# Scorer admin config — runtime-tunable cascade knobs + read-only deployment status

**Date:** 2026-07-05
**Status:** Design approved; ready for implementation plan
**Owner:** Jenova

## Goal

Surface the **important, runtime-configurable** `services/scorer` knobs in the admin
(`apps/admin` → Settings → *Agent moderation*), following the existing per-project
`moderator_config` override pattern. Add read-only visibility of the deployment/infra wiring.
Disable the now-unused Haiku/LLM-provider editing surface (the operator is committing to a
no-Haiku deployment, and those fields are silently ignored by the scorer today).

"Runtime-configurable" is the filter: a knob qualifies only if the scorer reads it **per job**
from `projects.moderator_config` (briefly cached in `get_moderator_config`). Anything read from
the frozen env `Settings` at process start is **startup-only** and stays env-owned.

## Scope

### In scope — editable, per-project (Bucket A, runtime)

New `moderator_config` fields (env-only today → plumbed through the override rail):

| Field (jsonb / contract) | Env default source | Default | Server clamp / validation |
|---|---|---|---|
| `grayzoneLow` | `SCORER_GRAYZONE_LOW` | 0.30 | `[0,1]`; **must be ≤ `grayzoneHigh`** |
| `grayzoneHigh` | `SCORER_GRAYZONE_HIGH` | 0.80 | `[0,1]`; must be ≥ `grayzoneLow` |
| `coParticipatesLookbackDays` | `SCORER_CO_PARTICIPATES_LOOKBACK_DAYS` | 7 | int `[0, 365]` |
| `coParticipatesMaxParticipants` | `SCORER_CO_PARTICIPATES_MAX_PARTICIPANTS` | 50 | int `[1, 500]` — **hard ceiling** (feeds a SQL `LIMIT`; unbounded = query-cost DoS) |
| `coParticipatesMaxWeight` | `SCORER_CO_PARTICIPATES_MAX_WEIGHT` | 10.0 | `[1, 1000]` |

Already per-project (grouped/relabeled, no new plumbing): `blockAutoActionThreshold`,
`reviewAutoActionThreshold`, `categories`.

### In scope — read-only status (Bucket B, startup-only)

Operator-only "Deployment status" view sourced from the scorer's existing `/config` endpoint
(extended). Secrets shown only as `set` / `not set`; non-secret wiring shown by value:
`DATABASE_URL` (host/db), `SCORER_LISTEN_DATABASE_URL` (set?), `ACCESS_TOKEN_SECRET` (set?),
`API_BASE_URL` + `MODERATION_SERVICE_SECRET` (write-back on/off — already present),
`ANTHROPIC_API_KEY` (Haiku on/off — already present), the two model-server URLs, `SCORER_QUEUE`,
`SCORER_POLL_INTERVAL_MS`, `SCORER_VISIBILITY_TIMEOUT_S`, `NEO4J_URI` (host) + `NEO4J_AUTH` (set?)
+ `NEO4J_DATABASE`. Labeled "env-owned · restart to change."

### Out of scope (explicitly)

- **Editing** any Bucket B infra/secret (would write secrets to the DB, allow cross-project wiring
  rewrite, and not take effect without a restart — contradicts `SECURITY.md`).
- **Haiku / per-project LLM provider** — not wired. See "Haiku section" below.
- Wiring per-project `llmModel` / `llmMaxTokens` / `llmProvider` / `llmBaseUrl` / `llmApiKey` into
  the scorer. That pre-existing drift (panel stores them; scorer's `resolve()` drops them; `haiku.py`
  reads env only) is documented here as a **known gap**, not fixed. Removing the editable inputs
  (below) stops it being a *misleading* surface without changing stored data.

## Architecture & data flow

The override rail already exists end-to-end; we extend each hop:

```
apps/admin ModeratorPanel  ──PATCH /settings/moderator──▶  apps/api misc.ts
   (edit Bucket A knobs)                                     persist → projects.moderator_config jsonb
                                                                   │
services/scorer get_moderator_config(project_id)  ◀──── reads jsonb per job (cached)
   → resolve(cfg, settings)  overlays jsonb over env defaults  → ResolvedModeratorConfig
        │
   pipeline.py  reads cfg.grayzone_low / cfg.grayzone_high   (was: settings.*)
   db.resolve_co_participants(cfg…)  reads cfg co-participates (was: settings.*)

apps/admin ModeratorPanel  ──GET /moderation/config──▶  scorer admin_api /config (operator-only)
   (effective defaults + read-only Deployment status)     defaults{…} + NEW deployment{…}
```

### Component changes

1. **`packages/contract/src/schemas.ts` — `moderatorConfigSchema`**
   Add the five fields with the clamps above. Add a `.superRefine` (or `.refine`) that rejects
   `grayzoneLow > grayzoneHigh` when both are present → contract-level validation, surfaced as a
   zod issue by `parseBody`. Keep the existing `llm*` fields in the schema (backward-compat; the
   admin simply stops sending them). Export any new TS types the admin imports.

2. **`apps/api/src/routes/misc.ts`**
   - Extend the PATCH persist key-list with the five new keys (same merge-on-write: `null` clears
     → scorer env default).
   - Extend `moderatorView()` to echo the five stored overrides (typed-number/`null`).
   - Add a boundary ordering check (defense-in-depth alongside the contract refine): if the
     *resulting* merged config has `low > high`, throw `Errors.badRequest("moderator/grayzone-order", …)`.
     (Mirror the social-config "validate the resulting state" pattern already in this file.)

3. **`services/scorer/scorer/config.py` — `ResolvedModeratorConfig` + `resolve()`**
   Add `grayzone_low`, `grayzone_high`, `co_participates_lookback_days`,
   `co_participates_max_participants`, `co_participates_max_weight`. `resolve()` overlays each
   (`_clamp01` for the 0–1 pair; new `_clamp_int(lo, hi)` / `_clamp_float(lo, hi)` helpers for the
   co-participates trio, re-applying the same ceilings server-side — never trust the stored jsonb).
   Enforce `low ≤ high` here too (if inverted, fall back to env defaults — fail safe, never an empty
   band).

4. **`services/scorer/worker/pipeline.py`**
   Read `cfg.grayzone_low` / `cfg.grayzone_high` (from the already-fetched `cfg`) instead of
   `settings.grayzone_low/high`. Pass the resolved co-participates values into
   `resolve_co_participants` (signature gains the three params, or takes `cfg`).

5. **`services/scorer/scorer/db.py` — `resolve_co_participants`**
   Take the resolved lookback/max-participants/max-weight from `cfg` rather than `settings`.

6. **`services/scorer/worker/admin_api.py` — `/config`**
   Extend `config.defaults` with `grayzoneLow`, `grayzoneHigh`, and a `coParticipates` object
   (`lookbackDays`, `maxParticipants`, `maxWeight`). Add a new `config.deployment` object for the
   read-only Bucket B status (values for non-secrets, booleans for secrets — see Bucket B list).

7. **`apps/admin/src/lib/moderation-ai.ts` — `ModeratorRunningConfig`**
   Extend the `defaults` type + add the `deployment` type to match #6.

8. **`apps/admin/src/lib/settings.ts` — `ModeratorConfigView` / `ModeratorConfigPatch`**
   Add the five new fields (`number | null`).

9. **`apps/admin/src/routes/settings/ModeratorPanel.tsx`** — reorganized into sections:
   1. *Effective for this project* summary (existing; add rows for grayzone + co-participates).
   2. **Cascade thresholds** (new grouping): `grayzoneLow`, `grayzoneHigh`, `blockAutoActionThreshold`,
      `reviewAutoActionThreshold`. A small inline legend: `allow < LOW ≤ escalate < HIGH ≤ block`,
      and a live inline warning when `LOW ≥ HIGH`.
   3. **Social-graph tuning** (new): the three co-participates knobs.
   4. **Haiku adjudication — Disabled** (replaces the editable LLM inputs): a greyed read-only block
      driven by running-config `defaults.llm.enabled` / `apiKeySet`. Copy: "Haiku is off —
      gray-zone items route to human review. Re-enable via `ANTHROPIC_API_KEY` (env, operator)."
      When Haiku *is* enabled, show its effective model/max-tokens read-only (from running config)
      plus a one-line note that per-project LLM overrides are not currently consumed by the scorer
      (the known gap). No editable provider/key/model/maxTokens inputs remain.
   5. **Deployment status** (new, operator-only, read-only): Bucket B table from
      `running.config.deployment`; hidden entirely if running-config is unavailable.
   6. *Moderation categories* editor (existing, unchanged).

## Security

- **Fail closed on validation.** Clamp + reject at the API boundary (zod + resulting-state check)
  **and** re-clamp in the scorer `resolve()` — the jsonb is untrusted input at read time too.
- **Hard ceilings** on co-participates ints, `maxParticipants` especially, because it becomes a SQL
  `LIMIT` in the co-participant query. Ceiling enforced in both the contract schema and `resolve()`.
- **Ordering invariant** (`low ≤ high`) enforced at the boundary (reject) and at read (safe fallback)
  so a bad/legacy row can never produce an empty or inverted escalation band.
- **Authorization unchanged.** `GET/PATCH /settings/moderator` stay `requireProjectAdmin`; the
  `/config` status stays operator-only (`require_operator`). No new route, no new gate to get wrong.
- **No secret ever valued.** Deployment status shows secrets as `set`/`not set` only — reuses the
  existing `bool(...)`-projection pattern in `/config`.

## Testing

- **Scorer (pytest, pure):** extend `tests/test_config.py` — `resolve()` override/default/clamp for
  all five fields; ceiling enforcement; `low > high` → safe fallback. Add a `tests/test_pipeline.py`
  case: a per-project `grayzoneHigh` override moves the block boundary for a fixed toxicity score
  (assert verdict flips from `block` to `allow`/escalate at the new edge).
- **Contract/API:** unit-test `moderatorConfigSchema` rejects out-of-range values and `low > high`.
  Integration test: PATCH persists the five fields to `moderator_config`; GET round-trips them;
  clearing (null) reverts to env default in the view.
- **Admin:** manual/visual per repo convention (no admin unit suite).

Per CLAUDE.md this is security-relevant logic → assert negative cases (out-of-range rejected,
inverted band rejected, ceiling clamps).

## Docs / changelog / propagation

- `CHANGELOG.md` → `Added` (new per-project scorer overrides + admin section) and `Changed`
  (LLM/Haiku editing removed from the panel).
- `docs/SCORER.md`, `docs/CHEAT-SHEET.md`, and the moderator-config doc: note the gray-zone +
  co-participates env vars are now per-project overridable, and that per-project LLM provider config
  is a known unconsumed gap.
- Run `/propagate` on the branch diff to catch mirrors (the env vars already exist in the three
  `.env.*.example` files; they gain an "also per-project override" note).

## Open questions

None — scope locked with the operator:
- Bucket B → read-only status (not editable).
- Optionals → co-participates **in**, deployment status **in**, Haiku model/max-tokens wiring **out**.
- Haiku section → **disabled** by removing the editable LLM inputs (stored values untouched).
- Co-participates → same panel, separate section.
