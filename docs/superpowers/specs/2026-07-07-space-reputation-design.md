# Space-Scoped Reputation (Engine) — Design

**Date:** 2026-07-07
**Status:** Design — approved decisions, pending spec review
**Sub-project:** B (deferred from the mentions sub-project)
**Feature slug:** `space-reputation`

## 1. Summary

Add a per-`(user, space)` reputation score — the space-partitioned twin of the existing
global `profiles.reputation`. This is the **engine** behind the SDK v7.8.2 "space-reputation
enrichment" wire feature (#6): the query params, validation, and embedded response shape are
owned by the `feat/sdk-v7.8.2-sync` worktree; **this spec owns only the store, its maintenance,
and the read path that produces the number.**

A user's reputation *in a space* is the reaction score of the content they authored that lives
in that space, maintained forward-only by extending the existing reaction trigger. Descendant
aggregation (`spaceReputationDescendants=true`) is computed at read time via a recursive CTE over
the space hierarchy — no closure table, no denormalized rollup.

## 2. Scope

### In scope
- New `space_reputation` table (Drizzle schema + generated migration + RLS deny-all).
- Extending `on_reaction_change()` to maintain the per-space score alongside the global one.
- A read/enrichment batcher `loadSpaceReputations(...)` including the recursive-CTE descendant
  rollup.
- Unit + integration tests for all of the above.

### Explicitly out of scope (owned elsewhere)
- **Wire contract (v7.8.2 worktree, feature #6):** parsing `spaceReputationId`
  (`uuid | "none" | "context"`) and `spaceReputationDescendants`, resolving `"context"` → a
  concrete `spaceId`, the `context`→400-on-`/users/*` rule, and the embedded `spaceReputation`
  field on the User model. This spec **consumes** that contract; it does not redesign it.
- **No backfill.** The table starts empty and fills from install forward.
- Any new reputation *source* beyond reactions (membership, role, moderation grants) — the
  space score mirrors global reputation exactly.

## 3. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| What counts | Reactions on content the user authored **in** the space | Faithful space-partitioned twin of global reputation |
| Storage | Trigger-maintained `space_reputation` table | Matches existing denormalized-count convention; reads stay a lookup on 7 hot paths |
| Descendant rollup | Recursive CTE **at read**, self-score stored only | Zero write-path hierarchy maintenance; opt-in read cost; re-parenting is free |
| Backfill | **None** — forward-only | Simpler migration (chosen over day-one-correctness) |
| Negatives | Allowed (downvote −1, same delta map as global) | Mirror global |
| Membership | Not required to earn reputation | Mirror global |
| Moderation | No reputation claw-back on content removal | The global trigger doesn't claw back either |
| Message reactions | Contribute to **no** space | Chat messages belong to conversations, not spaces |

## 4. Data model

New table, single source of truth in `packages/core/src/db/schema/` (Drizzle), then a generated
migration for the table DDL and a **custom SQL migration** for the trigger changes + RLS.

```
space_reputation
  project_id  uuid    not null
  space_id    uuid    not null   references spaces(id)   on delete cascade
  user_id     uuid    not null   references profiles(id) on delete cascade
  reputation  integer not null default 0
  primary key (project_id, space_id, user_id)
  index space_reputation_user_idx on (project_id, user_id)
```

- The composite PK covers the `descendants=false` lookup (`project_id, space_id, user_id`) and
  the descendant SUM (`project_id, space_id IN (...)`, grouped by `user_id`).
- `space_reputation_user_idx` covers the reverse path (one user across many spaces), should a
  future caller need it; cheap insurance.
- **RLS:** the creating migration MUST ship an explicit deny-all — new tables are not covered
  retroactively by the `0017` enablement guard (per CLAUDE.md / precedent `auth_credentials`,
  `project_roles`).

### Migration numbering caveat
The `feat/sdk-v7.8.2-sync` worktree already uses migrations `0058`–`0061`. This engine's
migrations must be numbered **after** whatever the branch's journal max is at implementation time,
with a `when` timestamp strictly greater than the current journal max (per the
drizzle-journal-timestamp-skip gotcha — a non-monotonic `when` strands later migrations). Assign
concrete numbers when the branch is cut, not now.

## 5. Maintenance — extending `on_reaction_change()`

The existing trigger (`apps/api/drizzle/0002_triggers.sql`) already, per reaction INSERT/DELETE/
UPDATE, resolves the content author via `reaction_author(target_type, target_id)` and bumps
`profiles.reputation` by `reaction_reputation(reaction_type)`. We extend it to **also** upsert the
per-space row, resolving the space the content lives in.

### New helper: `content_space_id`
Resolves the space a reaction target belongs to (or `null` — meaning "counts toward no space"):

```sql
create or replace function content_space_id(p_target reaction_target, p_id uuid)
returns uuid language sql stable as $$
  select case
    when p_target = 'entity'  then (select space_id from entities where id = p_id)
    when p_target = 'comment' then (select e.space_id
                                      from comments c
                                      join entities e on e.id = c.entity_id
                                      where c.id = p_id)
    else null   -- message (or any future target) contributes to no space
  end $$;
```

- **Entity** → its own `space_id` (nullable; feed-level content resolves to `null`).
- **Comment** → its **root entity's** `space_id` (comments have no `space_id` column).
- **Anything else** (e.g. `message`) → `null`.

### New helper: `bump_space_reputation`
```sql
create or replace function bump_space_reputation(
  p_project uuid, p_target reaction_target, p_id uuid, p_author uuid, p_delta int
) returns void language plpgsql as $$
declare sid uuid;
begin
  if p_author is null or p_delta = 0 then return; end if;
  sid := content_space_id(p_target, p_id);
  if sid is null then return; end if;   -- feed-level / non-spaced content
  insert into space_reputation (project_id, space_id, user_id, reputation)
    values (p_project, sid, p_author, p_delta)
  on conflict (project_id, space_id, user_id)
    do update set reputation = space_reputation.reputation + p_delta;
end $$;
```

### Wiring into `on_reaction_change()`
Add a `bump_space_reputation(...)` call in each branch, immediately after the existing
`profiles.reputation` update, reusing the already-resolved `author` and the same
`reaction_reputation(...)` delta. `project_id` comes off the reaction row (`new`/`old`).

- **INSERT:** `bump_space_reputation(new.project_id, new.target_type, new.target_id, author, reaction_reputation(new.reaction_type));`
- **DELETE:** `bump_space_reputation(old.project_id, old.target_type, old.target_id, author, -reaction_reputation(old.reaction_type));`
- **UPDATE** (reaction_type changed): a single call with the net delta
  `reaction_reputation(new.reaction_type) - reaction_reputation(old.reaction_type)` (target/author
  are unchanged on a type-change update, mirroring how the global branch handles it).

The migration is a `create or replace` of `on_reaction_change()` plus the two new helper
functions — idempotent, no trigger re-creation needed (the trigger already points at the function).

### Note on non-reversal
Because maintenance is purely reaction-driven, deleting or removing an author's content does **not**
subtract the reputation it earned — identical to the global trigger's behavior. Accepted per §3.

## 6. Read path — `loadSpaceReputations`

A batcher mirroring `loadUsers` (`lib/shape.ts`), living in `apps/api/src/lib/space-reputation.ts`.
This is the single seam the v7.8.2 shape layer calls once it has resolved `(spaceId,
includeDescendants, userIds)`.

```ts
// apps/api/src/lib/space-reputation.ts
export async function loadSpaceReputations(
  projectId: string,
  spaceId: string,
  includeDescendants: boolean,
  userIds: string[],
): Promise<Map<string /* userId */, number>>;
```

- Returns a map from `userId` → reputation. **Every** requested `userId` is present in the map;
  users with no stored row map to `0` (callers never have to null-check).
- Empty `userIds` → empty map, no query.

### `includeDescendants = false`
Plain indexed lookup:
```sql
select user_id, reputation
from space_reputation
where project_id = $1 and space_id = $2 and user_id = any($3::uuid[])
```

### `includeDescendants = true`
Recursive CTE gathers the subtree of `spaceId` (inclusive), then sums:
```sql
with recursive subtree as (
  select id from spaces where id = $2 and project_id = $1
  union all
  select s.id from spaces s
    join subtree t on s.parent_space_id = t.id
  where s.project_id = $1
)
select sr.user_id, sum(sr.reputation)::int as reputation
from space_reputation sr
where sr.project_id = $1
  and sr.space_id in (select id from subtree)
  and sr.user_id = any($3::uuid[])
group by sr.user_id
```

- Bounded by tree depth (shallow per the `depth` column). Paid only when the caller opts in.
- `project_id` is applied at every level of the walk — no cross-tenant leakage.
- Parameterized via Drizzle `sql` tags with explicit casts (`::uuid[]`), never string-interpolated
  (per the security posture).

### Integration seam (the one thing both branches must agree on at merge)
The v7.8.2 worktree defines the embedded shape on the User model (scalar `number` vs an object like
`{ spaceId, reputation }`). This engine returns the **number**; the worktree's shaper decides how to
attach it. **Before implementation, read the worktree's contract type for `spaceReputation` and pin
the shaper call to match.** This is the single reconciliation point between the two branches; the
engine's signature above is stable regardless of which shape wins.

## 7. Testing

### Unit (`apps/api/src/lib/space-reputation.test.ts`, no DB)
Factor the query-building / map-fill logic so the pure parts test without Postgres:
- Empty `userIds` → empty map, no query issued.
- Map-fill: given raw `[{userId, reputation}]` rows and a requested id set, every requested id is
  present; missing ids default to `0`; extra rows are ignored.

### Integration (`apps/api/test/integration/space-reputation.test.ts`, real PG, isolated by `project_id`)
Trigger + read correctness end-to-end:
1. **Entity attribution:** react (upvote) to a spaced entity → the author's `(space, user)` row = +1.
2. **Comment attribution:** react to a comment → attributed to the **root entity's** space, not to
   any space of its own.
3. **Feed-level content:** react to an entity with `space_id = null` → **no** `space_reputation`
   row written.
4. **Message reactions:** a `message`-target reaction writes **no** `space_reputation` row.
5. **Delta map:** `love` adds +2, `downvote` drives the row **negative**; a reaction-type change
   applies the net delta; a reaction delete subtracts.
6. **Descendants=false:** returns only the space's own score.
7. **Descendants=true:** parent space + one child space sum; a grandchild also included (multi-level
   walk); a sibling/unrelated space excluded.
8. **Zero default:** a user with no activity in the space reads `0` from `loadSpaceReputations`.
9. **Tenant isolation:** an identical `(space_id, user_id)` under a different `project_id` never
   bleeds into the result.

Security-relevant negatives (tenant isolation, message/feed-level exclusion) are first-class test
cases, not afterthoughts.

## 8. Files

- **Modify** `packages/core/src/db/schema/` — add the `space_reputation` table (new schema file or
  the existing spaces-adjacent module, following local convention).
- **Create** generated migration — `space_reputation` table DDL.
- **Create** custom SQL migration — `content_space_id`, `bump_space_reputation`,
  `create or replace on_reaction_change()`, and the table's RLS deny-all. (Numbered after the
  branch's journal max — see §4 caveat.)
- **Create** `apps/api/src/lib/space-reputation.ts` — `loadSpaceReputations`.
- **Create** `apps/api/src/lib/space-reputation.test.ts` — unit tests.
- **Create** `apps/api/test/integration/space-reputation.test.ts` — integration tests.
- **Update** `CHANGELOG.md` (`[Unreleased] / Added`) — new space-scoped reputation store + read path.

## 9. Open items / dependencies
- **Merge coordination with `feat/sdk-v7.8.2-sync`:** the worktree provides the param plumbing and
  the embedded-shape decision (§6 seam). This engine can be designed and built independently, but
  the shaper wiring lands only once both branches meet. Confirm the embedded `spaceReputation` shape
  from the worktree before wiring the call site.
- **Concrete migration numbers/timestamps** assigned at branch-cut time (§4).
