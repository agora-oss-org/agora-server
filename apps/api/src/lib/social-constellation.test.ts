import { describe, expect, it } from "vitest";
import { sizeBucket, blobsFromCommunities } from "./social-constellation.js";
import { BLOB_SIZE_BUCKETS } from "@agora-server/contract";

const [B5, B10, B20, B50, B100] = BLOB_SIZE_BUCKETS;
const community = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("sizeBucket", () => {
  it("buckets coarsely at 10 / 20 / 50 / 100", () => {
    expect(sizeBucket(5)).toBe(B5);
    expect(sizeBucket(9)).toBe(B5);
    expect(sizeBucket(10)).toBe(B10);
    expect(sizeBucket(19)).toBe(B10);
    expect(sizeBucket(20)).toBe(B20);
    expect(sizeBucket(49)).toBe(B20);
    expect(sizeBucket(50)).toBe(B50);
    expect(sizeBucket(99)).toBe(B50);
    expect(sizeBucket(100)).toBe(B100);
    expect(sizeBucket(5000)).toBe(B100);
  });
});

describe("blobsFromCommunities", () => {
  it("suppresses clusters below the k-floor (k-anonymity), counting all members pre-suppression", () => {
    const communities = new Map([
      ["c1", community(6, "a")], // ≥5 → rendered
      ["c2", community(3, "b")], // <5 → suppressed
    ]);
    const { blobs, memberCount } = blobsFromCommunities(communities, new Map(), 5);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.size).toBe(B5);
    expect(memberCount).toBe(9);
  });

  it("tints by mean member S_p; members absent from the map fall to the floor", () => {
    const warm = community(5, "a");
    const warmScores = new Map(warm.map((m) => [m, 0.9]));
    expect(blobsFromCommunities(new Map([["c", warm]]), warmScores, 5).blobs[0]!.warmth).toBe("sunny");
    // no scores → every member floors → stormy
    expect(blobsFromCommunities(new Map([["c", community(5, "b")]]), new Map(), 5).blobs[0]!.warmth).toBe("stormy");
  });

  it("buckets the rendered size", () => {
    const { blobs } = blobsFromCommunities(new Map([["c", community(25, "a")]]), new Map(), 5);
    expect(blobs[0]!.size).toBe(B20);
  });

  it("orders largest-then-warmest first (deterministic; the client randomizes layout per load)", () => {
    const communities = new Map([
      ["small", community(6, "s")], // 5–9
      ["big", community(50, "b")],  // 50–99
    ]);
    const { blobs } = blobsFromCommunities(communities, new Map(), 5);
    expect(blobs.map((b) => b.size)).toEqual([B50, B5]);
  });

  it("honors a raised k-floor (the admin can only raise it, never lower below 5)", () => {
    const communities = new Map([["c", community(8, "a")]]);
    expect(blobsFromCommunities(communities, new Map(), 5).blobs).toHaveLength(1);
    expect(blobsFromCommunities(communities, new Map(), 10).blobs).toHaveLength(0); // 8 < 10 → suppressed
  });
});
