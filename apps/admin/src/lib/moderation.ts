// Moderation data access. Listing the queues uses the role-scoped /reports endpoints; taking action
// uses the space-scoped moderation + report-resolution endpoints (so a report must carry a spaceId).
import type { PaginatedResponse, Report, Entity, Comment } from "@agora/contract";
import { api } from "./api";

export type ReportStatus = "pending" | "moderated";
export type ModerationDecision = "approved" | "removed";

export const reportsKey = (status: ReportStatus, page: number) => ["reports", status, page] as const;

export function listReports(status: ReportStatus, page: number) {
  return api<PaginatedResponse<Report>>(`/reports/${status}`, { query: { page } });
}

/** Fetch the reported target (for the review panel). Only entity/comment are reportable today. */
export function getReportTarget(report: Report): Promise<Entity | Comment | null> {
  if (report.targetType === "entity") return api<Entity>(`/entities/${report.targetId}`);
  if (report.targetType === "comment") return api<Comment>(`/comments/${report.targetId}`);
  return Promise.resolve(null);
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
 * Requires `report.spaceId` (the endpoints are space-scoped).
 */
export async function actOnReport(report: Report, action: ModerationDecision | "dismiss", reason?: string) {
  if (!report.spaceId) throw new Error("This report isn't scoped to a space, so it can't be actioned here.");
  if (action !== "dismiss") await moderateContent(report.spaceId, report, action, reason);
  await resolveReports(report.spaceId, report);
}
