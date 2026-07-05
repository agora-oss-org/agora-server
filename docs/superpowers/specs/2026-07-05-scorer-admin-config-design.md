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

### In scope — per-project Haiku/LLM adjudication (corporate)

Wire the scorer to actually honor per-project LLM config (closing the pre-existing drift where the
panel stored `llm*` but `resolve()`/`haiku.py` ignored them). A corporate project can bring its own
provider + key + model:

| Field | Env fallback | Consumed how |
|---|---|---|
| `llmProvider` (`anthropic` \| `openai`) | `"anthropic"` (env is Anthropic-only) | picks the fixed provider host + request shape |
| `llmApiKey` (secret) | `settings.anthropic_api_key` **only when effective provider is `anthropic`**, else `None` | request auth; never logged |
| `llmModel` | `settings.haiku_model` | request model |
| `llmMaxTokens` | `settings.haiku_max_tokens` | request cap |

- **Base URL is NOT per-project** — fixed per provider (`api.anthropic.com` / `api.openai.com`), so no
  admin-controlled outbound URL (no SSRF / key-exfil vector). `llmBaseUrl` is dropped from the admin
  surface (schema field left dormant for backward-compat).
- **Enablement is per-project:** `llm_enabled = bool(resolved apiKey)`. A project with its own key gets
  Haiku even if the env key is unset; a project selecting `openai` with no own key is **disabled**
  (never sent the Anthropic env key). Disabled → the existing "borderline → human review" path.
- The scorer's `haiku.py` generalizes to a provider-branching LLM adapter (anthropic messages API /
  openai chat-completions), reusing the same `policy` prompts + `verdict` parser — the verdict contract
  is unchanged.

### Out of scope (explicitly)

- **Editing** any Bucket B infra/secret (would write secrets to the DB, allow cross-project wiring
  rewrite, and not take effect without a restart — contradicts `SECURITY.md`).
- **Per-project `llmBaseUrl`** — deliberately env/provider-default only (the SSRF boundary above);
  removed from the admin surface, ignored by the scorer.

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
   Also add the per-project LLM fields: `llm_provider` (`"anthropic"`|`"openai"`, default `"anthropic"`),
   `llm_model` (default `settings.haiku_model`), `llm_max_tokens` (default `settings.haiku_max_tokens`),
   `llm_api_key` (`cfg.llmApiKey` else `settings.anthropic_api_key` **only if effective provider is
   `anthropic`**, else `None`). Add `llm_enabled()` on the resolved object = `bool(llm_api_key)`.

3b. **`services/scorer/scorer/haiku.py` — generalize to a provider-branching LLM adapter**
   `assess()` takes the resolved LLM config (provider/model/max_tokens/api_key) instead of reading
   `settings.*`. Branch on provider: `anthropic` → `POST https://api.anthropic.com/v1/messages`
   (current headers/body); `openai` → `POST https://api.openai.com/v1/chat/completions` (Bearer auth,
   `messages` with a system role, parse `choices[0].message.content`). Reuse `policy.build_system_prompt`
   / `build_user_prompt` / `verdict.parse_verdict`. Returns `None` when disabled (no key) or on any error
   (→ human review), unchanged. **The API key and request body are never logged** (status/verdict only).

4. **`services/scorer/worker/pipeline.py`**
   Read `cfg.grayzone_low` / `cfg.grayzone_high` (from the already-fetched `cfg`) instead of
   `settings.grayzone_low/high`. Pass the resolved co-participates values into
   `resolve_co_participants` (signature gains the three params, or takes `cfg`). Change the gray-zone
   escalation to call the generalized adapter with the resolved LLM config and gate on `cfg.llm_enabled()`
   (per-project) instead of `settings.haiku_enabled()`.

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
   4. **Haiku adjudication** (kept editable, per-project — for corporate users): the existing
      **provider / API key / model / max-tokens** inputs stay. **Remove only the base-url input**
      (now env/provider-default only — the SSRF boundary). API key stays write-only (`hasLlmApiKey`).
      A hint notes: blank fields fall back to the scorer's env Haiku config; a project can bring its own
      provider + key. No "disabled" block — enablement is now per-project (own key works even if the
      env key is unset).
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
- **Per-project LLM key handling.** The resolved `llm_api_key` is a secret: in-memory only, **never
  logged** (adapter logs status/verdict, never the key/headers/request body — honors the info/error
  message-only rule). `moderatorView` keeps redacting it to `hasLlmApiKey`; `/config` shows `apiKeySet`
  only. Provider-aware fallback prevents leaking the Anthropic env key to an `openai` project (that
  project is simply disabled without its own key).
- **No admin-controlled outbound URL.** `llmBaseUrl` is not consumed — the adapter uses the fixed
  provider host, so there is no per-project SSRF / key-exfil surface.

## Testing

- **Scorer (pytest, pure):** extend `tests/test_config.py` — `resolve()` override/default/clamp for
  all five cascade/co-participates fields; ceiling enforcement; `low > high` → safe fallback; **the LLM
  resolution matrix** (per-project provider/model/max-tokens/key; env fallback; `openai`-without-key →
  `llm_enabled()` False and no Anthropic-key leak). Add a `tests/test_pipeline.py` case: a per-project
  `grayzoneHigh` override moves the block boundary. Extend `tests/test_haiku.py`: the adapter builds the
  correct anthropic vs openai request (URL/headers/body) from the resolved config, parses each response,
  and returns `None` when disabled; assert the API key never appears in any log output.
- **Contract/API:** unit-test `moderatorConfigSchema` rejects out-of-range values and `low > high`.
  Integration test: PATCH persists the five fields to `moderator_config`; GET round-trips them;
  clearing (null) reverts to env default in the view.
- **Admin:** manual/visual per repo convention (no admin unit suite).

Per CLAUDE.md this is security-relevant logic → assert negative cases (out-of-range rejected,
inverted band rejected, ceiling clamps).

## Docs / changelog / propagation

- `CHANGELOG.md` → `Added` (new per-project scorer overrides + admin section; per-project Haiku/LLM
  now honored incl. `openai` provider) and `Changed` (base-url dropped from the panel; Haiku enablement
  is now per-project).
- `docs/SCORER.md`, `docs/CHEAT-SHEET.md`, and the moderator-config doc: note the gray-zone +
  co-participates env vars are now per-project overridable, and that per-project LLM provider/key/model
  is now consumed (env is the fallback; base-url stays env-only).
- Run `/propagate` on the branch diff to catch mirrors (the env vars already exist in the three
  `.env.*.example` files; they gain an "also per-project override" note).

## Open questions

None — scope locked with the operator:
- Bucket B → read-only status (not editable).
- Optionals → co-participates **in**, deployment status **in**.
- Haiku section → **kept editable and wired per-project** (corporate users): provider + key + model +
  max-tokens consumed per-project with env fallback; `openai` + `anthropic` supported.
- Per-project `llmBaseUrl` → **out** (env/provider-default only — SSRF boundary); input removed from the panel.
- Co-participates → same panel, separate section.
