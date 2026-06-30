# Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let devices register/deregister push tokens, serve the VAPID public key unauthenticated, and dispatch FCM/APNs/Web Push to recipients wherever an in-app notification is created — with Web Push as the end-to-end-testable path.

**Architecture:** A `push_devices` table + a `routes/push-notifications.ts` router. Credentials live in the existing `project_integrations` table (VAPID per-project with a global env fallback). A dispatch **provider seam** (`lib/push/`, mirroring `lib/storage/`) routes each device to its platform provider; the orchestration (`dispatchToDevices`) is pure and unit-tested with mocked providers, and `dispatchToUser` wraps it with the DB load + stale-token pruning. The trigger is the single existing notification choke point (`lib/notifications.ts` `insert()`).

**Tech Stack:** Hono, Drizzle ORM, zod (contract), `web-push` (RFC 8030/8292), `jose` (already a dep — FCM OAuth JWT + APNs ES256 JWT), Node `http2` (APNs), vitest (unit + integration).

## Global Constraints

- **Security-first.** `POST/DELETE /devices` require `requireAuth`. `GET /vapid-public-key` is intentionally unauthenticated (public key, pre-sign-in) — covered by the edge rate-limiter already mounted on `/v7/*`. Never log credentials, tokens, or subscriptions: `info`/`error` are message-only; raw detail only on `logger.debug({ err }, "…")`.
- **Upsert + idempotency.** Register dedupes native on `(project_id, user_id, platform, token)`, web on `(project_id, user_id, subscription->>'endpoint')`. Delete is idempotent (`204` even when unknown). `DELETE /devices` (SDK contract) **plus** a proxy-safe `POST /devices/deregister` alias.
- **VAPID scope:** per-project (`project_integrations` `name='vapid'`) with a deployment-wide env fallback (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`). Absent both → web push disabled, `vapid-public-key` returns `{ publicKey: null }`.
- **Trigger:** mirror in-app notifications — dispatch from `lib/notifications.ts` `insert()`, fire-and-forget (never block the request; failures logged, not thrown).
- **All three transports** implemented behind the seam; Web Push is fully exercised in tests (self-generated VAPID). FCM/APNs are complete but credential-gated (skipped when `project_integrations` lacks `fcm`/`apns`).
- **Stale-token pruning:** delete the device row on FCM/APNs "unregistered"/"not registered" and Web Push `404`/`410 Gone`.
- **Migration:** hand-authored, idempotent; new table ships its own RLS deny-all; `when` > current journal max; apply with `pnpm db:migrate:run`. Confirm the next free migration number at execution time (this plan assumes `0055`, after the inbox `0053` + events `0054`).
- `pnpm -r typecheck`, `pnpm --filter @agora/api test`, and (DB tasks) the integration suite must pass before a task is done.
- Integration harness (`test/integration/helpers.js`): `createProject()`, `createUser(projectId) → { id, token }`, `api(method, path, { token?, body? }) → { status, body }`, `base(projectId)`, `deleteProject(projectId)`. Single file: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts <name>`.

---

### Task 1: Schema + env — `push_devices` and VAPID vars

**Files:**
- Create: `packages/core/src/db/schema/push.ts`
- Modify: `packages/core/src/db/schema/index.ts` (barrel)
- Modify: `packages/core/src/lib/env.ts` (VAPID vars)

**Interfaces:**
- Produces Drizzle table `pushDevices` (`@agora/core/db`) and env `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` (all optional).

- [ ] **Step 1: Create the schema file**

```ts
// packages/core/src/db/schema/push.ts
// push_devices — per-user OS push registrations (SDK v7.6.2). The platform CHECK + the two partial
// UNIQUE indexes (native by token, web by subscription->>'endpoint') are added in the custom migration
// (Drizzle can't express a partial unique on a jsonb expression).
import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { projects, profiles } from "./projects.js";

export const pushDevices = pgTable("push_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(), // 'ios' | 'android' | 'web' (CHECK in migration)
  token: text("token"),                  // native APNs/FCM token
  subscription: jsonb("subscription"),   // web: { endpoint, keys: { p256dh, auth } }
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("push_devices_user_idx").on(t.projectId, t.userId),
]);
```

- [ ] **Step 2: Barrel export**

In `packages/core/src/db/schema/index.ts`, add after the `./misc.js` line:

```ts
export * from "./push.js";
```

- [ ] **Step 3: Add the VAPID env vars**

In `packages/core/src/lib/env.ts`, inside the `z.object({ … })` schema (near the other optional vars,
e.g. after the `S3_*` block), add:

```ts
  VAPID_PUBLIC_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  VAPID_PRIVATE_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  VAPID_SUBJECT: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()), // mailto: or https URL
```

- [ ] **Step 4: Build the kernel + typecheck**

Run (from repo root): `pnpm --filter @agora/core build && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/schema/push.ts packages/core/src/db/schema/index.ts packages/core/src/lib/env.ts
git commit -m "feat(schema): push_devices table + VAPID env vars"
```

---

### Task 2: Migration — `push_devices` (CHECK, partial uniques, RLS)

**Files:**
- Create: `apps/api/drizzle/0055_push_devices.sql` (confirm number first)
- Modify: `apps/api/drizzle/meta/_journal.json`

- [ ] **Step 1: Confirm the next free number**

Run (from `apps/api`): `ls drizzle/*.sql | tail -3`. Use the next integer; adjust filename + journal
`tag` + `when` (= current max `when` + 1) if it isn't `0055`.

- [ ] **Step 2: Write the migration**

```sql
-- apps/api/drizzle/0055_push_devices.sql
-- Per-user push registrations. Platform CHECK + the two partial UNIQUE indexes (native token / web
-- endpoint). Idempotent + RLS deny-all (new tables aren't covered by the 0017 guard).
SET search_path TO public, extensions;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "token" text,
  "subscription" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "push_devices_platform_chk" CHECK ("platform" IN ('ios','android','web')),
  CONSTRAINT "push_devices_shape_chk" CHECK (
       ("platform" IN ('ios','android') AND "token" IS NOT NULL AND "subscription" IS NULL)
    OR ("platform" = 'web' AND "subscription" IS NOT NULL AND "token" IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_devices_native_unique"
  ON "push_devices" ("project_id","user_id","platform","token") WHERE "platform" IN ('ios','android');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_devices_web_unique"
  ON "push_devices" ("project_id","user_id",("subscription"->>'endpoint')) WHERE "platform" = 'web';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_devices_user_idx" ON "push_devices" ("project_id","user_id");
--> statement-breakpoint
ALTER TABLE "push_devices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "push_devices"; CREATE POLICY "deny_all" ON "push_devices" FOR ALL USING (false) WITH CHECK (false);
```

- [ ] **Step 3: Append the journal entry**

In `apps/api/drizzle/meta/_journal.json`, append (idx = previous + 1, `when` = previous max + 1):

```json
		,{
			"idx": 55,
			"version": "7",
			"when": 1781934611653,
			"tag": "0055_push_devices",
			"breakpoints": true
		}
```

- [ ] **Step 4: Apply + verify**

Run (from `apps/api`):

```bash
pnpm db:migrate:run
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
psql "$url" -c "\d+ push_devices" | grep -E "platform|subscription|unique"
pnpm db:migrate:run   # idempotent no-op
```

Expected: table + both partial unique indexes present; second run applies nothing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/drizzle/0055_push_devices.sql apps/api/drizzle/meta/_journal.json
git commit -m "feat(db): push_devices migration"
```

---

### Task 3: Contract — device-identifier schema + PushDevice type

**Files:**
- Create: `packages/contract/src/push.ts`
- Modify: `packages/contract/src/index.ts`
- Test: `apps/api/src/lib/contract-schemas.test.ts`

**Interfaces:**
- Produces (from `@agora-server/contract`): `pushDeviceSchema` (discriminated union), types `PushDeviceIdentifier`, `PushDevice`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/lib/contract-schemas.test.ts`:

```ts
import { pushDeviceSchema } from "@agora-server/contract";

describe("pushDeviceSchema", () => {
  it("accepts a native identifier", () => {
    expect(pushDeviceSchema.safeParse({ platform: "ios", token: "abc" }).success).toBe(true);
    expect(pushDeviceSchema.safeParse({ platform: "android", token: "abc" }).success).toBe(true);
  });
  it("accepts a web subscription", () => {
    expect(pushDeviceSchema.safeParse({ platform: "web", subscription: { endpoint: "https://x", keys: { p256dh: "p", auth: "a" } } }).success).toBe(true);
  });
  it("rejects native without a token and web without a subscription", () => {
    expect(pushDeviceSchema.safeParse({ platform: "ios" }).success).toBe(false);
    expect(pushDeviceSchema.safeParse({ platform: "web", token: "abc" }).success).toBe(false);
    expect(pushDeviceSchema.safeParse({ platform: "desktop", token: "abc" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- contract-schemas`
Expected: FAIL — `pushDeviceSchema` not exported.

- [ ] **Step 3: Write the contract module**

```ts
// packages/contract/src/push.ts
// Push device registration identifiers (SDK PushDeviceIdentifier union). Pure zod + types.
import { z } from "zod";

const nativeDevice = z.object({
  platform: z.enum(["ios", "android"]),
  token: z.string().min(1),
});
const webDevice = z.object({
  platform: z.literal("web"),
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
});
export const pushDeviceSchema = z.discriminatedUnion("platform", [nativeDevice, webDevice]);

export type PushDeviceIdentifier = z.infer<typeof pushDeviceSchema>;
export interface PushDevice {
  id: string; projectId: string; userId: string;
  platform: "ios" | "android" | "web";
  token: string | null;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } } | null;
  createdAt: string; updatedAt: string;
}
```

In `packages/contract/src/index.ts`, add `export * from "./push.js";`, then rebuild:

```bash
pnpm --filter @agora-server/contract build
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- contract-schemas`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src/push.ts packages/contract/src/index.ts
git commit -m "feat(contract): push device identifier schema"
```

---

### Task 4: VAPID resolver (pure resolution + DB lookup)

**Files:**
- Create: `apps/api/src/lib/push/vapid.ts`
- Test: `apps/api/src/lib/push/vapid.test.ts`

**Interfaces:**
- Produces:
  - `resolveVapid(perProject: { publicKey?: string; privateKey?: string; subject?: string } | null, envKeys: { publicKey?: string; privateKey?: string; subject?: string }): { publicKey: string; privateKey: string; subject: string } | null` (pure).
  - `getVapidKeys(projectId: string): Promise<{ publicKey: string; privateKey: string; subject: string } | null>` (DB + env).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/lib/push/vapid.test.ts
import { describe, it, expect } from "vitest";
import { resolveVapid } from "./vapid.js";

describe("resolveVapid", () => {
  const env = { publicKey: "ENVpub", privateKey: "ENVpriv", subject: "mailto:ops@x" };
  it("prefers a complete per-project keypair", () => {
    expect(resolveVapid({ publicKey: "Ppub", privateKey: "Ppriv", subject: "mailto:p@x" }, env))
      .toEqual({ publicKey: "Ppub", privateKey: "Ppriv", subject: "mailto:p@x" });
  });
  it("falls back to env when per-project is null/incomplete", () => {
    expect(resolveVapid(null, env)).toEqual(env);
    expect(resolveVapid({ publicKey: "Ppub" }, env)).toEqual(env); // missing private → fall back
  });
  it("returns null when neither is complete", () => {
    expect(resolveVapid(null, { publicKey: "only" })).toBeNull();
  });
  it("defaults the subject when absent", () => {
    expect(resolveVapid({ publicKey: "a", privateKey: "b" }, { publicKey: "a", privateKey: "b" }).subject)
      .toBe("mailto:push@agora");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- push/vapid`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the resolver**

```ts
// apps/api/src/lib/push/vapid.ts
// VAPID keypair resolution: per-project (project_integrations name='vapid') first, else the global
// env keypair. Returns null when neither yields a COMPLETE pair (web push then simply disabled).
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { projectIntegrations } from "../../db/schema/index.js";
import { env } from "../env.js";

type Keys = { publicKey?: string; privateKey?: string; subject?: string };
type ResolvedVapid = { publicKey: string; privateKey: string; subject: string };

const DEFAULT_SUBJECT = "mailto:push@agora";

export function resolveVapid(perProject: Keys | null, envKeys: Keys): ResolvedVapid | null {
  const complete = (k: Keys | null): ResolvedVapid | null =>
    k && k.publicKey && k.privateKey ? { publicKey: k.publicKey, privateKey: k.privateKey, subject: k.subject || DEFAULT_SUBJECT } : null;
  return complete(perProject) ?? complete(envKeys);
}

export async function getVapidKeys(projectId: string): Promise<ResolvedVapid | null> {
  const [row] = await db.select({ data: projectIntegrations.data }).from(projectIntegrations)
    .where(and(eq(projectIntegrations.projectId, projectId), eq(projectIntegrations.name, "vapid"))).limit(1);
  const perProject = (row?.data as Keys | undefined) ?? null;
  return resolveVapid(perProject, {
    publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- push/vapid`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/push/vapid.ts apps/api/src/lib/push/vapid.test.ts
git commit -m "feat(push): VAPID keypair resolver (per-project + env fallback)"
```

---

### Task 5: Dispatch seam — provider interface + pure fan-out + payload mapping

**Files:**
- Create: `apps/api/src/lib/push/provider.ts`
- Create: `apps/api/src/lib/push/dispatch.ts`
- Test: `apps/api/src/lib/push/dispatch.test.ts`

**Interfaces:**
- Produces:
  - `provider.ts`: `interface PushPayload { title: string; body: string; data?: Record<string,string>; url?: string }`, `interface PushProvider { send(device: DeviceLike, payload: PushPayload): Promise<{ ok: boolean; prune?: boolean }> }`, `type DeviceLike = { id: string; platform: string; token: string | null; subscription: unknown }`.
  - `dispatch.ts`: `pickProvider(platform: string, providers: ProviderMap): PushProvider | null`, `dispatchToDevices(devices: DeviceLike[], payload, providers, prune): Promise<{ sent: number; pruned: number }>`, `notificationPushPayload(type: string): PushPayload | null` (null = not push-worthy → suppressed), where `type ProviderMap = Record<"ios"|"android"|"web", PushProvider | null>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/lib/push/dispatch.test.ts
import { describe, it, expect, vi } from "vitest";
import { dispatchToDevices, pickProvider, notificationPushPayload } from "./dispatch.js";
import type { PushProvider } from "./provider.js";

const mk = (res: { ok: boolean; prune?: boolean }): PushProvider => ({ send: vi.fn().mockResolvedValue(res) });

describe("pickProvider", () => {
  it("routes a platform to its provider, null when absent", () => {
    const web = mk({ ok: true });
    const providers = { ios: null, android: null, web } as any;
    expect(pickProvider("web", providers)).toBe(web);
    expect(pickProvider("ios", providers)).toBeNull();
  });
});

describe("dispatchToDevices", () => {
  it("sends to every device via its provider and prunes flagged ones", async () => {
    const web = mk({ ok: true });
    const ios = mk({ ok: false, prune: true });
    const providers = { ios, android: null, web } as any;
    const prune = vi.fn().mockResolvedValue(undefined);
    const devices = [
      { id: "d1", platform: "web", token: null, subscription: {} },
      { id: "d2", platform: "ios", token: "t", subscription: null },
      { id: "d3", platform: "android", token: "t", subscription: null }, // no provider → skipped
    ];
    const out = await dispatchToDevices(devices as any, { title: "x", body: "y" }, providers, prune);
    expect(web.send).toHaveBeenCalledTimes(1);
    expect(ios.send).toHaveBeenCalledTimes(1);
    expect(out.sent).toBe(1);              // only the web send was ok
    expect(out.pruned).toBe(1);            // the ios device was pruned
    expect(prune).toHaveBeenCalledWith("d2");
  });
});

describe("notificationPushPayload", () => {
  it("produces a PII-free payload for a push-worthy type, keyed by type", () => {
    const p = notificationPushPayload("entity-comment");
    expect(p).not.toBeNull();
    expect(p!.title).toBe("New comment");
    expect(p!.body).toBe("Open the app to see what's new.");
    expect(p!.data).toEqual({ type: "entity-comment" });
  });
  it("uses the corrected new-follow key (not 'follow')", () => {
    expect(notificationPushPayload("new-follow")!.title).toBe("New follower");
    expect(notificationPushPayload("follow")).toBeNull(); // not a real type → not push-worthy
  });
  it("returns null for SILENT (in-app-only) types — reactions + milestones", () => {
    for (const t of [
      "entity-upvote", "comment-upvote", "entity-reaction", "comment-reaction",
      "entity-reaction-milestone-specific", "comment-reaction-milestone-total",
    ]) expect(notificationPushPayload(t)).toBeNull();
  });
  it("pushes steward types with the neutral fallback (never hints content removal)", () => {
    const p = notificationPushPayload("steward-content-removed");
    expect(p).not.toBeNull();
    expect(p!.title).toBe("New activity"); // neutral — no 'removed'/complainant framing
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- push/dispatch`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the provider interface + dispatch**

```ts
// apps/api/src/lib/push/provider.ts
export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  url?: string;
}
export type DeviceLike = { id: string; platform: string; token: string | null; subscription: unknown };
export interface PushProvider {
  // Returns { ok } on delivery; { prune: true } when the token/subscription is dead (delete the row).
  send(device: DeviceLike, payload: PushPayload): Promise<{ ok: boolean; prune?: boolean }>;
}
export type ProviderMap = Record<"ios" | "android" | "web", PushProvider | null>;
```

```ts
// apps/api/src/lib/push/dispatch.ts
// Pure dispatch orchestration: route each device to its provider, collect results, prune dead rows.
// DB-free + provider-agnostic so it's hermetically unit-testable (the real getProviders()/pruneDevice
// are injected by dispatchToUser in lib/push/index.ts).
import type { DeviceLike, PushPayload, PushProvider, ProviderMap } from "./provider.js";
import { logger } from "../logger.js";

export function pickProvider(platform: string, providers: ProviderMap): PushProvider | null {
  return platform === "ios" || platform === "android" || platform === "web" ? providers[platform] : null;
}

export async function dispatchToDevices(
  devices: DeviceLike[],
  payload: PushPayload,
  providers: ProviderMap,
  prune: (deviceId: string) => Promise<void>,
): Promise<{ sent: number; pruned: number }> {
  let sent = 0, pruned = 0;
  await Promise.all(devices.map(async (d) => {
    const provider = pickProvider(d.platform, providers);
    if (!provider) return; // transport not configured → skip silently
    try {
      const res = await provider.send(d, payload);
      if (res.ok) sent++;
      if (res.prune) { await prune(d.id); pruned++; }
    } catch (err) {
      logger.error("push: provider send failed");
      logger.debug({ err, platform: d.platform }, "push: provider send failed");
    }
  }));
  return { sent, pruned };
}

// Allowlist + PII-free push copy, keyed by the in-app notification `type`. ONE place owns both the
// gate and the copy: returns null for non-push-worthy types (the bridge then no-ops), else a payload.
// A push must never carry another user's identity/PII (SECURITY.md); clients deep-link via data.type.
//
// SILENT (in-app only): reactions + reaction-milestones (entity/comment -upvote, -reaction,
// -reaction-milestone-specific/-total) — a buzz-per-upvote is noise. They're simply absent from the set.
//
// Steward types are push-worthy but intentionally have NO specific title → they fall to the neutral
// "New activity" fallback so a push never hints content was removed / carries complainant framing
// (mirrors stewardCaseRecipients in lib/notifications.ts).
const PUSH_TITLES: Record<string, string> = {
  "entity-comment": "New comment",
  "comment-reply": "New reply",
  "comment-mention": "You were mentioned",
  "entity-mention": "You were mentioned",
  "new-follow": "New follower",
  "connection-request": "New connection request",
  "connection-accepted": "Connection accepted",
  "space-membership-approved": "Membership approved",
};
// Push-worthy but neutral-copy (sensitive): steward lifecycle + mediation invites.
const PUSH_WORTHY_NEUTRAL = new Set<string>([
  "steward-case-opened", "steward-case-in-mediation", "steward-case-resolved",
  "steward-content-removed", "steward-mediation-invite",
]);

export function notificationPushPayload(type: string): PushPayload | null {
  const titled = PUSH_TITLES[type];
  if (!titled && !PUSH_WORTHY_NEUTRAL.has(type)) return null; // not push-worthy → in-app only
  return { title: titled ?? "New activity", body: "Open the app to see what's new.", data: { type } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- push/dispatch`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/push/provider.ts apps/api/src/lib/push/dispatch.ts apps/api/src/lib/push/dispatch.test.ts
git commit -m "feat(push): dispatch seam + pure fan-out + payload mapping"
```

---

### Task 6: Web Push provider + `dispatchToUser` (DB orchestration + pruning)

**Files:**
- Add dep: `web-push` (+ `@types/web-push`)
- Create: `apps/api/src/lib/push/webpush.ts`
- Create: `apps/api/src/lib/push/index.ts`
- Test: `apps/api/test/integration/push-dispatch.test.ts`

**Interfaces:**
- Consumes: `resolveVapid`/`getVapidKeys` (Task 4), `dispatchToDevices`/`notificationPushPayload` (Task 5).
- Produces: `getProviders(projectId): Promise<ProviderMap>`, `dispatchToUser(projectId: string, userId: string, payload: PushPayload): Promise<void>`, `dispatchNotificationPush(projectId, userId, type): void` (fire-and-forget wrapper).

- [ ] **Step 1: Add the dependency**

Run (from repo root):

```bash
pnpm --filter @agora/api add web-push
pnpm --filter @agora/api add -D @types/web-push
```

- [ ] **Step 2: Write the Web Push provider**

```ts
// apps/api/src/lib/push/webpush.ts
// RFC 8030 + VAPID (RFC 8292) via the `web-push` lib. 404/410 → prune (subscription gone).
import webpush from "web-push";
import type { DeviceLike, PushPayload, PushProvider } from "./provider.js";

export class WebPushProvider implements PushProvider {
  constructor(private vapid: { publicKey: string; privateKey: string; subject: string }) {}
  async send(device: DeviceLike, payload: PushPayload): Promise<{ ok: boolean; prune?: boolean }> {
    const sub = device.subscription as webpush.PushSubscription | null;
    if (!sub) return { ok: false };
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), {
        vapidDetails: { subject: this.vapid.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
      });
      return { ok: true };
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      return { ok: false, prune: status === 404 || status === 410 };
    }
  }
}
```

- [ ] **Step 3: Write the orchestrator**

```ts
// apps/api/src/lib/push/index.ts
// dispatchToUser: load a user's devices, build the per-project provider map, fan out, prune dead rows.
// FCM/APNs providers are wired in Task 8; until then `getProviders` returns them as null (skipped).
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { pushDevices } from "../../db/schema/index.js";
import type { ProviderMap, PushPayload } from "./provider.js";
import { dispatchToDevices, notificationPushPayload } from "./dispatch.js";
import { getVapidKeys } from "./vapid.js";
import { WebPushProvider } from "./webpush.js";
import { getFcmProvider, getApnsProvider } from "./native.js"; // added in Task 8
import { logger } from "../logger.js";

export async function getProviders(projectId: string): Promise<ProviderMap> {
  const vapid = await getVapidKeys(projectId);
  return {
    web: vapid ? new WebPushProvider(vapid) : null,
    ios: await getApnsProvider(projectId),
    android: await getFcmProvider(projectId),
  };
}

export async function dispatchToUser(projectId: string, userId: string, payload: PushPayload): Promise<void> {
  const devices = await db.select().from(pushDevices)
    .where(and(eq(pushDevices.projectId, projectId), eq(pushDevices.userId, userId)));
  if (devices.length === 0) return;
  const providers = await getProviders(projectId);
  const prune = async (deviceId: string) => { await db.delete(pushDevices).where(eq(pushDevices.id, deviceId)); };
  const { sent, pruned } = await dispatchToDevices(devices as any, payload, providers, prune);
  logger.info(`push: dispatched (sent=${sent} pruned=${pruned})`);
}

/** Fire-and-forget bridge from the notification choke point (never blocks/throws into the request).
 *  No-ops when the type isn't push-worthy (reactions/milestones → in-app only; see allowlist). */
export function dispatchNotificationPush(projectId: string, userId: string, type: string): void {
  const payload = notificationPushPayload(type);
  if (!payload) return; // suppressed type → in-app only
  dispatchToUser(projectId, userId, payload).catch((err) => {
    logger.error("push: notification dispatch failed");
    logger.debug({ err, type }, "push: notification dispatch failed");
  });
}
```

> Note: this file imports `./native.js` (Task 8). To keep Task 6 compiling on its own, create a
> minimal stub `apps/api/src/lib/push/native.ts` now:
> ```ts
> // apps/api/src/lib/push/native.ts — FCM/APNs providers (full impl in Task 8).
> import type { PushProvider } from "./provider.js";
> export async function getFcmProvider(_projectId: string): Promise<PushProvider | null> { return null; }
> export async function getApnsProvider(_projectId: string): Promise<PushProvider | null> { return null; }
> ```

- [ ] **Step 4: Write the failing integration test**

```ts
// apps/api/test/integration/push-dispatch.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createProject, createUser, deleteProject } from "./helpers.js";
import { db } from "../../src/db/index.js";
import { pushDevices, projectIntegrations } from "../../src/db/schema/index.js";
import webpush from "web-push";
import { dispatchToUser } from "../../src/lib/push/index.js";

describe("push dispatch — web push (integration)", () => {
  let projectId: string; let user: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    user = await createUser(projectId);
    const keys = webpush.generateVAPIDKeys();
    await db.insert(projectIntegrations).values({ projectId, name: "vapid", data: { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:t@x" } });
    await db.insert(pushDevices).values({ projectId, userId: user.id, platform: "web", subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } } });
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("sends to the user's web device", async () => {
    const spy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({} as any);
    await dispatchToUser(projectId, user.id, { title: "Hi", body: "There" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("prunes the device on a 410 Gone", async () => {
    const spy = vi.spyOn(webpush, "sendNotification").mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    await dispatchToUser(projectId, user.id, { title: "Hi", body: "There" });
    const rows = await db.select().from(pushDevices).where(eq(pushDevices.userId, user.id));
    expect(rows.length).toBe(0);
    spy.mockRestore();
  });
});
```

(Add `import { eq } from "drizzle-orm";` at the top.)

- [ ] **Step 5: Run the integration test (RED → GREEN)**

Run (from `apps/api`): `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts push-dispatch`
Expected: PASS (the second test confirms 410 pruning empties the device rows).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/api/src/lib/push/webpush.ts apps/api/src/lib/push/index.ts apps/api/src/lib/push/native.ts apps/api/test/integration/push-dispatch.test.ts apps/api/package.json
git commit -m "feat(push): web push provider + dispatchToUser with pruning"
```

---

### Task 7: Router — register / deregister / vapid-public-key + mount

**Files:**
- Create: `apps/api/src/routes/push-notifications.ts`
- Modify: `apps/api/src/routes/index.ts`
- Test: `apps/api/test/integration/push-devices.test.ts`

**Interfaces:**
- Consumes: `pushDeviceSchema` (Task 3), `getVapidKeys` (Task 4), `parseBody`/`requireAuth`/`Errors` (existing).
- Produces: module-private `registerDevice(projectId, userId, ident)` + `deregisterDevice(projectId, userId, ident)` (upsert / idempotent delete).

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/test/integration/push-devices.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { db } from "../../src/db/index.js";
import { pushDevices, projectIntegrations } from "../../src/db/schema/index.js";
import { eq } from "drizzle-orm";
import webpush from "web-push";

describe("push devices (integration)", () => {
  let projectId: string; let B: string; let user: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    user = await createUser(projectId);
    const keys = webpush.generateVAPIDKeys();
    await db.insert(projectIntegrations).values({ projectId, name: "vapid", data: { publicKey: keys.publicKey, privateKey: keys.privateKey } });
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("requires auth to register", async () => {
    expect((await api("POST", `${B}/push-notifications/devices`, { body: { platform: "ios", token: "t1" } })).status).toBe(401);
  });

  it("registers a native device (idempotent upsert)", async () => {
    expect((await api("POST", `${B}/push-notifications/devices`, { token: user.token, body: { platform: "ios", token: "t1" } })).status).toBe(204);
    expect((await api("POST", `${B}/push-notifications/devices`, { token: user.token, body: { platform: "ios", token: "t1" } })).status).toBe(204); // idempotent
    const rows = await db.select().from(pushDevices).where(eq(pushDevices.userId, user.id));
    expect(rows.filter((r) => r.platform === "ios" && r.token === "t1").length).toBe(1);
  });

  it("deregisters (idempotent — 204 even when unknown)", async () => {
    expect((await api("DELETE", `${B}/push-notifications/devices`, { token: user.token, body: { platform: "ios", token: "t1" } })).status).toBe(204);
    expect((await api("DELETE", `${B}/push-notifications/devices`, { token: user.token, body: { platform: "ios", token: "nope" } })).status).toBe(204);
    const rows = await db.select().from(pushDevices).where(eq(pushDevices.userId, user.id));
    expect(rows.length).toBe(0);
  });

  it("the POST /deregister fallback also removes", async () => {
    await api("POST", `${B}/push-notifications/devices`, { token: user.token, body: { platform: "android", token: "a1" } });
    expect((await api("POST", `${B}/push-notifications/devices/deregister`, { token: user.token, body: { platform: "android", token: "a1" } })).status).toBe(204);
  });

  it("serves the VAPID public key unauthenticated", async () => {
    const res = await api("GET", `${B}/push-notifications/vapid-public-key`);
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe("string");
  });
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts push-devices`
Expected: FAIL — routes 404.

- [ ] **Step 3: Write the router**

```ts
// apps/api/src/routes/push-notifications.ts
// /v7/:projectId/push-notifications/* — device registration + VAPID public key.
import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { pushDevices } from "../db/schema/index.js";
import { parseBody } from "../lib/validation.js";
import { pushDeviceSchema, type PushDeviceIdentifier } from "@agora-server/contract";
import { getVapidKeys } from "../lib/push/vapid.js";

// Upsert: native dedupes on (project,user,platform,token); web on (project,user,endpoint).
async function registerDevice(projectId: string, userId: string, ident: PushDeviceIdentifier): Promise<void> {
  if (ident.platform === "web") {
    const endpoint = ident.subscription.endpoint;
    const updated = await db.update(pushDevices).set({ subscription: ident.subscription, updatedAt: new Date() })
      .where(and(eq(pushDevices.projectId, projectId), eq(pushDevices.userId, userId), eq(pushDevices.platform, "web"), sql`${pushDevices.subscription}->>'endpoint' = ${endpoint}`)).returning({ id: pushDevices.id });
    if (updated.length === 0) {
      await db.insert(pushDevices).values({ projectId, userId, platform: "web", subscription: ident.subscription });
    }
  } else {
    const updated = await db.update(pushDevices).set({ updatedAt: new Date() })
      .where(and(eq(pushDevices.projectId, projectId), eq(pushDevices.userId, userId), eq(pushDevices.platform, ident.platform), eq(pushDevices.token, ident.token))).returning({ id: pushDevices.id });
    if (updated.length === 0) {
      await db.insert(pushDevices).values({ projectId, userId, platform: ident.platform, token: ident.token });
    }
  }
}

async function deregisterDevice(projectId: string, userId: string, ident: PushDeviceIdentifier): Promise<void> {
  if (ident.platform === "web") {
    await db.delete(pushDevices).where(and(
      eq(pushDevices.projectId, projectId), eq(pushDevices.userId, userId), eq(pushDevices.platform, "web"),
      sql`${pushDevices.subscription}->>'endpoint' = ${ident.subscription.endpoint}`));
  } else {
    await db.delete(pushDevices).where(and(
      eq(pushDevices.projectId, projectId), eq(pushDevices.userId, userId),
      eq(pushDevices.platform, ident.platform), eq(pushDevices.token, ident.token)));
  }
}

export const pushNotificationRoutes = new Hono<{ Variables: Variables }>()
  .post("/devices", requireAuth, async (c) => {
    const ident = parseBody(pushDeviceSchema, await c.req.json().catch(() => ({})), "push-notifications");
    await registerDevice(c.var.projectId, c.var.auth!.userId, ident);
    return c.body(null, 204);
  })
  .delete("/devices", requireAuth, async (c) => {
    const ident = parseBody(pushDeviceSchema, await c.req.json().catch(() => ({})), "push-notifications");
    await deregisterDevice(c.var.projectId, c.var.auth!.userId, ident);
    return c.body(null, 204);
  })
  // Proxy-safe fallback for gateways that strip DELETE bodies.
  .post("/devices/deregister", requireAuth, async (c) => {
    const ident = parseBody(pushDeviceSchema, await c.req.json().catch(() => ({})), "push-notifications");
    await deregisterDevice(c.var.projectId, c.var.auth!.userId, ident);
    return c.body(null, 204);
  })
  // Intentionally UNAUTHENTICATED (public key, fetched pre-sign-in). Covered by the edge rate-limiter.
  .get("/vapid-public-key", async (c) => {
    const vapid = await getVapidKeys(c.var.projectId);
    return c.json({ publicKey: vapid?.publicKey ?? null });
  });
```

- [ ] **Step 4: Mount the router**

In `apps/api/src/routes/index.ts`, add:

```ts
import { pushNotificationRoutes } from "./push-notifications.js";
// …with the other project.route(...) calls:
  project.route("/push-notifications", pushNotificationRoutes);
```

> Route ordering: `/devices/deregister` is a distinct static path; declare it after `/devices` (it
> does not collide — `/devices` has no `:param`). No ordering hazard.

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts push-devices`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/api/src/routes/push-notifications.ts apps/api/src/routes/index.ts apps/api/test/integration/push-devices.test.ts
git commit -m "feat(push): device register/deregister + vapid-public-key router"
```

---

### Task 8: FCM + APNs providers (credential-gated)

**Files:**
- Modify: `apps/api/src/lib/push/native.ts` (replace the Task 6 stub with real providers)

**Interfaces:**
- Produces: `getFcmProvider(projectId): Promise<PushProvider | null>` (FCM HTTP v1, OAuth JWT via `jose`), `getApnsProvider(projectId): Promise<PushProvider | null>` (APNs HTTP/2, ES256 JWT via `jose`). Both return `null` when the project lacks the credential row.

- [ ] **Step 1: Replace the stub with real providers**

```ts
// apps/api/src/lib/push/native.ts
// FCM (HTTP v1) + APNs (HTTP/2) providers. Credentials live in project_integrations (name 'fcm'/'apns').
// Both return null when unconfigured → that transport is simply skipped (fail-safe). Tokens/creds are
// never logged. Unregistered/410 → prune.
import http2 from "node:http2";
import { and, eq } from "drizzle-orm";
import { SignJWT, importPKCS8 } from "jose";
import { db } from "../../db/index.js";
import { projectIntegrations } from "../../db/schema/index.js";
import type { DeviceLike, PushPayload, PushProvider } from "./provider.js";

async function loadIntegration(projectId: string, name: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select({ data: projectIntegrations.data }).from(projectIntegrations)
    .where(and(eq(projectIntegrations.projectId, projectId), eq(projectIntegrations.name, name))).limit(1);
  const data = row?.data as Record<string, unknown> | undefined;
  return data && Object.keys(data).length ? data : null;
}

// ── FCM HTTP v1 ──
async function fcmAccessToken(sa: { client_email: string; private_key: string; token_uri?: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(sa.private_key, "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(sa.client_email).setSubject(sa.client_email)
    .setAudience(sa.token_uri ?? "https://oauth2.googleapis.com/token")
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const res = await fetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) throw new Error("fcm: token exchange failed");
  return json.access_token;
}

export async function getFcmProvider(projectId: string): Promise<PushProvider | null> {
  const sa = await loadIntegration(projectId, "fcm") as { client_email: string; private_key: string; project_id: string } | null;
  if (!sa?.client_email || !sa?.private_key || !sa?.project_id) return null;
  return {
    async send(device: DeviceLike, payload: PushPayload) {
      if (!device.token) return { ok: false };
      const accessToken = await fcmAccessToken(sa);
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { token: device.token, notification: { title: payload.title, body: payload.body }, data: payload.data ?? {} } }),
      });
      if (res.ok) return { ok: true };
      // UNREGISTERED / NOT_FOUND → the token is dead.
      return { ok: false, prune: res.status === 404 || res.status === 410 };
    },
  };
}

// ── APNs HTTP/2 ──
export async function getApnsProvider(projectId: string): Promise<PushProvider | null> {
  const cfg = await loadIntegration(projectId, "apns") as { key: string; keyId: string; teamId: string; bundleId: string; production?: boolean } | null;
  if (!cfg?.key || !cfg?.keyId || !cfg?.teamId || !cfg?.bundleId) return null;
  const host = cfg.production ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  return {
    async send(device: DeviceLike, payload: PushPayload) {
      if (!device.token) return { ok: false };
      const now = Math.floor(Date.now() / 1000);
      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: cfg.keyId }).setIssuer(cfg.teamId).setIssuedAt(now)
        .sign(await importPKCS8(cfg.key, "ES256"));
      const body = JSON.stringify({ aps: { alert: { title: payload.title, body: payload.body } }, data: payload.data ?? {} });
      return await new Promise<{ ok: boolean; prune?: boolean }>((resolve) => {
        const client = http2.connect(host);
        const req = client.request({
          ":method": "POST", ":path": `/3/device/${device.token}`,
          authorization: `bearer ${jwt}`, "apns-topic": cfg.bundleId, "apns-push-type": "alert",
        });
        let status = 0;
        req.on("response", (h) => { status = Number(h[":status"]) || 0; });
        req.on("end", () => { client.close(); resolve({ ok: status === 200, prune: status === 410 }); });
        req.on("error", () => { client.close(); resolve({ ok: false }); });
        req.end(body);
      });
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run (from repo root): `pnpm -r typecheck`
Expected: PASS. (These providers are credential-gated; the web-push integration test from Task 6 still
passes since FCM/APNs return `null` without `project_integrations` rows.)

- [ ] **Step 3: Verify the existing suites still pass**

Run (from `apps/api`):

```bash
pnpm --filter @agora/api test
pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts push-dispatch push-devices
```

Expected: PASS (no regressions).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/push/native.ts
git commit -m "feat(push): FCM HTTP v1 + APNs HTTP/2 providers (credential-gated)"
```

---

### Task 9: Wire the notification choke point + final verification

**Files:**
- Modify: `apps/api/src/lib/notifications.ts` (the `insert()` choke point, ~line 59-66)
- Modify: `CHANGELOG.md`, `docs/MODELS.md`

**Interfaces:**
- Consumes: `dispatchNotificationPush` (Task 6).

- [ ] **Step 1: Add the import**

At the top of `apps/api/src/lib/notifications.ts`, add:

```ts
import { dispatchNotificationPush } from "./push/index.js";
```

- [ ] **Step 2: Dispatch push from the choke point**

In `insert()`, inside the `if (row) { … }` block, after the existing
`emitToUser(projectId, recipientId, "notification:created", shaped);` line, add:

```ts
    // Push bridge: deliver to the recipient's registered devices (offline-friendly). Fire-and-forget
    // — never block or throw into the caller. No-op when the user has no devices / no transport.
    dispatchNotificationPush(projectId, recipientId, type);
```

- [ ] **Step 3: Verify the wiring (unit + typecheck)**

Run (from repo root): `pnpm -r typecheck && pnpm --filter @agora/api test`
Expected: PASS. (The `notifications` paths already have coverage; `dispatchNotificationPush` is
fire-and-forget and no-ops without devices, so existing notification tests are unaffected.)

- [ ] **Step 4: Changelog + MODELS**

Under `## [Unreleased]` → `### Added`:

```markdown
- Push notifications: `push_devices` table + `/v7/:projectId/push-notifications/*` (register/deregister/deregister-fallback/vapid-public-key).
- Push dispatch seam (Web Push fully wired; FCM HTTP v1 + APNs HTTP/2 credential-gated) bridged to the in-app notification choke point.
- VAPID per-project (project_integrations `vapid`) with `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` env fallback.
```

Add the `PushDevice` shape to `docs/MODELS.md` (from `packages/contract/src/push.ts`).

- [ ] **Step 5: Full verification**

Run (from repo root):

```bash
pnpm -r build && pnpm -r typecheck && pnpm --filter @agora/api test
cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts push-devices push-dispatch
```

Expected: build, typecheck, unit suite, and both push integration files PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/notifications.ts CHANGELOG.md docs/MODELS.md
git commit -m "feat(push): dispatch on in-app notifications + docs"
```

---

## Self-Review notes

- **Spec coverage (§1):** `push_devices` table + CHECK + partial uniques → Tasks 1-2; register/deregister upsert + idempotent delete + DELETE-body **and** POST fallback → Task 7; unauthenticated rate-limited `vapid-public-key` → Task 7 (edge limiter); VAPID per-project + env fallback → Task 4; FCM/APNs/Web Push behind a seam with Web Push testable → Tasks 5-8; stale-token pruning (410/404/unregistered) → Tasks 6,8; multi-device send → `dispatchToDevices` fans out to all rows; trigger = in-app notification choke point → Task 9; credentials in `project_integrations` → Tasks 4,8; orphan tokens via FK cascade → Task 1 (`user_id … on delete cascade`).
- **Security:** auth on register/deregister; vapid endpoint deliberately open but rate-limited; payloads are generic/PII-free (`notificationPushPayload`); creds/tokens never logged (message-only `info`/`error`, detail on `debug`). Fire-and-forget dispatch never blocks the request.
- **Hermetic tests:** pure `dispatchToDevices`/`pickProvider`/`notificationPushPayload`/`resolveVapid` unit-tested with mocks; web push integration mocks `webpush.sendNotification` (no real network); FCM/APNs are credential-gated and return `null` in tests (skipped) — matches the integration env forcing external creds empty.
- **Type consistency:** `PushProvider`/`PushPayload`/`DeviceLike`/`ProviderMap`, `dispatchToDevices`/`pickProvider`/`notificationPushPayload`, `getProviders`/`dispatchToUser`/`dispatchNotificationPush`, `resolveVapid`/`getVapidKeys`, `registerDevice`/`deregisterDevice`, `getFcmProvider`/`getApnsProvider` are referenced identically across tasks. Task 6 creates a `native.ts` stub so it compiles before Task 8 fills it in.
- **Push-worthy allowlist (spec §7/§10):** `notificationPushPayload` is the single gate — push the
  human-attention types (comments/replies/mentions/new-follow/connection-request|accepted/space-approved
  + steward lifecycle & mediation invites), return `null` for reactions + reaction-milestones (in-app
  only). `dispatchNotificationPush` no-ops on `null`. Self-notify is already skipped upstream in
  `insert()`. Corrected `follow` → the real `new-follow` type; steward types use the neutral fallback
  (never hint content removal / complainant framing).
- **Open follow-ups (deferred, per spec §11):** chat-message push + its online/offline socket gating
  (chat doesn't hit this choke point — separate later wiring); per-user push preferences
  (mute/quiet-hours/per-type opt-out) deferred to a future spec.
