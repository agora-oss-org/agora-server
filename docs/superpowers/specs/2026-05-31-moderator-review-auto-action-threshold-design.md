# Split the moderator auto-action threshold into block + review

**Date:** 2026-05-31
**Status:** Approved (design)
**Scope:** `@agora/moderator`, `@agora-server/contract`, `@agora/api`, `@agora/admin`

## Problem

The moderator has one auto-action knob, `MODERATION_AUTO_ACTION_THRESHOLD` (default 0.85),
that auto-removes a `block` verdict when `confidence >= threshold`. A `review` verdict never
auto-acts regardless of confidence — `review` means "route to a human." Operators want a second,
independent knob to *optionally* auto-remove high-confidence `review` verdicts too, for finer
tuning, without changing the conservative default behavior.

Note on semantics: `confidence` on a `review` verdict is the model's certainty that the item
*needs human review*, not certainty it should be removed. Auto-acting on `review` is therefore an
explicit, opt-in operator choice — hence the new knob defaults to **off**.

## Decisions

- **New env var:** `MODERATION_REVIEW_AUTO_ACTION_THRESHOLD`, range 0..1, **default 0 (off)**.
  `0` (or unset) means reviews always queue for a human (today's behavior).
- **Rename existing:** `MODERATION_AUTO_ACTION_THRESHOLD` → `MODERATION_BLOCK_AUTO_ACTION_THRESHOLD`
  (default 0.85, behavior unchanged). Symmetry with the new var.
- **Config field rename** in `projects.moderator_config` (jsonb): `autoActionThreshold` →
  `blockAutoActionThreshold`; add `reviewAutoActionThreshold`.
- **"Auto-hide" == the existing removal write-back.** There is no separate "hidden" write-back
  status; `api-client.applyModeration` writes `status: "removed"`. A review auto-action uses the
  same path. How removed content *displays* (hide vs placeholder) remains governed by the API's
  project `moderation_config` and is untouched here.
- **Stored-override handling: clean break (option C).** No data migration. Any value a project
  already saved under the old `autoActionThreshold` jsonb key is orphaned and silently falls back
  to the env default on upgrade. Acceptable because the deployment is early/single-project. Flagged
  in CHANGELOG as a breaking config rename.

## Core logic (`apps/moderator/src/lib/assess-and-record.ts`)

```ts
const removable = t.targetType === "entity" || t.targetType === "comment";
const blockEligible =
  verdict.verdict === "block" &&
  config.blockAutoActionThreshold > 0 &&
  verdict.confidence >= config.blockAutoActionThreshold;
const reviewEligible =
  verdict.verdict === "review" &&
  config.reviewAutoActionThreshold > 0 &&
  verdict.confidence >= config.reviewAutoActionThreshold;
const eligible = removable && (blockEligible || reviewEligible);
```

The "moderation: verdict" log line carries both thresholds and which one fired:
`blockThreshold`, `reviewThreshold`, `autoActionVerdict: "block" | "review" | null`
(replacing the single `threshold` field).

## Touch points

1. `apps/moderator/src/lib/env.ts` — rename `MODERATION_AUTO_ACTION_THRESHOLD` →
   `MODERATION_BLOCK_AUTO_ACTION_THRESHOLD`; add `MODERATION_REVIEW_AUTO_ACTION_THRESHOLD`
   (`z.coerce.number().min(0).max(1).default(0)`).
2. `apps/moderator/src/lib/project-config.ts` — `ResolvedModeratorConfig` gains
   `blockAutoActionThreshold` + `reviewAutoActionThreshold`; `resolve()` reads each as
   `override ?? env`, clamped 0..1; debug log updated.
3. `apps/moderator/src/lib/assess-and-record.ts` — the logic above + log fields.
4. `apps/moderator/src/lib/running-config.ts` — `defaults` exposes both thresholds.
5. `apps/moderator/src/lib/running-config.test.ts` — assert both fields present, no secret leak.
6. `packages/contract/src/schemas.ts` — `moderatorConfigSchema`: rename `autoActionThreshold` →
   `blockAutoActionThreshold`, add `reviewAutoActionThreshold` (both `z.number().min(0).max(1).nullish()`).
7. `apps/api/src/routes/misc.ts` — merge-loop key list + `moderatorView` mapping for both fields.
8. `apps/admin/src/lib/settings.ts` — `ModeratorConfigView` / `ModeratorConfigPatch` field renames + add.
9. `apps/admin/src/lib/moderation-ai.ts` — `defaults` type gains both thresholds.
10. `apps/admin/src/routes/settings/ModeratorPanel.tsx` — rename "Auto-action threshold" →
    "Block auto-action threshold"; add "Review auto-action threshold" field + an effective-summary
    row; form state, submit patch, `eff` map, placeholders updated.
11. `apps/moderator/.env.example` — document both vars (block renamed, review added + explained).
12. `CHANGELOG.md` — `Added`: review auto-action threshold; `Changed`: env + config-field rename
    (breaking).

## Testing

- Unit: `running-config.test.ts` updated for both defaults + no-secret-leak.
- Unit: extend/add a test asserting the `blockEligible || reviewEligible` decision table
  (block≥/<, review≥/< with review-threshold 0 vs >0, non-removable target).
- `pnpm --filter @agora-server/contract build` then `pnpm -r typecheck` must pass.
- Manual: admin Settings → Moderator shows both fields + effective values; setting the review
  threshold and posting borderline content auto-removes it.

## Out of scope

- The display behavior of removed content (API `moderation_config` hide/placeholder).
- Any change to the LLM policy/prompt (`policy.ts`) or verdict taxonomy.
- Backward-compat reading of the old jsonb key or env var name (explicitly rejected — option C).
