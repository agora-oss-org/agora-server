// Moderation data access. Listing the queues uses the role-scoped /reports endpoints; taking action
// uses the space-scoped moderation + report-resolution endpoints (so a report must carry a spaceId).
import type { PaginatedResponse, Report, Entity, Comment, ReportTargetType } from "@agora/contract";
import { api } from "./api";
import { DEMO_URL } from "../config";

export type ReportStatus = "pending" | "moderated";
export type ModerationDecision = "approved" | "removed";

export const reportsKey = (status: ReportStatus, page: number) => ["reports", status, page] as const;

export function listReports(status: ReportStatus, page: number) {
  return api<PaginatedResponse<Report>>(`/reports/${status}`, { query: { page } });
}

/** Fetch a moderatable target's content by type + id (for the review panels). Only entity/comment
 *  are loadable today. Shape asymmetry: GET /entities/:id returns the entity bare, but GET
 *  /comments/:id wraps it as `{ comment }` (the SDK's useFetchComment contract) — unwrap the comment. */
export function getTargetContent(targetType: ReportTargetType, targetId: string): Promise<Entity | Comment | null> {
  if (targetType === "entity") return api<Entity>(`/entities/${targetId}`);
  if (targetType === "comment")
    return api<{ comment: Comment }>(`/comments/${targetId}`).then((r) => r.comment);
  return Promise.resolve(null); // message (and anything else) isn't loadable here
}

/** Fetch the reported target (for the report ReviewDialog). */
export function getReportTarget(report: Report): Promise<Entity | Comment | null> {
  return getTargetContent(report.targetType, report.targetId);
}

/**
 * Deep link from a report to the reported content in the consumer/demo app (DEMO_URL). The demo reads
 * `?entity=<id>[&comment=<id>]` off its URL. For a comment we need its parent `entityId`, which only
 * comes from the loaded target — so this returns null until the comment target is available.
 */
export function contentDeepLink(
  targetType: ReportTargetType,
  targetId: string,
  target: Entity | Comment | null,
): string | null {
  let entityId: string | undefined;
  let commentId: string | undefined;
  if (targetType === "entity") {
    entityId = targetId;
  } else if (targetType === "comment") {
    entityId = (target as Comment | null)?.entityId; // parent entity — needs the loaded comment
    commentId = targetId;
  }
  if (!entityId) return null;
  try {
    const url = new URL(DEMO_URL);
    url.searchParams.set("entity", entityId);
    if (commentId) url.searchParams.set("comment", commentId);
    return url.toString();
  } catch {
    return null; // malformed DEMO_URL
  }
}

/** Deep link from a report to the reported content in the consumer/demo app. */
export function reportDeepLink(report: Report, target: Entity | Comment | null): string | null {
  return contentDeepLink(report.targetType, report.targetId, target);
}

// ── space-scoped actions ──────────────────────────────────────────────────────
function moderateContent(spaceId: string, report: Report, status: ModerationDecision, reason?: string) {
  const kind = report.targetType === "comment" ? "comments" : "entities";
  return api(`/spaces/${spaceId}/${kind}/${report.targetId}/moderation`, {
    method: "PATCH",
    body: { status, ...(reason ? { reason } : {}) },
  });
}

function resolveReports(spaceId: string, report: Report) {
  const kind = report.targetType === "comment" ? "comment" : "entity";
  return api(`/spaces/${spaceId}/reports/${kind}/${report.targetId}`, { method: "PATCH" });
}

/**
 * Apply a moderation decision to a reported item and resolve the report in one go.
 * - "removed"/"approved" → moderate the content, then mark the report resolved.
 * - "dismiss"            → resolve the report without touching the content.
 * Space-scoped reports go through the space endpoints (role-checked). Project-level reports (no
 * space) use the operator-only /reports/:id/resolve endpoint (operators have the god-view).
 */
export async function actOnReport(report: Report, action: ModerationDecision | "dismiss", reason?: string) {
  if (report.spaceId) {
    if (action !== "dismiss") await moderateContent(report.spaceId, report, action, reason);
    await resolveReports(report.spaceId, report);
    return;
  }
  await api(`/reports/${report.id}/resolve`, { method: "PATCH", body: { action, ...(reason ? { reason } : {}) } });
}
