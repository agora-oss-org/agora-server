# Record raw classifier signals on moderation analyses — design

**Date:** 2026-07-05
**Status:** approved (brainstormed with Jenova)

## Motivation

The scorer runs two RoBERTa classifiers on every content item, but only the toxicity score gates
moderation; the relationship (sentiment) score is written solely to Neo4j. Neither raw signal is
recorded on the `moderation_analyses` audit row, so a human working the admin AI-flag queue sees the
verdict and (Haiku-era) confidence but not what the models actually measured — `tox 0.55 ·
sentiment −0.90` (likely venting) reads very differently from `tox 0.55 · sentiment +0.40` (likely
sarcasm), and with Haiku disabled the raw signals are all the context there is.

Recording both signals on **every** assessment (including `allow`s) also accumulates the dataset
needed to later validate the "disagreement routing" idea (§Future) with real traffic instead of
guesses.

## Decisions (and rejected alternatives)

1. **No formula folding the relationship score into the toxicity gate.** Sentiment ≠ toxicity, and
   the divergent cases are the highest-stakes ones in both directions:
   - Deeply negative but legitimate: grief, venting, criticism, recovery-community cries for help
     (*"I relapsed. I hate myself right now."*). Profanity already inflates tox on these; adding
     negative sentiment compounds the false positive. Auto-removing these is the worst possible
     failure mode.
   - Toxic but positive-toned: polite harassment, dogwhistles, sarcasm — sentiment would *dilute* a
     correct high tox score.
   A naive `tox' = tox + k·(−rel)` is wrong in both directions. Rejected.
2. **Record both raw signals as audit data; humans interpret them.** Zero decision risk.
3. **Disagreement routing (#2) is documented as a future addition, not implemented.** See §Future.
4. **No per-content score columns or `content_latest_scores` view.** The append log answers
   per-content queries via `DISTINCT ON` + the existing `(target_type, target_id)` index; no hot
   consumer exists; content tables are API-owned (the scorer must not write them) and content-row
   fields are one shaper mistake from leaking moderation internals to SDK clients. Revisit only when
   a concrete consumer (e.g. a space-health dashboard) shows up.
5. **UI scope: AI-flag dialog only.** The queue table and the reports ReviewDialog stay unchanged
   (YAGNI; explicitly declined).

## Design

### 1. Schema + migration

Two new **nullable** `double precision` columns on `moderation_analyses`:

| Column | Meaning | Range |
|---|---|---|
| `toxicity_score` | raw `P(toxic)` from the toxicity RoBERTa | 0..1 |
| `relationship_score` | signed sentiment quality `P(positive) − P(negative)` | −1..1 |

Nullable, not default-0: `0` is a meaningful value; pre-existing rows genuinely lack the data and
must render as "—", never as fake neutral.

- Drizzle schema: `packages/core/src/db/schema/misc.ts` (`moderationAnalyses`).
- Migration: **hand-authored** `apps/api/drizzle/0056_analysis_raw_signals.sql` (`db:generate` is
  broken in this repo), idempotent (`add column if not exists`), journal entry with `when` greater
  than the current journal max (non-monotonic timestamps strand later migrations).

### 2. Scorer write path

In `worker/pipeline.py` `assess_and_record`, both values are already in scope: `tox` and
`rel_quality` (hoist the `rel_quality` computation above the `record_analysis` call — it currently
sits below). Thread through:

- `worker/analyses.py` `AnalysisInput`: new fields `toxicity_score: float | None = None`,
  `relationship_score: float | None = None`.
- `scorer/db.py` `insert_analysis` + `_INSERT_ANALYSIS`: two new columns/params.

Both the pgmq queue path and the on-demand admin `/analyze` path flow through `assess_and_record`,
so both record the signals. Recorded on every verdict including `allow`.

### 3. Contract + shapers

- `packages/contract/src/types.ts` `ModerationAnalysis`: `toxicityScore: number | null`,
  `relationshipScore: number | null` — additive, no consumer breakage.
- `scorer/models.py` `ModerationAnalysis` (pydantic, camel-aliased): mirror fields, default `None`.
- `worker/analyses.py` `shape_analysis`: map the row columns (None-safe for legacy rows).

Naming matches the existing Neo4j `Content.relationshipScore` convention.

### 4. Admin UI

`apps/admin/src/routes/moderation/AiFlagDialog.tsx`: under the verdict badge / confidence line, a
small mono row — `tox 0.55 · sentiment −0.90` — with "—" for null, plus a one-line faint hint that
negative sentiment ≠ toxic (grief/venting also read negative). No admin type change needed:
`apps/admin/src/lib/moderation-ai.ts` imports `ModerationAnalysis` directly from
`@agora-server/contract`, so the contract fields flow through (rebuild the contract first).

### 5. Docs

- `docs/SCORER.md`: document the two recorded signals on the analysis row; add a **"Future
  addition: disagreement routing"** subsection (§Future below, condensed).
- `services/scorer/README.md` (cascade section): one line — both raw signals are recorded on every
  analysis row.
- `CHANGELOG.md` under `## [Unreleased]` → `Added`.

### 6. Tests

- Scorer pytest: `AnalysisInput` → `insert_analysis` passes the new params; `shape_analysis`
  includes both fields and tolerates `None`/missing (legacy rows); pipeline test asserting the
  recorded row carries `tox` and `rel_quality` (existing pipeline tests use fakes — extend the fake
  insert capture).
- `pnpm -r typecheck` + `pnpm test` (unit) must pass; scorer suite via
  `ANTHROPIC_API_KEY="" pytest`.

## Future addition (documented, NOT implemented): disagreement routing

When `P(toxic) ≥ grayzone_high` **but** `relationship_score` is strongly positive (models disagree),
the combination suggests sarcasm, quoted lyrics, or in-group banter — route the item to `review`
(human queue) instead of auto-blocking. Key properties that make it acceptable to consider:

- It only ever moves content **toward** humans (fail-closed) — it can never cause a removal, so it
  cannot recreate the grief-post failure mode.
- Cost: some genuinely toxic content waits for a human instead of being auto-removed.
- **Precondition:** thresholds ("strongly positive") must be validated against the accumulated
  analysis dataset this change starts recording — not guessed.

## Out of scope

- The scorer admin-config panel (separate spec, `2026-07-05-scorer-admin-config-design.md`, parked).
- Reports ReviewDialog classifier context; queue-table columns; per-content score views/tables.
- Any change to the Neo4j write path (unchanged).
