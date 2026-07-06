// Per-space read-receipts coverage (corporate tier · operator-only) — docs/SOCIAL-GRAPH.md §4.
//
// The compliance counterpart to the private feed-affinity reads: for each read-receipts-enabled space,
// how many of its members have read each recent post ("87% of Engineering saw the new policy"). Pure
// Postgres over the `read_receipts` rows the member record endpoint writes — NO Neo4j, NO snapshot, NO
// cron. Read live: the operator endpoint calls this on request. The numerator counts only ACTIVE space
// members (a non-member who read the post is recorded but never counts toward coverage); the denominator
// is the space's active membership.
import { and, eq, isNull, inArray, desc, count, countDistinct, ne, or } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { spaces, spaceMembers, entities, readReceipts } from "../db/schema/index.js";
import { readReceiptCoverage, type SocialReadReceipts, type ReceiptSpace } from "@agora-server/contract";

// How many recent posts to report per space. Announcement spaces are low-volume; this caps the per-space
// fan-out and keeps the payload bounded.
const ANNOUNCEMENTS_PER_SPACE = 50;

export async function getReadReceiptsCoverage(projectId: string): Promise<SocialReadReceipts> {
  const asOf = new Date().toISOString();

  // 1) The receipts-enabled spaces (the only ones that record reads).
  const spaceRows = await getDb()
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(and(eq(spaces.projectId, projectId), eq(spaces.readReceiptsEnabled, true), isNull(spaces.deletedAt)))
    .orderBy(spaces.name);
  if (spaceRows.length === 0) return { spaces: [], asOf };
  const spaceIds = spaceRows.map((s) => s.id);

  // 2) Active-member counts per space (the coverage denominator).
  const memberRows = await getDb()
    .select({ spaceId: spaceMembers.spaceId, n: count() })
    .from(spaceMembers)
    .where(and(
      eq(spaceMembers.projectId, projectId),
      eq(spaceMembers.status, "active"),
      inArray(spaceMembers.spaceId, spaceIds),
    ))
    .groupBy(spaceMembers.spaceId);
  const memberCount = new Map(memberRows.map((r) => [r.spaceId, Number(r.n)]));

  // 3) Recent visible posts per space (newest first, capped). Per-space limit, so loop the few spaces.
  const announcements: { id: string; title: string | null; createdAt: Date; spaceId: string }[] = [];
  for (const s of spaceRows) {
    const rows = await getDb()
      .select({ id: entities.id, title: entities.title, createdAt: entities.createdAt, spaceId: entities.spaceId })
      .from(entities)
      .where(and(
        eq(entities.projectId, projectId),
        eq(entities.spaceId, s.id),
        eq(entities.isDraft, false),
        isNull(entities.deletedAt),
        or(isNull(entities.moderationStatus), ne(entities.moderationStatus, "removed")),
      ))
      .orderBy(desc(entities.createdAt))
      .limit(ANNOUNCEMENTS_PER_SPACE);
    for (const r of rows) announcements.push({ id: r.id, title: r.title, createdAt: r.createdAt, spaceId: r.spaceId! });
  }

  // 4) Distinct ACTIVE-member readers per post (the numerator) — one grouped query over all posts.
  const readerCount = new Map<string, number>();
  if (announcements.length > 0) {
    const readerRows = await getDb()
      .select({ entityId: readReceipts.entityId, n: countDistinct(readReceipts.userId) })
      .from(readReceipts)
      .innerJoin(spaceMembers, and(
        eq(spaceMembers.projectId, projectId),
        eq(spaceMembers.spaceId, readReceipts.spaceId),
        eq(spaceMembers.userId, readReceipts.userId),
        eq(spaceMembers.status, "active"),
      ))
      .where(and(
        eq(readReceipts.projectId, projectId),
        inArray(readReceipts.entityId, announcements.map((a) => a.id)),
      ))
      .groupBy(readReceipts.entityId);
    for (const r of readerRows) readerCount.set(r.entityId, Number(r.n));
  }

  // 5) Assemble per-space → posts with coverage.
  const out: ReceiptSpace[] = spaceRows.map((s) => {
    const members = memberCount.get(s.id) ?? 0;
    return {
      spaceId: s.id,
      name: s.name,
      memberCount: members,
      announcements: announcements
        .filter((a) => a.spaceId === s.id)
        .map((a) => {
          const readers = readerCount.get(a.id) ?? 0;
          return {
            entityId: a.id,
            title: a.title,
            createdAt: a.createdAt.toISOString(),
            readerCount: readers,
            coverage: readReceiptCoverage(readers, members),
          };
        }),
    };
  });

  return { spaces: out, asOf };
}
