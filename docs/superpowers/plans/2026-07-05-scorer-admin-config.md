# Scorer Admin Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the important, runtime-configurable `services/scorer` knobs (gray-zone gate + co-participates) in the admin via the existing `moderator_config` override rail, add a read-only deployment-status view, and disable the unused Haiku/LLM editing surface.

**Architecture:** Extend the existing end-to-end override rail hop by hop — contract zod schema → API persist/view → scorer `resolve()`/`ResolvedModeratorConfig` → pipeline/db/neo4j consumers → scorer `/config` status endpoint → admin lib types → admin panel. No new routes or gates; reuse `requireProjectAdmin` (edit) and `require_operator` (status).

**Tech Stack:** TypeScript (Hono API, React/Vite admin, zod contract), Python (FastAPI scorer worker, asyncpg, pytest), vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-scorer-admin-config-design.md`.
- Clamps/bounds (enforce in BOTH the contract schema AND the scorer `resolve()` — jsonb is untrusted at read time): `grayzoneLow`/`grayzoneHigh` ∈ `[0,1]` and `grayzoneLow ≤ grayzoneHigh`; `coParticipatesLookbackDays` int `[0,365]`; `coParticipatesMaxParticipants` int `[1,500]` (hard ceiling — feeds a SQL `LIMIT`); `coParticipatesMaxWeight` ∈ `[1,1000]`.
- Ordering invariant fails **closed**: reject at the API boundary; in the scorer, an inverted band falls back to env defaults (never an empty escalation band).
- Never value a secret in status output — `set`/`not set` booleans only.
- Follow repo logging policy (`info`/`error` message-only; raw payloads on `debug`) — not expected to be needed here but applies.
- Build order: `pnpm --filter @agora-server/contract build` before typechecking/using the API or admin.
- Before "done": `pnpm -r typecheck` and `pnpm test` pass; scorer `ANTHROPIC_API_KEY="" pytest` passes (per memory: direnv key leak).
- All commits DCO-signed (`git commit -s`); end message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Work on branch `root` per repo convention.

---

### Task 1: Contract schema — new fields + ordering refine

**Files:**
- Modify: `packages/contract/src/schemas.ts` (the `moderatorConfigSchema` object, ~line 371)
- Test: `packages/contract/src/schemas.test.ts`

**Interfaces:**
- Produces: `moderatorConfigSchema` now accepts `grayzoneLow`, `grayzoneHigh`, `coParticipatesLookbackDays`, `coParticipatesMaxParticipants`, `coParticipatesMaxWeight` (all `number | null | undefined`), and rejects a body where both gray-zone values are present with `grayzoneLow > grayzoneHigh`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/contract/src/schemas.test.ts`:

```ts
import { moderatorConfigSchema } from "./schemas.js";

describe("moderatorConfigSchema — scorer cascade knobs", () => {
  it("accepts the new gray-zone + co-participates fields", () => {
    const r = moderatorConfigSchema.safeParse({
      grayzoneLow: 0.2, grayzoneHigh: 0.7,
      coParticipatesLookbackDays: 14, coParticipatesMaxParticipants: 100, coParticipatesMaxWeight: 5,
    });
    expect(r.success).toBe(true);
  });
  it("rejects gray-zone values out of [0,1]", () => {
    expect(moderatorConfigSchema.safeParse({ grayzoneHigh: 1.5 }).success).toBe(false);
    expect(moderatorConfigSchema.safeParse({ grayzoneLow: -0.1 }).success).toBe(false);
  });
  it("rejects grayzoneLow > grayzoneHigh when both present", () => {
    expect(moderatorConfigSchema.safeParse({ grayzoneLow: 0.8, grayzoneHigh: 0.3 }).success).toBe(false);
  });
  it("allows a partial patch of only grayzoneLow (ordering checked server-side vs stored)", () => {
    expect(moderatorConfigSchema.safeParse({ grayzoneLow: 0.9 }).success).toBe(true);
  });
  it("enforces the co-participates hard ceilings", () => {
    expect(moderatorConfigSchema.safeParse({ coParticipatesMaxParticipants: 501 }).success).toBe(false);
    expect(moderatorConfigSchema.safeParse({ coParticipatesMaxParticipants: 0 }).success).toBe(false);
    expect(moderatorConfigSchema.safeParse({ coParticipatesLookbackDays: 366 }).success).toBe(false);
    expect(moderatorConfigSchema.safeParse({ coParticipatesMaxWeight: 0 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @agora-server/contract test -- schemas`
Expected: FAIL (new fields stripped so `grayzoneLow:0.8/High:0.3` still parses; ceiling cases pass through).

- [ ] **Step 3: Implement the schema changes**

In `packages/contract/src/schemas.ts`, replace the `moderatorConfigSchema` definition (keep the existing `llm*` + `categories` fields untouched) with:

```ts
export const moderatorConfigSchema = z
  .object({
    blockAutoActionThreshold: z.number().min(0).max(1).nullish(),
    reviewAutoActionThreshold: z.number().min(0).max(1).nullish(),
    // Gray-zone gate (RoBERTa P(toxic) band): allow < low ≤ escalate < high ≤ block.
    grayzoneLow: z.number().min(0).max(1).nullish(),
    grayzoneHigh: z.number().min(0).max(1).nullish(),
    // CO_PARTICIPATES edge bounds. maxParticipants is a hard ceiling (feeds a SQL LIMIT).
    coParticipatesLookbackDays: z.number().int().min(0).max(365).nullish(),
    coParticipatesMaxParticipants: z.number().int().min(1).max(500).nullish(),
    coParticipatesMaxWeight: z.number().min(1).max(1000).nullish(),
    llmProvider: z.enum(["openai", "anthropic"]).nullish(),
    llmBaseUrl: z.string().url().nullish(),
    llmApiKey: z.string().min(1).nullish(),
    llmModel: z.string().min(1).nullish(),
    llmMaxTokens: z.number().int().positive().nullish(),
    categories: z.array(z.string().trim().min(1).max(64)).max(100).nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.grayzoneLow != null && v.grayzoneHigh != null && v.grayzoneLow > v.grayzoneHigh) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["grayzoneLow"],
        message: "grayzoneLow must be ≤ grayzoneHigh",
      });
    }
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @agora-server/contract test -- schemas`
Expected: PASS. Then `pnpm --filter @agora-server/contract build` (api/admin consume dist).

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src/schemas.ts packages/contract/src/schemas.test.ts
git commit -s -m "feat(contract): scorer gray-zone + co-participates moderator_config fields"
```

---

### Task 2: Scorer `resolve()` + `ResolvedModeratorConfig`

**Files:**
- Modify: `services/scorer/scorer/config.py` (`ResolvedModeratorConfig` ~line 115, clamp helpers ~line 122, `resolve()` ~line 136)
- Test: `services/scorer/tests/test_config.py`

**Interfaces:**
- Produces: `ResolvedModeratorConfig` gains `grayzone_low: float`, `grayzone_high: float`, `co_participates_lookback_days: int`, `co_participates_max_participants: int`, `co_participates_max_weight: float` (all with defaults so existing constructors keep working). `resolve()` overlays+clamps them and falls back to env defaults on an inverted band.

- [ ] **Step 1: Write the failing tests**

Append to `services/scorer/tests/test_config.py`:

```python
def test_resolve_applies_gray_zone_and_co_participates() -> None:
    s = Settings()
    cfg = resolve(
        {
            "grayzoneLow": 0.2, "grayzoneHigh": 0.7,
            "coParticipatesLookbackDays": 14, "coParticipatesMaxParticipants": 100,
            "coParticipatesMaxWeight": 5,
        },
        s,
    )
    assert cfg.grayzone_low == 0.2
    assert cfg.grayzone_high == 0.7
    assert cfg.co_participates_lookback_days == 14
    assert cfg.co_participates_max_participants == 100
    assert cfg.co_participates_max_weight == 5.0


def test_resolve_clamps_co_participates_ceilings() -> None:
    s = Settings()
    cfg = resolve(
        {"coParticipatesMaxParticipants": 99999, "coParticipatesLookbackDays": -5, "coParticipatesMaxWeight": 99999},
        s,
    )
    assert cfg.co_participates_max_participants == 500  # hard ceiling
    assert cfg.co_participates_lookback_days == 0       # floor
    assert cfg.co_participates_max_weight == 1000.0     # ceiling


def test_resolve_inverted_gray_zone_falls_back_to_env() -> None:
    s = Settings()
    cfg = resolve({"grayzoneLow": 0.9, "grayzoneHigh": 0.2}, s)
    assert cfg.grayzone_low == s.grayzone_low
    assert cfg.grayzone_high == s.grayzone_high


def test_resolve_gray_zone_defaults_to_env() -> None:
    s = Settings()
    cfg = resolve({}, s)
    assert cfg.grayzone_low == s.grayzone_low
    assert cfg.grayzone_high == s.grayzone_high
    assert cfg.co_participates_max_participants == s.co_participates_max_participants
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd services/scorer && ANTHROPIC_API_KEY="" .venv/bin/pytest tests/test_config.py -q`
Expected: FAIL (`ResolvedModeratorConfig` has no `grayzone_low`, etc.).

- [ ] **Step 3: Implement config changes**

In `services/scorer/scorer/config.py`, extend the dataclass (add after `categories`):

```python
@dataclass(frozen=True)
class ResolvedModeratorConfig:
    block_auto_action_threshold: float
    review_auto_action_threshold: float
    categories: list[str]
    # Runtime-tunable cascade + graph knobs (defaults mirror the env defaults so test/fake
    # constructors that omit them stay valid).
    grayzone_low: float = 0.30
    grayzone_high: float = 0.80
    co_participates_lookback_days: int = 7
    co_participates_max_participants: int = 50
    co_participates_max_weight: float = 10.0
```

Add clamp helpers next to `_clamp01`:

```python
def _clamp_int(v: object, fallback: int, lo: int, hi: int) -> int:
    if isinstance(v, bool):
        return fallback
    if isinstance(v, (int, float)):
        return max(lo, min(hi, int(v)))
    return fallback


def _clamp_float(v: object, fallback: float, lo: float, hi: float) -> float:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return max(lo, min(hi, float(v)))
    return fallback
```

Rewrite `resolve()`'s return to include the new fields (compute the gray-zone pair first for the fallback):

```python
def resolve(raw: object, settings: Settings) -> ResolvedModeratorConfig:
    """PURE: overlay a project's moderator_config jsonb over env defaults (override-or-env)."""
    cfg = raw if isinstance(raw, dict) else {}
    gl = _clamp01(cfg.get("grayzoneLow"), settings.grayzone_low)
    gh = _clamp01(cfg.get("grayzoneHigh"), settings.grayzone_high)
    if gl > gh:  # inverted/empty band → fail safe to env defaults, never an empty escalation band
        gl, gh = settings.grayzone_low, settings.grayzone_high
    return ResolvedModeratorConfig(
        block_auto_action_threshold=_clamp01(cfg.get("blockAutoActionThreshold"), settings.block_auto_action_threshold),
        review_auto_action_threshold=_clamp01(cfg.get("reviewAutoActionThreshold"), settings.review_auto_action_threshold),
        categories=_resolve_categories(cfg.get("categories")),
        grayzone_low=gl,
        grayzone_high=gh,
        co_participates_lookback_days=_clamp_int(cfg.get("coParticipatesLookbackDays"), settings.co_participates_lookback_days, 0, 365),
        co_participates_max_participants=_clamp_int(cfg.get("coParticipatesMaxParticipants"), settings.co_participates_max_participants, 1, 500),
        co_participates_max_weight=_clamp_float(cfg.get("coParticipatesMaxWeight"), settings.co_participates_max_weight, 1.0, 1000.0),
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd services/scorer && ANTHROPIC_API_KEY="" .venv/bin/pytest tests/test_config.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/scorer/scorer/config.py services/scorer/tests/test_config.py
git commit -s -m "feat(scorer): resolve per-project gray-zone + co-participates overrides"
```

---

### Task 3: Pipeline + db + neo4j consumers read the resolved config

**Files:**
- Modify: `services/scorer/worker/pipeline.py` (gray-zone gate ~line 64-67; co-participates call ~line 141-150)
- Modify: `services/scorer/scorer/db.py` (`resolve_co_participants` ~line 192-217)
- Modify: `services/scorer/worker/neo4j_writer.py` (`write_co_participates_edge` ~line 270-292)
- Test: `services/scorer/tests/test_pipeline.py`; update `services/scorer/tests/test_neo4j_writer_co_participates.py` for the new signature

**Interfaces:**
- Consumes: `ResolvedModeratorConfig.grayzone_low/high`, `.co_participates_*` (Task 2).
- Produces: `resolve_co_participants(settings, *, comment_id, actor_id, lookback_days, max_participants)`; `write_co_participates_edge(settings, *, project_id, actor_id, participant_id, max_weight)`.

- [ ] **Step 1: Write the failing test**

Append to `services/scorer/tests/test_pipeline.py` (the `_patch` helper's `fake_cfg` uses the dataclass defaults, so override grayzone by patching a bespoke cfg):

```python
async def test_per_project_gray_zone_high_moves_the_block_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    # tox=0.6 is BELOW the default high (0.80) → would escalate/allow. With a per-project high of 0.5,
    # 0.6 ≥ 0.5 → block. Proves the pipeline reads cfg.grayzone_high, not settings.
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.4, "toxic": 0.6})

    async def fake_cfg_low_high(settings, pid):  # noqa: ANN001
        return ResolvedModeratorConfig(
            block_auto_action_threshold=0.85, review_auto_action_threshold=0.0, categories=["spam"],
            grayzone_low=0.30, grayzone_high=0.50,
        )

    monkeypatch.setattr(pipeline, "get_moderator_config", fake_cfg_low_high)
    await pipeline.process_job(Settings(), _job(), msg_id=99)
    assert rec["data"].verdict == "block"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/scorer && ANTHROPIC_API_KEY="" .venv/bin/pytest tests/test_pipeline.py::test_per_project_gray_zone_high_moves_the_block_boundary -q`
Expected: FAIL (pipeline still reads `settings.grayzone_high=0.80` → verdict `allow`, not `block`).

- [ ] **Step 3: Implement the consumer changes**

In `services/scorer/worker/pipeline.py`, change the gate to read `cfg` (note `cfg` is already fetched just above at `cfg = await get_moderator_config(...)`):

```python
    # ── gray-zone cascade (gate on P(toxic), not the top label) ─────────────────
    tox = toxicity.scores.get("toxic", toxicity.score)
    verdict, categories, confidence, reason, model = "allow", [], tox, "", "roberta:toxicity"
    prompt_tokens = completion_tokens = 0
    if tox >= cfg.grayzone_high:
        verdict, confidence, reason = "block", tox, "High toxicity score"
    elif tox >= cfg.grayzone_low:
```

In the same file, update the co-participates block (~line 140-150) to pass resolved values:

```python
            if settings.neo4j_enabled() and ctx.actor_id is not None:
                participant_ids = await resolve_co_participants(
                    settings,
                    comment_id=target_id,
                    actor_id=ctx.actor_id,
                    lookback_days=cfg.co_participates_lookback_days,
                    max_participants=cfg.co_participates_max_participants,
                )
                for participant_id in participant_ids:
                    await neo4j_writer.write_co_participates_edge(
                        settings,
                        project_id=project_id,
                        actor_id=ctx.actor_id,
                        participant_id=participant_id,
                        max_weight=cfg.co_participates_max_weight,
                    )
```

In `services/scorer/scorer/db.py`, change `resolve_co_participants` to take the bounds as params:

```python
async def resolve_co_participants(
    settings: Settings, *, comment_id: str, actor_id: str, lookback_days: int, max_participants: int
) -> list[str]:
```

and replace the two `settings.co_participates_*` args in the `pool.fetch(...)` call with `lookback_days,` and `max_participants,`.

In `services/scorer/worker/neo4j_writer.py`, change `write_co_participates_edge` to accept `max_weight` and use it (replace `max_weight=float(settings.co_participates_max_weight)` in the `session.run` with `max_weight=float(max_weight)`), updating the signature to `... participant_id: str, max_weight: float)`.

- [ ] **Step 4: Update the neo4j-writer test for the new signature**

In `services/scorer/tests/test_neo4j_writer_co_participates.py`, add `max_weight=10.0` to each `write_co_participates_edge(...)` call.

- [ ] **Step 5: Run the scorer suite to verify green**

Run: `cd services/scorer && ANTHROPIC_API_KEY="" .venv/bin/pytest -q`
Expected: PASS (new pipeline test + existing pipeline/co-participates tests). Then `ruff check . && mypy scorer`.

- [ ] **Step 6: Commit**

```bash
git add services/scorer/worker/pipeline.py services/scorer/scorer/db.py services/scorer/worker/neo4j_writer.py services/scorer/tests/test_pipeline.py services/scorer/tests/test_neo4j_writer_co_participates.py
git commit -s -m "feat(scorer): pipeline + graph writers honor per-project cascade/co-participates config"
```

---

### Task 4: Scorer `/config` — publish new defaults + deployment status

**Files:**
- Modify: `services/scorer/worker/admin_api.py` (`get_config` ~line 64-104)
- Test: `services/scorer/tests/test_admin_config.py` (create)

**Interfaces:**
- Produces: `/config` response `config.defaults` gains `grayzoneLow`, `grayzoneHigh`, `coParticipates{lookbackDays,maxParticipants,maxWeight}`; new `config.deployment` object with model-server URLs, queue/poll/visibility, listen-db + anthropic booleans, and a `neo4j` sub-object.

- [ ] **Step 1: Write the failing test**

Create `services/scorer/tests/test_admin_config.py`:

```python
"""GET /config exposes the new gray-zone/co-participates defaults + a read-only deployment block.
Called directly (the Depends(require_operator) only binds under FastAPI routing; the param is unused)."""

from __future__ import annotations

from worker.admin_api import get_config


def test_config_reports_gray_zone_and_deployment() -> None:
    out = get_config("p1", None)  # type: ignore[arg-type]
    defaults = out["config"]["defaults"]
    assert "grayzoneLow" in defaults and "grayzoneHigh" in defaults
    assert defaults["coParticipates"]["maxParticipants"] == 50
    deploy = out["config"]["deployment"]
    assert "toxicityUrl" in deploy and "relationshipUrl" in deploy
    assert deploy["queue"] == "scorer_jobs"
    assert set(deploy["neo4j"]) == {"uriSet", "authSet", "database", "enabled"}
    # secrets are booleans, never values
    assert isinstance(deploy["anthropicApiKeySet"], bool)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/scorer && ANTHROPIC_API_KEY="" .venv/bin/pytest tests/test_admin_config.py -q`
Expected: FAIL (`KeyError: 'coParticipates'` / `'deployment'`).

- [ ] **Step 3: Implement the endpoint changes**

In `services/scorer/worker/admin_api.py`, inside `get_config`'s returned `config` dict, extend `defaults` and add `deployment` (place `deployment` as a sibling key of `defaults`):

```python
            "defaults": {
                "blockAutoActionThreshold": s.block_auto_action_threshold,
                "reviewAutoActionThreshold": s.review_auto_action_threshold,
                "grayzoneLow": s.grayzone_low,
                "grayzoneHigh": s.grayzone_high,
                "coParticipates": {
                    "lookbackDays": s.co_participates_lookback_days,
                    "maxParticipants": s.co_participates_max_participants,
                    "maxWeight": s.co_participates_max_weight,
                },
                # The scorer adjudicates the gray zone with Claude Haiku; report it in the llm slot.
                "llm": {
                    "provider": "anthropic",
                    "baseUrl": None,
                    "model": s.haiku_model,
                    "maxTokens": s.haiku_max_tokens,
                    "apiKeySet": s.haiku_enabled(),
                    "enabled": s.haiku_enabled(),
                },
            },
            # Read-only deployment wiring (env-owned; restart to change). Secrets as booleans only.
            "deployment": {
                "listenDatabaseUrlSet": bool(s.listen_database_url),
                "anthropicApiKeySet": s.haiku_enabled(),
                "toxicityUrl": s.toxicity_url,
                "relationshipUrl": s.relationship_url,
                "queue": s.queue,
                "pollIntervalMs": s.poll_interval_ms,
                "visibilityTimeoutS": s.visibility_timeout_s,
                "neo4j": {
                    "uriSet": bool(s.neo4j_uri),
                    "authSet": bool(s.neo4j_auth),
                    "database": s.neo4j_database,
                    "enabled": s.neo4j_enabled(),
                },
            },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/scorer && ANTHROPIC_API_KEY="" .venv/bin/pytest tests/test_admin_config.py -q`
Expected: PASS. Then `mypy scorer worker` (or the repo's configured mypy target).

- [ ] **Step 5: Commit**

```bash
git add services/scorer/worker/admin_api.py services/scorer/tests/test_admin_config.py
git commit -s -m "feat(scorer): /config publishes gray-zone/co-participates defaults + deployment status"
```

---

### Task 5: API — persist + view + resulting-state ordering guard

**Files:**
- Modify: `apps/api/src/routes/misc.ts` (PATCH persist key-list ~line 190; `moderatorView` ~line 316-332; add ordering guard in the PATCH handler ~line 195)
- Test: `apps/api/test/integration/moderator-config.test.ts` (create)

**Interfaces:**
- Consumes: `moderatorConfigSchema` (Task 1).
- Produces: `GET/PATCH /settings/moderator` round-trips the five new fields; PATCH rejects a *resulting* config where both gray-zone numbers are present and `low > high` with `Errors.badRequest("moderator/grayzone-order", …)`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/moderator-config.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { api, signToken, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("scorer moderator_config — gray-zone + co-participates overrides", () => {
  const created: string[] = [];
  afterAll(async () => { for (const p of created) await deleteProject(p); });

  async function adminCtx() {
    const projectId = await createProject();
    created.push(projectId);
    const u = await createUser(projectId, "visitor");
    const token = await signToken(u.id, "visitor", false, false, false, true /* project admin */);
    return { projectId, token };
  }

  it("persists and round-trips the new fields", async () => {
    const { projectId, token } = await adminCtx();
    const patch = await api("PATCH", `${base(projectId)}/settings/moderator`, {
      token,
      body: { grayzoneLow: 0.2, grayzoneHigh: 0.7, coParticipatesMaxParticipants: 120 },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.grayzoneLow).toBe(0.2);
    expect(patch.body.grayzoneHigh).toBe(0.7);
    expect(patch.body.coParticipatesMaxParticipants).toBe(120);

    const get = await api("GET", `${base(projectId)}/settings/moderator`, { token });
    expect(get.body.grayzoneHigh).toBe(0.7);
  });

  it("clearing a field (null) reverts it to unset in the view", async () => {
    const { projectId, token } = await adminCtx();
    await api("PATCH", `${base(projectId)}/settings/moderator`, { token, body: { grayzoneLow: 0.4 } });
    const cleared = await api("PATCH", `${base(projectId)}/settings/moderator`, { token, body: { grayzoneLow: null } });
    expect(cleared.body.grayzoneLow).toBeNull();
  });

  it("rejects an inverted gray-zone band in one PATCH", async () => {
    const { projectId, token } = await adminCtx();
    const res = await api("PATCH", `${base(projectId)}/settings/moderator`, {
      token, body: { grayzoneLow: 0.9, grayzoneHigh: 0.2 },
    });
    expect(res.status).toBe(400); // caught by the contract superRefine
  });

  it("rejects an inverted band assembled across two PATCHes (resulting-state guard)", async () => {
    const { projectId, token } = await adminCtx();
    await api("PATCH", `${base(projectId)}/settings/moderator`, { token, body: { grayzoneHigh: 0.3 } });
    const res = await api("PATCH", `${base(projectId)}/settings/moderator`, { token, body: { grayzoneLow: 0.8 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("moderator/grayzone-order");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts moderator-config`
Expected: FAIL (view omits new fields; the two-PATCH case returns 200 not 400).

- [ ] **Step 3: Implement the handler changes**

In `apps/api/src/routes/misc.ts`, extend the persist key-list:

```ts
    for (const k of ["blockAutoActionThreshold", "reviewAutoActionThreshold", "grayzoneLow", "grayzoneHigh", "coParticipatesLookbackDays", "coParticipatesMaxParticipants", "coParticipatesMaxWeight", "llmProvider", "llmBaseUrl", "llmApiKey", "llmModel", "llmMaxTokens", "categories"] as const) {
```

After the merge loop (before the `db.update`), add the resulting-state ordering guard:

```ts
    if (typeof next.grayzoneLow === "number" && typeof next.grayzoneHigh === "number" && next.grayzoneLow > next.grayzoneHigh) {
      throw Errors.badRequest("moderator/grayzone-order", "grayzoneLow must be ≤ grayzoneHigh");
    }
```

Extend `moderatorView()`'s returned object with the five echoes:

```ts
    grayzoneLow: typeof cfg.grayzoneLow === "number" ? cfg.grayzoneLow : null,
    grayzoneHigh: typeof cfg.grayzoneHigh === "number" ? cfg.grayzoneHigh : null,
    coParticipatesLookbackDays: typeof cfg.coParticipatesLookbackDays === "number" ? cfg.coParticipatesLookbackDays : null,
    coParticipatesMaxParticipants: typeof cfg.coParticipatesMaxParticipants === "number" ? cfg.coParticipatesMaxParticipants : null,
    coParticipatesMaxWeight: typeof cfg.coParticipatesMaxWeight === "number" ? cfg.coParticipatesMaxWeight : null,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts moderator-config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/misc.ts apps/api/test/integration/moderator-config.test.ts
git commit -s -m "feat(api): persist + guard scorer gray-zone/co-participates overrides"
```

---

### Task 6: Admin lib types

**Files:**
- Modify: `apps/admin/src/lib/settings.ts` (`ModeratorConfigView` ~line 117; `ModeratorConfigPatch` ~line 130)
- Modify: `apps/admin/src/lib/moderation-ai.ts` (`ModeratorRunningConfig` ~line 34)

**Interfaces:**
- Produces: `ModeratorConfigView`/`ModeratorConfigPatch` gain the five `number | null` fields; `ModeratorRunningConfig.config.defaults` gains `grayzoneLow`, `grayzoneHigh`, `coParticipates`, and `config` gains `deployment`.

- [ ] **Step 1: Extend the view/patch types**

In `apps/admin/src/lib/settings.ts`, add to `ModeratorConfigView` (after `reviewAutoActionThreshold`):

```ts
  grayzoneLow: number | null;
  grayzoneHigh: number | null;
  coParticipatesLookbackDays: number | null;
  coParticipatesMaxParticipants: number | null;
  coParticipatesMaxWeight: number | null;
```

and the mirror optional fields to `ModeratorConfigPatch`:

```ts
  grayzoneLow?: number | null;
  grayzoneHigh?: number | null;
  coParticipatesLookbackDays?: number | null;
  coParticipatesMaxParticipants?: number | null;
  coParticipatesMaxWeight?: number | null;
```

- [ ] **Step 2: Extend the running-config type**

In `apps/admin/src/lib/moderation-ai.ts`, extend `ModeratorRunningConfig`'s `config.defaults` with:

```ts
      grayzoneLow: number;
      grayzoneHigh: number;
      coParticipates: { lookbackDays: number; maxParticipants: number; maxWeight: number };
```

and add a sibling `deployment` field to `config`:

```ts
    deployment?: {
      listenDatabaseUrlSet: boolean;
      anthropicApiKeySet: boolean;
      toxicityUrl: string;
      relationshipUrl: string;
      queue: string;
      pollIntervalMs: number;
      visibilityTimeoutS: number;
      neo4j: { uriSet: boolean; authSet: boolean; database: string; enabled: boolean };
    };
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @agora/admin typecheck`
Expected: PASS (types only; consumers updated in Task 7 — if the panel already references new fields it belongs to Task 7's commit, so expect PASS here with unused type fields).

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/lib/settings.ts apps/admin/src/lib/moderation-ai.ts
git commit -s -m "feat(admin): types for scorer cascade/co-participates + deployment status"
```

---

### Task 7: Admin ModeratorPanel — sections, disabled Haiku, deployment status

**Files:**
- Modify: `apps/admin/src/routes/settings/ModeratorPanel.tsx`

**Interfaces:**
- Consumes: the extended `ModeratorConfigView/Patch` and `ModeratorRunningConfig` (Task 6); `getModeratorConfig`/`updateModeratorConfig` (unchanged signatures).

- [ ] **Step 1: Add state + patch wiring for the five new fields**

In `ModeratorForm`, add state next to the existing threshold state:

```tsx
  const [grayLow, setGrayLow] = useState(str(initial.grayzoneLow));
  const [grayHigh, setGrayHigh] = useState(str(initial.grayzoneHigh));
  const [cpLookback, setCpLookback] = useState(str(initial.coParticipatesLookbackDays));
  const [cpMaxParticipants, setCpMaxParticipants] = useState(str(initial.coParticipatesMaxParticipants));
  const [cpMaxWeight, setCpMaxWeight] = useState(str(initial.coParticipatesMaxWeight));
```

In the `save` mutation's `onSuccess`, re-sync them:

```tsx
      setGrayLow(str(view.grayzoneLow));
      setGrayHigh(str(view.grayzoneHigh));
      setCpLookback(str(view.coParticipatesLookbackDays));
      setCpMaxParticipants(str(view.coParticipatesMaxParticipants));
      setCpMaxWeight(str(view.coParticipatesMaxWeight));
```

In `onSubmit`'s `patch` object, add (a small `numOrNull` local: `const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));`):

```tsx
      grayzoneLow: numOrNull(grayLow),
      grayzoneHigh: numOrNull(grayHigh),
      coParticipatesLookbackDays: numOrNull(cpLookback),
      coParticipatesMaxParticipants: numOrNull(cpMaxParticipants),
      coParticipatesMaxWeight: numOrNull(cpMaxWeight),
```

Drop the `llmProvider/llmBaseUrl/llmModel/llmMaxTokens/llmApiKey` fields from the submitted `patch` (stop editing them). Remove the now-unused `provider/baseUrl/apiKey/model/maxTokens` state and their `onSuccess` re-syncs. Extend the `isDirty` current/initial objects with the five new trimmed values and drop the removed LLM fields.

- [ ] **Step 2: Add the "Cascade thresholds" section**

Replace the existing two-`Field` threshold grid with a grouped section (gray-zone first, then the auto-action floors), plus a live inverted-band warning:

```tsx
          <div className="space-y-3">
            <Label>Cascade thresholds</Label>
            <p className="text-xs text-faint">Toxicity gate: <code>allow &lt; low ≤ escalate &lt; high ≤ block</code>. Blank = server default.</p>
            {grayLow.trim() !== "" && grayHigh.trim() !== "" && Number(grayLow) > Number(grayHigh) && (
              <p className="text-xs text-danger">Gray-zone low must be ≤ high.</p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Gray-zone low" hint="P(toxic) below this → allow (no LLM). Blank = server default.">
                <Input type="number" min={0} max={1} step={0.01} placeholder={ph(defaults?.grayzoneLow, "0.30 (default)")} value={grayLow} onChange={(e) => setGrayLow(e.target.value)} />
              </Field>
              <Field label="Gray-zone high" hint="P(toxic) at/above this → block (no LLM). Blank = server default.">
                <Input type="number" min={0} max={1} step={0.01} placeholder={ph(defaults?.grayzoneHigh, "0.80 (default)")} value={grayHigh} onChange={(e) => setGrayHigh(e.target.value)} />
              </Field>
              <Field label="Block auto-action threshold" hint="0–1 confidence to auto-remove a “block”. 0 disables (queues for a human). Blank = server default.">
                <Input type="number" min={0} max={1} step={0.01} placeholder={ph(defaults?.blockAutoActionThreshold, "0.85 (default)")} value={blockThreshold} onChange={(e) => setBlockThreshold(e.target.value)} />
              </Field>
              <Field label="Review auto-action threshold" hint="0 (default) keeps reviews queuing for a human. Blank = server default.">
                <Input type="number" min={0} max={1} step={0.01} placeholder={ph(defaults?.reviewAutoActionThreshold, "0 (default)")} value={reviewThreshold} onChange={(e) => setReviewThreshold(e.target.value)} />
              </Field>
            </div>
          </div>
```

- [ ] **Step 3: Add the "Social-graph tuning" section**

After the cascade section:

```tsx
          <div className="space-y-3 border-t border-border pt-4">
            <Label>Social-graph tuning (co-participates)</Label>
            <p className="text-xs text-faint">Bounds the co-commenter edges written to the graph. Blank = server default.</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Lookback (days)" hint="0–365">
                <Input type="number" min={0} max={365} step={1} placeholder={ph(defaults?.coParticipates?.lookbackDays, "7 (default)")} value={cpLookback} onChange={(e) => setCpLookback(e.target.value)} />
              </Field>
              <Field label="Max participants" hint="1–500 (query cap)">
                <Input type="number" min={1} max={500} step={1} placeholder={ph(defaults?.coParticipates?.maxParticipants, "50 (default)")} value={cpMaxParticipants} onChange={(e) => setCpMaxParticipants(e.target.value)} />
              </Field>
              <Field label="Max edge weight" hint="1–1000">
                <Input type="number" min={1} max={1000} step={1} placeholder={ph(defaults?.coParticipates?.maxWeight, "10 (default)")} value={cpMaxWeight} onChange={(e) => setCpMaxWeight(e.target.value)} />
              </Field>
            </div>
          </div>
```

(Add `coParticipates` to the `Defaults` type usage — it flows from the extended `ModeratorRunningConfig` in Task 6, so `defaults?.coParticipates?.…` typechecks.)

- [ ] **Step 4: Replace the LLM inputs with the disabled Haiku section**

Delete the old Provider/API base URL/API key/Model/Max tokens `Field`s. In their place:

```tsx
          <div className="space-y-2 border-t border-border pt-4">
            <Label>Haiku adjudication</Label>
            {defaults?.llm.enabled ? (
              <div className="rounded-lg border border-border bg-bg/60 p-3 text-xs text-muted">
                <p>Enabled · model <span className="font-mono text-fg">{defaults.llm.model}</span> · max tokens {defaults.llm.maxTokens}.</p>
                <p className="mt-1 text-faint">Per-project LLM provider overrides are not currently consumed by the scorer (configured via env).</p>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs text-muted opacity-80">
                <p className="font-medium text-fg">Disabled</p>
                <p className="mt-1">Gray-zone items route to human review. Re-enable by setting <code>ANTHROPIC_API_KEY</code> in the scorer environment (operator).</p>
              </div>
            )}
          </div>
```

- [ ] **Step 5: Add the operator-only "Deployment status" section**

Before the categories editor (guarded on `running?.config.deployment`):

```tsx
          {running?.config.deployment && (
            <div className="space-y-2 border-t border-border pt-4">
              <Label>Deployment status</Label>
              <p className="text-xs text-faint">Env-owned · restart to change.</p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                <EffRow label="Toxicity server" eff={{ value: running.config.deployment.toxicityUrl, source: "default" }} />
                <EffRow label="Relationship server" eff={{ value: running.config.deployment.relationshipUrl, source: "default" }} />
                <EffRow label="Queue" eff={{ value: running.config.deployment.queue, source: "default" }} />
                <EffRow label="Poll interval (ms)" eff={{ value: String(running.config.deployment.pollIntervalMs), source: "default" }} />
                <EffRow label="Visibility timeout (s)" eff={{ value: String(running.config.deployment.visibilityTimeoutS), source: "default" }} />
                <EffRow label="Anthropic key" eff={{ value: running.config.deployment.anthropicApiKeySet ? "set" : "not set", source: running.config.deployment.anthropicApiKeySet ? "default" : "unset" }} />
                <EffRow label="Listen DB (NOTIFY)" eff={{ value: running.config.deployment.listenDatabaseUrlSet ? "set" : "not set", source: running.config.deployment.listenDatabaseUrlSet ? "default" : "unset" }} />
                <EffRow label="Neo4j" eff={{ value: running.config.deployment.neo4j.enabled ? `on · ${running.config.deployment.neo4j.database}` : "off", source: running.config.deployment.neo4j.enabled ? "default" : "unset" }} />
              </div>
            </div>
          )}
```

- [ ] **Step 6: Extend the effective summary + verify build**

Add gray-zone rows to the `eff` object and `EffectiveSummary` grid (mirror the existing `blockThreshold`/`reviewThreshold` rows using `defaults?.grayzoneLow`/`grayzoneHigh`). Then:

Run: `pnpm --filter @agora/admin typecheck && pnpm --filter @agora/admin build`
Expected: PASS. Manually verify in the running admin (Settings → Agent moderation): the three new sections render, the inverted-band warning shows when low>high, save persists, and the Haiku block shows "Disabled" when `ANTHROPIC_API_KEY` is unset.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/routes/settings/ModeratorPanel.tsx
git commit -s -m "feat(admin): scorer cascade + co-participates sections, disabled Haiku, deployment status"
```

---

### Task 8: Docs, changelog, propagation

**Files:**
- Modify: `CHANGELOG.md`, `docs/SCORER.md`, `docs/CHEAT-SHEET.md`

- [ ] **Step 1: Changelog**

Under `## [Unreleased]`, add to `Added`:

```markdown
- **Per-project scorer cascade tuning in the admin.** Settings → Agent moderation now exposes the
  RoBERTa gray-zone gate (`grayzoneLow`/`grayzoneHigh`), the block/review auto-action floors, and the
  co-participates graph bounds (`coParticipatesLookbackDays`/`MaxParticipants`/`MaxWeight`) as
  per-project overrides on `moderator_config` (env values remain the default). Adds a read-only,
  operator-only **Deployment status** view (model-server URLs, queue, poll/visibility, Neo4j, secret
  present/absent). (`packages/contract`, `apps/api/src/routes/misc.ts`, `services/scorer`, `apps/admin`.)
```

and to `Changed`:

```markdown
- **The moderator panel no longer edits per-project LLM provider config.** Those fields were stored
  but never consumed by the scorer (Haiku model/key come from env); the editing surface is replaced by
  a read-only "Haiku adjudication" status block. Stored values are untouched. (`apps/admin`.)
```

- [ ] **Step 2: Scorer docs**

In `docs/SCORER.md`, near the gray-zone section (~line 141) and the env-gates list, note that `SCORER_GRAYZONE_LOW/HIGH` and `SCORER_CO_PARTICIPATES_*` are now **per-project overridable** via `moderator_config` (admin Settings → Agent moderation), env value is the default; and that per-project LLM provider config remains a known unconsumed field. Mirror a one-line note in `docs/CHEAT-SHEET.md` where the scorer env vars are listed.

- [ ] **Step 3: Run the propagation checker**

Run: `cd apps/api && pnpm check:propagation --diff root`
Review output; apply any flagged `.env.*.example` / wiki mirror notes (the env vars already exist — they gain an "also per-project override" annotation). If `/propagate` is preferred, run it and approve the drafted edits.

- [ ] **Step 4: Full verification**

Run from repo root:
```bash
pnpm -r build && pnpm -r typecheck && pnpm test
cd services/scorer && ANTHROPIC_API_KEY="" .venv/bin/pytest -q && ruff check . && mypy scorer
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/SCORER.md docs/CHEAT-SHEET.md
git commit -s -m "docs(scorer): document per-project cascade/co-participates overrides + admin"
```

---

## Self-Review notes

- **Spec coverage:** gray-zone LOW/HIGH (Tasks 1-3,5-7 ✓), block/review grouping (Task 7 ✓), co-participates ×3 (Tasks 1-3,5-7 ✓), read-only deployment status (Tasks 4,6,7 ✓), disable Haiku section (Task 7 ✓), clamps in both layers (Tasks 1-2 ✓), ordering fail-closed at boundary + safe fallback at read (Tasks 2,5 ✓), maxParticipants ceiling (Tasks 1-2 ✓), secrets-as-booleans (Task 4 ✓), tests incl. negatives (Tasks 1-5 ✓), docs/propagate (Task 8 ✓).
- **Type consistency:** `ResolvedModeratorConfig` field names (`grayzone_low` etc.) match across config/pipeline/db; contract field names (`grayzoneLow` etc.) match API persist-list, `moderatorView`, admin types, and `/config` defaults keys; `resolve_co_participants`/`write_co_participates_edge` new signatures match their call sites in Task 3.
- **Known gap (intentional, per spec):** per-project `llmProvider/llmBaseUrl/llmApiKey/llmModel/llmMaxTokens` stay in the schema/DB but are not consumed by the scorer and no longer editable in the panel.
