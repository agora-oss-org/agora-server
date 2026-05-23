// Entity-feed filters + sort, matching the SDK's EntityListFilters/EntityListSort contract
// (agora-sdk .../store/api/entityListsApi.ts). The SDK serializes filter objects with Axios-style
// bracket notation (e.g. metadataFilters[includes][status]=active, keywordsFilters[includes][0]=x),
// so we parse the raw query string back into nested objects, then translate to SQL.
//
// All dynamic values are parameterized via drizzle `sql` interpolation; metadata sort keys are
// sanitized to [A-Za-z0-9_] before being used as a json path operand.
import { and, asc, desc, ilike, sql, type SQL } from "drizzle-orm";
import { entities } from "../db/schema/index.js";
import { REACTION_TYPES } from "./shape.js";

const TIME_FRAMES: Record<string, string> = {
  hour: "1 hour", day: "1 day", week: "7 days", month: "30 days", year: "365 days",
};

/** Parse an Axios bracket-notation query string into nested objects/arrays. */
export function parseBracketQuery(rawUrl: string): Record<string, any> {
  const out: Record<string, any> = {};
  const sp = new URL(rawUrl).searchParams;
  for (const [rawKey, value] of sp.entries()) {
    const path = rawKey.replace(/\]/g, "").split("["); // "a[b][0]" -> ["a","b","0"]
    let node: any = out;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i]!;
      if (i === path.length - 1) {
        node[seg] = value;
      } else {
        const nextIsIndex = /^\d+$/.test(path[i + 1]!);
        if (node[seg] == null) node[seg] = nextIsIndex ? [] : {};
        node = node[seg];
      }
    }
  }
  return out;
}

const truthy = (v: unknown) => v === true || v === "true";
// A bracketed field may arrive as a string, an array, or an index-keyed object.
const toArray = (v: unknown): string[] =>
  v == null ? [] : Array.isArray(v) ? v.map(String) : typeof v === "object" ? Object.values(v as object).map(String) : [String(v)];

// Drizzle interpolates a JS array in a raw `sql` template as a single scalar param (not a Postgres
// array), so array operands for @> / && / ?& / ?| must be built as an explicit array[…] literal.
const pgTextArray = (arr: string[]): SQL =>
  sql`array[${sql.join(arr.map((v) => sql`${v}`), sql`, `)}]::text[]`;

function textConds(f: any, col: typeof entities.title | typeof entities.content): SQL[] {
  const c: SQL[] = [];
  if (!f || typeof f !== "object") return c;
  const has = f.hasTitle ?? f.hasContent;
  if (has !== undefined) {
    c.push(truthy(has) ? sql`${col} is not null and ${col} <> ''` : sql`(${col} is null or ${col} = '')`);
  }
  for (const inc of toArray(f.includes)) c.push(ilike(col, `%${inc}%`));
  for (const exc of toArray(f.doesNotInclude)) c.push(sql`${col} not ilike ${`%${exc}%`}`);
  return c;
}

/**
 * Build the WHERE conditions contributed by feed filters (to AND with the caller's base conds).
 * `authUserId` is required for followedOnly; absent → the filter matches nothing.
 */
export function buildFeedConditions(parsed: Record<string, any>, authUserId?: string): SQL[] {
  const c: SQL[] = [];

  const interval = TIME_FRAMES[parsed.timeFrame as string];
  if (interval) c.push(sql`${entities.createdAt} >= now() - ${interval}::interval`);

  if (truthy(parsed.followedOnly)) {
    if (authUserId) {
      c.push(sql`${entities.userId} in (select followed_id from follows where project_id = ${entities.projectId} and follower_id = ${authUserId})`);
    } else {
      c.push(sql`false`); // followedOnly without a user → no results
    }
  }

  const kf = parsed.keywordsFilters;
  if (kf) {
    const inc = toArray(kf.includes);
    const exc = toArray(kf.doesNotInclude);
    if (inc.length) c.push(sql`${entities.keywords} @> ${pgTextArray(inc)}`); // has all
    if (exc.length) c.push(sql`not (${entities.keywords} && ${pgTextArray(exc)})`); // has none
  }

  c.push(...textConds(parsed.titleFilters, entities.title));
  c.push(...textConds(parsed.contentFilters, entities.content));

  const af = parsed.attachmentsFilters;
  if (af?.hasAttachments !== undefined) {
    c.push(truthy(af.hasAttachments)
      ? sql`jsonb_array_length(${entities.attachments}) > 0`
      : sql`jsonb_array_length(${entities.attachments}) = 0`);
  }

  const mf = parsed.metadataFilters;
  if (mf) {
    if (mf.includes && typeof mf.includes === "object") c.push(sql`${entities.metadata} @> ${JSON.stringify(mf.includes)}::jsonb`);
    const any = Array.isArray(mf.includesAny) ? mf.includesAny : mf.includesAny ? Object.values(mf.includesAny) : [];
    if (any.length) {
      const ors = any.map((o: any) => sql`${entities.metadata} @> ${JSON.stringify(o)}::jsonb`);
      c.push(sql`(${sql.join(ors, sql` or `)})`);
    }
    if (mf.doesNotInclude && typeof mf.doesNotInclude === "object") c.push(sql`not (${entities.metadata} @> ${JSON.stringify(mf.doesNotInclude)}::jsonb)`);
    const exists = toArray(mf.exists);
    if (exists.length) c.push(sql`${entities.metadata} ?& ${pgTextArray(exists)}`);
    const notExists = toArray(mf.doesNotExist);
    if (notExists.length) c.push(sql`not (${entities.metadata} ?| ${pgTextArray(notExists)})`);
  }

  const lf = parsed.locationFilters;
  if (lf?.latitude != null && lf?.longitude != null && lf?.radius != null) {
    const lat = Number(lf.latitude), lng = Number(lf.longitude), r = Number(lf.radius);
    if ([lat, lng, r].every(Number.isFinite)) {
      // location is a geography(Point,4326) column not modeled in Drizzle — reference it raw.
      c.push(sql`location is not null and ST_DWithin(location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${r})`);
    }
  }

  return c;
}

/** Build the ORDER BY expressions for the feed (always tie-broken by createdAt). */
export function buildFeedOrder(parsed: Record<string, any>): SQL[] {
  const dir = parsed.sortDir === "asc" ? asc : desc;
  const sortBy = parsed.sortBy as string | undefined;

  // Explicit reaction sort takes precedence.
  const reaction = parsed.sortByReaction as string | undefined;
  if (reaction && (REACTION_TYPES as readonly string[]).includes(reaction)) {
    return [dir(sql`coalesce((${entities.reactionCounts}->>${reaction})::int, 0)`), desc(entities.createdAt)];
  }

  if (sortBy?.startsWith("metadata.")) {
    const key = sortBy.slice("metadata.".length).replace(/[^A-Za-z0-9_]/g, "");
    if (key) {
      const st = parsed.sortType as string | undefined;
      const expr =
        st === "numeric" ? sql`(${entities.metadata}->>${key})::numeric`
        : st === "timestamp" ? sql`(${entities.metadata}->>${key})::timestamptz`
        : st === "boolean" ? sql`(${entities.metadata}->>${key})::boolean`
        : sql`${entities.metadata}->>${key}`;
      return [dir(expr), desc(entities.createdAt)];
    }
  }

  switch (sortBy) {
    case "hot":
    case "top":
      return [dir(entities.score), desc(entities.createdAt)];
    case "controversial":
      // High when both sides are large and balanced: least(up,down) first, then total.
      return [
        dir(sql`least(coalesce((${entities.reactionCounts}->>'upvote')::int, 0), coalesce((${entities.reactionCounts}->>'downvote')::int, 0))`),
        desc(sql`coalesce((${entities.reactionCounts}->>'upvote')::int, 0) + coalesce((${entities.reactionCounts}->>'downvote')::int, 0)`),
      ];
    case "new":
    default:
      return [dir(entities.createdAt)];
  }
}

/** Convenience: combine base conditions + filter conditions into one WHERE. */
export function combineConds(base: SQL[], extra: SQL[]): SQL | undefined {
  return and(...base, ...extra);
}
