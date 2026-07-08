# Space-Scoped Reputation (Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a trigger-maintained per-`(user, space)` reputation store — the space-partitioned twin of `profiles.reputation` — plus a read batcher the v7.8.2 enrichment layer calls to populate the SDK's embedded `spaceReputation`.

**Architecture:** A `space_reputation(project_id, space_id, user_id, reputation)` table is upserted forward-only by extending the existing `on_reaction_change()` reaction trigger (resolving each reaction target's space; feed-level/message targets contribute to none). A read batcher `loadSpaceReputations(...)` returns a `userId → number` map, doing a plain PK lookup for a single space and a recursive-CTE subtree rollup when descendants are requested. No backfill, no closure table.

**Tech Stack:** TypeScript, Hono, Drizzle (postgres.js), Postgres (plpgsql triggers + recursive CTE), vitest (unit + real-Postgres integration).

**Spec:** `docs/superpowers/specs/2026-07-07-space-reputation-design.md`

## Global Constraints

- **Server is the trust boundary; parameterize all SQL** through Drizzle `sql` tags with explicit `::uuid` / `::uuid[]` casts — never string-interpolate user input.
- **New table ships its own RLS deny-all** in its creating migration (the `0017` guard does not cover new tables). Pattern verbatim from `0055_push_devices.sql`.
- **Forward-only — NO backfill.** The table starts empty and fills from install onward.
- **Mirror global reputation exactly:** reuse the existing `reaction_reputation(rt)` delta map (upvote +1, downvote −1, like +1, love +2, wow +1, funny +1, sad/angry 0). Negatives allowed. No membership gate. No moderation claw-back.
- **Message-target and feed-level (null-space) reactions contribute to NO space.**
- **Migration numbering:** these continue root's sequence as `0058` (table) and `0059` (trigger), with `when` timestamps `1781934611656` / `1781934611657` (monotonically after root's `0057` = `1781934611655`). ⚠️ If the `feat/sdk-v7.8.2-sync` worktree (which holds `0058`–`0061`) merges first, renumber both to the branch's journal max +1 and bump their `when` strictly above the new journal max **before applying** — a non-monotonic `when` strands later migrations (drizzle-journal-timestamp-skip).
- **Apply migrations with `pnpm db:migrate:run`**, never `db:migrate`.
- **The engine returns a bare `number`;** the embedded `spaceReputation` shape on the User model is owned by the v7.8.2 worktree and wired at merge — not in this plan.
- **Tests:** unit tests are pure/no-DB (`src/**/*.test.ts`); DB-backed behavior is integration (`test/integration/**`, isolated by `project_id`). Security negatives (tenant isolation, message/feed-level exclusion) are first-class cases.
- **Before considering work done:** `pnpm -r typecheck` and `pnpm test` must pass; integration via `pnpm test:integration` (needs `TEST_DATABASE_URL`; prefix `TMPDIR="$HOME/.cache/agora-tmp"`).
- **⚠️ Commits require Jenova's approval.** The commit step in each task is authored per the plan format, but per repo rule NO `git commit` runs without asking first. Raise the per-task-commit question in pre-flight before Task 1 and honor the answer for the run.

## File Structure

- `packages/core/src/db/schema/spaces.ts` — **modify:** add the `spaceReputation` pgTable (source of truth for TS types). Auto-exported via the `index.ts` barrel.
- `apps/api/drizzle/0058_space_reputation.sql` — **create:** table + index + RLS deny-all (hand-authored; `db:generate` is unreliable in this repo).
- `apps/api/drizzle/0059_space_reputation_trigger.sql` — **create:** `content_space_id`, `bump_space_reputation`, `create or replace on_reaction_change()`.
- `apps/api/drizzle/meta/_journal.json` — **modify:** append the two migration entries.
- `apps/api/src/lib/space-reputation.ts` — **create:** `fillReputationMap` (pure) + `loadSpaceReputations` (async batcher).
- `apps/api/src/lib/space-reputation.test.ts` — **create:** unit tests for `fillReputationMap`.
- `apps/api/test/integration/space-reputation.test.ts` — **create:** trigger + read integration tests (built up across Tasks 1–4).
- `CHANGELOG.md` — **modify:** `[Unreleased] / Added` entry (Task 4).

---

### Task 1: `space_reputation` table, schema, and migration

**Files:**
- Modify: `packages/core/src/db/schema/spaces.ts`
- Create: `apps/api/drizzle/0058_space_reputation.sql`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Test: `apps/api/test/integration/space-reputation.test.ts`

**Interfaces:**
- Produces: table `space_reputation(project_id uuid, space_id uuid, user_id uuid, reputation int)`, PK `(project_id, space_id, user_id)` (the trigger's ON CONFLICT target in Task 2), index `space_reputation_user_idx`. Drizzle export `spaceReputation` (`typeof spaceReputation.$inferSelect` used by Task 3).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/space-reputation.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/db/index.js";
import { api, base, createProject, createUser, deleteProject } from "./helpers.js";

/** Read one user's stored self-score for a space (0 when absent). */
async function spaceRep(projectId: string, spaceId: string, userId: string): Promise<number> {
  const rows = await getDb().execute<{ reputation: number }>(sql`
    select reputation from space_reputation
    where project_id = ${projectId}::uuid and space_id = ${spaceId}::uuid and user_id = ${userId}::uuid`);
  const r = [...rows];
  return r.length ? Number(r[0]!.reputation) : 0;
}

/** Count all rows for a project (used to assert "no row written"). */
async function repRowCount(projectId: string): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`
    select count(*)::int n from space_reputation where project_id = ${projectId}::uuid`);
  return Number([...rows][0]!.n);
}

describe("space_reputation table", () => {
  it("exists and upserts on the composite PK (project_id, space_id, user_id)", async () => {
    const projectId = await createProject();
    const user = await createUser(projectId);
    const { body: space } = await api("POST", `${base(projectId)}/spaces`, {
      token: user.token, body: { name: "Rep space" },
    });
    await getDb().execute(sql`insert into space_reputation (project_id, space_id, user_id, reputation)
      values (${projectId}::uuid, ${space.id}::uuid, ${user.id}::uuid, 3)`);
    await getDb().execute(sql`insert into space_reputation (project_id, space_id, user_id, reputation)
      values (${projectId}::uuid, ${space.id}::uuid, ${user.id}::uuid, 2)
      on conflict (project_id, space_id, user_id) do update set reputation = space_reputation.reputation + 2`);
    expect(await spaceRep(projectId, space.id, user.id)).toBe(5);
    await deleteProject(projectId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation`
Expected: FAIL — `relation "space_reputation" does not exist`.

- [ ] **Step 3: Add the Drizzle table to `packages/core/src/db/schema/spaces.ts`**

Add `primaryKey` to the existing `drizzle-orm/pg-core` import, then append after the `spaces`/`spaceMembers` tables:

```ts
// Per-(user, space) reputation — the space-partitioned twin of profiles.reputation.
// Trigger-maintained (see drizzle/0059); composite PK is the upsert conflict target.
export const spaceReputation = pgTable("space_reputation", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  reputation: integer("reputation").notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.spaceId, t.userId] }),
  index("space_reputation_user_idx").on(t.projectId, t.userId),
]);
```

- [ ] **Step 4: Hand-author the migration `apps/api/drizzle/0058_space_reputation.sql`**

```sql
-- apps/api/drizzle/0058_space_reputation.sql
-- Per-(user, space) reputation: the space-partitioned twin of profiles.reputation. Trigger-maintained
-- (see 0059). Composite PK is the upsert conflict target. Idempotent + RLS deny-all (new tables aren't
-- covered by the 0017 guard).
SET search_path TO public, extensions;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "space_reputation" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "space_id"   uuid NOT NULL REFERENCES "spaces"("id")   ON DELETE CASCADE,
  "user_id"    uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "reputation" integer NOT NULL DEFAULT 0,
  CONSTRAINT "space_reputation_pk" PRIMARY KEY ("project_id","space_id","user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_reputation_user_idx" ON "space_reputation" ("project_id","user_id");
--> statement-breakpoint
ALTER TABLE "space_reputation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "deny_all" ON "space_reputation"; CREATE POLICY "deny_all" ON "space_reputation" FOR ALL USING (false) WITH CHECK (false);
```

- [ ] **Step 5: Append the journal entry in `apps/api/drizzle/meta/_journal.json`**

Add to the `entries` array, after the `0057` entry:

```json
{
  "idx": 58,
  "version": "7",
  "when": 1781934611656,
  "tag": "0058_space_reputation",
  "breakpoints": true
}
```

- [ ] **Step 6: Build core, apply the migration, run the test to verify it passes**

Run:
```bash
pnpm --filter @agora/core build
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation
```
Expected: PASS (globalSetup applies the new migration on first run). If the test DB was already migrated, run `pnpm --filter @agora/api db:migrate:run` against `TEST_DATABASE_URL` first.

- [ ] **Step 7: Typecheck and commit** *(commit only with approval — see Global Constraints)*

```bash
pnpm -r typecheck
git add packages/core/src/db/schema/spaces.ts apps/api/drizzle/0058_space_reputation.sql \
  apps/api/drizzle/meta/_journal.json apps/api/test/integration/space-reputation.test.ts
git commit -m "feat(reputation): add space_reputation table + RLS"
```

---

### Task 2: Maintain the store from the reaction trigger

**Files:**
- Create: `apps/api/drizzle/0059_space_reputation_trigger.sql`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Test: `apps/api/test/integration/space-reputation.test.ts`

**Interfaces:**
- Consumes: `space_reputation` table (Task 1); existing `reaction_reputation(rt)`, `reaction_author(target, id)`, `bump_reaction_count(...)` (migration `0002`); `reactions` columns `project_id, target_type, target_id, user_id, reaction_type`.
- Produces: SQL functions `content_space_id(reaction_target, uuid) → uuid`, `bump_space_reputation(uuid, reaction_target, uuid, uuid, int) → void`, and a `create or replace`d `on_reaction_change()` that also maintains `space_reputation`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/integration/space-reputation.test.ts`:

```ts
describe("space_reputation trigger maintenance", () => {
  async function setup() {
    const projectId = await createProject();
    const author = await createUser(projectId);
    const reactor = await createUser(projectId);
    return { projectId, author, reactor };
  }
  async function makeSpacedEntity(projectId: string, token: string, spaceId?: string) {
    const { body: entity } = await api("POST", `${base(projectId)}/entities`, {
      token, body: { title: "t", ...(spaceId ? { spaceId } : {}) },
    });
    return entity;
  }
  async function makeSpace(projectId: string, token: string, parentSpaceId?: string) {
    const { body: space } = await api("POST", `${base(projectId)}/spaces`, {
      token, body: { name: `S_${randomUUID().slice(0, 6)}`, ...(parentSpaceId ? { parentSpaceId } : {}) },
    });
    return space;
  }

  it("credits the author's (space, user) row when their spaced entity is reacted to", async () => {
    const { projectId, author, reactor } = await setup();
    const space = await makeSpace(projectId, author.token);
    const entity = await makeSpacedEntity(projectId, author.token, space.id);
    await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`,
      { token: reactor.token, body: { reactionType: "upvote" } });
    expect(await spaceRep(projectId, space.id, author.id)).toBe(1);
    await deleteProject(projectId);
  });

  it("attributes a comment reaction to the comment's ROOT entity's space", async () => {
    const { projectId, author, reactor } = await setup();
    const space = await makeSpace(projectId, author.token);
    const entity = await makeSpacedEntity(projectId, author.token, space.id);
    const { body: comment } = await api("POST", `${base(projectId)}/comments`,
      { token: author.token, body: { entityId: entity.id, content: "c" } });
    await api("POST", `${base(projectId)}/comments/${comment.id}/reactions`,
      { token: reactor.token, body: { reactionType: "like" } });
    expect(await spaceRep(projectId, space.id, author.id)).toBe(1); // like = +1, keyed by the entity's space
    await deleteProject(projectId);
  });

  it("writes no row for a feed-level (null-space) entity", async () => {
    const { projectId, author, reactor } = await setup();
    const entity = await makeSpacedEntity(projectId, author.token); // no spaceId
    await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`,
      { token: reactor.token, body: { reactionType: "upvote" } });
    expect(await repRowCount(projectId)).toBe(0);
    await deleteProject(projectId);
  });

  it("writes no row for a message-target reaction", async () => {
    const { projectId, reactor } = await setup();
    await getDb().execute(sql`insert into reactions (project_id, target_type, target_id, user_id, reaction_type)
      values (${projectId}::uuid, 'message', ${randomUUID()}::uuid, ${reactor.id}::uuid, 'like')`);
    expect(await repRowCount(projectId)).toBe(0);
    await deleteProject(projectId);
  });

  it("applies the reaction delta map (love = +2)", async () => {
    const { projectId, author, reactor } = await setup();
    const space = await makeSpace(projectId, author.token);
    const entity = await makeSpacedEntity(projectId, author.token, space.id);
    await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`,
      { token: reactor.token, body: { reactionType: "love" } });
    expect(await spaceRep(projectId, space.id, author.id)).toBe(2);
    await deleteProject(projectId);
  });

  it("allows the score to go negative on a downvote", async () => {
    const { projectId, author, reactor } = await setup();
    const space = await makeSpace(projectId, author.token);
    const entity = await makeSpacedEntity(projectId, author.token, space.id);
    await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`,
      { token: reactor.token, body: { reactionType: "downvote" } });
    expect(await spaceRep(projectId, space.id, author.id)).toBe(-1);
    await deleteProject(projectId);
  });

  it("applies the net delta on a reaction type change (upvote → love)", async () => {
    const { projectId, author, reactor } = await setup();
    const space = await makeSpace(projectId, author.token);
    const entity = await makeSpacedEntity(projectId, author.token, space.id);
    const url = `${base(projectId)}/entities/${entity.id}/reactions`;
    await api("POST", url, { token: reactor.token, body: { reactionType: "upvote" } }); // +1
    await api("POST", url, { token: reactor.token, body: { reactionType: "love" } });   // switch → +2 total
    expect(await spaceRep(projectId, space.id, author.id)).toBe(2);
    await deleteProject(projectId);
  });

  it("subtracts the delta when a reaction is removed", async () => {
    const { projectId, author, reactor } = await setup();
    const space = await makeSpace(projectId, author.token);
    const entity = await makeSpacedEntity(projectId, author.token, space.id);
    const url = `${base(projectId)}/entities/${entity.id}/reactions`;
    await api("POST", url, { token: reactor.token, body: { reactionType: "like" } }); // +1
    await api("POST", url, { token: reactor.token, body: { reactionType: "like" } }); // toggle off → 0
    expect(await spaceRep(projectId, space.id, author.id)).toBe(0);
    await deleteProject(projectId);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation`
Expected: FAIL — the reaction fires the old trigger, `space_reputation` stays empty, `spaceRep` returns `0` where a bump is expected.

*(Note: `POST /spaces` is `requireAuth`-only and the creator auto-joins as `admin`, so a plain `visitor` token both creates spaces and posts entities into them; subspace creation requires admin on the parent, which the author always is. No special role needed in `setup()`.)*

- [ ] **Step 3: Hand-author `apps/api/drizzle/0059_space_reputation_trigger.sql`**

```sql
-- apps/api/drizzle/0059_space_reputation_trigger.sql
-- Maintain space_reputation from the reaction trigger. Resolves the space a reaction target lives in
-- (entity → its space_id; comment → its ROOT entity's space_id; message/feed-level → null = no space),
-- and upserts the author's per-space score alongside the existing global profiles.reputation bump.
-- Idempotent (create or replace); the 0002 trigger already points at on_reaction_change().
SET search_path TO public, extensions;
--> statement-breakpoint
create or replace function content_space_id(p_target reaction_target, p_id uuid)
returns uuid language sql stable as $$
  select case
    when p_target = 'entity'  then (select space_id from entities where id = p_id)
    when p_target = 'comment' then (select e.space_id from comments c
                                      join entities e on e.id = c.entity_id
                                      where c.id = p_id)
    else null
  end $$;
--> statement-breakpoint
create or replace function bump_space_reputation(
  p_project uuid, p_target reaction_target, p_id uuid, p_author uuid, p_delta int
) returns void language plpgsql as $$
declare sid uuid;
begin
  if p_author is null or p_delta = 0 then return; end if;
  sid := content_space_id(p_target, p_id);
  if sid is null then return; end if;
  insert into space_reputation (project_id, space_id, user_id, reputation)
    values (p_project, sid, p_author, p_delta)
  on conflict (project_id, space_id, user_id)
    do update set reputation = space_reputation.reputation + p_delta;
end $$;
--> statement-breakpoint
create or replace function on_reaction_change() returns trigger language plpgsql as $$
declare author uuid;
begin
  if (tg_op = 'INSERT') then
    perform bump_reaction_count(new.target_type, new.target_id, new.reaction_type, 1);
    author := reaction_author(new.target_type, new.target_id);
    if author is not null then
      update profiles set reputation = reputation + reaction_reputation(new.reaction_type) where id = author;
      perform bump_space_reputation(new.project_id, new.target_type, new.target_id, author,
                                    reaction_reputation(new.reaction_type));
    end if;
  elsif (tg_op = 'DELETE') then
    perform bump_reaction_count(old.target_type, old.target_id, old.reaction_type, -1);
    author := reaction_author(old.target_type, old.target_id);
    if author is not null then
      update profiles set reputation = reputation - reaction_reputation(old.reaction_type) where id = author;
      perform bump_space_reputation(old.project_id, old.target_type, old.target_id, author,
                                    -reaction_reputation(old.reaction_type));
    end if;
  elsif (tg_op = 'UPDATE' and new.reaction_type <> old.reaction_type) then
    perform bump_reaction_count(old.target_type, old.target_id, old.reaction_type, -1);
    perform bump_reaction_count(new.target_type, new.target_id, new.reaction_type, 1);
    author := reaction_author(new.target_type, new.target_id);
    if author is not null then
      update profiles set reputation = reputation
        - reaction_reputation(old.reaction_type) + reaction_reputation(new.reaction_type)
      where id = author;
      perform bump_space_reputation(new.project_id, new.target_type, new.target_id, author,
                                    reaction_reputation(new.reaction_type) - reaction_reputation(old.reaction_type));
    end if;
  end if;
  return null;
end $$;
```

- [ ] **Step 4: Append the journal entry in `apps/api/drizzle/meta/_journal.json`**

After the `0058` entry:

```json
{
  "idx": 59,
  "version": "7",
  "when": 1781934611657,
  "tag": "0059_space_reputation_trigger",
  "breakpoints": true
}
```

- [ ] **Step 5: Apply the migration and run the tests to verify they pass**

Run:
```bash
pnpm --filter @agora/api db:migrate:run
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation
```
Expected: PASS (all trigger-maintenance cases green; Task 1's table test still green).

- [ ] **Step 6: Typecheck and commit** *(commit only with approval)*

```bash
pnpm -r typecheck
git add apps/api/drizzle/0059_space_reputation_trigger.sql apps/api/drizzle/meta/_journal.json \
  apps/api/test/integration/space-reputation.test.ts
git commit -m "feat(reputation): maintain space_reputation from the reaction trigger"
```

---

### Task 3: Read batcher — single space + pure map-fill

**Files:**
- Create: `apps/api/src/lib/space-reputation.ts`
- Create: `apps/api/src/lib/space-reputation.test.ts`
- Test: `apps/api/test/integration/space-reputation.test.ts`

**Interfaces:**
- Consumes: `space_reputation` table + trigger (Tasks 1–2); `getDb()` from `../db/index.js`.
- Produces:
  - `fillReputationMap(rows: { userId: string; reputation: number }[], userIds: string[]): Map<string, number>` — pure; every requested id present, absent ids `0`.
  - `loadSpaceReputations(projectId: string, spaceId: string, includeDescendants: boolean, userIds: string[]): Promise<Map<string, number>>` — the descendant branch is stubbed in this task (Task 4 fills it).

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/lib/space-reputation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fillReputationMap } from "./space-reputation.js";

describe("fillReputationMap", () => {
  it("defaults every requested id to 0", () => {
    expect(fillReputationMap([], ["a", "b"])).toEqual(new Map([["a", 0], ["b", 0]]));
  });
  it("fills present rows and leaves absent ids at 0", () => {
    const m = fillReputationMap([{ userId: "a", reputation: 5 }], ["a", "b"]);
    expect(m.get("a")).toBe(5);
    expect(m.get("b")).toBe(0);
  });
  it("ignores rows for ids that were not requested", () => {
    const m = fillReputationMap([{ userId: "z", reputation: 9 }], ["a"]);
    expect(m.has("z")).toBe(false);
    expect(m.get("a")).toBe(0);
  });
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `pnpm --filter @agora/api test -- space-reputation`
Expected: FAIL — cannot resolve `./space-reputation.js` / `fillReputationMap` not exported.

- [ ] **Step 3: Create `apps/api/src/lib/space-reputation.ts`**

```ts
import { sql } from "drizzle-orm";
import { getDb } from "../db/index.js";

/** Fill a userId → reputation map from raw rows, defaulting every requested id to 0. Pure. */
export function fillReputationMap(
  rows: { userId: string; reputation: number }[],
  userIds: string[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const id of userIds) map.set(id, 0);
  for (const r of rows) if (map.has(r.userId)) map.set(r.userId, r.reputation);
  return map;
}

/**
 * Batch-load per-space reputation for a set of users. Returns a map with EVERY requested id present
 * (absent → 0). `includeDescendants` rolls the score up over the space's subtree (Task 4).
 */
export async function loadSpaceReputations(
  projectId: string,
  spaceId: string,
  includeDescendants: boolean,
  userIds: string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  if (includeDescendants) {
    // Filled in Task 4.
    throw new Error("descendant rollup not yet implemented");
  }
  const rows = await getDb().execute<{ user_id: string; reputation: number }>(sql`
    select user_id, reputation from space_reputation
    where project_id = ${projectId}::uuid and space_id = ${spaceId}::uuid
      and user_id = any(${ids}::uuid[])`);
  return fillReputationMap(
    [...rows].map((r) => ({ userId: r.user_id, reputation: Number(r.reputation) })),
    ids,
  );
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm --filter @agora/api test -- space-reputation`
Expected: PASS (3/3).

- [ ] **Step 5: Write the failing integration test (descendants=false)**

Append to `apps/api/test/integration/space-reputation.test.ts` (add the import at the top:
`import { loadSpaceReputations } from "../../src/lib/space-reputation.js";`):

```ts
describe("loadSpaceReputations (single space)", () => {
  it("returns the space's own score and 0 for users with no activity", async () => {
    const projectId = await createProject();
    const author = await createUser(projectId);
    const reactor = await createUser(projectId);
    const { body: space } = await api("POST", `${base(projectId)}/spaces`,
      { token: author.token, body: { name: "Solo" } });
    const { body: entity } = await api("POST", `${base(projectId)}/entities`,
      { token: author.token, body: { title: "t", spaceId: space.id } });
    await api("POST", `${base(projectId)}/entities/${entity.id}/reactions`,
      { token: reactor.token, body: { reactionType: "upvote" } });

    const m = await loadSpaceReputations(projectId, space.id, false, [author.id, reactor.id]);
    expect(m.get(author.id)).toBe(1);
    expect(m.get(reactor.id)).toBe(0); // present, zero — never undefined
    await deleteProject(projectId);
  });

  it("returns an empty map for an empty user list", async () => {
    const projectId = await createProject();
    const author = await createUser(projectId);
    const { body: space } = await api("POST", `${base(projectId)}/spaces`,
      { token: author.token, body: { name: "Empty" } });
    expect((await loadSpaceReputations(projectId, space.id, false, [])).size).toBe(0);
    await deleteProject(projectId);
  });
});
```

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation`
Expected: PASS (single-space read cases green; earlier suites still green).

- [ ] **Step 7: Typecheck and commit** *(commit only with approval)*

```bash
pnpm -r typecheck
git add apps/api/src/lib/space-reputation.ts apps/api/src/lib/space-reputation.test.ts \
  apps/api/test/integration/space-reputation.test.ts
git commit -m "feat(reputation): loadSpaceReputations single-space read + map-fill"
```

---

### Task 4: Descendant rollup (recursive CTE) + changelog

**Files:**
- Modify: `apps/api/src/lib/space-reputation.ts`
- Test: `apps/api/test/integration/space-reputation.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `loadSpaceReputations(..., includeDescendants=true, ...)` sums the score across the space's subtree, scoped by `project_id` at every level.

- [ ] **Step 1: Write the failing integration tests**

Append to `apps/api/test/integration/space-reputation.test.ts`:

```ts
describe("loadSpaceReputations (descendant rollup)", () => {
  it("sums parent + child + grandchild, excludes siblings", async () => {
    const projectId = await createProject();
    const author = await createUser(projectId);
    const reactor = await createUser(projectId);
    const mk = async (parentSpaceId?: string) =>
      (await api("POST", `${base(projectId)}/spaces`,
        { token: author.token, body: { name: `S_${randomUUID().slice(0, 6)}`, ...(parentSpaceId ? { parentSpaceId } : {}) } })).body;

    const parent = await mk();
    const child = await mk(parent.id);
    const grandchild = await mk(child.id);
    const sibling = await mk(); // top-level, NOT under parent

    for (const s of [parent, child, grandchild, sibling]) {
      const { body: e } = await api("POST", `${base(projectId)}/entities`,
        { token: author.token, body: { title: "t", spaceId: s.id } });
      await api("POST", `${base(projectId)}/entities/${e.id}/reactions`,
        { token: reactor.token, body: { reactionType: "upvote" } }); // +1 each
    }

    const rolled = await loadSpaceReputations(projectId, parent.id, true, [author.id]);
    expect(rolled.get(author.id)).toBe(3); // parent + child + grandchild, sibling excluded

    const self = await loadSpaceReputations(projectId, parent.id, false, [author.id]);
    expect(self.get(author.id)).toBe(1); // parent only
    await deleteProject(projectId);
  });

  it("does not bleed across projects (tenant isolation)", async () => {
    const a = await createProject();
    const b = await createProject();
    const authorA = await createUser(a);
    const reactorA = await createUser(a);
    const { body: spaceA } = await api("POST", `${base(a)}/spaces`, { token: authorA.token, body: { name: "A" } });
    const { body: entA } = await api("POST", `${base(a)}/entities`, { token: authorA.token, body: { title: "t", spaceId: spaceA.id } });
    await api("POST", `${base(a)}/entities/${entA.id}/reactions`, { token: reactorA.token, body: { reactionType: "upvote" } });

    // Query project B for the same user id — must see nothing from A.
    const m = await loadSpaceReputations(b, spaceA.id, true, [authorA.id]);
    expect(m.get(authorA.id)).toBe(0);
    await deleteProject(a);
    await deleteProject(b);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation`
Expected: FAIL — `descendant rollup not yet implemented` thrown from the `includeDescendants` branch.

- [ ] **Step 3: Implement the recursive-CTE branch in `apps/api/src/lib/space-reputation.ts`**

Replace the `if (includeDescendants) { throw ... }` block with:

```ts
  if (includeDescendants) {
    const rows = await getDb().execute<{ user_id: string; reputation: number }>(sql`
      with recursive subtree as (
        select id from spaces where id = ${spaceId}::uuid and project_id = ${projectId}::uuid
        union all
        select s.id from spaces s
          join subtree t on s.parent_space_id = t.id
        where s.project_id = ${projectId}::uuid
      )
      select sr.user_id, sum(sr.reputation)::int as reputation
      from space_reputation sr
      where sr.project_id = ${projectId}::uuid
        and sr.space_id in (select id from subtree)
        and sr.user_id = any(${ids}::uuid[])
      group by sr.user_id`);
    return fillReputationMap(
      [...rows].map((r) => ({ userId: r.user_id, reputation: Number(r.reputation) })),
      ids,
    );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation`
Expected: PASS (rollup + isolation green; whole file green).

- [ ] **Step 5: Add the changelog entry to `CHANGELOG.md`**

Under `## [Unreleased]` → `### Added` (create the section if absent):

```markdown
### Added
- Space-scoped reputation: a trigger-maintained `space_reputation` store (the space-partitioned twin of `profiles.reputation`) plus a `loadSpaceReputations` read batcher with recursive-CTE descendant rollup. Maintained forward-only; feed-level and message reactions contribute to no space. This is the engine behind the SDK v7.8.2 space-reputation enrichment (wire contract owned by that branch).
```

- [ ] **Step 6: Full typecheck + unit + integration, then commit** *(commit only with approval)*

Run:
```bash
pnpm -r typecheck
pnpm --filter @agora/api test -- space-reputation
TMPDIR="$HOME/.cache/agora-tmp" pnpm --filter @agora/api exec vitest run -c vitest.integration.config.ts space-reputation
```
Expected: all green.

```bash
git add apps/api/src/lib/space-reputation.ts apps/api/test/integration/space-reputation.test.ts CHANGELOG.md
git commit -m "feat(reputation): descendant rollup via recursive CTE + changelog"
```

---

## Post-implementation (not tasks — coordination)

- **Merge seam with `feat/sdk-v7.8.2-sync`:** once both branches meet, wire the worktree's enrichment shaper to call `loadSpaceReputations(...)` and attach the number to the User's embedded `spaceReputation` field (scalar vs object — match the worktree's contract type). Renumber migrations `0058`/`0059` if the worktree merged first (Global Constraints).
- **Propagation check:** run `pnpm check:propagation` — a new table + trigger may have doc mirrors (schema docs, MODELS.md if the field surfaces). The embedded-field docs belong to the worktree; this branch documents only the store.
