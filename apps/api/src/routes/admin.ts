// Admin dashboard endpoints — operator (project-wide) or space-moderator (scoped) stats.
// Mounted at /v7/:projectId/admin. Reads only; aggregates the dashboard's "Project metrics"
// (live SQL counts) + "App metering" (api_usage, request-metering middleware) in one round trip.
// Also serves GET /admin/config — the operator-only, secret-redacted running configuration.
import { Hono } from "hono";
import { and, eq, or, count, sum, isNull, inArray, sql } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { env } from "../lib/env.js";
import { parseBody } from "../lib/validation.js";
import {
  SOCIAL_ANALYTICS_REPORTS, socialAnalyticsRecomputeSchema, readReceiptsToggleSchema,
  type SocialAnalyticsReport,
} from "@agora-server/contract";
import { getSocialConfig } from "../lib/social-config.js";
import {
  ANALYTICS_REPORT_FLAG, getEngagement, getInfluence, getSilos, rollupAnalytics,
} from "../lib/social-analytics.js";
import { getReadReceiptsCoverage } from "../lib/social-read-receipts.js";
import { logger } from "../lib/logger.js";
import { buildRunningConfig } from "../lib/running-config.js";
import { getServerResources } from "../lib/server-resources.js";
import { loadUsers, shapeEntity } from "../lib/shape.js";
import { db } from "../db/index.js";
import {
  profiles, reports, spaces, spaceMembers, entities, comments, files, apiUsage, communityStatsHourly,
} from "../db/schema/index.js";
import { isProjectAdmin, requireProjectAdmin } from "../lib/project-roles.js";

// Spaces where the user is an active admin/moderator (their moderation scope when not an operator).
async function moderatedSpaceIds(projectId: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(and(
      eq(spaces.projectId, projectId),
      eq(spaceMembers.userId, userId),
      or(eq(spaceMembers.role, "admin"), eq(spaceMembers.role, "moderator")),
    ));
  return rows.map((r) => r.spaceId);
}

export const adminRoutes = new Hono<{ Variables: Variables }>()
  // GET /admin/dashboard/metrics — role-scoped aggregate for the dashboard cards.
  .get("/dashboard/metrics", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const userId = c.var.auth!.userId;
    const isOperator = c.var.auth!.isOperator;
    const projectAdmin = isProjectAdmin(c.var.auth!);

    // Project admins/owners (and operators) see all reports project-wide; plain space-moderators only
    // see reports for spaces they moderate. Project-wide counts (members, entities, etc.) stay
    // project-scoped — they're not space-partitioned and a moderator's dashboard still shows totals.
    const spaceScope = projectAdmin ? null : await moderatedSpaceIds(projectId, userId);

    const openReportsWhere = and(
      eq(reports.projectId, projectId),
      isNull(reports.resolvedAt),
      ...(spaceScope ? [spaceScope.length ? inArray(reports.spaceId, spaceScope) : sql`false`] : []),
    );

    const [
      openReports, members, spaceCount, entityCount, commentCount, mau, storage,
    ] = await Promise.all([
      db.select({ n: count() }).from(reports).where(openReportsWhere),
      db.select({ n: count() }).from(profiles).where(eq(profiles.projectId, projectId)),
      db.select({ n: count() }).from(spaces).where(eq(spaces.projectId, projectId)),
      db.select({ n: count() }).from(entities).where(eq(entities.projectId, projectId)),
      db.select({ n: count() }).from(comments).where(eq(comments.projectId, projectId)),
      db.select({ n: count() }).from(profiles).where(and(
        eq(profiles.projectId, projectId),
        sql`${profiles.lastActive} >= date_trunc('month', now())`,
      )),
      db.select({ total: sum(files.originalSize) }).from(files).where(eq(files.projectId, projectId)),
    ]);

    // App metering lives in api_usage, which is gated behind migration 0016. Fail soft: if the table
    // isn't there yet (or the query errors), the dashboard's Project metrics still render and the
    // App-metering cards just read zero rather than 500-ing the whole page.
    const usage = await db
      .select({
        requests: sum(apiUsage.requests),
        egress: sum(apiUsage.egressBytes),
        durationTotal: sum(apiUsage.durationMsTotal),
      })
      .from(apiUsage)
      .where(and(
        eq(apiUsage.projectId, projectId),
        sql`${apiUsage.month} = date_trunc('month', now())::date`,
      ))
      .catch(() => [] as { requests: string | null; egress: string | null; durationTotal: string | null }[]);

    // Supabase usage: the Management API doesn't expose billing figures (storage/egress/MAU), so the
    // one authoritative number we can pull is the whole-instance Postgres size. It's instance-wide
    // (all tenants share one DB), not project-scoped, so it's operator-only. Fail-soft like usage.
    const dbSize = isOperator
      ? await db
          .execute(sql`select pg_database_size(current_database()) as bytes`)
          .then((rows) => Number((rows as any)[0]?.bytes ?? 0))
          .catch(() => null)
      : null;

    // Container resource snapshot (free memory + disk) — operator-only deployment infra.
    const serverResources = isOperator ? await getServerResources().catch(() => null) : null;

    const storageBytes = Number(storage[0]?.total ?? 0);
    const apiCalls = Number(usage[0]?.requests ?? 0);
    const egressBytes = Number(usage[0]?.egress ?? 0);
    const durationTotal = Number(usage[0]?.durationTotal ?? 0);

    return c.json({
      scope: isOperator ? "operator" : projectAdmin ? "admin" : "moderator",
      projectMetrics: {
        openReports: openReports[0]?.n ?? 0,
        members: members[0]?.n ?? 0,
        spaces: spaceCount[0]?.n ?? 0,
        entities: entityCount[0]?.n ?? 0,
        comments: commentCount[0]?.n ?? 0,
        monthlyActiveUsers: mau[0]?.n ?? 0,
        storageUsedBytes: storageBytes,
      },
      appMetrics: {
        apiCalls,
        clientEgressBytes: egressBytes,
        avgLatencyMs: apiCalls > 0 ? durationTotal / apiCalls : 0,
      },
      // Supabase/infra figures. databaseSizeBytes is null for non-operators and on query failure;
      // egress + Auth MAU are intentionally absent — not exposed by the Supabase Management API.
      supabaseMetrics: {
        databaseSizeBytes: dbSize,
      },
      // The running container's free memory + disk (operator-only; null otherwise / on read failure).
      serverMetrics: serverResources,
    });
  })

  // GET /admin/config — the running configuration (deployment-level), OPERATOR-ONLY. Secrets are
  // never emitted: secret-bearing settings report as `*Set`/`*Enabled` booleans; only non-sensitive
  // values are echoed (see lib/running-config.ts). Useful for ops to confirm what's actually wired.
  .get("/config", requireAuth, async (c) => {
    if (!c.var.auth!.isOperator) throw Errors.forbidden("admin/operator-required", "Operator access required");
    return c.json({
      service: "agora-api",
      node: process.version,
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      config: buildRunningConfig(env),
    });
  })

  // GET /admin/community/overview?days=N — OPERATOR-ONLY community-health pulse. Reads the hourly
  // rollup (community_stats_hourly, written by the community-stats cron): pulse totals + 24h deltas,
  // a per-hour growth series, moderation pressure, and the latest leaderboard + top-post snapshot
  // (ranking ids stored in the rollup; display fields hydrated fresh here). `configured:false` until
  // the first rollup has run, so the page shows a friendly empty state instead of erroring.
  .get("/community/overview", requireAuth, async (c) => {
    requireProjectAdmin(c);
    const projectId = c.var.projectId;
    const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 90); // clamp 1..90

    const rows = await db
      .select()
      .from(communityStatsHourly)
      .where(and(
        eq(communityStatsHourly.projectId, projectId),
        sql`${communityStatsHourly.hour} >= now() - make_interval(days => ${days})`,
      ))
      .orderBy(communityStatsHourly.hour);

    const latest = rows.at(-1);
    if (!latest) {
      return c.json({
        configured: false, range: { days }, snapshotAt: null,
        totals: { users: 0, posts: 0, comments: 0, reactions: 0 },
        deltas24h: null,
        series: [], moderation: { series: [], openNow: 0 },
        leaderboards: { posters: [], commenters: [], reactors: [] }, topPosts: [],
      });
    }

    const isoHour = (h: Date | string) => (h instanceof Date ? h.toISOString() : String(h));

    // 24h-delta baseline: the latest row at-or-before (latest.hour − 24h).
    const targetMs = new Date(latest.hour as unknown as string).getTime() - 24 * 3600 * 1000;
    const prior = [...rows].reverse().find((r) => new Date(r.hour as unknown as string).getTime() <= targetMs);
    const deltas24h = prior
      ? {
          users: latest.totalUsers - prior.totalUsers,
          posts: latest.totalPosts - prior.totalPosts,
          comments: latest.totalComments - prior.totalComments,
          reactions: latest.totalReactions - prior.totalReactions,
        }
      : null;

    // Hydrate leaderboards (userId → public User) and top posts (entityId → entity) from the snapshot.
    type Ranked = { userId: string; count: number };
    type PostRank = { entityId: string; reactions: number; replies: number; score: number };
    const posters = (latest.topPosters as Ranked[]) ?? [];
    const commenters = (latest.topCommenters as Ranked[]) ?? [];
    const reactors = (latest.topReactors as Ranked[]) ?? [];
    const postRanks = (latest.topPosts as PostRank[]) ?? [];

    const users = await loadUsers(projectId, [...posters, ...commenters, ...reactors].map((e) => e.userId));
    const hydrateBoard = (entries: Ranked[]) =>
      entries.map((e) => ({ user: users.get(e.userId) ?? null, count: e.count })).filter((x) => x.user);

    const entityRows = postRanks.length
      ? await db.select().from(entities).where(and(
          eq(entities.projectId, projectId),
          inArray(entities.id, postRanks.map((e) => e.entityId)),
        ))
      : [];
    const entityById = new Map(entityRows.map((r) => [r.id, r]));
    const topPosts = postRanks
      .map((e) => {
        const row = entityById.get(e.entityId);
        if (!row) return null; // deleted since the snapshot
        const ent = shapeEntity(row);
        return {
          entity: {
            id: ent.id, shortId: ent.shortId, title: ent.title,
            reactionCounts: ent.reactionCounts, repliesCount: ent.repliesCount,
            score: ent.score, createdAt: ent.createdAt,
          },
          reactions: e.reactions, replies: e.replies,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const [openNow] = await db
      .select({ n: count() })
      .from(reports)
      .where(and(eq(reports.projectId, projectId), isNull(reports.resolvedAt)));

    return c.json({
      configured: true,
      range: { days },
      snapshotAt: isoHour(latest.updatedAt as unknown as Date),
      totals: {
        users: latest.totalUsers, posts: latest.totalPosts,
        comments: latest.totalComments, reactions: latest.totalReactions,
      },
      deltas24h,
      series: rows.map((r) => ({
        hour: isoHour(r.hour as unknown as Date),
        newUsers: r.newUsers, newPosts: r.newPosts, newComments: r.newComments, newReactions: r.newReactions,
        activePosters: r.activePosters, activeCommenters: r.activeCommenters, activeReactors: r.activeReactors,
      })),
      moderation: {
        series: rows.map((r) => ({ hour: isoHour(r.hour as unknown as Date), opened: r.reportsOpened, resolved: r.reportsResolved })),
        openNow: openNow?.n ?? 0,
      },
      leaderboards: {
        posters: hydrateBoard(posters),
        commenters: hydrateBoard(commenters),
        reactors: hydrateBoard(reactors),
      },
      topPosts,
    });
  })
  // ── Admin analytics reads (operator-only, corporate-tier) — docs/AGORA-CORP.md. Each serves the LATEST
  // materialized snapshot (names hydrated fresh), or an empty `{ …, asOf: null }` sentinel when none exists
  // yet. Gate order mirrors routes/social.ts: operator first, then graph + the report's corporate flag.
  .get("/social/influence", requireAuth, async (c) => {
    if (!c.var.auth!.isOperator) throw Errors.forbidden("admin/operator-required", "Operator access required");
    const cfg = await getSocialConfig(c.var.projectId);
    if (!cfg.graphEnabled || !cfg.influenceScoresEnabled) {
      throw Errors.badRequest("social/influence-disabled", "Influence scores are not enabled for this project");
    }
    return c.json(await getInfluence(c.var.projectId));
  })
  .get("/social/silos", requireAuth, async (c) => {
    if (!c.var.auth!.isOperator) throw Errors.forbidden("admin/operator-required", "Operator access required");
    const cfg = await getSocialConfig(c.var.projectId);
    if (!cfg.graphEnabled || !cfg.siloDetectionEnabled) {
      throw Errors.badRequest("social/silos-disabled", "Silo detection is not enabled for this project");
    }
    return c.json(await getSilos(c.var.projectId));
  })
  .get("/social/engagement", requireAuth, async (c) => {
    if (!c.var.auth!.isOperator) throw Errors.forbidden("admin/operator-required", "Operator access required");
    const cfg = await getSocialConfig(c.var.projectId);
    if (!cfg.graphEnabled || !cfg.engagementScoresEnabled) {
      throw Errors.badRequest("social/engagement-disabled", "Engagement scores are not enabled for this project");
    }
    return c.json(await getEngagement(c.var.projectId));
  })
  // POST /admin/social/recompute — operator-forced, SYNCHRONOUS re-materialization of the admin-analytics
  // snapshots (docs/AGORA-CORP.md). Blocks while GDS runs over the whole graph (the admin UI shows a
  // "this will take a while" spinner), then returns the fresh reports. Body:
  // { report?: 'influence' | 'silos' | 'engagement' | 'all' } (default 'all'). Corporate-tier-only:
  // a specific disabled report 400s as social/<report>-disabled; "all" with nothing enabled 400s as
  // social/analytics-disabled.
  .post("/social/recompute", requireAuth, async (c) => {
    if (!c.var.auth!.isOperator) throw Errors.forbidden("admin/operator-required", "Operator access required");
    const projectId = c.var.projectId;
    const cfg = await getSocialConfig(projectId);
    const { report } = parseBody(socialAnalyticsRecomputeSchema, await c.req.json().catch(() => ({})), "social-analytics");
    const target = report ?? "all";
    const requested: SocialAnalyticsReport[] = target === "all" ? [...SOCIAL_ANALYTICS_REPORTS] : [target];
    const enabled = requested.filter((r) => cfg.graphEnabled && cfg[ANALYTICS_REPORT_FLAG[r]]);
    if (enabled.length === 0) {
      const code = target === "all" ? "social/analytics-disabled" : `social/${target}-disabled`;
      throw Errors.badRequest(code, "Analytics report is not enabled for this project");
    }
    await rollupAnalytics(projectId, { force: true, reports: enabled });
    return c.json({
      recomputed: enabled,
      ...(enabled.includes("influence") ? { influence: await getInfluence(projectId) } : {}),
      ...(enabled.includes("silos") ? { silos: await getSilos(projectId) } : {}),
      ...(enabled.includes("engagement") ? { engagement: await getEngagement(projectId) } : {}),
    });
  })
  // ── Read receipts (operator-only, corporate-tier) — docs/SOCIAL-GRAPH.md §4. Live Postgres coverage
  // over read-receipts-enabled spaces (no snapshot, no cron, no graph). Gate: operator first, then the
  // corporate readReceiptsAllowed flag — NOT graphEnabled (receipts are independent of Neo4j).
  .get("/social/read-receipts", requireAuth, async (c) => {
    if (!c.var.auth!.isOperator) throw Errors.forbidden("admin/operator-required", "Operator access required");
    const cfg = await getSocialConfig(c.var.projectId);
    if (!cfg.readReceiptsAllowed) {
      throw Errors.badRequest("social/read-receipts-disabled", "Read receipts are not enabled for this project");
    }
    return c.json(await getReadReceiptsCoverage(c.var.projectId));
  })
  // PATCH /admin/social/read-receipts/spaces/:spaceId { enabled } — operator flips a single space's
  // per-space opt-in. Kept in the /admin/social namespace (not the member space PATCH) so enabling
  // tracking stays an operator+corporate action ("the operator chooses; the platform enforces").
  .patch("/social/read-receipts/spaces/:spaceId", requireAuth, async (c) => {
    if (!c.var.auth!.isOperator) throw Errors.forbidden("admin/operator-required", "Operator access required");
    const cfg = await getSocialConfig(c.var.projectId);
    if (!cfg.readReceiptsAllowed) {
      throw Errors.badRequest("social/read-receipts-disabled", "Read receipts are not enabled for this project");
    }
    const { enabled } = parseBody(readReceiptsToggleSchema, await c.req.json().catch(() => ({})), "read-receipts");
    const spaceId = c.req.param("spaceId");
    const [updated] = await db
      .update(spaces)
      .set({ readReceiptsEnabled: enabled })
      .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, spaceId), isNull(spaces.deletedAt)))
      .returning({ id: spaces.id, readReceiptsEnabled: spaces.readReceiptsEnabled });
    if (!updated) throw Errors.notFound("spaces/not-found", "Space not found");
    logger.info({ projectId: c.var.projectId, spaceId, enabled }, "admin: read receipts toggled");
    return c.json({ spaceId: updated.id, readReceiptsEnabled: updated.readReceiptsEnabled });
  });
