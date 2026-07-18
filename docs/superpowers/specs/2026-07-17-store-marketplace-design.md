# Agora Store — Digital Marketplace Design

**Date:** 2026-07-17
**Status:** Approved design, pre-implementation
**Scope:** Per-project digital-merch store (Discord-style cosmetics) with a virtual-coin
economy (Phase 1) and a real-money rail powering coin top-ups + fulfilled physical merch
(Phase 2). One spec, two implementation phases.

---

## 1. Overview & goals

Each Agora site gets an opt-in **Store**: a catalog of digital cosmetics (avatar
decorations, profile glam, emoji/reaction packs, badges, per-space flair) priced in a
per-project virtual currency ("coins"), curated by project owners/admins. Phase 2 adds a
real-money rail (operator's own Stripe account) that powers coin top-up packs and
print-on-demand physical merch with fulfillment.

**Goals**

- A store domain the forked Agora SDK consumes 1:1, following the events/push
  "Agora extension" precedent (contract-first, standard envelopes).
- A money-grade economy from day one: append-only ledger, atomic purchases, full audit —
  so Phase 2 real money lands without schema surgery.
- Opt-in everywhere: per-project `store_config.enabled` (default **off**); Phase 2
  payments env-gated (`STRIPE_*` unset → 503), like `VAPID_*`/`NEO4J_URI`.
- Calm-by-design shop dynamics: availability windows and supply caps exist as neutral
  tools; **no** first-class rotation/countdown/FOMO machinery.

**Non-goals (v1+v2)**

- Creator marketplace (members selling items) — schema is creator-ready
  (`creator_id`, `revenue_share_bps`), feature deferred.
- Tax/VAT computation — the operator is the merchant of record; documented as their
  responsibility in SELF-HOSTING docs.
- Subscriptions ("Nitro-alike"), saved payment methods, saved address book,
  creator payouts. Open questions only.

## 2. Decisions record

| Question | Decision |
| --- | --- |
| Currency | Virtual coins first; Stripe becomes a top-up rail in Phase 2 |
| Catalog types | Avatar decor + profile glam, emoji/reaction packs, badges + space flair; physical merch |
| Sequencing | Digital + coins in Phase 1; real money + merch in Phase 2 (designed now) |
| Coin faucets | Participation earning (tunable) + admin grants / member gifting + daily claim-based stipend |
| Who sells | Admin-curated catalog; creator-ready schema for a later marketplace |
| Shop dynamics | Gentle: optional `available_from`/`available_until` + `max_supply`; no rotation/countdown UI |
| Architecture | Approach A — in-core domain router + append-only ledger (events precedent), NOT a separate process |

## 3. Phase 1 — coins + digital cosmetics

### 3.1 Data model

Five new tables in Phase 1 (plus Phase 2's `merch_variants` and `store_orders`, §4.3) in `packages/core/src/db/schema/store.ts` (single source of truth), all
carrying `project_id`, all with explicit RLS deny-all in the creating migration (the
`project_roles`/`0045` convention). New migration `when` must exceed the journal max
(drizzle watermark gotcha).

**`store_items`** — the catalog.

- `id` uuid PK, `project_id`
- `type` enum `store_item_type`: `avatar_decoration | profile_effect | name_style |
  profile_banner | emoji_pack | reaction_skin | badge | flair | merch` (merch unused
  until Phase 2)
- `name`, `description`
- `price_coins` int (≥0; merch items ignore this — merch is never coin-priced)
- `render_payload` jsonb — type-specific render contract (asset `files` refs / public
  URLs, gradient specs, emoji definitions `{ name, fileId, url }[]`, badge art, etc.)
- `space_id` uuid nullable — set only for `flair` (scoped to one space)
- `available_from` / `available_until` timestamptz nullable — availability window
- `max_supply` int nullable + `sold_count` int (trigger-maintained)
- `status` enum: `draft | published | archived`
- Creator-ready (unused v1): `creator_id` uuid nullable, `revenue_share_bps` int default 0
- `created_at` / `updated_at`

**`coin_transactions`** — append-only ledger; the integrity heart. Rows are never
updated or deleted; corrections are compensating entries.

- `id`, `project_id`, `profile_id`
- `amount` int, signed (credit +, debit −)
- `kind` enum `coin_txn_kind`: `earn_activity | stipend | admin_grant | gift_sent |
  gift_received | purchase | refund | topup` (`topup` unused until Phase 2)
- refs: `item_id` nullable, `counterparty_profile_id` nullable (gift peer / granting
  admin), Phase 2 adds `order_id` nullable
- `idempotency_key` text, unique per `(project_id, profile_id)` — client-generated keys
  can't collide across users, and retries can never double-apply
- `created_at`

**`coin_balances`** — trigger-maintained from the ledger (the `reaction_counts`
convention). PK `(project_id, profile_id)`, `balance` int, `updated_at`. Handlers
NEVER write this table; the ledger-insert trigger does.

**`store_inventory`** — owned items. `id`, `project_id`, `profile_id`, `item_id`
(unique `(profile_id, item_id)`), `acquired_via` enum `purchase | grant | gift`,
`transaction_id` ledger backref, `created_at`.

**`store_equipped`** — what's worn. Unique `(project_id, profile_id, slot, space_id)`
→ `item_id`. `slot` enum: `avatar_decoration | profile_effect | name_style | banner |
badges | flair` — the `badges` slot's row stores an ordered id list in a jsonb column;
`flair` rows carry a non-null `space_id` (null for every other slot). Server verifies
ownership + slot/type compatibility on every write.

**`merch_variants`** — Phase 2 (created then, listed here for completeness): §4.3.

### 3.2 Purchase atomicity

A hand-written SQL function **`purchase_store_item(p_project, p_buyer, p_item,
p_idempotency_key)`** (the `toggle_reaction` precedent, custom migration, idempotent
DDL): row-locks the item; checks `status='published'`, availability window,
`sold_count < max_supply`, buyer balance, not-already-owned; inserts the debit ledger
row + inventory row and bumps `sold_count` — one transaction, fail-closed on any check
with distinct error codes the handler maps to `Errors.*`
(`store/insufficient-balance`, `store/sold-out`, `store/not-available`,
`store/already-owned`, `store/duplicate-request`). Gifts of coins/items use the same
serialized-SQL-function pattern (`gift_coins`, `gift_item`) so no TOCTOU double-spend
path exists anywhere.

### 3.3 Project config

`projects.store_config` jsonb (mirrors `social_config`; resolver
`lib/store-config.ts` with the same 30s cache pattern):

```jsonc
{
  "enabled": false,              // master switch, default off
  "earn": {
    "entityCreate": 5, "commentCreate": 2, "reactionReceived": 1,
    "eventAttendance": 10, "dailyCap": 50
  },
  "stipend": { "amount": 10, "enabled": true },   // claim-based, 24h cooldown
  "gifting": { "enabled": true, "maxPerGift": 500 },
  "coinPacks": []                // Phase 2: [{ id, coins, priceCents, currency }]
}
```

Defaults + clamping live in the contract zod schema (server-side max on every amount).

### 3.4 API surface

Router `apps/api/src/routes/store.ts`, mounted at `/v7/:projectId/store/*`. An
**Agora extension** section in `docs/MANIFEST.md` + shapes in `docs/MODELS.md`; all
request/response types + zod in `packages/contract` first. Every endpoint checks
`store_config.enabled` → `404 store/not-enabled` when off. Static routes above `/:id`
(Hono capture rule). Standard `{ data, pagination }` + error envelopes.

Member-facing:

| Method + path | Notes |
| --- | --- |
| `GET /store/catalog` | published + window-open items, filtered in SQL; `?type=`; flair rows gated by `assertCanReadSpace` |
| `GET /store/emoji` | caller's usable emoji map (owned packs) for composers |
| `GET /store/me/balance` | self only |
| `GET /store/me/transactions` | self ledger, paginated |
| `GET /store/me/inventory` | self only |
| `POST /store/me/equip` | `{ slot, itemId \| null, spaceId? }`; ownership + slot-compat verified server-side |
| `POST /store/stipend/claim` | 24h cooldown checked against the ledger; no cron |
| `POST /store/gift` | coins or owned item; config-gated, positive-int zod, no self-gift, serialized SQL |
| `POST /store/items/:id/purchase` | client idempotency key → `purchase_store_item` |
| `GET /store/items/:id` | single item |

Admin:

| Method + path | Gate |
| --- | --- |
| `POST /store/items`, `PATCH /store/items/:id`, `DELETE /store/items/:id` | `requireProjectAdmin(c)` |
| `POST /store/grants` | `requireProjectAdmin(c)`; ledger row records granting admin as counterparty |
| `GET /store/admin/ledger` | `requireProjectAdmin(c)`; project-wide, paginated, filterable |
| `GET /settings/store`, `PATCH /settings/store` | in `misc.ts` beside the other settings; PATCH adds `assertSettingsWritable(c)` — the **sixth** read-only-blocked settings save |

Item art uploads reuse `POST /storage/images` (sharp → webp variants); no new upload
path. `files` rows referenced from `render_payload`.

### 3.5 Earning hooks

`lib/store-earn.ts` — fire-and-forget credits called from existing write paths
(entity create, comment create, reaction received, event attendance), rate + daily cap
from `store_config`, cap enforced in SQL against the current day's ledger rows.
Rules: no earn on self-reactions; suspended users earn nothing; content removed by
moderation triggers a compensating claw-back entry from the moderation path. Failures
log per Log-with-intent (message-only `error`, `{ err }` on `debug`) and never fail
the parent write.

### 3.6 Render contract (SDK surface)

`shapeUser` gains optional **`cosmetics`**: resolved equipped items —
`avatarDecoration`, `profileEffect`, `nameStyle`, `banner`, `badges[]`, and `flair`
(populated when a space is in context) — each carrying its `render_payload` so every
surface that already returns users (feeds, comments, member lists, chat) renders glam
with zero extra fetches. Batched via a `loadCosmetics` batcher beside `loadUsers`
(no N+1). Emoji packs unlock `:pack.name:` tokens; composers hydrate from
`GET /store/emoji`. Contract types: `StoreItem`, `CoinTransaction`, `InventoryItem`,
`UserCosmetics`, `StoreConfig` in `@agora-server/contract`.

Notifications ride the existing `app_notifications` fan-out (+ push allowlist
candidates): `gift-received`, `item-back-in-stock` (opt-in), `stipend-available`
(opt-in). Gift notifications carry the sender's public identity only — never balance
data.

### 3.7 Admin SPA

New **Store** tab (role-gated project-admin): catalog manager (draft/publish,
windows, supply caps, art upload), grants panel, ledger explorer, config card
(read-only rendering for `settingsReadonly` operators).

### 3.8 Security posture (non-negotiable)

- Server is the trust boundary: every gate wired on every path (`requireAuth`,
  `requireProjectAdmin`, `assertCanReadSpace` for space flair, ownership checks on
  equip/gift). RLS deny-all as defense-in-depth only.
- Value mutations are ledger inserts through serialized SQL functions with row locks —
  handlers never write balances; no TOCTOU double-spend path (the events-RSVP lesson,
  applied from day one).
- Idempotency keys on purchase/gift; standard rate-limit middleware applies (no new
  limiter in v1).
- `GET /store/me/*` strictly self-scoped; another member's balance/inventory is never
  readable; no balance data in notifications or logs.
- `parseBody` + contract zod at every boundary; amounts are positive ints with
  server-side maxima; all SQL parameterized with explicit casts.

### 3.9 Testing

- **Unit (vitest, no DB):** earn-rate/cap policy matrix, availability-window logic,
  slot/type compatibility validation, store-config clamping, cosmetics shaper —
  mirroring `steward-notify.test.ts`.
- **Integration (real Postgres, project-isolated):** purchase negatives (insufficient
  balance, sold out, window closed, idempotency replay, already-owned), gift
  negatives (self-gift, over-max, insufficient balance), non-owner equip 403,
  `store/not-enabled` 404, settings-readonly 403 on `PATCH /settings/store`,
  ledger↔balance trigger consistency.
- `pnpm -r typecheck` + `pnpm test` green before any completion claim.

## 4. Phase 2 — real money + fulfilled merch

### 4.1 Money rail

Operator brings their own Stripe account: `STRIPE_SECRET_KEY` +
`STRIPE_WEBHOOK_SECRET` env (unset → `503 store/payments-not-configured`). No
platform account, no Connect — the operator is the merchant of record; Agora stays
out of money transmission. **Stripe Checkout hosted sessions** only (card data never
touches Agora; minimal PCI scope). Webhook handler is signature-verified and
idempotent by Stripe event id.

Two purchasables:

1. **Coin packs** (`store_config.coinPacks`) — webhook success writes a `topup`
   ledger entry. The Phase 1 ledger absorbs real money unchanged.
2. **Merch orders** — real-currency-priced only; coins remain a closed loop.

### 4.2 Fulfillment seam

`lib/fulfillment/` mirrors the `lib/storage/` provider pattern: a
`FulfillmentProvider` interface (`createOrder`, `getShippingRates`,
`verifyWebhook`/`parseWebhook`) with a **Printful** reference implementation,
selected by `FULFILLMENT_PROVIDER` env. Outbound calls respect the SSRF guard
posture; provider webhooks get their own secret-verified internal endpoint.

### 4.3 Merch data + orders

- **`merch_variants`**: `item_id` → size/color, provider variant id, print-file
  `files` refs, `price_cents` + `currency`.
- **`store_orders`**: status machine `pending_payment → paid → submitted → shipped →
  delivered | cancelled | refunded`; Stripe session/payment-intent ids, provider
  order id, tracking number; `project_id` + `profile_id`.
- **Shipping addresses = PII crown jewel:** stored per-order only (no address book),
  encrypted at rest (pgcrypto), readable only by the order's owner and
  project-admins, **never logged** (Log-with-intent applies hard), purged from the
  row after a post-delivery retention window (default 90 days, configurable).

### 4.4 Refunds

Admin-initiated via Stripe API. Refunded coin packs claw back coins with a
compensating ledger entry — balance may go negative, which blocks spending until
repaid (never blocks reading or participation).

## 5. Rollout & propagation obligations

- Phase 1 ships behind `store_config.enabled=false` — zero behavior change for
  existing sites until an admin opts in.
- New env vars (Phase 2: `STRIPE_*`, `FULFILLMENT_*`) propagate to all three
  `.env.*.example` files, compose files, README, SELF-HOSTING docs per
  `docs/PROPAGATION.yaml` (run `/propagate` on the branch).
- MANIFEST §store + MODELS shapes land with Phase 1; CHANGELOG entries under
  `[Unreleased]` per convention; SECURITY.md gains a Store section (ledger trust
  model, PII handling).
- SDK fork (`../agora-sdk`) grows the `useStore*` hook family against the published
  contract; the demo harness (`../agora-demo`) gets a Store tab — both separate
  repos, separate cycles.

## 6. Open questions (deferred, not blocking)

- Creator marketplace activation: submission review flow, revenue-share payout rail.
- Subscriptions / "Nitro-alike" bundles.
- Coin-price display alongside real-money coin-pack pricing (regulatory optics in
  some jurisdictions when coins become purchasable).
- Cross-project cosmetics portability (out of scope while agora-server stays
  single-tenant; a hosting-layer question).
