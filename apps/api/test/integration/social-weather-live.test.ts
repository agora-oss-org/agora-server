// OPT-IN live-graph test for WEATHER_PAIRS_CYPHER — the one thing unit tests can't cover.
// Run with: TEST_NEO4J_URI=bolt://localhost:7687 TEST_NEO4J_AUTH=neo4j/… pnpm test:integration
// Uses its own driver (the app's NEO4J_URI is forced empty for hermeticity) and namespaces all
// nodes under a random projectId, DETACH DELETEing them afterwards.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { type Driver } from "neo4j-driver";
import { testNeo4jDriver } from "./neo4j-test-driver.js";
import { computeWeather, pairBrightness } from "../../src/lib/social-weather.js";

const uri = process.env.TEST_NEO4J_URI;
const DAY_MS = 86_400_000;
const cfg = { warmthHalfLifeDays: 30, frictionHalfLifeDays: 14 };

describe.runIf(!!uri)("weather cypher (live graph)", () => {
  let driver: Driver;
  const projectId = randomUUID();
  // u[3] is a fourth user whose ONLY edge is sentiment=0 — verifies the zero-exclusion filter:
  // under correct Cypher (AND r.sentiment <> 0) this pair produces NO row; under a buggy filter
  // it would produce a w=0,f=0 row → B=0.15 third inbound pair → S_p(u1) changes from a
  // mean-of-two to a mean-of-three, causing the assertion to fail.
  const u = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const NOW = Date.now();

  async function seedEdge(actor: string, recipient: string, sentiment: number, ageDays: number) {
    await driver.executeQuery(
      `MERGE (a:User {id: $actor}) MERGE (b:User {id: $recipient})
       CREATE (a)-[:INTERACTED {sourceId: $sourceId, kind: "comment", sentiment: $sentiment,
                                projectId: $projectId, at: $at, createdAt: $at}]->(b)`,
      { actor, recipient, sentiment, projectId, sourceId: randomUUID(), at: NOW - ageDays * DAY_MS },
    );
  }

  beforeAll(async () => {
    driver = testNeo4jDriver();
    await seedEdge(u[0]!, u[1]!, 1.0, 0);   // fresh full-warmth comment
    await seedEdge(u[0]!, u[1]!, 1.0, 30);  // one warmth half-life old → contributes 0.5
    await seedEdge(u[2]!, u[1]!, -1.0, 0);  // fresh friction
    await seedEdge(u[2]!, u[1]!, 0, 0);     // neutral (e.g. "sad" empathy) — MUST be excluded
    await seedEdge(u[3]!, u[1]!, 0, 0);     // zero-only pair: excluded by correct Cypher → no row
  });

  afterAll(async () => {
    if (!driver) return;
    await driver.executeQuery(`MATCH (n:User) WHERE n.id IN $ids DETACH DELETE n`, { ids: u });
    await driver.close();
  });

  it("matches the hand-computed read-time-decayed aggregate (zero-sentiment edges excluded)", async () => {
    // Pair u0→u1: W = 1.0 + 1.0·exp(−ln2·30/30) = 1.5, F = 0 → B(1.5, 0)
    // Pair u2→u1: W = 0, F = 1.0 → B(0, 1) = floor (0.15); its sentiment-0 edge contributes nothing.
    // u3→u1: zero-only pair → NO row under correct Cypher; under buggy Cypher would add B(0,0)=0.15.
    // S_p(u1) = mean of the two inbound pairs; only recipient → weather = S_p(u1).
    const expected = (pairBrightness(1.5, 0) + pairBrightness(0, 1)) / 2;
    const v = await computeWeather(driver, projectId, cfg, NOW);
    expect(v).not.toBeNull();
    expect(v!).toBeCloseTo(expected, 3);
  });

  it("scopes strictly by projectId", async () => {
    expect(await computeWeather(driver, randomUUID(), cfg, NOW)).toBeNull();
  });

  it("the prior window excludes newer edges", async () => {
    // As of 7d ago: the three age-0 edges don't exist yet; only the (then 23d-old) warm edge does.
    const expected = pairBrightness(Math.exp((-Math.LN2 * 23) / 30), 0);
    const v = await computeWeather(driver, projectId, cfg, NOW - 7 * DAY_MS);
    expect(v!).toBeCloseTo(expected, 3);
  });
});

// PR 3 — the FRICTION UNION branch + the age cutoff, both real-Cypher-only behaviors. Own projectId so
// it can't perturb the block above (project-wide weather aggregates over every pair).
describe.runIf(!!uri)("weather cypher — FRICTION fold + age cutoff (live graph)", () => {
  let driver: Driver;
  const projectId = randomUUID();
  const u = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const NOW = Date.now();
  // 6 warmth half-lives = 180d is the cutoff; 200d is safely past it, 10d safely inside.
  const ANCIENT_DAYS = 200;

  async function seedInteracted(pid: string, actor: string, recipient: string, sentiment: number, ageDays: number) {
    await driver.executeQuery(
      `MERGE (a:User {id: $actor}) MERGE (b:User {id: $recipient})
       CREATE (a)-[:INTERACTED {sourceId: $sourceId, kind: "comment", sentiment: $sentiment,
                                projectId: $pid, at: $at, createdAt: $at}]->(b)`,
      { actor, recipient, sentiment, pid, sourceId: randomUUID(), at: NOW - ageDays * DAY_MS },
    );
  }
  async function seedFriction(pid: string, actor: string, recipient: string, weight: number, ageDays: number) {
    await driver.executeQuery(
      `MERGE (a:User {id: $actor}) MERGE (b:User {id: $recipient})
       CREATE (a)-[:FRICTION {sourceId: $sourceId, kind: "report", weight: $weight,
                              projectId: $pid, at: $at, createdAt: $at}]->(b)`,
      { actor, recipient, weight, pid, sourceId: randomUUID(), at: NOW - ageDays * DAY_MS },
    );
  }

  beforeAll(async () => {
    driver = testNeo4jDriver();
    // Pair u0→u1: warm INTERACTED (W=1) AND a fresh report (FRICTION weight 1) — the additive fold.
    await seedInteracted(projectId, u[0]!, u[1]!, 1.0, 0);
    await seedFriction(projectId, u[0]!, u[1]!, 1.0, 0);
    // Pair u2→u3 (same project): a single warm edge, but ANCIENT — must fall out under the age cutoff
    // (if it didn't, the additive assertion below would see a second recipient and fail).
    await seedInteracted(projectId, u[2]!, u[3]!, 1.0, ANCIENT_DAYS);
  });

  afterAll(async () => {
    if (!driver) return;
    await driver.executeQuery(`MATCH (n:User) WHERE n.id IN $ids DETACH DELETE n`, { ids: u });
    await driver.close();
  });

  it("folds a FRICTION edge into F additively on the same directed pair (UNION ALL + merge)", async () => {
    // Both branches emit a u0→u1 row; mergePairRows sums them → one tie B(W=1, F=1), strictly dimmer
    // than warmth-only B(1,0) but above the floor. u2→u3 is excluded (ancient) so u1 is the only
    // recipient → weather = B(1, 1).
    const v = await computeWeather(driver, projectId, cfg, NOW);
    expect(v!).toBeCloseTo(pairBrightness(1, 1), 3);
    expect(v!).toBeLessThan(pairBrightness(1, 0)); // the report dimmed the tie
    expect(v!).toBeGreaterThan(0.15);              // ...but not to the floor
  });

  it("drops edges older than the age cutoff (dormant ⇒ quiet, not stormy)", async () => {
    // A throwaway project whose ONLY edge is 200d old: past 6 warmth half-lives → no rows → null.
    const dormant = randomUUID();
    const a = randomUUID(), b = randomUUID();
    u.push(a, b); // tracked for afterAll cleanup
    await seedInteracted(dormant, a, b, 1.0, ANCIENT_DAYS);
    expect(await computeWeather(driver, dormant, cfg, NOW)).toBeNull();
  });
});
