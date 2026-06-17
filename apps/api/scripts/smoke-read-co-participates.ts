// Smoke-test CLI: read a CO_PARTICIPATES edge back via the REAL API reader against a live Neo4j.
//
// Reader-side half of the end-to-end seam smoke test
// (docs/superpowers/specs/2026-06-16-co-participates-smoke-test-design.md), driven by
// scripts/smoke/co-participates.sh. The companion Python writer MERGEs the edge; this calls the actual
// getSocialNeighborhood and asserts the participant reads back as a `coParticipation` tie at floor
// brightness when opted in, and is gated out when not. A writer↔reader label/property drift surfaces
// here as the participant simply being absent — the silent zero-result the unit suites can't catch.
//
// Profiles are stubbed (the Cypher returns ids; the Postgres join is covered elsewhere) so this needs
// only Neo4j. Run from apps/api with TEST_NEO4J_URI / TEST_NEO4J_AUTH (and DATABASE_URL /
// ACCESS_TOKEN_SECRET, required at import by lib/env) in the environment:
//   pnpm exec tsx scripts/smoke-read-co-participates.ts --project <p> --actor <a> --participant <b>
//   pnpm exec tsx scripts/smoke-read-co-participates.ts --project <p> --actor <a> --participant <b> --cleanup
import { testNeo4jDriver } from "../test/integration/neo4j-test-driver.js";
import { getSocialNeighborhood } from "../src/lib/social-neighborhood.js";

const cfg = { warmthHalfLifeDays: 30, frictionHalfLifeDays: 14 };
const FLOOR_BRIGHTNESS = 0.15; // pairBrightness(0, 0) — 0 warmth / 0 friction ⇒ structurally neutral

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const projectId = arg("project");
const actor = arg("actor");
const participant = arg("participant");
const cleanupOnly = process.argv.includes("--cleanup");

// Every candidate "exists" so presence/absence reflects the Cypher, not the (unused) Postgres join.
const stubProfiles = async (ids: string[]) =>
  new Map(ids.map((id) => [id, { id, username: id.slice(0, 8), name: null, avatar: null }]));

async function main(): Promise<number> {
  if (!projectId || !actor || !participant) {
    console.error("usage: smoke-read-co-participates.ts --project <p> --actor <a> --participant <b> [--cleanup]");
    return 2;
  }
  const driver = testNeo4jDriver();
  try {
    if (cleanupOnly) {
      await driver.executeQuery(`MATCH (n:User) WHERE n.id IN $ids DETACH DELETE n`, { ids: [actor, participant] });
      console.log(`cleaned up nodes ${actor}, ${participant}`);
      return 0;
    }

    const off = await getSocialNeighborhood(projectId, actor, cfg, {
      driver, includeCoParticipates: false, fetchProfiles: stubProfiles,
    });
    const on = await getSocialNeighborhood(projectId, actor, cfg, {
      driver, includeCoParticipates: true, fetchProfiles: stubProfiles,
    });
    const tie = on.ties.find((t) => t.userId === participant);

    const problems: string[] = [];
    if (off.includesCoParticipates !== false) {
      problems.push(`includesCoParticipates should echo false when off (got ${off.includesCoParticipates})`);
    }
    if (off.ties.some((t) => t.userId === participant)) {
      problems.push(`participant leaked into the default-off read (gating broken)`);
    }
    if (on.includesCoParticipates !== true) {
      problems.push(`includesCoParticipates should echo true when on (got ${on.includesCoParticipates})`);
    }
    if (!tie) {
      problems.push(`participant ${participant} absent from the opt-in read — writer↔reader DRIFT`);
    } else {
      if (!tie.tieKinds.includes("coParticipation")) {
        problems.push(`tieKinds missing "coParticipation": ${JSON.stringify(tie.tieKinds)}`);
      }
      if (Math.abs(tie.brightness - FLOOR_BRIGHTNESS) > 0.005) {
        problems.push(`expected floor brightness ${FLOOR_BRIGHTNESS}, got ${tie.brightness}`);
      }
    }

    if (problems.length > 0) {
      console.error("READ FAIL:");
      for (const p of problems) console.error(`  - ${p}`);
      console.error(`opt-in ties: ${JSON.stringify(on.ties)}`);
      return 1;
    }
    console.log(`READ OK — ${participant} read back as coParticipation @ brightness ${tie!.brightness} (tieKinds ${JSON.stringify(tie!.tieKinds)})`);
    return 0;
  } finally {
    await driver.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
