import { describe, it, expect } from "vitest";
import {
  shapeSpace,
  shapeRule,
  shapeAuthUser,
  shapeReport,
  shapeFile,
  shapeConversation,
  shapeConversationMember,
  shapeChatMessage,
} from "./shape.js";

// Hand-built Drizzle-style rows (camelCase + Date), typed `any` — fixtures, not full $inferSelect.
const D = new Date("2026-01-01T00:00:00.000Z");
const iso = D.toISOString();

describe("shapeSpace", () => {
  const row: any = {
    id: "s1", projectId: "p1", shortId: "sh1", slug: null, name: "Space", description: null,
    avatarFileId: null, bannerFileId: null, userId: "u1", readingPermission: "anyone",
    postingPermission: "members", requireJoinApproval: false, parentSpaceId: null, depth: 0,
    metadata: {}, membersCount: 3, childSpacesCount: 1, createdAt: D, updatedAt: D, deletedAt: null,
  };

  it("maps fields and serializes dates", () => {
    const s = shapeSpace(row);
    expect(s).toMatchObject({ id: "s1", name: "Space", membersCount: 3, childSpacesCount: 1, depth: 0 });
    expect(s.createdAt).toBe(iso);
    expect(s.deletedAt).toBeNull();
  });

  it("includes isMember only when provided", () => {
    expect(shapeSpace(row)).not.toHaveProperty("isMember");
    expect(shapeSpace(row, { isMember: true }).isMember).toBe(true);
  });
});

describe("shapeRule", () => {
  it("maps fields", () => {
    const r = shapeRule({ id: "r1", projectId: "p1", spaceId: "s1", title: "No spam", description: null, order: 2, lastApprovedBy: "u1", createdAt: D, updatedAt: D } as any);
    expect(r).toMatchObject({ id: "r1", spaceId: "s1", title: "No spam", order: 2, lastApprovedBy: "u1" });
    expect(r.createdAt).toBe(iso);
  });
});

describe("shapeAuthUser", () => {
  const row: any = {
    id: "u1", projectId: "p1", foreignId: null, role: "visitor", name: "Jett", username: "jett",
    avatar: null, avatarFileId: null, bannerFileId: null, bio: null, birthdate: null, metadata: {},
    reputation: 5, createdAt: D, email: "jett@example.com", isVerified: true, isActive: true,
    lastActive: D, updatedAt: D, authMethods: ["password"],
  };

  it("re-exposes the private fields shapeUser strips, plus suspensions/authMethods", () => {
    const u = shapeAuthUser(row, [{ reason: "rule", startDate: D, endDate: null }]);
    expect(u).toMatchObject({
      id: "u1", email: "jett@example.com", isVerified: true, isActive: true, authMethods: ["password"],
    });
    expect(u.lastActive).toBe(iso);
    expect(u.updatedAt).toBe(iso);
    expect(u.suspensions).toEqual([{ reason: "rule", startDate: iso, endDate: null }]);
  });

  it("defaults suspensions to an empty array", () => {
    expect(shapeAuthUser(row).suspensions).toEqual([]);
  });
});

describe("shapeReport", () => {
  it("maps fields; resolvedAt null when unresolved", () => {
    const r = shapeReport({ id: "rep1", projectId: "p1", reporterId: "u1", targetType: "entity", targetId: "e1", spaceId: null, reason: "spam", details: null, resolvedAt: null, resolvedById: null, createdAt: D } as any);
    expect(r).toMatchObject({ id: "rep1", targetType: "entity", targetId: "e1", reason: "spam" });
    expect(r.resolvedAt).toBeNull();
  });
});

describe("shapeFile", () => {
  it("maps fields; image undefined when absent", () => {
    const f = shapeFile({ id: "f1", projectId: "p1", userId: "u1", entityId: null, commentId: null, chatMessageId: null, spaceId: null, type: "image", originalPath: "x/y.webp", originalSize: 1234, originalMimeType: "image/webp", position: 0, metadata: {}, image: null, createdAt: D, updatedAt: D } as any);
    expect(f).toMatchObject({ id: "f1", type: "image", originalPath: "x/y.webp", originalSize: 1234 });
    expect(f.image).toBeUndefined();
  });
});

describe("shapeConversation", () => {
  const row: any = {
    id: "c1", projectId: "p1", type: "direct", name: null, description: null, spaceId: null,
    createdById: "u1", avatarFileId: null, lastMessageAt: null, postingPermission: null,
    metadata: {}, createdAt: D, updatedAt: D,
  };
  it("omits optional fields unless provided", () => {
    const c = shapeConversation(row);
    for (const k of ["memberCount", "currentMember", "unreadCount", "lastMessage"]) expect(c).not.toHaveProperty(k);
  });
  it("includes optional fields when provided", () => {
    const c = shapeConversation(row, { unreadCount: 2, memberCount: 5 });
    expect(c).toMatchObject({ unreadCount: 2, memberCount: 5 });
  });
});

describe("shapeConversationMember", () => {
  it("attaches user only when passed", () => {
    const base: any = { id: "m1", projectId: "p1", conversationId: "c1", userId: "u1", role: "member", lastReadAt: null, mutedUntil: null, isActive: true, leftAt: null, createdAt: D, updatedAt: D };
    expect(shapeConversationMember(base)).not.toHaveProperty("user");
    expect(shapeConversationMember(base, { id: "u1" } as any).user).toEqual({ id: "u1" });
  });
});

describe("shapeChatMessage", () => {
  const base: any = {
    id: "msg1", projectId: "p1", conversationId: "c1", userId: "u1", content: "hi", gif: { url: "g" },
    mentions: [], metadata: {}, parentMessageId: null, quotedMessageId: null, threadReplyCount: 0,
    reactionCounts: { "🔥": 2 }, editedAt: null, userDeletedAt: null, moderationStatus: null,
    moderatedAt: null, moderatedById: null, moderatedByType: null, createdAt: D, updatedAt: D,
  };

  it("maps reactionCounts + userReactions and content when live", () => {
    const m = shapeChatMessage(base, { userReactions: ["🔥"] });
    expect(m.content).toBe("hi");
    expect(m.reactionCounts).toEqual({ "🔥": 2 });
    expect(m.userReactions).toEqual(["🔥"]);
  });

  it("blanks content/gif when user-deleted", () => {
    const m = shapeChatMessage({ ...base, userDeletedAt: D });
    expect(m.content).toBeNull();
    expect(m.gif).toBeNull();
    expect(m.userDeletedAt).toBe(iso);
  });
});
