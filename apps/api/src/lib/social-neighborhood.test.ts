import { describe, expect, it } from "vitest";
import {
  neighborhoodFromRows, getSocialNeighborhood, NEIGHBORHOOD_CYPHER, type NeighborhoodRow,
} from "./social-neighborhood.js";
import { pairBrightness, AGE_CUTOFF_HALF_LIVES } from "./social-weather.js";
import { SOCIAL_TIER_DEFAULTS } from "@agora-server/contract";

const cfg = SOCIAL_TIER_DEFAULTS.community;
const round2 = (x: number) => Math.round(x * 100) / 100;

describe("neighborhoodFromRows", () => {
  const row = (userId: string, w: number, f = 0): NeighborhoodRow => ({ userId, tieKinds: ["interaction"], w, f });

  it("scores each tie's dyadic brightness, rounded to 2dp", () => {
    const [t] = neighborhoodFromRows([row("x", 5, 3)]);
    expect(t!.brightness).toBe(round2(pairBrightness(5, 3)));
  });

  it("a structural-only tie (no warmth, no friction) sits at the floor", () => {
    const [t] = neighborhoodFromRows([{ userId: "y", tieKinds: ["follow"], w: 0, f: 0 }]);
    expect(t!.brightness).toBe(0.15);
  });

  it("friction dims a warm tie but the result stays above the floor", () => {
    const [warm] = neighborhoodFromRows([row("x", 5, 0)]);
    const [dimmed] = neighborhoodFromRows([row("x", 5, 3)]);
    expect(dimmed!.brightness).toBeLessThan(warm!.brightness);
    expect(dimmed!.brightness).toBeGreaterThan(0.15);
  });

  it("sorts brightest-first", () => {
    const out = neighborhoodFromRows([row("dim", 1), row("bright", 100), row("mid", 5)]);
    expect(out.map((t) => t.userId)).toEqual(["bright", "mid", "dim"]);
  });
});

// Stub neo4j Driver: returns canned rows ({userId, tieKinds, w, f}) and records each call's params.
function stubDriver(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const driver = {
    executeQuery: async (cypher: string, params: Record<string, unknown>) => {
      calls.push({ cypher, params });
      return { records: rows.map((r) => ({ get: (k: string) => r[k] })) };
    },
  };
  return { driver: driver as never, calls };
}

type P = { id: string; username: string | null; name: string | null; avatar: string | null };
const stubProfiles = (entries: Array<[string, Partial<P>]>) => {
  const m = new Map<string, P>();
  for (const [id, p] of entries) m.set(id, { id, username: p.username ?? null, name: p.name ?? null, avatar: p.avatar ?? null });
  return async () => m;
};

describe("getSocialNeighborhood", () => {
  const NOW = 1_750_000_000_000;

  it("passes me, projectId, asOf, age cutoff, and half-lives to the query", async () => {
    const { driver, calls } = stubDriver([]);
    await getSocialNeighborhood("proj-1", "me-1", cfg, { driver, nowMs: NOW, fetchProfiles: stubProfiles([]) });
    expect(calls[0]!.cypher).toBe(NEIGHBORHOOD_CYPHER);
    expect(calls[0]!.params).toMatchObject({
      me: "me-1", projectId: "proj-1", asOf: NOW,
      ageCutoff: NOW - AGE_CUTOFF_HALF_LIVES * cfg.warmthHalfLifeDays * 86_400_000,
      warmthHalfLifeDays: 30, frictionHalfLifeDays: 14,
    });
  });

  it("defaults includeInteractions to false (structural-only) and echoes it", async () => {
    const { driver, calls } = stubDriver([]);
    const out = await getSocialNeighborhood("p", "me", cfg, { driver, nowMs: NOW, fetchProfiles: stubProfiles([]) });
    expect(calls[0]!.params.includeInteractions).toBe(false);
    expect(out.includesInteractions).toBe(false);
  });

  it("passes includeInteractions through and echoes it when set", async () => {
    const { driver, calls } = stubDriver([]);
    const out = await getSocialNeighborhood("p", "me", cfg, {
      driver, nowMs: NOW, includeInteractions: true, fetchProfiles: stubProfiles([]),
    });
    expect(calls[0]!.params.includeInteractions).toBe(true);
    expect(out.includesInteractions).toBe(true);
  });

  it("joins profiles and returns dyadic brightness with friction folded in additively", async () => {
    const { driver } = stubDriver([{ userId: "x", tieKinds: ["INTERACTED"], w: 5, f: 3 }]);
    const out = await getSocialNeighborhood("p", "me", cfg, {
      driver, nowMs: NOW,
      fetchProfiles: stubProfiles([["x", { username: "ex", name: "Ex", avatar: "a.png" }]]),
    });
    expect(out.ties).toHaveLength(1);
    expect(out.ties[0]).toMatchObject({
      userId: "x", username: "ex", name: "Ex", avatar: "a.png",
      brightness: round2(pairBrightness(5, 3)), tieKinds: ["interaction"],
    });
    expect(out.asOf).toBe(new Date(NOW).toISOString());
  });

  it("maps + canonically sorts the Neo4j tie-kind labels (FOLLOWS/CONNECTED/INTERACTED)", async () => {
    const { driver } = stubDriver([{ userId: "x", tieKinds: ["INTERACTED", "FOLLOWS"], w: 1, f: 0 }]);
    const out = await getSocialNeighborhood("p", "me", cfg, {
      driver, nowMs: NOW, fetchProfiles: stubProfiles([["x", { username: "ex" }]]),
    });
    expect(out.ties[0]!.tieKinds).toEqual(["follow", "interaction"]);
  });

  it("drops a tie whose profile is missing (deleted user), keeps the rest, brightest-first", async () => {
    const { driver } = stubDriver([
      { userId: "gone", tieKinds: ["FOLLOWS"], w: 100, f: 0 }, // brightest, but no profile → dropped
      { userId: "x", tieKinds: ["CONNECTED"], w: 5, f: 0 },
      { userId: "y", tieKinds: ["INTERACTED"], w: 1, f: 0 },
    ]);
    const out = await getSocialNeighborhood("p", "me", cfg, {
      driver, nowMs: NOW,
      fetchProfiles: stubProfiles([["x", { username: "ex" }], ["y", { username: "why" }]]),
    });
    expect(out.ties.map((t) => t.userId)).toEqual(["x", "y"]); // gone dropped; x (W=5) before y (W=1)
    expect(out.ties[0]!.tieKinds).toEqual(["connection"]);
  });

  it("throws when no driver is configured (route maps to 503)", async () => {
    await expect(getSocialNeighborhood("p", "me", cfg, { nowMs: NOW })).rejects.toThrow(/neo4j/i);
  });
});
