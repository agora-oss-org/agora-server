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
