// OPT-IN live-graph test for NEIGHBORHOOD_CYPHER — the tie-set union + dyadic brightness + age cutoff,
// the parts unit tests (stub driver) can't reach. Run with:
//   TEST_NEO4J_URI=bolt://localhost:7687 TEST_NEO4J_PASSWORD=… pnpm test:integration
// Own driver (the app's NEO4J_URI is forced empty for hermeticity); profiles are stubbed (the Cypher
// returns ids — Postgres join is covered by the unit suite). All nodes namespaced + DETACH DELETEd.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import neo4j, { type Driver } from "neo4j-driver";
import { getSocialNeighborhood } from "../../src/lib/social-neighborhood.js";
import { pairBrightness } from "../../src/lib/social-weather.js";

const uri = process.env.TEST_NEO4J_URI;
const DAY_MS = 86_400_000;
const cfg = { warmthHalfLifeDays: 30, frictionHalfLifeDays: 14 };
const ANCIENT_DAYS = 200; // > 6 warmth half-lives (180d) → past the age cutoff

describe.runIf(!!uri)("neighborhood cypher (live graph)", () => {
  let driver: Driver;
  const me = randomUUID();
  // X: followed + I reported them (structural tie, friction-dimmed).
  // Y: mutual connection, no interaction (structural-only → floor).
  // Z: interaction-only, warm (no follow/connection).
  // Q: ONLY an ancient interaction (must fall out under the age cutoff → absent).
  // R: ONLY friction toward me, no other edge (friction isn't structure → absent).
  const X = randomUUID(), Y = randomUUID(), Z = randomUUID(), Q = randomUUID(), R = randomUUID();
  const NOW = Date.now();
  const projectId = randomUUID();
  const all = [me, X, Y, Z, Q, R];
  // Stub profile resolver: every candidate "exists" so presence/absence reflects the Cypher, not the join.
  const stubProfiles = async (ids: string[]) =>
    new Map(ids.map((id) => [id, { id, username: id.slice(0, 8), name: null, avatar: null }]));

  async function follow(a: string, b: string) {
    await driver.executeQuery(
      `MERGE (a:User {id:$a}) MERGE (b:User {id:$b}) MERGE (a)-[:FOLLOWS {at:$at}]->(b)`,
      { a, b, at: NOW },
    );
  }
  async function connect(a: string, b: string) {
    await driver.executeQuery(
      `MERGE (a:User {id:$a}) MERGE (b:User {id:$b}) MERGE (a)-[:CONNECTED {at:$at}]->(b)`,
      { a, b, at: NOW },
    );
  }
  async function interacted(a: string, b: string, sentiment: number, ageDays: number) {
    await driver.executeQuery(
      `MERGE (a:User {id:$a}) MERGE (b:User {id:$b})
       CREATE (a)-[:INTERACTED {sourceId:$sid, kind:"comment", sentiment:$sentiment,
                                projectId:$pid, at:$at, createdAt:$at}]->(b)`,
      { a, b, sentiment, pid: projectId, sid: randomUUID(), at: NOW - ageDays * DAY_MS },
    );
  }
  async function friction(a: string, b: string, weight: number, ageDays: number) {
    await driver.executeQuery(
      `MERGE (a:User {id:$a}) MERGE (b:User {id:$b})
       CREATE (a)-[:FRICTION {sourceId:$sid, kind:"report", weight:$weight,
                              projectId:$pid, at:$at, createdAt:$at}]->(b)`,
      { a, b, weight, pid: projectId, sid: randomUUID(), at: NOW - ageDays * DAY_MS },
    );
  }

  beforeAll(async () => {
    driver = neo4j.driver(
      uri!,
      neo4j.auth.basic(process.env.TEST_NEO4J_USER ?? "neo4j", process.env.TEST_NEO4J_PASSWORD ?? ""),
    );
    await follow(me, X);
    await friction(me, X, 1.0, 0);       // I reported X → dims my tie to X
    await connect(me, Y);                 // mutual, no interaction → floor
    await interacted(me, Z, 1.0, 0);      // warm interaction-only tie
    await interacted(me, Q, 1.0, ANCIENT_DAYS); // only ancient interaction → excluded
    await friction(R, me, 1.0, 0);        // R reported me, no other edge → not a tie
  });

  afterAll(async () => {
    if (!driver) return;
    await driver.executeQuery(`MATCH (n:User) WHERE n.id IN $ids DETACH DELETE n`, { ids: all });
    await driver.close();
  });

  it("DEFAULT (structural-only): only follows + connections — interaction-only Z is excluded", async () => {
    const out = await getSocialNeighborhood(projectId, me, cfg, {
      driver, nowMs: NOW, fetchProfiles: stubProfiles, // includeInteractions defaults to false
    });
    expect(out.includesInteractions).toBe(false);
    expect(out.ties.map((t) => t.userId).sort()).toEqual([X, Y].sort()); // Z, Q, R all absent
  });

  it("includeInteractions=true: adds the recent-interaction tie Z (ancient + friction-only still excluded)", async () => {
    const out = await getSocialNeighborhood(projectId, me, cfg, {
      driver, nowMs: NOW, includeInteractions: true, fetchProfiles: stubProfiles,
    });
    expect(out.includesInteractions).toBe(true);
    expect(out.ties.map((t) => t.userId).sort()).toEqual([X, Y, Z].sort()); // Q (ancient) + R (friction-only) absent
    const byId = new Map(out.ties.map((t) => [t.userId, t.tieKinds]));
    expect(byId.get(X)).toEqual(["follow"]);
    expect(byId.get(Y)).toEqual(["connection"]);
    expect(byId.get(Z)).toEqual(["interaction"]);
  });

  it("computes dyadic brightness either way: friction-dimmed X and quiet connection Y sit at the floor", async () => {
    const out = await getSocialNeighborhood(projectId, me, cfg, {
      driver, nowMs: NOW, includeInteractions: true, fetchProfiles: stubProfiles,
    });
    const b = (id: string) => out.ties.find((t) => t.userId === id)!.brightness;
    // X: W=0 (no interaction), F=1 (one report) → floor (friction can't dip below it).
    expect(b(X)).toBeCloseTo(0.15, 2);
    // Y: structural-only, W=0,F=0 → floor.
    expect(b(Y)).toBeCloseTo(0.15, 2);
    // Z: fresh warm interaction W=1, F=0.
    expect(b(Z)).toBeCloseTo(Math.round(pairBrightness(1, 0) * 100) / 100, 2);
    // Z (warm) is the brightest tie; it sorts first.
    expect(out.ties[0]!.userId).toBe(Z);
  });
});
