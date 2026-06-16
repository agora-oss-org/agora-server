// OPT-IN live-graph test for the admin-analytics GDS scoring — PageRank + betweenness over one shared
// projection (influenceScores). This is the new GDS path the unit suite (pure topByScore/dominantSpaces/
// churnFromSeries) can't reach; the silos report reuses louvainCommunities, already covered by
// social-constellation-live.test.ts. Requires OpenGDS installed in the Neo4j/DozerDB target.
// Run with: TEST_NEO4J_URI=bolt://localhost:7687 TEST_NEO4J_AUTH=neo4j/… pnpm test:integration
// Uses its own driver (the app's NEO4J_URI is forced empty for hermeticity) and namespaces all nodes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { type Driver } from "neo4j-driver";
import { testNeo4jDriver } from "./neo4j-test-driver.js";
import { influenceScores } from "../../src/lib/social-analytics.js";

const uri = process.env.TEST_NEO4J_URI;

describe.runIf(!!uri)("admin analytics GDS scoring (live graph)", () => {
  let driver: Driver;
  const projectId = randomUUID();
  // Two 5-cliques joined ONLY through a single bridge node, which fans into two members of each clique.
  // The bridge is then the sole cut vertex between the cliques → it must top betweenness (every A↔B
  // shortest path runs through it), while the densely mutually-linked clique members top PageRank.
  const A = Array.from({ length: 5 }, () => randomUUID());
  const B = Array.from({ length: 5 }, () => randomUUID());
  const bridge = randomUUID();
  const all = [...A, ...B, bridge];

  async function edge(a: string, b: string) {
    await driver.executeQuery(
      `MERGE (a:User {id: $a}) MERGE (b:User {id: $b})
       CREATE (a)-[:INTERACTED {sourceId: $sid, projectId: $pid, at: timestamp(), sentiment: 1.0}]->(b)`,
      { a, b, sid: randomUUID(), pid: projectId },
    );
  }
  async function clique(ids: string[]) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) await edge(ids[i]!, ids[j]!);
  }

  beforeAll(async () => {
    driver = testNeo4jDriver();
    await clique(A);
    await clique(B);
    // fan the bridge into two members of each clique so no single clique node is itself a cut vertex —
    // keeps the bridge the unambiguous betweenness peak.
    await edge(A[0]!, bridge);
    await edge(A[1]!, bridge);
    await edge(bridge, B[0]!);
    await edge(bridge, B[1]!);
  });

  afterAll(async () => {
    if (!driver) return;
    await driver.executeQuery(`MATCH (n:User) WHERE n.id IN $ids DETACH DELETE n`, { ids: all });
    await driver.close();
  });

  it("scores every node; the bridge tops betweenness and a clique member (not the bridge) tops PageRank", async () => {
    const scores = await influenceScores(driver, projectId, all);
    expect(scores).not.toBeNull(); // null would mean GDS isn't installed in the target
    const { pageRank, betweenness } = scores!;

    // every seeded node landed in both score maps
    for (const id of all) {
      expect(pageRank.has(id)).toBe(true);
      expect(betweenness.has(id)).toBe(true);
    }

    // the sole cut vertex carries every cross-clique shortest path → highest betweenness
    const topBetween = [...betweenness.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(topBetween).toBe(bridge);

    // PageRank rewards dense mutual linking, not bridging → a clique member outranks the bridge
    const topPr = [...pageRank.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    expect(topPr).not.toBe(bridge);
    expect([...A, ...B]).toContain(topPr);
  });
});
