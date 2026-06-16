// Per-space read-receipts coverage (operator-only, corporate tier) — GET /admin/social/read-receipts +
// PATCH /admin/social/read-receipts/spaces/:spaceId. The coverage read serves LIVE Postgres counts (no
// snapshot). Both are operator-gated + corporate-tier-gated server-side; a community-tier project 400s
// `social/read-receipts-disabled`, which the UI renders as a "corporate tier required" state.
import type { SocialReadReceipts } from "@agora-server/contract";
import { api } from "./api";

export type { SocialReadReceipts, ReceiptSpace, ReceiptAnnouncement } from "@agora-server/contract";

export const readReceiptsKey = ["read-receipts"] as const;

export function getReadReceipts(signal?: AbortSignal): Promise<SocialReadReceipts> {
  return api<SocialReadReceipts>("/admin/social/read-receipts", { signal });
}

export interface ReceiptsToggleResult {
  spaceId: string;
  readReceiptsEnabled: boolean;
}

export function toggleSpaceReceipts(spaceId: string, enabled: boolean): Promise<ReceiptsToggleResult> {
  return api<ReceiptsToggleResult>(`/admin/social/read-receipts/spaces/${spaceId}`, {
    method: "PATCH",
    body: { enabled },
  });
}
