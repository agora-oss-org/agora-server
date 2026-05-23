import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  parseBody,
  createEntitySchema,
  createCommentSchema,
  reactionSchema,
} from "./validation.js";
import { ApiError } from "../http/errors.js";

describe("parseBody", () => {
  it("returns the parsed data on success", () => {
    const out = parseBody(reactionSchema, { type: "love" }, "entities");
    expect(out).toEqual({ type: "love" });
  });

  it("throws a Replyke-shaped 400 with feature-scoped code and offending field", () => {
    try {
      parseBody(createCommentSchema, { entityId: "not-a-uuid" }, "comments");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(400);
      expect(err.code).toBe("comments/invalid-body");
      expect(err.field).toBe("entityId");
    }
  });

  it("reports a nested field path joined by dots", () => {
    const schema = z.object({ a: z.object({ b: z.string() }) });
    try {
      parseBody(schema, { a: { b: 1 } }, "x");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ApiError).field).toBe("a.b");
    }
  });
});

describe("reactionSchema", () => {
  it("accepts the 8 contract types", () => {
    for (const type of ["upvote", "downvote", "like", "love", "wow", "sad", "angry", "funny"]) {
      expect(reactionSchema.safeParse({ type }).success).toBe(true);
    }
  });

  it("rejects unknown reaction types", () => {
    expect(reactionSchema.safeParse({ type: "dislike" }).success).toBe(false);
  });
});

describe("createEntitySchema", () => {
  it("allows an empty body (all fields optional)", () => {
    expect(createEntitySchema.safeParse({}).success).toBe(true);
  });

  it("rejects a non-uuid spaceId", () => {
    expect(createEntitySchema.safeParse({ spaceId: "nope" }).success).toBe(false);
  });
});

describe("createCommentSchema", () => {
  it("requires a uuid entityId", () => {
    expect(createCommentSchema.safeParse({}).success).toBe(false);
    expect(createCommentSchema.safeParse({ entityId: "11111111-1111-1111-1111-111111111111" }).success).toBe(true);
  });
});
