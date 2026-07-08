import { describe, it, expect } from "vitest";
import { collectUsers, resolveDirective, stampReputations, type UserLike } from "./space-reputation-enrich.js";

const UUID = "11111111-1111-1111-1111-111111111111";
const user = (id: string, reputation = 3): UserLike => ({
  id, projectId: "p", foreignId: null, role: "visitor", name: null, username: "u_" + id,
  avatar: null, avatarFileId: null, bannerFileId: null, bio: null, birthdate: null,
  location: null, metadata: {}, reputation, createdAt: "2026-01-01T00:00:00.000Z",
});

describe("collectUsers", () => {
  it("finds top-level, nested, and array-embedded users", () => {
    const payload = {
      data: [{ id: "e1", user: user("a"), topComment: { id: "c1", user: user("b") } }],
      pagination: {},
    };
    const ids = collectUsers(payload).map((u) => u.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });
  it("returns EVERY occurrence (same id embedded twice → two objects), for uniform stamping", () => {
    const shared = () => user("a");
    const found = collectUsers([{ user: shared() }, { user: shared() }]);
    expect(found).toHaveLength(2);
  });
  it("ignores Entity/Comment/Space and the reduced userSummary shape", () => {
    const entity = { id: "e", shortId: "s", reactionCounts: {}, createdAt: "x" }; // no role/username
    const summary = { id: "z", username: "z", name: "Z", reputation: 1 };          // no role/createdAt
    expect(collectUsers({ entity, summary })).toEqual([]);
  });
  it("does not infinite-loop on a cyclic object", () => {
    const o: any = { user: user("a") }; o.self = o;
    expect(collectUsers(o).map((u) => u.id)).toEqual(["a"]);
  });
});

describe("resolveDirective", () => {
  it("absent → null", () => {
    expect(resolveDirective({}, "context")).toBeNull();
  });
  it("'none' → global", () => {
    expect(resolveDirective({ spaceReputationId: "none" }, "context")).toEqual({ mode: "global" });
  });
  it("uuid → space (descendants from the flag)", () => {
    expect(resolveDirective({ spaceReputationId: UUID, spaceReputationDescendants: "true" }, "context"))
      .toEqual({ mode: "space", spaceId: UUID, includeDescendants: true });
    expect(resolveDirective({ spaceReputationId: UUID }, "context"))
      .toEqual({ mode: "space", spaceId: UUID, includeDescendants: false });
  });
  it("'context' on a context route → null (deferred, no throw)", () => {
    expect(resolveDirective({ spaceReputationId: "context" }, "context")).toBeNull();
  });
  it("'context' on a user-direct route → throws (400)", () => {
    expect(() => resolveDirective({ spaceReputationId: "context" }, "user-direct")).toThrow();
  });
  it("garbage id → throws", () => {
    expect(() => resolveDirective({ spaceReputationId: "garbage" }, "context")).toThrow();
  });
});

describe("stampReputations", () => {
  it("global mode copies each user's own reputation", () => {
    const users = [user("a", 7), user("b", 2)];
    stampReputations(users, { mode: "global" }, null);
    expect(users.map((u) => u.spaceReputation)).toEqual([7, 2]);
  });
  it("space mode reads the map, defaulting a missing id to 0", () => {
    const users = [user("a"), user("b")];
    stampReputations(users, { mode: "space", spaceId: UUID, includeDescendants: false }, new Map([["a", 9]]));
    expect(users.map((u) => u.spaceReputation)).toEqual([9, 0]);
  });
});
