# Auth Wall — Private by Default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every request under `/v7/:projectId/*` requires an authenticated account, except the explicit pre-sign-in allowlist — Agora becomes private by default.

**Architecture:** One new middleware, `authWall`, in the `@agora/core` kernel replaces `optionalAuth` at the project-group mount. An exported allowlist constant (exact paths + one `/auth/` prefix) is the API's entire anonymous surface; everything else gets `requireAuth` semantics (401 anonymous, 403 suspended). A companion migration drops the RLS `0008` public-read policies so the DB layer states the same posture.

**Tech Stack:** Hono middleware (`hono/factory` `createMiddleware`), jose (HS256 JWT), Drizzle custom SQL migration, vitest (unit + real-Postgres integration).

**Spec:** `docs/superpowers/specs/2026-07-17-auth-wall-private-by-default-design.md`

## Global Constraints

- **Security first, fail closed** (CLAUDE.md → Engineering principles). The wall must default every future route to authed; only the allowlist constant grants anonymity.
- **Build order:** `@agora-server/contract` → `@agora/core` → apps. After editing `packages/core`, run `pnpm --filter @agora/core build` before running api tests (apps consume core's `dist/` via its exports map).
- **Migrations:** apply with `pnpm db:migrate:run` (NOT `db:migrate` — drizzle-kit's journal schema is misconfigured). New journal `when` MUST exceed the current max (`1781934611661`) or the migrator strands it.
- **Errors** are thrown `Errors.*` (`packages/core/src/http/errors.ts`), never bare strings. `Errors.unauthorized()` → 401; `Errors.forbidden("auth/suspended", "Account suspended")` → 403.
- **Logging:** shared `logger` only; `info`/`error` carry a message ONLY; raw err objects go on `debug` with data-object-FIRST arg order. (No new logging is expected in this plan.)
- **Integration tests:** run with `TMPDIR="$HOME/.cache/agora-tmp"` (macOS `/private/tmp` fills). Single-file: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts <name>` (a bare `pnpm test:integration -- <name>` runs the WHOLE suite).
- **Commits:** ⚠️ standing rule — **ask Jenova before ANY commit**. At execution pre-flight, ask whether per-task commits are authorized for this run; if not, accumulate and ask at the end. The commit steps below are contingent on that authorization.
- **Done means:** `pnpm -r typecheck` AND `pnpm test` pass (plus the integration suite for this plan).

---

### Task 1: `authWall` middleware + allowlist in `@agora/core`

**Files:**
- Modify: `packages/core/src/middleware/auth.ts` (61 lines today; full current content shown below)
- Test: `apps/api/src/middleware/auth-wall.test.ts` (new; the api's unit suite runs `src/**/*.test.ts` with dummy env — no DB)

**Interfaces:**
- Consumes: existing `verify`/`bearer`/`Errors`/`hasActiveSuspension` internals of `auth.ts`.
- Produces: `authWall` (Hono middleware), `AUTH_WALL_ALLOWLIST: { prefixes: readonly string[]; exact: readonly string[] }`, `projectRelativePath(fullPath: string): string`, `isWallAllowlisted(relPath: string): boolean` — all exported from `@agora/core/middleware/auth` and re-exported by the api shim `apps/api/src/middleware/auth.ts` (`export * from "@agora/core/middleware/auth"` — already in place, no edit needed). Task 2 mounts `authWall`; Task 2's tests rely on 401/403 semantics exactly matching `requireAuth`.

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/middleware/auth-wall.test.ts`:

```ts
// The auth wall's pure logic: path derivation + allowlist membership. The wall's HTTP behavior
// (401/403/pass) is covered by test/integration/auth-wall.test.ts against the real app; these
// tests pin the decision logic and the EXACT anonymous surface (a membership change must fail here).
import { describe, it, expect } from "vitest";
import { AUTH_WALL_ALLOWLIST, projectRelativePath, isWallAllowlisted } from "./auth.js";

describe("AUTH_WALL_ALLOWLIST", () => {
  it("pins the exact anonymous surface of the API", () => {
    expect(AUTH_WALL_ALLOWLIST.prefixes).toEqual(["/auth/"]);
    expect(AUTH_WALL_ALLOWLIST.exact).toEqual([
      "/oauth/authorize",
      "/oauth/callback",
      "/projects/lean",
      "/push-notifications/vapid-public-key",
      "/crypto/sign-testing-jwt/v2",
    ]);
  });
});

describe("projectRelativePath", () => {
  it("strips /v7/<projectId> and keeps the rest", () => {
    expect(projectRelativePath("/v7/11111111-1111-1111-1111-111111111111/auth/sign-in"))
      .toBe("/auth/sign-in");
    expect(projectRelativePath("/v7/11111111-1111-1111-1111-111111111111/entities"))
      .toBe("/entities");
    expect(projectRelativePath("/v7/11111111-1111-1111-1111-111111111111/chat/conversations/abc/messages"))
      .toBe("/chat/conversations/abc/messages");
  });
});

describe("isWallAllowlisted", () => {
  it("admits the /auth/ prefix", () => {
    expect(isWallAllowlisted("/auth/sign-in")).toBe(true);
    expect(isWallAllowlisted("/auth/request-new-access-token")).toBe(true);
  });
  it("admits exact members only", () => {
    expect(isWallAllowlisted("/projects/lean")).toBe(true);
    expect(isWallAllowlisted("/oauth/callback")).toBe(true);
    expect(isWallAllowlisted("/push-notifications/vapid-public-key")).toBe(true);
    expect(isWallAllowlisted("/crypto/sign-testing-jwt/v2")).toBe(true);
  });
  it("rejects near-misses (fail closed)", () => {
    expect(isWallAllowlisted("/authx/anything")).toBe(false);      // prefix must not over-match
    expect(isWallAllowlisted("/auth")).toBe(false);                 // bare /auth is not a route
    expect(isWallAllowlisted("/oauth/identities")).toBe(false);     // authed oauth stays walled
    expect(isWallAllowlisted("/projects/lean/extra")).toBe(false);  // exact means exact
    expect(isWallAllowlisted("/entities")).toBe(false);
    expect(isWallAllowlisted("/search/content")).toBe(false);
    expect(isWallAllowlisted("/users/suggestions")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && pnpm test -- auth-wall
```
Expected: FAIL — `AUTH_WALL_ALLOWLIST` is not exported (`undefined`).

- [ ] **Step 3: Implement in `packages/core/src/middleware/auth.ts`**

The file today ends with `requireAuth`. Refactor the duplicated enforcement into a helper and append the wall. Full new content from line 41 (keep lines 1–39 — imports, `verify`, `bearer` — unchanged):

```ts
export const optionalAuth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  const token = bearer(c);
  c.set("auth", token ? await verify(token) : null);
  await next();
});

/** Verified, non-suspended auth or throw: 401 anonymous/invalid; 403 suspended.
 *  Operators AND project owners bypass the suspension check — operators hold the deployment
 *  god-view and lift suspensions, and an owner can't be locked out of their own project. */
async function enforceAuthed(c: { req: { header: (n: string) => string | undefined } }): Promise<AuthContext> {
  const token = bearer(c);
  const auth = token ? await verify(token) : null;
  if (!auth) throw Errors.unauthorized();
  if (!(auth.isOperator || auth.isProjectOwner) && (await hasActiveSuspension(auth.userId))) {
    throw Errors.forbidden("auth/suspended", "Account suspended");
  }
  return auth;
}

export const requireAuth = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  c.set("auth", await enforceAuthed(c));
  await next();
});

// ─── the auth wall (private by default) ─────────────────────────────────────────
// Agora requires an authenticated account for EVERY project-scoped request except the
// pre-sign-in surface below. Mounted group-wide in apps/api routes/index.ts in place of
// optionalAuth; every future route is therefore authed by default (fail closed).
// Design: docs/superpowers/specs/2026-07-17-auth-wall-private-by-default-design.md

/** The API's ENTIRE anonymous surface. Adding an entry here is a security decision —
 *  it must ship with a spec rationale and the unit test pinning this list must be updated. */
export const AUTH_WALL_ALLOWLIST: { prefixes: readonly string[]; exact: readonly string[] } = {
  // The door itself: sign-up/sign-in/refresh/reset/verify. Its authed members
  // (change-password, account deletion) keep their inner requireAuth.
  prefixes: ["/auth/"],
  exact: [
    "/oauth/authorize",                    // OAuth sign-in starts pre-session
    "/oauth/callback",                     // browser redirect — cannot carry a Bearer header
    "/projects/lean",                      // SDK ReplykeProvider bootstrap (plain axios, fires pre-sign-in)
    "/push-notifications/vapid-public-key",// documented pre-sign-in fetch, rate-limited
    "/crypto/sign-testing-jwt/v2",         // dev stub; signs with a CLIENT-supplied key, no server secret
  ],
};

/** /v7/<projectId>/auth/sign-in → /auth/sign-in (segment 3 onward; c.req.path carries no query string). */
export function projectRelativePath(fullPath: string): string {
  return "/" + fullPath.split("/").slice(3).join("/");
}

export function isWallAllowlisted(relPath: string): boolean {
  return (
    AUTH_WALL_ALLOWLIST.exact.includes(relPath) ||
    AUTH_WALL_ALLOWLIST.prefixes.some((p) => relPath.startsWith(p))
  );
}

/** Group-mount gate: allowlisted paths get optionalAuth semantics (token attached when present,
 *  anonymous allowed, no suspension check — matching today's anonymous-flow behavior); everything
 *  else gets requireAuth semantics exactly. */
export const authWall = createMiddleware<{ Variables: Variables }>(async (c, next) => {
  if (isWallAllowlisted(projectRelativePath(c.req.path))) {
    const token = bearer(c);
    c.set("auth", token ? await verify(token) : null);
    return next();
  }
  c.set("auth", await enforceAuthed(c));
  await next();
});
```

Also update the file's header comment (lines 1–7) to mention the three flavors: `optionalAuth`, `requireAuth`, `authWall` (group-mount gate + allowlist).

- [ ] **Step 4: Build core, run the test to verify it passes**

```bash
pnpm --filter @agora/core build && cd apps/api && pnpm test -- auth-wall
```
Expected: PASS (all three describe blocks).

- [ ] **Step 5: Typecheck the workspace**

```bash
pnpm -r typecheck
```
Expected: clean. (`optionalAuth` is still exported — `/auth/sign-out` uses it route-level.)

- [ ] **Step 6: Commit (if authorized — see Global Constraints)**

```bash
git add packages/core/src/middleware/auth.ts apps/api/src/middleware/auth-wall.test.ts
git commit -s -m "feat(core): authWall middleware — private-by-default gate with pre-sign-in allowlist"
```

---

### Task 2: Mount the wall + integration coverage

**Files:**
- Modify: `apps/api/src/routes/index.ts:6,36` (swap `optionalAuth` → `authWall`)
- Test: `apps/api/test/integration/auth-wall.test.ts` (new)

**Interfaces:**
- Consumes: `authWall` via the shim `../middleware/auth.js` (Task 1); integration helpers `api/base/createProject/createUser/deleteProject/signToken` (`test/integration/helpers.ts`).
- Produces: the mounted wall — after this task, every non-allowlisted project route 401s anonymously. Task 3 depends on this behavior landing first.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/auth-wall.test.ts`:

```ts
// The auth wall end-to-end: every project-scoped read 401s anonymously and passes authed;
// the pre-sign-in allowlist stays reachable with no token; suspended accounts 403 on walled
// paths but still reach the allowlist (so they can refresh/appeal). The NEGATIVE cases are
// the point (CLAUDE.md → security-relevant logic).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, base, createProject, createUser, deleteProject, signToken } from "./helpers.js";

let projectId: string;
let B: string;
let member: { id: string; token: string };
let operator: { id: string; token: string };

beforeAll(async () => {
  projectId = await createProject();
  B = base(projectId);
  member = await createUser(projectId);
  const op = await createUser(projectId);
  operator = { id: op.id, token: await signToken(op.id, "visitor", true) };
});

afterAll(async () => {
  if (projectId) await deleteProject(projectId);
});

// One representative read per project-group router that was anonymous before the wall.
// [method, path, body?] — paths are project-relative; B is prefixed in the loop.
const WALLED_READS: [string, string, unknown?][] = [
  ["GET", "/entities"],
  ["GET", "/entities/by-short-id?shortId=none"],
  ["GET", "/comments?entityId=00000000-0000-0000-0000-000000000000"],
  ["GET", "/spaces"],
  ["GET", "/spaces/check-slug?slug=probe"],
  ["GET", "/users/suggestions"],
  ["GET", "/users/check-username?username=probe"],
  ["GET", "/events"],
  ["GET", "/users/by-username?username=probe"],
  ["POST", "/search/spaces", { query: "probe" }],
  ["POST", "/search/users", { query: "probe" }],
  // /search/content is the config-leak case from the spec: anonymous must see 401, never
  // 400 search/embeddings-disabled (VOYAGE_API_KEY is forced empty in this suite). The authed
  // call returns that 400 — which the loop's "not 401/403" assertion accepts, proving order.
  ["POST", "/search/content", { query: "probe" }],
];

describe("auth wall — walled reads", () => {
  for (const [method, path, body] of WALLED_READS) {
    it(`${method} ${path} → 401 anonymous`, async () => {
      const r = await api(method, `${B}${path}`, body !== undefined ? { body } : {});
      expect(r.status).toBe(401);
    });
    it(`${method} ${path} → not 401/403 with a member token`, async () => {
      const r = await api(method, `${B}${path}`, { token: member.token, ...(body !== undefined ? { body } : {}) });
      expect([401, 403]).not.toContain(r.status); // past the wall; handler-level 2xx/4xx is its own contract
    });
  }

  it("GET /entities → 200 with a member token (positive anchor)", async () => {
    const r = await api("GET", `${B}/entities`, { token: member.token });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("data");
  });

  it("a malformed token is anonymous, not an error: GET /spaces → 401", async () => {
    const r = await api("GET", `${B}/spaces`, { token: "undefined" }); // the SDK's signed-out literal
    expect(r.status).toBe(401);
  });

  // Anonymous-only on purpose: an authed call would make a REAL outbound fetch (hermeticity).
  // The wall rejecting it pre-handler is exactly the point — an anonymous caller can no longer
  // drive the SSRF-guarded metadata fetcher at all.
  it("GET /utils/get-metadata → 401 anonymous (no outbound fetch attempted)", async () => {
    const r = await api("GET", `${B}/utils/get-metadata?url=https%3A%2F%2Fexample.com`);
    expect(r.status).toBe(401);
  });
});

describe("auth wall — allowlist stays anonymous", () => {
  it("GET /projects/lean → 200 with no token (SDK provider bootstrap)", async () => {
    const r = await api("GET", `${B}/projects/lean`);
    expect(r.status).toBe(200);
  });
  it("GET /push-notifications/vapid-public-key → 200 with no token", async () => {
    const r = await api("GET", `${B}/push-notifications/vapid-public-key`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("publicKey"); // null when VAPID unset — shape, not value
  });
  it("POST /auth/sign-up with an empty body reaches the handler (400, not the wall's 401)", async () => {
    const r = await api("POST", `${B}/auth/sign-up`, { body: {} });
    expect(r.status).toBe(400);
  });
  it("POST /oauth/authorize reaches the handler anonymously (not 401)", async () => {
    const r = await api("POST", `${B}/oauth/authorize`, { body: { provider: "google", redirectAfterAuth: "https://example.com" } });
    expect(r.status).not.toBe(401); // oauth/not-configured (503/400) is fine — it got past the wall
  });
});

describe("auth wall — suspension enforcement", () => {
  it("a suspended member 403s on a walled read but still reaches the allowlist", async () => {
    const u = await createUser(projectId);
    const s = await api("POST", `${B}/users/${u.id}/suspend`, { token: operator.token, body: { reason: "test" } });
    expect(s.status).toBe(201);

    const walled = await api("GET", `${B}/entities`, { token: u.token });
    expect(walled.status).toBe(403);
    expect(walled.body.code).toBe("auth/suspended");

    const allowed = await api("GET", `${B}/projects/lean`, { token: u.token });
    expect(allowed.status).toBe(200); // allowlist = optionalAuth semantics, no suspension gate
  });
});
```

- [ ] **Step 2: Run it to verify it fails (the wall is not mounted yet)**

```bash
mkdir -p "$HOME/.cache/agora-tmp"
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts auth-wall
```
Expected: FAIL — every "→ 401 anonymous" case gets a 2xx/4xx (routes are still anonymous).

- [ ] **Step 3: Mount the wall**

In `apps/api/src/routes/index.ts`, change line 6 and line 36:

```ts
// line 6 — was: import { optionalAuth } from "../middleware/auth.js";
import { authWall } from "../middleware/auth.js";
```

```ts
// line 36 — was: project.use("*", resolveProject, optionalAuth);
  // The auth wall: every project-scoped request requires an authenticated account except the
  // pre-sign-in allowlist (AUTH_WALL_ALLOWLIST). Private by default — fail closed for new routes.
  project.use("*", resolveProject, authWall);
```

- [ ] **Step 4: Run the new test to verify it passes**

```bash
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts auth-wall
```
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + unit suite**

```bash
pnpm -r typecheck && cd apps/api && pnpm test
```
Expected: clean / green (unit suite makes no HTTP calls; unaffected).

- [ ] **Step 6: Commit (if authorized)**

```bash
git add apps/api/src/routes/index.ts apps/api/test/integration/auth-wall.test.ts
git commit -s -m "feat(api): mount the auth wall — private by default behind AUTH_WALL_ALLOWLIST"
```

---

### Task 3: Existing integration-suite sweep

The wall breaks every existing test that exercised a read anonymously. This is expected churn, not regression — each fix is "mint/pass a token", never "loosen the wall".

**Files:**
- Modify: any `apps/api/test/integration/*.test.ts` that fails with 401 (inventory produced in Step 1 — likely includes the feed/list read tests; most tests already auth because they create content first)

**Interfaces:**
- Consumes: the mounted wall (Task 2); `createUser(projectId)` returns `{ id, token }` — the standard fixture.
- Produces: a green integration suite; Task 6's final verification depends on it.

- [ ] **Step 1: Run the full suite and inventory the 401 failures**

```bash
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts 2>&1 | tee /tmp/wall-sweep.log
grep -E "FAIL|✗|×" /tmp/wall-sweep.log | sort -u
```
Expected: a list of failing files. For each, confirm the failure is a 401 where the test expected content (the wall) and not something else (investigate anything that isn't a 401 before touching it).

- [ ] **Step 2: Fix file-by-file — pass a token on anonymous reads**

The mechanical pattern, applied per failing call site:

```ts
// BEFORE (anonymous read, now 401):
const r = await api("GET", `${B}/entities`);
// AFTER (authed read — reuse a fixture user already in the file, or create one in beforeAll):
const r = await api("GET", `${B}/entities`, { token: member.token });
```

Rules for the sweep:
- Reuse an existing fixture user's token when the file already has one; add `const member = await createUser(projectId)` in `beforeAll` only when it doesn't.
- If a test *asserted* anonymous access as the behavior under test (e.g. "public read returns the entity"), rewrite the assertion to the new contract: anonymous → `401`, authed → previous expectation. Do NOT delete the case — invert it.
- Never add an allowlist entry to make a test pass. If a test seems to *require* anonymity, stop and flag it in the task report — that's a design question, not a sweep fix.

- [ ] **Step 3: Re-run the full suite until green**

```bash
TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration
```
Expected: PASS. (Flaky-looking failures: check for lingering vitest processes and dev `.env` drift per the integration-env-leakage note before suspecting the sweep.)

- [ ] **Step 4: Check the standalone scripts for anonymous reads**

```bash
grep -rn "fetch(\|axios" apps/api/scripts/chat-e2e.mjs apps/api/perf/*.mjs 2>/dev/null | grep -v Authorization | head -20
```
Expected: `chat-e2e.mjs` and seeders sign in (they already do). If the perf harness (`apps/api/perf/`) makes anonymous reads, add a sign-in/minted token using the same pattern the seeders use — report what was found either way.

- [ ] **Step 5: Commit (if authorized)**

```bash
git add apps/api/test/integration apps/api/perf apps/api/scripts
git commit -s -m "test(api): sweep integration suite for the auth wall — reads now carry tokens"
```

---

### Task 4: RLS migration — drop the `0008` public-read policies

**Files:**
- Create: `apps/api/drizzle/0064_auth_wall_revoke_public_read.sql`
- Modify: `apps/api/drizzle/meta/_journal.json` (append entry)

**Interfaces:**
- Consumes: the six `*_public_read` policies + anon `SELECT` grants created by `apps/api/drizzle/0008_rls_public_read.sql` (tables: `spaces`, `entities`, `comments`, `space_rules`, `follows`, `reactions`).
- Produces: a DB where `anon` has no read path; the `0017` deny-all backstop covers everything. No app-code interface.

- [ ] **Step 1: Write the migration**

Create `apps/api/drizzle/0064_auth_wall_revoke_public_read.sql`:

```sql
-- 0064: auth wall — private by default.
-- Design: docs/superpowers/specs/2026-07-17-auth-wall-private-by-default-design.md
-- The API now requires an authenticated account for every read (the authWall middleware), so the
-- direct anon-key read path (0008 "Option A", a never-used performance seam) has no remaining
-- legitimate caller. Drop every *_public_read policy and revoke anon's SELECT. The authenticated
-- role keeps its GRANTs (harmless: the 0017 deny-all backstop denies without a policy) and its
-- self-access policies from later migrations. Idempotent.
DROP POLICY IF EXISTS "spaces_public_read" ON "spaces";
--> statement-breakpoint
DROP POLICY IF EXISTS "entities_public_read" ON "entities";
--> statement-breakpoint
DROP POLICY IF EXISTS "comments_public_read" ON "comments";
--> statement-breakpoint
DROP POLICY IF EXISTS "space_rules_public_read" ON "space_rules";
--> statement-breakpoint
DROP POLICY IF EXISTS "follows_public_read" ON "follows";
--> statement-breakpoint
DROP POLICY IF EXISTS "reactions_public_read" ON "reactions";
--> statement-breakpoint
REVOKE SELECT ON "spaces", "entities", "comments", "space_rules", "follows", "reactions" FROM anon;
```

- [ ] **Step 2: Append the journal entry**

In `apps/api/drizzle/meta/_journal.json`, append to `entries` (copy the exact field shape of the idx-63 entry; `when` MUST exceed `1781934611661`):

```json
{ "idx": 64, "version": "7", "when": 1781934611662, "tag": "0064_auth_wall_revoke_public_read", "breakpoints": true }
```

Verify the shape matches its neighbors: `python3 -c "import json; e=json.load(open('apps/api/drizzle/meta/_journal.json'))['entries']; print(e[-2]); print(e[-1])"`

- [ ] **Step 3: Apply and verify**

```bash
cd apps/api && pnpm db:migrate:run
```
Expected: applies `0064` and exits 0. Then verify the policies are gone and anon lost SELECT:

```bash
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
psql "$url" -c "select polname, polrelid::regclass from pg_policy where polname like '%public_read%';"
psql "$url" -c "select has_table_privilege('anon','entities','select') as anon_can_read_entities;"
```
Expected: zero policy rows; `anon_can_read_entities = f`.

- [ ] **Step 4: Prove idempotency + test-DB path**

```bash
psql "$url" -v ON_ERROR_STOP=1 -f drizzle/0064_auth_wall_revoke_public_read.sql
```
Expected: exits 0 on the second run (DROP IF EXISTS + REVOKE are re-runnable). Then confirm the integration DB applies it cleanly on next suite run (globalSetup runs migrations):

```bash
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts auth-wall
```
Expected: PASS (migration applied to TEST_DATABASE_URL without error).

- [ ] **Step 5: Commit (if authorized)**

```bash
git add apps/api/drizzle/0064_auth_wall_revoke_public_read.sql apps/api/drizzle/meta/_journal.json
git commit -s -m "feat(db): revoke 0008 anon public-read policies — DB posture matches the auth wall"
```

---

### Task 5: Docs — contract posture, security posture, changelog, supersession

**Files:**
- Modify: `docs/MANIFEST.md` (§1 + §spaces preamble + §search preamble)
- Modify: `docs/MODELS.md` (Space section, one line)
- Modify: `SECURITY.md` (posture addition)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Changed`, breaking)
- Modify: `docs/superpowers/specs/2026-07-16-search-auth-and-abuse-defaults-design.md` (status line)

**Interfaces:** none (docs only). Task 6 runs the propagation checker over the branch.

- [ ] **Step 1: MANIFEST §1 — the global posture statement**

In `docs/MANIFEST.md`, directly under the `**Auth header:** Authorization: Bearer <accessToken>.` block (line ~50), insert:

```markdown
**Private by default (auth wall).** EVERY endpoint under `/v7/:projectId/*` requires a valid
`Authorization: Bearer` token — anonymous → `401`, suspended account → `403 auth/suspended` — with
exactly one exception set, the pre-sign-in allowlist (`AUTH_WALL_ALLOWLIST`,
`packages/core/src/middleware/auth.ts`): `/auth/*`, `/oauth/authorize`, `/oauth/callback`,
`/projects/lean`, `/push-notifications/vapid-public-key`, `/crypto/sign-testing-jwt/v2`.
Per-route auth notes below are therefore redundant for project-scoped routes and kept only where
a stricter role (operator/project-admin/host) applies. The root-mounted connections module and the
secure-chat service require auth on every route independently of the wall.
```

- [ ] **Step 2: MANIFEST §spaces + §search preamble notes**

In the §spaces preamble (near the `readingPermission` discussion around line 242), append one sentence:

```markdown
Since the auth wall, `readingPermission: "anyone"` means *any authenticated user* — no space
content is reachable anonymously.
```

In §search (line ~421), the preamble sentence starting "All search endpoints are **POST**…" gains a leading sentence:

```markdown
All search endpoints sit behind the auth wall (anonymous → `401`) like every other project-scoped route.
```

- [ ] **Step 3: MODELS.md Space note**

In the `## Space / SpaceDetailed` section (line ~44-56), append one line after the `visibility` paragraph:

```markdown
`readingPermission: "anyone"` = any *authenticated* user (the auth wall bars anonymous reads entirely).
```

- [ ] **Step 4: SECURITY.md posture addition**

Read `SECURITY.md`, find the section describing the trust boundary / API posture, and add (adapting the heading level to its neighbors):

```markdown
### Private by default (auth wall)

Every `/v7/:projectId/*` request requires an authenticated account. The gate is `authWall`
(`packages/core/src/middleware/auth.ts`), mounted group-wide; its `AUTH_WALL_ALLOWLIST` constant is
the API's entire anonymous surface (the pre-sign-in flows: `/auth/*`, OAuth authorize/callback,
`/projects/lean`, the VAPID public key, and the dev JWT-signing stub). New routes are authed by
default — fail closed. Adding an allowlist entry is a security decision requiring spec rationale;
a unit test pins the list's exact contents. The RLS `0008` anon public-read policies were revoked
(`0064`) so the DB layer states the same posture. Uploaded media remains fetchable by unguessable
URL (see the storage section) — the one anonymous-readable artifact class, queued for a signed-URL
follow-up.
```

- [ ] **Step 5: CHANGELOG entry**

Under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Changed
- **BREAKING — private by default.** Every `/v7/:projectId/*` endpoint now requires an
  authenticated account (`authWall`, group-mounted). Anonymous → `401`; suspended → `403
  auth/suspended`. The only anonymous surface is the pre-sign-in allowlist: `/auth/*`,
  `/oauth/authorize`, `/oauth/callback`, `/projects/lean`, `/push-notifications/vapid-public-key`,
  `/crypto/sign-testing-jwt/v2`. Deployments serving anonymous readers (public widget embeds) break
  by design; signed-in SDK users are unaffected. Ships in the next MAJOR version.
- RLS: the `0008` anon public-read policies are dropped and `anon`'s `SELECT` grants revoked
  (migration `0064`) — the DB now states the same private-by-default posture as the API.
```

- [ ] **Step 6: Mark the superseded spec**

In `docs/superpowers/specs/2026-07-16-search-auth-and-abuse-defaults-design.md`, replace the Status line (line 3):

```markdown
> **Status:** SUPERSEDED (2026-07-17). Change 1 (search auth) is subsumed by the auth wall
> (`2026-07-17-auth-wall-private-by-default-design.md`); Changes 2–4 (per-user budgets, fail-closed
> limiter defaults, breaker) move to the forthcoming abuse-deterrence spec, which must also fix two
> review findings: the integration suite shares one rate-limit bucket (`clientIp` falls back to
> "unknown" with no XFF header — pin `RATE_LIMIT_MAX=0`/`RATE_LIMIT_AUTH_MAX=0` in
> `vitest.integration.config.ts` env), and the same "unknown" bucket makes per-IP defaults a
> deployment-wide cap when no proxy writes XFF (needs a startup warning + docs).
```

- [ ] **Step 7: Commit (if authorized)**

```bash
git add docs/MANIFEST.md docs/MODELS.md SECURITY.md CHANGELOG.md docs/superpowers/specs/2026-07-16-search-auth-and-abuse-defaults-design.md
git commit -s -m "docs: private-by-default posture — MANIFEST/MODELS/SECURITY/CHANGELOG + supersede search spec"
```

---

### Task 6: Final verification

**Files:** none created; read-only checks.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Full builds + typecheck + unit suite**

```bash
pnpm -r build && pnpm -r typecheck && cd apps/api && pnpm test
```
Expected: all green.

- [ ] **Step 2: Full integration suite**

```bash
TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration
```
Expected: all green (Tasks 2–4 landed).

- [ ] **Step 3: Propagation check over the branch diff**

```bash
cd apps/api && pnpm check:propagation --diff root
```
Expected: doc obligations for the endpoint-class change resolve to the MANIFEST/MODELS/SECURITY/CHANGELOG edits from Task 5 (wiki/API-Contract.md may surface as an obligation — draft the same posture note there if the checker demands it). No env-var obligations (this plan adds none).

- [ ] **Step 4: Live smoke (dev server)**

```bash
cd apps/api && pnpm dev &   # :4000; stop it after
sleep 3
PID=11111111-1111-1111-1111-111111111111   # seed project
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:4000/v7/$PID/entities"        # expect 401
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:4000/v7/$PID/projects/lean"   # expect 200
```
Expected: `401` then `200`. Kill the dev server.

- [ ] **Step 5: Report**

Summarize: suite counts, sweep inventory size (how many files/call sites Task 3 touched), any flagged design questions (tests that seemed to require anonymity), propagation results. Remind: release must be a MAJOR version bump.
