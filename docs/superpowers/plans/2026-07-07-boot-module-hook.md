# Boot-Module Hook (`AGORA_BOOT_MODULE`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a prebuilt agora-server image a documented boot hook — `AGORA_BOOT_MODULE` — so the closed hosting layer can register its per-project DB resolver (and other init) once at startup, before serving, without editing the bundled entrypoint.

**Architecture:** A tiny shared kernel function `loadBootModule(specifier)` in `@agora/core` side-effect-imports an operator-supplied module. Both entrypoints (`apps/api`, `apps/secure-chat`) call it after env/logger/OTel are ready and before `serve()`, failing **closed** (exit 1) if a configured module throws. Unset → byte-for-byte today's boot. One extra guard test proves app construction resolves no project DB, so registration always precedes the first `resolveDbFor`.

**Tech Stack:** TypeScript (ESM, top-level await), pnpm workspaces, Zod (env schema), Vitest (unit), Hono.

**Spec:** `docs/superpowers/specs/2026-07-07-boot-module-hook-design.md`

## Global Constraints

- **Single mechanism only.** `AGORA_BOOT_MODULE` is the sole supported hook. `NODE_OPTIONS=--import` is NOT wired and NOT documented as supported — do not add it anywhere.
- **Fail closed.** A configured-but-failing boot module → log + `process.exit(1)`, never serve. Unset/empty → no-op.
- **Build order.** `@agora/core` is consumed as built `dist/` by api + secure-chat. After changing core, run `pnpm --filter @agora/core build` before typechecking/testing the apps.
- **Logging (Log-with-intent).** Use the shared `logger`. `info`/`error` are **message-only strings**; the raw `{ err }` goes ONLY on `logger.debug`. Never `console.*`.
- **Import-path style.** From apps, import core libs WITHOUT a `.js` suffix (e.g. `@agora/core/lib/boot`), matching the existing `@agora/core/lib/suspensions` sites. Within a package, relative imports keep the `.js` suffix (e.g. `./boot.js`).
- **Commits require explicit per-run authorization** (standing rule — never commit without asking, even plan-embedded commit steps). Before Task 1, confirm authorization for this run's commits. All commits use DCO sign-off (`git commit -s`) and end with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Done bar.** `pnpm -r typecheck` **and** `pnpm test` (all packages) pass before the work is considered complete.

---

### Task 1: `loadBootModule` kernel function + unit tests

**Files:**
- Create: `packages/core/src/lib/boot.ts`
- Create: `packages/core/src/lib/boot.test.ts`
- Create: `packages/core/src/lib/__fixtures__/boot-ran.ts`
- Create: `packages/core/src/lib/__fixtures__/boot-throws.ts`

**Interfaces:**
- Consumes: nothing (leaf module — no `@agora/core` internals).
- Produces: `loadBootModule(specifier: string | undefined): Promise<string | null>` — resolves to the specifier if a module was imported, `null` if `specifier` is falsy (unset/empty); rejects (propagates) if the import throws. Exported from `@agora/core/lib/boot` (auto-resolved via core's `"./*"` exports wildcard — no `package.json` edit needed).

- [ ] **Step 1: Write the two test fixtures**

`packages/core/src/lib/__fixtures__/boot-ran.ts`:
```ts
// Test fixture for loadBootModule — its import side effect increments a global counter, so a test can
// prove the module was actually evaluated. NOT a *.test.ts file, so vitest never collects it as a suite.
const g = globalThis as Record<string, unknown>;
g.__agoraBootRan = ((g.__agoraBootRan as number | undefined) ?? 0) + 1;
```

`packages/core/src/lib/__fixtures__/boot-throws.ts`:
```ts
// Test fixture for loadBootModule — throws at module-evaluation time, exercising the fail-closed path.
throw new Error("boot fixture boom");
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/lib/boot.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { loadBootModule } from "./boot.js";

const RAN = new URL("./__fixtures__/boot-ran.ts", import.meta.url).href;
const THROWS = new URL("./__fixtures__/boot-throws.ts", import.meta.url).href;

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__agoraBootRan;
});

describe("loadBootModule", () => {
  it("is a no-op when the specifier is undefined", async () => {
    const result = await loadBootModule(undefined);
    expect(result).toBeNull();
    expect((globalThis as Record<string, unknown>).__agoraBootRan).toBeUndefined();
  });

  it("is a no-op when the specifier is an empty string", async () => {
    const result = await loadBootModule("");
    expect(result).toBeNull();
    expect((globalThis as Record<string, unknown>).__agoraBootRan).toBeUndefined();
  });

  it("imports the module (running its side effect) and returns the specifier", async () => {
    const result = await loadBootModule(RAN);
    expect(result).toBe(RAN);
    expect((globalThis as Record<string, unknown>).__agoraBootRan).toBe(1);
  });

  it("propagates a failure thrown by the boot module", async () => {
    await expect(loadBootModule(THROWS)).rejects.toThrow("boot fixture boom");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @agora/core exec vitest run src/lib/boot.test.ts`
Expected: FAIL — `Cannot find module './boot.js'` / `loadBootModule is not a function`.

- [ ] **Step 4: Write the implementation**

`packages/core/src/lib/boot.ts`:
```ts
// Optional deployment boot hook. Runs an operator-supplied module ONCE at startup, before the server
// serves — the documented way for a PREBUILT image to register a per-project DB resolver (setDbResolver)
// or warm a tenant directory without editing the bundled entrypoint. AGORA_BOOT_MODULE is the SOLE
// supported mechanism. Loaded as a side-effect import: the module does its work at evaluation time
// (top-level await is fine). Unset/empty → no-op, byte-for-byte today's boot.
//
// An import failure PROPAGATES unchanged so the entrypoint can fail CLOSED (refuse to start). There is
// deliberately no swallow-and-continue branch: serving without the configured resolver would silently
// fall back to the shared DB — cross-tenant contamination, the exact failure the resolver seam prevents.
export async function loadBootModule(specifier: string | undefined): Promise<string | null> {
  if (!specifier) return null;
  await import(specifier);
  return specifier;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @agora/core exec vitest run src/lib/boot.test.ts`
Expected: PASS — 4 passed.

- [ ] **Step 6: Build core so the apps can consume the new export**

Run: `pnpm --filter @agora/core build`
Expected: exits 0; `packages/core/dist/lib/boot.js` exists.

- [ ] **Step 7: Commit** *(only after per-run authorization)*

```bash
git add packages/core/src/lib/boot.ts packages/core/src/lib/boot.test.ts packages/core/src/lib/__fixtures__/boot-ran.ts packages/core/src/lib/__fixtures__/boot-throws.ts
git commit -s -m "feat(core): add loadBootModule — the AGORA_BOOT_MODULE boot hook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `AGORA_BOOT_MODULE` env var + fail-closed wiring in both entrypoints

**Files:**
- Modify: `packages/core/src/lib/env.ts` (add one schema field, inside the `z.object({ ... })`)
- Modify: `apps/api/src/index.ts` (add import + glue before `const app = createApp();`)
- Modify: `apps/secure-chat/src/index.ts` (add import + glue before the suspension-hydrate block)

**Interfaces:**
- Consumes: `loadBootModule` from `@agora/core/lib/boot` (Task 1); `env.AGORA_BOOT_MODULE: string | undefined`; the shared `logger`.
- Produces: both server processes honor `AGORA_BOOT_MODULE` at boot (fail-closed). No new exported symbols.

- [ ] **Step 1: Add the env var to the core schema**

In `packages/core/src/lib/env.ts`, inside the `z.object({ ... })`, immediately after the `DATABASE_URL: z.string().url(),` line, add:
```ts
  // Optional deployment boot hook (see @agora/core/lib/boot). A module specifier the entrypoint
  // side-effect-imports ONCE before serving — the documented way for a prebuilt image to register a
  // per-project DB resolver without editing the bundle. Unset → no-op. Empty string treated as unset.
  AGORA_BOOT_MODULE: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
```

- [ ] **Step 2: Rebuild core (the apps typecheck against its dist)**

Run: `pnpm --filter @agora/core build`
Expected: exits 0.

- [ ] **Step 3: Wire the hook into the API entrypoint**

In `apps/api/src/index.ts`, add the import alongside the other `@agora/core/lib/*` imports (immediately after the `import { hydrateSuspensionIndex } from "@agora/core/lib/suspensions";` line):
```ts
import { loadBootModule } from "@agora/core/lib/boot";
```

Then, between the `process.on("uncaughtException", ...)` block and `const app = createApp();`, insert:
```ts
// Optional deployment boot hook — import an operator-supplied module ONCE before serving (registers a
// per-project DB resolver, warms a tenant directory, etc.). Unset → no-op. Fail CLOSED: a configured
// module that fails to load means refuse to start — never serve without it (a silent shared-DB fallback
// would be cross-tenant contamination). AGORA_BOOT_MODULE is the sole supported mechanism.
try {
  const loaded = await loadBootModule(env.AGORA_BOOT_MODULE);
  if (loaded) logger.info("boot module loaded");
} catch (err) {
  logger.error("boot module failed to load — refusing to start");
  logger.debug({ err }, "boot module failed to load — refusing to start");
  process.exit(1);
}
```

- [ ] **Step 4: Wire the hook into the secure-chat entrypoint**

In `apps/secure-chat/src/index.ts`, add the import immediately after the `import { hydrateSuspensionIndex } from "@agora/core/lib/suspensions";` line:
```ts
import { loadBootModule } from "@agora/core/lib/boot";
```

Then, between the `process.on("uncaughtException", ...)` block and the `// Hydrate the Redis suspension index BEFORE listening` comment, insert (so hosting init runs before suspension hydration):
```ts
// Optional deployment boot hook — import an operator-supplied module ONCE before serving (registers a
// per-project DB resolver, etc.). Unset → no-op. Fail CLOSED: a configured module that fails to load
// means refuse to start — never serve without it (mirrors @agora/api). AGORA_BOOT_MODULE is the sole
// supported mechanism.
try {
  const loaded = await loadBootModule(env.AGORA_BOOT_MODULE);
  if (loaded) logger.info("boot module loaded");
} catch (err) {
  logger.error("boot module failed to load — refusing to start");
  logger.debug({ err }, "boot module failed to load — refusing to start");
  process.exit(1);
}
```

- [ ] **Step 5: Typecheck the whole workspace**

Run: `pnpm -r typecheck`
Expected: PASS — no errors. (`env.AGORA_BOOT_MODULE` is typed `string | undefined`; both entrypoints compile with top-level await.)

- [ ] **Step 6: Smoke-test the fail-closed path**

Create a throwing boot module in the scratchpad:
```bash
printf 'throw new Error("smoke");\n' > /Users/jenova/claude/tmp/claude-502/-Users-jenova-projects-jenova-marie-agora-server/5f97bfee-2fab-43fd-93fb-38ad9c081fba/scratchpad/boot-smoke-throws.mjs
```
Run from `apps/api` (uses its real `.env` for env validation, which is schema-only — no DB connection is made before the hook fires):
```bash
cd apps/api && AGORA_BOOT_MODULE="/Users/jenova/claude/tmp/claude-502/-Users-jenova-projects-jenova-marie-agora-server/5f97bfee-2fab-43fd-93fb-38ad9c081fba/scratchpad/boot-smoke-throws.mjs" pnpm exec tsx src/index.ts; echo "exit=$?"
```
Expected: the log line `boot module failed to load — refusing to start`, then `exit=1`, and the process NEVER prints `🏛️  Agora API listening`.

- [ ] **Step 7: Smoke-test the unset (no-op) path**

Run from `apps/api` (no `AGORA_BOOT_MODULE`):
```bash
cd apps/api && pnpm exec tsx src/index.ts
```
Expected: NO `boot module loaded` line; the server reaches `🏛️  Agora API listening` as normal. Stop it with Ctrl-C.

- [ ] **Step 8: Commit** *(only after per-run authorization)*

```bash
git add packages/core/src/lib/env.ts apps/api/src/index.ts apps/secure-chat/src/index.ts
git commit -s -m "feat: wire the AGORA_BOOT_MODULE boot hook into api + secure-chat (fail-closed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Guard test — app construction resolves no project DB (spec #3)

**Files:**
- Create: `apps/api/src/boot-ordering.test.ts`
- Create: `apps/secure-chat/src/boot-ordering.test.ts`

**Interfaces:**
- Consumes: `setDbResolver`/`resetDbResolver` from `@agora/core/db`; `createApp` from `apps/api/src/app.ts`; `createSecureApp` from `apps/secure-chat/src/app.ts`.
- Produces: nothing consumed downstream — this task locks the invariant that `resolveDbFor` runs only at request/task time, never during import or app construction, so the boot hook always registers the resolver first.

- [ ] **Step 1: Write the API guard test**

`apps/api/src/boot-ordering.test.ts`:
```ts
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDbResolver, setDbResolver } from "./db/index.js";
import { createApp } from "./app.js";

// The boot hook registers the per-project resolver before serving. That is only sufficient if nothing
// resolves a DB at import/construction time. Prove construction touches no resolver: a spy that would
// throw if called must stay untouched through createApp().
beforeEach(() => resetDbResolver());
afterEach(() => resetDbResolver());

it("does not resolve a project DB while constructing the app", () => {
  const resolver = vi.fn(async () => {
    throw new Error("resolveDbFor must never run at app-construction time");
  });
  setDbResolver(resolver);

  createApp();

  expect(resolver).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write the secure-chat guard test**

`apps/secure-chat/src/boot-ordering.test.ts`:
```ts
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDbResolver, setDbResolver } from "@agora/core/db";
import { createSecureApp } from "./app.js";

beforeEach(() => resetDbResolver());
afterEach(() => resetDbResolver());

it("does not resolve a project DB while constructing the secure-chat app", () => {
  const resolver = vi.fn(async () => {
    throw new Error("resolveDbFor must never run at app-construction time");
  });
  setDbResolver(resolver);

  createSecureApp();

  expect(resolver).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run both guard tests to verify they pass**

Run: `pnpm --filter @agora/api exec vitest run src/boot-ordering.test.ts && pnpm --filter @agora/secure-chat exec vitest run src/boot-ordering.test.ts`
Expected: PASS in both packages (1 passed each). If either FAILS, that is a real finding — some module resolves a DB at construction time; stop and surface it rather than weakening the test.

- [ ] **Step 4: Run the full unit suites (no regressions)**

Run: `pnpm test`
Expected: all packages' unit suites PASS.

- [ ] **Step 5: Commit** *(only after per-run authorization)*

```bash
git add apps/api/src/boot-ordering.test.ts apps/secure-chat/src/boot-ordering.test.ts
git commit -s -m "test: assert app construction resolves no project DB (boot-hook ordering)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Propagate — docs, env examples, changelog

**Files:**
- Modify: `.env.dev.example`, `.env.selfhost.example`, `.env.prod.example` (add a commented `AGORA_BOOT_MODULE`)
- Modify: `docs/SELF-HOSTING.md` (a short "Boot hook" note)
- Modify: `CLAUDE.md` (one line in the env-knobs paragraph)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `Added`)
- Modify: `docs/PROPAGATION.yaml` (record the intentionally-skipped mirrors under `exceptions:`)

**How `PROPAGATION.yaml` actually works (read before editing it):** it is NOT a per-variable map. The
`env-var:` category already lists every mirror target generically (`.env.*.example` ×3, the three
`docker-compose*.yml`, and prose: `SELF-HOSTING.md`, `README.md`, `CLAUDE.md`, `wiki/Deployment.md`). The
checker derives an obligation for each new env var against *all* of those. You do NOT add a mapping entry;
you fulfill the mirrors that apply and record the ones you intentionally skip under `exceptions:` (exactly
like the existing `MAX_POOLS` block). For `AGORA_BOOT_MODULE` the plan fulfills `.env.*.example`,
`SELF-HOSTING.md`, `CLAUDE.md`, and `CHANGELOG.md`, and excepts the compose files + `README.md` +
`wiki/Deployment.md` (a hosting-layer knob passed via `env_file`, not a user-facing self-host setting).

**Interfaces:**
- Consumes: nothing. Documentation/config mirrors only.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Run the propagation checker to see obligations from this branch's diff**

Run: `cd apps/api && pnpm check:propagation --diff root`
Expected: it reports `AGORA_BOOT_MODULE` as a new env var with unfulfilled mirror obligations across the
`env-var` targets (`.env.*.example`, the compose files, and the prose docs). Use its output to confirm the
edits below clear every obligation (fulfill or except). Optionally drive this with the `/propagate` skill.

- [ ] **Step 2: Add the commented var to all three env examples**

Append to each of `.env.dev.example`, `.env.selfhost.example`, `.env.prod.example` (adapt the surrounding comment style to each file):
```bash
# Optional deployment boot hook. A module specifier the server side-effect-imports ONCE at startup,
# before serving (e.g. to register a per-project DB resolver in a hosted deployment). Unset → no-op.
# If set and the module fails to load, the server refuses to start (fails closed). Hosting-layer knob;
# leave unset for a normal single-project deploy.
# AGORA_BOOT_MODULE=
```

- [ ] **Step 3: Add the "Boot hook" note to `docs/SELF-HOSTING.md`**

Add a short subsection (place it near the environment/deployment discussion):
```markdown
### Boot hook (`AGORA_BOOT_MODULE`)

`AGORA_BOOT_MODULE` is an optional module specifier the `agora` and `secure-chat` processes
**side-effect-import once at startup, before serving** — the supported way for a prebuilt image to run
deployment init (e.g. registering a per-project DB resolver) without editing the bundled entrypoint.
Unset → no-op. If set and the module fails to load, the process **fails closed** (logs and exits) rather
than serve without it. It fires after env validation, the logger, and OpenTelemetry are ready.

This is the **sole supported** mechanism. Node's native `NODE_OPTIONS=--import` can technically preload a
module too, but it runs before env/logger/OTel exist and is **not** a contract Agora documents, relies on,
or tests — if you use it, you are on your own.
```

- [ ] **Step 4: Add a one-line mention to `CLAUDE.md`**

In `CLAUDE.md`, in the `**Env:**` paragraph (the list of optional feature-gating env vars in the Commands
section), add one sentence so future sessions discover the seam:
```markdown
`AGORA_BOOT_MODULE` (a module specifier the api/secure-chat entrypoints side-effect-import once at boot,
before serving — the supported hook for a prebuilt image to register a per-project DB resolver; unset →
no-op, fails closed if a set module throws).
```

- [ ] **Step 5: Add the changelog entry**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:
```markdown
- **Boot hook (`AGORA_BOOT_MODULE`).** Optional module specifier the `agora` and `secure-chat`
  entrypoints side-effect-import once at startup, before serving — lets a prebuilt image register a
  per-project DB resolver (or other init) without editing the bundle. Unset → no-op; a configured module
  that fails to load makes the process fail closed (exit 1). `NODE_OPTIONS=--import` is explicitly not a
  supported mechanism.
```

- [ ] **Step 6: Record the intentionally-skipped mirrors in `docs/PROPAGATION.yaml`**

Append to the `exceptions:` list (mirroring the `MAX_POOLS` block's shape — one `subject`/`target`/`reason`
per skipped target):
```yaml
  # AGORA_BOOT_MODULE is a hosting-layer boot hook (default unset), irrelevant to a single-tenant
  # deployment — which is every deployment of this repo. It ships in the .env templates + CLAUDE.md +
  # SELF-HOSTING.md as a documented seam; compose passes it through env_file (no explicit default), and
  # it has no place in user-facing deploy prose. Hosting init lives in ../agora-hosting.
  - subject: AGORA_BOOT_MODULE
    target: docker-compose.dev.yml
    reason: passed via env_file; hosting-layer knob, no compose default needed
  - subject: AGORA_BOOT_MODULE
    target: docker-compose.yml
    reason: passed via env_file; hosting-layer knob, no compose default needed
  - subject: AGORA_BOOT_MODULE
    target: docker-compose.prod.yml
    reason: passed via env_file; hosting-layer knob, no compose default needed
  - subject: AGORA_BOOT_MODULE
    target: README.md
    reason: hosting-layer seam; documented in SELF-HOSTING.md + CLAUDE.md, not a user-facing self-host knob
  - subject: AGORA_BOOT_MODULE
    target: wiki/Deployment.md
    reason: hosting-layer seam; documented in SELF-HOSTING.md + CLAUDE.md, not a user-facing self-host knob
```

- [ ] **Step 7: Re-run the checker to confirm the obligations clear**

Run: `cd apps/api && pnpm check:propagation --diff root`
Expected: no outstanding `AGORA_BOOT_MODULE` mirror obligations (each is either fulfilled or excepted).

- [ ] **Step 8: Final verification**

Run: `pnpm -r typecheck && pnpm test`
Expected: both PASS.

- [ ] **Step 9: Commit** *(only after per-run authorization)*

```bash
git add .env.dev.example .env.selfhost.example .env.prod.example docs/SELF-HOSTING.md CLAUDE.md CHANGELOG.md docs/PROPAGATION.yaml
git commit -s -m "docs: document the AGORA_BOOT_MODULE boot hook + propagate env mirrors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Do not touch `packages/core/src/db/resolver.ts`.** The seam is complete; this plan only adds the *place to call it from*.
- **No hosting-side code.** The actual boot module lives in the closed `agora-hosting` repo, not here.
- **No cron hook.** The cron container only `curl`s HTTP endpoints; it never resolves a per-project DB.
- If a smoke or guard test reveals eager DB resolution at import/construction time, that is a genuine defect in the touched module — surface it, don't weaken the test.
