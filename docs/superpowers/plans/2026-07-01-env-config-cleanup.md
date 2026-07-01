# Env & Compose Configuration Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unmanaged pile of env files with three complete, correct, per-mode templates (`dev`/`selfhost`/`prod`), add a marker + guardrail so destructive DB scripts can't silently wipe a cloud database, and make the self-host path actually boot end-to-end.

**Architecture:** Option A from the design doc — one complete `.env.<mode>.example` per first-class configuration, selected by `cp`. A pure `isLocalTarget()` helper (unit-tested) drives a confirmation guardrail wired into `drop.mjs`/`genesis.mjs`. Docs collapse to a single per-mode table. A validation task boots the self-host stack and fixes whatever blocks it.

**Tech Stack:** Node ESM scripts (`.mjs`), vitest (unit), Docker Compose, Postgres, MinIO.

## Global Constraints

- Source of truth for what each template contains: the variable matrix in `docs/superpowers/specs/2026-07-01-env-config-design.md` §4. Copy values verbatim from that matrix.
- Secrets in templates are **placeholders only** (`<GENERATE: …>` / `<your.domain>`) — never real values.
- Scripts are plain Node ESM (`.mjs`) run via `node scripts/*.mjs` (no build step) — they may only import `.mjs`/`.js`, never `.ts`.
- Pino/logging, env-schema, and app code are **not** touched — the app already strips unknown env keys (`z.object(...).parse`), so `AGORA_ENV` needs no schema change.
- `pnpm -r typecheck` and `pnpm test` must pass before the work is considered done.
- Three first-class configs (verbatim): **dev** = `docker-compose.dev.yml` + `--profile supabase` (host app + cloud); **selfhost** = `docker-compose.yml` + `--profile selfhost` (container-from-source + local); **prod** = `docker-compose.prod.yml` + `--profile supabase` (pulled image + cloud).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `apps/api/scripts/lib/db-target.mjs` | Create | Pure helpers: `dbTargetHost(url)`, `isLocalTarget({agoraEnv, databaseUrl})` |
| `apps/api/scripts/lib/db-target.test.mjs` | Create | Unit tests for the two helpers |
| `apps/api/vitest.config.ts` | Modify | Add `scripts/**/*.test.mjs` to the unit `include` |
| `apps/api/scripts/drop.mjs` | Modify | Use `isLocalTarget` + `--force-cloud` in the confirm gate; print marker/target kind |
| `apps/api/scripts/genesis.mjs` | Modify | Forward `--force-cloud`; `--test` implies it |
| `.env.dev.example` | Create | Config #1 template (host + cloud) |
| `.env.selfhost.example` | Rename from `.env.local.example` | Config #4 template (container + local) |
| `.env.prod.example` | Create | Config #5 template (container + cloud) |
| `.env.example` | Delete | Misleading 15-var stub |
| `apps/api/.env.example` | Delete | Stale Supabase direct-connection shape |
| `.gitignore` | Modify | Track any `.env.*.example` via one pattern |
| `README.md`, `docs/SELF-HOSTING.md`, `docs/DEVELOPMENT.md`, `docs/CHEAT-SHEET.md`, `apps/api/README.md` | Modify | Per-mode configuration table; drop stale example references |
| `docker-compose*.yml` (header comments) | Modify | Point at the per-mode templates, drop the `.env.local` copy dance |

---

### Task 1: Destructive-target guardrail — pure logic (TDD)

**Files:**
- Create: `apps/api/scripts/lib/db-target.mjs`
- Test: `apps/api/scripts/lib/db-target.test.mjs`
- Modify: `apps/api/vitest.config.ts` (unit `include`)

**Interfaces:**
- Produces:
  - `dbTargetHost(url: string): string | null` — the hostname of a Postgres URL (`null` if unparseable).
  - `isLocalTarget({ agoraEnv?: string, databaseUrl?: string }): boolean` — `true` when `agoraEnv === "selfhost"` OR the DB hostname ∈ `{db, localhost, 127.0.0.1}`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/scripts/lib/db-target.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { dbTargetHost, isLocalTarget } from "./db-target.mjs";

describe("dbTargetHost", () => {
  it("extracts the hostname (ignoring port/user/pw)", () => {
    expect(dbTargetHost("postgres://postgres:pw@db:5432/postgres")).toBe("db");
    expect(dbTargetHost("postgresql://postgres.ref:pw@aws-1-us-west-2.pooler.supabase.com:6543/postgres"))
      .toBe("aws-1-us-west-2.pooler.supabase.com");
  });
  it("returns null for an unparseable url", () => {
    expect(dbTargetHost("not a url")).toBeNull();
    expect(dbTargetHost(undefined)).toBeNull();
  });
});

describe("isLocalTarget", () => {
  it("is true when AGORA_ENV=selfhost regardless of host", () => {
    expect(isLocalTarget({ agoraEnv: "selfhost", databaseUrl: "postgresql://x:y@cloud.example.com:6543/postgres" })).toBe(true);
  });
  it("is true for db / localhost / 127.0.0.1 hosts", () => {
    expect(isLocalTarget({ databaseUrl: "postgres://postgres:pw@db:5432/postgres" })).toBe(true);
    expect(isLocalTarget({ databaseUrl: "postgres://postgres:pw@localhost:5432/postgres" })).toBe(true);
    expect(isLocalTarget({ databaseUrl: "postgres://postgres:pw@127.0.0.1:5432/postgres" })).toBe(true);
  });
  it("is false for a cloud pooler host with no selfhost marker", () => {
    expect(isLocalTarget({ agoraEnv: "prod", databaseUrl: "postgresql://postgres.ref:pw@aws-1-us-west-2.pooler.supabase.com:6543/postgres" })).toBe(false);
    expect(isLocalTarget({ agoraEnv: "dev", databaseUrl: "postgresql://postgres.ref:pw@aws-1-us-west-2.pooler.supabase.com:6543/postgres" })).toBe(false);
  });
  it("is false (fail-safe toward confirmation) when the url is unparseable and no marker", () => {
    expect(isLocalTarget({ databaseUrl: "garbage" })).toBe(false);
    expect(isLocalTarget({})).toBe(false);
  });
});
```

- [ ] **Step 2: Add the scripts glob to the unit test include**

In `apps/api/vitest.config.ts`, change the `include` line:

```ts
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run scripts/lib/db-target.test.mjs`
Expected: FAIL — `Failed to load url ./db-target.mjs` (module doesn't exist yet).

- [ ] **Step 4: Write the minimal implementation**

Create `apps/api/scripts/lib/db-target.mjs`:

```js
// Pure helpers shared by the destructive DB scripts (drop.mjs / genesis.mjs) to classify a target and
// decide how strong a confirmation to require. A "local" target (the selfhost `db` container, or a
// localhost Postgres) is safe to --force; anything else is treated as a cloud/shared DB that must not
// be wiped without an explicit, louder opt-in. Fail-safe: an unknown/unparseable host is NOT local.

/** Hostname of a Postgres connection URL, or null if it can't be parsed. */
export function dbTargetHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(["db", "localhost", "127.0.0.1"]);

/** True when the target is the local selfhost DB (safe to --force), false otherwise (require louder confirm). */
export function isLocalTarget({ agoraEnv, databaseUrl } = {}) {
  if (agoraEnv === "selfhost") return true;
  const host = dbTargetHost(databaseUrl);
  return host !== null && LOCAL_HOSTS.has(host);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run scripts/lib/db-target.test.mjs`
Expected: PASS (8 assertions across 6 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/lib/db-target.mjs apps/api/scripts/lib/db-target.test.mjs apps/api/vitest.config.ts
git commit -m "feat(scripts): add isLocalTarget guardrail helper for destructive DB scripts"
```

---

### Task 2: Wire the guardrail into `drop.mjs` and `genesis.mjs`

**Files:**
- Modify: `apps/api/scripts/drop.mjs` (imports, header comment ~26-30, target print block ~53-58, confirm gate ~82-89)
- Modify: `apps/api/scripts/genesis.mjs` (arg parsing ~24-26, `dropArgs` ~40)

**Interfaces:**
- Consumes: `isLocalTarget` from Task 1 (`./lib/db-target.mjs`).

- [ ] **Step 1: Import the helper in `drop.mjs`**

In `apps/api/scripts/drop.mjs`, add after the existing imports (after line 35):

```js
import { isLocalTarget } from "./lib/db-target.mjs";
```

- [ ] **Step 2: Parse `--force-cloud` and classify the target**

In `apps/api/scripts/drop.mjs`, replace the `FORCE` line (currently line 40):

```js
const FORCE = args.has("--force");
```

with:

```js
const FORCE = args.has("--force");
const FORCE_CLOUD = args.has("--force-cloud");
const LOCAL = isLocalTarget({ agoraEnv: process.env.AGORA_ENV, databaseUrl: process.env.DATABASE_URL });
```

- [ ] **Step 3: Surface the marker + target kind in the header**

In `apps/api/scripts/drop.mjs`, in the `console.log` block that prints the target (currently lines 53-58), add two lines before the trailing blank `console.log("")`:

```js
  console.log(`   AGORA_ENV    : ${process.env.AGORA_ENV ?? "(unset)"}`);
  console.log(`   Target kind  : ${LOCAL ? "LOCAL (safe to --force)" : "CLOUD/REMOTE (needs --force-cloud)"}`);
```

- [ ] **Step 4: Replace the confirmation gate**

In `apps/api/scripts/drop.mjs`, replace the whole confirmation-gate block (currently lines 82-89):

```js
  if (!FORCE && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Type the project ref "${ref}" to confirm IRREVERSIBLE drop: `);
    rl.close();
    if (answer.trim() !== ref) die("Confirmation did not match — aborted. Nothing was dropped.");
  } else if (!FORCE) {
    die("Refusing non-interactive drop without --force. Re-run with --yes --force.");
  }
```

with:

```js
  // A LOCAL target (selfhost db / localhost) may be forced with --force. A CLOUD/REMOTE target must
  // NOT be wiped on a bare --force — require the interactive typed-ref confirm, or an explicit
  // --force-cloud for known-disposable cloud DBs (e.g. the test project). This closes the
  // "genesis --force against a cloud .env" footgun.
  const bypass = LOCAL ? (FORCE || FORCE_CLOUD) : FORCE_CLOUD;
  if (!bypass && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Type the project ref "${ref}" to confirm IRREVERSIBLE drop: `);
    rl.close();
    if (answer.trim() !== ref) die("Confirmation did not match — aborted. Nothing was dropped.");
  } else if (!bypass) {
    die(LOCAL
      ? "Refusing non-interactive drop without --force. Re-run with --yes --force."
      : `Refusing to drop a CLOUD/REMOTE target (${dbHost}, AGORA_ENV=${process.env.AGORA_ENV ?? "unset"}) on --force alone. `
        + "Use the interactive typed-ref confirm, or --force-cloud if this DB is disposable (e.g. a test project).");
  }
```

- [ ] **Step 5: Update the `drop.mjs` usage comment**

In `apps/api/scripts/drop.mjs`, replace the usage block (currently lines 26-30) with:

```js
// Usage:
//   node scripts/drop.mjs                  # dry run (safe) — lists objects that would be dropped
//   node scripts/drop.mjs --yes            # drop schema (interactive typed-ref confirm)
//   node scripts/drop.mjs --yes --force    # non-interactive — LOCAL targets only (selfhost db/localhost)
//   node scripts/drop.mjs --yes --force-cloud  # non-interactive against a disposable CLOUD DB (e.g. test)
//   node scripts/drop.mjs --yes --migrate  # drop, then immediately rebuild from migrations
```

- [ ] **Step 6: Forward the cloud bypass from `genesis.mjs`**

In `apps/api/scripts/genesis.mjs`, replace the arg-parsing block (currently lines 24-26):

```js
const args = new Set(process.argv.slice(2));
const isTest = args.has("--test");
const force = args.has("--force") || args.has("-f");
```

with:

```js
const args = new Set(process.argv.slice(2));
const isTest = args.has("--test");
const force = args.has("--force") || args.has("-f");
// --test targets the dedicated, disposable TEST_DATABASE_URL (a cloud test project), so treat it as an
// explicit opt-in to the cloud bypass; otherwise forward --force-cloud only when the caller passed it.
const forceCloud = args.has("--force-cloud") || isTest;
```

- [ ] **Step 7: Pass `--force-cloud` into the delegated drop**

In `apps/api/scripts/genesis.mjs`, replace the `dropArgs` line (currently line 40):

```js
const dropArgs = ["--yes", "--migrate", ...(force ? ["--force"] : [])];
```

with:

```js
const dropArgs = ["--yes", "--migrate", ...(force ? ["--force"] : []), ...(forceCloud ? ["--force-cloud"] : [])];
```

- [ ] **Step 8: Manually verify the guardrail (dry runs, no writes)**

Run each and confirm the printed behavior (these do NOT drop — they hit the confirm gate or dry-run):

```bash
cd apps/api
# 1. Cloud target + --force → REFUSED (pipe empty stdin so it's non-interactive):
AGORA_ENV=dev DATABASE_URL='postgresql://postgres.ref:pw@aws-1-us-west-2.pooler.supabase.com:6543/postgres' \
  node scripts/drop.mjs --yes --force < /dev/null; echo "exit=$?"
# Expected: prints "Target kind : CLOUD/REMOTE", then "✗ Refusing to drop a CLOUD/REMOTE target …", exit=1

# 2. Local target + --force → allowed to proceed (will then try to connect to db:5432 and fail fast —
#    that connection error is fine; it proves the gate was PASSED, not blocked):
AGORA_ENV=selfhost DATABASE_URL='postgres://postgres:pw@db:5432/postgres' \
  node scripts/drop.mjs --yes --force < /dev/null; echo "exit=$?"
# Expected: prints "Target kind : LOCAL (safe to --force)", NO "Refusing…" line (fails later on connection).
```

- [ ] **Step 9: Run the unit suite to confirm no regressions**

Run: `cd apps/api && npx vitest run scripts/lib/db-target.test.mjs`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/scripts/drop.mjs apps/api/scripts/genesis.mjs
git commit -m "feat(scripts): guard drop/genesis against wiping a cloud DB on --force"
```

---

### Task 3: The three per-mode templates + gitignore

**Files:**
- Rename: `.env.local.example` → `.env.selfhost.example` (modify: add `AGORA_ENV`)
- Create: `.env.dev.example`, `.env.prod.example`
- Delete: `.env.example`, `apps/api/.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Rename the selfhost template and add its marker**

```bash
git mv .env.local.example .env.selfhost.example
```

Then in `.env.selfhost.example`, add the marker as the first non-comment line (immediately before the `# ═══ Core (required) ═══` section, after the header comment block):

```bash
AGORA_ENV=selfhost
```

Also update its header line 2 to name the config precisely:

```
# Agora — SELFHOST config #4: CONTAINER app (built from source) + LOCAL Postgres + MinIO (no Supabase).
```

and its "Bring it up" command block to:

```
#     docker compose --profile selfhost up --build -d
#     docker compose exec agora node scripts/genesis.mjs --force        # schema + fixtures (LOCAL db)
#     docker compose exec agora node scripts/seeds/seed.mjs             # demo content + admin login
```

- [ ] **Step 2: Create `.env.dev.example`**

Create `.env.dev.example`:

```bash
# ──────────────────────────────────────────────────────────────────────────────
# Agora — DEV config #1: HOST-run app (pnpm dev, HMR) + CLOUD Supabase data plane.
#   Compose:  docker compose -f docker-compose.dev.yml --profile supabase up --build
#   You run the app on the HOST (e.g. `cd apps/api && pnpm dev`); the containers (Caddy
#   front door, cron, scorer) reach it over host.docker.internal. Backing services the
#   dev compose publishes to localhost are addressed here as localhost.
#
# 1. cp .env.dev.example .env    2. fill the <…> placeholders (Supabase creds + secrets)
# Secret rules:  URL/NEO4J passwords → openssl rand -hex 16   |   token secrets → openssl rand -base64 48
# ──────────────────────────────────────────────────────────────────────────────
AGORA_ENV=dev

# ═══ Core ═══════════════════════════════════════════════════════════════════
# Supabase transaction pooler (:6543), Drizzle connects with prepare:false.
# Supabase dashboard → Project Settings → Database → Connection string (Transaction pooler).
DATABASE_URL=postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@aws-1-<region>.pooler.supabase.com:6543/postgres
ACCESS_TOKEN_SECRET=<GENERATE: openssl rand -base64 48>

# ═══ Supabase — Auth + Storage ═════════════════════════════════════════════
SUPABASE_URL=https://<PROJECT_REF>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<Supabase → Settings → API → service_role>
SUPABASE_ANON_KEY=<Supabase → Settings → API → anon/publishable>

# ═══ API server ════════════════════════════════════════════════════════════
PORT=4000
ACCESS_TOKEN_TTL=1800
REFRESH_TOKEN_TTL=2592000
REFRESH_TOKEN_GRACE_SECONDS=30
CORS_ORIGIN=*
# Make the seeded admin a deployment operator (god-view). Matches the demo seed user.
OPERATOR_EMAILS=agora-admin@gmail.com

# ═══ Front door (Caddy) — plain HTTP for local dev ═════════════════════════
SERVER_NAME=:80
PUBLIC_BASE_URL=http://localhost
RATE_LIMIT_TRUSTED_HOPS=1

# ═══ Backing services — HOST-side hostnames ════════════════════════════════
# The app runs on the HOST; the dev compose publishes these to localhost and overrides the
# container-side consumers (scorer/cron) to service names automatically. Only needed if you add
# --profile scorer / --profile secure-chat.
NEO4J_URI=bolt://localhost:7687
NEO4J_AUTH=neo4j/<GENERATE: openssl rand -hex 16>
REDIS_URL=redis://localhost:6379
API_BASE_URL=http://localhost:4000

# ═══ Internal endpoints (cron + scorer write-back) ════════════════════════
CRON_SECRET=<GENERATE: openssl rand -base64 48>
MODERATION_SERVICE_SECRET=<GENERATE: openssl rand -base64 48>

# ═══ Optional AI features (blank = disabled) ══════════════════════════════
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=

# ═══ Observability (off by default) ═══════════════════════════════════════
LOG_LEVEL=debug
LOG_CONSOLE=aligned
OTEL_SDK_DISABLED=true
```

- [ ] **Step 3: Create `.env.prod.example`**

Create `.env.prod.example`:

```bash
# ──────────────────────────────────────────────────────────────────────────────
# Agora — PROD config #5: CONTAINER app (pulled image) + CLOUD Supabase data plane.
#   Compose:  docker compose -f docker-compose.prod.yml --profile supabase up -d
#   Pin a release with AGORA_TAG (default `latest`). The Caddy front door is the only public
#   surface (80/443); backend ports are NOT published.
#
# 1. cp .env.prod.example .env   2. fill the <…> placeholders
# Secret rules:  URL/NEO4J passwords → openssl rand -hex 16   |   token secrets → openssl rand -base64 48
# ──────────────────────────────────────────────────────────────────────────────
AGORA_ENV=prod

# ═══ Core ═══════════════════════════════════════════════════════════════════
DATABASE_URL=postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@aws-1-<region>.pooler.supabase.com:6543/postgres
ACCESS_TOKEN_SECRET=<GENERATE: openssl rand -base64 48>

# ═══ Supabase — Auth + Storage ═════════════════════════════════════════════
SUPABASE_URL=https://<PROJECT_REF>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<Supabase → Settings → API → service_role>
SUPABASE_ANON_KEY=<Supabase → Settings → API → anon/publishable>

# ═══ API server ════════════════════════════════════════════════════════════
PORT=4000
ACCESS_TOKEN_TTL=1800
REFRESH_TOKEN_TTL=2592000
REFRESH_TOKEN_GRACE_SECONDS=30
CORS_ORIGIN=https://<your.domain>
OPERATOR_EMAILS=<you@your.domain>

# ═══ Front door (Caddy) — real domain, auto-HTTPS ═════════════════════════
# DNS for <your.domain> must point at this host so ACME can validate on :80.
# Behind an external TLS terminator instead, set SERVER_NAME=:80.
SERVER_NAME=<your.domain>
PUBLIC_BASE_URL=https://<your.domain>
ACME_CA=https://acme-v02.api.letsencrypt.org/directory
RATE_LIMIT_TRUSTED_HOPS=1

# ═══ Backing services — in-container service hostnames ════════════════════
NEO4J_URI=bolt://neo4j:7687
NEO4J_AUTH=neo4j/<GENERATE: openssl rand -hex 16>
REDIS_URL=redis://redis:6379

# ═══ Internal endpoints (cron + scorer write-back) ════════════════════════
CRON_SECRET=<GENERATE: openssl rand -base64 48>
MODERATION_SERVICE_SECRET=<GENERATE: openssl rand -base64 48>

# ═══ Optional AI features (blank = disabled) ══════════════════════════════
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=

# ═══ Observability (off by default) ═══════════════════════════════════════
LOG_LEVEL=info
LOG_CONSOLE=json
OTEL_SDK_DISABLED=true
```

- [ ] **Step 4: Delete the stale examples**

```bash
git rm .env.example apps/api/.env.example
```

- [ ] **Step 5: Update `.gitignore` to track any mode template**

In `.gitignore`, replace the two per-file exception lines (currently lines 8-9):

```gitignore
!.env.example
!.env.local.example
```

with a single pattern:

```gitignore
!.env.*.example
```

- [ ] **Step 6: Verify tracking is correct**

```bash
git status --short
git check-ignore .env.dev.example .env.selfhost.example .env.prod.example && echo "BUG: template ignored" || echo "OK: templates tracked"
git check-ignore .env .env.local .env.prod >/dev/null && echo "OK: real env files still ignored"
```
Expected: the three `.env.*.example` are staged/tracked (not ignored); `.env`/`.env.local`/`.env.prod` remain ignored.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(env): three per-mode templates (.env.dev/selfhost/prod.example); drop stale examples"
```

---

### Task 4: Documentation — one per-mode table, kill stale references

**Files:**
- Modify: `README.md` (Quick start ~228-231; "Environment files" section ~241-266)
- Modify: `docs/SELF-HOSTING.md` (~32, 40, 44, 47)
- Modify: `docs/DEVELOPMENT.md` (~36, 40-41)
- Modify: `docs/CHEAT-SHEET.md` (~5)
- Modify: `apps/api/README.md` (~87, 163)
- Modify: `docker-compose.prod.yml` header (~25); `docker-compose.dev.yml` header refs to `.env.local`

- [ ] **Step 1: Replace the README "Environment files" section**

In `README.md`, replace the entire `## Environment files` section (from the `## Environment files` heading through the end of that section, currently ~lines 241-266) with:

```markdown
## Environment files

Agora runs in three first-class configurations, each with a **complete, ready-to-fill template**. Pick
the one that matches how you're running it, copy it to `.env`, and fill the `<…>` placeholders:

| Configuration | Template → `.env` | Bring it up |
|---|---|---|
| **dev** — you edit code on the host (HMR), cloud Supabase backs it | `cp .env.dev.example .env` | `docker compose -f docker-compose.dev.yml --profile supabase up --build` + `pnpm --filter @agora/api dev` |
| **selfhost** — fully self-contained, no cloud account (local Postgres + MinIO) | `cp .env.selfhost.example .env` | `docker compose --profile selfhost up --build -d` |
| **prod** — pulled images, cloud Supabase, real domain | `cp .env.prod.example .env` | `docker compose -f docker-compose.prod.yml --profile supabase up -d` |

Compose reads the root **`.env`** for both `${VAR}` interpolation and the services' `env_file`. Each app
also loads it via `dotenv` (`apps/api/.env` is a symlink to the root `.env`). Every template carries an
`AGORA_ENV=<mode>` marker; the destructive DB scripts (`drop`/`genesis`) read it to refuse a `--force`
that would wipe a **cloud** database.

The browser-facing admin SPA has its own build-time vars — see [`apps/admin/.env.example`](apps/admin/.env.example).
```

- [ ] **Step 2: Fix the README Quick start copy line**

In `README.md`, in the `## Quick start` section, replace the backend copy line (currently line 230):

```
cp .env.example .env      # fill in DATABASE_URL
```

with:

```
cp .env.dev.example .env  # dev (host + cloud Supabase); or .env.selfhost.example for a fully local stack
```

Also in the same section, replace the later `cp .env.example .env` (currently ~line 260) with `cp .env.dev.example .env` and delete the now-obsolete `ln -sf ../../.env apps/secure-chat/.env` line if it references the deleted example (the `apps/api/.env` symlink already exists and is kept).

- [ ] **Step 3: Update `docs/SELF-HOSTING.md`**

In `docs/SELF-HOSTING.md`, in the "Quick start" section, replace the three references so the flow uses the renamed template and a single copy step:

- Line ~32: `` [`.env.local.example`](../.env.local.example) `` → `` [`.env.selfhost.example`](../.env.selfhost.example) ``
- Lines ~40-44: replace the three-line `cp .env.local.example .env.local` / edit / `cp .env.local .env` dance with:

```bash
   cp .env.selfhost.example .env            # copy the template
   # …fill the <GENERATE:…> placeholders (openssl commands are shown inline)…
```

- Line ~47: change "what you'd otherwise assemble by hand from `.env.example` →" to "what you'd otherwise assemble by hand →" (the `.env.example` stub no longer exists).

- [ ] **Step 4: Update `docs/DEVELOPMENT.md`**

In `docs/DEVELOPMENT.md`, replace the copy line (~36) `cp .env.example .env      # fill in DATABASE_URL …` with:

```
cp .env.dev.example .env  # dev (host + cloud); see Environment files in the README for all three modes
```

And in the paragraph at ~40-41, replace the sentence "The repo-root `.env.example` is the comprehensive reference; per-app `*.env.example` files are minimal subsets." with:

```
Each of the three modes has a complete template — `.env.dev.example`, `.env.selfhost.example`,
`.env.prod.example` (see the README → Environment files).
```

- [ ] **Step 5: Update `docs/CHEAT-SHEET.md`**

In `docs/CHEAT-SHEET.md`, line ~5, replace the `` [`.env.example`](../.env.example) `` reference with `` [`.env.dev.example`](../.env.dev.example) `` (the general config reference for a maintainer).

- [ ] **Step 6: Update `apps/api/README.md`**

In `apps/api/README.md`, replace both `cp .env.example .env` occurrences (~87 and ~163) with:

```
cp ../../.env.dev.example .env  # or .env.selfhost.example — see the root README → Environment files
```

(The `apps/api/.env` symlink to the root `.env` means you normally fill the root file, not a per-app one.)

- [ ] **Step 7: Update the compose header comments**

In `docker-compose.prod.yml`, line ~25, replace `see .env.example / docs/CHEAT-SHEET.md` with `see .env.prod.example / docs/SELF-HOSTING.md`.

In `docker-compose.dev.yml`, update the header comment that references pointing "your single host `.env` at localhost" to name the template: `cp .env.dev.example .env` (dev) `or .env.selfhost.example` (offline). In `docker-compose.yml`, if any header comment references `.env.local`, change it to `.env.selfhost.example`.

- [ ] **Step 8: Verify no stale references remain in live docs**

```bash
grep -rn "\.env\.example\|\.env\.local\.example\|\.env\.local\b" README.md apps/api/README.md docs/SELF-HOSTING.md docs/DEVELOPMENT.md docs/CHEAT-SHEET.md docker-compose*.yml | grep -v "\.env\.\(dev\|selfhost\|prod\)\.example"
```
Expected: no output (all references now point at the per-mode templates). Ignore hits under `docs/superpowers/` (historical specs/plans).

- [ ] **Step 9: Commit**

```bash
git add README.md apps/api/README.md docs/SELF-HOSTING.md docs/DEVELOPMENT.md docs/CHEAT-SHEET.md docker-compose.yml docker-compose.dev.yml docker-compose.prod.yml
git commit -m "docs: document the three per-mode env templates; drop stale .env.example references"
```

---

### Task 5: Validate the self-host stack end-to-end and fix what's broken

> This is the "make selfhost real" task. The design flags that "never worked" may hide more than env
> (image build, migration extensions, MinIO bucket bootstrap, native-auth seed). Work the checklist;
> when a step fails, diagnose with `superpowers:systematic-debugging`, fix at the root, and record the
> fix in this task's commit. If a fix balloons beyond env/compose wiring, STOP and surface it rather
> than silently expanding scope.

**Files:** whatever the validation surfaces (likely candidates: `.env.selfhost.example`, `docker-compose.yml`, `apps/api/scripts/seeds/*`, `lib/storage/s3.ts`, a migration bootstrap). No file is pre-committed to change.

- [ ] **Step 1: Prepare a real selfhost `.env` from the template (local, gitignored)**

```bash
cp .env.selfhost.example .env
# Fill placeholders with generated values. POSTGRES_PASSWORD must equal the pw in DATABASE_URL;
# MINIO_ROOT_PASSWORD must equal S3_SECRET_ACCESS_KEY. Example (do NOT commit .env):
#   PW=$(openssl rand -hex 16)   → put in DATABASE_URL + POSTGRES_PASSWORD
#   MK=$(openssl rand -hex 16)   → put in S3_SECRET_ACCESS_KEY + MINIO_ROOT_PASSWORD
#   openssl rand -base64 48      → ACCESS_TOKEN_SECRET / CRON_SECRET / MODERATION_SERVICE_SECRET
#   openssl rand -hex 16         → NEO4J_AUTH password half
```
Confirm `AGORA_ENV=selfhost` is present: `grep '^AGORA_ENV=' .env` → `AGORA_ENV=selfhost`.

- [ ] **Step 2: Bring up the selfhost data plane**

```bash
docker compose --profile selfhost up -d --build
docker compose ps        # db, minio, agora, proxy, cron should be Up (db/minio healthy)
```
Expected: all listed services Up. If `agora` crash-loops, capture `docker compose logs agora` and fix the root cause (common: env validation, DB reachability) before proceeding.

- [ ] **Step 3: Build the schema against the LOCAL db (guardrail should allow --force)**

```bash
docker compose exec agora node scripts/genesis.mjs --force
```
Expected: prints `AGORA_ENV : selfhost` + `Target kind : LOCAL`, then drops/rebuilds/seeds `seed.sql`, ending `✅ genesis complete`. If it instead prints "Refusing to drop a CLOUD/REMOTE target", the `.env` `DATABASE_URL` host isn't `db` — fix the template/`.env`.

- [ ] **Step 4: Seed the native admin + demo content**

```bash
docker compose exec -e ADMIN_EMAIL=agora-admin@gmail.com -e ADMIN_PASSWORD=DemoPass123! -e SEED_DEMO_DATA=1 \
  agora node scripts/seeds/seed.mjs
```
Expected: admin user created (native), demo posts seeded. Fix any seeder failure at root (e.g. native-auth seeder needs `DEFAULT_AUTH_PROVIDER=native` — verify it's in the template).

- [ ] **Step 5: Verify the running stack over HTTP**

```bash
curl -fsS http://localhost/v7/health && echo " OK: API health"
# Sign in as the seeded admin through the front door:
curl -fsS -X POST http://localhost/v7/11111111-1111-1111-1111-111111111111/auth/sign-in \
  -H 'content-type: application/json' \
  -d '{"email":"agora-admin@gmail.com","password":"DemoPass123!"}' | grep -o '"accessToken"' && echo " OK: login"
```
Expected: health OK; login returns an `accessToken`. Then open `http://localhost` (admin SPA) and confirm a seeded post renders and its image loads from `/media` (proves MinIO storage + bucket bootstrap). Fix media/storage failures at root (likely `lib/storage/s3.ts` bucket/policy on first upload, or `S3_PUBLIC_URL`).

- [ ] **Step 6: Record fixes + run the test gates**

```bash
pnpm -r typecheck
pnpm test
```
Expected: both pass. If Step 2-5 required code/compose/template fixes, they are included in this task's commit.

- [ ] **Step 7: Tear down and commit**

```bash
docker compose --profile selfhost down
git add -A
git commit -m "fix(selfhost): make the self-contained stack boot end-to-end (genesis→seed→login→media)"
```

*(If no code fix was needed and selfhost booted clean, commit only any doc note recording that it's validated, and say so.)*

---

### Task 6: Changelog + final sweep

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the changelog entry**

In `CHANGELOG.md`, under `## [Unreleased]`, add to `### Changed` (and `### Added`/`### Removed` as fitting):

```markdown
### Added
- **Three per-mode env templates** — `.env.dev.example` (host + cloud Supabase), `.env.selfhost.example`
  (fully self-contained: local Postgres + MinIO, native auth), and `.env.prod.example` (pulled images +
  cloud + real domain). Each is complete and self-consistent; pick one, `cp` it to `.env`, fill the
  placeholders. Every template carries an `AGORA_ENV` marker.
- **Destructive-script guardrail** — `drop`/`genesis` refuse a `--force` that targets a **cloud/remote**
  database (anything but the selfhost `db`/localhost); a cloud wipe now requires the interactive typed-ref
  confirm or an explicit `--force-cloud`. `genesis --test` (the disposable test project) implies it.

### Removed
- The misleading `.env.example` (15-var stub) and stale `apps/api/.env.example` — superseded by the
  per-mode templates above.
```

- [ ] **Step 2: Full-repo stale-reference sweep**

```bash
grep -rn "\.env\.local\.example\|cp \.env\.example" --include='*.md' --include='*.yml' . | grep -v "docs/superpowers/"
```
Expected: no output outside historical `docs/superpowers/` artifacts. Fix any stragglers.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): per-mode env templates + destructive-script cloud guardrail"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-01-env-config-design.md`):
- §Design.1 three templates + delete stale + `!.env.*.example` gitignore → Task 3 ✓
- §Design.2 `AGORA_ENV` marker → Task 3 (in every template) ✓
- §Design.3 destructive-script guardrail (local vs cloud, `--force-cloud`) → Tasks 1-2 ✓
- §Design.4 variable matrix → Task 3 template contents ✓
- §Design.5 docs (single per-mode table, kill stale comments) → Task 4 ✓
- §Validation (selfhost boots end-to-end + fix; dev regression; guardrail unit test) → Task 5 (boot), Task 1 (unit test), Task 5 Step 5 (dev unaffected — dev `.env` unchanged shape) ✓
- §Validation.4 guardrail unit test (local proceeds / cloud refused) → Task 1 tests ✓

**Placeholder scan:** template `<GENERATE:…>`/`<your.domain>` tokens are intentional artifact content, not plan gaps. No "TBD/handle edge cases/similar to Task N". ✓

**Type/name consistency:** `isLocalTarget({agoraEnv, databaseUrl})` and `dbTargetHost(url)` are defined in Task 1 and consumed with those exact names/shapes in Task 2. `--force-cloud` is the single spelling across `drop.mjs`, `genesis.mjs`, and docs. `AGORA_ENV` spelling consistent across templates, scripts, and docs. ✓

**Open risk (carried from spec):** Task 5's depth is unknown. It is structured as diagnose-fix-at-root with an explicit "stop and surface if it balloons" instruction rather than a blank check.
