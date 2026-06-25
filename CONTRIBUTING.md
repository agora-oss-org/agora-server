# Contributing to Agora

Thanks for being here — Agora is an open, self-hosted, Replyke-compatible social backend, and it
gets better with more hands. 💜 This guide covers how to set up, the rules that keep the project
coherent, and how to land a change. Whether you're fixing a typo or adding a domain, you're welcome.

Everyone is welcome regardless of background or experience level. Be kind, assume good faith, and
keep feedback about the work, not the person.

---

## Ways to contribute

- **Bug fixes** — especially SDK-contract mismatches (see [The contract is the constraint](#the-contract-is-the-constraint)).
- **Features** — admin-app slices, new endpoints that fill a Replyke gap, ops tooling.
- **Tests** — unit and integration coverage are always welcome.
- **Docs** — README, `docs/MANIFEST.md`, `docs/MODELS.md`, code comments, this file, and the
  [wiki](https://github.com/agora-oss-org/agora-server/wiki) (authored in `wiki/` — see below).
- **Triage** — reproducing issues, narrowing repros, confirming fixes.

Not sure where to start? Check the [open issues](https://github.com/jenova-marie/agora-server/issues)
and the **Status** backlog in the [README](README.md#status).

---

## The ecosystem (which repo gets your change?)

Agora is **three separate repos** on purpose:

| Repo | What it is | File changes here when… |
|---|---|---|
| **[`agora-server`](https://github.com/jenova-marie/agora-server)** (this repo) | the backend + admin app | the API, schema, business logic, or admin UI is involved |
| **[`agora-sdk`](https://github.com/jenova-marie/agora-sdk)** | the forked, repointed Replyke SDK (`@agora-sdk/*`) | the client hooks/types need to change |
| **[`agora-demo`](https://github.com/jenova-marie/agora-demo)** | the 1:1 compatibility harness + live demo | you're adding a surface to exercise the SDK against a server |

If a server change requires an SDK change to stay compatible, that usually means the **contract**
shifted — stop and reconsider (see below). The SDK and demo are arms-length consumers by design.

---

## The contract is the constraint

Agora exists so the forked Replyke SDK's typed hooks work **unchanged**. That makes the API contract
non-negotiable:

- **[`docs/MANIFEST.md`](docs/MANIFEST.md)** — every REST endpoint (method + path), socket.io event
  names, and the auth / pagination / error envelopes.
- **[`docs/MODELS.md`](docs/MODELS.md)** — field-level response shapes.

**Before changing any request/response shape, REST path, or socket event:** confirm it against these
docs, and update them in the same PR if the contract legitimately changes. A change that breaks the
SDK's hooks is a regression, not a feature. Shared request/response types and zod schemas live in
**`packages/contract`** (`@agora-server/contract`) — never redefine a contract type locally.

---

## Dev setup

Prerequisites: **Node 22**, **corepack** (ships with Node), and a **Supabase project** (free tier is
fine) for `DATABASE_URL`.

```bash
corepack enable                 # activates the pinned pnpm@10.14.0
pnpm install                    # all workspaces, from the repo root
pnpm -r build                   # build every package (contract first, topologically)

cd apps/api
cp .env.example .env            # fill in DATABASE_URL (required); see README → Configuration
pnpm db:migrate                 # apply migrations (idempotent; safe to re-run)
pnpm dev                        # http://localhost:4000/v7   (GET /health to verify)
```

Admin app: `cd apps/admin && pnpm dev` (`:5173`; set `VITE_API_BASE_URL`). Demo harness lives in the
separate `agora-demo` repo.

> ⚠️ `@agora/api` consumes `@agora-server/contract`'s built `dist/`. From a clean checkout, run
> `pnpm --filter @agora-server/contract build` (or `pnpm -r build`) before typechecking the API.

---

## Project layout

See the [README → Layout](README.md#layout) for the full tree. The essentials:

- `apps/api` — `@agora/api`, the Hono backend. `routes/entities.ts` is the reference domain router.
- `apps/admin` — `@agora/admin`, the Vite + React + Tailwind admin frontend.
- `packages/contract` — `@agora-server/contract`, shared types + zod schemas (no hono/drizzle).
- `apps/api/src/db/schema/*.ts` — Drizzle schema, the single source of truth for the DB.
- `apps/api/drizzle/` — SQL migrations (generated + hand-written custom).

---

## Coding conventions

Match the surrounding code's style — comment density, naming, idiom. Beyond that:

**API handlers**
- **URL shape is fixed:** `/v7/:projectId/<domain>/...`. In a domain router, static routes
  (`/by-username`, `/root`, …) MUST be declared **above** `/:id` or Hono captures them.
- **Envelopes are contract.** Lists → `{ data, pagination }` via `paginate()`/`readPagination()`.
  Errors → throw `Errors.*` (→ `{ error, code, field? }`), never bare strings.
- **Shape every row** through `lib/shape.ts` (camelCase, Date→ISO, derived fields) — never return
  raw Drizzle rows.
- **Validate input** with the zod schemas via `parseBody()` (schemas live in `@agora-server/contract`).

**Data**
- **Drizzle owns all DB access** via the direct `postgres.js` connection. `@supabase/supabase-js`
  is reserved for Auth + Storage only (lazy `getSupabase()`).
- **Denormalized counts are trigger-maintained** — never recompute them per request.
- **Reactions** go through the `toggle_reaction` RPC with explicit casts.

**Security (the trust boundary is the server)**
- Enforce ownership / role / visibility checks **in the handlers** — RLS is defense-in-depth, not the
  gate (the server connects RLS-bypassing). Reuse the helpers in `lib/space-access.ts` and
  `lib/moderation-visibility.ts` rather than re-implementing read/write gating. See
  [README → Security](README.md#security--access-control).
- Reads of **public** content are intentionally anonymous (matches Replyke); every mutation is
  `requireAuth`.

**Realtime & logging**
- socket.io event names must stay byte-identical to the SDK's `socket.ts`.
- Use the shared `logger` (`lib/logger.ts`), never `console.*`. **Pino arg order is data-first:**
  `logger.error({ err }, "msg")` — a message-first call silently drops the data object.

**Always run before considering work done:**

```bash
pnpm -r typecheck     # or: pnpm --filter @agora/api typecheck
pnpm test             # unit tests
```

---

## Database changes

Schema lives in `apps/api/src/db/schema/*.ts` (the source of truth).

1. Edit the schema, then `pnpm db:generate` → a new migration in `apps/api/drizzle/`.
2. `pnpm db:migrate` to apply.
3. Anything Drizzle can't express (triggers, RPC, RLS, PostGIS) is a **hand-written custom
   migration**, written **idempotently** (`create or replace`, `drop … if exists`, `create extension
   if not exists`) so re-runs are safe, and registered in `drizzle/meta/_journal.json` in order.

Don't squash or rewrite existing migrations — they're applied in journal order on every deployment.

---

## Testing

[Vitest](https://vitest.dev), two tiers:

- **Unit** (`src/**/*.test.ts`) — pure logic, no DB. `pnpm test`.
- **Integration** (`test/integration/**`) — runs against a real **dedicated** cloud Postgres via
  `TEST_DATABASE_URL` (never your dev DB), driving the app in-process. `pnpm test:integration`.

New behavior should come with tests where practical. Bug fixes should add a regression test.

---

## Changelog

`CHANGELOG.md` (repo root) follows [Keep a Changelog](https://keepachangelog.com). **Any change that
affects behavior, the API contract, the schema/migrations, deployment, or tooling gets an entry
under `## [Unreleased]`** in the right section (`Added` / `Changed` / `Fixed` / `Removed`). Pure
internal refactors with no observable effect don't need one.

---

## Editing the wiki

The [GitHub wiki](https://github.com/agora-oss-org/agora-server/wiki) is a curated handbook that
summarizes the project and links into the deep `docs/*.md` files. Its **source lives in this repo under
`wiki/`** — edit those markdown pages via a normal PR. On merge to `root`, the `wiki-sync` workflow
(`.github/workflows/wiki-sync.yml`) publishes them to the wiki repo automatically.

**Don't edit the published wiki directly** — the next sync overwrites anything changed there. New pages
go in `wiki/` as `Page-Name.md` (the filename is the page title; `_Sidebar.md`/`_Footer.md` are the nav
chrome). Because the wiki is a separate repo, links into source must be absolute GitHub URLs
(`https://github.com/agora-oss-org/agora-server/blob/root/docs/…`); link between wiki pages with
`[[Page Name]]`.

---

## Commits & pull requests

**Commits** use [Conventional Commits](https://www.conventionalcommits.org) with an emoji prefix,
matching the existing history:

```
✨ feat(api): add moderation-removal visibility setting
🐛 fix(admin): keep webhook secret on save
📝 docs: document the auth model
♻️ refactor(api): extract space-access helpers
🧪 test(api): cover private-space read gating
🔒 security(api): enforce postingPermission on create
```

Common types: `feat` ✨ · `fix` 🐛 · `docs` 📝 · `refactor` ♻️ · `test` 🧪 · `chore` 🏗️ ·
`security` 🔒 · `perf` 🔥 · `deps` 📦. Scope is optional but encouraged (`api`, `admin`, `contract`,
`docker`, …). Keep the subject imperative and under ~72 chars; explain the *why* in the body.

**Pull requests:**

1. Branch off `root` (the default branch).
2. Keep each PR to one logical change — smaller is easier to review.
3. Make sure `pnpm -r typecheck` and `pnpm test` pass.
4. Update `CHANGELOG.md`, and `docs/MANIFEST.md` / `docs/MODELS.md` if the contract changed.
5. **Sign off every commit** (`git commit -s`) — DCO, no CLA. See [Licensing](#licensing).
6. Describe what changed and why; link any related issue.

We'll review as promptly as we can. Thanks for helping build the open social layer. 🌸

---

## Licensing

Agora's server is **[AGPL-3.0-only](LICENSE)** — `@agora/api`, `@agora/admin`, and the `services/*`
workers (e.g. `services/scorer`). The shared wire contract, [`@agora-server/contract`](packages/contract),
stays **Apache-2.0** so the [`agora-sdk`](https://github.com/jenova-marie/agora-sdk) and third-party
clients can build against it freely. **The community edition is AGPL-3.0 and always will be** — that's
a promise, not a placeholder.

### No CLA — we use the DCO

There is **no Contributor License Agreement**. We don't ask you to assign or relicense your copyright,
and the project *can't* quietly go closed-source later: your contributions stay yours, licensed
AGPL-3.0. Instead we use the lightweight **[Developer Certificate of Origin](https://developercertificate.org/)** —
a one-line attestation that you wrote the patch (or otherwise have the right to submit it) under the
project's license.

Sign off every commit:

```
git commit -s -m "✨ feat(api): ..."
```

That appends a `Signed-off-by: Your Name <you@example.com>` trailer from your git `user.name` /
`user.email`. Forgot one? `git commit --amend -s` for the last commit, or `git rebase --signoff root`
for a whole branch. CI checks that every commit in a PR is signed off.

### A note for operators (AGPL §13)

If you run Agora as a network service, the AGPL requires you to offer your users the *corresponding
source* of the version you're running. Agora ships a source link by default — if you modify Agora,
keep that link pointing at your fork.
