---
name: propagate
description: Use when a feature branch is done (or the user asks to sync docs/config) to propagate the branch's changes into every mirror — .env examples, compose files, docs/, wiki/, CHANGELOG. Checker-driven agent fan-out; propose-then-approve (drafts edits in the working tree, never commits).
---

# /propagate — diff-driven doc & config propagation

Design: `docs/superpowers/specs/2026-07-03-propagate-doc-sync-design.md`.
Map (what mirrors what): `docs/PROPAGATION.yaml`.
Checker: `pnpm --filter @agora/api check:propagation --diff <base> --json`.

**Prime directive: propose-then-approve.** Draft every edit in the working tree, present a
checklist, then STOP. Never commit, never push. The user reviews and commits.

## Flow

### 1. Establish the base
Use an explicit ref if the user gave one as an argument; otherwise `git merge-base HEAD root`.
If the merge-base equals HEAD (working directly on root), fall back to `HEAD` — the diff is
then just uncommitted work. All diffing includes uncommitted changes.

### 2. Scout (deterministic)
Run the checker and parse its JSON:
```bash
pnpm --filter @agora/api check:propagation --diff <base> --json
```
`obligations[]` rows are `{ cls, subject, kind, target, status, note? }`. Work only the
`missing` ones; carry `advisory` rows forward as judgment items; report `unparseable` rows
verbatim in the final checklist (never swallow them). `excepted`/`present` need no work.

### 3. Judgment sweep (one agent, read-only)
Dispatch ONE agent with the full diff (`git diff <base>` + untracked files) and the list of
mapped targets. Its job — it EDITS NOTHING, it returns data:
- Which prose docs beyond the mapped targets are affected? (It should list `docs/` and
  `wiki/` filenames and skim candidates before answering.)
- Draft the CHANGELOG `[Unreleased]` entry (Keep a Changelog sections: Added/Changed/Fixed/Removed).
- For each `advisory` obligation from the scout: is it real work or ignorable, and why?

### 4. Fan out drafting agents (parallel, one file : one agent)
Partition by audience cluster so each agent tells one coherent story across related docs.
**No two agents may touch the same file.** Standard clusters (skip any with no work; add
clusters for sweep-discovered targets):
- **mechanical** — `.env.*.example` ×3 + `docker-compose*.yml` ×3. Rote edits: match each
  template's comment style and the LOCAL/CLOUD commented-switch convention; compose entries
  use `KEY: ${KEY:-default}` with a brief comment, mirroring existing entries.
- **deployment prose** — `docs/SELF-HOSTING.md` + `README.md` + `wiki/Deployment.md`
  (+ `CLAUDE.md` when env/commands/architecture summaries are affected).
- **API contract prose** — `docs/MANIFEST.md` + `docs/MODELS.md` + `wiki/API-Contract.md`.
- **CHANGELOG** — apply the sweep's drafted entry under `[Unreleased]`.

Every drafting agent gets: the relevant diff hunks, its obligation rows, the instruction to
match each doc's existing voice/structure/heading style, and the hard rule: **if you cannot
find a sensible home for content, REPORT it back — do not invent new doc sections.**

### 5. Verify (deterministic again)
Re-run the checker. Every remaining `missing`/`unparseable` row must be explained in the
checklist (candidate for `exceptions:` in `docs/PROPAGATION.yaml`, or a real gap the user
must rule on). Then one critic agent, read-only: "Given this diff and these edits, what's
still missing — a doc not updated, a removal not scrubbed, a stale wiki page?"

### 6. Report and stop
Present:
- ✅ propagated (subject → files)
- ⏭️ excepted (with reasons)
- ⚠️ intentionally skipped? (unresolved obligations — offer to add recurring ones to
  `exceptions:` in `docs/PROPAGATION.yaml`)
- ❓ needs your judgment (advisory + anything agents reported instead of guessing)
- 💥 unparseable (checker could not read/parse a mapped target — fix the map or the file)
- `git diff --stat` of the working tree
Then STOP. The user reviews and commits.
