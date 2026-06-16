// OPT-IN live-graph test for the Constellation's GDS Louvain clustering — the one thing the unit suite
// (pure bucket/band/suppress helpers) can't reach. Requires OpenGDS installed in the Neo4j/DozerDB target.
// Run with: TEST_NEO4J_URI=bolt://localhost:7687 TEST_NEO4J_PASSWORD=… pnpm test:integration
// Uses its own driver (the app's NEO4J_URI is forced empty for hermeticity) and namespaces all nodes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import neo4j, { type Driver } from "neo4j-driver";
import { louvainCommunities } from "../../src/lib/social-constellation.js";

const uri = process.env.TEST_NEO4J_URI;

describe.runIf(!!uri)("constellation Louvain (live graph)", () => {
  let driver: Driver;
  const projectId = randomUUID();
  // Two cliques the algorithm should recover as two communities.
  const A = Array.from({ length: 6 }, () => randomUUID());
  const B = Array.from({ length: 6 }, () => randomUUID());
  const all = [...A, ...B];

  async function edge(a: string, b: string) {
    await driver.executeQuery(
      `MERGE (a:User {id: $a}) MERGE (b:User {id: $b})
       CREATE (a)-[:INTERACTED {sourceId: $sid, projectId: $pid, at: timestamp(), sentiment: 1.0}]->(b)`,
      { a, b, sid: randomUUID(), pid: projectId },
    );
  }
  async function clique(ids: string[]) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) await edge(ids[i]!, ids[j]!);
    }
  }

  beforeAll(async () => {
    driver = neo4j.driver(
      uri!,
      neo4j.auth.basic(process.env.TEST_NEO4J_USER ?? "neo4j", process.env.TEST_NEO4J_PASSWORD ?? ""),
    );
    await clique(A);
    await clique(B);
    await edge(A[0]!, B[0]!); // one weak bridge — graph is connected, but the two cliques still split
  });

  afterAll(async () => {
    if (!driver) return;
    await driver.executeQuery(`MATCH (n:User) WHERE n.id IN $ids DETACH DELETE n`, { ids: all });
    await driver.close();
  });

  it("projects the warmth graph + runs Louvain, recovering the two cliques as two communities", async () => {
    const communities = await louvainCommunities(driver, projectId, all);
    expect(communities).not.toBeNull();

    const commOf = new Map<string, string>();
    for (const [cid, members] of communities!) for (const m of members) commOf.set(m, cid);
    expect(commOf.size).toBe(all.length); // every seeded user got a community

    const aComms = new Set(A.map((u) => commOf.get(u)));
    const bComms = new Set(B.map((u) => commOf.get(u)));
    expect(aComms.size).toBe(1);              // clique A is one community
    expect(bComms.size).toBe(1);              // clique B is one community
    expect([...aComms][0]).not.toBe([...bComms][0]); // …and they're different
  });
});
