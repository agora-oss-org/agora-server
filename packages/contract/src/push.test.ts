import { describe, it, expect } from "vitest";
import { PUSH_EVENT_TYPES, updateNotificationPreferencesSchema } from "./push.js";

describe("PUSH_EVENT_TYPES", () => {
  it("is the exact 20-value SDK set", () => {
    expect(PUSH_EVENT_TYPES).toEqual([
      "entity-comment", "comment-reply", "entity-mention", "comment-mention",
      "entity-upvote", "comment-upvote", "entity-reaction", "comment-reaction",
      "entity-reaction-milestone-specific", "entity-reaction-milestone-total",
      "comment-reaction-milestone-specific", "comment-reaction-milestone-total",
      "new-follow", "connection-request", "connection-accepted",
      "space-membership-approved", "event-invite", "event-updated", "event-cancelled",
      "message",
    ]);
  });
});

describe("updateNotificationPreferencesSchema", () => {
  it("accepts a valid disabledTypes set", () => {
    const r = updateNotificationPreferencesSchema.parse({ disabledTypes: ["message", "new-follow"] });
    expect(r.disabledTypes).toEqual(["message", "new-follow"]);
  });
  it("rejects an unknown push type", () => {
    expect(() => updateNotificationPreferencesSchema.parse({ disabledTypes: ["not-a-type"] })).toThrow();
  });
  it("defaults missing disabledTypes to []", () => {
    expect(updateNotificationPreferencesSchema.parse({}).disabledTypes).toEqual([]);
  });
});
