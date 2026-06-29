# Events Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A complete Events domain (events + RSVPs + invites + hosts + image galleries) matching the SDK contract 1:1, behind server-side authorization, space-access, and moderation-visibility gates.

**Architecture:** A new Drizzle schema file + one hand-authored idempotent SQL migration (tables, enums, indexes, RLS deny-all, PostGIS `location`, `files.event_id`). Branching logic (capacity, visibility, host-auth, last-host, shaping) lives in pure unit-tested helpers (`lib/events-policy.ts`, `lib/shape.ts`). A single domain router (`routes/events.ts`) holds the ~16 endpoints, sharing a few module-private helpers (`getEvent`, `requireEventManage`, `buildEventResponse`). Security-critical gates get integration tests with negative cases.

**Tech Stack:** Hono, Drizzle ORM (`postgres.js`), PostGIS (`geography(Point,4326)`), zod (contract), vitest (unit + integration), the existing image-upload pipeline (`lib/images.ts`).

## Global Constraints

- **Security-first, fail closed.** Every endpoint wires its gates: `requireAuth` where it mutates; `assertCanPostInSpace` on create when `spaceId` set; visibility gate on reads; `removedPolicy(c)` so removed events never reach non-admins; host/admin gate on management. A missing gate is a defect.
- **Authorization (resolved decisions):** update/delete/cancel + manage hosts/invites = **any host OR project-admin** (`isProjectAdmin(c.var.auth)` folds in operator/owner). Creator is auto-added as a host. The **last host cannot be removed** (`events/last-host`).
- **Capacity** caps **`going` only** (reject with `400 events/capacity-full`); `maybe`/`not_going` never blocked, never counted.
- **`allow_maybe:false`** → `400 events/maybe-not-allowed` on a `maybe` RSVP. Cancelled/past event → `400 events/rsvp-closed`.
- **`visibility`:** `public` = anyone (subject to space read access); `members` = space members if `space_id` set, else any authenticated project member; `invite` = invitees + hosts/admins only (`403` otherwise).
- **`locationFilters`** radius in **km** via PostGIS `ST_DWithin` over the geography column (mirror `lib/entity-filters.ts:114-121`).
- **Migrations:** hand-author SQL (do NOT rely on `db:generate` — it's broken in this repo), idempotent (`create … if not exists`, DO-block enums, `drop policy if exists` before create). Apply with `pnpm db:migrate:run`. New table ships its **own RLS deny-all** (the one-time `0017` guard doesn't cover new tables). Journal `when` strictly greater than the current max (`1781934611650`).
- **Shape every row** through `lib/shape.ts` (camelCase, Date→ISO). Lists → `paginate()`/`readPagination()`. Errors → `Errors.*`, never bare strings.
- `pnpm -r typecheck`, `pnpm --filter @agora/api test`, and (for DB-backed tasks) `pnpm test:integration` must pass before a task is done.
- Integration harness (`test/integration/helpers.js`): `createProject()`, `createUser(projectId, role?) → { id, token }`, `api(method, path, { token?, body? }) → { status, body }`, `base(projectId)`, `deleteProject(projectId)`. Run a single integration file: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts <name>` (the bare `pnpm test:integration -- <name>` does NOT filter). Prefix with `TMPDIR="$HOME/.cache/agora-tmp"` if `/private/tmp` fills.

---

### Task 1: Schema — enums, tables, `files.event_id`

**Files:**
- Modify: `packages/core/src/db/schema/_shared.ts` (add 4 enums)
- Create: `packages/core/src/db/schema/events.ts`
- Modify: `packages/core/src/db/schema/index.ts` (barrel export)
- Modify: `packages/core/src/db/schema/misc.ts` (add `eventId` to `files` + index)

**Interfaces:**
- Produces Drizzle tables `events`, `eventRsvps`, `eventInvites`, `eventHosts` and enums `eventType`/`eventVisibility`/`eventStatus`/`rsvpStatus`, all re-exported from `@agora/core/db`. `files.eventId` nullable FK.

- [ ] **Step 1: Add the enums**

In `packages/core/src/db/schema/_shared.ts`, after the `connectionStatus` enum (line ~26), add:

```ts
// ─── Events ──────────────────────────────────────────────────────────────────
export const eventType = pgEnum("event_type", ["online", "physical", "hybrid"]);
export const eventVisibility = pgEnum("event_visibility", ["public", "members", "invite"]);
export const eventStatus = pgEnum("event_status", ["active", "cancelled"]);
export const rsvpStatus = pgEnum("rsvp_status", ["going", "maybe", "not_going"]);
```

- [ ] **Step 2: Create the schema file**

```ts
// packages/core/src/db/schema/events.ts
// events, event_rsvps, event_invites, event_hosts (SDK v7.6.2 Events domain).
// NOTE: `location` geography(Point,4326) + its GiST index are added in the custom SQL migration
// (Drizzle's customType mis-quotes the geography modifier — same as entities/profiles).
// `space_id` is a SOFT reference (no FK) per the SDK contract. rsvp_counts + host_ids are DERIVED
// (computed per request), not stored.
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index, unique, primaryKey } from "drizzle-orm/pg-core";
import { eventType, eventVisibility, eventStatus, rsvpStatus, moderationStatus, moderatedByType } from "./_shared.js";
import { projects, profiles } from "./projects.js";

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  shortId: text("short_id").notNull(),
  userId: uuid("user_id").references(() => profiles.id, { onDelete: "set null" }), // creator
  title: text("title").notNull(),
  description: text("description"),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }),
  timezone: text("timezone"),
  type: eventType("type").notNull(),
  url: text("url"),
  venueName: text("venue_name"),
  address: text("address"),
  spaceId: uuid("space_id"), // SOFT ref — no FK
  visibility: eventVisibility("visibility").notNull().default("public"),
  status: eventStatus("status").notNull().default("active"),
  allowMaybe: boolean("allow_maybe").notNull().default(true),
  guestListVisible: boolean("guest_list_visible").notNull().default(true),
  capacity: integer("capacity"), // null = unlimited
  coverImageId: uuid("cover_image_id"), // a files.id (no FK — avoids a cycle with files.event_id)
  // location geography(Point,4326) added in the custom events migration
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  moderationStatus: moderationStatus("moderation_status"),
  moderatedAt: timestamp("moderated_at", { withTimezone: true }),
  moderatedById: uuid("moderated_by_id").references(() => profiles.id, { onDelete: "set null" }),
  moderatedByType: moderatedByType("moderated_by_type"),
  moderationReason: text("moderation_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  unique("events_project_short").on(t.projectId, t.shortId),
  index("events_feed_idx").on(t.projectId, t.startTime),
  index("events_space_idx").on(t.projectId, t.spaceId),
]);

export const eventRsvps = pgTable("event_rsvps", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  status: rsvpStatus("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("event_rsvps_unique").on(t.eventId, t.userId),
  index("event_rsvps_event_idx").on(t.eventId, t.status),
]);

export const eventInvites = pgTable("event_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  invitedAt: timestamp("invited_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("event_invites_unique").on(t.eventId, t.userId),
]);

export const eventHosts = pgTable("event_hosts", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.eventId, t.userId] }),
  index("event_hosts_user_idx").on(t.projectId, t.userId),
]);
```

- [ ] **Step 3: Barrel export**

In `packages/core/src/db/schema/index.ts`, add after the `./misc.js` line:

```ts
export * from "./events.js";
```

- [ ] **Step 4: Add `files.event_id`**

In `packages/core/src/db/schema/misc.ts`, in the `files` table definition, add the column after
`spaceId` (the column list, ~line where `spaceId` is declared):

```ts
  eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
```

…and add the index in the constraints tuple:

```ts
  index("files_event_idx").on(t.eventId),
```

Add `events` to the imports at the top of `misc.ts`:

```ts
import { events } from "./events.js";
```

(If `misc.ts` imports tables from sibling files differently, follow its existing import style.)

- [ ] **Step 5: Build the kernel + typecheck**

Run (from repo root):

```bash
pnpm --filter @agora/core build && pnpm -r typecheck
```

Expected: PASS. (No migration applied yet — that's Task 2. Drizzle schema is the TS source of truth.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/db/schema/_shared.ts packages/core/src/db/schema/events.ts packages/core/src/db/schema/index.ts packages/core/src/db/schema/misc.ts
git commit -m "feat(schema): events/rsvps/invites/hosts tables + files.event_id"
```

---

### Task 2: Migration — tables, indexes, RLS, PostGIS

**Files:**
- Create: `apps/api/drizzle/0054_events.sql` (confirm the number first — see Step 1)
- Modify: `apps/api/drizzle/meta/_journal.json`

- [ ] **Step 1: Confirm the next free migration number**

Run (from `apps/api`):

```bash
ls drizzle/*.sql | tail -3
```

Use the next integer after the highest existing migration. This plan assumes `0054` (with the inbox
plan's `0053` landed). If `0053` is NOT present, use `0053`; adjust the filename + journal `tag`
accordingly. The journal `when` is `(current max when) + 1`.

- [ ] **Step 2: Write the migration (idempotent)**

```sql
-- apps/api/drizzle/0054_events.sql
-- Events domain: enums, tables, indexes, RLS deny-all, PostGIS location, files.event_id.
-- Hand-authored + idempotent (db:generate is not used in this repo).
SET search_path TO public, extensions;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "event_type" AS ENUM ('online','physical','hybrid'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "event_visibility" AS ENUM ('public','members','invite'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "event_status" AS ENUM ('active','cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "rsvp_status" AS ENUM ('going','maybe','not_going'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "short_id" text NOT NULL,
  "user_id" uuid REFERENCES "profiles"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "description" text,
  "start_time" timestamptz NOT NULL,
  "end_time" timestamptz,
  "timezone" text,
  "type" "event_type" NOT NULL,
  "url" text,
  "venue_name" text,
  "address" text,
  "space_id" uuid,
  "visibility" "event_visibility" NOT NULL DEFAULT 'public',
  "status" "event_status" NOT NULL DEFAULT 'active',
  "allow_maybe" boolean NOT NULL DEFAULT true,
  "guest_list_visible" boolean NOT NULL DEFAULT true,
  "capacity" integer,
  "cover_image_id" uuid,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "moderation_status" "moderation_status",
  "moderated_at" timestamptz,
  "moderated_by_id" uuid REFERENCES "profiles"("id") ON DELETE SET NULL,
  "moderated_by_type" "moderated_by_type",
  "moderation_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_project_short" ON "events" ("project_id","short_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_feed_idx" ON "events" ("project_id","start_time");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_space_idx" ON "events" ("project_id","space_id");
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "location" geography(Point,4326);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_location_gist" ON "events" USING gist ("location");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_rsvps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "status" "rsvp_status" NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_rsvps_unique" ON "event_rsvps" ("event_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_rsvps_event_idx" ON "event_rsvps" ("event_id","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "invited_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_invites_unique" ON "event_invites" ("event_id","user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_hosts" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "event_hosts_pk" PRIMARY KEY ("event_id","user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_hosts_user_idx" ON "event_hosts" ("project_id","user_id");
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "event_id" uuid REFERENCES "events"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_event_idx" ON "files" ("event_id");
--> statement-breakpoint
-- RLS deny-all backstop (new tables aren't covered by the one-time 0017 guard). Server bypasses RLS
-- as the owner role; this is defense-in-depth (SECURITY.md).
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "event_rsvps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "event_invites" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "event_hosts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "events"; CREATE POLICY "deny_all" ON "events" FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "event_rsvps"; CREATE POLICY "deny_all" ON "event_rsvps" FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "event_invites"; CREATE POLICY "deny_all" ON "event_invites" FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "event_hosts"; CREATE POLICY "deny_all" ON "event_hosts" FOR ALL USING (false) WITH CHECK (false);
```

- [ ] **Step 3: Append the journal entry**

In `apps/api/drizzle/meta/_journal.json`, append to the `entries` array (mirror the existing entry
shape; `idx` = previous + 1, `when` = previous max + 1, `tag` = the filename without `.sql`). If the
inbox plan already added `0053`, this is `idx: 54, when: 1781934611652`:

```json
		,{
			"idx": 54,
			"version": "7",
			"when": 1781934611652,
			"tag": "0054_events",
			"breakpoints": true
		}
```

- [ ] **Step 4: Apply + verify**

Run (from `apps/api`):

```bash
pnpm db:migrate:run
url=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
psql "$url" -c "\dt events" -c "\d+ events" | grep -E "events|location"
psql "$url" -c "\d files" | grep event_id
pnpm db:migrate:run   # re-run: must be a no-op (idempotent)
```

Expected: tables exist, `location` is `geography(Point,4326)`, `files.event_id` present; the second
run applies nothing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/drizzle/0054_events.sql apps/api/drizzle/meta/_journal.json
git commit -m "feat(db): events domain migration (tables, RLS, PostGIS)"
```

---

### Task 3: Contract — zod schemas + response types

**Files:**
- Create: `packages/contract/src/events.ts`
- Modify: `packages/contract/src/index.ts` (export the new module)
- Test: `apps/api/src/lib/contract-schemas.test.ts`

**Interfaces:**
- Produces (from `@agora-server/contract`): `createEventSchema`, `updateEventSchema`, `rsvpSchema`, `eventUserIdSchema`, `eventVisibilityEnum`, `rsvpStatusEnum`, and TS types `Event`, `EventRsvp`, `EventInvite`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/lib/contract-schemas.test.ts`:

```ts
import { createEventSchema, rsvpSchema, rsvpStatusEnum } from "@agora-server/contract";

describe("event schemas", () => {
  it("requires title, startTime, and type on create", () => {
    expect(createEventSchema.safeParse({ title: "Party", startTime: "2026-07-01T18:00:00Z", type: "online" }).success).toBe(true);
    expect(createEventSchema.safeParse({ title: "Party" }).success).toBe(false); // missing startTime/type
  });
  it("rejects an unknown event type", () => {
    expect(createEventSchema.safeParse({ title: "x", startTime: "2026-07-01T18:00:00Z", type: "bogus" }).success).toBe(false);
  });
  it("accepts the three RSVP statuses and rejects others", () => {
    for (const s of ["going", "maybe", "not_going"]) expect(rsvpSchema.safeParse({ status: s }).success).toBe(true);
    expect(rsvpSchema.safeParse({ status: "perhaps" }).success).toBe(false);
    expect(rsvpStatusEnum.options).toEqual(["going", "maybe", "not_going"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- contract-schemas`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Write the contract module**

```ts
// packages/contract/src/events.ts
// Events domain request schemas + response types (SDK v7.6.2). Pure zod + types — no server coupling.
import { z } from "zod";

export const eventTypeEnum = z.enum(["online", "physical", "hybrid"]);
export const eventVisibilityEnum = z.enum(["public", "members", "invite"]);
export const eventStatusEnum = z.enum(["active", "cancelled"]);
export const rsvpStatusEnum = z.enum(["going", "maybe", "not_going"]);

const locationInput = z.object({ latitude: z.number(), longitude: z.number() }).nullish();

export const createEventSchema = z.object({
  title: z.string().min(1),
  startTime: z.string(),            // ISO 8601
  type: eventTypeEnum,
  description: z.string().nullish(),
  endTime: z.string().nullish(),
  timezone: z.string().nullish(),
  url: z.string().nullish(),
  venueName: z.string().nullish(),
  address: z.string().nullish(),
  location: locationInput,
  spaceId: z.string().uuid().nullish(),
  visibility: eventVisibilityEnum.optional(),     // default "public" server-side
  capacity: z.number().int().positive().nullish(),
  allowMaybe: z.boolean().nullish(),
  guestListVisible: z.boolean().nullish(),
  hostIds: z.array(z.string().uuid()).nullish(),  // creator auto-added
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

// Update = the same scalar set, all optional, MINUS hostIds (hosts are managed via /hosts), plus removeImageIds.
export const updateEventSchema = z.object({
  title: z.string().min(1).optional(),
  startTime: z.string().optional(),
  type: eventTypeEnum.optional(),
  description: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  venueName: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  location: locationInput,
  spaceId: z.string().uuid().nullable().optional(),
  visibility: eventVisibilityEnum.optional(),
  status: eventStatusEnum.optional(),
  capacity: z.number().int().positive().nullable().optional(),
  allowMaybe: z.boolean().optional(),
  guestListVisible: z.boolean().optional(),
  removeImageIds: z.array(z.string().uuid()).optional(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
}).refine((v) => Object.keys(v).length > 0, { message: "No updatable fields provided" });

export const rsvpSchema = z.object({ status: rsvpStatusEnum });
export const eventUserIdSchema = z.object({ userId: z.string().uuid() });

export type EventType = z.infer<typeof eventTypeEnum>;
export type EventVisibility = z.infer<typeof eventVisibilityEnum>;
export type EventStatus = z.infer<typeof eventStatusEnum>;
export type RsvpStatus = z.infer<typeof rsvpStatusEnum>;

export interface Event {
  id: string; shortId: string; projectId: string;
  userId: string | null; user?: unknown | null;
  title: string; description: string | null;
  startTime: string; endTime: string | null; timezone: string | null;
  type: EventType; url: string | null;
  venueName: string | null; address: string | null;
  location: { type: "Point"; coordinates: [number, number] } | null;
  spaceId: string | null; space?: unknown | null;
  visibility: EventVisibility; status: EventStatus;
  allowMaybe: boolean; guestListVisible: boolean;
  capacity: number | null;
  hostIds: string[];
  coverImageId: string | null; files?: unknown[];
  rsvpCounts: { going: number; maybe: number; not_going: number };
  userRsvp?: RsvpStatus | null;
  metadata: Record<string, unknown>;
  createdAt: string; updatedAt: string; deletedAt: string | null;
}
export interface EventRsvp { id: string; eventId: string; userId: string; user?: unknown; status: RsvpStatus; createdAt: string; updatedAt: string }
export interface EventInvite { id: string; eventId: string; userId: string; user?: unknown; invitedAt: string; createdAt: string; updatedAt: string }
```

In `packages/contract/src/index.ts`, add:

```ts
export * from "./events.js";
```

Then rebuild the contract:

```bash
pnpm --filter @agora-server/contract build
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- contract-schemas`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src/events.ts packages/contract/src/index.ts
git commit -m "feat(contract): event schemas + response types"
```

---

### Task 4: Pure policy helpers (capacity, visibility, host-auth)

**Files:**
- Create: `apps/api/src/lib/events-policy.ts`
- Test: `apps/api/src/lib/events-policy.test.ts`

**Interfaces:**
- Produces:
  - `canRsvpGoing(goingCount: number, capacity: number | null): boolean`
  - `isEventHost(hostIds: string[], userId: string | undefined): boolean`
  - `wouldOrphanHosts(hostIds: string[], removingUserId: string): boolean`
  - `canViewEvent(ev: { visibility: "public"|"members"|"invite" }, v: { isAuthed: boolean; isMember: boolean; isInvited: boolean; isHostOrAdmin: boolean }): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/lib/events-policy.test.ts
import { describe, it, expect } from "vitest";
import { canRsvpGoing, isEventHost, wouldOrphanHosts, canViewEvent } from "./events-policy.js";

describe("canRsvpGoing", () => {
  it("allows unlimited capacity (null)", () => expect(canRsvpGoing(999, null)).toBe(true));
  it("allows while under capacity, blocks at/over", () => {
    expect(canRsvpGoing(4, 5)).toBe(true);
    expect(canRsvpGoing(5, 5)).toBe(false);
    expect(canRsvpGoing(6, 5)).toBe(false);
  });
});

describe("isEventHost", () => {
  it("is true only when the user id is in hostIds", () => {
    expect(isEventHost(["a", "b"], "b")).toBe(true);
    expect(isEventHost(["a", "b"], "c")).toBe(false);
    expect(isEventHost(["a"], undefined)).toBe(false);
  });
});

describe("wouldOrphanHosts", () => {
  it("is true only when removing the sole host", () => {
    expect(wouldOrphanHosts(["a"], "a")).toBe(true);
    expect(wouldOrphanHosts(["a", "b"], "a")).toBe(false);
    expect(wouldOrphanHosts(["a", "b"], "c")).toBe(false); // not a host → not orphaning
  });
});

describe("canViewEvent", () => {
  const V = (p: any) => ({ isAuthed: false, isMember: false, isInvited: false, isHostOrAdmin: false, ...p });
  it("host/admin always see, regardless of visibility", () => {
    expect(canViewEvent({ visibility: "invite" }, V({ isHostOrAdmin: true }))).toBe(true);
  });
  it("public is visible to anyone", () => {
    expect(canViewEvent({ visibility: "public" }, V({}))).toBe(true);
  });
  it("members requires membership", () => {
    expect(canViewEvent({ visibility: "members" }, V({ isAuthed: true, isMember: true }))).toBe(true);
    expect(canViewEvent({ visibility: "members" }, V({ isAuthed: true, isMember: false }))).toBe(false);
  });
  it("invite requires an invitation", () => {
    expect(canViewEvent({ visibility: "invite" }, V({ isAuthed: true, isInvited: true }))).toBe(true);
    expect(canViewEvent({ visibility: "invite" }, V({ isAuthed: true, isInvited: false }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- events-policy`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the helpers**

```ts
// apps/api/src/lib/events-policy.ts
// Pure authorization/semantics predicates for the Events domain (unit-tested without a DB).
// The route resolves the DB facts (counts, membership, invitation, host roster) and calls these.

/** Capacity caps `going` only: null = unlimited; otherwise reject once going-count hits capacity. */
export function canRsvpGoing(goingCount: number, capacity: number | null): boolean {
  return capacity == null || goingCount < capacity;
}

export function isEventHost(hostIds: string[], userId: string | undefined): boolean {
  return !!userId && hostIds.includes(userId);
}

/** Removing the sole host would orphan the event (must be rejected). */
export function wouldOrphanHosts(hostIds: string[], removingUserId: string): boolean {
  return hostIds.length <= 1 && hostIds.includes(removingUserId);
}

export function canViewEvent(
  ev: { visibility: "public" | "members" | "invite" },
  v: { isAuthed: boolean; isMember: boolean; isInvited: boolean; isHostOrAdmin: boolean },
): boolean {
  if (v.isHostOrAdmin) return true;
  switch (ev.visibility) {
    case "public": return true;
    case "members": return v.isMember;
    case "invite": return v.isInvited;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- events-policy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/events-policy.ts apps/api/src/lib/events-policy.test.ts
git commit -m "feat(events): pure policy helpers (capacity/visibility/host-auth)"
```

---

### Task 5: Event shapers

**Files:**
- Modify: `apps/api/src/lib/shape.ts` (add event shapers near the other shapers)
- Test: `apps/api/src/lib/shape-events.test.ts`

**Interfaces:**
- Produces:
  - `shapeEvent(row, opts: { location?: { lat: number; lng: number } | null; hostIds: string[]; rsvpCounts: { going: number; maybe: number; not_going: number }; userRsvp?: string | null; user?: unknown; space?: unknown; files?: unknown[] })`
  - `shapeEventRsvp(row, user?)`, `shapeEventInvite(row, user?)`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/lib/shape-events.test.ts
import { describe, it, expect } from "vitest";
import { shapeEvent } from "./shape.js";

const row = {
  id: "e1", projectId: "p1", shortId: "abc", userId: "u1",
  title: "Launch", description: null, startTime: new Date("2026-07-01T18:00:00Z"),
  endTime: null, timezone: "UTC", type: "online", url: null, venueName: null, address: null,
  spaceId: null, visibility: "public", status: "active", allowMaybe: true, guestListVisible: true,
  capacity: null, coverImageId: null, metadata: {}, moderationStatus: null,
  createdAt: new Date("2026-06-01T00:00:00Z"), updatedAt: new Date("2026-06-01T00:00:00Z"), deletedAt: null,
} as any;

describe("shapeEvent", () => {
  it("maps scalars, derives hostIds + rsvpCounts, ISO-formats dates", () => {
    const out = shapeEvent(row, { location: null, hostIds: ["u1"], rsvpCounts: { going: 2, maybe: 1, not_going: 0 } }) as any;
    expect(out.id).toBe("e1");
    expect(out.hostIds).toEqual(["u1"]);
    expect(out.rsvpCounts).toEqual({ going: 2, maybe: 1, not_going: 0 });
    expect(out.startTime).toBe("2026-07-01T18:00:00.000Z");
    expect(out.location).toBeNull();
    expect("userRsvp" in out).toBe(false); // omitted unless provided
  });
  it("emits GeoJSON [lng, lat] when location is present", () => {
    const out = shapeEvent(row, { location: { lat: 40.5, lng: -73.9 }, hostIds: [], rsvpCounts: { going: 0, maybe: 0, not_going: 0 } }) as any;
    expect(out.location).toEqual({ type: "Point", coordinates: [-73.9, 40.5] });
  });
  it("includes userRsvp when provided (incl. null)", () => {
    const out = shapeEvent(row, { location: null, hostIds: [], rsvpCounts: { going: 0, maybe: 0, not_going: 0 }, userRsvp: "going" }) as any;
    expect(out.userRsvp).toBe("going");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- shape-events`
Expected: FAIL — `shapeEvent` not exported.

- [ ] **Step 3: Add the shapers to `shape.ts`**

Add near the end of the chat shapers in `apps/api/src/lib/shape.ts` (and add the row types). The
`events`/`eventRsvps`/`eventInvites` tables are exported from the schema barrel already imported in
`shape.ts`:

```ts
// ─── event shapers ───────────────────────────────────────────────────────────
type EventRow = typeof events.$inferSelect;
type EventRsvpRow = typeof eventRsvps.$inferSelect;
type EventInviteRow = typeof eventInvites.$inferSelect;

export function shapeEvent(
  row: EventRow,
  opts: {
    location?: { lat: number; lng: number } | null;
    hostIds: string[];
    rsvpCounts: { going: number; maybe: number; not_going: number };
    userRsvp?: string | null;
    user?: unknown;
    space?: unknown;
    files?: unknown[];
  },
) {
  const ev: Record<string, unknown> = {
    id: row.id,
    shortId: row.shortId,
    projectId: row.projectId,
    userId: row.userId ?? null,
    title: row.title,
    description: row.description ?? null,
    startTime: iso(row.startTime)!,
    endTime: iso(row.endTime),
    timezone: row.timezone ?? null,
    type: row.type,
    url: row.url ?? null,
    venueName: row.venueName ?? null,
    address: row.address ?? null,
    location: opts.location ? { type: "Point", coordinates: [opts.location.lng, opts.location.lat] } : null,
    spaceId: row.spaceId ?? null,
    visibility: row.visibility,
    status: row.status,
    allowMaybe: row.allowMaybe,
    guestListVisible: row.guestListVisible,
    capacity: row.capacity ?? null,
    hostIds: opts.hostIds,
    coverImageId: row.coverImageId ?? null,
    rsvpCounts: opts.rsvpCounts,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
    deletedAt: iso(row.deletedAt),
  };
  if (opts.userRsvp !== undefined) ev.userRsvp = opts.userRsvp;
  if (opts.user !== undefined) ev.user = opts.user;
  if (opts.space !== undefined) ev.space = opts.space;
  if (opts.files !== undefined) ev.files = opts.files;
  return ev;
}

export function shapeEventRsvp(row: EventRsvpRow, user?: User | null) {
  const r: Record<string, unknown> = {
    id: row.id, eventId: row.eventId, userId: row.userId, status: row.status,
    createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
  };
  if (user !== undefined) r.user = user;
  return r;
}

export function shapeEventInvite(row: EventInviteRow, user?: User | null) {
  const r: Record<string, unknown> = {
    id: row.id, eventId: row.eventId, userId: row.userId,
    invitedAt: iso(row.invitedAt)!, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
  };
  if (user !== undefined) r.user = user;
  return r;
}
```

Add `events, eventRsvps, eventInvites` to the schema import in `shape.ts` if not already pulled in via
the barrel (`import { … } from "../db/schema/index.js"`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- shape-events`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/shape.ts apps/api/src/lib/shape-events.test.ts
git commit -m "feat(events): event/rsvp/invite shapers"
```

---

### Task 6: Events router — CRUD + cancel + image gallery + mount

**Files:**
- Modify: `apps/api/src/lib/images.ts` (add `eventId` to `ImageAssoc` + the files insert)
- Create: `apps/api/src/routes/events.ts`
- Modify: `apps/api/src/routes/index.ts` (mount `/events`)
- Test: `apps/api/test/integration/events.test.ts`

**Interfaces:**
- Consumes: `createEventSchema`/`updateEventSchema` (Task 3), `shapeEvent` (Task 5), `isEventHost`/`canViewEvent` (Task 4), `assertCanPostInSpace`/`assertCanReadSpace` (existing), `isProjectAdmin`/`removedPolicy`/`shouldHide` (existing), `generateShortId`/`readPagination`/`paginate` (existing), `storeImageFromUpload` (existing).
- Produces: module-private `getEventOr404(c, id)`, `loadEventAssoc(c, row)` (returns `{ hostIds, rsvpCounts, location }`), `requireEventManage(c, row, hostIds)`, `buildEventResponse(c, row)`. These are reused by Tasks 7-8.

- [ ] **Step 1: Add `eventId` to the image pipeline**

In `apps/api/src/lib/images.ts`, add to the `ImageAssoc` interface (line 15-20):

```ts
  eventId?: string | null;
```

…and wherever `storeImageFromUpload` builds the `files` insert `values({...})`, include
`eventId: assoc.eventId ?? null` alongside the other assoc fields.

- [ ] **Step 2: Write the failing integration test (CRUD + auth gates)**

```ts
// apps/api/test/integration/events.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("events — CRUD + authorization (integration)", () => {
  let projectId: string; let B: string;
  let host: { id: string; token: string };
  let other: { id: string; token: string };
  let eventId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [host, other] = await Promise.all([createUser(projectId), createUser(projectId)]);
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("creates an event (creator auto-added as host)", async () => {
    const res = await api("POST", `${B}/events`, { token: host.token, body: { title: "Launch", startTime: "2026-07-01T18:00:00Z", type: "online" } });
    expect(res.status).toBe(201);
    expect(res.body.hostIds).toEqual([host.id]);
    expect(res.body.rsvpCounts).toEqual({ going: 0, maybe: 0, not_going: 0 });
    eventId = res.body.id;
  });

  it("fetches the event", async () => {
    const res = await api("GET", `${B}/events/${eventId}`, { token: host.token });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Launch");
  });

  it("rejects update by a non-host non-admin (403)", async () => {
    const res = await api("PATCH", `${B}/events/${eventId}`, { token: other.token, body: { title: "hijack" } });
    expect(res.status).toBe(403);
  });

  it("allows a host to update", async () => {
    const res = await api("PATCH", `${B}/events/${eventId}`, { token: host.token, body: { title: "Launch v2" } });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Launch v2");
  });

  it("cancels via the cancel endpoint", async () => {
    const res = await api("POST", `${B}/events/${eventId}/cancel`, { token: host.token });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("lists events for the project", async () => {
    const res = await api("GET", `${B}/events`, { token: host.token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some((e: any) => e.id === eventId)).toBe(true);
  });

  it("soft-deletes (204) and then 404s on fetch", async () => {
    expect((await api("DELETE", `${B}/events/${eventId}`, { token: host.token })).status).toBe(204);
    expect((await api("GET", `${B}/events/${eventId}`, { token: host.token })).status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the integration test to verify it fails**

Run (from `apps/api`): `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts events`
Expected: FAIL — `/events` not mounted (404s everywhere).

- [ ] **Step 4: Write the router (CRUD + cancel + shared helpers)**

```ts
// apps/api/src/routes/events.ts
// /v7/:projectId/events/* — events, RSVPs, invites, hosts (SDK v7.6.2). Pure REST (no sockets).
import { Hono } from "hono";
import { and, eq, isNull, sql, count, desc, asc, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { events, eventHosts, eventRsvps, eventInvites, spaceMembers, spaces } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { parseBody } from "../lib/validation.js";
import { createEventSchema, updateEventSchema, rsvpSchema, eventUserIdSchema } from "@agora-server/contract";
import { shapeEvent, shapeEventRsvp, shapeEventInvite, generateShortId, loadUsers, parseInclude } from "../lib/shape.js";
import { isProjectAdmin } from "../lib/project-roles.js";
import { removedPolicy, shouldHide } from "../lib/moderation-visibility.js";
import { assertCanPostInSpace, assertCanReadSpace } from "../lib/space-access.js";
import { isEventHost, canViewEvent, canRsvpGoing, wouldOrphanHosts } from "../lib/events-policy.js";
import { storeImageFromUpload } from "../lib/images.js";
import { logger } from "../lib/logger.js";

type EventRow = typeof events.$inferSelect;

// ── shared helpers ───────────────────────────────────────────────────────────
async function getEventOr404(c: any, id: string): Promise<EventRow> {
  const [row] = await db.select().from(events)
    .where(and(eq(events.projectId, c.var.projectId), eq(events.id, id), isNull(events.deletedAt))).limit(1);
  if (!row) throw Errors.notFound("events/not-found", "Event not found");
  return row;
}

async function loadHostIds(eventId: string): Promise<string[]> {
  const rows = await db.select({ userId: eventHosts.userId }).from(eventHosts)
    .where(eq(eventHosts.eventId, eventId)).orderBy(asc(eventHosts.createdAt));
  return rows.map((r) => r.userId);
}

async function loadRsvpCounts(eventId: string): Promise<{ going: number; maybe: number; not_going: number }> {
  const rows = await db.select({ status: eventRsvps.status, n: count() }).from(eventRsvps)
    .where(eq(eventRsvps.eventId, eventId)).groupBy(eventRsvps.status);
  const out = { going: 0, maybe: 0, not_going: 0 };
  for (const r of rows) (out as any)[r.status] = r.n;
  return out;
}

async function loadLocation(eventId: string): Promise<{ lat: number; lng: number } | null> {
  const res = (await db.execute(sql`
    select ST_Y(location::geometry) as lat, ST_X(location::geometry) as lng
    from events where id = ${eventId}::uuid and location is not null
  `)) as unknown as { lat: number; lng: number }[];
  return res[0] ? { lat: Number(res[0].lat), lng: Number(res[0].lng) } : null;
}

// Is the caller a member for `visibility:"members"`? space members if spaceId set, else any authed user.
async function isMemberForEvent(c: any, row: EventRow): Promise<boolean> {
  const uid = c.var.auth?.userId;
  if (!uid) return false;
  if (!row.spaceId) return true; // project member = any authenticated user
  const [m] = await db.select({ id: spaceMembers.id }).from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, row.spaceId), eq(spaceMembers.userId, uid), eq(spaceMembers.status, "active"))).limit(1);
  if (m) return true;
  const [s] = await db.select({ userId: spaces.userId }).from(spaces).where(eq(spaces.id, row.spaceId)).limit(1);
  return !!s && s.userId === uid;
}

async function isInvited(eventId: string, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const [r] = await db.select({ id: eventInvites.id }).from(eventInvites)
    .where(and(eq(eventInvites.eventId, eventId), eq(eventInvites.userId, userId))).limit(1);
  return !!r;
}

// Throws 403 unless the caller is a host or a project-admin.
function requireEventManage(c: any, hostIds: string[]): void {
  const auth = c.var.auth;
  if (auth && (isProjectAdmin(auth) || isEventHost(hostIds, auth.userId))) return;
  throw Errors.forbidden("events/not-host", "Only a host or admin can manage this event");
}

// Assemble the full Event response (hostIds, rsvpCounts, location, optional includes).
async function buildEventResponse(c: any, row: EventRow, opts: { include?: Set<string> } = {}) {
  const [hostIds, rsvpCounts, location] = await Promise.all([loadHostIds(row.id), loadRsvpCounts(row.id), loadLocation(row.id)]);
  const include = opts.include ?? new Set<string>();
  let userRsvp: string | null | undefined;
  if (include.has("userRsvp") && c.var.auth?.userId) {
    const [r] = await db.select({ status: eventRsvps.status }).from(eventRsvps)
      .where(and(eq(eventRsvps.eventId, row.id), eq(eventRsvps.userId, c.var.auth.userId))).limit(1);
    userRsvp = r?.status ?? null;
  }
  let user: unknown;
  if (include.has("user") && row.userId) {
    const um = await loadUsers(c.var.projectId, [row.userId]);
    user = um.get(row.userId) ?? null;
  }
  return shapeEvent(row, { hostIds, rsvpCounts, location, ...(userRsvp !== undefined ? { userRsvp } : {}), ...(user !== undefined ? { user } : {}) });
}

// Set the PostGIS location from a {latitude, longitude} input (or clear it when null).
async function writeLocation(eventId: string, loc: { latitude: number; longitude: number } | null | undefined) {
  if (loc === undefined) return;
  if (loc === null) { await db.execute(sql`update events set location = null where id = ${eventId}::uuid`); return; }
  await db.execute(sql`update events set location = ST_SetSRID(ST_MakePoint(${loc.longitude}, ${loc.latitude}), 4326)::geography where id = ${eventId}::uuid`);
}

// Pull scalar event fields out of a multipart form (cover/gallery handled separately).
function parseMultipartEventFields(form: Record<string, unknown>): Record<string, unknown> {
  const str = (k: string) => { const v = form[k]; return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined; };
  const json = (k: string) => { const s = str(k); if (s === undefined) return undefined; try { return JSON.parse(s); } catch { return undefined; } };
  return {
    title: str("title"), startTime: str("startTime"), type: str("type"), description: str("description"),
    endTime: str("endTime"), timezone: str("timezone"), url: str("url"), venueName: str("venueName"),
    address: str("address"), location: json("location"), spaceId: str("spaceId"), visibility: str("visibility"),
    capacity: json("capacity"), allowMaybe: json("allowMaybe"), guestListVisible: json("guestListVisible"),
    hostIds: json("hostIds"), metadata: json("metadata"),
  };
}

export const eventRoutes = new Hono<{ Variables: Variables }>()
  .post("/", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const userId = c.var.auth!.userId;
    const contentType = c.req.header("content-type") ?? "";
    const isMultipart = contentType.includes("multipart/form-data");
    let coverFiles: File[] = [], galleryFiles: File[] = [];
    let coverOpts: Record<string, unknown> = {}, galleryOpts: Record<string, unknown> = {};
    let rawBody: Record<string, unknown>;
    if (isMultipart) {
      const form = await c.req.parseBody({ all: true });
      rawBody = parseMultipartEventFields(form);
      const cv = form["cover"]; coverFiles = (Array.isArray(cv) ? cv : cv ? [cv] : []).filter((f): f is File => typeof f !== "string");
      const gl = form["gallery"]; galleryFiles = (Array.isArray(gl) ? gl : gl ? [gl] : []).filter((f): f is File => typeof f !== "string");
      if (typeof form["cover.options"] === "string") { try { coverOpts = JSON.parse(form["cover.options"] as string); } catch { /* ignore */ } }
      if (typeof form["gallery.options"] === "string") { try { galleryOpts = JSON.parse(form["gallery.options"] as string); } catch { /* ignore */ } }
    } else {
      rawBody = await c.req.json().catch(() => ({}));
    }
    const body = parseBody(createEventSchema, rawBody, "events");
    await assertCanPostInSpace(c, body.spaceId ?? null); // enforce space posting permission if attached

    const [row] = await db.insert(events).values({
      projectId, userId, shortId: generateShortId(),
      title: body.title, description: body.description ?? null,
      startTime: new Date(body.startTime), endTime: body.endTime ? new Date(body.endTime) : null,
      timezone: body.timezone ?? null, type: body.type, url: body.url ?? null,
      venueName: body.venueName ?? null, address: body.address ?? null, spaceId: body.spaceId ?? null,
      visibility: body.visibility ?? "public", capacity: body.capacity ?? null,
      allowMaybe: body.allowMaybe ?? true, guestListVisible: body.guestListVisible ?? true,
      metadata: body.metadata ?? undefined,
    }).returning();
    if (!row) throw Errors.badRequest("events/create-failed", "Insert returned no row");
    await writeLocation(row.id, body.location);

    // Hosts: creator + any supplied hostIds (deduped). Creator is always a host.
    const hostIds = [...new Set([userId, ...(body.hostIds ?? [])])];
    await db.insert(eventHosts).values(hostIds.map((uid) => ({ projectId, eventId: row.id, userId: uid }))).onConflictDoNothing();

    // Cover (first) + gallery images → files rows linked by event_id; cover_image_id points to the cover file.
    let coverImageId: string | null = null;
    for (const file of coverFiles) {
      const { fileRow } = await storeImageFromUpload({ projectId, userId, file, optionsBody: coverOpts, assoc: { eventId: row.id } });
      coverImageId = fileRow.id; break; // one cover
    }
    let pos = 0;
    for (const file of galleryFiles) {
      await storeImageFromUpload({ projectId, userId, file, optionsBody: galleryOpts, assoc: { eventId: row.id } });
      pos++;
    }
    if (coverImageId) await db.update(events).set({ coverImageId }).where(eq(events.id, row.id));

    const [fresh] = await db.select().from(events).where(eq(events.id, row.id)).limit(1);
    logger.info({ projectId, eventId: row.id, userId, spaceId: row.spaceId ?? null, hosts: hostIds.length }, "event: created");
    return c.json(await buildEventResponse(c, fresh!), 201);
  })
  .get("/", async (c) => {
    // List with filters: page/limit, sortBy (startTime|going), sortDir, timeWindow, spaceId, hostId,
    // type, status, startsAfter/Before, locationFilters[latitude|longitude|radius] (km).
    const projectId = c.var.projectId;
    const { page, limit, offset } = readPagination(c);
    const q = (k: string) => { const v = c.req.query(k); return v && v !== "null" && v !== "undefined" ? v : undefined; };
    const conds: SQL[] = [eq(events.projectId, projectId), isNull(events.deletedAt)];
    if (q("spaceId")) conds.push(eq(events.spaceId, q("spaceId")!));
    if (q("type")) conds.push(sql`${events.type} = ${q("type")}::event_type`);
    if (q("status")) conds.push(sql`${events.status} = ${q("status")}::event_status`);
    if (q("startsAfter")) conds.push(sql`${events.startTime} >= ${q("startsAfter")}::timestamptz`);
    if (q("startsBefore")) conds.push(sql`${events.startTime} <= ${q("startsBefore")}::timestamptz`);
    const tw = q("timeWindow");
    if (tw === "upcoming") conds.push(sql`${events.startTime} > now()`);
    else if (tw === "past") conds.push(sql`coalesce(${events.endTime}, ${events.startTime}) < now()`);
    else if (tw === "ongoing") conds.push(sql`${events.startTime} <= now() and coalesce(${events.endTime}, ${events.startTime}) >= now()`);
    if (q("hostId")) conds.push(sql`exists (select 1 from event_hosts h where h.event_id = ${events.id} and h.user_id = ${q("hostId")}::uuid)`);
    const lat = q("locationFilters[latitude]"), lng = q("locationFilters[longitude]"), radiusKm = q("locationFilters[radius]");
    if (lat && lng && radiusKm) {
      conds.push(sql`location is not null and ST_DWithin(location, ST_SetSRID(ST_MakePoint(${Number(lng)}, ${Number(lat)}), 4326)::geography, ${Number(radiusKm) * 1000})`);
    }
    // Hide removed events from non-admins.
    const removed = await removedPolicy(c);
    if (!removed.privileged) conds.push(sql`(${events.moderationStatus} is null or ${events.moderationStatus} <> 'removed')`);
    // Visibility: anonymous/non-members only see public events; admins see all. (Per-row invite/members
    // refinement is enforced on single GET; the list shows public + the caller's own visible set.)
    if (!(c.var.auth && isProjectAdmin(c.var.auth))) {
      const uid = c.var.auth?.userId ?? null;
      conds.push(uid
        ? sql`(${events.visibility} = 'public'
            or (${events.visibility} = 'members' and (${events.spaceId} is null or exists (select 1 from space_members m where m.space_id = ${events.spaceId} and m.user_id = ${uid}::uuid and m.status = 'active')))
            or (${events.visibility} = 'invite' and exists (select 1 from event_invites i where i.event_id = ${events.id} and i.user_id = ${uid}::uuid))
            or exists (select 1 from event_hosts h where h.event_id = ${events.id} and h.user_id = ${uid}::uuid))`
        : sql`${events.visibility} = 'public'`);
    }
    const where = and(...conds);
    const sortBy = q("sortBy");
    const dir = q("sortDir") === "asc" ? sql`asc` : sql`desc`;
    const orderBy = sortBy === "going"
      ? sql`(select count(*) from event_rsvps r where r.event_id = ${events.id} and r.status = 'going') ${dir}, ${events.startTime} asc`
      : sql`${events.startTime} ${dir}`;
    const rows = await db.select().from(events).where(where).orderBy(orderBy).limit(limit).offset(offset);
    const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(events).where(where);
    const data = await Promise.all(rows.map((r) => buildEventResponse(c, r)));
    return c.json(paginate(data, total, page, limit));
  })
  .get("/:eventId", async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    const removed = await removedPolicy(c);
    if (shouldHide(removed, row.moderationStatus)) throw Errors.notFound("events/not-found", "Event not found");
    if (row.spaceId) await assertCanReadSpace(c, row.spaceId); // space read gate first
    const hostIds = await loadHostIds(row.id);
    const isHostOrAdmin = !!(c.var.auth && (isProjectAdmin(c.var.auth) || isEventHost(hostIds, c.var.auth.userId)));
    const visible = canViewEvent(row, {
      isAuthed: !!c.var.auth, isHostOrAdmin,
      isMember: await isMemberForEvent(c, row),
      isInvited: await isInvited(row.id, c.var.auth?.userId),
    });
    if (!visible) throw Errors.forbidden("events/not-visible", "You don't have access to this event");
    return c.json(await buildEventResponse(c, row, { include: parseInclude(c) }));
  })
  .patch("/:eventId", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id));
    const body = parseBody(updateEventSchema, await c.req.json().catch(() => ({})), "events");
    const patch: Record<string, unknown> = {};
    const set = (k: keyof typeof body, col: string, transform?: (v: any) => unknown) => {
      if (body[k] !== undefined) patch[col] = transform ? transform(body[k]) : body[k];
    };
    set("title", "title"); set("description", "description"); set("type", "type"); set("url", "url");
    set("venueName", "venueName"); set("address", "address"); set("timezone", "timezone");
    set("visibility", "visibility"); set("status", "status"); set("capacity", "capacity");
    set("allowMaybe", "allowMaybe"); set("guestListVisible", "guestListVisible"); set("spaceId", "spaceId");
    set("metadata", "metadata"); set("startTime", "startTime", (v) => new Date(v));
    set("endTime", "endTime", (v) => (v ? new Date(v) : null));
    if (Object.keys(patch).length) await db.update(events).set(patch).where(eq(events.id, row.id));
    if (body.location !== undefined) await writeLocation(row.id, body.location);
    if (body.removeImageIds?.length) {
      await db.execute(sql`delete from files where event_id = ${row.id}::uuid and id = any(${sql`array[${sql.join(body.removeImageIds.map((id) => sql`${id}::uuid`), sql`, `)}]`})`);
    }
    const [fresh] = await db.select().from(events).where(eq(events.id, row.id)).limit(1);
    return c.json(await buildEventResponse(c, fresh!));
  })
  .delete("/:eventId", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id));
    await db.update(events).set({ deletedAt: new Date() }).where(eq(events.id, row.id));
    logger.info({ projectId: c.var.projectId, eventId: row.id, userId: c.var.auth!.userId }, "event: deleted");
    return c.body(null, 204);
  })
  .post("/:eventId/cancel", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id));
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, row.id));
    const [fresh] = await db.select().from(events).where(eq(events.id, row.id)).limit(1);
    return c.json(await buildEventResponse(c, fresh!));
  });
```

- [ ] **Step 5: Mount the router**

In `apps/api/src/routes/index.ts`, add the import and the mount (next to the other domain routers):

```ts
import { eventRoutes } from "./events.js";
// …inside mountRoutes(), with the other project.route(...) calls:
  project.route("/events", eventRoutes);
```

- [ ] **Step 6: Run the integration test to verify it passes**

Run (from `apps/api`): `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts events`
Expected: PASS (all CRUD + auth-gate cases).

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/api/src/lib/images.ts apps/api/src/routes/events.ts apps/api/src/routes/index.ts apps/api/test/integration/events.test.ts
git commit -m "feat(events): CRUD + cancel + image gallery router"
```

---

### Task 7: RSVP endpoints

**Files:**
- Modify: `apps/api/src/routes/events.ts` (add RSVP routes)
- Test: `apps/api/test/integration/event-rsvps.test.ts`

**Interfaces:**
- Consumes: `getEventOr404`, `loadHostIds`, `loadRsvpCounts`, `buildEventResponse`, `requireEventManage` (Task 6); `rsvpSchema` (Task 3); `canRsvpGoing` (Task 4).

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/test/integration/event-rsvps.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("event RSVPs (integration)", () => {
  let projectId: string; let B: string;
  let host: { id: string; token: string };
  let a: { id: string; token: string };
  let b: { id: string; token: string };
  let eventId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [host, a, b] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId)]);
    eventId = (await api("POST", `${B}/events`, { token: host.token, body: { title: "Capped", startTime: "2026-07-01T18:00:00Z", type: "online", capacity: 1, allowMaybe: false } })).body.id;
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("sets a going RSVP (upsert) and bumps the count", async () => {
    const res = await api("POST", `${B}/events/${eventId}/rsvp`, { token: a.token, body: { status: "going" } });
    expect(res.status).toBe(200);
    expect(res.body.rsvpCounts.going).toBe(1);
  });

  it("rejects a 2nd going past capacity 1 (400)", async () => {
    const res = await api("POST", `${B}/events/${eventId}/rsvp`, { token: b.token, body: { status: "going" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("events/capacity-full");
  });

  it("rejects maybe when allowMaybe is false (400)", async () => {
    const res = await api("POST", `${B}/events/${eventId}/rsvp`, { token: b.token, body: { status: "maybe" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("events/maybe-not-allowed");
  });

  it("withdraws an RSVP, freeing the seat", async () => {
    expect((await api("DELETE", `${B}/events/${eventId}/rsvp`, { token: a.token })).body.rsvpCounts.going).toBe(0);
    expect((await api("POST", `${B}/events/${eventId}/rsvp`, { token: b.token, body: { status: "going" } })).status).toBe(200);
  });

  it("lists RSVPs for the host", async () => {
    const res = await api("GET", `${B}/events/${eventId}/rsvps`, { token: host.token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts event-rsvps`
Expected: FAIL — RSVP routes return 404.

- [ ] **Step 3: Add the RSVP routes**

Append these handlers to the `eventRoutes` chain in `apps/api/src/routes/events.ts` (before the final
`;`). They reuse the Task 6 helpers:

```ts
  .post("/:eventId/rsvp", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    const { status } = parseBody(rsvpSchema, await c.req.json().catch(() => ({})), "events");
    if (row.status === "cancelled" || row.startTime.getTime() < Date.now()) {
      throw Errors.badRequest("events/rsvp-closed", "RSVPs are closed for this event");
    }
    if (status === "maybe" && !row.allowMaybe) throw Errors.badRequest("events/maybe-not-allowed", "This event does not allow 'maybe'");
    if (status === "going") {
      const counts = await loadRsvpCounts(row.id);
      // Only count an additional seat if the caller isn't already 'going'.
      const [mine] = await db.select({ status: eventRsvps.status }).from(eventRsvps)
        .where(and(eq(eventRsvps.eventId, row.id), eq(eventRsvps.userId, c.var.auth!.userId))).limit(1);
      const effectiveGoing = mine?.status === "going" ? counts.going - 1 : counts.going;
      if (!canRsvpGoing(effectiveGoing, row.capacity)) throw Errors.badRequest("events/capacity-full", "This event is at capacity");
    }
    await db.insert(eventRsvps).values({ projectId: c.var.projectId, eventId: row.id, userId: c.var.auth!.userId, status })
      .onConflictDoUpdate({ target: [eventRsvps.eventId, eventRsvps.userId], set: { status, updatedAt: new Date() } });
    return c.json(await buildEventResponse(c, row));
  })
  .delete("/:eventId/rsvp", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    await db.delete(eventRsvps).where(and(eq(eventRsvps.eventId, row.id), eq(eventRsvps.userId, c.var.auth!.userId)));
    return c.json(await buildEventResponse(c, row));
  })
  .get("/:eventId/rsvps", async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    const hostIds = await loadHostIds(row.id);
    const isHostOrAdmin = !!(c.var.auth && (isProjectAdmin(c.var.auth) || isEventHost(hostIds, c.var.auth.userId)));
    if (!isHostOrAdmin && !row.guestListVisible) throw Errors.forbidden("events/guest-list-hidden", "The guest list is private");
    const { page, limit, offset } = readPagination(c);
    const status = c.req.query("status");
    const where = and(eq(eventRsvps.eventId, row.id), status ? sql`${eventRsvps.status} = ${status}::rsvp_status` : undefined);
    const rows = await db.select().from(eventRsvps).where(where).orderBy(desc(eventRsvps.createdAt)).limit(limit).offset(offset);
    const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(eventRsvps).where(where);
    const include = parseInclude(c);
    const userMap = include.has("user") ? await loadUsers(c.var.projectId, rows.map((r) => r.userId)) : null;
    const data = rows.map((r) => shapeEventRsvp(r, userMap ? userMap.get(r.userId) ?? null : undefined));
    return c.json(paginate(data, total, page, limit));
  })
```

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts event-rsvps`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/api/src/routes/events.ts apps/api/test/integration/event-rsvps.test.ts
git commit -m "feat(events): RSVP set/withdraw/list with capacity + allowMaybe gates"
```

---

### Task 8: Invites + Hosts endpoints

**Files:**
- Modify: `apps/api/src/routes/events.ts` (add invite + host routes)
- Test: `apps/api/test/integration/event-invites-hosts.test.ts`

**Interfaces:**
- Consumes: `getEventOr404`, `loadHostIds`, `requireEventManage`, `buildEventResponse`, `wouldOrphanHosts` (Tasks 4/6); `eventUserIdSchema` (Task 3).

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/test/integration/event-invites-hosts.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";

describe("event invites + hosts (integration)", () => {
  let projectId: string; let B: string;
  let host: { id: string; token: string };
  let cohost: { id: string; token: string };
  let guest: { id: string; token: string };
  let stranger: { id: string; token: string };
  let eventId: string;

  beforeAll(async () => {
    projectId = await createProject();
    B = base(projectId);
    [host, cohost, guest, stranger] = await Promise.all([createUser(projectId), createUser(projectId), createUser(projectId), createUser(projectId)]);
    eventId = (await api("POST", `${B}/events`, { token: host.token, body: { title: "Invite-only", startTime: "2026-07-01T18:00:00Z", type: "online", visibility: "invite" } })).body.id;
  });
  afterAll(async () => { if (projectId) await deleteProject(projectId); });

  it("non-invitee cannot view an invite-only event (403)", async () => {
    expect((await api("GET", `${B}/events/${eventId}`, { token: stranger.token })).status).toBe(403);
  });

  it("host invites a guest (idempotent); guest can now view", async () => {
    expect((await api("POST", `${B}/events/${eventId}/invites`, { token: host.token, body: { userId: guest.id } })).status).toBe(200);
    expect((await api("POST", `${B}/events/${eventId}/invites`, { token: host.token, body: { userId: guest.id } })).status).toBe(200); // idempotent
    expect((await api("GET", `${B}/events/${eventId}`, { token: guest.token })).status).toBe(200);
  });

  it("non-host cannot list invites (403)", async () => {
    expect((await api("GET", `${B}/events/${eventId}/invites`, { token: stranger.token })).status).toBe(403);
  });

  it("host adds a co-host; co-host can then manage", async () => {
    expect((await api("POST", `${B}/events/${eventId}/hosts`, { token: host.token, body: { userId: cohost.id } })).body.hostIds).toContain(cohost.id);
    expect((await api("PATCH", `${B}/events/${eventId}`, { token: cohost.token, body: { title: "Renamed by cohost" } })).status).toBe(200);
  });

  it("removing the last host is rejected (400)", async () => {
    await api("DELETE", `${B}/events/${eventId}/hosts`, { token: host.token, body: { userId: cohost.id } });
    const res = await api("DELETE", `${B}/events/${eventId}/hosts`, { token: host.token, body: { userId: host.id } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("events/last-host");
  });

  it("removing an invite drops the invitee's RSVP + access", async () => {
    await api("POST", `${B}/events/${eventId}/rsvp`, { token: guest.token, body: { status: "going" } });
    await api("DELETE", `${B}/events/${eventId}/invites`, { token: host.token, body: { userId: guest.id } });
    expect((await api("GET", `${B}/events/${eventId}`, { token: guest.token })).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts event-invites-hosts`
Expected: FAIL — invite/host routes return 404.

- [ ] **Step 3: Add the invite + host routes**

Append to the `eventRoutes` chain in `apps/api/src/routes/events.ts`:

```ts
  // ── invites (host-only) ──
  .post("/:eventId/invites", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id));
    const { userId } = parseBody(eventUserIdSchema, await c.req.json().catch(() => ({})), "events");
    await db.insert(eventInvites).values({ projectId: c.var.projectId, eventId: row.id, userId }).onConflictDoNothing();
    return c.json(await buildEventResponse(c, row));
  })
  .delete("/:eventId/invites", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id));
    const { userId } = parseBody(eventUserIdSchema, await c.req.json().catch(() => ({})), "events");
    // Removing an invite also drops that user's RSVP (revokes access to invite-only events).
    await db.delete(eventInvites).where(and(eq(eventInvites.eventId, row.id), eq(eventInvites.userId, userId)));
    await db.delete(eventRsvps).where(and(eq(eventRsvps.eventId, row.id), eq(eventRsvps.userId, userId)));
    return c.json(await buildEventResponse(c, row));
  })
  .get("/:eventId/invites", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id)); // host-only list
    const { page, limit, offset } = readPagination(c);
    const rows = await db.select().from(eventInvites).where(eq(eventInvites.eventId, row.id))
      .orderBy(desc(eventInvites.createdAt)).limit(limit).offset(offset);
    const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(eventInvites).where(eq(eventInvites.eventId, row.id));
    const include = parseInclude(c);
    const userMap = include.has("user") ? await loadUsers(c.var.projectId, rows.map((r) => r.userId)) : null;
    const data = rows.map((r) => shapeEventInvite(r, userMap ? userMap.get(r.userId) ?? null : undefined));
    return c.json(paginate(data, total, page, limit));
  })
  // ── hosts ──
  .post("/:eventId/hosts", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    requireEventManage(c, await loadHostIds(row.id));
    const { userId } = parseBody(eventUserIdSchema, await c.req.json().catch(() => ({})), "events");
    await db.insert(eventHosts).values({ projectId: c.var.projectId, eventId: row.id, userId }).onConflictDoNothing();
    return c.json(await buildEventResponse(c, row));
  })
  .delete("/:eventId/hosts", requireAuth, async (c) => {
    const row = await getEventOr404(c, c.req.param("eventId"));
    const hostIds = await loadHostIds(row.id);
    requireEventManage(c, hostIds);
    const { userId } = parseBody(eventUserIdSchema, await c.req.json().catch(() => ({})), "events");
    if (wouldOrphanHosts(hostIds, userId)) throw Errors.badRequest("events/last-host", "An event must have at least one host");
    await db.delete(eventHosts).where(and(eq(eventHosts.eventId, row.id), eq(eventHosts.userId, userId)));
    return c.json(await buildEventResponse(c, row));
  })
```

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts event-invites-hosts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -r typecheck
git add apps/api/src/routes/events.ts apps/api/test/integration/event-invites-hosts.test.ts
git commit -m "feat(events): invite + host management with host-only + last-host gates"
```

---

### Task 9: Docs + final verification

**Files:**
- Modify: `CHANGELOG.md` (repo root, `## [Unreleased]`)
- Modify: `docs/MODELS.md` (add `Event`/`EventRsvp`/`EventInvite` shapes)
- Modify: `docs/MANIFEST.md` (add the `/events` endpoints to the contract inventory)

- [ ] **Step 1: Changelog**

Under `## [Unreleased]` → `### Added`:

```markdown
- Events domain: `events`/`event_rsvps`/`event_invites`/`event_hosts` tables + `files.event_id`.
- `/v7/:projectId/events/*`: CRUD + cancel, RSVP (set/withdraw/list), invites (host-only), hosts.
- Event image galleries (cover + gallery) via the existing image pipeline.
- `@agora-server/contract`: `Event`/`EventRsvp`/`EventInvite` types + request schemas.
```

- [ ] **Step 2: MODELS.md + MANIFEST.md**

Add the `Event`, `EventRsvp`, `EventInvite` field-level shapes (from `packages/contract/src/events.ts`)
to `docs/MODELS.md`, and the 16 `/events` endpoints (method + path) to `docs/MANIFEST.md`'s inventory,
marking them 🔶inferred (SDK-derived, not yet round-tripped against the live SDK).

- [ ] **Step 3: Full verification**

Run (from repo root):

```bash
pnpm -r build && pnpm -r typecheck && pnpm --filter @agora/api test
cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts events event-rsvps event-invites-hosts
```

Expected: build, typecheck, unit suite, and the three events integration files all PASS.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/MODELS.md docs/MANIFEST.md
git commit -m "docs(events): changelog + MODELS + MANIFEST"
```

---

## Self-Review notes

- **Spec coverage (§2):** tables + `files.event_id` → Tasks 1-2; CRUD/cancel → Task 6; list filters (timeWindow, spaceId, hostId, type, status, startsAfter/Before, location km) → Task 6 list handler; RSVP set/withdraw/list + capacity + allowMaybe + closed → Task 7; invites (host-only, idempotent, remove drops RSVP) → Task 8; hosts (add/remove, last-host) → Task 8; image gallery → Task 6; shapers/types → Tasks 3,5; authorization → `requireEventManage` + `canViewEvent` across Tasks 6-8.
- **Decisions wired:** any-host-or-admin manage (`requireEventManage`); capacity caps going-only (`canRsvpGoing`, with self-already-going adjustment); `members` = space-if-spaceId-else-project (`isMemberForEvent`); join table (`event_hosts`); km radius `ST_DWithin`; `coverImageId` → a files row.
- **Security negatives tested:** non-host update 403, non-invitee invite-only 403, guest-list 403, capacity 400, allowMaybe 400, last-host 400, invite-removal revokes access. All in Tasks 6-8.
- **Type consistency:** helper names (`getEventOr404`, `loadHostIds`, `loadRsvpCounts`, `loadLocation`, `buildEventResponse`, `requireEventManage`, `writeLocation`, `isMemberForEvent`, `isInvited`) and policy fns (`canRsvpGoing`, `isEventHost`, `wouldOrphanHosts`, `canViewEvent`) are referenced identically across tasks. Error codes (`events/not-found`, `events/not-host`, `events/capacity-full`, `events/maybe-not-allowed`, `events/rsvp-closed`, `events/guest-list-hidden`, `events/last-host`, `events/not-visible`) are stable.
- **Known follow-ups (non-blocking):** `excludeRemovedSql` isn't extended to `events` (the list handler inlines the removed filter + `shouldHide` covers single reads — acceptable; a future refactor can add `events` to that union). `rsvp_counts` are derived per request (fine for v1; denormalize via trigger if volume grows). `timezone` stored as-is (no IANA validation in v1).
