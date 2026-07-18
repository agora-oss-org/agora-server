# Demo Read-Only Admin (Settings-Locked Operator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the public demo a shared operator login (`demo-admin@agora-oss.org`) that can view the entire admin/operator surface but is server-blocked from persisting any of the five settings-save endpoints, and rename the default seeded-admin email onto the project's own domain.

**Architecture:** Mirror the existing `isOperator` allowlist→JWT-claim pattern. A new env allowlist `SETTINGS_READONLY_EMAILS` is resolved once at token-mint time into a `settingsReadonly` claim, read back by core auth middleware into `c.var.auth.settingsReadonly`, and enforced by a `assertSettingsWritable(c)` guard placed after `requireProjectAdmin(c)` on exactly the five config-persisting handlers. Two non-destructive actions (webhook test, constellation recompute) stay available. The client `VITE_SETTINGS_READ_ONLY` flag is unrelated and untouched except for one line re-enabling the recompute button.

**Tech Stack:** Hono, jose (HS256 JWT), Zod (env schema), Drizzle, vitest (unit + real-Postgres integration), React (admin SPA). pnpm monorepo build order: `@agora-server/contract` → `@agora/core` → `apps/*`.

## Global Constraints

- **Env var name:** `SETTINGS_READONLY_EMAILS` (comma-separated, case-insensitive emails; empty/unset ⇒ feature off, empty string treated as unset). Claim name: `settingsReadonly`. Error: `403` code `settings/read-only`.
- **The five LOCKED endpoints** (all in `apps/api/src/routes/misc.ts`, each opening with `await requireProjectAdmin(c);`): `PATCH /settings/feed`, `PATCH /settings/moderator`, `PATCH /settings/steward`, `PATCH /settings/social`, `PATCH /webhooks/config`.
- **Explicitly NOT locked** (must stay reachable for a read-only principal): `POST /webhooks/test`, `POST /admin/social/constellation/recompute`, and all ordinary member writes.
- **Guard placement:** `assertSettingsWritable(c)` is called on the line **immediately after** `await requireProjectAdmin(c);` — admin-gate first, read-only cap last.
- **Scope is settings-saves only** — never a global read-only. `settingsReadonly` gates only those five endpoints.
- **`AuthContext` lives in `packages/contract/src/types.ts`** (re-exported by core). `AuthUser` (the `isOperator` block near line 107) is NOT changed — the demo cap is server-side only; the admin UI uses the separate deployment-wide `VITE_SETTINGS_READ_ONLY` flag.
- **Email rename target:** `agora-admin@gmail.com` → `agora-admin@agora-oss.org`, **live surfaces only**.
- **NEVER touch** `docs/PENTEST.md` (repo owner's file), and **do not rewrite** shipped `CHANGELOG.md` history or `docs/superpowers/plans/2026-07-01-env-config-cleanup.md` (historical records).
- **Before "done":** `pnpm -r build` (contract→core→apps), `pnpm -r typecheck`, and `pnpm test` (unit) must pass; the new integration test must pass against `TEST_DATABASE_URL`.
- **Logging:** shared `logger` only; `info`/`error` message-only, raw payloads on `debug`, Pino data-object-first.
- **Do not run `git commit` unless the human explicitly authorizes it.** Steps below include commit commands per SDD convention; honor the standing "never commit without asking" rule if the two conflict.

## File Structure

- `apps/api/src/lib/settings-readonly.ts` (**new**) — `isSettingsReadonly(profile)` resolver; sole owner of `SETTINGS_READONLY_EMAILS` parsing. Mirror of `lib/operators.ts`.
- `apps/api/src/lib/settings-readonly.test.ts` (**new**) — unit tests for the resolver (mirror `operators.test.ts`).
- `packages/core/src/lib/env.ts` — declare the optional env var.
- `packages/contract/src/types.ts` — add `settingsReadonly` to `AuthContext`.
- `packages/core/src/middleware/auth.ts` — read the `settingsReadonly` claim into `c.var.auth`.
- `apps/api/src/lib/tokens.ts` — thread `settingsReadonly` through `signAccessToken`/`mintSession`/`profileAuthBits`.
- `apps/api/src/lib/tokens.test.ts` — assert the claim round-trips.
- `apps/api/src/routes/auth.ts` — compute the bit in `authBits`; pass it to the two `mintSession` calls.
- `apps/api/src/lib/project-roles.ts` — add `assertSettingsWritable(c)` guard.
- `apps/api/src/routes/misc.ts` — call the guard on the five locked handlers.
- `apps/admin/src/routes/settings/SocialGraphPanel.tsx` — re-enable the recompute button under read-only.
- `apps/api/test/integration/helpers.ts` — `signToken` gains an optional `settingsReadonly` param.
- `apps/api/test/integration/settings-readonly.test.ts` (**new**) — per-route 403 + scope proof.
- Config/docs (Task 3): `.env.dev.example`, `.env.selfhost.example`, `.env.prod.example`, seed scripts, `CLAUDE.md`, `docs/SELF-HOSTING.md`, `docs/DEVELOPMENT.md`, `apps/admin/README.md`, `apps/api/README.md`, `docs/MANIFEST.md`, `docs/SECURITY.md`, `CHANGELOG.md`.

---

## Task 1: The `settingsReadonly` claim pipeline

Builds the flag end-to-end (env → resolver → mint → read-back → type) with no enforcement yet. After this task the flag rides in every token and is visible at `c.var.auth.settingsReadonly`, but nothing rejects on it.

**Files:**
- Create: `apps/api/src/lib/settings-readonly.ts`
- Create: `apps/api/src/lib/settings-readonly.test.ts`
- Modify: `packages/core/src/lib/env.ts:35`
- Modify: `packages/contract/src/types.ts:146-154`
- Modify: `packages/core/src/middleware/auth.ts:22-30`
- Modify: `apps/api/src/lib/tokens.ts:28-35,53-59,94-95,109-110,131-143`
- Modify: `apps/api/src/routes/auth.ts:78-82,90,173`
- Test: `apps/api/src/lib/settings-readonly.test.ts`, `apps/api/src/lib/tokens.test.ts`

**Interfaces:**
- Produces: `isSettingsReadonly(profile: { email?: string | null }): boolean` (`apps/api/src/lib/settings-readonly.ts`).
- Produces: JWT claim `settingsReadonly: boolean`; `AuthContext.settingsReadonly: boolean`; `c.var.auth.settingsReadonly`.
- Produces (new signatures — later tasks and callers rely on the parameter ORDER):
  - `signAccessToken(projectId, profileId, role, operator=false, steward=false, owner=false, admin=false, settingsReadonly=false)`
  - `mintSession(projectId, profileId, role, operator=false, steward=false, owner=false, admin=false, settingsReadonly=false, familyId?)`
  - `profileAuthBits(...)` return gains `settingsReadonly: boolean`.

- [ ] **Step 1: Write the failing resolver unit test**

Create `apps/api/src/lib/settings-readonly.test.ts` (mirrors `operators.test.ts` — the resolver builds its allowlist Set at module import, so each case resets modules and re-imports):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

// settings-readonly.ts builds its email allowlist Set at import time from env.SETTINGS_READONLY_EMAILS.
// Each case clears the var, resets the module registry, assigns the test env, and re-imports.
const ORIGINAL_ENV = { ...process.env };

async function loadIsSettingsReadonly(value?: string) {
  vi.resetModules();
  delete process.env.SETTINGS_READONLY_EMAILS;
  if (value !== undefined) process.env.SETTINGS_READONLY_EMAILS = value;
  return (await import("./settings-readonly.js")).isSettingsReadonly;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("isSettingsReadonly", () => {
  it("returns false for everyone when unconfigured", async () => {
    const f = await loadIsSettingsReadonly();
    expect(f({ email: "someone@example.com" })).toBe(false);
    expect(f({ email: null })).toBe(false);
    expect(f({})).toBe(false);
  });

  it("matches a configured email case-insensitively (both directions)", async () => {
    let f = await loadIsSettingsReadonly("Demo-Admin@Agora-OSS.org");
    expect(f({ email: "demo-admin@agora-oss.org" })).toBe(true);
    f = await loadIsSettingsReadonly("demo-admin@agora-oss.org");
    expect(f({ email: "Demo-Admin@Agora-OSS.org" })).toBe(true);
  });

  it("matches one of a comma-separated, whitespace-padded list", async () => {
    const f = await loadIsSettingsReadonly(" a@x.io , demo-admin@agora-oss.org ,b@y.io ");
    expect(f({ email: "demo-admin@agora-oss.org" })).toBe(true);
    expect(f({ email: "a@x.io" })).toBe(true);
  });

  it("returns false for a non-matching, null, undefined, or empty email", async () => {
    const f = await loadIsSettingsReadonly("demo-admin@agora-oss.org");
    expect(f({ email: "other@example.com" })).toBe(false);
    expect(f({ email: null })).toBe(false);
    expect(f({ email: undefined })).toBe(false);
    expect(f({ email: "" })).toBe(false);
  });

  it("treats an empty-string env value as unset", async () => {
    const f = await loadIsSettingsReadonly("");
    expect(f({ email: "" })).toBe(false);
    expect(f({ email: "anyone@example.com" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/api && pnpm test -- settings-readonly`
Expected: FAIL — `Cannot find module './settings-readonly.js'`.

- [ ] **Step 3: Declare the env var** in `packages/core/src/lib/env.ts`, immediately after the `OPERATOR_EMAILS` line (line 35):

```ts
  OPERATOR_EMAILS: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // Accounts allowed a settings-read-only operator view (the shared demo login). Comma-separated,
  // case-insensitive emails; empty/unset = no read-only principals. See lib/settings-readonly.ts.
  SETTINGS_READONLY_EMAILS: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
```

- [ ] **Step 4: Create the resolver** `apps/api/src/lib/settings-readonly.ts`:

```ts
// Settings-read-only allowlist (env-configured). An account in this list gets the normal operator/admin
// view but is blocked from the five settings-SAVE endpoints (the guard is lib/project-roles.ts
// `assertSettingsWritable`). Powers the shared public-demo login: look at everything, change nothing.
//
// Matched by email only (case-insensitive) — the demo account is addressed by email. The result is
// stamped into the access JWT at mint time (lib/tokens.ts) and read back in core middleware/auth.ts,
// so handlers see `c.var.auth.settingsReadonly` with no extra DB hit. Mirrors lib/operators.ts.
import { env } from "./env.js";

const split = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const readonlyEmails = new Set(split(env.SETTINGS_READONLY_EMAILS).map((e) => e.toLowerCase()));

/** True when a profile's email is in the settings-read-only allowlist. */
export function isSettingsReadonly(profile: { email?: string | null }): boolean {
  const email = profile.email?.toLowerCase();
  return !!email && readonlyEmails.has(email);
}
```

- [ ] **Step 5: Run the resolver test to green**

Run: `cd apps/api && pnpm test -- settings-readonly`
Expected: PASS (5 tests).

- [ ] **Step 6: Add `settingsReadonly` to the `AuthContext` type** in `packages/contract/src/types.ts`. In the `AuthContext` interface (starts line 146), add the field after `isSteward` (line 153):

```ts
  isSteward: boolean; // conflict-resolution steward (DB grant) — gates the Steward routes/tab
  // Agora extension: true when this identity is a settings-read-only principal (env allowlist,
  // SETTINGS_READONLY_EMAILS) — blocked from the five settings-save endpoints (the demo login).
  settingsReadonly: boolean;
```

Do **not** add it to the `AuthUser` interface (the `isOperator` block near line 107) — the cap is server-side only.

- [ ] **Step 7: Read the claim in core auth middleware.** In `packages/core/src/middleware/auth.ts`, in the object returned by `verify()` (lines 22-30), add after `isProjectAdmin`:

```ts
      isProjectAdmin: payload.padmin === true,
      settingsReadonly: payload.settingsReadonly === true,
```

- [ ] **Step 8: Thread the claim through `tokens.ts`.** Apply all of the following edits in `apps/api/src/lib/tokens.ts`:

Add the import beside the operators import (line 10):
```ts
import { isOperator } from "./operators.js";
import { isSettingsReadonly } from "./settings-readonly.js";
```

`signAccessToken` (lines 28-35) — new param + claim:
```ts
export async function signAccessToken(projectId: string, profileId: string, role: string, operator = false, steward = false, owner = false, admin = false, settingsReadonly = false): Promise<string> {
  return new SignJWT({ role, operator, steward, powner: owner, padmin: admin, settingsReadonly, pid: projectId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(profileId)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL}s`)
    .sign(accessSecret);
}
```

`mintSession` (lines 53-59) — new param BEFORE `familyId`, forwarded to `signAccessToken`:
```ts
export async function mintSession(projectId: string, profileId: string, role: string, operator = false, steward = false, owner = false, admin = false, settingsReadonly = false, familyId?: string): Promise<SessionTokens> {
  const family = familyId ?? randomUUID();
  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(projectId, profileId, role, operator, steward, owner, admin, settingsReadonly),
    issueRefreshToken(projectId, profileId, family),
  ]);
  return { accessToken, refreshToken };
}
```

`profileAuthBits` (lines 131-143) — return the bit:
```ts
async function profileAuthBits(projectId: string, profileId: string): Promise<{ role: string; operator: boolean; owner: boolean; admin: boolean; steward: boolean; settingsReadonly: boolean }> {
  const [p] = await getDb().select({ id: profiles.id, role: profiles.role, email: profiles.email })
    .from(profiles).where(eq(profiles.id, profileId)).limit(1);
  if (!p) return { role: "visitor", operator: false, owner: false, admin: false, steward: false, settingsReadonly: false };
  const roles = await getProjectRoles(projectId, p.id);
  return {
    role: p.role,
    operator: isOperator(p),
    owner: roles.has("owner"),
    admin: roles.has("admin"),
    steward: roles.has("steward") || roles.has("admin") || roles.has("owner"),
    settingsReadonly: isSettingsReadonly(p),
  };
}
```

The two rotate-path callers (lines 94-95 and 109-110) — destructure and pass the bit before `row.familyId`:
```ts
      const { role, operator, owner, admin, steward, settingsReadonly } = await profileAuthBits(projectId, row.profileId);
      return { ...(await mintSession(projectId, row.profileId, role, operator, steward, owner, admin, settingsReadonly, row.familyId)), profileId: row.profileId };
```
Apply that same two-line replacement at BOTH sites (the grace-window replay at ~94-95 and the normal rotation at ~109-110).

- [ ] **Step 9: Compute + pass the bit at sign-in** in `apps/api/src/routes/auth.ts`.

Add the import (beside `isOperator`; find the existing `isOperator` import and add):
```ts
import { isSettingsReadonly } from "../lib/settings-readonly.js";
```

`authBits` (lines 78-82) — return the bit:
```ts
  const roles = await getProjectRoles(projectId, profile.id);
  const owner = roles.has("owner");
  const admin = roles.has("admin");
  return { operator: isOperator(profile), owner, admin, steward: roles.has("steward") || admin || owner, settingsReadonly: isSettingsReadonly(profile) };
}
```

`sessionResponse` (line 90) — pass it to `mintSession` (destructure `settingsReadonly` from the `authBits` result and forward it):
```ts
  const [suspensions, { operator, owner, admin, steward, settingsReadonly }] = await Promise.all([
    getDb().select().from(userSuspensions).where(eq(userSuspensions.profileId, profile.id)),
    authBits(projectId, profile),
  ]);
  const { accessToken, refreshToken } = await mintSession(projectId, profile.id, profile.role, operator, steward, owner, admin, settingsReadonly);
```

`change-password` handler (line 173) — pass `b.settingsReadonly`:
```ts
    const b = await authBits(projectId, profile);
    return c.json({ success: true, ...(await mintSession(projectId, profile.id, profile.role, b.operator, b.steward, b.owner, b.admin, b.settingsReadonly)) });
```

> Note: `apps/api/src/routes/misc.ts:104`'s `mintSession(projectId, profile.id, profile.role)` (OAuth callback) is intentionally left on defaults — that path grants no operator/owner, so the account can't reach the settings endpoints anyway; the `settingsReadonly` default of `false` is correct and safe there.

- [ ] **Step 10: Add the token-claim round-trip test.** Append to `apps/api/src/lib/tokens.test.ts` inside the `describe("signAccessToken", …)` block:

```ts
  it("defaults the settingsReadonly claim to false", async () => {
    const token = await signAccessToken(projectId, "p", "visitor");
    const { payload } = await jwtVerify(token, secret);
    expect(payload.settingsReadonly).toBe(false);
  });

  it("carries settingsReadonly = true when requested", async () => {
    // positional: (projectId, profileId, role, operator, steward, owner, admin, settingsReadonly)
    const token = await signAccessToken(projectId, "p", "visitor", true, false, false, false, true);
    const { payload } = await jwtVerify(token, secret);
    expect(payload.settingsReadonly).toBe(true);
    expect(payload.operator).toBe(true);
  });
```

- [ ] **Step 11: Build + typecheck + unit test the whole flow**

Run: `pnpm --filter @agora-server/contract build && pnpm --filter @agora/core build`
Then: `pnpm -r typecheck`
Then: `cd apps/api && pnpm test -- settings-readonly tokens`
Expected: contract+core build clean; typecheck 5/5 clean; unit tests PASS (resolver 5 + token suite incl. 2 new).

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/lib/settings-readonly.ts apps/api/src/lib/settings-readonly.test.ts \
  packages/core/src/lib/env.ts packages/contract/src/types.ts packages/core/src/middleware/auth.ts \
  apps/api/src/lib/tokens.ts apps/api/src/lib/tokens.test.ts apps/api/src/routes/auth.ts
git commit -m "feat(auth): settingsReadonly allowlist → JWT claim → c.var.auth pipeline"
```

---

## Task 2: Enforce the cap on the five settings-save handlers + UI alignment

Adds the guard and wires it into exactly the five locked endpoints, re-enables the recompute button under the deployment read-only flag, and proves the whole contract with integration tests (5 blocked, 2 actions + a member write allowed).

**Files:**
- Modify: `apps/api/src/lib/project-roles.ts` (add `assertSettingsWritable`)
- Modify: `apps/api/src/routes/misc.ts` (5 handlers: lines ~118, ~143, ~165, ~182, ~220)
- Modify: `apps/admin/src/routes/settings/SocialGraphPanel.tsx` (recompute button ~line 380)
- Modify: `apps/api/test/integration/helpers.ts` (signToken param)
- Test: `apps/api/src/lib/project-roles.test.ts` (new — guard unit test), `apps/api/test/integration/settings-readonly.test.ts` (new)

**Interfaces:**
- Consumes: `c.var.auth.settingsReadonly` (Task 1); `requireProjectAdmin(c)`, `isProjectAdmin`, `Errors.forbidden(code,msg)`, `Ctx = Context<{ Variables }>` (existing in `project-roles.ts`).
- Consumes: `signToken(userId, role, operator, steward, owner, admin, projectId?)` (existing integration helper).
- Produces: `assertSettingsWritable(c: Ctx): void` — throws `403 settings/read-only` when `c.var.auth.settingsReadonly`; `signToken(..., projectId?, settingsReadonly=false)`.

- [ ] **Step 1: Write the failing guard unit test.** Create `apps/api/src/lib/project-roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertSettingsWritable } from "./project-roles.js";
import { ApiError } from "../http/errors.js";

// assertSettingsWritable reads c.var.auth.settingsReadonly and throws 403 settings/read-only when set.
// Build a minimal fake Hono context — only c.var.auth is read.
const ctx = (settingsReadonly: boolean) =>
  ({ var: { auth: { settingsReadonly } } }) as unknown as Parameters<typeof assertSettingsWritable>[0];

describe("assertSettingsWritable", () => {
  it("is a no-op when the caller is not settings-read-only", () => {
    expect(() => assertSettingsWritable(ctx(false))).not.toThrow();
  });

  it("throws 403 settings/read-only for a settings-read-only caller", () => {
    try {
      assertSettingsWritable(ctx(true));
      throw new Error("expected assertSettingsWritable to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
      expect((e as ApiError).code).toBe("settings/read-only");
    }
  });
});
```

> Verify the `ApiError` shape before writing the assertion: open `apps/api/src/http/errors.ts` (or `packages/core/src/http/errors.ts`) and confirm the property names are `.status` and `.code`. If they differ, match them here.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/api && pnpm test -- project-roles`
Expected: FAIL — `assertSettingsWritable` is not exported.

- [ ] **Step 3: Add the guard** to `apps/api/src/lib/project-roles.ts`, immediately after `requireProjectAdmin` (line 26):

```ts
export function requireProjectAdmin(c: Ctx): void {
  if (!isProjectAdmin(c.var.auth!)) throw Errors.forbidden("roles/admin-only", "Project admin access required");
}
/** Block a settings-read-only principal (the demo login) from persisting settings. Call AFTER
 *  requireProjectAdmin — the caller is already a confirmed admin; this is the narrowest final gate. */
export function assertSettingsWritable(c: Ctx): void {
  if (c.var.auth!.settingsReadonly) throw Errors.forbidden("settings/read-only", "This account cannot change settings");
}
```

- [ ] **Step 4: Run the guard test to green**

Run: `cd apps/api && pnpm test -- project-roles`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the guard into the five locked handlers** in `apps/api/src/routes/misc.ts`. First ensure the import includes it (find the existing `requireProjectAdmin` import from `../lib/project-roles.js` and add `assertSettingsWritable`):

```ts
import { requireProjectAdmin, assertSettingsWritable } from "../lib/project-roles.js";
```

Then, in **each** of these five handlers, add `assertSettingsWritable(c);` on the line right after `await requireProjectAdmin(c);`:

1. `.patch("/webhooks/config", …)` (~line 118)
2. `.patch("/settings/feed", …)` (~line 143)
3. `.patch("/settings/steward", …)` (~line 165)
4. `.patch("/settings/moderator", …)` (~line 182)
5. `.patch("/settings/social", …)` (~line 220)

Each becomes, e.g.:
```ts
  .patch("/settings/feed", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    assertSettingsWritable(c);
    // …unchanged body…
```

Do **not** add it to the GET handlers, to `.post("/webhooks/test", …)`, or to `admin.ts`'s constellation recompute.

- [ ] **Step 6: Re-enable the recompute button under read-only** in `apps/admin/src/routes/settings/SocialGraphPanel.tsx` (~line 380). Remove `|| SETTINGS_READ_ONLY` from the recompute button's `disabled`:

```tsx
                  <Button
                    type="button"
                    variant="outline"
                    disabled={recompute.isPending}
                    onClick={() => recompute.mutate()}
                  >
```

Leave the five Save buttons and the `SETTINGS_READ_ONLY` view-only banner unchanged.

- [ ] **Step 7: Extend the integration `signToken` helper** in `apps/api/test/integration/helpers.ts` — add an optional trailing param that stamps the claim:

```ts
export function signToken(
  userId: string,
  role = "visitor",
  operator = false,
  steward = false,
  owner = false,
  admin = false,
  projectId?: string,
  settingsReadonly = false,
) {
  return new SignJWT({ role, operator, steward, powner: owner, padmin: admin, ...(projectId ? { pid: projectId } : {}), ...(settingsReadonly ? { settingsReadonly: true } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setExpirationTime("1h")
    .sign(secret);
}
```

- [ ] **Step 8: Write the integration test.** Create `apps/api/test/integration/settings-readonly.test.ts`:

```ts
// The settings-read-only cap: a demo operator (operator claim + settingsReadonly claim) is blocked on
// the five settings-SAVE endpoints (403 settings/read-only) but stays free everywhere else — the two
// non-destructive actions and ordinary member writes. A plain operator (no cap) saves normally.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, base, createProject, createUser, deleteProject, signToken } from "./helpers.js";

describe("settings read-only cap", () => {
  let projectId: string;
  let B: string;
  let op: { id: string; token: string };       // plain operator — can save
  let demo: { id: string; token: string };      // operator + settingsReadonly — blocked on saves

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    const a = await createUser(projectId);
    const d = await createUser(projectId);
    // operator claim = arg 3; settingsReadonly = arg 8 (projectId = arg 7).
    op = { id: a.id, token: await signToken(a.id, "visitor", true, false, false, false, projectId) };
    demo = { id: d.id, token: await signToken(d.id, "visitor", true, false, false, false, projectId, true) };
  });

  afterAll(async () => {
    await deleteProject(projectId);
  });

  // Each locked endpoint: demo → 403 settings/read-only; plain operator → not 403 (allowed through the cap).
  const locked: Array<[string, string, Record<string, unknown>]> = [
    ["PATCH", "/settings/feed", { gravity: 1.5 }],
    ["PATCH", "/settings/moderator", { blockAutoActionThreshold: 0.9 }],
    ["PATCH", "/settings/steward", { notifyPolicy: "both" }],
    ["PATCH", "/settings/social", { graphEnabled: false }],
    ["PATCH", "/webhooks/config", { url: "https://example.com/hook" }],
  ];

  for (const [method, path, body] of locked) {
    it(`blocks the read-only principal on ${method} ${path}`, async () => {
      const res = await api(method, `${B}${path}`, { token: demo.token, body });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("settings/read-only");
    });

    it(`allows a plain operator through the cap on ${method} ${path}`, async () => {
      const res = await api(method, `${B}${path}`, { token: op.token, body });
      expect(res.status).not.toBe(403); // 200 on success; never the settings/read-only 403
    });
  }

  // Scope proof: the cap is settings-SAVES only — the read-only principal keeps its other powers.
  it("still lets the read-only principal run the two non-destructive actions", async () => {
    // webhooks test: 400 webhooks/not-configured is fine (proves it passed the cap and ran the handler).
    const test = await api("POST", `${B}/webhooks/test`, { token: demo.token });
    expect(test.status).not.toBe(403);

    const recompute = await api("POST", `${B}/admin/social/constellation/recompute`, { token: demo.token });
    expect(recompute.status).not.toBe(403);
  });

  it("still lets the read-only principal do an ordinary member write (create entity)", async () => {
    const res = await api("POST", `${B}/entities`, {
      token: demo.token,
      body: { foreignId: `fk-${Date.now()}`, type: "post", title: "demo can still post" },
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.error).toBeUndefined();
  });
});
```

> Before running, confirm the `POST /entities` body shape against `apps/api/test/integration/entities.test.ts` (use whatever minimal create body that suite uses) and adjust if needed — the point is only that it is NOT a 403.

- [ ] **Step 9: Run the integration test**

Run: `cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts settings-readonly`
Expected: PASS — 5 blocked (403 settings/read-only), 5 operator-allowed, 2 scope-proof cases green.
(Requires `TEST_DATABASE_URL`. If unset, provision a local Postgres and point `TEST_DATABASE_URL` at it; do not paste credentials into any committed file.)

- [ ] **Step 10: Full build + typecheck + unit suite**

Run: `pnpm -r build && pnpm -r typecheck && cd apps/api && pnpm test`
Expected: build clean, typecheck clean, unit suite green (incl. the new `project-roles` guard test).

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/lib/project-roles.ts apps/api/src/lib/project-roles.test.ts \
  apps/api/src/routes/misc.ts apps/admin/src/routes/settings/SocialGraphPanel.tsx \
  apps/api/test/integration/helpers.ts apps/api/test/integration/settings-readonly.test.ts
git commit -m "feat(settings): block settings-read-only principal from the five save endpoints"
```

---

## Task 3: Config, email rename, docs & propagation

Turns the feature on for the demo account, renames the default admin email onto the project domain across live surfaces, and updates the contract/security docs, changelog, and propagation mirrors. No application logic — verified by grep + `check:propagation` + typecheck.

**Files:**
- Modify: `.env.dev.example`, `.env.selfhost.example`, `.env.prod.example`
- Modify: seed scripts (rename `DEMO_EMAIL` default): `apps/api/scripts/seeds/00-seed-auth-admin.mjs`, `apps/api/scripts/seeds/helpers/seed-supabase-auth-admin.mjs`, `apps/api/scripts/seeds/04-seed-homepage-comments.mjs`, and every `apps/api/scripts/seeds/seed-*-post.mjs`
- Modify: `CLAUDE.md`, `docs/SELF-HOSTING.md`, `docs/DEVELOPMENT.md`, `apps/admin/README.md`, `apps/api/README.md`
- Modify: `docs/MANIFEST.md`, `docs/SECURITY.md`, `CHANGELOG.md`

**Interfaces:** none (config + docs).

- [ ] **Step 1: Env templates — add the var and enable the demo account.**

In `.env.dev.example` (line 29) and `.env.selfhost.example` (line 30), replace the `OPERATOR_EMAILS` line and add the new var directly beneath:
```bash
OPERATOR_EMAILS=agora-admin@agora-oss.org,demo-admin@agora-oss.org
# Accounts allowed a settings-read-only operator view (the shared public demo login): full operator
# visibility + the two non-destructive actions, but the five settings-save endpoints return 403.
# Comma-separated, case-insensitive emails. Empty/unset = feature off.
SETTINGS_READONLY_EMAILS=demo-admin@agora-oss.org
```

In `.env.selfhost.example` (line 132), rename `AGORA_DEMO_EMAIL`:
```bash
AGORA_DEMO_EMAIL=agora-admin@agora-oss.org
```

In `.env.prod.example`, after the `OPERATOR_EMAILS=<you@your.domain>` line (line 28), add the documented var with an empty default (prod operators opt in per deployment):
```bash
# Settings-read-only operator accounts (e.g. a shared demo login). Comma-separated emails; empty = off.
SETTINGS_READONLY_EMAILS=
```

- [ ] **Step 2: Rename the email in the seed scripts.** These use `process.env.DEMO_EMAIL || "agora-admin@gmail.com"` (the post seeders + `04-seed-homepage-comments.mjs` + the supabase auth helper) or a `const DEMO_EMAIL = "agora-admin@gmail.com"` (`00-seed-auth-admin.mjs`). Rename the literal only:

```bash
cd /Users/jenova/projects/jenova-marie/agora-server
# All seed scripts under scripts/seeds (post seeders, homepage comments, the master, the supabase helper):
grep -rl 'agora-admin@gmail\.com' apps/api/scripts/seeds \
  | xargs sed -i '' 's/agora-admin@gmail\.com/agora-admin@agora-oss.org/g'
# Verify none remain in the seed tree:
grep -rn 'agora-admin@gmail\.com' apps/api/scripts/seeds && echo "STILL PRESENT — investigate" || echo "seed tree clean"
```

- [ ] **Step 3: Rename in live docs.** Update the current-default references (NOT changelog history, NOT the 2026-07-01 plan, NEVER `docs/PENTEST.md`):

```bash
cd /Users/jenova/projects/jenova-marie/agora-server
for f in CLAUDE.md docs/SELF-HOSTING.md docs/DEVELOPMENT.md apps/admin/README.md apps/api/README.md; do
  sed -i '' 's/agora-admin@gmail\.com/agora-admin@agora-oss.org/g' "$f"
done
# Confirm the excluded files were untouched and still hold the old string (expected):
grep -c 'agora-admin@gmail\.com' docs/PENTEST.md CHANGELOG.md docs/superpowers/plans/2026-07-01-env-config-cleanup.md
```
Expected: the five live docs no longer contain the old email; `docs/PENTEST.md`, `CHANGELOG.md`, and the 2026-07-01 plan still do (untouched historical records).

- [ ] **Step 4: MANIFEST — document the 403.** In `docs/MANIFEST.md`, in the admin/settings section that lists `PATCH /settings/*` + `PATCH /webhooks/config`, add one line:

> The five settings-save endpoints (`PATCH /settings/feed|moderator|steward|social`, `PATCH /webhooks/config`) return `403 settings/read-only` for a settings-read-only principal (`SETTINGS_READONLY_EMAILS`); the read actions and `POST /webhooks/test` + `POST /admin/social/constellation/recompute` remain available.

- [ ] **Step 5: SECURITY.md — add the posture bullet.** Under the security-model section, add:

> - **Settings-read-only principals** (`SETTINGS_READONLY_EMAILS`): a shared demo/operator login can hold the full operator view yet is server-blocked (`assertSettingsWritable`, after the project-admin gate) from persisting any of the five settings-save endpoints. Per-identity and server-enforced — independent of, and stricter than, the client-side `VITE_SETTINGS_READ_ONLY` display flag. Additive; no existing gate is relaxed.

- [ ] **Step 6: CHANGELOG — Unreleased entry.** Under `## [Unreleased]`:

```markdown
### Added
- **Settings-read-only operator** — `SETTINGS_READONLY_EMAILS` (comma-separated emails) marks accounts
  that get the full operator/admin view but are blocked (`403 settings/read-only`) from the five
  settings-save endpoints (`PATCH /settings/feed|moderator|steward|social`, `PATCH /webhooks/config`).
  Non-destructive actions (`POST /webhooks/test`, constellation recompute) and ordinary member writes
  stay available. Powers the shared public demo login `demo-admin@agora-oss.org`.

### Changed
- Default seeded-admin email renamed `agora-admin@gmail.com` → `agora-admin@agora-oss.org` (templates +
  seed scripts + docs). Existing deployments are unaffected (their `.env` is already set); only the
  template default and fresh seeds change.
```

- [ ] **Step 7: Run the propagation checker.**

Run: `cd apps/api && pnpm check:propagation --diff root`
Expected: no unsatisfied obligations for `SETTINGS_READONLY_EMAILS` across the three `.env.*.example` files (all now declare it). Resolve anything it flags (e.g. a wiki mirror) per its output.

- [ ] **Step 8: Typecheck (docs/config touched no code, but confirm nothing regressed)**

Run: `pnpm -r typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add .env.dev.example .env.selfhost.example .env.prod.example apps/api/scripts/seeds \
  CLAUDE.md docs/SELF-HOSTING.md docs/DEVELOPMENT.md apps/admin/README.md apps/api/README.md \
  docs/MANIFEST.md docs/SECURITY.md CHANGELOG.md
git commit -m "chore(demo): enable settings-read-only demo operator + rename default admin email"
```

---

## Self-Review (author checklist — completed)

**Spec coverage:** Mechanism (allowlist→claim) → Task 1. Five locked endpoints + guard → Task 2. Frontend recompute line → Task 2 Step 6. Demo-admin operator+readonly config → Task 3 Step 1. Email rename (live only, exclusions honored) → Task 3 Steps 2-3. Tests (unit resolver+guard+token, integration per-route+scope) → Tasks 1-2. Docs/propagation (env schema, templates, MANIFEST, SECURITY, CHANGELOG) → Tasks 1 & 3. All spec sections mapped.

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step carries full code; every command has an expected result.

**Type consistency:** `settingsReadonly` used identically across contract type, middleware, `signAccessToken`/`mintSession`/`profileAuthBits`/`authBits`, `signToken`, and the guard. Parameter order fixed and repeated verbatim at all call sites (`…, admin, settingsReadonly[, familyId]`). Error code `settings/read-only` and env name `SETTINGS_READONLY_EMAILS` consistent throughout.

**Correction vs spec:** `PATCH /settings/social` lives in `apps/api/src/routes/misc.ts` (not `social.ts` as the spec's table said); all five locked handlers are in `misc.ts`. Reflected in Task 2.
