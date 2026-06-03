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
import { buildRunningConfig } from "../lib/running-config.js";
import { getOverview, umamiReportingEnabled, type UmamiSite } from "../lib/umami-reporting.js";
import { getServerResources } from "../lib/server-resources.js";
import { db } from "../db/index.js";
import {
  profiles, reports, spaces, spaceMembers, entities, comments, files, apiUsage,
} from "../db/schema/index.js";

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

    // Non-operators only see reports for spaces they moderate. Project-wide counts (members,
    // entities, etc.) stay project-scoped — they're not space-partitioned and a moderator's
    // dashboard still shows the project's totals as context.
    const spaceScope = isOperator ? null : await moderatedSpaceIds(projectId, userId);

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
      scope: isOperator ? "operator" : "moderator",
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

  // GET /admin/umami/overview?site=product|admin&days=N — OPERATOR-ONLY analytics read-back. Proxies
  // the Umami reporting API with the secret AGORA_UMAMI_API_KEY (server-side only, never exposed to
  // the browser): summary stats + top custom events + a daily pageviews/sessions series for one site.
  .get("/umami/overview", requireAuth, async (c) => {
    if (!c.var.auth!.isOperator) throw Errors.forbidden("admin/operator-required", "Operator access required");
    if (!umamiReportingEnabled())
      throw Errors.badRequest("admin/umami-disabled", "Umami reporting is not configured (AGORA_UMAMI_URL + AGORA_UMAMI_API_KEY)");
    const site: UmamiSite = c.req.query("site") === "admin" ? "admin" : "product";
    const days = Math.min(Math.max(Number(c.req.query("days")) || 7, 1), 90); // clamp 1..90
    return c.json(await getOverview(site, days));
  });
