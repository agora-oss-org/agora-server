# Boot-module hook (`AGORA_BOOT_MODULE`)

**Date:** 2026-07-07
**Branch:** `feat/hosting-enablement-seam`
**Status:** design approved, pending implementation plan

## Problem

The `feat/hosting-enablement-seam` branch added the per-project DB resolver seam
(`setDbResolver` / `resolveDbFor`, `packages/core/src/db/resolver.ts`). A hosting deployment
registers a resolver **once at boot, before serving** to route each project to its own database.

But `agora-server` ships a **prebuilt image** (`CMD ["node", "dist/index.js"]`). The closed
`agora-hosting` layer consumes that image and cannot edit the bundled `index.js`, so it has no way
to get its `setDbResolver(...)` call to run. It needs a **documented boot hook**: a supported point
where the server imports an operator-supplied module during startup.

## Decision

A single, server-owned mechanism: an **env-named boot module**, `AGORA_BOOT_MODULE`, loaded as a
**side-effect import** at a fixed point in each process's boot sequence.

The hook is **general** ("run your init here before serving"); registering the DB resolver is its
motivating first use, not its only one. A hosting boot module typically also warms a tenant
directory (reads `TENANT_DIRECTORY_KEY` + `REDIS_URL`) and logs through the shared logger — all of
which need env-validation, the logger, and OTel to already be up.

### Rejected alternative: `NODE_OPTIONS=--import`

Dropped from the supported surface. It fires **before** Node reaches agora's init — no validated
env, no structured logger, no OTel — which is strictly worse for a resolver that depends on all
three. It also hands the ordering guarantee (the entire value of the seam) to Node and the operator
instead of the server. Its only unique capability is "preload earlier than agora's init," which
resolver registration never needs.

**Caveat to document verbatim:** dropping `--import` as *supported* does not physically prevent an
operator from using Node's native `--import` — it simply is no longer a contract we document, rely
on, or test. "If you use it, you're on your own." That is the correct posture for a capability-poor
path.

### Contract: side-effect import

Agora does `await import(env.AGORA_BOOT_MODULE)` and nothing more. The module performs its setup at
evaluation time (top-level `await` is fine) — calls `setDbResolver`, warms the tenant directory,
etc. — pulling env/logger/db from `@agora/core` directly (the same singletons the server uses,
since it is the same module registry within the process).

```ts
// hosting's boot module (baked as a thin image layer or mounted):
import { setDbResolver } from "@agora/core/db";
import { logger } from "@agora/core/lib/logger";
import { warmTenantDirectory } from "@agora-hosting/directory";

await warmTenantDirectory();                        // reads TENANT_DIRECTORY_KEY + REDIS_URL
setDbResolver(async (projectId) => /* per-tenant handle */);
logger.info("hosting boot complete");
```

## Components

### 1. `packages/core/src/lib/boot.ts` — the testable unit

Shared by both processes (lives in core like every other kernel module; DRY).

```ts
/** Import the operator's boot module exactly once, before serving. Unset → no-op (today's boot,
 *  byte-for-byte). Returns the resolved specifier if one ran, else null. An import failure
 *  PROPAGATES — the caller owns the exit policy. */
export async function loadBootModule(specifier: string | undefined): Promise<string | null> {
  if (!specifier) return null;
  await import(specifier);
  return specifier;
}
```

Rethrows rather than exiting, so it stays a pure, unit-testable unit; the process-kill policy lives
in the glue.

### 2. Env schema — `packages/core/src/lib/env.ts`

Follows the existing empty-string→undefined convention. Surfaces in both processes automatically
(api re-exports core's env via `apps/api/src/lib/env.ts`).

```ts
AGORA_BOOT_MODULE: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
```

### 3. Glue — both `index.ts` (api + secure-chat, symmetric)

Placed after `env` / `instrument` / `logger` are ready and **before** `createApp()`, the background
sweeps, and `serve()`:

```ts
try {
  const loaded = await loadBootModule(env.AGORA_BOOT_MODULE);
  if (loaded) logger.info("boot module loaded");
} catch (err) {
  logger.error("boot module failed to load — refusing to start");   // message-only (Log-with-intent)
  logger.debug({ err }, "boot module failed to load — refusing to start");
  process.exit(1);
}
```

`apps/secure-chat/src/index.ts` already uses top-level `await`; `apps/api/src/index.ts` gains one
(ESM permits it). Both processes get the identical block — a boot module needs to register the
resolver in *every* process that calls `resolveDbFor`.

## Failure semantics — fail closed

- **Unset** → no-op. Single-tenant / self-host boot is unchanged, byte-for-byte.
- **Set but throws / not found** → log (message-only `error` + `{ err }` on `debug`) then
  `process.exit(1)`. **Do not serve.** A boot module is configured precisely to register the
  per-tenant resolver; serving without it would silently fall back to the shared DB — cross-tenant
  contamination, the exact failure the resolver seam exists to prevent. Refuse to start; the
  orchestrator restarts. This mirrors secure-chat's existing "suspension index hydrate failed →
  `exit(1)`" readiness gate and the resolver's fail-closed doctrine.

## Ordering rationale

The hook runs before any background task or request, so the resolver is registered before the first
`resolveDbFor`. It does **not** need to precede OTel `instrument` (an independent concern), so it
sits after it — giving hosting a validated env, a live logger, and active tracing when its code
runs.

## #3 — DB resolution stays call-time (cheap hardening)

Independent of the mechanism: no per-project handle may be resolved at **module-import or
app-construction time**, so resolver registration is always guaranteed to precede the first
`resolveDbFor`. This is a property of boot ordering, and it dovetails with CLAUDE.md's existing
"never hoist `getDb()` at module scope" rule.

**Encoding (one test):** register a **spy resolver** via `setDbResolver`, then construct the app
(`createApp()` / `createSecureApp()`), and assert the spy was **never called**. That directly proves
route-wiring/construction touches no DB — resolution is call-time only.

## Testing (per CLAUDE.md — pure/branching logic ships with tests)

`packages/core/src/lib/boot.test.ts` (vitest, no DB), against tiny fixture modules:

- **unset / empty** → returns `null`, imports nothing;
- **valid module** → its side effect ran (fixture flips a flag / calls a spy), returns the specifier;
- **throwing module / bad specifier** → rejects (asserts the trigger of the fail-closed path).

Plus the #3 call-time assertion above (in core, or alongside each app's construction test), using a
spy resolver.

## Propagation

New env var + new seam → `/propagate` obligations, run at the end via the propagate skill:

- the three `.env.*.example` files (commented — this is a hosting-layer knob, not a self-host knob);
- `docs/SELF-HOSTING.md` (a short "Boot hook" note, including the `--import`-is-unsupported caveat);
- `CHANGELOG.md` (`Added`);
- `docs/PROPAGATION.yaml` (map the new env var to its mirrors).

## Scope guardrails

- No changes to the resolver itself (`resolver.ts` unchanged).
- No hosting-side code — the boot module lives in the closed `agora-hosting` repo.
- No cron hook — the cron container only `curl`s HTTP endpoints; it never resolves a per-project DB.
- Single mechanism only — `--import` is neither wired nor documented as supported.
