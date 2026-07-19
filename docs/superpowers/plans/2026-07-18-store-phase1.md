# Agora Store Phase 1 (coins + digital cosmetics) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-project opt-in store: admin-curated digital-cosmetics catalog priced in an earnable virtual coin, with an append-only ledger, atomic purchases, equip/render contract on the User shape, and settings/admin surface — Phase 1 of `docs/superpowers/specs/2026-07-17-store-marketplace-design.md`.

**Architecture:** New `store` domain in `@agora/api` (events precedent): contract types/zod in `@agora-server/contract`, Drizzle tables in `@agora/core`, one hand-authored SQL migration carrying DDL + RLS + a balance trigger + serialized purchase/gift/earn/stipend functions, one domain router, config in `projects.store_config` jsonb.

**Tech Stack:** Hono, Drizzle/postgres.js, zod, vitest (unit + real-Postgres integration suite).

## Global Constraints

- Spec is the authority: `docs/superpowers/specs/2026-07-17-store-marketplace-design.md`. The SDK contract style must match `docs/MANIFEST.md`/`docs/MODELS.md`.
- Contract-first: shared request/response types + zod live in `packages/contract`; rebuild it (`pnpm --filter @agora-server/contract build`) before typechecking api/core.
- Security-first (CLAUDE.md): server is the trust boundary; every endpoint wires `requireAuth`/ownership/`requireProjectAdmin`/`assertCanReadSpace`; fail closed; parameterized SQL only.
- Ledger integrity: handlers NEVER write `coin_balances`; every value mutation is a `coin_transactions` insert via the serialized SQL functions.
- Logging: shared `logger`, data-object-FIRST arg order; `info`/`error` message-only, `{ err }` on `debug` only.
- Migrations are hand-authored (drizzle-kit `db:generate` is broken here — memory `sdk-conformance-build`); apply with `pnpm db:migrate:run`; new journal `when` MUST exceed the current max (`1781934611662`).
- All commands below run from `apps/api/` unless stated; contract commands from repo root.
- Integration suite: `TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration` (macOS temp-fs gotcha); single-file: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts <name>`.
- **Commits require Jenova's per-run approval** (standing rule): at execution pre-flight, ask whether per-task commits are authorized for this run; if not, skip every "Commit" step and batch at the end. All commits DCO-signed (`git commit -s`).
- `CHANGELOG.md` entry lands in Task 13, not per-task.
- Explicitly deferred within Phase 1 (state in docs, do not build): `item-back-in-stock` and `stipend-available` notification kinds (reserved names only), creator marketplace behavior, everything Phase 2 (§4 of the spec).

## File Map

- Create: `packages/contract/src/store.ts` (+ `store.test.ts`) — types, zod, `resolveStoreConfig`, `SLOT_FOR_TYPE`
- Modify: `packages/contract/src/index.ts` — export `./store.js`
- Modify: `packages/core/src/db/schema/_shared.ts` — five store enums
- Create: `packages/core/src/db/schema/store.ts`; modify `packages/core/src/db/schema/index.ts`
- Create: `apps/api/drizzle/0066_store_phase1.sql`; modify `apps/api/drizzle/meta/_journal.json`
- Create: `apps/api/src/lib/store-config.ts` — cached resolver (mirrors `social-config.ts`)
- Create: `apps/api/src/lib/store-shape.ts` (+ `store-shape.test.ts`) — shapers + `buildCosmetics` + `attachCosmetics`
- Create: `apps/api/src/lib/store-earn.ts` (+ `store-earn.test.ts`) — `earnAmount`, `creditEarnAsync`, `clawbackEarnAsync`
- Create: `apps/api/src/routes/store.ts` — the domain router; modify `apps/api/src/routes/index.ts` (mount)
- Modify: `apps/api/src/routes/misc.ts` — `GET/PATCH /settings/store`
- Modify: `apps/api/src/lib/shape.ts` (`loadUsers` cosmetics), `apps/api/src/routes/entities.ts`, `apps/api/src/routes/comments.ts`, `apps/api/src/routes/events.ts` (earn hooks), `apps/api/src/lib/client-moderation.ts` (+ the two other removal-write sites) (claw-back)
- Create: `apps/api/test/integration/store.test.ts`, `store-economy.test.ts`, `store-admin.test.ts`
- Modify: `docs/MANIFEST.md`, `docs/MODELS.md`, `SECURITY.md`, `CHANGELOG.md`

---

### Task 1: Contract — store types, zod schemas, config resolver

**Files:**
- Create: `packages/contract/src/store.ts`
- Create: `packages/contract/src/store.test.ts`
- Modify: `packages/contract/src/index.ts`

**Interfaces:**
- Consumes: nothing (pure zod + types).
- Produces (used by every later task): `STORE_ITEM_TYPES`, `StoreItemType`, `STORE_ITEM_STATUSES`, `StoreItemStatus`, `EQUIP_SLOTS`, `EquipSlot`, `COIN_TXN_KINDS`, `CoinTxnKind`, `SLOT_FOR_TYPE: Record<StoreItemType, EquipSlot | null>`, `StoreItem`, `CoinTransaction`, `InventoryItem`, `UserCosmetics`, `ResolvedStoreConfig`, `STORE_CONFIG_DEFAULTS`, `resolveStoreConfig(stored: unknown): ResolvedStoreConfig`, `storeConfigSchema`, `createStoreItemSchema`, `updateStoreItemSchema`, `purchaseItemSchema`, `equipSchema`, `giftSchema`, `grantCoinsSchema`.

- [ ] **Step 1: Write the failing test** — `packages/contract/src/store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  resolveStoreConfig, STORE_CONFIG_DEFAULTS, SLOT_FOR_TYPE, STORE_ITEM_TYPES,
  equipSchema, giftSchema, createStoreItemSchema,
} from "./store.js";

describe("resolveStoreConfig", () => {
  it("falls back to defaults on garbage (fail-closed, store disabled)", () => {
    for (const bad of [null, undefined, 42, "x", [], { enabled: "yes" }]) {
      const cfg = resolveStoreConfig(bad);
      expect(cfg).toEqual(STORE_CONFIG_DEFAULTS);
      expect(cfg.enabled).toBe(false);
    }
  });
  it("merges partial overrides over defaults", () => {
    const cfg = resolveStoreConfig({ enabled: true, earn: { entityCreate: 7 } });
    expect(cfg.enabled).toBe(true);
    expect(cfg.earn.entityCreate).toBe(7);
    expect(cfg.earn.commentCreate).toBe(STORE_CONFIG_DEFAULTS.earn.commentCreate);
  });
  it("clamps every numeric into range", () => {
    const cfg = resolveStoreConfig({
      earn: { entityCreate: 99999, dailyCap: -5 },
      stipend: { amount: -1 }, gifting: { maxPerGift: 0 },
    });
    expect(cfg.earn.entityCreate).toBe(1000);
    expect(cfg.earn.dailyCap).toBe(0);
    expect(cfg.stipend.amount).toBe(0);
    expect(cfg.gifting.maxPerGift).toBe(1);
  });
});

describe("SLOT_FOR_TYPE", () => {
  it("covers every item type; packs/merch are owned-not-worn", () => {
    for (const t of STORE_ITEM_TYPES) expect(SLOT_FOR_TYPE).toHaveProperty(t);
    expect(SLOT_FOR_TYPE.profile_banner).toBe("banner");
    expect(SLOT_FOR_TYPE.badge).toBe("badges");
    expect(SLOT_FOR_TYPE.emoji_pack).toBeNull();
    expect(SLOT_FOR_TYPE.reaction_skin).toBeNull();
    expect(SLOT_FOR_TYPE.merch).toBeNull();
  });
});

describe("request schemas", () => {
  it("equip: badges slot takes badgeItemIds, single slots take itemId, flair needs spaceId", () => {
    expect(equipSchema.safeParse({ slot: "avatar_decoration", itemId: "5b8e1a52-0000-4000-8000-000000000001" }).success).toBe(true);
    expect(equipSchema.safeParse({ slot: "avatar_decoration", itemId: null }).success).toBe(true); // unequip
    expect(equipSchema.safeParse({ slot: "badges", itemId: null, badgeItemIds: ["5b8e1a52-0000-4000-8000-000000000001"] }).success).toBe(true);
    expect(equipSchema.safeParse({ slot: "badges", itemId: "5b8e1a52-0000-4000-8000-000000000001" }).success).toBe(false);
    expect(equipSchema.safeParse({ slot: "flair", itemId: "5b8e1a52-0000-4000-8000-000000000001" }).success).toBe(false); // no spaceId
    expect(equipSchema.safeParse({ slot: "flair", itemId: "5b8e1a52-0000-4000-8000-000000000001", spaceId: "5b8e1a52-0000-4000-8000-000000000002" }).success).toBe(true);
  });
  it("gift: exactly one of amount|itemId; positive int amounts", () => {
    const to = "5b8e1a52-0000-4000-8000-000000000003", idempotencyKey = "test-key-0001";
    expect(giftSchema.safeParse({ toUserId: to, amount: 10, idempotencyKey }).success).toBe(true);
    expect(giftSchema.safeParse({ toUserId: to, itemId: to, idempotencyKey }).success).toBe(true);
    expect(giftSchema.safeParse({ toUserId: to, idempotencyKey }).success).toBe(false);
    expect(giftSchema.safeParse({ toUserId: to, amount: 5, itemId: to, idempotencyKey }).success).toBe(false);
    expect(giftSchema.safeParse({ toUserId: to, amount: 0, idempotencyKey }).success).toBe(false);
    expect(giftSchema.safeParse({ toUserId: to, amount: 1.5, idempotencyKey }).success).toBe(false);
  });
  it("createStoreItem: merch rejected in Phase 1; flair requires spaceId; others reject spaceId", () => {
    const base = { name: "Halo", priceCoins: 50, status: "published" };
    expect(createStoreItemSchema.safeParse({ ...base, type: "avatar_decoration" }).success).toBe(true);
    expect(createStoreItemSchema.safeParse({ ...base, type: "merch" }).success).toBe(false);
    expect(createStoreItemSchema.safeParse({ ...base, type: "flair" }).success).toBe(false);
    expect(createStoreItemSchema.safeParse({ ...base, type: "flair", spaceId: "5b8e1a52-0000-4000-8000-000000000002" }).success).toBe(true);
    expect(createStoreItemSchema.safeParse({ ...base, type: "badge", spaceId: "5b8e1a52-0000-4000-8000-000000000002" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (repo root): `pnpm --filter @agora-server/contract exec vitest run store`
Expected: FAIL — `Cannot find module './store.js'`

- [ ] **Step 3: Write the implementation** — `packages/contract/src/store.ts`:

```ts
// Store (marketplace) contract — Phase 1: item/ledger/cosmetics types, request schemas, and the
// store_config resolver. Pure types + zod (no hono/drizzle). Spec:
// docs/superpowers/specs/2026-07-17-store-marketplace-design.md
import { z } from "zod";

export const STORE_ITEM_TYPES = [
  "avatar_decoration", "profile_effect", "name_style", "profile_banner",
  "emoji_pack", "reaction_skin", "badge", "flair", "merch",
] as const;
export type StoreItemType = (typeof STORE_ITEM_TYPES)[number];
export const STORE_ITEM_STATUSES = ["draft", "published", "archived"] as const;
export type StoreItemStatus = (typeof STORE_ITEM_STATUSES)[number];
export const EQUIP_SLOTS = ["avatar_decoration", "profile_effect", "name_style", "banner", "badges", "flair"] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];
export const COIN_TXN_KINDS = [
  "earn_activity", "stipend", "admin_grant", "gift_sent", "gift_received", "purchase", "refund", "topup",
] as const;
export type CoinTxnKind = (typeof COIN_TXN_KINDS)[number];

/** Which equip slot a type occupies; null = owned-not-worn (packs unlock usage; merch is Phase 2). */
export const SLOT_FOR_TYPE: Record<StoreItemType, EquipSlot | null> = {
  avatar_decoration: "avatar_decoration",
  profile_effect: "profile_effect",
  name_style: "name_style",
  profile_banner: "banner",
  badge: "badges",
  flair: "flair",
  emoji_pack: null,
  reaction_skin: null,
  merch: null,
};

// ─── Response models (MODELS.md §store) ──────────────────────────────────────
export interface StoreItem {
  id: string;
  projectId: string;
  type: StoreItemType;
  name: string;
  description: string | null;
  priceCoins: number;
  renderPayload: Record<string, unknown>;
  spaceId: string | null;
  availableFrom: string | null;
  availableUntil: string | null;
  maxSupply: number | null;
  soldCount: number;
  status: StoreItemStatus;
  creatorId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CoinTransaction {
  id: string;
  amount: number;
  kind: CoinTxnKind;
  itemId: string | null;
  counterpartyProfileId: string | null;
  createdAt: string;
}

export interface InventoryItem {
  id: string;
  itemId: string;
  acquiredVia: "purchase" | "grant" | "gift";
  createdAt: string;
  item: StoreItem | null;
}

/** Resolved equipped cosmetics carried on the User shape (shapeUser().cosmetics). */
export interface UserCosmetics {
  avatarDecoration: StoreItem | null;
  profileEffect: StoreItem | null;
  nameStyle: StoreItem | null;
  banner: StoreItem | null;
  badges: StoreItem[];
  flair: StoreItem | null;
}

// ─── store_config (projects.store_config jsonb) ──────────────────────────────
export interface ResolvedStoreConfig {
  enabled: boolean;
  earn: { entityCreate: number; commentCreate: number; reactionReceived: number; eventAttendance: number; dailyCap: number };
  stipend: { enabled: boolean; amount: number };
  gifting: { enabled: boolean; maxPerGift: number };
}

export const STORE_CONFIG_DEFAULTS: ResolvedStoreConfig = {
  enabled: false,
  earn: { entityCreate: 5, commentCreate: 2, reactionReceived: 1, eventAttendance: 10, dailyCap: 50 },
  stipend: { enabled: true, amount: 10 },
  gifting: { enabled: true, maxPerGift: 500 },
};

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === "number" && Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Fail-closed resolution of the stored jsonb: garbage → defaults (store disabled); every numeric clamped. */
export function resolveStoreConfig(stored: unknown): ResolvedStoreConfig {
  const s = obj(stored);
  const d = STORE_CONFIG_DEFAULTS;
  const earn = obj(s.earn), stipend = obj(s.stipend), gifting = obj(s.gifting);
  return {
    enabled: bool(s.enabled, d.enabled),
    earn: {
      entityCreate: clamp(earn.entityCreate, 0, 1000, d.earn.entityCreate),
      commentCreate: clamp(earn.commentCreate, 0, 1000, d.earn.commentCreate),
      reactionReceived: clamp(earn.reactionReceived, 0, 1000, d.earn.reactionReceived),
      eventAttendance: clamp(earn.eventAttendance, 0, 1000, d.earn.eventAttendance),
      dailyCap: clamp(earn.dailyCap, 0, 10_000, d.earn.dailyCap),
    },
    stipend: { enabled: bool(stipend.enabled, d.stipend.enabled), amount: clamp(stipend.amount, 0, 1000, d.stipend.amount) },
    gifting: { enabled: bool(gifting.enabled, d.gifting.enabled), maxPerGift: clamp(gifting.maxPerGift, 1, 100_000, d.gifting.maxPerGift) },
  };
}

// ─── Request schemas ─────────────────────────────────────────────────────────
const intRange = (lo: number, hi: number) => z.number().int().min(lo).max(hi);

/** PATCH /settings/store body — partial overrides; null clears a key back to default. */
export const storeConfigSchema = z.object({
  enabled: z.boolean().nullish(),
  earn: z.object({
    entityCreate: intRange(0, 1000).nullish(),
    commentCreate: intRange(0, 1000).nullish(),
    reactionReceived: intRange(0, 1000).nullish(),
    eventAttendance: intRange(0, 1000).nullish(),
    dailyCap: intRange(0, 10_000).nullish(),
  }).strict().nullish(),
  stipend: z.object({ enabled: z.boolean().nullish(), amount: intRange(0, 1000).nullish() }).strict().nullish(),
  gifting: z.object({ enabled: z.boolean().nullish(), maxPerGift: intRange(1, 100_000).nullish() }).strict().nullish(),
}).strict();

const storeItemBase = z.object({
  type: z.enum(STORE_ITEM_TYPES),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  priceCoins: intRange(0, 1_000_000),
  renderPayload: z.record(z.string(), z.unknown()).default({}),
  spaceId: z.string().uuid().nullish(),
  availableFrom: z.string().datetime({ offset: true }).nullish(),
  availableUntil: z.string().datetime({ offset: true }).nullish(),
  maxSupply: intRange(1, 1_000_000).nullish(),
  status: z.enum(STORE_ITEM_STATUSES).default("draft"),
});

const storeItemRules = (v: { type?: StoreItemType; spaceId?: string | null }, ctx: z.RefinementCtx) => {
  if (v.type === "merch") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["type"], message: "merch is Phase 2" });
  if (v.type === "flair" && !v.spaceId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spaceId"], message: "flair requires spaceId" });
  if (v.type && v.type !== "flair" && v.spaceId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spaceId"], message: "only flair is space-scoped" });
};

export const createStoreItemSchema = storeItemBase.strict().superRefine(storeItemRules);
export const updateStoreItemSchema = storeItemBase.partial().omit({ type: true }).strict(); // type is immutable

export const purchaseItemSchema = z.object({ idempotencyKey: z.string().min(8).max(128) }).strict();

export const equipSchema = z.object({
  slot: z.enum(EQUIP_SLOTS),
  itemId: z.string().uuid().nullable(),
  badgeItemIds: z.array(z.string().uuid()).max(10).nullish(),
  spaceId: z.string().uuid().nullish(),
}).strict().superRefine((v, ctx) => {
  if (v.slot === "badges") {
    if (v.itemId !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["itemId"], message: "badges slot uses badgeItemIds" });
  } else if (v.badgeItemIds != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["badgeItemIds"], message: "only the badges slot takes badgeItemIds" });
  }
  if (v.slot === "flair" && v.itemId !== null && !v.spaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spaceId"], message: "flair requires spaceId" });
  }
  if (v.slot !== "flair" && v.spaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spaceId"], message: "only flair is space-scoped" });
  }
});

export const giftSchema = z.object({
  toUserId: z.string().uuid(),
  amount: intRange(1, 100_000).nullish(),
  itemId: z.string().uuid().nullish(),
  message: z.string().max(500).nullish(),
  idempotencyKey: z.string().min(8).max(128),
}).strict().superRefine((v, ctx) => {
  if ((v.amount == null) === (v.itemId == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "exactly one of amount or itemId" });
  }
});

export const grantCoinsSchema = z.object({
  toUserId: z.string().uuid(),
  amount: intRange(1, 1_000_000),
  note: z.string().max(500).nullish(),
}).strict();
```

- [ ] **Step 4: Export from the barrel** — in `packages/contract/src/index.ts`, add alongside the existing wildcard exports:

```ts
export * from "./store.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run (repo root): `pnpm --filter @agora-server/contract exec vitest run store`
Expected: PASS (all describe blocks green)

- [ ] **Step 6: Build the contract + typecheck**

Run (repo root): `pnpm --filter @agora-server/contract build && pnpm -r typecheck`
Expected: clean

- [ ] **Step 7: Commit** (if per-task commits approved)

```bash
git add packages/contract/src/store.ts packages/contract/src/store.test.ts packages/contract/src/index.ts
git commit -s -m "feat(contract): store types, request schemas, store_config resolver"
```

---

### Task 2: Core schema — store enums + five tables

**Files:**
- Modify: `packages/core/src/db/schema/_shared.ts`
- Create: `packages/core/src/db/schema/store.ts`
- Modify: `packages/core/src/db/schema/index.ts`

**Interfaces:**
- Consumes: `projects`, `profiles` (`./projects.js`), `spaces` (`./spaces.js`).
- Produces: Drizzle tables `storeItems`, `coinTransactions`, `coinBalances`, `storeInventory`, `storeEquipped`; enums `storeItemType`, `storeItemStatus`, `coinTxnKind`, `storeAcquiredVia`, `storeEquipSlot`. Row types via `typeof storeItems.$inferSelect` etc.

- [ ] **Step 1: Add enums** — append to `packages/core/src/db/schema/_shared.ts` (values MUST byte-match Task 1's const arrays and Task 3's SQL):

```ts
// ─── Store (marketplace, Phase 1) ────────────────────────────────────────────
export const storeItemType = pgEnum("store_item_type", ["avatar_decoration", "profile_effect", "name_style", "profile_banner", "emoji_pack", "reaction_skin", "badge", "flair", "merch"]);
export const storeItemStatus = pgEnum("store_item_status", ["draft", "published", "archived"]);
// Append-only ledger kinds; corrections are compensating entries, never updates. "topup" reserved for Phase 2.
export const coinTxnKind = pgEnum("coin_txn_kind", ["earn_activity", "stipend", "admin_grant", "gift_sent", "gift_received", "purchase", "refund", "topup"]);
export const storeAcquiredVia = pgEnum("store_acquired_via", ["purchase", "grant", "gift"]);
export const storeEquipSlot = pgEnum("store_equip_slot", ["avatar_decoration", "profile_effect", "name_style", "banner", "badges", "flair"]);
```

- [ ] **Step 2: Create the tables file** — `packages/core/src/db/schema/store.ts`:

```ts
// Store Phase 1: catalog, append-only coin ledger, trigger-maintained balances, inventory, equipped.
// Balance/sold_count maintenance + purchase/gift/earn/stipend serialization live in drizzle/0066
// (hand-written SQL) — handlers never write coin_balances or sold_count directly.
import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, jsonb, timestamp, index, unique, primaryKey,
} from "drizzle-orm/pg-core";
import { storeItemType, storeItemStatus, coinTxnKind, storeAcquiredVia, storeEquipSlot } from "./_shared.js";
import { projects, profiles } from "./projects.js";
import { spaces } from "./spaces.js";

export const storeItems = pgTable("store_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  type: storeItemType("type").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  priceCoins: integer("price_coins").notNull().default(0),
  renderPayload: jsonb("render_payload").notNull().default(sql`'{}'::jsonb`),
  spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "cascade" }),
  availableFrom: timestamp("available_from", { withTimezone: true }),
  availableUntil: timestamp("available_until", { withTimezone: true }),
  maxSupply: integer("max_supply"),
  soldCount: integer("sold_count").notNull().default(0),
  status: storeItemStatus("status").notNull().default("draft"),
  // Creator-ready (spec §3.1) — unused in v1, so a creator marketplace is a feature flag, not a migration.
  creatorId: uuid("creator_id").references(() => profiles.id, { onDelete: "set null" }),
  revenueShareBps: integer("revenue_share_bps").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("store_items_catalog_idx").on(t.projectId, t.status, t.type),
]);

export const coinTransactions = pgTable("coin_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  amount: integer("amount").notNull(),
  kind: coinTxnKind("kind").notNull(),
  itemId: uuid("item_id").references(() => storeItems.id, { onDelete: "set null" }),
  counterpartyProfileId: uuid("counterparty_profile_id").references(() => profiles.id, { onDelete: "set null" }),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("coin_txns_idem").on(t.projectId, t.profileId, t.idempotencyKey),
  index("coin_txns_profile_idx").on(t.projectId, t.profileId, t.createdAt),
]);

export const coinBalances = pgTable("coin_balances", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  balance: integer("balance").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.profileId] }),
]);

export const storeInventory = pgTable("store_inventory", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => storeItems.id, { onDelete: "cascade" }),
  acquiredVia: storeAcquiredVia("acquired_via").notNull(),
  transactionId: uuid("transaction_id").references(() => coinTransactions.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("store_inventory_unique").on(t.profileId, t.itemId),
  index("store_inventory_profile_idx").on(t.projectId, t.profileId),
]);

export const storeEquipped = pgTable("store_equipped", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  slot: storeEquipSlot("slot").notNull(),
  spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "cascade" }), // flair rows only
  itemId: uuid("item_id").references(() => storeItems.id, { onDelete: "cascade" }),
  itemIds: jsonb("item_ids"), // badges slot only: ordered id list
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("store_equipped_unique").on(t.projectId, t.profileId, t.slot, t.spaceId).nullsNotDistinct(),
  index("store_equipped_profile_idx").on(t.projectId, t.profileId),
]);
```

- [ ] **Step 3: Export** — in `packages/core/src/db/schema/index.ts`, add beside the other wildcard exports:

```ts
export * from "./store.js";
```

- [ ] **Step 4: Build + typecheck**

Run (repo root): `pnpm --filter @agora/core build && pnpm -r typecheck`
Expected: clean (tables compile; no runtime change yet)

- [ ] **Step 5: Commit** (if approved)

```bash
git add packages/core/src/db/schema/_shared.ts packages/core/src/db/schema/store.ts packages/core/src/db/schema/index.ts
git commit -s -m "feat(core): store schema — catalog, coin ledger, balances, inventory, equipped"
```

---

### Task 3: Migration `0066_store_phase1` — DDL, RLS, balance trigger, serialized SQL functions

**Files:**
- Create: `apps/api/drizzle/0066_store_phase1.sql`
- Modify: `apps/api/drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: Task 2's table/enum names (SQL must byte-match them).
- Produces (called by later tasks via `db.execute(sql\`...\`)`): `purchase_store_item(p_project uuid, p_buyer uuid, p_item uuid, p_key text) returns text` — `'ok' | 'duplicate' | 'not_available' | 'sold_out' | 'already_owned' | 'insufficient_balance'`; `store_gift_coins(p_project, p_from, p_to, p_amount int, p_key) returns text` — `'ok' | 'duplicate' | 'invalid' | 'insufficient_balance'`; `store_gift_item(p_project, p_from, p_to, p_item, p_key) returns text` — `'ok' | 'duplicate' | 'invalid' | 'not_owned' | 'already_owned'`; `store_credit_earn(p_project, p_profile, p_amount int, p_daily_cap int, p_key) returns int` (coins actually granted, 0 if capped/duplicate); `store_claim_stipend(p_project, p_profile, p_amount int) returns text` — `'ok' | 'cooldown' | 'disabled'`. Trigger `coin_txn_balance` maintains `coin_balances`.

- [ ] **Step 1: Write the migration** — `apps/api/drizzle/0066_store_phase1.sql` (idempotent throughout; enums guarded because `CREATE TYPE` has no `IF NOT EXISTS`):

```sql
-- apps/api/drizzle/0066_store_phase1.sql
-- Store Phase 1 (spec docs/superpowers/specs/2026-07-17-store-marketplace-design.md §3):
-- catalog + append-only coin ledger + trigger-maintained balances + serialized purchase/gift/
-- earn/stipend functions. Every table ships its own RLS deny-all (0017's guard was one-time).
-- Handlers NEVER write coin_balances/sold_count — only the trigger + these functions do.
SET search_path TO public, extensions;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE store_item_type AS ENUM ('avatar_decoration','profile_effect','name_style','profile_banner','emoji_pack','reaction_skin','badge','flair','merch');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE store_item_status AS ENUM ('draft','published','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE coin_txn_kind AS ENUM ('earn_activity','stipend','admin_grant','gift_sent','gift_received','purchase','refund','topup');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE store_acquired_via AS ENUM ('purchase','grant','gift');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE store_equip_slot AS ENUM ('avatar_decoration','profile_effect','name_style','banner','badges','flair');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS store_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type store_item_type NOT NULL,
  name text NOT NULL,
  description text,
  price_coins integer NOT NULL DEFAULT 0 CHECK (price_coins >= 0),
  render_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  space_id uuid REFERENCES spaces(id) ON DELETE CASCADE,
  available_from timestamptz,
  available_until timestamptz,
  max_supply integer CHECK (max_supply > 0),
  sold_count integer NOT NULL DEFAULT 0,
  status store_item_status NOT NULL DEFAULT 'draft',
  creator_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  revenue_share_bps integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS store_items_catalog_idx ON store_items (project_id, status, type);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS coin_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount integer NOT NULL,
  kind coin_txn_kind NOT NULL,
  item_id uuid REFERENCES store_items(id) ON DELETE SET NULL,
  counterparty_profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coin_txns_idem UNIQUE (project_id, profile_id, idempotency_key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS coin_txns_profile_idx ON coin_transactions (project_id, profile_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS coin_balances (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  balance integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, profile_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS store_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES store_items(id) ON DELETE CASCADE,
  acquired_via store_acquired_via NOT NULL,
  transaction_id uuid REFERENCES coin_transactions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_inventory_unique UNIQUE (profile_id, item_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS store_inventory_profile_idx ON store_inventory (project_id, profile_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS store_equipped (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  slot store_equip_slot NOT NULL,
  space_id uuid REFERENCES spaces(id) ON DELETE CASCADE,
  item_id uuid REFERENCES store_items(id) ON DELETE CASCADE,
  item_ids jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_equipped_unique UNIQUE NULLS NOT DISTINCT (project_id, profile_id, slot, space_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS store_equipped_profile_idx ON store_equipped (project_id, profile_id);
--> statement-breakpoint
ALTER TABLE store_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE coin_transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE coin_balances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE store_inventory ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE store_equipped ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Balance maintenance: the ONLY writer of coin_balances.
create or replace function on_coin_txn_insert() returns trigger language plpgsql as $$
begin
  insert into coin_balances (project_id, profile_id, balance, updated_at)
    values (new.project_id, new.profile_id, new.amount, now())
  on conflict (project_id, profile_id)
    do update set balance = coin_balances.balance + new.amount, updated_at = now();
  return new;
end $$;
--> statement-breakpoint
drop trigger if exists coin_txn_balance on coin_transactions;
--> statement-breakpoint
create trigger coin_txn_balance after insert on coin_transactions
  for each row execute function on_coin_txn_insert();
--> statement-breakpoint
-- Per-(project,profile) wallet serialization without requiring a balance row to exist yet.
create or replace function store_wallet_lock(p_project uuid, p_profile uuid) returns void
language sql as $$
  select pg_advisory_xact_lock(hashtextextended(p_project::text || ':' || p_profile::text, 7401));
$$;
--> statement-breakpoint
-- Atomic purchase: every check + debit + inventory + sold_count in one tx; fail-closed.
create or replace function purchase_store_item(p_project uuid, p_buyer uuid, p_item uuid, p_key text)
returns text language plpgsql as $$
declare v_item store_items%rowtype; v_balance int; v_txn uuid;
begin
  perform store_wallet_lock(p_project, p_buyer);
  if exists (select 1 from coin_transactions
             where project_id = p_project and profile_id = p_buyer and idempotency_key = p_key) then
    return 'duplicate';
  end if;
  select * into v_item from store_items
    where id = p_item and project_id = p_project for update;
  if not found or v_item.status <> 'published' or v_item.type = 'merch' then return 'not_available'; end if;
  if v_item.available_from is not null and now() < v_item.available_from then return 'not_available'; end if;
  if v_item.available_until is not null and now() > v_item.available_until then return 'not_available'; end if;
  if v_item.max_supply is not null and v_item.sold_count >= v_item.max_supply then return 'sold_out'; end if;
  if exists (select 1 from store_inventory where profile_id = p_buyer and item_id = p_item) then
    return 'already_owned';
  end if;
  select coalesce(balance, 0) into v_balance from coin_balances
    where project_id = p_project and profile_id = p_buyer;
  if coalesce(v_balance, 0) < v_item.price_coins then return 'insufficient_balance'; end if;
  insert into coin_transactions (project_id, profile_id, amount, kind, item_id, idempotency_key)
    values (p_project, p_buyer, -v_item.price_coins, 'purchase', p_item, p_key)
    returning id into v_txn;
  insert into store_inventory (project_id, profile_id, item_id, acquired_via, transaction_id)
    values (p_project, p_buyer, p_item, 'purchase', v_txn);
  update store_items set sold_count = sold_count + 1, updated_at = now() where id = p_item;
  return 'ok';
end $$;
--> statement-breakpoint
create or replace function store_gift_coins(p_project uuid, p_from uuid, p_to uuid, p_amount int, p_key text)
returns text language plpgsql as $$
declare v_balance int;
begin
  if p_amount <= 0 or p_from = p_to then return 'invalid'; end if;
  perform store_wallet_lock(p_project, p_from);
  if exists (select 1 from coin_transactions
             where project_id = p_project and profile_id = p_from and idempotency_key = p_key) then
    return 'duplicate';
  end if;
  select coalesce(balance, 0) into v_balance from coin_balances
    where project_id = p_project and profile_id = p_from;
  if coalesce(v_balance, 0) < p_amount then return 'insufficient_balance'; end if;
  insert into coin_transactions (project_id, profile_id, amount, kind, counterparty_profile_id, idempotency_key)
    values (p_project, p_from, -p_amount, 'gift_sent', p_to, p_key);
  insert into coin_transactions (project_id, profile_id, amount, kind, counterparty_profile_id, idempotency_key)
    values (p_project, p_to, p_amount, 'gift_received', p_from, p_key || ':recv');
  return 'ok';
end $$;
--> statement-breakpoint
-- Item gift: moves the inventory row; zero-amount ledger pair records the transfer for audit.
create or replace function store_gift_item(p_project uuid, p_from uuid, p_to uuid, p_item uuid, p_key text)
returns text language plpgsql as $$
declare v_inv store_inventory%rowtype; v_txn uuid;
begin
  if p_from = p_to then return 'invalid'; end if;
  perform store_wallet_lock(p_project, p_from);
  if exists (select 1 from coin_transactions
             where project_id = p_project and profile_id = p_from and idempotency_key = p_key) then
    return 'duplicate';
  end if;
  select * into v_inv from store_inventory
    where project_id = p_project and profile_id = p_from and item_id = p_item for update;
  if not found then return 'not_owned'; end if;
  if exists (select 1 from store_inventory where profile_id = p_to and item_id = p_item) then
    return 'already_owned';
  end if;
  delete from store_inventory where id = v_inv.id;
  delete from store_equipped
    where project_id = p_project and profile_id = p_from and item_id = p_item;
  insert into coin_transactions (project_id, profile_id, amount, kind, item_id, counterparty_profile_id, idempotency_key)
    values (p_project, p_from, 0, 'gift_sent', p_item, p_to, p_key);
  insert into coin_transactions (project_id, profile_id, amount, kind, item_id, counterparty_profile_id, idempotency_key)
    values (p_project, p_to, 0, 'gift_received', p_item, p_from, p_key || ':recv')
    returning id into v_txn;
  insert into store_inventory (project_id, profile_id, item_id, acquired_via, transaction_id)
    values (p_project, p_to, p_item, 'gift', v_txn);
  return 'ok';
end $$;
--> statement-breakpoint
-- Earn credit under the daily cap; returns coins actually granted (0 = capped or duplicate).
create or replace function store_credit_earn(p_project uuid, p_profile uuid, p_amount int, p_daily_cap int, p_key text)
returns int language plpgsql as $$
declare v_today int; v_grant int;
begin
  if p_amount <= 0 or p_daily_cap <= 0 then return 0; end if;
  perform store_wallet_lock(p_project, p_profile);
  if exists (select 1 from coin_transactions
             where project_id = p_project and profile_id = p_profile and idempotency_key = p_key) then
    return 0;
  end if;
  select coalesce(sum(amount), 0) into v_today from coin_transactions
    where project_id = p_project and profile_id = p_profile and kind = 'earn_activity'
      and amount > 0 and created_at >= date_trunc('day', now());
  v_grant := least(p_amount, greatest(0, p_daily_cap - v_today));
  if v_grant = 0 then return 0; end if;
  insert into coin_transactions (project_id, profile_id, amount, kind, idempotency_key)
    values (p_project, p_profile, v_grant, 'earn_activity', p_key);
  return v_grant;
end $$;
--> statement-breakpoint
create or replace function store_claim_stipend(p_project uuid, p_profile uuid, p_amount int)
returns text language plpgsql as $$
begin
  if p_amount <= 0 then return 'disabled'; end if;
  perform store_wallet_lock(p_project, p_profile);
  if exists (select 1 from coin_transactions
             where project_id = p_project and profile_id = p_profile and kind = 'stipend'
               and created_at > now() - interval '24 hours') then
    return 'cooldown';
  end if;
  insert into coin_transactions (project_id, profile_id, amount, kind, idempotency_key)
    values (p_project, p_profile, p_amount, 'stipend', 'stipend:' || to_char(now(), 'YYYYMMDDHH24MISSUS'));
  return 'ok';
end $$;
```

- [ ] **Step 2: Add the journal entry** — clone the last entry so `version`/shape stay exact; `when` = max+1 (`1781934611663`):

Run (from `apps/api/`):
```bash
python3 - <<'PY'
import json
p = "drizzle/meta/_journal.json"
j = json.load(open(p))
last = j["entries"][-1]
assert last["tag"] != "0066_store_phase1", "already added"
e = dict(last)
e.update(idx=last["idx"] + 1, when=last["when"] + 1, tag="0066_store_phase1")
j["entries"].append(e)
json.dump(j, open(p, "w"), indent=2)
print("added", e)
PY
```
Expected: `added {'idx': 66, ... 'tag': '0066_store_phase1', 'when': ...}` — idx/when are derived from whatever entry is currently last in the journal (self-adjusting), not hardcoded; as of 2026-07-18 the last entry is idx 65 `0065_entity_internet_public` (when 1784246400000), so this produces idx 66. Re-verify at execution time — the journal may have moved again.

- [ ] **Step 3: Apply to the dev DB**

Run (from `apps/api/`): `pnpm db:migrate:run`
Expected: applies `0066_store_phase1` without error (NOT `db:migrate` — journal-schema gotcha)

- [ ] **Step 4: Smoke the functions directly** (idempotency + trigger):

```bash
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
psql "$url" -v ON_ERROR_STOP=1 -c "select purchase_store_item(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'k1');"
```
Expected: `not_available` (nonexistent item fails closed, no exception)

- [ ] **Step 5: Verify idempotency of the migration itself**

Run: `pnpm db:migrate:run`
Expected: no-op, no error (already applied; file is re-runnable by hand too)

- [ ] **Step 6: Commit** (if approved)

```bash
git add apps/api/drizzle/0066_store_phase1.sql apps/api/drizzle/meta/_journal.json
git commit -s -m "feat(db): store phase 1 — tables, RLS, balance trigger, serialized purchase/gift/earn/stipend fns"
```

---

### Task 4: `lib/store-config.ts` + `GET/PATCH /settings/store`

**Files:**
- Create: `apps/api/src/lib/store-config.ts`
- Modify: `apps/api/src/routes/misc.ts`
- Create: `apps/api/test/integration/store-admin.test.ts` (settings block only; Task 10 extends it)

**Interfaces:**
- Consumes: `resolveStoreConfig`, `storeConfigSchema`, `ResolvedStoreConfig` (Task 1); `projects.storeConfig` column — **note:** add the column mapping to `packages/core/src/db/schema/projects.ts` in this task:

```ts
  storeConfig: jsonb("store_config").notNull().default(sql`'{}'::jsonb`),
```
  and the matching DDL belongs in Task 3's migration — append there before applying (if Task 3 already ran, add to the SAME file; it's idempotent):

```sql
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN IF NOT EXISTS store_config jsonb NOT NULL DEFAULT '{}'::jsonb;
```
- Produces: `getStoreConfig(projectId): Promise<ResolvedStoreConfig>` (30s cache), `invalidateStoreConfig(projectId): void`, `storeConfigView(stored, effective)`.

- [ ] **Step 1: Write the failing integration test** — `apps/api/test/integration/store-admin.test.ts`:

```ts
// Store settings + admin surface. RED until misc.ts settings endpoints + lib/store-config exist.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, deleteProject, createUser, signToken, base } from "./helpers.js";

describe("store settings (integration)", () => {
  let projectId: string; let B: string;
  let admin: { id: string; token: string }; let member: { id: string; token: string };
  let roAdminToken: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    member = await createUser(projectId);
    admin = await createUser(projectId);
    admin.token = await signToken(admin.id, "visitor", false, false, false, true, projectId); // padmin
    roAdminToken = await signToken(admin.id, "visitor", false, false, false, true, projectId, true); // + settingsReadonly
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("GET /settings/store is admin-gated and returns stored + effective", async () => {
    expect((await api("GET", `${B}/settings/store`, { token: member.token })).status).toBe(403);
    const res = await api("GET", `${B}/settings/store`, { token: admin.token });
    expect(res.status).toBe(200);
    expect(res.body.effective.enabled).toBe(false); // default off
  });

  it("PATCH merges overrides, clears with null, and invalidates the cache", async () => {
    const res = await api("PATCH", `${B}/settings/store`, {
      token: admin.token, body: { enabled: true, earn: { entityCreate: 7 } },
    });
    expect(res.status).toBe(200);
    expect(res.body.effective.enabled).toBe(true);
    expect(res.body.effective.earn.entityCreate).toBe(7);
    const cleared = await api("PATCH", `${B}/settings/store`, { token: admin.token, body: { earn: null } });
    expect(cleared.body.effective.earn.entityCreate).toBe(5); // back to the default
  });

  it("settings-readonly operator gets 403 settings/read-only on PATCH (the sixth save)", async () => {
    const res = await api("PATCH", `${B}/settings/store`, { token: roAdminToken, body: { enabled: true } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("settings/read-only");
  });

  it("rejects out-of-range values at the boundary", async () => {
    const res = await api("PATCH", `${B}/settings/store`, { token: admin.token, body: { earn: { entityCreate: 5000 } } });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts store-admin`
Expected: FAIL — 404s (endpoints don't exist)

- [ ] **Step 3: Implement the resolver** — `apps/api/src/lib/store-config.ts` (mirror of `social-config.ts`):

```ts
// Per-project store config, resolved from projects.store_config JSONB with a 30s cache +
// invalidate — mirrors lib/social-config.ts. Resolution/clamping is the contract's pure
// resolveStoreConfig (fail-closed → store disabled).
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/index.js";
import { resolveStoreConfig, type ResolvedStoreConfig } from "@agora-server/contract";

const CONFIG_TTL_MS = 30_000;
const cache = new Map<string, { cfg: ResolvedStoreConfig; at: number }>();

export async function getStoreConfig(projectId: string): Promise<ResolvedStoreConfig> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
  const [p] = await getDb()
    .select({ storeConfig: projects.storeConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const cfg = resolveStoreConfig(p?.storeConfig);
  cache.set(projectId, { cfg, at: Date.now() });
  return cfg;
}

/** Drop the cached config (call after an admin PATCHes /settings/store). */
export function invalidateStoreConfig(projectId: string): void {
  cache.delete(projectId);
}

/** Admin GET view: raw stored overrides + the effective (resolved, clamped) config. */
export function storeConfigView(stored: unknown, effective: ResolvedStoreConfig) {
  const s = (stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}) as Record<string, unknown>;
  return { stored: s, effective };
}
```

- [ ] **Step 4: Add the settings endpoints** — in `apps/api/src/routes/misc.ts`, directly after the `.patch("/settings/social", ...)` block, mirroring it exactly:

```ts
  .get("/settings/store", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const [row] = await getDb()
      .select({ storeConfig: projects.storeConfig })
      .from(projects)
      .where(eq(projects.id, c.var.projectId))
      .limit(1);
    return c.json(storeConfigView(row?.storeConfig, resolveStoreConfig(row?.storeConfig)));
  })
  .patch("/settings/store", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    assertSettingsWritable(c);
    const body = parseBody(storeConfigSchema, await c.req.json().catch(() => ({})), "store");
    const [row] = await getDb()
      .select({ storeConfig: projects.storeConfig })
      .from(projects)
      .where(eq(projects.id, c.var.projectId))
      .limit(1);
    const current = (row?.storeConfig && typeof row.storeConfig === "object" ? row.storeConfig : {}) as Record<string, any>;
    const next: Record<string, any> = { ...current };
    for (const k of ["enabled", "earn", "stipend", "gifting"] as const) {
      const v = (body as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (v === null) delete next[k]; // clear → defaults
      else if (typeof v === "object") next[k] = { ...(typeof next[k] === "object" ? next[k] : {}), ...v };
      else next[k] = v;
    }
    await getDb().update(projects).set({ storeConfig: next }).where(eq(projects.id, c.var.projectId));
    invalidateStoreConfig(c.var.projectId);
    const effective = resolveStoreConfig(next);
    return c.json(storeConfigView(next, effective));
  })
```

Add to misc.ts's imports: `storeConfigSchema, resolveStoreConfig` from `@agora-server/contract`; `storeConfigView, invalidateStoreConfig` from `../lib/store-config.js`. (`requireProjectAdmin`, `assertSettingsWritable`, `parseBody`, `projects`, `eq` are already imported there.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts store-admin`
Expected: PASS (4 tests). Note: inner-object PATCH semantics are shallow-merge per key (`earn: null` clears the whole earn block → defaults).

- [ ] **Step 6: Typecheck + unit suite**

Run (repo root): `pnpm -r typecheck && pnpm --filter @agora/api test`
Expected: clean

- [ ] **Step 7: Commit** (if approved)

```bash
git add apps/api/src/lib/store-config.ts apps/api/src/routes/misc.ts apps/api/test/integration/store-admin.test.ts packages/core/src/db/schema/projects.ts apps/api/drizzle/0066_store_phase1.sql
git commit -s -m "feat(store): store_config resolver + GET/PATCH /settings/store (sixth read-only-gated save)"
```

---

### Task 5: `lib/store-shape.ts` — shapers + `buildCosmetics`

**Files:**
- Create: `apps/api/src/lib/store-shape.ts`
- Create: `apps/api/src/lib/store-shape.test.ts`

**Interfaces:**
- Consumes: `StoreItem`, `CoinTransaction`, `InventoryItem`, `UserCosmetics` (Task 1); row types from Task 2 (`typeof storeItems.$inferSelect` etc.).
- Produces: `shapeStoreItem(row): StoreItem`, `shapeCoinTransaction(row): CoinTransaction`, `shapeInventoryItem(row, item?): InventoryItem`, `buildCosmetics(equipRows, itemsById, spaceId?): UserCosmetics | null` (pure), `attachCosmetics(projectId, users: Map<string, User>, spaceId?): Promise<void>` (batcher; wired in Task 12).

- [ ] **Step 1: Write the failing unit test** — `apps/api/src/lib/store-shape.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildCosmetics, shapeStoreItem } from "./store-shape.js";

const item = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id, projectId: "p", type, name: id, description: null, priceCoins: 10,
  renderPayload: { url: `https://x/${id}.webp` }, spaceId: null, availableFrom: null,
  availableUntil: null, maxSupply: null, soldCount: 0, status: "published",
  creatorId: null, revenueShareBps: 0, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
  ...extra,
});
const equip = (slot: string, extra: Record<string, unknown> = {}) => ({
  id: `eq-${slot}`, projectId: "p", profileId: "u", slot, spaceId: null, itemId: null, itemIds: null,
  updatedAt: new Date("2026-01-01"), ...extra,
});

describe("shapeStoreItem", () => {
  it("camelCases, ISO-dates, and never leaks revenueShareBps", () => {
    const s = shapeStoreItem(item("halo", "avatar_decoration") as any);
    expect(s.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(s.renderPayload).toEqual({ url: "https://x/halo.webp" });
    expect("revenueShareBps" in s).toBe(false);
  });
});

describe("buildCosmetics", () => {
  const items = new Map(
    ["halo", "spark", "b1", "b2", "regular-flair"].map((id) => [id, shapeStoreItem(item(id, id.startsWith("b") ? "badge" : "avatar_decoration") as any)])
  );
  it("returns null when nothing is equipped", () => {
    expect(buildCosmetics([], items, null)).toBeNull();
  });
  it("resolves single slots and ordered badges; skips ids missing from the item map", () => {
    const c = buildCosmetics(
      [equip("avatar_decoration", { itemId: "halo" }) as any,
       equip("badges", { itemIds: ["b2", "gone", "b1"] }) as any],
      items, null,
    );
    expect(c?.avatarDecoration?.id).toBe("halo");
    expect(c?.badges.map((b) => b.id)).toEqual(["b2", "b1"]); // order kept, missing dropped
    expect(c?.profileEffect).toBeNull();
  });
  it("flair only surfaces for the matching space", () => {
    const rows = [equip("flair", { itemId: "regular-flair", spaceId: "s1" }) as any];
    expect(buildCosmetics(rows, items, "s1")?.flair?.id).toBe("regular-flair");
    expect(buildCosmetics(rows, items, "s2")?.flair ?? null).toBeNull();
    expect(buildCosmetics(rows, items, null)?.flair ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run store-shape`
Expected: FAIL — module not found

- [ ] **Step 3: Implement** — `apps/api/src/lib/store-shape.ts`:

```ts
// Store row → API-model shapers + the cosmetics resolver (spec §3.6). Pure except attachCosmetics.
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { storeItems, storeEquipped } from "../db/schema/index.js";
import type { StoreItem, CoinTransaction, InventoryItem, UserCosmetics, User, EquipSlot } from "@agora-server/contract";
import { getStoreConfig } from "./store-config.js";

type ItemRow = typeof storeItems.$inferSelect;
type EquipRow = typeof storeEquipped.$inferSelect;
type TxnRow = { id: string; amount: number; kind: CoinTransaction["kind"]; itemId: string | null; counterpartyProfileId: string | null; createdAt: Date };
type InvRow = { id: string; itemId: string; acquiredVia: InventoryItem["acquiredVia"]; createdAt: Date };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function shapeStoreItem(row: ItemRow): StoreItem {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    name: row.name,
    description: row.description ?? null,
    priceCoins: row.priceCoins,
    renderPayload: (row.renderPayload as Record<string, unknown>) ?? {},
    spaceId: row.spaceId ?? null,
    availableFrom: iso(row.availableFrom),
    availableUntil: iso(row.availableUntil),
    maxSupply: row.maxSupply ?? null,
    soldCount: row.soldCount,
    status: row.status,
    creatorId: row.creatorId ?? null,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

export function shapeCoinTransaction(row: TxnRow): CoinTransaction {
  return {
    id: row.id,
    amount: row.amount,
    kind: row.kind,
    itemId: row.itemId ?? null,
    counterpartyProfileId: row.counterpartyProfileId ?? null,
    createdAt: iso(row.createdAt)!,
  };
}

export function shapeInventoryItem(row: InvRow, item?: StoreItem | null): InventoryItem {
  return { id: row.id, itemId: row.itemId, acquiredVia: row.acquiredVia, createdAt: iso(row.createdAt)!, item: item ?? null };
}

/** Resolve equipped rows into the UserCosmetics shape. Pure. spaceId scopes which flair shows. */
export function buildCosmetics(
  equipRows: EquipRow[],
  itemsById: Map<string, StoreItem>,
  spaceId?: string | null,
): UserCosmetics | null {
  const out: UserCosmetics = {
    avatarDecoration: null, profileEffect: null, nameStyle: null, banner: null, badges: [], flair: null,
  };
  let any = false;
  for (const r of equipRows) {
    if (r.slot === "badges") {
      const ids = Array.isArray(r.itemIds) ? (r.itemIds as string[]) : [];
      out.badges = ids.map((id) => itemsById.get(id)).filter((x): x is StoreItem => !!x);
      any = any || out.badges.length > 0;
    } else if (r.slot === "flair") {
      if (spaceId && r.spaceId === spaceId && r.itemId) {
        out.flair = itemsById.get(r.itemId) ?? null;
        any = any || !!out.flair;
      }
    } else if (r.itemId) {
      const it = itemsById.get(r.itemId) ?? null;
      const key = { avatar_decoration: "avatarDecoration", profile_effect: "profileEffect", name_style: "nameStyle", banner: "banner" }[r.slot as Exclude<EquipSlot, "badges" | "flair">];
      if (it && key) { (out as any)[key] = it; any = true; }
    }
  }
  return any ? out : null;
}

/** Batcher: stamp .cosmetics onto every user in the map (2 queries total). No-op when store disabled. */
export async function attachCosmetics(projectId: string, users: Map<string, User>, spaceId?: string | null): Promise<void> {
  if (users.size === 0) return;
  const cfg = await getStoreConfig(projectId); // 30s-cached — cheap on hot paths
  if (!cfg.enabled) return;
  const ids = [...users.keys()];
  const equipRows = await getDb().select().from(storeEquipped)
    .where(and(eq(storeEquipped.projectId, projectId), inArray(storeEquipped.profileId, ids)));
  if (equipRows.length === 0) return;
  const itemIds = new Set<string>();
  for (const r of equipRows) {
    if (r.itemId) itemIds.add(r.itemId);
    if (Array.isArray(r.itemIds)) for (const id of r.itemIds as string[]) itemIds.add(id);
  }
  const itemRows = itemIds.size
    ? await getDb().select().from(storeItems)
        .where(and(eq(storeItems.projectId, projectId), inArray(storeItems.id, [...itemIds])))
    : [];
  const itemsById = new Map(itemRows.map((r) => [r.id, shapeStoreItem(r)]));
  const byProfile = new Map<string, EquipRow[]>();
  for (const r of equipRows) {
    const list = byProfile.get(r.profileId) ?? [];
    list.push(r); byProfile.set(r.profileId, list);
  }
  for (const [uid, u] of users) {
    const rows = byProfile.get(uid);
    if (rows) (u as User & { cosmetics?: UserCosmetics | null }).cosmetics = buildCosmetics(rows, itemsById, spaceId);
  }
}
```

Also in Task 1's `packages/contract/src/types.ts` territory: add the optional field to the `User` interface (it lives in `types.ts`; do it in THIS task since it's first needed here, then rebuild the contract):

```ts
  cosmetics?: UserCosmetics | null;
```
(import `UserCosmetics` from `./store.js` in `types.ts`.)

- [ ] **Step 4: Run to verify it passes**

Run (repo root): `pnpm --filter @agora-server/contract build && cd apps/api && pnpm exec vitest run store-shape`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck** — `pnpm -r typecheck` (repo root). Expected: clean.

- [ ] **Step 6: Commit** (if approved)

```bash
git add apps/api/src/lib/store-shape.ts apps/api/src/lib/store-shape.test.ts packages/contract/src/types.ts
git commit -s -m "feat(store): shapers + buildCosmetics/attachCosmetics; User.cosmetics contract field"
```

---

### Task 6: Router scaffold + member read endpoints + mount

**Files:**
- Create: `apps/api/src/routes/store.ts`
- Modify: `apps/api/src/routes/index.ts`
- Create: `apps/api/test/integration/store.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 symbols; `getStoreConfig`; `assertCanReadSpace(c, spaceId)` from `../lib/space-access.js`.
- Produces: `storeRoutes` (Hono) with `GET /catalog`, `GET /emoji`, `GET /me/balance`, `GET /me/transactions`, `GET /me/inventory`, `GET /items/:id`; the `storeGate` middleware every store endpoint sits behind. Later tasks ADD handlers to this router — route order rule: everything static stays declared above `/items/:id`.

- [ ] **Step 1: Write the failing integration test** — `apps/api/test/integration/store.test.ts`:

```ts
// Store member surface. RED until routes/store.ts exists and is mounted.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { api, createProject, deleteProject, createUser, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { projects, storeItems, coinTransactions } from "../../src/db/schema/index.js";
import { invalidateStoreConfig } from "../../src/lib/store-config.js";

async function enableStore(projectId: string) {
  await getDb().update(projects).set({ storeConfig: { enabled: true } }).where(eq(projects.id, projectId));
  invalidateStoreConfig(projectId);
}

describe("store member surface (integration)", () => {
  let projectId: string; let B: string; let me: { id: string; token: string };
  let publishedId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    me = await createUser(projectId);
    const rows = await getDb().insert(storeItems).values([
      { projectId, type: "avatar_decoration", name: "Halo", priceCoins: 25, status: "published" },
      { projectId, type: "badge", name: "Draft badge", priceCoins: 5, status: "draft" },
      { projectId, type: "profile_effect", name: "Expired", priceCoins: 5, status: "published",
        availableUntil: new Date(Date.now() - 86_400_000) },
    ]).returning();
    publishedId = rows[0]!.id;
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("everything 404s store/not-enabled while the store is off", async () => {
    const res = await api("GET", `${B}/store/catalog`, { token: me.token });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("store/not-enabled");
  });

  it("catalog lists only published, window-open items", async () => {
    await enableStore(projectId);
    const res = await api("GET", `${B}/store/catalog`, { token: me.token });
    expect(res.status).toBe(200);
    expect(res.body.data.map((i: any) => i.name)).toEqual(["Halo"]);
    expect(res.body.pagination).toBeTruthy();
  });

  it("GET /items/:id returns a published item; drafts 404", async () => {
    const ok = await api("GET", `${B}/store/items/${publishedId}`, { token: me.token });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe("Halo");
  });

  it("me/balance starts at 0; me/transactions shows the ledger newest-first", async () => {
    const bal = await api("GET", `${B}/store/me/balance`, { token: me.token });
    expect(bal.status).toBe(200);
    expect(bal.body.balance).toBe(0);
    await getDb().insert(coinTransactions).values({
      projectId, profileId: me.id, amount: 40, kind: "admin_grant", idempotencyKey: "seed-grant-1",
    });
    const bal2 = await api("GET", `${B}/store/me/balance`, { token: me.token });
    expect(bal2.body.balance).toBe(40); // trigger maintained it
    const txns = await api("GET", `${B}/store/me/transactions`, { token: me.token });
    expect(txns.body.data[0].kind).toBe("admin_grant");
    expect(txns.body.data[0]).not.toHaveProperty("idempotencyKey"); // never leaked
  });

  it("member surface requires auth", async () => {
    expect((await api("GET", `${B}/store/me/balance`, {})).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts "store\.test"`
Expected: FAIL — 404 without the `store/not-enabled` code (router not mounted)

- [ ] **Step 3: Implement the router** — `apps/api/src/routes/store.ts`:

```ts
// /v7/:projectId/store/* — Store Phase 1 (spec docs/superpowers/specs/2026-07-17-store-marketplace-design.md).
// Agora extension domain (MANIFEST §store). Every endpoint sits behind storeGate (config off → 404).
// Value mutations are ledger inserts via the 0066 SQL functions — never direct balance writes.
import { Hono } from "hono";
import { and, eq, desc, isNull, lte, gte, or, sql, inArray, count } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import { storeItems, coinBalances, coinTransactions, storeInventory, storeEquipped, profiles } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { parseBody } from "../lib/validation.js";
import {
  STORE_ITEM_TYPES, SLOT_FOR_TYPE, purchaseItemSchema, equipSchema, giftSchema,
  grantCoinsSchema, createStoreItemSchema, updateStoreItemSchema,
} from "@agora-server/contract";
import { getStoreConfig } from "../lib/store-config.js";
import { shapeStoreItem, shapeCoinTransaction, shapeInventoryItem } from "../lib/store-shape.js";
import { assertCanReadSpace } from "../lib/space-access.js";
import { requireProjectAdmin } from "../lib/project-roles.js";
import { logger } from "../lib/logger.js";

export const storeRoutes = new Hono<{ Variables: Variables }>()
  // Config gate for the whole domain: off → indistinguishable from a server without the feature.
  .use("*", async (c, next) => {
    const cfg = await getStoreConfig(c.var.projectId);
    if (!cfg.enabled) throw Errors.notFound("store/not-enabled", "Store is not enabled");
    await next();
  })

  .get("/catalog", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    const type = c.req.query("type");
    if (type && !(STORE_ITEM_TYPES as readonly string[]).includes(type)) {
      throw Errors.badRequest("store/invalid-type", "Unknown item type", "type");
    }
    const now = sql`now()`;
    const conds = [
      eq(storeItems.projectId, c.var.projectId),
      eq(storeItems.status, "published"),
      sql`${storeItems.type} <> 'merch'`,
      or(isNull(storeItems.availableFrom), lte(storeItems.availableFrom, now)),
      or(isNull(storeItems.availableUntil), gte(storeItems.availableUntil, now)),
    ];
    if (type) conds.push(eq(storeItems.type, type as (typeof STORE_ITEM_TYPES)[number]));
    const rows = await getDb().select().from(storeItems).where(and(...conds))
      .orderBy(desc(storeItems.createdAt)).limit(limit).offset(offset);
    // Space-scoped flair: only show rows whose space the caller can read (fail-closed per space).
    const readable = new Map<string, boolean>();
    const visible = [];
    for (const r of rows) {
      if (!r.spaceId) { visible.push(r); continue; }
      if (!readable.has(r.spaceId)) {
        try { await assertCanReadSpace(c, r.spaceId); readable.set(r.spaceId, true); }
        catch { readable.set(r.spaceId, false); }
      }
      if (readable.get(r.spaceId)) visible.push(r);
    }
    // total counts the SQL conds; unreadable-space flair filtering can shorten a page (never lengthens).
    const [{ total } = { total: 0 }] = await getDb().select({ total: count() }).from(storeItems).where(and(...conds));
    return c.json(paginate(visible.map(shapeStoreItem), total, page, limit));
  })

  .get("/emoji", requireAuth, async (c) => {
    const uid = c.var.auth!.userId;
    const rows = await getDb().select({ item: storeItems }).from(storeInventory)
      .innerJoin(storeItems, eq(storeInventory.itemId, storeItems.id))
      .where(and(
        eq(storeInventory.projectId, c.var.projectId),
        eq(storeInventory.profileId, uid),
        inArray(storeItems.type, ["emoji_pack", "reaction_skin"]),
      ));
    return c.json({ data: rows.map((r) => shapeStoreItem(r.item)) });
  })

  .get("/me/balance", requireAuth, async (c) => {
    const [row] = await getDb().select({ balance: coinBalances.balance }).from(coinBalances)
      .where(and(eq(coinBalances.projectId, c.var.projectId), eq(coinBalances.profileId, c.var.auth!.userId)))
      .limit(1);
    return c.json({ balance: row?.balance ?? 0 });
  })

  .get("/me/transactions", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    const where = and(eq(coinTransactions.projectId, c.var.projectId), eq(coinTransactions.profileId, c.var.auth!.userId));
    const rows = await getDb().select().from(coinTransactions).where(where)
      .orderBy(desc(coinTransactions.createdAt)).limit(limit).offset(offset);
    const [{ total } = { total: 0 }] = await getDb().select({ total: count() }).from(coinTransactions).where(where);
    return c.json(paginate(rows.map(shapeCoinTransaction), total, page, limit));
  })

  .get("/me/inventory", requireAuth, async (c) => {
    const rows = await getDb().select({ inv: storeInventory, item: storeItems }).from(storeInventory)
      .innerJoin(storeItems, eq(storeInventory.itemId, storeItems.id))
      .where(and(eq(storeInventory.projectId, c.var.projectId), eq(storeInventory.profileId, c.var.auth!.userId)))
      .orderBy(desc(storeInventory.createdAt));
    return c.json({ data: rows.map((r) => shapeInventoryItem(r.inv, shapeStoreItem(r.item))) });
  })

  // ⚠️ Everything static stays ABOVE /items/:id (Hono capture rule). Later tasks add handlers here.
  .get("/items/:id", requireAuth, async (c) => {
    const [row] = await getDb().select().from(storeItems)
      .where(and(eq(storeItems.projectId, c.var.projectId), eq(storeItems.id, c.req.param("id"))))
      .limit(1);
    if (!row || row.status !== "published") throw Errors.notFound("store/item-not-found", "Item not found");
    if (row.spaceId) await assertCanReadSpace(c, row.spaceId);
    return c.json(shapeStoreItem(row));
  });
```

(The unused imports — `parseBody`, schemas, `SLOT_FOR_TYPE`, `storeEquipped`, `profiles`, `requireProjectAdmin`, `logger` — are consumed by Tasks 7–10 which extend this file; if the linter complains at this task's commit, import them in the task that uses them instead.)

- [ ] **Step 4: Mount** — in `apps/api/src/routes/index.ts`, beside the other domain mounts:

```ts
import { storeRoutes } from "./store.js";
// …
  project.route("/store", storeRoutes);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts "store\.test"`
Expected: PASS (5 tests)

- [ ] **Step 6: Typecheck + commit** (if approved)

```bash
pnpm -r typecheck
git add apps/api/src/routes/store.ts apps/api/src/routes/index.ts apps/api/test/integration/store.test.ts
git commit -s -m "feat(store): domain router — gate, catalog, emoji, balance/transactions/inventory, item read"
```

---

### Task 7: Purchase endpoint

**Files:**
- Modify: `apps/api/src/routes/store.ts` (add handler ABOVE `.get("/items/:id", …)`)
- Create: `apps/api/test/integration/store-economy.test.ts` (purchase block; Tasks 8–9 extend it)

**Interfaces:**
- Consumes: `purchase_store_item` SQL fn (Task 3), `purchaseItemSchema` (Task 1).
- Produces: `POST /store/items/:id/purchase` → 200 `{ ok: true, balance }` | 402-class errors as 400/404/409 (`store/insufficient-balance` 400, `store/not-available` 404, `store/sold-out` 409, `store/already-owned` 409, `store/duplicate-request` 409).

- [ ] **Step 1: Write the failing test** — `apps/api/test/integration/store-economy.test.ts`:

```ts
// Purchase/equip/stipend/gift economy paths. RED until the handlers exist.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { api, createProject, deleteProject, createUser, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { projects, storeItems, coinTransactions, coinBalances } from "../../src/db/schema/index.js";
import { invalidateStoreConfig } from "../../src/lib/store-config.js";

const grant = (projectId: string, profileId: string, amount: number, key: string) =>
  getDb().insert(coinTransactions).values({ projectId, profileId, amount, kind: "admin_grant", idempotencyKey: key });

describe("store economy (integration)", () => {
  let projectId: string; let B: string;
  let buyer: { id: string; token: string }; let friend: { id: string; token: string };
  let haloId: string; let rareId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    await getDb().update(projects).set({ storeConfig: { enabled: true } }).where(eq(projects.id, projectId));
    invalidateStoreConfig(projectId);
    buyer = await createUser(projectId);
    friend = await createUser(projectId);
    const rows = await getDb().insert(storeItems).values([
      { projectId, type: "avatar_decoration", name: "Halo", priceCoins: 25, status: "published" },
      { projectId, type: "badge", name: "Rare", priceCoins: 10, status: "published", maxSupply: 1 },
    ]).returning();
    haloId = rows[0]!.id; rareId = rows[1]!.id;
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("insufficient balance fails closed", async () => {
    const res = await api("POST", `${B}/store/items/${haloId}/purchase`, {
      token: buyer.token, body: { idempotencyKey: "buy-halo-1" },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("store/insufficient-balance");
  });

  it("happy path debits, grants inventory, and replay is a no-double-spend 409", async () => {
    await grant(projectId, buyer.id, 100, "seed-buyer");
    const res = await api("POST", `${B}/store/items/${haloId}/purchase`, {
      token: buyer.token, body: { idempotencyKey: "buy-halo-1" },
    });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(75);
    const replay = await api("POST", `${B}/store/items/${haloId}/purchase`, {
      token: buyer.token, body: { idempotencyKey: "buy-halo-1" },
    });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("store/duplicate-request");
    const [bal] = await getDb().select().from(coinBalances)
      .where(eq(coinBalances.profileId, buyer.id));
    expect(bal!.balance).toBe(75); // exactly one debit
    const again = await api("POST", `${B}/store/items/${haloId}/purchase`, {
      token: buyer.token, body: { idempotencyKey: "buy-halo-2" },
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("store/already-owned");
  });

  it("supply cap: second buyer of a max_supply=1 item gets sold-out", async () => {
    await grant(projectId, friend.id, 100, "seed-friend");
    expect((await api("POST", `${B}/store/items/${rareId}/purchase`, {
      token: buyer.token, body: { idempotencyKey: "buy-rare-b" },
    })).status).toBe(200);
    const res = await api("POST", `${B}/store/items/${rareId}/purchase`, {
      token: friend.token, body: { idempotencyKey: "buy-rare-f" },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("store/sold-out");
  });

  it("draft/expired items purchase as not-available 404", async () => {
    const [draft] = await getDb().insert(storeItems).values(
      { projectId, type: "badge", name: "Unpublished", priceCoins: 1, status: "draft" },
    ).returning();
    const res = await api("POST", `${B}/store/items/${draft!.id}/purchase`, {
      token: buyer.token, body: { idempotencyKey: "buy-draft" },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("store/not-available");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts store-economy`
Expected: FAIL — 404 (no purchase route)

- [ ] **Step 3: Implement** — add to `routes/store.ts`, ABOVE `.get("/items/:id", …)`:

```ts
  .post("/items/:id/purchase", requireAuth, async (c) => {
    const { idempotencyKey } = parseBody(purchaseItemSchema, await c.req.json().catch(() => ({})), "store");
    const uid = c.var.auth!.userId;
    const id = c.req.param("id");
    const res = (await getDb().execute(sql`
      select purchase_store_item(${c.var.projectId}::uuid, ${uid}::uuid, ${id}::uuid, ${idempotencyKey}) as status
    `)) as unknown as { status: string }[];
    const status = res[0]?.status ?? "not_available";
    if (status !== "ok") {
      logger.debug({ status, itemId: id }, "store purchase rejected");
      switch (status) {
        case "insufficient_balance": throw Errors.badRequest("store/insufficient-balance", "Not enough coins");
        case "sold_out": throw Errors.conflict("store/sold-out", "Item is sold out");
        case "already_owned": throw Errors.conflict("store/already-owned", "Already owned");
        case "duplicate": throw Errors.conflict("store/duplicate-request", "Duplicate purchase request");
        default: throw Errors.notFound("store/not-available", "Item not available");
      }
    }
    const [bal] = await getDb().select({ balance: coinBalances.balance }).from(coinBalances)
      .where(and(eq(coinBalances.projectId, c.var.projectId), eq(coinBalances.profileId, uid))).limit(1);
    return c.json({ ok: true, balance: bal?.balance ?? 0 });
  })
```

- [ ] **Step 4: Run the purchase tests**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts store-economy`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck + commit** (if approved)

```bash
pnpm -r typecheck
git add apps/api/src/routes/store.ts apps/api/test/integration/store-economy.test.ts
git commit -s -m "feat(store): atomic purchase endpoint over purchase_store_item"
```

---

### Task 8: Equip endpoint

**Files:**
- Modify: `apps/api/src/routes/store.ts` (add `POST /me/equip` beside the other `/me/*` handlers, above `/items/:id`)
- Modify: `apps/api/test/integration/store-economy.test.ts` (append the equip block)

**Interfaces:**
- Consumes: `equipSchema`, `SLOT_FOR_TYPE` (Task 1); `storeEquipped`, `storeInventory`, `storeItems` (Task 2).
- Produces: `POST /store/me/equip` → 200 `{ ok: true }`. Errors: `store/not-owned` 403, `store/wrong-slot` 400, `store/item-not-found` 404.

- [ ] **Step 1: Append the failing tests** to `store-economy.test.ts`:

```ts
describe("equip", () => {
  it("equips an owned, slot-compatible item; rejects non-owned and wrong-slot", async () => {
    // buyer owns Halo (avatar_decoration) from the purchase block
    const [{ id: haloId2 }] = await getDb().select({ id: storeItems.id }).from(storeItems)
      .where(eq(storeItems.name, "Halo"));
    const ok = await api("POST", `${B}/store/me/equip`, {
      token: buyer.token, body: { slot: "avatar_decoration", itemId: haloId2 },
    });
    expect(ok.status).toBe(200);
    const notOwned = await api("POST", `${B}/store/me/equip`, {
      token: friend.token, body: { slot: "avatar_decoration", itemId: haloId2 },
    });
    expect(notOwned.status).toBe(403);
    expect(notOwned.body.code).toBe("store/not-owned");
    const wrongSlot = await api("POST", `${B}/store/me/equip`, {
      token: buyer.token, body: { slot: "banner", itemId: haloId2 },
    });
    expect(wrongSlot.status).toBe(400);
    expect(wrongSlot.body.code).toBe("store/wrong-slot");
  });
  it("itemId null unequips", async () => {
    const res = await api("POST", `${B}/store/me/equip`, {
      token: buyer.token, body: { slot: "avatar_decoration", itemId: null },
    });
    expect(res.status).toBe(200);
    const rows = await getDb().select().from(storeEquipped)
      .where(eq(storeEquipped.profileId, buyer.id));
    expect(rows.length).toBe(0);
  });
});
```
Add `storeEquipped` to the test file's schema imports.

- [ ] **Step 2: Run to verify it fails** — same vitest command as Task 7. Expected: FAIL (404).

- [ ] **Step 3: Implement** — add to `routes/store.ts` after `.get("/me/inventory", …)`:

```ts
  .post("/me/equip", requireAuth, async (c) => {
    const body = parseBody(equipSchema, await c.req.json().catch(() => ({})), "store");
    const uid = c.var.auth!.userId;
    const pid = c.var.projectId;
    const spaceId = body.slot === "flair" ? (body.spaceId ?? null) : null;
    const wanted = body.slot === "badges" ? (body.badgeItemIds ?? []) : body.itemId ? [body.itemId] : [];

    if (wanted.length > 0) {
      // Server-side ownership + slot-compatibility — never trust the client's claim.
      const owned = await getDb().select({ inv: storeInventory, item: storeItems }).from(storeInventory)
        .innerJoin(storeItems, eq(storeInventory.itemId, storeItems.id))
        .where(and(eq(storeInventory.projectId, pid), eq(storeInventory.profileId, uid),
                   inArray(storeInventory.itemId, wanted)));
      if (owned.length !== new Set(wanted).size) throw Errors.forbidden("store/not-owned", "Item not owned");
      for (const { item } of owned) {
        if (SLOT_FOR_TYPE[item.type] !== body.slot) throw Errors.badRequest("store/wrong-slot", "Item does not fit that slot", "slot");
        if (body.slot === "flair" && item.spaceId !== spaceId) throw Errors.badRequest("store/wrong-slot", "Flair belongs to another space", "spaceId");
      }
    }

    await getDb().transaction(async (tx) => {
      // delete-then-insert keeps the NULLS NOT DISTINCT unique simple (no cosmetic value at risk)
      await tx.delete(storeEquipped).where(and(
        eq(storeEquipped.projectId, pid), eq(storeEquipped.profileId, uid), eq(storeEquipped.slot, body.slot),
        spaceId ? eq(storeEquipped.spaceId, spaceId) : isNull(storeEquipped.spaceId),
      ));
      if (wanted.length > 0) {
        await tx.insert(storeEquipped).values({
          projectId: pid, profileId: uid, slot: body.slot, spaceId,
          itemId: body.slot === "badges" ? null : body.itemId,
          itemIds: body.slot === "badges" ? body.badgeItemIds : null,
        });
      }
    });
    return c.json({ ok: true });
  })
```

- [ ] **Step 4: Run tests** — Expected: PASS (equip block + all prior blocks).

- [ ] **Step 5: Typecheck + commit** (if approved)

```bash
pnpm -r typecheck
git add apps/api/src/routes/store.ts apps/api/test/integration/store-economy.test.ts
git commit -s -m "feat(store): equip endpoint with server-side ownership + slot checks"
```

---

### Task 9: Stipend claim + gifts (+ gift-received notification)

**Files:**
- Modify: `apps/api/src/routes/store.ts` (add `POST /stipend/claim`, `POST /gift` — both static, above `/items/:id`)
- Modify: `apps/api/test/integration/store-economy.test.ts` (append blocks)

**Interfaces:**
- Consumes: `store_claim_stipend`, `store_gift_coins`, `store_gift_item` SQL fns (Task 3); `giftSchema` (Task 1); `appNotifications` (schema); `assertProfilesInProject` idiom (mirror events.ts — inline here).
- Produces: `POST /store/stipend/claim` → 200 `{ ok, amount }` | 409 `store/stipend-cooldown` | 404 `store/stipend-disabled`; `POST /store/gift` → 200 `{ ok: true }` | 400 `store/insufficient-balance` | 400 `store/invalid-gift` | 403 `store/not-owned`-equivalent (`not_owned` maps to 403) | 409 `store/duplicate-request` | 409 `store/already-owned` | 404 `store/gifting-disabled`. Notification row `type: "gift-received"`.

- [ ] **Step 1: Append the failing tests** to `store-economy.test.ts`:

```ts
describe("stipend + gifts", () => {
  it("stipend claims once, then cooldown 409", async () => {
    const res = await api("POST", `${B}/store/stipend/claim`, { token: friend.token, body: {} });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(10); // STORE_CONFIG_DEFAULTS.stipend.amount
    const again = await api("POST", `${B}/store/stipend/claim`, { token: friend.token, body: {} });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("store/stipend-cooldown");
  });

  it("coin gift moves value, writes both ledger sides, and notifies (no balance leak)", async () => {
    const res = await api("POST", `${B}/store/gift`, {
      token: buyer.token, body: { toUserId: friend.id, amount: 5, idempotencyKey: "gift-1", message: "for you 💜" },
    });
    expect(res.status).toBe(200);
    const replay = await api("POST", `${B}/store/gift`, {
      token: buyer.token, body: { toUserId: friend.id, amount: 5, idempotencyKey: "gift-1" },
    });
    expect(replay.status).toBe(409);
    const notifs = await getDb().select().from(appNotifications)
      .where(eq(appNotifications.userId, friend.id));
    const gift = notifs.find((n) => n.type === "gift-received");
    expect(gift).toBeTruthy();
    expect(JSON.stringify(gift!.metadata)).not.toContain("balance");
  });

  it("self-gift and cross-project recipients are rejected", async () => {
    expect((await api("POST", `${B}/store/gift`, {
      token: buyer.token, body: { toUserId: buyer.id, amount: 5, idempotencyKey: "gift-self" },
    })).status).toBe(400);
    const otherProject = await createProject();
    const stranger = await createUser(otherProject);
    const res = await api("POST", `${B}/store/gift`, {
      token: buyer.token, body: { toUserId: stranger.id, amount: 5, idempotencyKey: "gift-x" },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("store/invalid-gift");
    await deleteProject(otherProject);
  });

  it("over-max gifts are rejected by config", async () => {
    const res = await api("POST", `${B}/store/gift`, {
      token: buyer.token, body: { toUserId: friend.id, amount: 501, idempotencyKey: "gift-big" }, // default maxPerGift 500
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("store/gift-too-large");
  });
});
```
Add `appNotifications` to the test file's schema imports.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL (404s).

- [ ] **Step 3: Implement** — add to `routes/store.ts` above `/items/:id` (needs `appNotifications` added to its schema import):

```ts
  .post("/stipend/claim", requireAuth, async (c) => {
    const cfg = await getStoreConfig(c.var.projectId);
    if (!cfg.stipend.enabled || cfg.stipend.amount <= 0) {
      throw Errors.notFound("store/stipend-disabled", "Stipend is not enabled");
    }
    const res = (await getDb().execute(sql`
      select store_claim_stipend(${c.var.projectId}::uuid, ${c.var.auth!.userId}::uuid, ${cfg.stipend.amount}) as status
    `)) as unknown as { status: string }[];
    if (res[0]?.status === "cooldown") throw Errors.conflict("store/stipend-cooldown", "Stipend already claimed today");
    if (res[0]?.status !== "ok") throw Errors.notFound("store/stipend-disabled", "Stipend is not enabled");
    return c.json({ ok: true, amount: cfg.stipend.amount });
  })

  .post("/gift", requireAuth, async (c) => {
    const cfg = await getStoreConfig(c.var.projectId);
    if (!cfg.gifting.enabled) throw Errors.notFound("store/gifting-disabled", "Gifting is not enabled");
    const body = parseBody(giftSchema, await c.req.json().catch(() => ({})), "store");
    if (body.amount != null && body.amount > cfg.gifting.maxPerGift) {
      throw Errors.badRequest("store/gift-too-large", "Gift exceeds the per-gift maximum", "amount");
    }
    const uid = c.var.auth!.userId;
    const pid = c.var.projectId;
    // Recipient must be a real profile IN THIS PROJECT (cross-tenant guard, the events.ts lesson).
    const [recipient] = await getDb().select({ id: profiles.id }).from(profiles)
      .where(and(eq(profiles.projectId, pid), eq(profiles.id, body.toUserId))).limit(1);
    if (!recipient) throw Errors.badRequest("store/invalid-gift", "No such user in this project", "toUserId");

    const fn = body.amount != null
      ? sql`select store_gift_coins(${pid}::uuid, ${uid}::uuid, ${body.toUserId}::uuid, ${body.amount}, ${body.idempotencyKey}) as status`
      : sql`select store_gift_item(${pid}::uuid, ${uid}::uuid, ${body.toUserId}::uuid, ${body.itemId}::uuid, ${body.idempotencyKey}) as status`;
    const res = (await getDb().execute(fn)) as unknown as { status: string }[];
    const status = res[0]?.status;
    if (status !== "ok") {
      logger.debug({ status }, "store gift rejected");
      switch (status) {
        case "duplicate": throw Errors.conflict("store/duplicate-request", "Duplicate gift request");
        case "insufficient_balance": throw Errors.badRequest("store/insufficient-balance", "Not enough coins");
        case "not_owned": throw Errors.forbidden("store/not-owned", "Item not owned");
        case "already_owned": throw Errors.conflict("store/already-owned", "Recipient already owns this item");
        default: throw Errors.badRequest("store/invalid-gift", "Invalid gift");
      }
    }
    // Notification: sender's public identity + the gift itself — NEVER balance data.
    try {
      await getDb().insert(appNotifications).values({
        projectId: pid, userId: body.toUserId, type: "gift-received", action: "open-store",
        metadata: {
          fromUserId: uid,
          ...(body.amount != null ? { amount: body.amount } : { itemId: body.itemId }),
          ...(body.message ? { message: body.message } : {}),
        },
      });
    } catch {
      logger.error("gift-received notification insert failed");
    }
    return c.json({ ok: true });
  })
```

- [ ] **Step 4: Run tests** — Expected: PASS (all economy blocks).

- [ ] **Step 5: Typecheck + commit** (if approved)

```bash
pnpm -r typecheck
git add apps/api/src/routes/store.ts apps/api/test/integration/store-economy.test.ts
git commit -s -m "feat(store): stipend claim + coin/item gifts with gift-received notification"
```

---

### Task 10: Admin surface — items CRUD, grants, project ledger

**Files:**
- Modify: `apps/api/src/routes/store.ts`
- Modify: `apps/api/test/integration/store-admin.test.ts` (append blocks)

**Interfaces:**
- Consumes: `createStoreItemSchema`, `updateStoreItemSchema`, `grantCoinsSchema` (Task 1); `requireProjectAdmin(c)` (`../lib/project-roles.js`).
- Produces: `POST /store/items` (201, StoreItem), `PATCH /store/items/:id`, `DELETE /store/items/:id` (archives, never hard-deletes — inventory rows reference it), `POST /store/grants` → `{ ok: true }`, `GET /store/admin/ledger` (paginated, `?userId=`/`?kind=` filters). All project-admin-gated.

- [ ] **Step 1: Append the failing tests** to `store-admin.test.ts`:

```ts
describe("store admin surface", () => {
  it("item authoring is project-admin-gated", async () => {
    const body = { type: "badge", name: "Founder", priceCoins: 100, status: "published" };
    expect((await api("POST", `${B}/store/items`, { token: member.token, body })).status).toBe(403);
    const res = await api("POST", `${B}/store/items`, { token: admin.token, body });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("badge");
    const patched = await api("PATCH", `${B}/store/items/${res.body.id}`, {
      token: admin.token, body: { priceCoins: 50 },
    });
    expect(patched.body.priceCoins).toBe(50);
    const del = await api("DELETE", `${B}/store/items/${res.body.id}`, { token: admin.token });
    expect(del.status).toBe(200);
    expect(del.body.status).toBe("archived"); // archive, not hard delete
  });

  it("grants credit coins with the granting admin recorded as counterparty", async () => {
    const res = await api("POST", `${B}/store/grants`, {
      token: admin.token, body: { toUserId: member.id, amount: 30, note: "welcome!" },
    });
    expect(res.status).toBe(200);
    const bal = await api("GET", `${B}/store/me/balance`, { token: member.token });
    expect(bal.body.balance).toBe(30);
    const rows = await getDb().select().from(coinTransactions)
      .where(eq(coinTransactions.profileId, member.id));
    expect(rows[0]!.kind).toBe("admin_grant");
    expect(rows[0]!.counterpartyProfileId).toBe(admin.id);
  });

  it("admin ledger is project-wide, filterable, and member-403", async () => {
    expect((await api("GET", `${B}/store/admin/ledger`, { token: member.token })).status).toBe(403);
    const res = await api("GET", `${B}/store/admin/ledger?kind=admin_grant`, { token: admin.token });
    expect(res.status).toBe(200);
    expect(res.body.data.every((t: any) => t.kind === "admin_grant")).toBe(true);
  });
});
```
Add to the test file's imports: `coinTransactions` from the schema barrel and `getDb`; also `enableStore(projectId)` must run in `beforeAll` (add `await getDb().update(projects).set({ storeConfig: { enabled: true } })…; invalidateStoreConfig(projectId)` there, mirroring `store.test.ts`, since the whole router is gated).

- [ ] **Step 2: Run to verify it fails** — `… vitest run -c vitest.integration.config.ts store-admin`. Expected: FAIL.

- [ ] **Step 3: Implement** — add to `routes/store.ts` (grants + admin ledger are static → above `/items/:id`; the items CRUD paths don't collide):

```ts
  .post("/items", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const body = parseBody(createStoreItemSchema, await c.req.json().catch(() => ({})), "store");
    if (body.spaceId) await assertCanReadSpace(c, body.spaceId); // flair space must exist + be visible to the admin
    const [row] = await getDb().insert(storeItems).values({
      projectId: c.var.projectId,
      type: body.type,
      name: body.name,
      description: body.description ?? null,
      priceCoins: body.priceCoins,
      renderPayload: body.renderPayload,
      spaceId: body.spaceId ?? null,
      availableFrom: body.availableFrom ? new Date(body.availableFrom) : null,
      availableUntil: body.availableUntil ? new Date(body.availableUntil) : null,
      maxSupply: body.maxSupply ?? null,
      status: body.status,
    }).returning();
    return c.json(shapeStoreItem(row!), 201);
  })

  .post("/grants", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const body = parseBody(grantCoinsSchema, await c.req.json().catch(() => ({})), "store");
    const [recipient] = await getDb().select({ id: profiles.id }).from(profiles)
      .where(and(eq(profiles.projectId, c.var.projectId), eq(profiles.id, body.toUserId))).limit(1);
    if (!recipient) throw Errors.badRequest("store/invalid-grant", "No such user in this project", "toUserId");
    await getDb().insert(coinTransactions).values({
      projectId: c.var.projectId,
      profileId: body.toUserId,
      amount: body.amount,
      kind: "admin_grant",
      counterpartyProfileId: c.var.auth!.userId, // audit: which admin granted
      idempotencyKey: `grant:${crypto.randomUUID()}`,
    });
    return c.json({ ok: true });
  })

  .get("/admin/ledger", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const { page, limit, offset } = readPagination(c);
    const conds = [eq(coinTransactions.projectId, c.var.projectId)];
    const userId = c.req.query("userId"); const kind = c.req.query("kind");
    if (userId) conds.push(eq(coinTransactions.profileId, userId));
    if (kind) {
      if (!(COIN_TXN_KINDS as readonly string[]).includes(kind)) throw Errors.badRequest("store/invalid-kind", "Unknown kind", "kind");
      conds.push(eq(coinTransactions.kind, kind as (typeof COIN_TXN_KINDS)[number]));
    }
    const rows = await getDb().select().from(coinTransactions).where(and(...conds))
      .orderBy(desc(coinTransactions.createdAt)).limit(limit).offset(offset);
    const [{ total } = { total: 0 }] = await getDb().select({ total: count() }).from(coinTransactions).where(and(...conds));
    return c.json(paginate(rows.map((r) => ({ ...shapeCoinTransaction(r), profileId: r.profileId })), total, page, limit));
  })

  .patch("/items/:id", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const body = parseBody(updateStoreItemSchema, await c.req.json().catch(() => ({})), "store");
    const [existing] = await getDb().select().from(storeItems)
      .where(and(eq(storeItems.projectId, c.var.projectId), eq(storeItems.id, c.req.param("id")))).limit(1);
    if (!existing) throw Errors.notFound("store/item-not-found", "Item not found");
    const [row] = await getDb().update(storeItems).set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.priceCoins !== undefined ? { priceCoins: body.priceCoins } : {}),
      ...(body.renderPayload !== undefined ? { renderPayload: body.renderPayload } : {}),
      ...(body.availableFrom !== undefined ? { availableFrom: body.availableFrom ? new Date(body.availableFrom) : null } : {}),
      ...(body.availableUntil !== undefined ? { availableUntil: body.availableUntil ? new Date(body.availableUntil) : null } : {}),
      ...(body.maxSupply !== undefined ? { maxSupply: body.maxSupply } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      updatedAt: new Date(),
    }).where(eq(storeItems.id, existing.id)).returning();
    return c.json(shapeStoreItem(row!));
  })

  .delete("/items/:id", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    // Archive, never hard-delete: inventory/ledger rows reference the item (owned copies keep rendering).
    const [row] = await getDb().update(storeItems).set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(storeItems.projectId, c.var.projectId), eq(storeItems.id, c.req.param("id")))).returning();
    if (!row) throw Errors.notFound("store/item-not-found", "Item not found");
    return c.json(shapeStoreItem(row));
  })
```
Add `COIN_TXN_KINDS` to the contract import in `routes/store.ts`. Note the admin ledger view adds `profileId` per row (project-wide view needs to say whose transaction it is); the self view (`/me/transactions`) deliberately doesn't.

- [ ] **Step 4: Run the admin tests** — Expected: PASS (settings + admin blocks).

- [ ] **Step 5: Typecheck + commit** (if approved)

```bash
pnpm -r typecheck
git add apps/api/src/routes/store.ts apps/api/test/integration/store-admin.test.ts
git commit -s -m "feat(store): admin items CRUD (archive-only delete), coin grants, project ledger"
```

---

### Task 11: Earning hooks + moderation claw-back

**Files:**
- Create: `apps/api/src/lib/store-earn.ts`
- Create: `apps/api/src/lib/store-earn.test.ts`
- Modify: `apps/api/src/routes/entities.ts`, `apps/api/src/routes/comments.ts`, `apps/api/src/routes/events.ts`, `apps/api/src/lib/client-moderation.ts` (+ every other write site that sets `moderationStatus='removed'` — locate ALL with `grep -rn "moderationStatus" apps/api/src/routes apps/api/src/lib | grep -i removed`; expected: the admin moderation action in `routes/admin.ts` and the steward escalation path)
- Modify: `apps/api/test/integration/store-economy.test.ts` (earn/claw-back block)

**Interfaces:**
- Consumes: `store_credit_earn` SQL fn (Task 3), `getStoreConfig` (Task 4).
- Produces: `earnAmount(cfg, kind): number` (pure); `creditEarn(args): Promise<void>` (awaitable core, for tests); `creditEarnAsync(args): void` + `clawbackEarnAsync(args): void` (fire-and-forget wrappers for handlers — the chat-push awaitable-core pattern). `EarnKind = "entityCreate" | "commentCreate" | "reactionReceived" | "eventAttendance"`.

- [ ] **Step 1: Write the failing unit test** — `apps/api/src/lib/store-earn.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { earnAmount } from "./store-earn.js";
import { STORE_CONFIG_DEFAULTS } from "@agora-server/contract";

describe("earnAmount", () => {
  it("returns 0 whenever the store is disabled", () => {
    expect(earnAmount({ ...STORE_CONFIG_DEFAULTS, enabled: false }, "entityCreate")).toBe(0);
  });
  it("returns the configured per-kind rate when enabled", () => {
    const cfg = { ...STORE_CONFIG_DEFAULTS, enabled: true, earn: { ...STORE_CONFIG_DEFAULTS.earn, commentCreate: 3 } };
    expect(earnAmount(cfg, "entityCreate")).toBe(5);
    expect(earnAmount(cfg, "commentCreate")).toBe(3);
    expect(earnAmount(cfg, "reactionReceived")).toBe(1);
    expect(earnAmount(cfg, "eventAttendance")).toBe(10);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @agora/api exec vitest run store-earn`. Expected: FAIL.

- [ ] **Step 3: Implement** — `apps/api/src/lib/store-earn.ts`:

```ts
// Participation → coin credits (spec §3.5). Fire-and-forget from write paths: failures log and
// never fail the parent write. Cap/idempotency enforcement is IN SQL (store_credit_earn).
import { sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { getStoreConfig } from "./store-config.js";
import type { ResolvedStoreConfig } from "@agora-server/contract";
import { logger } from "./logger.js";

export type EarnKind = "entityCreate" | "commentCreate" | "reactionReceived" | "eventAttendance";

/** Pure rate lookup: 0 when the store is disabled. */
export function earnAmount(cfg: ResolvedStoreConfig, kind: EarnKind): number {
  return cfg.enabled ? cfg.earn[kind] : 0;
}

/** Awaitable core (tests use this); handlers use the void wrapper below. */
export async function creditEarn(args: { projectId: string; profileId: string; kind: EarnKind; refId: string }): Promise<void> {
  const cfg = await getStoreConfig(args.projectId);
  const amount = earnAmount(cfg, args.kind);
  if (amount <= 0) return;
  const key = `earn:${args.kind}:${args.refId}`;
  await getDb().execute(sql`
    select store_credit_earn(${args.projectId}::uuid, ${args.profileId}::uuid, ${amount}, ${cfg.earn.dailyCap}, ${key})
  `);
}

export function creditEarnAsync(args: { projectId: string; profileId: string; kind: EarnKind; refId: string }): void {
  void creditEarn(args).catch((err) => {
    logger.error("store earn credit failed");
    logger.debug({ err }, "store earn credit failed");
  });
}

/** Compensating entry reversing a removed content's earn. Idempotent via 'clawback:'-prefixed key. */
export async function clawbackEarn(args: { projectId: string; kind: "entityCreate" | "commentCreate"; refId: string }): Promise<void> {
  const key = `earn:${args.kind}:${args.refId}`;
  await getDb().execute(sql`
    insert into coin_transactions (project_id, profile_id, amount, kind, idempotency_key)
    select project_id, profile_id, -amount, 'refund', 'clawback:' || idempotency_key
      from coin_transactions
     where project_id = ${args.projectId}::uuid and idempotency_key = ${key} and amount > 0
    on conflict on constraint coin_txns_idem do nothing
  `);
}

export function clawbackEarnAsync(args: { projectId: string; kind: "entityCreate" | "commentCreate"; refId: string }): void {
  void clawbackEarn(args).catch((err) => {
    logger.error("store earn clawback failed");
    logger.debug({ err }, "store earn clawback failed");
  });
}
```

- [ ] **Step 4: Wire the hooks** (one line each; add the import `import { creditEarnAsync } from "../lib/store-earn.js";` to each router):

In `routes/entities.ts`, immediately after EACH of the two `insert(entities)` create sites (near lines 166 and 461) once the created `row` is in hand:

```ts
    if (row.userId) creditEarnAsync({ projectId: c.var.projectId, profileId: row.userId, kind: "entityCreate", refId: row.id });
```

In `routes/comments.ts`, after the `insert(comments)` create site (near line 95):

```ts
    if (row.userId) creditEarnAsync({ projectId: c.var.projectId, profileId: row.userId, kind: "commentCreate", refId: row.id });
```

In `routes/entities.ts`, in the reaction/vote handlers right after the `refresh_entity_score` call (near line 500): credit the CONTENT AUTHOR, never the reactor; the key includes the reactor so un-react/re-react can't double-credit:

```ts
    if (entity.userId && entity.userId !== userId) {
      creditEarnAsync({ projectId: c.var.projectId, profileId: entity.userId, kind: "reactionReceived", refId: `${id}:${userId}` });
    }
```
(`entity` = the row the handler already loaded for the existence check; do the same in `routes/comments.ts`'s reaction handler — find it with `grep -n toggle_reaction apps/api/src/routes/comments.ts` — crediting the comment author with `refId: `${commentId}:${userId}``.)

In `routes/events.ts`, in the RSVP handler where a `going` RSVP is recorded:

```ts
    if (body.status === "going") {
      creditEarnAsync({ projectId: c.var.projectId, profileId: uid, kind: "eventAttendance", refId: eventId });
    }
```

In `lib/client-moderation.ts`, after the `moderationStatus: "removed"` write, and in EACH other removal-write site found by the grep in **Files** above (`import { clawbackEarnAsync } from "./store-earn.js";` — path-adjust per file):

```ts
  if (args.status === "removed") {
    clawbackEarnAsync({
      projectId: args.projectId,
      kind: args.targetType === "entity" ? "entityCreate" : "commentCreate",
      refId: args.targetId,
    });
  }
```
(Adapt the variable names to each site's locals — the semantic contract is: project id, entity-vs-comment, content id.)

- [ ] **Step 5: Append the integration block** to `store-economy.test.ts`:

```ts
// (hoist this import to the top of the file with the others)
import { creditEarn, clawbackEarn } from "../../src/lib/store-earn.js";

describe("earning + claw-back", () => {
  it("daily cap limits earn credits; duplicate keys no-op", async () => {
    const worker = await createUser(projectId);
    await getDb().update(projects).set({
      storeConfig: { enabled: true, earn: { entityCreate: 30, dailyCap: 50 } },
    }).where(eq(projects.id, projectId));
    invalidateStoreConfig(projectId);
    await creditEarn({ projectId, profileId: worker.id, kind: "entityCreate", refId: "e1" });
    await creditEarn({ projectId, profileId: worker.id, kind: "entityCreate", refId: "e1" }); // dup
    await creditEarn({ projectId, profileId: worker.id, kind: "entityCreate", refId: "e2" }); // capped to 20
    await creditEarn({ projectId, profileId: worker.id, kind: "entityCreate", refId: "e3" }); // capped to 0
    const bal = await api("GET", `${B}/store/me/balance`, { token: worker.token });
    expect(bal.body.balance).toBe(50);
  });

  it("claw-back reverses exactly the earned amount, once", async () => {
    const author = await createUser(projectId);
    await creditEarn({ projectId, profileId: author.id, kind: "entityCreate", refId: "gone-1" });
    await clawbackEarn({ projectId, kind: "entityCreate", refId: "gone-1" });
    await clawbackEarn({ projectId, kind: "entityCreate", refId: "gone-1" }); // idempotent
    const bal = await api("GET", `${B}/store/me/balance`, { token: author.token });
    expect(bal.body.balance).toBe(0);
  });
});
```
(Reset `storeConfig` back to `{ enabled: true }` + `invalidateStoreConfig(projectId)` at the end of the cap test if later blocks depend on default rates.)

- [ ] **Step 6: Run everything**

Run: `pnpm --filter @agora/api exec vitest run store-earn` then `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts store-economy`
Expected: PASS both

- [ ] **Step 7: Typecheck + commit** (if approved)

```bash
pnpm -r typecheck
git add apps/api/src/lib/store-earn.ts apps/api/src/lib/store-earn.test.ts apps/api/src/routes/entities.ts apps/api/src/routes/comments.ts apps/api/src/routes/events.ts apps/api/src/lib/client-moderation.ts apps/api/test/integration/store-economy.test.ts
git commit -s -m "feat(store): participation earning hooks + moderation claw-back (capped, idempotent)"
```
(Include any additional removal-site files the grep surfaced.)

---

### Task 12: Cosmetics on the User shape (`loadUsers` + single-user GET)

**Files:**
- Modify: `apps/api/src/lib/shape.ts` (`loadUsers`, near line 219)
- Modify: `apps/api/src/routes/users.ts` (single-user GET handlers)
- Modify: `apps/api/test/integration/store.test.ts` (cosmetics block)

**Interfaces:**
- Consumes: `attachCosmetics` (Task 5).
- Produces: every `loadUsers` surface (feeds, comments, member lists, chat) carries `user.cosmetics` when the store is enabled and the user has something equipped; single-user GETs likewise. Disabled store → field absent (`attachCosmetics` no-ops).

- [ ] **Step 1: Append the failing test** to `store.test.ts`:

```ts
describe("cosmetics on the User shape", () => {
  it("equipped decor surfaces on the single-user read; nothing equipped → no cosmetics", async () => {
    await getDb().insert(coinTransactions).values({
      projectId, profileId: me.id, amount: 100, kind: "admin_grant", idempotencyKey: "seed-cosmetics",
    });
    await api("POST", `${B}/store/items/${publishedId}/purchase`, {
      token: me.token, body: { idempotencyKey: "buy-for-cosmetics" },
    });
    await api("POST", `${B}/store/me/equip`, {
      token: me.token, body: { slot: "avatar_decoration", itemId: publishedId },
    });
    const res = await api("GET", `${B}/users/${me.id}`, { token: me.token });
    expect(res.status).toBe(200);
    expect(res.body.cosmetics.avatarDecoration.id).toBe(publishedId);
    const other = await createUser(projectId);
    const bare = await api("GET", `${B}/users/${other.id}`, { token: me.token });
    expect(bare.body.cosmetics ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL (`cosmetics` undefined).

- [ ] **Step 3: Wire the batcher** — in `apps/api/src/lib/shape.ts`, add the import and make `loadUsers` finish with the attach (signature unchanged — zero churn at its ~30 call sites):

```ts
import { attachCosmetics } from "./store-shape.js";
```
```ts
  for (const r of rows) {
    const u = shapeUser(r);
    if (u) map.set(r.id, u);
  }
  await attachCosmetics(projectId, map); // no-op unless store enabled (30s-cached config check)
  return map;
```
In `apps/api/src/routes/users.ts`, in each single-user GET handler (find them with `grep -n "shapeUser" apps/api/src/routes/users.ts`) where a lone user is shaped outside `loadUsers`, wrap with the batcher:

```ts
    const shaped = shapeUser(row)!;
    const m = new Map([[shaped.id, shaped]]);
    await attachCosmetics(c.var.projectId, m);
    return c.json(shaped);
```

- [ ] **Step 4: Run tests** — store.test + the full unit suite (`pnpm --filter @agora/api test`) — `loadUsers` is exercised broadly; everything must stay green.

- [ ] **Step 5: Typecheck + commit** (if approved)

```bash
pnpm -r typecheck
git add apps/api/src/lib/shape.ts apps/api/src/routes/users.ts apps/api/test/integration/store.test.ts
git commit -s -m "feat(store): cosmetics ride loadUsers + single-user reads (zero extra fetches for clients)"
```

---

### Task 13: Docs, contract manifest, changelog, security posture

**Files:**
- Modify: `docs/MANIFEST.md` (new `### Store (Agora extension)` section, after §events, mirroring its format: method+path table marked 🔶inferred, error codes, the `store/not-enabled` gate)
- Modify: `docs/MODELS.md` (StoreItem / CoinTransaction / InventoryItem / UserCosmetics / `User.cosmetics?` field-level shapes, copied from `packages/contract/src/store.ts`)
- Modify: `SECURITY.md` (new Store section: ledger trust model — append-only, serialized SQL fns, handlers never write balances; self-scoped `me/*`; no balance data in notifications/logs; archive-only item deletion)
- Modify: `CHANGELOG.md` (under `## [Unreleased]` → `### Added`)

- [ ] **Step 1: Write the docs sections** (each derived from the code shipped in Tasks 1–12 — endpoint list from `routes/store.ts` + `misc.ts`, shapes from the contract file; note the deferred `item-back-in-stock`/`stipend-available` notification kinds as reserved).

- [ ] **Step 2: CHANGELOG entry** under `## [Unreleased]`:

```markdown
### Added
- **Store (Phase 1)** — per-project opt-in digital-cosmetics marketplace (spec
  `docs/superpowers/specs/2026-07-17-store-marketplace-design.md`): admin-curated catalog
  (avatar decor, profile glam, emoji/reaction packs, badges, space flair), append-only coin
  ledger with trigger-maintained balances (migration `0066`), atomic `purchase_store_item`,
  participation earning with daily caps + moderation claw-back, daily stipend, coin/item
  gifting, equip slots surfacing as `User.cosmetics`, `GET/PATCH /settings/store`
  (settings-read-only-gated), admin grants + project ledger. Default OFF
  (`store_config.enabled`).
```

- [ ] **Step 3: Full verification sweep**

```bash
pnpm --filter @agora-server/contract build && pnpm -r typecheck && pnpm --filter @agora/api test
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api test:integration
```
Expected: all green (integration includes the three new store files + no regressions elsewhere).

- [ ] **Step 4: Propagation check** — run `pnpm check:propagation --diff root` (from `apps/api/`); no new env vars in Phase 1, so expected obligations are docs-only (MANIFEST/MODELS/CHANGELOG — satisfied above). If the checker flags more, address or consciously defer with a note.

- [ ] **Step 5: Commit** (if approved)

```bash
git add docs/MANIFEST.md docs/MODELS.md SECURITY.md CHANGELOG.md
git commit -s -m "docs(store): MANIFEST/MODELS store contract, security posture, changelog"
```

---

## Execution pre-flight (read before Task 1)

1. **Commit authorization** (standing rule): ask Jenova whether per-task commits are approved for this run.
2. **Migration number collision:** `0065` is now TAKEN (`0065_entity_internet_public`, merged to root 2026-07-18) — this plan and the parked space-scoped-stewards plan both now target `0066`; whichever executes first keeps it, the other renumbers to the next free index at its own execution time. Before Task 3, re-check `apps/api/drizzle/meta/_journal.json` regardless — if 0066 is taken by then too, renumber to the next free index and bump `when` past the new max.
3. **Worktree:** use `superpowers:using-git-worktrees`; a fresh worktree needs `pnpm install && pnpm -r build` before anything runs (memory: `worktree-needs-install-and-build`).
4. **Integration env:** needs `TEST_DATABASE_URL`; migrations auto-apply via globalSetup on first run (0066 must be in the journal first — Task 3 precedes every integration task).
5. Line-number anchors (entities.ts:166/461/500, comments.ts:95, shape.ts:219, misc.ts settings block) were read at plan time — re-grep if the file has drifted.

## Deliberately NOT in this plan (tracked, not forgotten)

- **Admin SPA Store tab** (spec §3.7) — separate plan, after the API lands.
- **Phase 2** (Stripe, coin packs, merch, fulfillment, orders — spec §4) — separate plan.
- **SDK hooks + demo tab** — separate repos (`../agora-sdk`, `../agora-demo`), separate cycles.
- `item-back-in-stock` / `stipend-available` notifications — reserved kinds documented in Task 13 only.
