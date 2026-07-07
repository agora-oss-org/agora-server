import { describe, it, expect } from "vitest";
import {
  shapeUser,
  shapeEntity,
  shapeComment,
  shapeSpace,
  generateShortId,
  parseInclude,
  parseBoolFlag,
  REACTION_TYPES,
} from "./shape.js";

const ZERO_COUNTS = { upvote: 0, downvote: 0, like: 0, love: 0, wow: 0, sad: 0, angry: 0, funny: 0 };

// A Drizzle profile row (camelCase, Date timestamps) including fields the public shape must drop.
// Typed as `any` — a hand-built fixture, not a full ProfileRow ($inferSelect).
function profileRow(over: Record<string, any> = {}): any {
  return {
    id: "u1",
    projectId: "p1",
    foreignId: null,
    role: "visitor",
    name: "Jett",
    username: "jett",
    avatar: null,
    avatarFileId: null,
    bannerFileId: null,
    bio: null,
    birthdate: null,
    metadata: { theme: "dark" },
    reputation: 7,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    // sensitive / non-public — must be stripped:
    email: "jett@example.com",
    secureMetadata: { ssn: "x" },
    isVerified: true,
    isActive: true,
    lastActive: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function entityRow(over: Record<string, any> = {}) {
  return {
    id: "e1",
    projectId: "p1",
    shortId: "abc123",
    foreignId: null,
    sourceId: null,
    spaceId: null,
    userId: "u1",
    title: "Hi",
    content: "Body",
    mentions: [],
    attachments: [],
    keywords: ["a"],
    upvotes: [],
    downvotes: [],
    reactionCounts: { ...ZERO_COUNTS, upvote: 3 },
    repliesCount: 0,
    views: 0,
    score: 1.5,
    scoreUpdatedAt: new Date("2026-01-02T00:00:00.000Z"),
    metadata: {},
    isDraft: false,
    moderationStatus: null,
    moderatedAt: null,
    moderatedById: null,
    moderatedByType: null,
    moderationReason: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...over,
  };
}

function commentRow(over: Record<string, any> = {}) {
  return {
    id: "c1",
    projectId: "p1",
    foreignId: null,
    entityId: "e1",
    userId: "u1",
    parentId: null,
    content: "a comment",
    gif: { url: "g" },
    mentions: [],
    upvotes: [],
    downvotes: [],
    reactionCounts: ZERO_COUNTS,
    repliesCount: 0,
    metadata: {},
    moderationStatus: null,
    moderatedAt: null,
    moderatedById: null,
    moderatedByType: null,
    moderationReason: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    userDeletedAt: null,
    ...over,
  };
}

describe("shapeUser", () => {
  it("drops non-public fields", () => {
    const u = shapeUser(profileRow())!;
    for (const k of ["email", "secureMetadata", "isVerified", "isActive", "lastActive", "updatedAt"]) {
      expect(u).not.toHaveProperty(k);
    }
  });

  it("maps fields and serializes createdAt to ISO", () => {
    const u = shapeUser(profileRow())!;
    expect(u).toMatchObject({ id: "u1", username: "jett", reputation: 7, metadata: { theme: "dark" } });
    expect(u.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(u.location).toBeNull();
  });

  it("returns null for a null row", () => {
    expect(shapeUser(null)).toBeNull();
  });
});

describe("shapeEntity", () => {
  it("converts Dates to ISO strings and passes reactionCounts through", () => {
    const e = shapeEntity(entityRow());
    expect(e.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(e.scoreUpdatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(e.deletedAt).toBeNull();
    expect(e.reactionCounts.upvote).toBe(3);
  });

  it("defaults userReaction to null and omits isSaved/user unless provided", () => {
    const e = shapeEntity(entityRow());
    expect(e.userReaction).toBeNull();
    expect(e).not.toHaveProperty("isSaved");
    expect(e).not.toHaveProperty("user");
  });

  it("applies opts (userReaction, isSaved, user)", () => {
    const e = shapeEntity(entityRow(), { userReaction: "love", isSaved: true, user: shapeUser(profileRow()) });
    expect(e.userReaction).toBe("love");
    expect(e.isSaved).toBe(true);
    expect(e.user?.id).toBe("u1");
  });
});

describe("shapeComment", () => {
  it("preserves content when not deleted", () => {
    const c = shapeComment(commentRow());
    expect(c.content).toBe("a comment");
    expect(c.gif).toEqual({ url: "g" });
    expect(c.userDeletedAt).toBeNull();
  });

  it("blanks content/gif when user-deleted (Reddit-style), keeping the row", () => {
    const c = shapeComment(commentRow({ userDeletedAt: new Date("2026-02-01T00:00:00.000Z") }));
    expect(c.content).toBeNull();
    expect(c.gif).toBeNull();
    expect(c.userDeletedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(c.id).toBe("c1"); // row preserved
  });
});

describe("generateShortId", () => {
  it("produces a 10-char URL-safe id", () => {
    const id = generateShortId();
    expect(id).toHaveLength(10);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is effectively unique across calls", () => {
    const set = new Set(Array.from({ length: 1000 }, () => generateShortId()));
    expect(set.size).toBe(1000);
  });
});

describe("parseInclude", () => {
  const ctx = (include?: string) => ({ req: { query: (k: string) => (k === "include" ? include : undefined) } }) as any;

  it("returns an empty set when absent", () => {
    expect(parseInclude(ctx()).size).toBe(0);
  });

  it("splits, trims, and drops empties", () => {
    const set = parseInclude(ctx("user, space ,,topComment"));
    expect([...set].sort()).toEqual(["space", "topComment", "user"]);
  });
});

describe("parseBoolFlag", () => {
  it("is true only for the truthy spellings 'true'/'1' (case-insensitive)", () => {
    for (const v of ["true", "TRUE", "True", "1", " true ", "  1"]) {
      expect(parseBoolFlag(v)).toBe(true);
    }
  });

  it("fails closed for absent/false/garbage values", () => {
    for (const v of [undefined, "", "false", "FALSE", "0", "yes", "on", "null", "undefined", "2"]) {
      expect(parseBoolFlag(v as string | undefined)).toBe(false);
    }
  });
});

describe("REACTION_TYPES", () => {
  it("is exactly the 8 contract reaction types", () => {
    expect(REACTION_TYPES).toEqual(["upvote", "downvote", "like", "love", "wow", "sad", "angry", "funny"]);
  });
});

function spaceRow(over: Record<string, unknown> = {}) {
  return {
    id: "s1", projectId: "p1", shortId: "abc", slug: null, name: "S", description: null,
    avatarFileId: null, bannerFileId: null, userId: null,
    readingPermission: "anyone", postingPermission: "members", requireJoinApproval: false,
    visibility: "unlisted", parentSpaceId: null, depth: 0, metadata: {}, membersCount: 0,
    childSpacesCount: 0, readReceiptsEnabled: false,
    createdAt: new Date(0), updatedAt: new Date(0), deletedAt: null,
    ...over,
  } as any;
}

describe("shapeSpace visibility", () => {
  it("emits the stored visibility", () => {
    expect((shapeSpace(spaceRow()) as any).visibility).toBe("unlisted");
  });
  it("defaults legacy null to 'public'", () => {
    expect((shapeSpace(spaceRow({ visibility: null })) as any).visibility).toBe("public");
  });
});
