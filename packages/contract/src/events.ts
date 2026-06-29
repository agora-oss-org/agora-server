// Events domain request schemas + response types (SDK v7.6.2). Pure zod + types — no server coupling.
import { z } from "zod";

export const eventTypeEnum = z.enum(["online", "physical", "hybrid"]);
export const eventVisibilityEnum = z.enum(["public", "members", "invite"]);
export const eventStatusEnum = z.enum(["active", "cancelled"]);
export const rsvpStatusEnum = z.enum(["going", "maybe", "not_going"]);

const locationInput = z.object({ latitude: z.number(), longitude: z.number() }).nullish();

export const createEventSchema = z.object({
  title: z.string().min(1),
  startTime: z.string(),            // ISO 8601
  type: eventTypeEnum,
  description: z.string().nullish(),
  endTime: z.string().nullish(),
  timezone: z.string().nullish(),
  url: z.string().nullish(),
  venueName: z.string().nullish(),
  address: z.string().nullish(),
  location: locationInput,
  spaceId: z.string().uuid().nullish(),
  visibility: eventVisibilityEnum.optional(),     // default "public" server-side
  capacity: z.number().int().positive().nullish(),
  allowMaybe: z.boolean().nullish(),
  guestListVisible: z.boolean().nullish(),
  hostIds: z.array(z.string().uuid()).nullish(),  // creator auto-added
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

// Update = the same scalar set, all optional, MINUS hostIds (hosts are managed via /hosts), plus removeImageIds.
export const updateEventSchema = z.object({
  title: z.string().min(1).optional(),
  startTime: z.string().optional(),
  type: eventTypeEnum.optional(),
  description: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  venueName: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  location: locationInput,
  spaceId: z.string().uuid().nullable().optional(),
  visibility: eventVisibilityEnum.optional(),
  status: eventStatusEnum.optional(),
  capacity: z.number().int().positive().nullable().optional(),
  allowMaybe: z.boolean().optional(),
  guestListVisible: z.boolean().optional(),
  removeImageIds: z.array(z.string().uuid()).optional(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
}).refine((v) => Object.keys(v).length > 0, { message: "No updatable fields provided" });

export const rsvpSchema = z.object({ status: rsvpStatusEnum });
export const eventUserIdSchema = z.object({ userId: z.string().uuid() });

export type EventType = z.infer<typeof eventTypeEnum>;
export type EventVisibility = z.infer<typeof eventVisibilityEnum>;
export type EventStatus = z.infer<typeof eventStatusEnum>;
export type RsvpStatus = z.infer<typeof rsvpStatusEnum>;

export interface Event {
  id: string; shortId: string; projectId: string;
  userId: string | null; user?: unknown | null;
  title: string; description: string | null;
  startTime: string; endTime: string | null; timezone: string | null;
  type: EventType; url: string | null;
  venueName: string | null; address: string | null;
  location: { type: "Point"; coordinates: [number, number] } | null;
  spaceId: string | null; space?: unknown | null;
  visibility: EventVisibility; status: EventStatus;
  allowMaybe: boolean; guestListVisible: boolean;
  capacity: number | null;
  hostIds: string[];
  coverImageId: string | null; files?: unknown[];
  rsvpCounts: { going: number; maybe: number; not_going: number };
  userRsvp?: RsvpStatus | null;
  metadata: Record<string, unknown>;
  createdAt: string; updatedAt: string; deletedAt: string | null;
}
export interface EventRsvp { id: string; eventId: string; userId: string; user?: unknown; status: RsvpStatus; createdAt: string; updatedAt: string }
export interface EventInvite { id: string; eventId: string; userId: string; user?: unknown; invitedAt: string; createdAt: string; updatedAt: string }
