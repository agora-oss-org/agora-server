# CO_PARTICIPATES Live Smoke Test — Design

> **Status:** approved (brainstorming). Spec for two complementary live-verification artifacts that prove the
> CO_PARTICIPATES writer↔reader seam against a real Neo4j.
> **Feature under test:** PR9 (commit `be5efc7`) — see `docs/superpowers/specs/2026-06-16-co-participates-design.md`.

## Problem

The CO_PARTICIPATES edge has a cross-language integration seam with no automated coverage:

- **Writer** — the Python scorer (`worker/neo4j_writer.py::write_co_participates_edge`) is the *only* producer.
  Its `_CO_PARTICIPATES_MERGE` Cypher sets the edge label `CO_PARTICIPATES` and properties
  `sourceA`, `sourceB`, `projectId`, `weight`, `lastAt`, `createdAt`.
- **Reader** — the TS API (`apps/api/src/lib/social-neighborhood.ts::getSocialNeighborhood`) consumes that edge
  via `NEIGHBORHOOD_CYPHER`, which matches the `CO_PARTICIPATES` label and reads `rel.projectId` / `rel.lastAt`.

Both sides were verified by unit tests, but those tests stub the Neo4j driver — **no test executes both Cypher
statements against a live graph.** A property-name or label drift between writer and reader (e.g. the writer renames
`lastAt`, or the reader expects `at`) would produce *silent zero results*: the neighborhood read simply returns no
co-participation ties, with no error. Nothing currently catches that class of regression.

## Goals

1. **Prove the seam end-to-end** — the exact bytes the real Python writer sets are exactly what the real TS reader
   consumes, against a live Neo4j.
2. **Catch drift durably** — a test in the suite that fails if writer-shaped edges stop reading back correctly.
3. **Stay hermetic-by-default** — neither artifact runs in the normal unit suite; both skip cleanly without a graph.

## Non-goals (YAGNI)

- No CI wiring. Both artifacts are manual / opt-in (run when a graph is available).
- No new env vars. Reuse the existing `TEST_NEO4J_URI` / `TEST_NEO4J_AUTH`.
- No Postgres / pgmq. The end-to-end script calls the writer with explicit ids — it does **not** exercise the
  `resolve_co_participants` → pipeline enqueue path (a separate, much heavier integration concern).
- No exercise of the weight-clamp or lookback-window SQL (integration-level, already noted out of unit scope in PR9).

---

## Component 1 — End-to-end seam script

**Purpose:** the genuine proof. Runs the *real* Python writer, then the *real* TS reader, against one live Neo4j.
Run manually with the local stack up. Needs **only Neo4j** — no Postgres, no pgmq.

**Location & files:**

- `scripts/smoke/co-participates.sh` — bash driver (new `scripts/smoke/` dir).
- `services/scorer/scripts/smoke_write_co_participates.py` — thin CLI around the real writer.
- `apps/api/scripts/smoke-read-co-participates.ts` — thin CLI around the real reader (run via `tsx`).

**Flow:**

1. **Preflight.** The driver reads `TEST_NEO4J_URI` / `TEST_NEO4J_AUTH`; errors with a usage hint if unset.
   Generate three ids: `PROJECT_ID`, `ACTOR_ID` (A), `PARTICIPANT_ID` (B) — via `uuidgen`, exported to both steps.
2. **Write (real Python writer).** `smoke_write_co_participates.py` argparses `--project/--actor/--participant`,
   builds `Settings()` via `dataclasses.replace(Settings(), neo4j_uri=<TEST_NEO4J_URI>, neo4j_auth=<TEST_NEO4J_AUTH>)`,
   and `asyncio.run`s the actual `write_co_participates_edge(settings, project_id=…, actor_id=…, participant_id=…)`.
   This executes the real `_CO_PARTICIPATES_MERGE` — no hand-copied Cypher. Invoked as
   `cd services/scorer && python scripts/smoke_write_co_participates.py …`.
3. **Read (real TS reader).** `smoke-read-co-participates.ts` constructs a driver from the same env
   (reuse `testNeo4jDriver()` from `apps/api/test/integration/neo4j-test-driver.ts`), then:
   - calls the real `getSocialNeighborhood(PROJECT_ID, ACTOR_ID, cfg, { driver, includeCoParticipates: true, fetchProfiles: <stub> })`
     and asserts **B is present** with `tieKinds` containing `"coParticipation"` at brightness `0.15`;
   - calls it again with `includeCoParticipates: false` and asserts **B is absent** (gating).
   - `cfg` = community defaults `{ warmthHalfLifeDays: 30, frictionHalfLifeDays: 14 }`. `fetchProfiles` is a stub
     that returns a minimal profile for any id — so **no Postgres is needed**. `nowMs` is left to default
     (read happens after the write, so the read clock ≥ the edge `lastAt`, keeping it inside the age window).
   Prints the resolved ties on success; exits non-zero with a diff on any mismatch. Invoked as
   `cd apps/api && pnpm exec tsx scripts/smoke-read-co-participates.ts …` (ids passed via env/argv).
4. **Cleanup.** A bash `trap` (runs on EXIT, even on failure) deletes the two `:User` nodes from the graph
   (`MATCH (n:User) WHERE n.id IN [$A,$B] DETACH DELETE n`) via a `--cleanup` mode on the read CLI
   (`smoke-read-co-participates.ts`), reusing its driver. Namespaced random ids mean cleanup is precise and
   collision-free.
5. **Report.** Driver prints a clear `PASS` / `FAIL` line and exits with the corresponding status.

**Why this proves the seam:** step 2 sets `sourceA/sourceB/projectId/lastAt` via the writer's own Cypher; step 3's
reader matches `CO_PARTICIPATES` and filters on `rel.projectId`/`rel.lastAt`. If either side drifts, B fails to
read back and the script exits non-zero — exactly the silent-zero regression the unit tests can't see.

---

## Component 2 — Automated read live-test

**Purpose:** durable, in-suite drift detection. Lives in the integration suite, skips without a graph.

**Location:** `apps/api/test/integration/co-participates-live.test.ts`, mirroring the existing
`social-neighborhood-live.test.ts` exactly:

- gated `describe.runIf(!!process.env.TEST_NEO4J_URI)`;
- `testNeo4jDriver()` for the driver; `randomUUID()`-namespaced `projectId` + user ids;
- seeds edges via `driver.executeQuery(<Cypher>)`; asserts through the real `getSocialNeighborhood`;
- `afterAll` cleanup: `MATCH (n:User) WHERE n.id IN $ids DETACH DELETE n`;
- runs via `pnpm test:integration` (from `apps/api`); silently skipped by the normal `pnpm test`.

**Seeding:** the test seeds CO_PARTICIPATES edges with Cypher that mirrors the writer's `_CO_PARTICIPATES_MERGE`
shape (same label + `sourceA/sourceB/projectId/lastAt`), with a comment naming the Python constant as the source of
truth. (The *script* in Component 1 is what closes the hand-copy gap; this test is the fast in-suite guard.)

**Scenarios (4):**

| # | Setup | Assert |
|---|-------|--------|
| 1 | A↔B CO_PARTICIPATES, recent `lastAt`; read with **default** opts | B **absent** (default off) |
| 2 | same edge; read with `includeCoParticipates: true` | B present, `tieKinds: ["coParticipation"]`, **brightness `0.15`** (proves 0 warmth / 0 friction) |
| 3 | A↔C CO_PARTICIPATES, **ancient** `lastAt` (e.g. 200 days); read with `includeCoParticipates: true` | C **absent** (age cutoff) |
| 4 | A↔D both `FOLLOWS` **and** CO_PARTICIPATES; read with `includeCoParticipates: true` | D present, `tieKinds: ["follow","coParticipation"]` (KIND_ORDER) |

Scenario 4 proves the new tie-kind merges and orders correctly alongside an existing kind; scenario 2's floor
brightness proves the edge is structurally neutral (contributes no warmth/friction).

---

## Verification

- `pnpm -r typecheck` clean (test file + the two script CLIs compile).
- `bash -n scripts/smoke/co-participates.sh` clean.
- `pnpm test:integration` **without** Neo4j → the new test skips; the integration suite stays green.
- **With the local stack up** (`docker compose up -d neo4j`; `.env` already has
  `TEST_NEO4J_URI=bolt://localhost:7687`, `TEST_NEO4J_AUTH=neo4j/please_change_me`):
  - `cd apps/api && TEST_NEO4J_URI=… TEST_NEO4J_AUTH=… pnpm test:integration` → the 4 scenarios pass;
  - `TEST_NEO4J_URI=… TEST_NEO4J_AUTH=… ./scripts/smoke/co-participates.sh` → prints `PASS`.

Final green for the live paths requires a reachable Neo4j; without one, verification is limited to typecheck +
syntax + correct-skip, and the run commands are handed to the operator.

## File summary

| File | New? | Role |
|------|------|------|
| `scripts/smoke/co-participates.sh` | new | bash driver: preflight → write → read → cleanup → PASS/FAIL |
| `services/scorer/scripts/smoke_write_co_participates.py` | new | CLI around the real `write_co_participates_edge` |
| `apps/api/scripts/smoke-read-co-participates.ts` | new | CLI around the real `getSocialNeighborhood` (+ `--cleanup`) |
| `apps/api/test/integration/co-participates-live.test.ts` | new | 4-scenario automated read live-test |
