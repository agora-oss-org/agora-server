# Storage cleanup on content deletion — design

**Date:** 2026-07-03
**Status:** Approved (design); implementation pending
**Problem:** Deleting content that carries uploaded files (entity posts, comments, chat
messages, events) leaves the objects in storage forever. Every delete path is a *soft*
delete (`deleted_at` / `user_deleted_at` stamp — the row survives), so the `files` table's
`ON DELETE CASCADE` never fires, and the `StorageProvider` seam has no delete operation at
all. Result: MinIO/S3 (and Supabase Storage) accumulate orphaned originals + variants.

## Decisions (made with Jenova, 2026-07-03; REVISED same day)

1. **Delete semantics are deployment-configurable**: new env var
   `CONTENT_DELETE_MODE` = `soft` (default) | `hard`, governing **all four**
   file-bearing content types (entities, comments, chat messages, events).
   - **`soft` (default — today's exact behavior):** rows are tombstoned
     (`deleted_at`/`user_deleted_at`) and hidden from reads; **media is LEFT in
     storage** (the content is conceptually recoverable, so its objects must survive).
   - **`hard`:** the row is truly `DELETE`d (FK cascades remove dependents:
     a comment's reply subtree, an entity's comments/reactions/`files` rows) **and the
     storage objects are deleted** — collected BEFORE the row delete (a DB cascade
     cannot reach MinIO/Supabase Storage), removed asynchronously after it.
2. **Timing (hard mode): immediate, best-effort** — object removal is fire-and-forget
   after the row delete; a failure logs (`error` message-only + `debug` with `err`) and
   is accepted (no retry queue, no cron sweep).
3. **Hard-delete key collection must span cascades**: deleting an entity collects the
   entity's own `files` rows AND its comments' `files` rows; deleting a comment collects
   its entire reply subtree's `files` rows (recursive CTE over `comments.parent_id`).
4. **Cleanup is triggered ONLY by author/user deletion.** Explicitly NOT triggered by:
   - **Moderation removal** — removed content is hidden, not destroyed; it must be
     restorable if a moderator/operator reverses the call.
   - **Account deletion** — the established policy is hard-delete-account /
     keep-content; surviving content keeps its media.
5. **All FK references verified cascade-safe** (2026-07-03 audit): every FK onto
   `entities.id`, `comments.id`, `chat_messages.id`, `events.id` is
   `onDelete: "cascade"`; `reports`/notification rows reference targets without FKs and
   simply go stale (same as the pre-existing account-deletion behavior).

## Design

### 1. Storage seam: `remove()`

Add to `StorageProvider` (`apps/api/src/lib/storage/provider.ts`):

```ts
/** Best-effort batch delete of stored objects. Missing keys are not an error. */
remove(keys: string[]): Promise<void>;
```

- **S3 provider** (`storage/s3.ts`): one `DeleteObjectsCommand` per call
  (`{ Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true } }`). S3 caps a batch at
  1000 keys — far above the real-world 4 objects per image (original + 3 variants); the
  helper below never approaches it, but chunk defensively at 1000 anyway.
- **Supabase provider** (`storage/supabase.ts`): `storage.from(bucket).remove(keys)`.
- Both: deleting a nonexistent key is success (idempotent), matching S3/Supabase native
  semantics.

### 2. Env knob (`packages/core/src/lib/env.ts`)

```ts
// Content deletion semantics. soft (default) = tombstone rows (deleted_at /
// user_deleted_at), hide from reads, KEEP media in storage (recoverable). hard = truly
// DELETE the row (FK cascades take dependents) AND delete the media objects.
CONTENT_DELETE_MODE: z.preprocess((v) => (v === "" ? undefined : v),
  z.enum(["soft", "hard"]).default("soft")),
```

Documented in all three `.env.*.example` templates.

### 3. Cleanup helper: `lib/storage-cleanup.ts`

```ts
type FileAssoc =
  | { entityId: string }     // entity's own files + its comments' files
  | { commentId: string }    // the comment's files + its reply subtree's files
  | { chatMessageId: string }
  | { eventId: string };

/** Pure: derive the storage object keys for one files row (original + variants). */
export function fileObjectKeys(row: { projectId: string; originalPath: string; image: unknown }): string[];

/** Load the files rows that the hard delete of `assoc` will cascade away.
 *  MUST be awaited BEFORE the row delete (afterwards the rows are gone). */
export async function collectFileRows(projectId: string, assoc: FileAssoc): Promise<FileRowLike[]>;

/** Fire-and-forget: remove the objects for `rows` from storage. Never throws.
 *  Failure logs error (message-only) + debug ({ err, keys }). No-op on empty. */
export function removeMediaAsync(rows: FileRowLike[], context: string): void;
```

Key derivation (`fileObjectKeys`):
- **Variants:** `image.variants.*.path` — already bare keys
  (e.g. `<projectId>/images/<fileId>/small.png`). Tolerate absent/partial `image`
  json (non-image files, `processingError` rows).
- **Original:** `original_path` stores the full *public URL*
  (e.g. `https://api.example.org/media/<projectId>/images/<fileId>/original.png`).
  Derive the key as the substring starting at `<projectId>/` — every upload key is
  built with a `${projectId}/` prefix (`routes/storage.ts:38`, `lib/images.ts`), and
  this stays correct even if `S3_PUBLIC_URL` changed since upload. If the marker is
  absent (malformed row), skip the original, keep the variants.
- Dedup across rows before the single `getStorage().remove(keys)` call.

Collection (`collectFileRows`):
- `{entityId}` → `files where entity_id = X OR comment_id IN (select id from comments
  where entity_id = X)`.
- `{commentId}` → recursive CTE over `comments.parent_id` rooted at X, then
  `files where comment_id IN (subtree)`.
- `{chatMessageId}` / `{eventId}` → direct column match. All scoped by `project_id`.

### 4. Handler wire-ins (branch on `env.CONTENT_DELETE_MODE`)

| Handler | File | soft (default, unchanged) | hard |
|---|---|---|---|
| `DELETE /entities/:id` | `routes/entities.ts` | stamp `deletedAt` | collect → `db.delete(entities)` → `removeMediaAsync` |
| `DELETE /comments/:id` | `routes/comments.ts` | stamp `deletedAt`+`userDeletedAt` | collect (subtree) → `db.delete(comments)` → `removeMediaAsync` |
| `DELETE /conversations/:id/messages/:messageId` | `routes/chat.ts` | stamp `userDeletedAt` | collect → `db.delete(chatMessages)` → `removeMediaAsync` (socket `message:deleted` emitted in both modes) |
| `DELETE /events/:eventId` | `routes/events.ts` | stamp `deletedAt` | collect → `db.delete(events)` → `removeMediaAsync` |

Notes:
- Media removal happens ONLY in hard mode; soft mode leaves storage untouched
  (Decision 1). Response shapes/status codes are identical in both modes.
- `files` rows need no explicit delete in hard mode — the FK cascade removes them with
  the parent row; `collectFileRows` runs first so the keys survive in memory.
- `files.space_id` exists but spaces have no user-facing delete flow that should destroy
  media today; out of scope (add the same wire-in if/when one appears).
- Account-deletion and moderation paths intentionally do NOT branch (see Decisions).

### 5. Testing

**Unit (`src/lib/storage-cleanup.test.ts`, vitest, no DB):**
- `fileObjectKeys()` against realistic rows (mirror the prod row shape observed
  2026-07-03: full-URL `original_path`, variants with bare `path`): derives original +
  3 variant keys; handles missing `image` json; handles `original_path` without the
  `<projectId>/` marker (skips original, keeps variants); dedups.
- `removeMediaAsync` failure path: a rejecting provider never surfaces (no unhandled
  rejection), logs fire.
- Provider `remove()` (in `storage/index.test.ts`): S3 provider sends one
  `DeleteObjectsCommand` with the right keys (reuse the existing `@aws-sdk/client-s3`
  mock); chunks at 1000; empty key list is a no-op.

**Integration (`test/integration/content-delete.test.ts`):**
- **Hard mode** (`(env as any).CONTENT_DELETE_MODE = "hard"` for the test, restored
  after; test storage provider injected via new `setStorageForTest()` seam in
  `storage/index.ts`): entity with own files + a comment with files → `DELETE` the
  entity → entity/comment/files rows all gone, provider `remove()` received the full
  key set. Same shape for the comment-subtree case.
- **Soft mode (default):** `DELETE` leaves the row (tombstoned), `files` rows intact,
  provider `remove()` NOT called.
- Negative: moderation removal of an entity leaves its `files` rows intact in both
  modes.

### 6. Non-goals / explicitly rejected

- **Cron GC sweep** — immediate-only in hard mode; soft mode keeps media by design.
- **DB triggers / pgmq queue** — no reliable-delivery requirement; keeps infra flat.
- **Deleting objects on moderation removal or account deletion** — see Decisions.
- **Per-request or per-project mode override** — deployment-wide env knob only (YAGNI).

### 7. Operational notes

- `CHANGELOG.md`: entry under `[Unreleased]` → `Added` (`CONTENT_DELETE_MODE` soft|hard
  + hard-mode storage cleanup) when implemented.
- Both providers gain a delete capability for the FIRST time — the S3 bucket policy
  (public **read** only) is unaffected; deletes ride the API's credentialed client.
- Log lines added: `storage: cleaned N objects for <assoc>` at `debug`;
  failure pair at `error`(message-only)/`debug`(with `err`) per the logging policy.
