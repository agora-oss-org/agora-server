import { describe, expect, it } from "vitest";
import { parseMentionTokens } from "./mentions.js";

describe("parseMentionTokens", () => {
  it("keeps well-formed user and space tokens", () => {
    const out = parseMentionTokens([
      { type: "user", id: "u1", username: "alice", foreignId: "f1" },
      { type: "space", id: "s1", slug: "dev" },
    ]);
    expect(out).toEqual([
      { type: "user", id: "u1", username: "alice", foreignId: "f1" },
      { type: "space", id: "s1", slug: "dev" },
    ]);
  });

  it("drops structurally invalid entries (missing id/username/slug, wrong type)", () => {
    expect(parseMentionTokens([
      { type: "user", id: "u1" },              // no username
      { type: "space", id: "s1" },             // no slug
      { type: "bogus", id: "x", username: "y" },
      { id: "u2", username: "bob" },           // no type, but decorated like a malformed structured token
      42, null, "",
    ])).toEqual([]);
  });

  it("coerces a legacy bare-string id and { id } object to a user token with empty username", () => {
    // Legacy tolerance: bare ids resolve later in sanitizeMentions (username refilled from DB).
    expect(parseMentionTokens(["u9", { id: "u8" }])).toEqual([
      { type: "user", id: "u9", username: "" },
      { type: "user", id: "u8", username: "" },
    ]);
  });

  it("coerces a truly-bare { userId } object (legacy userId key) to a user token", () => {
    // The id falls back to `userId` when `id` is absent; with no type/username/slug it's a bare
    // legacy token, so the username is refilled later by sanitizeMentions.
    expect(parseMentionTokens([{ userId: "u7" }])).toEqual([
      { type: "user", id: "u7", username: "" },
    ]);
  });

  it("drops an untyped object decorated with a slug (malformed structured token)", () => {
    // A slug without an explicit type="space" is a decorated-but-untyped shape, dropped rather than
    // coerced — symmetric to the untyped-with-username drop above.
    expect(parseMentionTokens([{ id: "s2", slug: "eng" }])).toEqual([]);
  });

  it("dedupes by (type,id) keeping the first", () => {
    expect(parseMentionTokens([
      { type: "user", id: "u1", username: "alice" },
      { type: "user", id: "u1", username: "ALICE" },
    ])).toEqual([{ type: "user", id: "u1", username: "alice" }]);
  });

  it("returns [] for non-array input", () => {
    expect(parseMentionTokens(null)).toEqual([]);
    expect(parseMentionTokens({})).toEqual([]);
    expect(parseMentionTokens(undefined)).toEqual([]);
  });
});
