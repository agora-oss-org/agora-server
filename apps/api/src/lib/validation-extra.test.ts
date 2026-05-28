import { describe, it, expect } from "vitest";
import {
  createSpaceSchema, updateSpaceSchema, createRuleSchema, reorderRulesSchema,
  memberRoleSchema, moderationSchema, createCollectionSchema, addEntitySchema,
  createReportSchema, signUpSchema, signInSchema, changePasswordSchema, emailSchema,
  verifyEmailSchema, externalUserSchema, oauthAuthorizeSchema,
} from "./validation.js";

const UUID = "11111111-1111-1111-1111-111111111111";
const ok = (s: any, v: unknown) => s.safeParse(v).success;

describe("space schemas", () => {
  it("createSpace requires a name and validates enums/uuids", () => {
    expect(ok(createSpaceSchema, { name: "S" })).toBe(true);
    expect(ok(createSpaceSchema, {})).toBe(false); // name required
    expect(ok(createSpaceSchema, { name: "" })).toBe(false);
    expect(ok(createSpaceSchema, { name: "S", readingPermission: "anyone", postingPermission: "admins" })).toBe(true);
    expect(ok(createSpaceSchema, { name: "S", readingPermission: "everyone" })).toBe(false);
    expect(ok(createSpaceSchema, { name: "S", parentSpaceId: "nope" })).toBe(false);
  });

  it("updateSpace rejects an empty patch but allows partials (incl. null reparent)", () => {
    expect(ok(updateSpaceSchema, {})).toBe(false); // refine: no fields
    expect(ok(updateSpaceSchema, { name: "New" })).toBe(true);
    expect(ok(updateSpaceSchema, { parentSpaceId: null })).toBe(true); // make top-level
  });
});

describe("rule schemas", () => {
  it("createRule requires a title within length", () => {
    expect(ok(createRuleSchema, { title: "No spam" })).toBe(true);
    expect(ok(createRuleSchema, {})).toBe(false);
    expect(ok(createRuleSchema, { title: "x".repeat(201) })).toBe(false);
  });

  it("reorderRules needs a non-empty list of uuids", () => {
    expect(ok(reorderRulesSchema, { order: [UUID] })).toBe(true);
    expect(ok(reorderRulesSchema, { order: [] })).toBe(false);
    expect(ok(reorderRulesSchema, { order: ["not-uuid"] })).toBe(false);
  });
});

describe("member role + moderation schemas", () => {
  it("memberRole accepts only the three roles", () => {
    expect(ok(memberRoleSchema, { role: "moderator" })).toBe(true);
    expect(ok(memberRoleSchema, { role: "owner" })).toBe(false);
  });
  it("moderation accepts approved/removed with optional reason", () => {
    expect(ok(moderationSchema, { status: "removed", reason: "spam" })).toBe(true);
    expect(ok(moderationSchema, { status: "approved" })).toBe(true);
    expect(ok(moderationSchema, { status: "hidden" })).toBe(false);
  });
});

describe("collection + report schemas", () => {
  it("createCollection requires a name; addEntity requires a uuid", () => {
    expect(ok(createCollectionSchema, { name: "Faves" })).toBe(true);
    expect(ok(createCollectionSchema, { name: "Faves", parentId: UUID })).toBe(true);
    expect(ok(createCollectionSchema, { name: "" })).toBe(false);
    expect(ok(addEntitySchema, { entityId: UUID })).toBe(true);
    expect(ok(addEntitySchema, { entityId: "x" })).toBe(false);
  });

  it("createReport requires targetType enum + uuid targetId + reason", () => {
    expect(ok(createReportSchema, { targetType: "entity", targetId: UUID, reason: "spam" })).toBe(true);
    expect(ok(createReportSchema, { targetType: "comment", targetId: UUID, reason: "x" })).toBe(true);
    expect(ok(createReportSchema, { targetType: "message", targetId: UUID, reason: "x" })).toBe(false); // not in enum
    expect(ok(createReportSchema, { targetType: "entity", targetId: UUID })).toBe(false); // reason required
  });
});

describe("auth schemas", () => {
  it("signUp/signIn validate email + password length", () => {
    expect(ok(signUpSchema, { email: "a@b.co", password: "longenough8" })).toBe(true);
    expect(ok(signUpSchema, { email: "bad", password: "longenough8" })).toBe(false);
    expect(ok(signUpSchema, { email: "a@b.co", password: "short" })).toBe(false); // < 8
    expect(ok(signInSchema, { email: "a@b.co", password: "x" })).toBe(true); // sign-in min 1
  });

  it("changePassword enforces newPassword >= 8", () => {
    expect(ok(changePasswordSchema, { currentPassword: "x", newPassword: "longenough8" })).toBe(true);
    expect(ok(changePasswordSchema, { currentPassword: "x", newPassword: "short" })).toBe(false);
  });

  it("email + verifyEmail + oauth schemas", () => {
    expect(ok(emailSchema, { email: "a@b.co" })).toBe(true);
    expect(ok(emailSchema, { email: "nope" })).toBe(false);
    expect(ok(verifyEmailSchema, { tokenHash: "abc" })).toBe(true);
    expect(ok(verifyEmailSchema, { tokenHash: "abc", type: "recovery" })).toBe(true);
    expect(ok(verifyEmailSchema, { tokenHash: "abc", type: "weird" })).toBe(false);
    expect(ok(oauthAuthorizeSchema, { provider: "google", redirectAfterAuth: "myapp://cb" })).toBe(true);
    expect(ok(oauthAuthorizeSchema, { provider: "google" })).toBe(false);
  });

  it("externalUser requires userJwt or the legacy token alias", () => {
    expect(ok(externalUserSchema, { userJwt: "jwt" })).toBe(true);
    expect(ok(externalUserSchema, { token: "jwt" })).toBe(true);
    expect(ok(externalUserSchema, {})).toBe(false);
  });
});
