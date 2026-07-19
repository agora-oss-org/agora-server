// SDK-contract conformance at the zod-schema boundary (Class 1 — request field names).
// Each case encodes the EXACT body shape the sublay-fork SDK sends (../agora-sdk). The server
// schema MUST accept it and normalize to the field/handlers already read. These are RED until
// the schemas accept the SDK's field names; do NOT relax them by dropping the original names
// (the admin app + server tests still send those).
import { describe, it, expect } from "vitest";
import {
  changePasswordSchema,
  verifyEmailSchema,
  createCollectionSchema,
  moderationSchema,
} from "./validation.js";
import { createEventSchema, updateEventSchema, rsvpSchema, rsvpStatusEnum, pushDeviceSchema, commentSortBySchema, sortDirSchema, entityVisibilitySchema } from "@agora-server/contract";

describe("SDK contract — request field names (Class 1)", () => {
  describe("change-password: SDK sends `password` for the current password", () => {
    // useAuth/changePasswordThunk → axios.post(.../auth/change-password, { password, newPassword })
    it("accepts { password, newPassword } and normalizes to currentPassword", () => {
      const r = changePasswordSchema.safeParse({ password: "oldsecret", newPassword: "newsecret1" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.currentPassword).toBe("oldsecret");
    });
    it("still accepts the native { currentPassword, newPassword } shape", () => {
      const r = changePasswordSchema.safeParse({ currentPassword: "oldsecret", newPassword: "newsecret1" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.currentPassword).toBe("oldsecret");
    });
    it("rejects when neither current-password field is present", () => {
      expect(changePasswordSchema.safeParse({ newPassword: "newsecret1" }).success).toBe(false);
    });
  });

  describe("verify-email: SDK sends `token`", () => {
    // useVerifyEmail → axios.post(.../auth/verify-email, { token })
    it("accepts { token } and normalizes to tokenHash", () => {
      const r = verifyEmailSchema.safeParse({ token: "abc123" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.tokenHash).toBe("abc123");
    });
    it("still accepts the native { tokenHash } shape", () => {
      const r = verifyEmailSchema.safeParse({ tokenHash: "abc123" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.tokenHash).toBe("abc123");
    });
  });

  describe("create sub-collection: SDK sends `collectionName`", () => {
    // useCreateCollectionMutation → POST .../sub-collections { collectionName }
    it("accepts { collectionName } and normalizes to name", () => {
      const r = createCollectionSchema.safeParse({ collectionName: "Favorites" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.name).toBe("Favorites");
    });
    it("still accepts the native { name } shape", () => {
      const r = createCollectionSchema.safeParse({ name: "Favorites" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.name).toBe("Favorites");
    });
  });

  describe("space moderation: SDK sends { action: approve|remove }", () => {
    // useModerateSpaceEntity/Comment → PATCH .../moderation { action, reason }
    it("accepts { action: 'approve' } and normalizes to status 'approved'", () => {
      const r = moderationSchema.safeParse({ action: "approve" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.status).toBe("approved");
    });
    it("accepts { action: 'remove', reason } and normalizes to status 'removed'", () => {
      const r = moderationSchema.safeParse({ action: "remove", reason: "spam" });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.status).toBe("removed");
        expect(r.data.reason).toBe("spam");
      }
    });
    it("still accepts the native { status } shape", () => {
      const r = moderationSchema.safeParse({ status: "approved" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.status).toBe("approved");
    });
  });
});

describe("event schemas", () => {
  it("requires title, startTime, and type on create", () => {
    expect(createEventSchema.safeParse({ title: "Party", startTime: "2026-07-01T18:00:00Z", type: "online" }).success).toBe(true);
    expect(createEventSchema.safeParse({ title: "Party" }).success).toBe(false); // missing startTime/type
  });
  it("rejects an unknown event type", () => {
    expect(createEventSchema.safeParse({ title: "x", startTime: "2026-07-01T18:00:00Z", type: "bogus" }).success).toBe(false);
  });
  it("accepts the three RSVP statuses and rejects others", () => {
    for (const s of ["going", "maybe", "not_going"]) expect(rsvpSchema.safeParse({ status: s }).success).toBe(true);
    expect(rsvpSchema.safeParse({ status: "perhaps" }).success).toBe(false);
    expect(rsvpStatusEnum.options).toEqual(["going", "maybe", "not_going"]);
  });
  it("rejects an empty update body but accepts any single field", () => {
    expect(updateEventSchema.safeParse({}).success).toBe(false); // the .refine — no updatable fields
    expect(updateEventSchema.safeParse({ title: "Renamed" }).success).toBe(true);
    expect(updateEventSchema.safeParse({ description: null }).success).toBe(true); // nullable clear counts
  });
});

describe("comment sort schemas", () => {
  it("accepts the documented sortBy values incl. deprecated aliases", () => {
    for (const v of ["createdAt", "top", "controversial", "new", "old"]) {
      expect(commentSortBySchema.safeParse(v).success).toBe(true);
    }
  });
  it("rejects values outside the documented set", () => {
    for (const v of ["bogus", "hot", "", "CreatedAt"]) {
      expect(commentSortBySchema.safeParse(v).success).toBe(false);
    }
  });
  it("accepts asc/desc for sortDir", () => {
    expect(sortDirSchema.safeParse("asc").success).toBe(true);
    expect(sortDirSchema.safeParse("desc").success).toBe(true);
    expect(sortDirSchema.safeParse("sideways").success).toBe(false);
  });
});

describe("pushDeviceSchema", () => {
  it("accepts a native identifier", () => {
    expect(pushDeviceSchema.safeParse({ platform: "ios", token: "abc" }).success).toBe(true);
    expect(pushDeviceSchema.safeParse({ platform: "android", token: "abc" }).success).toBe(true);
  });
  it("accepts a web subscription", () => {
    expect(pushDeviceSchema.safeParse({ platform: "web", subscription: { endpoint: "https://x", keys: { p256dh: "p", auth: "a" } } }).success).toBe(true);
  });
  it("rejects native without a token and web without a subscription", () => {
    expect(pushDeviceSchema.safeParse({ platform: "ios" }).success).toBe(false);
    expect(pushDeviceSchema.safeParse({ platform: "web", token: "abc" }).success).toBe(false);
    expect(pushDeviceSchema.safeParse({ platform: "desktop", token: "abc" }).success).toBe(false);
  });
});

describe("entityVisibilitySchema", () => {
  it("accepts a boolean public flag", () => {
    expect(entityVisibilitySchema.parse({ public: true })).toEqual({ public: true });
    expect(entityVisibilitySchema.parse({ public: false })).toEqual({ public: false });
  });
  it("rejects missing/non-boolean", () => {
    expect(entityVisibilitySchema.safeParse({}).success).toBe(false);
    expect(entityVisibilitySchema.safeParse({ public: "yes" }).success).toBe(false);
  });
});
