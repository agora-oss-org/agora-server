# Mentions (Sub-project A) — Design

**Date:** 2026-07-07
**Status:** Draft for review
**Author:** Jenova + Claude
**Scope:** Make the SDK's shipped `@user` / `#space` mention UX work against the server, and harden the mention write path. No new endpoints.

---

## 1. Context & problem

The forked SDK (`../agora-sdk`) already ships the full mention UX:

- `hooks/users/useUserMentions.tsx` (`@`, trigger `@`) → `useFetchUserSuggestions({ query })`
  → `GET /:projectId/users/suggestions?query=<text>` → expects a **bare `User[]`**.
- `hooks/spaces/useSpaceMentions.tsx` (`#`, trigger `#`) → `useFetchManySpaces({ searchAny, limit: 5 })`
  → `GET /:projectId/spaces?searchAny=<text>&limit=5` → expects `{ data, pagination }`.

The mention **tokens** are built client-side from the picked `User`/`Space` and sent in the
`mentions[]` array on entity/comment/message create; the server already stores them (jsonb) and fires
fan-out notifications.

**Three defects make the shipped UX non-functional and the write path unsafe:**

1. **`GET /users/suggestions` ignores `query`** (`routes/users.ts`). It returns top-N profiles by
   reputation regardless of the typed text, so `@jen` never narrows to "jen".
2. **`GET /spaces` ignores `searchAny`** (and `searchName`/`searchSlug`/`searchDescription`,
   `sortBy`, `memberOf`, `include`) (`routes/spaces.ts`). It only honors `parentSpaceId` +
   pagination, so `#dev` returns all root spaces.
3. **`mentions[]` is stored as raw unvalidated jsonb** (`z.array(z.unknown()).nullish()` in
   `packages/contract/src/schemas.ts`) on entity/comment/message create + update. The client's tokens
   go straight to the DB and drive fan-out — so a caller can put a **cross-project or non-existent
   profile id** in `mentions` and trigger a cross-tenant notification (same trust-boundary class as the
   events host/invite bug, commit `da3eab8`).

Additionally, `/users/suggestions` returns a `{ data: [...] }` envelope while the SDK expects a bare
array (`response.data as User[]`, no unwrapping interceptor) — a shape drift. Nothing on the server,
admin, or demo depends on the envelope (verified: only a SQL comment references the route).

## 2. Goals

- `@` autocomplete: `GET /users/suggestions` honors `query`; response shape matches the SDK.
- `#` autocomplete: `GET /spaces` honors its full documented **list** surface.
- Write path: `mentions[]` is validated + resolved server-side before storage and fan-out.
- Docs (MANIFEST/MODELS) document the params; contract types added; tests cover the above.

## 3. Non-goals (explicitly deferred)

- **`spaceReputation` params** (`spaceReputation` object + flat `spaceReputationId` /
  `spaceReputationDescendants`). This is a **separate cross-cutting subsystem** (space-scoped
  reputation with descendant aggregation across ~7 endpoint classes: entities, comments, chat, spaces
  team/members, search, reports, users). It is **not needed for mentions** (`useUserMentions` sends
  only `{ query }`). → **Sub-project B, its own spec/plan.**
- No new mention endpoints, no `@mention` rich-text link rendering (client concern).

---

## 4. Design

### 4.1 `GET /users/suggestions` — the `@` side (`routes/users.ts`)

- **Add optional `query`.** Present → case-insensitive `ILIKE '%query%'` across `username` + `name`
  (mirrors the existing `/search/users` filter in `routes/search.ts`), still excluding the caller,
  ordered by `reputation DESC`. **Absent → unchanged** (top-N by reputation) — preserves the route's
  existing non-mention "who to follow" use.
- **Response shape → bare `User[]`.** Drop the `{ data }` envelope to match `useFetchUserSuggestions`.
  Safe (nothing depends on the envelope).
- Keeps `limit` via `readPagination` default; the mention hook sends no `limit`.

### 4.2 `GET /spaces` — the `#` side, full list surface (`routes/spaces.ts`)

Extend the list handler (still `{ data, pagination }`):

| Param | Behavior |
|---|---|
| `searchAny` | `ILIKE '%q%'` across `name` OR `slug` OR `description` |
| `searchName` / `searchSlug` / `searchDescription` | field-specific `ILIKE '%q%'` |
| `sortBy` | `newest` (default; `createdAt DESC`, current) \| `members` (`members_count DESC`) \| `alphabetical` (`name ASC`) |
| `memberOf=true` | only spaces where the caller is an **active** member (auth required; ignored/omitted otherwise). Literal `true` only. |
| `include=files` | attach the space's `files[]` (batch-load, like other `include` paths) |
| `parentSpaceId`, `page`, `limit` | unchanged |

Search params combine with existing `parentSpaceId` + moderation/visibility filtering already present.

### 4.3 Write-side mention validation — `lib/mentions.ts` (new)

Two functions, one seam:

- **`parseMentionTokens(raw: unknown): Mention[]`** — *pure*. Parse a raw jsonb array into well-formed
  tokens, dropping anything structurally invalid. A user token is `{type:"user", id, foreignId?,
  username}`; a space token is `{type:"space", id, slug}`. Tolerant of the legacy shapes the client
  might send (bare string id, `{id}`), coercing to the union or dropping. **Unit-tested.**
- **`sanitizeMentions(projectId, raw): Promise<Mention[]>`** — *DB-backed*. `parseMentionTokens` →
  batch-check each `user.id` against `profiles` **scoped to `projectId`** and each `space.id` against
  `spaces` (non-deleted, same project) → **drop tokens that don't resolve** → **refresh the display
  fields from the DB row** (user token: `username` + `foreignId`; space token: `slug`) so stored tokens
  are canonical. Returns the cleaned array. **Integration-tested.**

**Applied at:** entity create (`entities.ts:174`) + update (`:264`), comment create (`comments.ts:101`)
+ update (`:201`), chat message create (`chat.ts:374`) + edit (`:407`). Store the sanitized array
instead of `body.mentions`.

**Invalid-token policy: drop silently** (not `400`). Mentions come from autocomplete; a stray or stale
token should not reject an otherwise-valid post. Dropping also means fan-out
(`notifyOnEntityMentions` / `notifyOnComment` via `mentionIds`) can only ever notify validated
in-project users — the cross-project hole closes as a side effect.

### 4.4 Contract & schema (`packages/contract`)

- Export a `Mention` union type + a lenient parse helper if useful; **keep the request `mentions`
  field lenient** (`z.array(z.unknown()).nullish()`) so `sanitizeMentions` remains the single source of
  truth and the write path never 400s on mentions (consistent with drop-silently).
- Add typed query params: `usersSuggestionsQuery` (`{ query?: string }`) and the spaces list filter
  schema (`searchAny`/`searchName`/`searchSlug`/`searchDescription`/`sortBy`/`memberOf`/`include`) —
  parsed in the handlers, rejecting a bad `sortBy` with a clean `400` (mirroring events' enum-filter
  handling).

---

## 5. Data model

`Mention` (already in MODELS.md §Mention, unchanged):

```
{ type: "user",  id: string, foreignId?: string, username: string }
| { type: "space", id: string, slug: string }
```

Stored canonical (server-resolved) in the `mentions` jsonb column on `entities` / `comments` /
`chat_messages`.

## 6. Security considerations

- **Trust boundary:** `sanitizeMentions` runs on the server for every mention write; the stored array
  and all fan-out derive only from validated in-project ids. Closes cross-tenant notification via
  forged mention tokens.
- `memberOf` and `include` on `/spaces` reuse existing space read/visibility gates; no new read path
  bypasses moderation/space-access filtering.
- `query` search is parameterized (Drizzle `ilike`), no interpolation.

## 7. Testing plan

**Unit** (`src/**/*.test.ts`, no DB):
- `parseMentionTokens`: user/space token parsing, legacy-shape coercion, structural drops, dedupe.
- spaces `sortBy` mapping + filter builder (bad `sortBy` → 400).

**Integration** (`test/integration/**`, real PG):
- `@`: `GET /users/suggestions?query=` matches by username AND by name; excludes self; no-query still
  returns reputation-ranked; response is a bare array.
- `#`: `GET /spaces?searchAny=` narrows by name/slug/description; `sortBy=members|alphabetical`;
  `memberOf=true`; `include=files`.
- Write validation: a cross-project user token is dropped (not stored, not notified); a non-existent
  id dropped; a valid token stored with refreshed username; fan-out notifies only the valid mention.

## 8. Docs / propagation

- MANIFEST §users (`/users/suggestions` — `query` param + bare-array shape), §spaces (list filter/sort
  surface).
- MODELS §User / §Space note the search params; §Mention unchanged.
- Run `/propagate` over the branch diff.

## 9. Out of scope → follow-up specs

- **Sub-project B: `spaceReputation`** — space-scoped reputation subsystem (separate spec).
