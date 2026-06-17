// OPT-IN live-graph test for the CO_PARTICIPATES branch of NEIGHBORHOOD_CYPHER — the per-request opt-in
// gate, the floor-brightness neutrality (0 warmth / 0 friction), the age cutoff, and the tie-kind merge:
// the parts the stubbed-driver unit tests can't reach. Run with:
//   TEST_NEO4J_URI=bolt://localhost:7687 TEST_NEO4J_AUTH=neo4j/… pnpm test:integration
// Own driver (the app's NEO4J_URI is forced empty for hermeticity); profiles are stubbed (the Cypher
// returns ids — the Postgres join is covered by the unit suite). All nodes namespaced + DETACH DELETEd.
//
// The end-to-end script (scripts/smoke/co-participates.sh) is what proves the Python writer's MERGE and
// this reader agree byte-for-byte; this test hand-seeds the same edge shape as a fast in-suite drift guard.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { type Driver } from "neo4j-driver";
import { testNeo4jDriver } from "./neo4j-test-driver.js";
import { getSocialNeighborhood } from "../../src/lib/social-neighborhood.js";

const uri = process.env.TEST_NEO4J_URI;
const DAY_MS = 86_400_000;
const cfg = { warmthHalfLifeDays: 30, frictionHalfLifeDays: 14 };
const ANCIENT_DAYS = 200; // > 6 warmth half-lives (180d) → past the age cutoff

describe.runIf(!!uri)("co-participates neighborhood (live graph)", () => {
  let driver: Driver;
  const me = randomUUID();
  // B: recent co-participant only → opt-in shows them at the floor; default-off hides them.
  // C: ONLY an ancient co-participation → falls out under the age cutoff even when opted in.
  // D: a follow that is ALSO a co-participant → present either way; both kinds when opted in.
  const B = randomUUID(), C = randomUUID(), D = randomUUID();
  const NOW = Date.now();
  const projectId = randomUUID();
  const all = [me, B, C, D];
  // Stub profile resolver: every candidate "exists" so presence/absence reflects the Cypher, not the join.
  const stubProfiles = async (ids: string[]) =>
    new Map(ids.map((id) => [id, { id, username: id.slice(0, 8), name: null, avatar: null }]));

  async function follow(a: string, b: string) {
    await driver.executeQuery(
      `MERGE (a:User {id:$a}) MERGE (b:User {id:$b}) MERGE (a)-[:FOLLOWS {at:$at}]->(b)`,
      { a, b, at: NOW },
    );
  }
  // Mirrors worker/neo4j_writer.py::_CO_PARTICIPATES_MERGE (the source of truth): canonical (min,max)
  // direction, keyed on {sourceA, sourceB, projectId}, recency in lastAt. The reader matches it undirected.
  async function coParticipates(a: string, b: string, ageDays: number) {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    await driver.executeQuery(
      `MERGE (lo:User {id:$lo}) MERGE (hi:User {id:$hi})
       MERGE (lo)-[r:CO_PARTICIPATES {sourceA:$lo, sourceB:$hi, projectId:$pid}]->(hi)
         ON CREATE SET r.createdAt=$at, r.weight=1.0
       SET r.lastAt=$at`,
      { lo, hi, pid: projectId, at: NOW - ageDays * DAY_MS },
    );
  }

  beforeAll(async () => {
    driver = testNeo4jDriver();
    await coParticipates(me, B, 0);            // recent co-participation
    await coParticipates(me, C, ANCIENT_DAYS); // ancient → age-cut
    await follow(me, D);                        // structural follow (always a tie)
    await coParticipates(me, D, 0);            // …who is also a recent co-participant
  });

  afterAll(async () => {
    if (!driver) return;
    await driver.executeQuery(`MATCH (n:User) WHERE n.id IN $ids DETACH DELETE n`, { ids: all });
    await driver.close();
  });

  it("DEFAULT (off): co-participants are excluded — only the follow shows", async () => {
    const out = await getSocialNeighborhood(projectId, me, cfg, {
      driver, nowMs: NOW, fetchProfiles: stubProfiles, // includeCoParticipates defaults to false
    });
    expect(out.includesCoParticipates).toBe(false);
    expect(out.ties.map((t) => t.userId).sort()).toEqual([D].sort()); // B + C absent; D is a follow
  });

  it("includeCoParticipates=true: recent co-participant appears at the floor; ancient is age-cut", async () => {
    const out = await getSocialNeighborhood(projectId, me, cfg, {
      driver, nowMs: NOW, includeCoParticipates: true, fetchProfiles: stubProfiles,
    });
    expect(out.includesCoParticipates).toBe(true);
    expect(out.ties.map((t) => t.userId).sort()).toEqual([B, D].sort()); // C (ancient) excluded
    const b = out.ties.find((t) => t.userId === B)!;
    expect(b.tieKinds).toEqual(["coParticipation"]);
    expect(b.brightness).toBeCloseTo(0.15, 2); // 0 warmth / 0 friction → structurally neutral floor
  });

  it("includeCoParticipates=true: a follow that is also a co-participant carries both kinds in canonical order", async () => {
    const out = await getSocialNeighborhood(projectId, me, cfg, {
      driver, nowMs: NOW, includeCoParticipates: true, fetchProfiles: stubProfiles,
    });
    const d = out.ties.find((t) => t.userId === D)!;
    expect(d.tieKinds).toEqual(["follow", "coParticipation"]);
  });
});
