import { describe, it, expect } from "vitest";
import {
  reactionSchema,
  createEntitySchema,
  updateEntitySchema,
  createCommentSchema,
  createReportSchema,
  createSpaceSchema,
  sendMessageSchema,
  rankParamsSchema,
  signUpSchema,
  stewardConfigSchema,
  createConversationSchema,
  moderationAnalyzeSchema,
} from "./schemas.js";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("reactionSchema — the SDK field-name contract", () => {
  it("accepts the SDK's { reactionType }", () => {
    expect(reactionSchema.safeParse({ reactionType: "upvote" }).success).toBe(true);
    expect(reactionSchema.safeParse({ reactionType: "funny" }).success).toBe(true);
  });

  it("rejects the legacy { type } field (the exact drift the integration suite hit)", () => {
    expect(reactionSchema.safeParse({ type: "upvote" }).success).toBe(false);
  });

  it("rejects an unknown reaction value and a missing field", () => {
    expect(reactionSchema.safeParse({ reactionType: "thumbsup" }).success).toBe(false);
    expect(reactionSchema.safeParse({}).success).toBe(false);
  });
});

describe("createEntitySchema", () => {
  it("accepts content/title and an empty object (all fields optional)", () => {
    expect(createEntitySchema.safeParse({ content: "hi" }).success).toBe(true);
    expect(createEntitySchema.safeParse({ title: "t" }).success).toBe(true);
    expect(createEntitySchema.safeParse({}).success).toBe(true);
  });

  it("accepts null for nullish fields (SDK sends absent fields as null)", () => {
    expect(createEntitySchema.safeParse({ content: null, title: null, spaceId: null }).success).toBe(true);
  });

  it("rejects a non-uuid spaceId", () => {
    expect(createEntitySchema.safeParse({ content: "x", spaceId: "not-a-uuid" }).success).toBe(false);
  });
});

describe("updateEntitySchema — refine requires at least one field", () => {
  it("rejects an empty patch", () => {
    expect(updateEntitySchema.safeParse({}).success).toBe(false);
  });
  it("accepts a single-field patch", () => {
    expect(updateEntitySchema.safeParse({ content: "edited" }).success).toBe(true);
  });
});

describe("createCommentSchema", () => {
  it("requires a uuid entityId", () => {
    expect(createCommentSchema.safeParse({ entityId: UUID, content: "hi" }).success).toBe(true);
    expect(createCommentSchema.safeParse({ content: "hi" }).success).toBe(false); // missing entityId
    expect(createCommentSchema.safeParse({ entityId: "nope", content: "hi" }).success).toBe(false);
  });
  it("allows null content (gif-only / blank comments handled downstream)", () => {
    expect(createCommentSchema.safeParse({ entityId: UUID, content: null }).success).toBe(true);
  });
});

describe("createReportSchema — entity/comment only", () => {
  it("accepts entity and comment targets", () => {
    expect(createReportSchema.safeParse({ targetType: "entity", targetId: UUID, reason: "spam" }).success).toBe(true);
    expect(createReportSchema.safeParse({ targetType: "comment", targetId: UUID, reason: "spam" }).success).toBe(true);
  });
  it("rejects a message target (messages report through the chat endpoint, not POST /reports)", () => {
    expect(createReportSchema.safeParse({ targetType: "message", targetId: UUID, reason: "x" }).success).toBe(false);
  });
  it("requires a non-empty reason within the length cap", () => {
    expect(createReportSchema.safeParse({ targetType: "entity", targetId: UUID, reason: "" }).success).toBe(false);
    expect(createReportSchema.safeParse({ targetType: "entity", targetId: UUID, reason: "a".repeat(101) }).success).toBe(false);
  });
});

describe("createSpaceSchema", () => {
  it("requires a name and validates the permission enums", () => {
    expect(createSpaceSchema.safeParse({ name: "S" }).success).toBe(true);
    expect(createSpaceSchema.safeParse({ name: "" }).success).toBe(false);
    expect(createSpaceSchema.safeParse({ name: "S", readingPermission: "members", postingPermission: "admins" }).success).toBe(true);
    expect(createSpaceSchema.safeParse({ name: "S", readingPermission: "everyone" }).success).toBe(false);
  });
});

describe("sendMessageSchema — refine requires content or gif", () => {
  it("accepts a text message and a gif-only message", () => {
    expect(sendMessageSchema.safeParse({ content: "hi" }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ gif: { id: "x" } }).success).toBe(true);
  });
  it("rejects an empty message (neither content nor gif)", () => {
    expect(sendMessageSchema.safeParse({}).success).toBe(false);
    expect(sendMessageSchema.safeParse({ mentions: [] }).success).toBe(false);
  });
});

describe("rankParamsSchema — finite, range-clamped numerics (no SQL injection surface)", () => {
  it("accepts in-range partial params", () => {
    expect(rankParamsSchema.safeParse({ halfLifeHours: 24, gravity: 1.8 }).success).toBe(true);
    expect(rankParamsSchema.safeParse({}).success).toBe(true);
  });
  it("rejects out-of-range and non-finite values", () => {
    expect(rankParamsSchema.safeParse({ gravity: 99 }).success).toBe(false);
    expect(rankParamsSchema.safeParse({ halfLifeHours: 0 }).success).toBe(false);
    expect(rankParamsSchema.safeParse({ z: Infinity }).success).toBe(false);
  });
});

describe("signUpSchema", () => {
  it("requires a valid email and an 8+ char password", () => {
    expect(signUpSchema.safeParse({ email: "a@b.co", password: "longenough" }).success).toBe(true);
    expect(signUpSchema.safeParse({ email: "not-an-email", password: "longenough" }).success).toBe(false);
    expect(signUpSchema.safeParse({ email: "a@b.co", password: "short" }).success).toBe(false);
  });
});

describe("stewardConfigSchema — partial enum config", () => {
  it("accepts valid enum members and a partial/empty object", () => {
    expect(stewardConfigSchema.safeParse({ notifyPolicy: "power-aware" }).success).toBe(true);
    expect(stewardConfigSchema.safeParse({ mediationMode: "hybrid", mediationOnClose: "archive-read-only" }).success).toBe(true);
    expect(stewardConfigSchema.safeParse({}).success).toBe(true);
  });
  it("rejects an unknown policy", () => {
    expect(stewardConfigSchema.safeParse({ notifyPolicy: "broadcast" }).success).toBe(false);
  });
});

describe("createConversationSchema", () => {
  it("accepts group/space types and uuid member ids", () => {
    expect(createConversationSchema.safeParse({ type: "group", memberIds: [UUID] }).success).toBe(true);
    expect(createConversationSchema.safeParse({}).success).toBe(true);
  });
  it("rejects a non-uuid member id and a bad posting permission", () => {
    expect(createConversationSchema.safeParse({ memberIds: ["x"] }).success).toBe(false);
    expect(createConversationSchema.safeParse({ postingPermission: "anyone" }).success).toBe(false); // chat is members|admins
  });
});

describe("moderationAnalyzeSchema", () => {
  it("accepts a message target with text (the moderator analyzes all three content types)", () => {
    expect(moderationAnalyzeSchema.safeParse({ targetType: "message", targetId: UUID, text: "hello" }).success).toBe(true);
  });
  it("requires non-empty text within the cap", () => {
    expect(moderationAnalyzeSchema.safeParse({ targetType: "entity", targetId: UUID, text: "" }).success).toBe(false);
  });
});
