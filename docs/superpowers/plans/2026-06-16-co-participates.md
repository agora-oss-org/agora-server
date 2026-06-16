# CO_PARTICIPATES Edge — Implementation Plan (PR9)

> **For agentic workers:** implement task-by-task; each task ends green (`pytest` for scorer, `pnpm -r typecheck` + `pnpm --filter @agora/api test` for TS) and gets its own commit. Steps use `- [ ]` checkboxes.

**Repo:** `/Users/jenova/projects/jenova-marie/agora-server`. Solo dev — work directly on `root`, no branches/PRs. Commit per task (gitmoji + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`). **Ask Jenova for commit approval before each commit.**

**Spec:** `docs/superpowers/specs/2026-06-16-co-participates-design.md` (approved).

---

## Context

The social graph's neighbor set is currently built from `FOLLOWS`, `CONNECTED`, and (opt-in) `INTERACTED` edges. The one remaining structural signal — *people who showed up in the same thread* — has no edge. CO_PARTICIPATES adds an **undirected, structurally-neutral** edge between two users who comment on the same entity. It contributes **0 warmth and 0 friction**; its sole effect is to **expand the Neighborhood neighbor set** when a member opts in via `?includeCoParticipates=true`. The scorer writes the edges into Neo4j (Postgres untouched — no migration, no new pgmq job); the API reads them back behind a per-request flag.

This completes SOCIAL-GRAPH.md §7 Phase 2.

### Three reconciliations with the spec (discovered while reading the actual code)

1. **Not a config flag.** Unlike `includeInteractions` (which has a `ResolvedSocialConfig.neighborhoodIncludeInteractions` project default), the design decided CO_PARTICIPATES is **purely per-request, default false**. So we do **not** touch `socialConfigSchema` / `ResolvedSocialConfig` / tier defaults. The route reads `?includeCoParticipates=true` with no config fallback.
2. **Explicit edge-type branches in the Cypher.** The current `NEIGHBORHOOD_CYPHER` relies on "anything not FOLLOWS/CONNECTED is INTERACTED" and reads `rel.at`. CO_PARTICIPATES is a *second* behavioral edge type and uses **`rel.lastAt`** (no `at`, no `sentiment`). So each behavioral branch must be scoped by `type(rel)` — otherwise the `rel.at` predicate would wrongly apply to CO_PARTICIPATES rows. The warmth/friction `OPTIONAL MATCH`es stay `INTERACTED`/`FRICTION`-only, so CO_PARTICIPATES contributes 0/0 automatically (no math change).
3. **A new tie-kind label is required.** `mapTieKinds` filters out unknown Neo4j labels, so without a new kind a co-participant-only neighbor would return `tieKinds: []`. Add `"coParticipation"` to `NEIGHBORHOOD_TIE_KINDS` + the `TIE_KIND`/`KIND_ORDER` maps, and echo `includesCoParticipates` on `SocialNeighborhood`.

### Edge schema (Neo4j, written by scorer)

Canonical-directed `(lower_id)→(higher_id)`, MERGE-keyed on `{sourceA, sourceB, projectId}`. Properties: `sourceA`, `sourceB`, `projectId`, `weight` (float, +1 per co-event, clamped at `MAX_WEIGHT`), `lastAt` (epoch-ms), `createdAt` (epoch-ms). No `sentiment`.

---

## File structure

**Scorer (Python, `services/scorer/`)** — package layout: `scorer/` (config, db, models, neo4j) + `worker/` (neo4j_writer, pipeline). Tests in `tests/` import `from scorer.config import Settings`, `from scorer.db import ...`, `from worker import neo4j_writer, pipeline`.
- `scorer/config.py` — +3 `Settings` fields (env vars).
- `scorer/db.py` — +`resolve_co_participants()`.
- `worker/neo4j_writer.py` — +`canonical_pair()` (pure helper) +`write_co_participates_edge()` +`_CO_PARTICIPATES_MERGE` Cypher.
- `worker/pipeline.py` — wire co-participant loop into the existing INTERACTED block in `assess_and_record()`.
- `tests/test_config.py`, `tests/test_db_co_participates.py` (new), `tests/test_neo4j_writer_co_participates.py` (new), `tests/test_pipeline.py` — tests.

**API + contract (TypeScript)**
- `packages/contract/src/social.ts` — tie-kind const + `SocialNeighborhood.includesCoParticipates`.
- `apps/api/src/lib/social-neighborhood.ts` — Cypher + `TIE_KIND`/`KIND_ORDER` + opts + echo.
- `apps/api/src/routes/social.ts` — `?includeCoParticipates` query param.
- `apps/api/src/lib/social-neighborhood.test.ts` — unit tests.

**Docs** — `CHANGELOG.md`, `docs/SOCIAL-GRAPH.md` §7, `docs/MANIFEST.md`.

---

## Task 1 — Scorer settings (3 env vars)

**Files:** Modify `services/scorer/scorer/config.py`; Test `services/scorer/tests/test_config.py`.

- [ ] **Step 1: Write the failing test.** Append to `tests/test_config.py`:

```python
def test_co_participates_defaults() -> None:
    s = Settings()
    assert s.co_participates_lookback_days == 7
    assert s.co_participates_max_participants == 50
    assert s.co_participates_max_weight == 10.0
```

- [ ] **Step 2: Run it — expect FAIL.** `cd services/scorer && pytest tests/test_config.py::test_co_participates_defaults -v` → `AttributeError: 'Settings' object has no attribute 'co_participates_lookback_days'`.

- [ ] **Step 3: Implement.** In `scorer/config.py`, add to the `Settings` dataclass directly after the Neo4j fields (`neo4j_uri` / `neo4j_auth`):

```python
    # CO_PARTICIPATES — undirected co-commenter edges (docs/SOCIAL-GRAPH.md §7). Neutral: feeds the
    # Neighborhood neighbor-set only, no warmth/friction. Lookback bounds recency; cap bounds fan-out
    # per comment event; weight ceiling bounds edge growth under repeated co-participation.
    co_participates_lookback_days: int = field(default_factory=lambda: _env_int("SCORER_CO_PARTICIPATES_LOOKBACK_DAYS", 7))
    co_participates_max_participants: int = field(default_factory=lambda: _env_int("SCORER_CO_PARTICIPATES_MAX_PARTICIPANTS", 50))
    co_participates_max_weight: float = field(default_factory=lambda: _env_float("SCORER_CO_PARTICIPATES_MAX_WEIGHT", 10.0))
```

- [ ] **Step 4: Run it — expect PASS.** `pytest tests/test_config.py -v`.

- [ ] **Step 5: Commit (after Jenova approves).**

```bash
git add services/scorer/scorer/config.py services/scorer/tests/test_config.py
git commit -m "✨ scorer: CO_PARTICIPATES env settings (lookback/cap/max-weight)"
```

---

## Task 2 — `resolve_co_participants()` (Postgres query)

**Files:** Modify `services/scorer/scorer/db.py`; Test `services/scorer/tests/test_db_co_participates.py` (new).

Resolves distinct *other* users who commented on the **same entity** (any thread depth) within the lookback window, most-recent-first, capped. Verified columns (from `apps/api/src/db/schema/content.ts`): `comments.id`, `comments.entity_id`, `comments.user_id` (nullable), `comments.deleted_at`, `comments.created_at`.

- [ ] **Step 1: Write the failing test.** Create `tests/test_db_co_participates.py`:

```python
from __future__ import annotations

import pytest

import scorer.db as db_module
from scorer.config import Settings


async def test_resolve_co_participants_stringifies_and_passes_through(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    class FakePool:
        async def fetch(self, sql, *args):  # noqa: ANN001
            captured["sql"] = sql
            captured["args"] = args
            return [{"user_id": "u1"}, {"user_id": "u2"}]

    async def fake_get_pool(settings):  # noqa: ANN001
        return FakePool()

    monkeypatch.setattr(db_module, "get_pool", fake_get_pool)
    out = await db_module.resolve_co_participants(Settings(), comment_id="c1", actor_id="a1")
    assert out == ["u1", "u2"]
    # comment id, actor id, lookback days, cap — in that positional order.
    assert captured["args"] == ("c1", "a1", 7, 50)
    assert "make_interval(days => $3)" in captured["sql"]
```

- [ ] **Step 2: Run it — expect FAIL.** `pytest tests/test_db_co_participates.py -v` → `AttributeError: module 'scorer.db' has no attribute 'resolve_co_participants'`.

- [ ] **Step 3: Implement.** Add to `scorer/db.py` (near the other `resolve_*` functions):

```python
async def resolve_co_participants(
    settings: Settings, *, comment_id: str, actor_id: str
) -> list[str]:
    """Distinct other users who also commented on the SAME entity (any thread depth) within the
    CO_PARTICIPATES lookback window, most-recent-first, capped at ``max_participants``. Excludes the
    triggering commenter, anonymous (null-author) and soft-deleted comments. Empty list if the comment
    is gone or has no co-participants."""
    pool = await get_pool(settings)
    rows = await pool.fetch(
        "select c2.user_id "
        "from comments c1 "
        "join comments c2 on c2.entity_id = c1.entity_id "
        "where c1.id = $1 "
        "  and c2.user_id is not null "
        "  and c2.user_id <> $2 "
        "  and c2.deleted_at is null "
        "  and c2.created_at >= now() - make_interval(days => $3) "
        "group by c2.user_id "
        "order by max(c2.created_at) desc "
        "limit $4",
        comment_id,
        actor_id,
        settings.co_participates_lookback_days,
        settings.co_participates_max_participants,
    )
    return [str(r["user_id"]) for r in rows]
```

> Note: lookback-window filtering and the cap live in SQL — they are integration-level (need a live DB) and are NOT asserted by the hermetic unit suite, consistent with every other `resolve_*` in `db.py`.

- [ ] **Step 4: Run it — expect PASS.** `pytest tests/test_db_co_participates.py -v`.

- [ ] **Step 5: Commit (after approval).**

```bash
git add services/scorer/scorer/db.py services/scorer/tests/test_db_co_participates.py
git commit -m "✨ scorer: resolve_co_participants — same-thread co-commenters (windowed, capped)"
```

---

## Task 3 — `write_co_participates_edge()` + `canonical_pair()`

**Files:** Modify `services/scorer/worker/neo4j_writer.py`; Test `services/scorer/tests/test_neo4j_writer_co_participates.py` (new).

- [ ] **Step 1: Write the failing test.** Create `tests/test_neo4j_writer_co_participates.py`:

```python
from __future__ import annotations

from worker.neo4j_writer import canonical_pair


def test_canonical_pair_orders_min_max_regardless_of_direction() -> None:
    assert canonical_pair("aaa", "bbb") == ("aaa", "bbb")
    assert canonical_pair("bbb", "aaa") == ("aaa", "bbb")


def test_canonical_pair_equal_ids() -> None:
    assert canonical_pair("x", "x") == ("x", "x")
```

- [ ] **Step 2: Run it — expect FAIL.** `pytest tests/test_neo4j_writer_co_participates.py -v` → `ImportError: cannot import name 'canonical_pair'`.

- [ ] **Step 3: Implement.** In `worker/neo4j_writer.py`, add the Cypher constant + helper near the other `_*_MERGE` constants:

```python
# CO_PARTICIPATES — undirected co-commenter edge, canonical-directed (lower id → higher id) so the pair
# is keyed once regardless of who triggers the write. Structurally neutral (no sentiment): the
# Neighborhood reads it only to EXPAND the neighbor set (0 warmth, 0 friction). weight is a co-event
# counter clamped at $max_weight — Cypher has no scalar min(), so a CASE does the clamp.
_CO_PARTICIPATES_MERGE = """
merge (a:User {id: $source_a})
merge (b:User {id: $source_b})
merge (a)-[r:CO_PARTICIPATES {sourceA: $source_a, sourceB: $source_b, projectId: $project_id}]->(b)
  on create set r.createdAt = timestamp(), r.weight = 1.0
  on match set r.weight = (case when r.weight + 1.0 > $max_weight then $max_weight else r.weight + 1.0 end)
set r.lastAt = timestamp()
"""


def canonical_pair(a: str, b: str) -> tuple[str, str]:
    """Order a user-id pair deterministically (min, max) so the undirected CO_PARTICIPATES edge keys
    once. Lexicographic on the id strings — stable regardless of call direction."""
    return (a, b) if a <= b else (b, a)
```

Then add the writer (mirroring `write_friction_edge`'s no-op guards):

```python
async def write_co_participates_edge(
    settings: Settings,
    *,
    project_id: str,
    actor_id: str,
    participant_id: str,
) -> None:
    """MERGE an undirected CO_PARTICIPATES edge between two co-commenters, keyed on the canonical
    (sourceA, sourceB, projectId) pair. No-op (logged) when Neo4j is off, an endpoint is missing, or
    it's a self-pair."""
    driver = await get_driver(settings)
    if driver is None:
        log(logger, "debug", "neo4j co-participates edge skipped (not configured)", actor_id=actor_id)
        return
    if not actor_id or not participant_id:
        log(logger, "debug", "neo4j co-participates edge skipped (missing endpoint)", actor_id=actor_id)
        return
    if str(actor_id) == str(participant_id):
        log(logger, "debug", "neo4j co-participates edge skipped (self-pair)", actor_id=actor_id)
        return
    source_a, source_b = canonical_pair(str(actor_id), str(participant_id))
    async with driver.session() as session:
        await session.run(
            _CO_PARTICIPATES_MERGE,
            source_a=source_a,
            source_b=source_b,
            project_id=str(project_id),
            max_weight=float(settings.co_participates_max_weight),
        )
    log(logger, "info", "neo4j co-participates edge merged", source_a=source_a, source_b=source_b)
```

> The weight increment + `MAX_WEIGHT` clamp live entirely in Cypher (`on match set ... case`); like the INTERACTED/FRICTION weight math, they're exercised only against live Neo4j, not the hermetic unit suite.

- [ ] **Step 4: Run it — expect PASS.** `pytest tests/test_neo4j_writer_co_participates.py -v`.

- [ ] **Step 5: Commit (after approval).**

```bash
git add services/scorer/worker/neo4j_writer.py services/scorer/tests/test_neo4j_writer_co_participates.py
git commit -m "✨ scorer: write_co_participates_edge — canonical-keyed undirected MERGE"
```

---

## Task 4 — Wire co-participants into the pipeline

**Files:** Modify `services/scorer/worker/pipeline.py`; Test `services/scorer/tests/test_pipeline.py`.

The hook goes inside `assess_and_record()`'s existing INTERACTED block (`if write_interaction and target_type == "comment":` → `if ctx is not None:`). Gate the whole thing on `settings.neo4j_enabled()` so we never run the co-participant query when the graph is off.

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_pipeline.py` (the file already has `_patch`, `Settings`, `ScoreJob`, `pipeline`, `neo4j_writer` imported):

```python
import dataclasses


def _capture_co_participates(monkeypatch: pytest.MonkeyPatch, rec: dict, participant_ids: list[str]) -> None:
    rec["co_participates"] = []

    async def fake_resolve_co(settings, *, comment_id, actor_id):  # noqa: ANN001
        rec["resolve_co_args"] = {"comment_id": comment_id, "actor_id": actor_id}
        return participant_ids

    async def fake_write_co(settings, **kw):  # noqa: ANN001
        rec["co_participates"].append(kw)

    monkeypatch.setattr(pipeline, "resolve_co_participants", fake_resolve_co)
    monkeypatch.setattr(neo4j_writer, "write_co_participates_edge", fake_write_co)


async def test_comment_job_writes_co_participates_when_graph_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.95, "toxic": 0.05})
    _capture_co_participates(monkeypatch, rec, ["u2", "u3"])
    settings = dataclasses.replace(Settings(), neo4j_uri="bolt://x", neo4j_auth="u/p")
    job = ScoreJob(target_type="comment", target_id="c1", project_id="p1")
    await pipeline.process_job(settings, job, msg_id=11)
    assert rec["resolve_co_args"] == {"comment_id": "c1", "actor_id": "author-1"}
    assert [c["participant_id"] for c in rec["co_participates"]] == ["u2", "u3"]
    assert all(c["actor_id"] == "author-1" and c["project_id"] == "p1" for c in rec["co_participates"])


async def test_entity_job_writes_no_co_participates(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.95, "toxic": 0.05})
    _capture_co_participates(monkeypatch, rec, ["u2"])
    settings = dataclasses.replace(Settings(), neo4j_uri="bolt://x", neo4j_auth="u/p")
    job = ScoreJob(target_type="entity", target_id="e1", project_id="p1")
    await pipeline.process_job(settings, job, msg_id=12)
    assert rec["co_participates"] == []


async def test_comment_job_skips_co_participates_when_graph_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.95, "toxic": 0.05})
    _capture_co_participates(monkeypatch, rec, ["u2"])
    job = ScoreJob(target_type="comment", target_id="c1", project_id="p1")
    await pipeline.process_job(Settings(), job, msg_id=13)  # default Settings → neo4j_enabled() is False
    assert rec["co_participates"] == []
```

- [ ] **Step 2: Run them — expect FAIL.** `pytest tests/test_pipeline.py -k co_participates -v` → `AttributeError: module 'worker.pipeline' has no attribute 'resolve_co_participants'` (the import doesn't exist yet).

- [ ] **Step 3a: Implement — extend the import.** In `worker/pipeline.py`, add `resolve_co_participants` to the `from scorer.db import (...)` block:

```python
from scorer.db import (
    fetch_content,
    get_moderator_config,
    resolve_co_participants,
    resolve_comment_interaction,
    resolve_reaction_interaction,
    resolve_report_friction,
)
```

- [ ] **Step 3b: Implement — the loop.** In `assess_and_record()`, inside the existing `if ctx is not None:` block, immediately after the `await neo4j_writer.write_interaction_edge(...)` call, add:

```python
            # CO_PARTICIPATES — undirected co-commenter edges (neutral; feeds the Neighborhood
            # neighbor-set only). Gated on Neo4j being configured so the co-participant query never
            # runs when the graph is off. Self-pairs / missing ids are dropped by the writer.
            if settings.neo4j_enabled() and ctx.actor_id is not None:
                participant_ids = await resolve_co_participants(
                    settings, comment_id=target_id, actor_id=ctx.actor_id
                )
                for participant_id in participant_ids:
                    await neo4j_writer.write_co_participates_edge(
                        settings,
                        project_id=project_id,
                        actor_id=ctx.actor_id,
                        participant_id=participant_id,
                    )
```

- [ ] **Step 4: Run them — expect PASS.** `pytest tests/test_pipeline.py -k co_participates -v`, then the full scorer suite: `pytest tests/ -v`.

- [ ] **Step 5: Commit (after approval).**

```bash
git add services/scorer/worker/pipeline.py services/scorer/tests/test_pipeline.py
git commit -m "✨ scorer: project CO_PARTICIPATES edges after INTERACTED on comment jobs"
```

---

## Task 5 — API: `includeCoParticipates` flag (contract + lib + route, end-to-end)

Grouped into one commit so the contract's new required `SocialNeighborhood.includesCoParticipates` and its single producer (`social-neighborhood.ts`) land together green.

**Files:** Modify `packages/contract/src/social.ts`, `apps/api/src/lib/social-neighborhood.ts`, `apps/api/src/routes/social.ts`; Test `apps/api/src/lib/social-neighborhood.test.ts`.

- [ ] **Step 1: Write the failing tests.** Add to `apps/api/src/lib/social-neighborhood.test.ts` (inside `describe("getSocialNeighborhood", ...)`, reusing its `stubDriver`, `stubProfiles`, `cfg`, `NOW`):

```typescript
  it("defaults includeCoParticipates to false and echoes it", async () => {
    const { driver, calls } = stubDriver([]);
    const out = await getSocialNeighborhood("p", "me", cfg, { driver, nowMs: NOW, fetchProfiles: stubProfiles([]) });
    expect(calls[0]!.params.includeCoParticipates).toBe(false);
    expect(out.includesCoParticipates).toBe(false);
  });

  it("passes includeCoParticipates through and echoes it when set", async () => {
    const { driver, calls } = stubDriver([]);
    const out = await getSocialNeighborhood("p", "me", cfg, {
      driver, nowMs: NOW, includeCoParticipates: true, fetchProfiles: stubProfiles([]),
    });
    expect(calls[0]!.params.includeCoParticipates).toBe(true);
    expect(out.includesCoParticipates).toBe(true);
  });

  it("maps a CO_PARTICIPATES-only tie to the coParticipation kind at the floor brightness", async () => {
    const { driver } = stubDriver([{ userId: "x", tieKinds: ["CO_PARTICIPATES"], w: 0, f: 0 }]);
    const out = await getSocialNeighborhood("p", "me", cfg, {
      driver, nowMs: NOW, includeCoParticipates: true,
      fetchProfiles: stubProfiles([["x", { username: "ex" }]]),
    });
    expect(out.ties[0]!.tieKinds).toEqual(["coParticipation"]);
    expect(out.ties[0]!.brightness).toBe(0.15);
  });
```

- [ ] **Step 2: Run them — expect FAIL.** `cd apps/api && pnpm test -- social-neighborhood` → fails (param undefined / `includesCoParticipates` missing).

- [ ] **Step 3a: Contract.** In `packages/contract/src/social.ts`:

Change the tie-kinds const (line 188):
```typescript
export const NEIGHBORHOOD_TIE_KINDS = ["follow", "connection", "interaction", "coParticipation"] as const;
```

Add to the `SocialNeighborhood` interface, right after `includesInteractions: boolean;`:
```typescript
  /** Whether CO_PARTICIPATES (co-commenter) ties were folded into the neighbor set for this response.
   *  Echoes the request's ?includeCoParticipates flag (default false). A neutral structural edge: it can
   *  only ADD a neighbor (at the floor brightness), never change warmth or friction. */
  includesCoParticipates: boolean;
```

- [ ] **Step 3b: Rebuild contract.** `pnpm --filter @agora-server/contract build`.

- [ ] **Step 3c: Lib.** In `apps/api/src/lib/social-neighborhood.ts`:

Extend the `TIE_KIND` map and `KIND_ORDER`:
```typescript
const TIE_KIND: Record<string, NeighborhoodTieKind> = {
  FOLLOWS: "follow",
  CONNECTED: "connection",
  INTERACTED: "interaction",
  CO_PARTICIPATES: "coParticipation",
};
const KIND_ORDER: readonly NeighborhoodTieKind[] = ["follow", "connection", "interaction", "coParticipation"];
```

Replace the `MATCH ... WHERE (...)` head of `NEIGHBORHOOD_CYPHER` (leave everything from `WITH me, x, collect(...)` onward unchanged):
```typescript
export const NEIGHBORHOOD_CYPHER = `
MATCH (me:User {id: $me})-[rel:FOLLOWS|CONNECTED|INTERACTED|CO_PARTICIPATES]-(x:User)
WHERE x.id <> $me AND (
  type(rel) IN ['FOLLOWS','CONNECTED']
  OR (type(rel) = 'INTERACTED' AND $includeInteractions AND rel.projectId = $projectId AND rel.at >= $ageCutoff AND rel.at <= $asOf)
  OR (type(rel) = 'CO_PARTICIPATES' AND $includeCoParticipates AND rel.projectId = $projectId AND rel.lastAt >= $ageCutoff AND rel.lastAt <= $asOf)
)
WITH me, x, collect(DISTINCT type(rel)) AS relTypes
```
*(the rest of the existing template string is unchanged — the `OPTIONAL MATCH (me)-[ri:INTERACTED]-(x)` warmth block and the FRICTION block stay exactly as-is, so CO_PARTICIPATES adds 0 warmth / 0 friction.)*

In `getSocialNeighborhood`, add to the `opts` type and read it:
```typescript
    includeInteractions?: boolean;
    includeCoParticipates?: boolean;
```
```typescript
  const includeInteractions = opts.includeInteractions ?? false;
  const includeCoParticipates = opts.includeCoParticipates ?? false;
```

Add the param to the `driver.executeQuery(NEIGHBORHOOD_CYPHER, { ... })` object:
```typescript
    includeInteractions,
    includeCoParticipates,
```

Echo it in the returned object:
```typescript
  return {
    ties,
    includesInteractions: includeInteractions,
    includesCoParticipates: includeCoParticipates,
    asOf: new Date(now).toISOString(),
  };
```

- [ ] **Step 3d: Route.** In `apps/api/src/routes/social.ts`, in the `.get("/neighborhood", ...)` handler, after the existing `includeInteractions` parse add:
```typescript
    // Per-request opt-in (no project default — neutral structural edge). Only "true" enables it.
    const includeCoParticipates = c.req.query("includeCoParticipates") === "true";
```
and pass both flags:
```typescript
      return c.json(
        await getSocialNeighborhood(c.var.projectId, c.var.auth!.userId, cfg, {
          includeInteractions,
          includeCoParticipates,
        }),
      );
```

- [ ] **Step 4: Run — expect PASS.** `cd apps/api && pnpm test -- social-neighborhood`, then from repo root `pnpm -r typecheck` and `pnpm --filter @agora/api test`.

- [ ] **Step 5: Commit (after approval).**

```bash
git add packages/contract/src/social.ts apps/api/src/lib/social-neighborhood.ts apps/api/src/routes/social.ts apps/api/src/lib/social-neighborhood.test.ts
git commit -m "✨ api: opt-in includeCoParticipates flag on GET /social/neighborhood"
```

---

## Task 6 — Docs + full verification

**Files:** `CHANGELOG.md`, `docs/SOCIAL-GRAPH.md`, `docs/MANIFEST.md`.

- [ ] **Step 1: CHANGELOG.** Under `## [Unreleased] → ### Added`:
```markdown
- **CO_PARTICIPATES social-graph edge** (SOCIAL-GRAPH §7 Phase 2). The scorer projects an undirected,
  structurally-neutral edge between users who comment in the same thread (canonical `(min,max)` key,
  windowed + capped + weight-clamped via `SCORER_CO_PARTICIPATES_LOOKBACK_DAYS` / `_MAX_PARTICIPANTS` /
  `_MAX_WEIGHT`). `GET /social/neighborhood?includeCoParticipates=true` opts a member's view into these
  ties (default off; adds neighbors at the floor brightness, contributes 0 warmth/friction). Neo4j-only —
  no Postgres migration.
```

- [ ] **Step 2: SOCIAL-GRAPH.md.** In §7, mark the Phase 2 CO_PARTICIPATES item complete (shipped this PR), matching the surrounding done-item style.

- [ ] **Step 3: MANIFEST.md.** On the `GET /social/neighborhood` entry, document the new optional query param `includeCoParticipates` (default false) alongside `includeInteractions`.

- [ ] **Step 4: Full verification.**
```bash
cd services/scorer && pytest tests/ -v
cd /Users/jenova/projects/jenova-marie/agora-server
pnpm --filter @agora-server/contract build
pnpm -r typecheck
pnpm --filter @agora/api test
```
Expected: scorer suite green (incl. the new co-participates tests), typecheck clean across 3 workspaces, api unit suite green.

- [ ] **Step 5: Commit (after approval).**

```bash
git add CHANGELOG.md docs/SOCIAL-GRAPH.md docs/MANIFEST.md
git commit -m "📝 docs: CO_PARTICIPATES edge + includeCoParticipates neighborhood flag"
```

---

## Self-review (spec coverage)

- §1 Edge schema → Task 3 (`_CO_PARTICIPATES_MERGE`, `canonical_pair`, weight clamp).
- §2 Scorer pipeline (`resolve_co_participants`, `write_co_participates_edge`, wiring, env vars) → Tasks 1–4.
- §3 API Neighborhood flag (query param, Cypher, neutral 0/0) → Task 5.
- §4 Contract (`includeCoParticipates` echo) → Task 5 (realized as `SocialNeighborhood.includesCoParticipates` + `coParticipation` tie-kind, not a config field — see Context reconciliations).
- §5 Testing → config default (T1), resolver pass-through (T2), canonical pairing (T3), pipeline fires/skips ×3 (T4), flag default/passthrough/tie-kind ×3 (T5). SQL-window/cap and Cypher weight-clamp are integration-level, noted.
- §6 Files changed → all covered. §7 Out of scope → unchanged.

## Out of scope (unchanged from spec)
No Weather changes; no `social_config` flag; no per-space CO_PARTICIPATES; no GDS projection edit (confirm separately it covers all relationship types); no `block`/`mute` FRICTION source.
