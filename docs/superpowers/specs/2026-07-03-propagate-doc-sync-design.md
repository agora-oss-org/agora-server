# `/propagate` — diff-driven doc & config propagation — design

**Date:** 2026-07-03
**Status:** approved design, pre-implementation

## Problem

A single behavioral change fans out into many mirrors. Adding one env var
(`CONTENT_DELETE_MODE`, the motivating case) touched 14 files: three
`.env.*.example` templates, three `docker-compose*.yml` files,
`packages/core/src/lib/env.ts`, `CHANGELOG.md`, and several prose docs. The
repo has ~30 docs in `docs/` plus the in-repo wiki (`wiki/`, mirrored to the
GitHub wiki by `.github/workflows/wiki-sync.yml` on merge). Keeping mirrors in
sync is manual, error-prone, and frequently forgotten.

## Goals

- On demand (a slash-command skill, run when a feature is done), detect every
  propagation obligation arising from the current branch's diff and draft the
  edits — **propose-then-approve**: nothing is committed without user review.
- Cover four change classes: env vars/config, API contract changes,
  compose/deploy changes, and a catch-all "any behavior-affecting change"
  (which also drafts the CHANGELOG entry).
- Deterministic completeness: a script, not an agent, decides whether every
  obligation was met.

## Non-goals (v1)

- No codegen of `.env.*.example` or compose files — they stay hand-curated
  (the commented LOCAL/CLOUD switch blocks are editorial content).
- No CI enforcement yet (the checker's full-scan mode enables it later, after
  the exceptions block matures).
- No auto-commit, no wiki publishing (wiki-sync already publishes on merge).

## Architecture

```
/propagate (repo skill, .claude/skills/propagate/SKILL.md)
   │  1. diff branch vs merge-base (incl. uncommitted changes)
   │  2. scout: deterministic work-list
   ▼
check-propagation CLI  ←──  propagation map (docs/PROPAGATION.yaml)
   │  JSON "obligations" (var X missing from file Y, endpoint Z not in MANIFEST, …)
   ▼
agent fan-out (parallel, partitioned by audience cluster — one file : one agent)
   ▼
verify: re-run checker (must be clean or explained) + completeness-critic agent
   ▼
checklist + working-tree diff → user reviews → user commits
```

Separation of duties: the **map** is the source of truth for *what mirrors
what*; the **checker** is the source of truth for *what is owed and whether it
was delivered*; **agents** only draft prose — they never self-certify
completeness.

## Components

### 1. Propagation map — `docs/PROPAGATION.yaml`

Checked-in, human-readable. Lives in `docs/` (not `.claude/`) because it is
repo knowledge — "what do I update when I add an env var" — useful to human
contributors, same posture as MANIFEST/MODELS. Shape:

```yaml
env-var:
  detect: [packages/core/src/lib/env.ts, apps/*/src/lib/env*.ts]
  mechanical: [.env.dev.example, .env.selfhost.example, .env.prod.example,
               docker-compose.dev.yml, docker-compose.yml, docker-compose.prod.yml]
  prose: [docs/SELF-HOSTING.md, README.md, CLAUDE.md, wiki/Deployment.md]
endpoint:
  detect: [apps/api/src/routes/**, apps/secure-chat/src/routes/**]
  prose: [docs/MANIFEST.md, docs/MODELS.md, wiki/API-Contract.md]
compose:
  detect: [docker-compose*.yml, deploy/**]
  prose: [docs/SELF-HOSTING.md, README.md, wiki/Deployment.md]
catch-all:
  prose: [CHANGELOG.md]   # + agent judgment sweep over docs/ + wiki/
exceptions: []            # grows over time; see Obligations are advisory
```

**Obligations are advisory.** Not every var belongs in every target (secrets
get no compose default; dev-only vars skip prod). Rather than pre-encoding
every exception, the final checklist marks unresolved obligations
"intentionally skipped?" for the user to rule on; recurring rulings get
recorded in `exceptions:` so they stop resurfacing.

### 2. Checker — pure lib + thin CLI

- Pure, unit-testable functions in `apps/api/src/lib/propagation/`:
  - parse env keys from the zod schema in `packages/core/src/lib/env.ts`
    (and app-local env files per the map's `detect` globs)
  - parse `KEY=` / `# KEY=` lines from `.env.*.example`
  - parse `environment:` blocks from compose files
  - extract route registrations from `routes/**` and match method+path
    against `docs/MANIFEST.md` entries
  - diff-scoped obligation derivation + removal/rename detection (a var
    deleted from `env.ts` that still appears anywhere mapped is drift too)
- Thin CLI at `apps/api/scripts/check-propagation.mjs` with two modes:
  - `--diff <base>`: obligations arising from the branch diff only (what
    `/propagate` consumes; also reads uncommitted changes)
  - full scan (no flag): whole-repo drift audit — CI-ready later
- Output: JSON obligations for the skill + a human-readable table.
- Parse failures are loud in the report; a target that cannot be parsed is
  never silently dropped.

Home is `apps/api` (not a new root `tools/` package): zero new workspace
plumbing, the existing vitest unit suite picks up its tests, and it follows
the `scripts/diag/` precedent for repo-level tooling living in the reference
app. Extract to `tools/` only if a second repo-level tool appears. Ensure the
lib is excluded from (or harmless in) the api runtime build.

### 3. Skill — `.claude/skills/propagate/SKILL.md`

Flow:

1. Determine base: explicit arg, else merge-base with `root`. Diff includes
   uncommitted working-tree changes.
2. Run `check-propagation --diff` → mechanical + mapped-prose obligations.
3. **Judgment sweep**: one agent reads the full diff, flags affected docs
   beyond the map (the catch-all class), and drafts the CHANGELOG entry per
   Keep a Changelog.
4. Fan out parallel agents, **partitioned by audience cluster** — one file
   belongs to exactly one agent, so parallel edits never conflict:
   - *mechanical* (one agent): env examples + compose blocks — rote edits
   - *deployment prose*: `docs/SELF-HOSTING.md` + `README.md` +
     `wiki/Deployment.md` (+ `CLAUDE.md` when env-related)
   - *API contract prose*: `docs/MANIFEST.md` + `docs/MODELS.md` +
     `wiki/API-Contract.md`
   - *CHANGELOG* (from the judgment sweep)
   - additional clusters as the judgment sweep discovers targets
   Rationale: per-cluster beats per-file because one agent tells one coherent
   story across related docs (consistent wording between SELF-HOSTING and the
   wiki); it beats a single agent on parallelism and context quality.
   Agents match each doc's existing voice/structure; an agent that cannot
   find a sensible home for content **reports instead of guessing** — no
   invented doc sections.
5. Verify: re-run the checker (must return clean or each residual obligation
   explained), plus a completeness-critic agent ("what did the sweep miss —
   doc not updated, removal not scrubbed, wiki page stale?").
6. Final report: ✅ done / ⚠️ intentionally skipped? / ❓ needs-your-judgment
   checklist + `git diff --stat`. The user reviews and commits.

## Error handling

- Checker parse failure on any mapped target → loud entry in the report,
  obligation retained as unresolved.
- Agent failure/timeout → its cluster's obligations stay open; the verify
  pass surfaces them; the skill reports rather than retries indefinitely.
- Ambiguous placement (agent can't find where content belongs) → reported as
  ❓ needs-your-judgment, never guessed.

## Testing

- Checker functions ship with vitest unit tests **in the same change**
  (`src/lib/propagation/*.test.ts`): env-schema key extraction, example/compose
  parsing, obligation derivation incl. removals, exception handling — the
  pure/branching logic the engineering principles mandate testing.
- First live validation: run `/propagate` on the current branch (the
  uncommitted auth/email `redirectTo` work is a real-world test case) and
  review its checklist against hand-derived expectations.

## Future (explicitly deferred)

- CI drift guard using the checker's full-scan mode.
- Codegen of mechanical mirrors from a single env manifest (approach B),
  should the hand-curated templates ever become a maintenance burden.
