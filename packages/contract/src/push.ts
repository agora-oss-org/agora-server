// Push device registration identifiers (SDK PushDeviceIdentifier union). Pure zod + types.
import { z } from "zod";

const nativeDevice = z.object({
  platform: z.enum(["ios", "android"]),
  token: z.string().min(1),
});
const webDevice = z.object({
  platform: z.literal("web"),
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
});
export const pushDeviceSchema = z.discriminatedUnion("platform", [nativeDevice, webDevice]);

export type PushDeviceIdentifier = z.infer<typeof pushDeviceSchema>;
export interface PushDevice {
  id: string; projectId: string; userId: string;
  platform: "ios" | "android" | "web";
  token: string | null;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } } | null;
  createdAt: string; updatedAt: string;
}

// ─── Push event types (must match the SDK's PUSH_EVENT_TYPES exactly, same order) ────────────────
// Source of truth mirrored by @agora-sdk core/interfaces/PushEventType.ts. Used by
// useNotificationPreferences (opt-OUT set) and validated server-side.
export const PUSH_EVENT_TYPES = [
  "entity-comment", "comment-reply", "entity-mention", "comment-mention",
  "entity-upvote", "comment-upvote", "entity-reaction", "comment-reaction",
  "entity-reaction-milestone-specific", "entity-reaction-milestone-total",
  "comment-reaction-milestone-specific", "comment-reaction-milestone-total",
  "new-follow", "connection-request", "connection-accepted",
  "space-membership-approved", "event-invite", "event-updated", "event-cancelled",
  "message",
] as const;
export type PushEventType = (typeof PUSH_EVENT_TYPES)[number];
export const pushEventType = z.enum(PUSH_EVENT_TYPES);

// GET returns { disabledTypes }; PUT is a full-replace upsert of the same shape.
export const updateNotificationPreferencesSchema = z.object({
  disabledTypes: z.array(pushEventType).default([]),
});
