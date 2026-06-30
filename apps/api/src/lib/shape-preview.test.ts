import { describe, it, expect } from "vitest";
import { truncateMessageContent, pickOtherMembers, shapeConversationPreview } from "./shape.js";

const convoRow = {
  id: "c1", projectId: "p1", type: "group", name: null, description: null, spaceId: null,
  createdById: "u1", avatarFileId: null, lastMessageAt: null, postingPermission: null,
  metadata: {}, createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
} as any;

describe("truncateMessageContent", () => {
  it("truncates content longer than max to exactly max characters", () => {
    const out = truncateMessageContent({ content: "x".repeat(150) }, 100);
    expect((out.content as string).length).toBe(100);
  });
  it("leaves short content untouched (same reference)", () => {
    const msg = { content: "hi" };
    expect(truncateMessageContent(msg, 100)).toBe(msg);
  });
  it("is codepoint-safe (does not split a surrogate pair at the boundary)", () => {
    const out = truncateMessageContent({ content: "😀".repeat(150) }, 100);
    expect([...(out.content as string)].length).toBe(100); // 100 whole emoji, not 50 split ones
  });
  it("ignores non-string / null content", () => {
    const msg = { content: null };
    expect(truncateMessageContent(msg as any, 100)).toBe(msg);
  });
});

describe("pickOtherMembers", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, name: `N${i}`, username: `n${i}`, avatar: null }));
  it("caps at max (default 5) and projects the inbox fields", () => {
    const out = pickOtherMembers(mk(7));
    expect(out.length).toBe(5);
    expect(out[0]).toEqual({ id: "u0", name: "N0", username: "n0", avatar: null });
  });
  it("returns all when fewer than max", () => {
    expect(pickOtherMembers(mk(2)).length).toBe(2);
  });
});

describe("shapeConversationPreview", () => {
  it("includes unreadCount, otherMembers, and a truncated lastMessage", () => {
    const preview = shapeConversationPreview(convoRow, {
      unreadCount: 3,
      lastMessage: { content: "y".repeat(150) },
      otherMembers: [{ id: "u2", name: "Bo", username: "bo", avatar: null }],
    }) as any;
    expect(preview.id).toBe("c1");
    expect(preview.unreadCount).toBe(3);
    expect(preview.otherMembers).toEqual([{ id: "u2", name: "Bo", username: "bo", avatar: null }]);
    expect((preview.lastMessage.content as string).length).toBe(100);
  });
  it("allows a null lastMessage (brand-new conversation)", () => {
    const preview = shapeConversationPreview(convoRow, { unreadCount: 0, lastMessage: null, otherMembers: [] }) as any;
    expect(preview.lastMessage).toBeNull();
    expect(preview.unreadCount).toBe(0);
  });
});
