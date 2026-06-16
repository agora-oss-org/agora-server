// Spaces management (admin Spaces section). Lists the project's top-level spaces and edits a space's
// basic settings via the existing GET/PATCH /v7/:projectId/spaces — reachable here because
// requireSpaceRole folds in project admins/operators (see apps/api routes/spaces.ts). Hierarchy moves,
// rules, and membership management are out of scope for this section.
import type { PaginatedResponse } from "@agora-server/contract";
import { api } from "./api";

export interface Space {
  id: string;
  projectId: string;
  shortId: string;
  slug: string | null;
  name: string;
  description: string | null;
  readingPermission: "anyone" | "members";
  postingPermission: "anyone" | "members" | "admins";
  requireJoinApproval: boolean;
  parentSpaceId: string | null;
  depth: number;
  membersCount: number;
  childSpacesCount: number;
  /** Disclosed per-space read-receipts opt-in (corporate tier). Flipped via the read-receipts toggle. */
  readReceiptsEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const spacesKey = ["spaces"] as const;

/** Top-level spaces (GET /spaces returns the root level when no parent filter is given). */
export function listSpaces(signal?: AbortSignal): Promise<PaginatedResponse<Space>> {
  return api<PaginatedResponse<Space>>("/spaces", { query: { limit: 100 }, signal });
}

export interface SpacePatch {
  name?: string;
  description?: string | null;
  readingPermission?: "anyone" | "members";
  postingPermission?: "anyone" | "members" | "admins";
  requireJoinApproval?: boolean;
}

export function updateSpace(id: string, patch: SpacePatch): Promise<Space> {
  return api<Space>(`/spaces/${id}`, { method: "PATCH", body: patch });
}
