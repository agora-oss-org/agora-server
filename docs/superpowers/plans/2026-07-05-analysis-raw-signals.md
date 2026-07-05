# Record Raw Classifier Signals on Moderation Analyses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp both raw RoBERTa signals (`toxicity_score` = P(toxic), `relationship_score` = signed sentiment) onto every `moderation_analyses` row and show them to human reviewers in the admin AI-flag dialog.

**Architecture:** Two nullable `double precision` columns on the append-log table; the scorer pipeline (which already has both values in scope) threads them through `AnalysisInput` → `insert_analysis`; the contract type gains two additive optional fields that flow to the admin dialog unchanged (the scorer's admin API reads `select *` and shapes via `shape_analysis`). No decision logic changes — signals are audit context only. Spec: `docs/superpowers/specs/2026-07-05-analysis-raw-signals-design.md`.

**Tech Stack:** Drizzle schema + hand-authored SQL migration (apps/api/drizzle), Python scorer (asyncpg, pydantic, pytest), TypeScript contract (`@agora-server/contract`), React admin.

## Global Constraints

- **Apply migrations with `pnpm db:migrate:run`, NEVER `pnpm db:migrate`** (drizzle-kit journal schema is misconfigured).
- **Hand-author the migration** — `pnpm db:generate` is broken in this repo. Journal entry `when` MUST be greater than the current max (`1781934611653`) or later migrations strand.
- **Migration must be idempotent** (`ADD COLUMN IF NOT EXISTS`).
- **Columns are nullable with NO default** — `0` is a meaningful score; pre-existing rows must read as NULL ("—"), never fake-neutral.
- **No decision-logic change**: the recorded signals must not alter any verdict/auto-action path.
- **Scorer tests run with the key blanked**: `ANTHROPIC_API_KEY="" pytest` (direnv can leak a real key; tests fail locally otherwise).
- **Build the contract before typechecking TS**: `pnpm --filter @agora-server/contract build`, then `pnpm -r typecheck`.
- **Logging rules** (if any log line is touched): `info`/`error` message-only; raw objects on `debug` only; Pino data-object-FIRST. Never `console.*` in TS.
- **Commits**: conventional-commit style, DCO-signed (`git commit -s`), footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Working-tree caveat**: `docs/SCORER.md`, `services/scorer/README.md` (this-session cascade-doc edits, on-topic — they ride along in Task 6's commit) and `CLAUDE.md` (unrelated — NEVER stage it) are already modified. Stage files explicitly; never `git add -A`.

---

### Task 1: DB column pair (Drizzle schema + hand-authored migration)

**Files:**
- Modify: `packages/core/src/db/schema/misc.ts` (the `moderationAnalyses` table, lines ~110-133)
- Create: `apps/api/drizzle/0056_analysis_raw_signals.sql`
- Modify: `apps/api/drizzle/meta/_journal.json` (append entry)

**Interfaces:**
- Produces: columns `moderation_analyses.toxicity_score` and `moderation_analyses.relationship_score`, both `double precision NULL`. Tasks 3-4 write them; the scorer's `select *` reads pick them up automatically.

- [ ] **Step 1: Add the columns to the Drizzle schema**

In `packages/core/src/db/schema/misc.ts`, inside `moderationAnalyses`, after the `completionTokens` line and before `humanResolvedAt`:

```ts
  // Raw classifier signals, recorded on EVERY assessment (incl. `allow`): P(toxic) from the toxicity
  // RoBERTa (0..1) and the signed relationship sentiment P(positive)−P(negative) (−1..1). Nullable, no
  // default — 0 is a meaningful value; pre-0056 rows genuinely lack the data and must render as "—".
  // Audit context for human review + the dataset for validating future threshold ideas (SCORER.md
  // "disagreement routing"). Deliberately NOT a moderation gate: sentiment ≠ toxicity.
  toxicityScore: doublePrecision("toxicity_score"),
  relationshipScore: doublePrecision("relationship_score"),
```

`doublePrecision` is already imported in this file (used by `confidence`).

- [ ] **Step 2: Create the migration**

Create `apps/api/drizzle/0056_analysis_raw_signals.sql`:

```sql
-- apps/api/drizzle/0056_analysis_raw_signals.sql
-- Raw classifier signals on the moderation_analyses audit row: toxicity_score = P(toxic) from the
-- toxicity RoBERTa (0..1); relationship_score = signed sentiment P(positive)−P(negative) (−1..1).
-- Nullable, no default — 0 is meaningful; pre-existing rows stay NULL. Recorded on every verdict
-- (incl. allow) as human-review context and as the validation dataset for the documented-but-not-
-- implemented "disagreement routing" idea (docs/SCORER.md). Idempotent.
SET search_path TO public, extensions;
--> statement-breakpoint
ALTER TABLE "moderation_analyses" ADD COLUMN IF NOT EXISTS "toxicity_score" double precision;
--> statement-breakpoint
ALTER TABLE "moderation_analyses" ADD COLUMN IF NOT EXISTS "relationship_score" double precision;
```

- [ ] **Step 3: Append the journal entry**

In `apps/api/drizzle/meta/_journal.json`, append after the `0055_push_devices` entry (note `when` = max+1):

```json
    {
      "idx": 56,
      "version": "7",
      "when": 1781934611654,
      "tag": "0056_analysis_raw_signals",
      "breakpoints": true
    }
```

- [ ] **Step 4: Apply and verify**

```bash
cd apps/api && pnpm db:migrate:run
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
psql "$url" -c '\d moderation_analyses' | grep -E 'toxicity_score|relationship_score'
```

Expected: both columns listed as `double precision` with no default, nullable. Re-run `pnpm db:migrate:run` once more — must be a no-op (idempotency).

- [ ] **Step 5: Typecheck**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server && pnpm -r typecheck
```

Expected: PASS (schema change is additive).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/db/schema/misc.ts apps/api/drizzle/0056_analysis_raw_signals.sql apps/api/drizzle/meta/_journal.json
git commit -s -m "feat(scorer): add raw classifier signal columns to moderation_analyses

toxicity_score (P(toxic), 0..1) + relationship_score (signed sentiment,
-1..1), nullable double precision, migration 0056. Audit context — not a
moderation gate.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Contract fields

**Files:**
- Modify: `packages/contract/src/types.ts` (interface `ModerationAnalysis`, ~line 155)

**Interfaces:**
- Produces: `ModerationAnalysis.toxicityScore?: number | null` and `ModerationAnalysis.relationshipScore?: number | null`. Task 5 (admin) consumes them. Optional AND nullable (deviation from the spec's `number | null`, deliberate): an old scorer process still running during a rolling deploy omits the keys entirely — `?:` makes the admin handle that honestly, mirroring the existing `author?: UserSummary | null` convention in the same interface.

- [ ] **Step 1: Add the fields**

In `packages/contract/src/types.ts`, inside `export interface ModerationAnalysis`, after the `autoActioned` line:

```ts
  // Raw classifier signals recorded with the assessment (see docs/SCORER.md). Optional + nullable:
  // null/absent on rows recorded before the columns existed (or by an older scorer process).
  toxicityScore?: number | null; // P(toxic) from the toxicity RoBERTa, 0..1
  relationshipScore?: number | null; // signed sentiment P(positive)−P(negative), −1..1
```

- [ ] **Step 2: Rebuild the contract + typecheck everything**

```bash
pnpm --filter @agora-server/contract build && pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/contract/src/types.ts
git commit -s -m "feat(contract): raw classifier signals on ModerationAnalysis

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Scorer persistence seam (models, AnalysisInput, insert SQL, shaper)

**Files:**
- Modify: `services/scorer/scorer/models.py` (pydantic `ModerationAnalysis`, ~line 92)
- Modify: `services/scorer/scorer/db.py` (`_INSERT_ANALYSIS` ~line 221, `insert_analysis` ~line 234)
- Modify: `services/scorer/worker/analyses.py` (`AnalysisInput`, `record_analysis`, `shape_analysis`)
- Create: `services/scorer/tests/test_analyses.py`

**Interfaces:**
- Consumes: Task 1's columns.
- Produces: `AnalysisInput(toxicity_score: float | None = None, relationship_score: float | None = None)`; `insert_analysis(..., toxicity_score: Optional[float], relationship_score: Optional[float])` (keyword args); `shape_analysis` emitting `toxicityScore`/`relationshipScore` (camel-aliased, `None`-safe). Task 4 constructs `AnalysisInput` with these fields.

- [ ] **Step 1: Write the failing tests**

Create `services/scorer/tests/test_analyses.py`:

```python
"""Persistence seam for the raw classifier signals — AnalysisInput → insert passthrough and the
row → ModerationAnalysis shaper (None-safe for pre-0056 rows)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from scorer import db
from scorer.config import Settings
from worker import analyses
from worker.analyses import AnalysisInput


def _input(**overrides: Any) -> AnalysisInput:
    base: dict[str, Any] = dict(
        project_id="p1", target_type="entity", target_id="t1", space_id=None,
        verdict="allow", categories=[], confidence=0.05, reason="", model="roberta:toxicity",
        auto_actioned=False, toxicity_score=0.05, relationship_score=-0.6, source_msg_id=7,
    )
    base.update(overrides)
    return AnalysisInput(**base)


async def test_record_analysis_passes_raw_signals_to_insert(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    async def fake_insert(settings: Settings, **kw: Any) -> dict[str, Any]:
        captured.update(kw)
        return kw

    monkeypatch.setattr(db, "insert_analysis", fake_insert)
    await analyses.record_analysis(Settings(), _input())
    assert captured["toxicity_score"] == pytest.approx(0.05)
    assert captured["relationship_score"] == pytest.approx(-0.6)


def _row(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "a1", "project_id": "p1", "target_type": "entity", "target_id": "t1",
        "space_id": None, "verdict": "allow", "categories": [], "confidence": 0.05,
        "reason": "", "model": "roberta:toxicity", "auto_actioned": False,
        "toxicity_score": 0.05, "relationship_score": -0.6,
        "human_resolved_at": None, "created_at": datetime(2026, 7, 5, tzinfo=timezone.utc),
    }
    base.update(overrides)
    return base


def test_shape_analysis_includes_raw_signals() -> None:
    shaped = analyses.shape_analysis(_row())
    assert shaped.toxicity_score == pytest.approx(0.05)
    assert shaped.relationship_score == pytest.approx(-0.6)
    dumped = shaped.model_dump(by_alias=True)
    assert dumped["toxicityScore"] == pytest.approx(0.05)
    assert dumped["relationshipScore"] == pytest.approx(-0.6)


def test_shape_analysis_none_safe_for_pre_migration_rows() -> None:
    shaped = analyses.shape_analysis(_row(toxicity_score=None, relationship_score=None))
    assert shaped.toxicity_score is None
    assert shaped.relationship_score is None
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
cd services/scorer && . .venv/bin/activate
ANTHROPIC_API_KEY="" pytest tests/test_analyses.py -v
```

Expected: FAIL — `AnalysisInput.__init__() got an unexpected keyword argument 'toxicity_score'` (and/or `ModerationAnalysis` has no field `toxicity_score`).

- [ ] **Step 3: Implement**

**(a)** `services/scorer/scorer/models.py`, in `class ModerationAnalysis(CamelModel)`, after `auto_actioned: bool = False`:

```python
    # Raw classifier signals (None on rows recorded before they existed). Audit context, not a gate.
    toxicity_score: Optional[float] = None
    relationship_score: Optional[float] = None
```

**(b)** `services/scorer/scorer/db.py` — replace `_INSERT_ANALYSIS` with:

```python
_INSERT_ANALYSIS = """
insert into moderation_analyses
  (project_id, target_type, target_id, space_id, verdict, categories, confidence, reason,
   model, auto_actioned, prompt_tokens, completion_tokens, source_msg_id,
   toxicity_score, relationship_score)
values
  ($1, $2::reaction_target, $3, $4, $5::moderation_verdict, $6, $7, $8, $9, $10, $11, $12, $13,
   $14, $15)
-- the dedup index is PARTIAL (migration 0028: `where source_msg_id is not null`), so the ON CONFLICT
-- arbiter must repeat that predicate to match it. NULL source_msg_id (on-demand /analyze) → no conflict.
on conflict (source_msg_id) where source_msg_id is not null do nothing
returning *
"""
```

and in `insert_analysis`, add two keyword params after `source_msg_id: Optional[int],`:

```python
    toxicity_score: Optional[float] = None,
    relationship_score: Optional[float] = None,
```

then append them to the `fetchrow` call:

```python
    return await pool.fetchrow(
        _INSERT_ANALYSIS, project_id, target_type, target_id, space_id, verdict, categories,
        confidence, reason, model, auto_actioned, prompt_tokens, completion_tokens, source_msg_id,
        toxicity_score, relationship_score,
    )
```

**(c)** `services/scorer/worker/analyses.py` — in `AnalysisInput`, after `completion_tokens: int = 0`:

```python
    # Raw classifier signals (recorded on every verdict, incl. allow). None when unavailable.
    toxicity_score: float | None = None
    relationship_score: float | None = None
```

In `record_analysis`, add to the `db.insert_analysis(...)` call after `completion_tokens=data.completion_tokens,`:

```python
        toxicity_score=data.toxicity_score,
        relationship_score=data.relationship_score,
```

In `shape_analysis`, after the `auto_actioned=...` line:

```python
        toxicity_score=(float(row["toxicity_score"]) if row["toxicity_score"] is not None else None),
        relationship_score=(float(row["relationship_score"]) if row["relationship_score"] is not None else None),
```

- [ ] **Step 4: Run the tests — verify they pass, plus the full scorer suite + lint/types**

```bash
ANTHROPIC_API_KEY="" pytest tests/test_analyses.py -v   # expected: 3 passed
ANTHROPIC_API_KEY="" pytest                              # expected: full suite passes
ruff check . && mypy scorer                              # expected: clean
```

- [ ] **Step 5: Commit**

```bash
git add scorer/models.py scorer/db.py worker/analyses.py tests/test_analyses.py
git commit -s -m "feat(scorer): persist raw classifier signals on analysis rows

Thread toxicity_score/relationship_score through AnalysisInput ->
insert_analysis -> shape_analysis (None-safe for pre-0056 rows).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Pipeline threading (record the live signals)

**Files:**
- Modify: `services/scorer/worker/pipeline.py` (`assess_and_record`, lines ~57-123)
- Modify: `services/scorer/tests/test_pipeline.py` (`_patch` + two new tests)

**Interfaces:**
- Consumes: Task 3's `AnalysisInput.toxicity_score`/`relationship_score`.
- Produces: every `assess_and_record` call records both signals; `rel_quality` computed once, used by both the analysis row and the Neo4j edge (behavior of the edge write unchanged).

- [ ] **Step 1: Extend the test fakes and write the failing tests**

In `services/scorer/tests/test_pipeline.py`, change `_patch`'s signature and the `rel_scores` line to accept an override (default preserves every existing test):

```python
def _patch(
    monkeypatch: pytest.MonkeyPatch,
    *,
    tox_scores: dict[str, float],
    rel_scores: dict[str, float] | None = None,
) -> dict:
    recorded: dict = {}
    rel_scores = rel_scores or {"negative": 0.2, "neutral": 0.6, "positive": 0.2}
```

(The rest of `_patch` is unchanged — `fake_score_both` already closes over `rel_scores`.)

Append two tests at the end of the file:

```python
async def test_raw_signals_recorded_on_analysis(monkeypatch: pytest.MonkeyPatch) -> None:
    # P(toxic) and the signed relationship quality (positive − negative) land on the audit row.
    rec = _patch(
        monkeypatch,
        tox_scores={"neutral": 0.1, "toxic": 0.9},
        rel_scores={"negative": 0.7, "neutral": 0.2, "positive": 0.1},
    )
    await pipeline.process_job(Settings(), _job(), msg_id=91)
    assert rec["data"].toxicity_score == pytest.approx(0.9)
    assert rec["data"].relationship_score == pytest.approx(-0.6)


async def test_raw_signals_recorded_on_allow_too(monkeypatch: pytest.MonkeyPatch) -> None:
    # The dataset property: allow verdicts record signals as well (not just flags/blocks).
    rec = _patch(monkeypatch, tox_scores={"neutral": 0.95, "toxic": 0.05})
    await pipeline.process_job(Settings(), _job(), msg_id=92)
    assert rec["data"].verdict == "allow"
    assert rec["data"].toxicity_score == pytest.approx(0.05)
    assert rec["data"].relationship_score == pytest.approx(0.0)
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd services/scorer && . .venv/bin/activate
ANTHROPIC_API_KEY="" pytest tests/test_pipeline.py -v
```

Expected: the two new tests FAIL (`toxicity_score` is `None` — pipeline doesn't pass it yet); all pre-existing tests still PASS.

- [ ] **Step 3: Implement in `worker/pipeline.py`**

**(a)** Hoist the `rel_quality` computation. Replace:

```python
    toxicity, relationship = await model_clients.score_both(settings, text, context)
    cfg = await get_moderator_config(settings, project_id)
```

with:

```python
    toxicity, relationship = await model_clients.score_both(settings, text, context)
    # Signed relationship quality in [-1, 1] (P(positive) - P(negative)); falls back to the top score
    # for non-sentiment models. Recorded on the analysis row below AND written to the Neo4j edge.
    rel = relationship.scores
    rel_quality = (rel.get("positive", 0.0) - rel.get("negative", 0.0)) if rel else relationship.score
    cfg = await get_moderator_config(settings, project_id)
```

**(b)** Remove the now-duplicate lines from the Neo4j section. Replace:

```python
    # ── relationship edges → Neo4j ─────────────────────────────────────────────
    # Signed quality in [-1, 1] (P(positive) - P(negative)); fall back to top score for non-sentiment models.
    rel = relationship.scores
    rel_quality = (rel.get("positive", 0.0) - rel.get("negative", 0.0)) if rel else relationship.score
    # v1: author → content (every scored item).
```

with:

```python
    # ── relationship edges → Neo4j ─────────────────────────────────────────────
    # v1: author → content (every scored item).
```

**(c)** Record the signals. In the `analyses.AnalysisInput(` construction, after `completion_tokens=completion_tokens,`:

```python
            toxicity_score=tox,
            relationship_score=rel_quality,
```

(`tox` is the gate's `toxicity.scores.get("toxic", toxicity.score)` — already in scope.)

- [ ] **Step 4: Run the scorer suite + lint/types**

```bash
ANTHROPIC_API_KEY="" pytest        # expected: full suite passes, incl. the 2 new tests
ruff check . && mypy scorer        # expected: clean
```

- [ ] **Step 5: Commit**

```bash
git add worker/pipeline.py tests/test_pipeline.py
git commit -s -m "feat(scorer): record live tox/rel signals from the cascade

Hoist rel_quality above the analysis insert and stamp both raw signals
onto every recorded assessment (allow included). No decision-logic change.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Admin AI-flag dialog — show the signals

**Files:**
- Modify: `apps/admin/src/routes/moderation/AiFlagDialog.tsx`

**Interfaces:**
- Consumes: Task 2's `toxicityScore`/`relationshipScore` on `ModerationAnalysis` (`current` in the dialog is one). No admin lib changes — `apps/admin/src/lib/moderation-ai.ts` imports the contract type directly.

- [ ] **Step 1: Add the formatter**

In `AiFlagDialog.tsx`, at module level (near the existing `VERDICT_BADGE` map):

```tsx
// "0.55" / "+0.40" / "−0.90"; em-dash when the row predates signal recording (null or absent).
const fmtScore = (v: number | null | undefined, signed = false) =>
  v == null ? "—" : `${signed && v > 0 ? "+" : ""}${v.toFixed(2)}`;
```

- [ ] **Step 2: Render the signals row**

Inside the `current ? (...)` block, between the badges `</div>` (the `flex flex-wrap` one ending with the categories map) and the `{current.reason ? ...}` line, insert:

```tsx
                    {current.toxicityScore != null || current.relationshipScore != null ? (
                      <div className="space-y-0.5">
                        <p className="font-mono text-xs text-muted">
                          tox {fmtScore(current.toxicityScore)} · sentiment {fmtScore(current.relationshipScore, true)}
                        </p>
                        <p className="text-xs text-faint">
                          Raw classifier signals — negative sentiment ≠ toxic (grief and venting also read negative).
                        </p>
                      </div>
                    ) : null}
```

(Entire block hidden for legacy rows where both are null/absent — no "tox — · sentiment —" noise.)

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: PASS. (Contract was rebuilt in Task 2; if this task runs in a fresh checkout, run `pnpm --filter @agora-server/contract build` first.)

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/routes/moderation/AiFlagDialog.tsx
git commit -s -m "feat(admin): show raw classifier signals in the AI-flag dialog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs + changelog

**Files:**
- Modify: `docs/SCORER.md` (cascade section ~line 148-151 + new subsection before "## The relationship graph")
- Modify: `services/scorer/README.md` ("The cascade" section)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)

**Interfaces:** none (docs only). NOTE: `docs/SCORER.md` and `services/scorer/README.md` carry uncommitted on-topic edits from the same work session (Haiku-off clarifications) — they ride along in this commit. `CLAUDE.md` is also modified but UNRELATED — do not stage it.

- [ ] **Step 1: docs/SCORER.md — record the signals in the cascade section**

Replace the sentence `Every assessment records one \`moderation_analyses\`\nrow (the admin queue).` (in the paragraph after the gray-zone bullets) with:

```markdown
Every assessment records one `moderation_analyses`
row (the admin queue) — stamped with both **raw classifier signals** (`toxicity_score` = P(toxic),
`relationship_score` = the signed sentiment quality), on every verdict **including `allow`**, so a
human reviewer sees what the models measured and future threshold ideas can be validated against
real traffic instead of guesses.
```

- [ ] **Step 2: docs/SCORER.md — add the future-addition subsection**

Immediately before the `## The relationship graph` heading, insert:

```markdown
### Future addition (documented, NOT implemented): disagreement routing

When `P(toxic) ≥ grayzone_high` **but** the relationship score is strongly positive, the two models
disagree — a pattern typical of sarcasm, quoted lyrics, or in-group banter. A future gate could route
that combination to `review` (the human queue) instead of auto-blocking. What makes it acceptable to
consider: it only ever moves content **toward** humans (fail-closed — it can never cause a removal),
and the "strongly positive" threshold must be validated against the accumulated analysis rows (which
now record both signals on every verdict, `allow` included) — not guessed. The relationship score is
deliberately NOT a moderation gate today: sentiment ≠ toxicity (grief/venting read negative but are
fine; polite harassment reads positive but isn't). See `services/scorer/README.md` → "The cascade".
```

- [ ] **Step 3: services/scorer/README.md — one line in "The cascade"**

After the paragraph explaining that only the toxicity model gates moderation (ends with "...one gate + one graph signal, not two moderation votes."), append to that paragraph:

```markdown
Both raw signals are recorded on every `moderation_analyses` row (`toxicity_score`,
`relationship_score`) — context for the human queue, and the dataset for validating future threshold
ideas (see `docs/SCORER.md` → "disagreement routing").
```

- [ ] **Step 4: CHANGELOG.md**

Under `## [Unreleased]`, add an `### Added` section above the existing `### Changed` (or extend `### Added` if one exists by then):

```markdown
### Added
- **Raw classifier signals on moderation analyses.** Every scorer assessment now records the two
  RoBERTa outputs on its `moderation_analyses` row — `toxicity_score` (P(toxic), 0..1) and
  `relationship_score` (signed sentiment, −1..1) — on every verdict including `allow`, and the admin
  AI-flag dialog shows them to human reviewers (migration `0056`, additive contract fields on
  `ModerationAnalysis`). Audit context only — no decision-logic change; the "disagreement routing"
  idea is documented as a future addition in `docs/SCORER.md`.
```

- [ ] **Step 5: Commit (explicit paths — CLAUDE.md must NOT be staged)**

```bash
git add docs/SCORER.md services/scorer/README.md CHANGELOG.md
git commit -s -m "docs(scorer): document recorded raw signals + disagreement-routing future

Also lands the pending cascade/Haiku-off clarifications in SCORER.md and
the scorer README from the same session.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full TS gate**

```bash
pnpm --filter @agora-server/contract build && pnpm -r typecheck && pnpm test
```

Expected: all PASS.

- [ ] **Step 2: Full scorer gate**

```bash
cd services/scorer && . .venv/bin/activate
ANTHROPIC_API_KEY="" pytest && ruff check . && mypy scorer
```

Expected: all PASS.

- [ ] **Step 3: Live write-path smoke (optional but recommended if the dev stack is up)**

With the dev DB migrated (Task 1) and the scorer worker + model servers running: post a comment through the API, then:

```bash
cd apps/api && url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
psql "$url" -c "select verdict, toxicity_score, relationship_score from moderation_analyses order by created_at desc limit 3;"
```

Expected: newest rows show non-NULL `toxicity_score` and `relationship_score`.
