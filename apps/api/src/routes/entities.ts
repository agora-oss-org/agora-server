// /v7/:projectId/entities/*
// Data layer is Drizzle (db); the Supabase client is reserved for Auth/Storage.
// Static routes (/drafts, /by-foreign-id, …) MUST stay above /:id or Hono captures them.
import { Hono } from "hono";
import { and, eq, isNull, desc, count, arrayOverlaps, sql, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { indexEntityAsync } from "../lib/embeddings.js";
import * as webhooks from "../lib/webhooks.js";
import { trackEvent } from "../lib/umami.js";
import { notifyOnEntityMentions, notifyOnReaction } from "../lib/notifications.js";
import { parseBracketQuery, buildFeedConditions, buildFeedOrder } from "../lib/entity-filters.js";
import { entities, reactions, collections, collectionEntities, spaces, readReceipts } from "../db/schema/index.js";
import { getSocialConfig } from "../lib/social-config.js";
import { readPagination, paginate } from "../http/envelope.js";
import {
  shapeEntity,
  shapeFile,
  parseInclude,
  generateShortId,
  attachUserReactions,
  loadUsers,
  loadEntityFiles,
} from "../lib/shape.js";
import { storeImageFromUpload } from "../lib/images.js";
import { parseRankParams } from "../lib/ranking.js";
import { getFeedConfig } from "../lib/feed-config.js";
import { assertCanReadSpace, assertCanReadEntity, assertCanPostInSpace, readableEntitiesFilter } from "../lib/space-access.js";
import { removedPolicy, excludeRemovedSql, shouldHide } from "../lib/moderation-visibility.js";
import { rerankCandidates } from "../lib/rerank.js";
import {
  parseBody,
  createEntitySchema,
  updateEntitySchema,
  reactionSchema,
} from "../lib/validation.js";

export const entityRoutes = new Hono<{ Variables: Variables }>()
  // ── feed ────────────────────────────────────────────────────────────────
  .get("/", async (c) => {
    const projectId = c.var.projectId;
    const { page, limit, offset } = readPagination(c);
    const include = parseInclude(c);

    const conds: SQL[] = [
      eq(entities.projectId, projectId),
      isNull(entities.deletedAt),
      eq(entities.isDraft, false),
    ];
    // SDK sends absent filters as the literal string "null"/"undefined" — treat those as unset.
    const clean = (v: string | undefined) => (v && v !== "null" && v !== "undefined" ? v : undefined);
    const spaceId = clean(c.req.query("spaceId"));
    const userId = clean(c.req.query("userId"));
    const sourceId = clean(c.req.query("sourceId"));
    const keywords = clean(c.req.query("keywords")); // legacy flat param (kept for back-compat)
    if (spaceId) conds.push(eq(entities.spaceId, spaceId));
    if (userId) conds.push(eq(entities.userId, userId));
    if (sourceId) conds.push(eq(entities.sourceId, sourceId));
    if (keywords) conds.push(arrayOverlaps(entities.keywords, keywords.split(",").map((k) => k.trim())));

    // Rich filters + sort (timeFrame / followedOnly / keywords|title|content|attachments|metadata|
    // location filters, sortBy hot/top/new/controversial/metadata.x, sortDir, sortType, sortByReaction).
    const parsed = parseBracketQuery(c.req.url);
    conds.push(...buildFeedConditions(parsed, c.var.auth?.userId));
    // Exclude entities in members-only spaces the caller can't read (private-space leak guard).
    const readable = readableEntitiesFilter(c);
    if (readable) conds.push(readable);
    // Moderation-removed entities: hidden from the feed for non-moderators (hide mode); in
    // placeholder mode they stay but are blanked after shaping (see below).
    const removed = await removedPolicy(c);
    const excludeRemoved = excludeRemovedSql(removed, entities);
    if (excludeRemoved) conds.push(excludeRemoved);
    const where = and(...conds);

    // Ranking precedence: request rankParams > project feed_config > built-in defaults. The project
    // config also supplies the default algorithm (when sortBy is absent) + reaction weights.
    const feedCfg = await getFeedConfig(projectId);
    if (!clean(c.req.query("sortBy"))) parsed.sortBy = feedCfg.defaultAlgorithm;
    // Pin the clock (rankAnchor) so query-time algos (decay/gravity) page consistently.
    const rankAnchorRaw = clean(c.req.query("rankAnchor"));
    const rankAnchor = rankAnchorRaw && !Number.isNaN(Date.parse(rankAnchorRaw))
      ? new Date(rankAnchorRaw).toISOString() : new Date().toISOString();
    const rankParams = parseRankParams(clean(c.req.query("rankParams")) ?? null, feedCfg.params);
    const orderBy = buildFeedOrder(parsed, { params: rankParams, weights: feedCfg.weights, anchor: sql`${rankAnchor}::timestamptz` });

    // Re-rank webhook (opt-in via ?rerank=true when one is configured): over-fetch a candidate pool,
    // let the host app reorder it, then slice the requested page. Fails open to the algorithm order.
    const rerankOn = !!feedCfg.rerankWebhook && clean(c.req.query("rerank")) === "true";
    let rows;
    if (rerankOn) {
      const poolSize = Math.min(limit * Math.max(1, feedCfg.rerankWebhook!.overFetch), 200);
      const pool = await db.select().from(entities).where(where).orderBy(...orderBy).limit(poolSize);
      const candidates = pool.map((r) => ({
        id: r.id,
        signals: { score: r.score, createdAt: r.createdAt, reactionCounts: r.reactionCounts, repliesCount: r.repliesCount, views: r.views },
      }));
      const order = await rerankCandidates(projectId, feedCfg.rerankWebhook!, candidates);
      const ordered = order ? order.map((id) => pool.find((r) => r.id === id)).filter((r): r is typeof pool[number] => !!r) : pool;
      rows = ordered.slice(offset, offset + limit);
    } else {
      rows = await db.select().from(entities).where(where).orderBy(...orderBy).limit(limit).offset(offset);
    }
    const total = await countWhere(where);

    const reactionMap = await attachUserReactions(projectId, "entity", rows.map((r) => r.id), c.var.auth?.userId);
    const userMap = include.has("user") ? await loadUsers(projectId, rows.map((r) => r.userId)) : null;
    const fileMap = await loadEntityFiles(projectId, rows.map((r) => r.id));
    const shaped = rows.map((r) =>
      shapeEntity(r, {
        userReaction: reactionMap.get(r.id) ?? null,
        ...(userMap ? { user: r.userId ? userMap.get(r.userId) ?? null : null } : {}),
        ...(fileMap.has(r.id) ? { files: fileMap.get(r.id) } : {}),
      })
    );
    // Echo the resolved ranking clock so clients can pin it across paginated requests.
    return c.json({ ...paginate(shaped, total, page, limit), rankAnchor });
  })
  .post("/", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const userId = c.var.auth!.userId;

    // The SDK's useCreateEntity sends multipart/form-data when images/files are attached, and JSON
    // otherwise. Branch on Content-Type: pull the entity fields + any image files out of the form,
    // or read the JSON body directly.
    const contentType = c.req.header("content-type") ?? "";
    const isMultipart = contentType.includes("multipart/form-data");
    let imageFiles: File[] = [];
    let imageOptions: Record<string, unknown> = {};
    let rawBody: Record<string, unknown>;

    if (isMultipart) {
      const form = await c.req.parseBody({ all: true });
      rawBody = parseMultipartEntityFields(form);
      const imgs = form["images.files"];
      imageFiles = (Array.isArray(imgs) ? imgs : imgs ? [imgs] : []).filter(
        (f): f is File => typeof f !== "string"
      );
      const optStr = form["images.options"];
      if (typeof optStr === "string") {
        try { imageOptions = JSON.parse(optStr); } catch { /* ignore malformed options */ }
      }
    } else {
      rawBody = await c.req.json().catch(() => ({}));
    }

    const body = parseBody(createEntitySchema, rawBody, "entities");
    await assertCanPostInSpace(c, body.spaceId); // enforce the space's postingPermission
    // Blocking validation webhook (host app may veto). Passes through if unconfigured/unsubscribed.
    const check = await webhooks.validate(projectId, "entity.created", { ...body, userId });
    if (!check.valid) throw Errors.forbidden("entities/rejected", check.message ?? "Entity rejected by validation webhook");
    const [row] = await db
      .insert(entities)
      .values({
        projectId,
        userId,
        shortId: generateShortId(),
        title: body.title,
        content: body.content,
        foreignId: body.foreignId,
        sourceId: body.sourceId,
        spaceId: body.spaceId,
        // null → undefined so Drizzle applies the NOT NULL array/jsonb defaults
        keywords: body.keywords ?? undefined,
        mentions: body.mentions ?? undefined,
        attachments: body.attachments ?? undefined,
        metadata: body.metadata ?? undefined,
        isDraft: body.isDraft ?? false,
      })
      .returning();
    if (!row) throw Errors.badRequest("entities/create-failed", "Insert returned no row");

    // Process any attached images: each becomes a `files` row linked to the new entity.
    const fileRows = [];
    for (const file of imageFiles) {
      const { fileRow } = await storeImageFromUpload({
        projectId, userId, file, optionsBody: imageOptions, assoc: { entityId: row.id },
      });
      fileRows.push(fileRow);
    }

    indexEntityAsync(projectId, row.id, [row.title, row.content].filter(Boolean).join("\n"));
    await notifyOnEntityMentions(projectId, row);
    const shaped = shapeEntity(row, fileRows.length ? { files: fileRows.map(shapeFile) } : {});
    logger.info({ projectId, entityId: row.id, userId, spaceId: row.spaceId ?? null, isDraft: row.isDraft, files: fileRows.length }, "entity: created");
    webhooks.broadcast(projectId, "entity.created.complete", shaped);
    trackEvent("entity-created", { projectId, ...(row.spaceId ? { spaceId: row.spaceId } : {}) });
    return c.json(shaped, 201);
  })
  .get("/drafts", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const userId = c.var.auth!.userId;
    const { page, limit, offset } = readPagination(c);
    const where = and(
      eq(entities.projectId, projectId),
      eq(entities.userId, userId),
      eq(entities.isDraft, true),
      isNull(entities.deletedAt)
    );
    const rows = await db
      .select()
      .from(entities)
      .where(where)
      .orderBy(desc(entities.createdAt))
      .limit(limit)
      .offset(offset);
    const total = await countWhere(where);
    return c.json(paginate(rows.map((r) => shapeEntity(r)), total, page, limit));
  })
  .get("/by-foreign-id", async (c) => {
    const foreignId = c.req.query("foreignId");
    if (!foreignId) throw Errors.badRequest("entities/missing-foreign-id", "foreignId is required", "foreignId");
    return c.json(await lookupEntity(c, eq(entities.foreignId, foreignId)));
  })
  .get("/by-short-id", async (c) => {
    const shortId = c.req.query("shortId");
    if (!shortId) throw Errors.badRequest("entities/missing-short-id", "shortId is required", "shortId");
    return c.json(await lookupEntity(c, eq(entities.shortId, shortId)));
  })
  .get("/is-entity-saved", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const userId = c.var.auth!.userId;
    const entityId = c.req.query("entityId");
    if (!entityId) throw Errors.badRequest("entities/missing-entity-id", "entityId is required", "entityId");
    // Saved == present in any of the user's collections.
    const rows = await db
      .select({ entityId: collectionEntities.entityId })
      .from(collectionEntities)
      .innerJoin(collections, eq(collectionEntities.collectionId, collections.id))
      .where(
        and(
          eq(collectionEntities.entityId, entityId),
          eq(collections.userId, userId),
          eq(collections.projectId, projectId)
        )
      )
      .limit(1);
    return c.json({ isSaved: rows.length > 0 });
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    return c.json(await lookupEntity(c, eq(entities.id, id)));
  })
  .patch("/:id", requireAuth, async (c) => {
    const row = await ownedEntity(c);
    const body = parseBody(updateEntitySchema, await c.req.json().catch(() => ({})), "entities");
    const check = await webhooks.validate(c.var.projectId, "entity.updated", { ...body, id: row.id, userId: row.userId });
    if (!check.valid) throw Errors.forbidden("entities/rejected", check.message ?? "Entity update rejected by validation webhook");
    const patch: Record<string, unknown> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.content !== undefined) patch.content = body.content;
    if (body.keywords !== undefined) patch.keywords = body.keywords;
    if (body.mentions !== undefined) patch.mentions = body.mentions;
    if (body.attachments !== undefined) patch.attachments = body.attachments;
    if (body.metadata !== undefined) patch.metadata = body.metadata;
    const [updated] = await db.update(entities).set(patch).where(eq(entities.id, row.id)).returning();
    if (body.title !== undefined || body.content !== undefined) {
      indexEntityAsync(c.var.projectId, updated!.id, [updated!.title, updated!.content].filter(Boolean).join("\n"));
    }
    const shaped = shapeEntity(updated!);
    logger.info({ projectId: c.var.projectId, entityId: row.id, userId: row.userId, fields: Object.keys(patch) }, "entity: updated");
    webhooks.broadcast(c.var.projectId, "entity.updated.complete", shaped);
    return c.json(shaped);
  })
  .delete("/:id", requireAuth, async (c) => {
    const row = await ownedEntity(c);
    await db.update(entities).set({ deletedAt: new Date() }).where(eq(entities.id, row.id));
    logger.info({ projectId: c.var.projectId, entityId: row.id, userId: row.userId }, "entity: deleted");
    return c.json({ success: true });
  })
  // SDK (usePublishDraft) calls PATCH; POST kept for any legacy caller.
  .on(["POST", "PATCH"], "/:id/publish", requireAuth, async (c) => {
    const row = await ownedEntity(c);
    const [updated] = await db.update(entities).set({ isDraft: false }).where(eq(entities.id, row.id)).returning();
    logger.info({ projectId: c.var.projectId, entityId: row.id, userId: row.userId }, "entity: published");
    return c.json(shapeEntity(updated!));
  })
  // ── read receipts ───────────────────────────────────────────────────────
  // Record that the caller read this post (corporate-tier per-space receipts, docs/SOCIAL-GRAPH.md §4).
  // Pure Postgres — never touches the social graph. Only valid for a post in a read-receipts-enabled
  // space under a project that allows receipts; idempotent (one row per member per post, readAt bumped).
  .post("/:id/read", requireAuth, async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .select({ spaceId: entities.spaceId, moderationStatus: entities.moderationStatus, deletedAt: entities.deletedAt })
      .from(entities)
      .where(and(eq(entities.projectId, c.var.projectId), eq(entities.id, id)))
      .limit(1);
    if (!row || row.deletedAt || shouldHide(await removedPolicy(c), row.moderationStatus)) {
      throw Errors.notFound("entities/not-found", "Entity not found");
    }
    // Receipts only exist for posts that live in a space; a space-less post can't be receipt-tracked.
    if (!row.spaceId) throw Errors.badRequest("social/read-receipts-disabled", "Read receipts are not enabled for this post");
    await assertCanReadSpace(c, row.spaceId); // can't record reading content you can't read
    // Gate: the space must be receipts-enabled AND the project must allow receipts (corporate tier).
    const [space] = await db
      .select({ enabled: spaces.readReceiptsEnabled })
      .from(spaces)
      .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, row.spaceId)))
      .limit(1);
    const cfg = await getSocialConfig(c.var.projectId);
    if (!space?.enabled || !cfg.readReceiptsAllowed) {
      throw Errors.badRequest("social/read-receipts-disabled", "Read receipts are not enabled for this space");
    }
    const readAt = new Date();
    await db
      .insert(readReceipts)
      .values({ projectId: c.var.projectId, spaceId: row.spaceId, entityId: id, userId: c.var.auth!.userId, readAt })
      .onConflictDoUpdate({
        target: [readReceipts.projectId, readReceipts.entityId, readReceipts.userId],
        set: { readAt },
      });
    return c.json({ recorded: true, readAt: readAt.toISOString() });
  })
  // ── reactions ─────────────────────────────────────────────────────────────
  // SDK (useFetchEntityReactions) — paginated list of who reacted, gated by entity read access.
  .get("/:id/reactions", async (c) => {
    const targetId = c.req.param("id");
    await assertCanReadEntity(c, targetId); // don't reveal reactors on content you can't read
    const { page, limit, offset } = readPagination(c);
    const rt = c.req.query("reactionType");
    const where = and(
      eq(reactions.projectId, c.var.projectId),
      eq(reactions.targetType, "entity"),
      eq(reactions.targetId, targetId),
      rt ? eq(reactions.reactionType, rt as any) : undefined,
    );
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(reactions).where(where);
    const rows = await db.select().from(reactions).where(where)
      .orderBy(desc(reactions.createdAt)).limit(limit).offset(offset);
    const userMap = await loadUsers(c.var.projectId, rows.map((r) => r.userId));
    const data = rows.map((r) => ({
      id: r.id, userId: r.userId, reactionType: r.reactionType,
      createdAt: r.createdAt.toISOString(), user: userMap.get(r.userId) ?? null,
    }));
    return c.json(paginate(data, n, page, limit));
  })
  .post("/:id/reactions", requireAuth, async (c) => {
    await assertCanReadEntity(c, c.req.param("id")); // can't react to content you can't read
    const { reactionType } = parseBody(reactionSchema, await c.req.json().catch(() => ({})), "entities");
    const result = await toggleEntityReaction(c, reactionType);
    await notifyOnReaction({
      projectId: c.var.projectId,
      targetType: "entity",
      targetId: c.req.param("id"),
      reactorId: c.var.auth!.userId,
      reactionType,
      isActive: result.userReaction === reactionType,
      reactionCounts: result.reactionCounts,
    });
    if (result.userReaction === reactionType) // fire only when the reaction was added (not toggled off)
      trackEvent("reaction-added", { projectId: c.var.projectId, targetType: "entity", reactionType });
    return c.json(result);
  })
  .delete("/:id/reactions", requireAuth, async (c) => {
    return c.json(await clearEntityReaction(c));
  });

// ─── shared helpers ────────────────────────────────────────────────────────

// Reduce a multipart form (string values; arrays under repeated keys) to the JSON-ish body the
// createEntitySchema expects. Scalar fields stay strings; the array/object fields the SDK sends as
// JSON strings are parsed back; isDraft is coerced to boolean. Absent fields are omitted (not null).
function parseMultipartEntityFields(form: Record<string, unknown>): Record<string, unknown> {
  const str = (k: string): string | undefined => {
    const v = form[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    return undefined;
  };
  const json = (k: string): unknown => {
    const s = str(k);
    if (s === undefined) return undefined;
    try { return JSON.parse(s); } catch { return undefined; }
  };
  const out: Record<string, unknown> = {};
  for (const k of ["title", "content", "foreignId", "sourceId", "spaceId"]) {
    const v = str(k);
    if (v !== undefined) out[k] = v;
  }
  for (const k of ["keywords", "mentions", "attachments", "metadata", "location"]) {
    const v = json(k);
    if (v !== undefined) out[k] = v;
  }
  const draft = str("isDraft");
  if (draft !== undefined) out.isDraft = draft === "true";
  return out;
}

async function countWhere(where: SQL | undefined): Promise<number> {
  const rows = await db.select({ total: count() }).from(entities).where(where);
  return rows[0]?.total ?? 0;
}

async function lookupEntity(c: any, predicate: SQL) {
  const projectId = c.var.projectId;
  const include = parseInclude(c);
  const [row] = await db
    .select()
    .from(entities)
    .where(and(eq(entities.projectId, projectId), predicate, isNull(entities.deletedAt)))
    .limit(1);
  if (!row) throw Errors.notFound("entities/not-found", "Entity not found");
  // Private-space leak guard: a single entity in a members-only space is owner/member-only.
  await assertCanReadSpace(c, row.spaceId);
  // Moderation-removed entities 404 for non-moderators (operators bypass for review).
  const removed = await removedPolicy(c);
  if (shouldHide(removed, row.moderationStatus)) throw Errors.notFound("entities/not-found", "Entity not found");

  const reactionMap = await attachUserReactions(projectId, "entity", [row.id], c.var.auth?.userId);
  const opts: any = { userReaction: reactionMap.get(row.id) ?? null };
  if (include.has("user")) {
    const users = await loadUsers(projectId, [row.userId]);
    opts.user = row.userId ? users.get(row.userId) ?? null : null;
  }
  const fileMap = await loadEntityFiles(projectId, [row.id]);
  if (fileMap.has(row.id)) opts.files = fileMap.get(row.id);
  return shapeEntity(row, opts);
}

/** Fetch an entity and assert the auth user owns it; throws 404/403 otherwise. */
async function ownedEntity(c: any): Promise<{ id: string; userId: string | null }> {
  const projectId = c.var.projectId;
  const id = c.req.param("id");
  const [row] = await db
    .select({ id: entities.id, userId: entities.userId })
    .from(entities)
    .where(and(eq(entities.projectId, projectId), eq(entities.id, id), isNull(entities.deletedAt)))
    .limit(1);
  if (!row) throw Errors.notFound("entities/not-found", "Entity not found");
  if (row.userId !== c.var.auth.userId) throw Errors.forbidden("entities/not-owner", "Not the owner");
  return row;
}

async function toggleEntityReaction(c: any, type: string) {
  const projectId = c.var.projectId;
  const id = c.req.param("id");
  const userId = c.var.auth.userId;
  // Atomic set/switch/clear in Postgres; the 0002 trigger maintains reaction_counts.
  const res = await db.execute(
    sql`select toggle_reaction(${projectId}::uuid, 'entity'::reaction_target, ${id}::uuid, ${userId}::uuid, ${type}::reaction_type) as counts`
  );
  await db.execute(sql`select refresh_entity_score(${id}::uuid)`);
  const userReaction = await currentReaction(projectId, "entity", id, userId);
  logger.debug({ projectId, entityId: id, userId, reactionType: type, active: userReaction === type }, "entity: reaction toggled");
  return { reactionCounts: (res as any)[0]?.counts ?? null, userReaction };
}

async function clearEntityReaction(c: any) {
  const projectId = c.var.projectId;
  const id = c.req.param("id");
  const userId = c.var.auth.userId;
  // Direct delete; the 0002 trigger fixes reaction_counts.
  await db
    .delete(reactions)
    .where(
      and(
        eq(reactions.projectId, projectId),
        eq(reactions.targetType, "entity"),
        eq(reactions.targetId, id),
        eq(reactions.userId, userId)
      )
    );
  await db.execute(sql`select refresh_entity_score(${id}::uuid)`);
  const [row] = await db.select({ rc: entities.reactionCounts }).from(entities).where(eq(entities.id, id)).limit(1);
  return { reactionCounts: row?.rc ?? null, userReaction: null };
}

async function currentReaction(projectId: string, target: "entity" | "comment", id: string, userId: string) {
  const [row] = await db
    .select({ reactionType: reactions.reactionType })
    .from(reactions)
    .where(
      and(
        eq(reactions.projectId, projectId),
        eq(reactions.targetType, target),
        eq(reactions.targetId, id),
        eq(reactions.userId, userId)
      )
    )
    .limit(1);
  return row?.reactionType ?? null;
}
