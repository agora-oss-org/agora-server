# Storage cleanup on content deletion — design

**Date:** 2026-07-03
**Status:** Approved (design); implementation pending
**Problem:** Deleting content that carries uploaded files (entity posts, comments, chat
messages, events) leaves the objects in storage forever. Every delete path is a *soft*
delete (`deleted_at` / `user_deleted_at` stamp — the row survives), so the `files` table's
`ON DELETE CASCADE` never fires, and the `StorageProvider` seam has no delete operation at
all. Result: MinIO/S3 (and Supabase Storage) accumulate orphaned originals + variants.

## Decisions (made with Jenova, 2026-07-03)

1. **Scope: all file-bearing content** — one generic mechanism keyed off the `files`
   table, wired into every content-delete handler (entities, comments, chat messages,
   events). Not entity-only.
2. **Timing: immediate, best-effort** — objects are deleted when the user deletes the
   content, asynchronously (fire-and-forget), no grace period, no retry queue, no cron
   sweep. A failed cleanup logs and leaves the `files` row as the breadcrumb.
3. **Cleanup is triggered ONLY by author/user deletion.** Explicitly NOT triggered by:
   - **Moderation removal** — removed content is hidden, not destroyed; it must be
     restorable if a moderator/operator reverses the call.
   - **Account deletion** — the established policy is hard-delete-account /
     keep-content; surviving content keeps its media.

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

### 2. Cleanup helper: `lib/storage-cleanup.ts`

```ts
type FileAssoc =
  | { entityId: string }
  | { commentId: string }
  | { chatMessageId: string }
  | { eventId: string };

/** Load the files rows for `assoc`, delete their storage objects, then delete the rows.
 *  Throws nothing; failures log and keep the rows. */
export async function cleanupFilesFor(projectId: string, assoc: FileAssoc): Promise<void>;

/** Fire-and-forget wrapper for delete handlers (mirrors indexEntityAsync). */
export function cleanupFilesAsync(projectId: string, assoc: FileAssoc): void;
```

Behavior of `cleanupFilesFor`:

1. `select` the `files` rows matching `project_id` + the assoc column.
2. Derive object keys per row (pure function `fileObjectKeys(row)`, exported for tests):
   - **Variants:** `image.variants.{thumbnail,small,medium}.path` — already bare keys
     (e.g. `<projectId>/images/<fileId>/small.png`). Tolerate absent/partial `image`
     json (non-image files, `processingError` rows).
   - **Original:** `original_path` stores the full *public URL*
     (e.g. `https://api.example.org/media/<projectId>/images/<fileId>/original.png`).
     Derive the key as the substring starting at `<projectId>/` — every upload key is
     built with a `${projectId}/` prefix (`routes/storage.ts:38`, `lib/images.ts`), and
     this stays correct even if `S3_PUBLIC_URL` changed since upload. If the marker is
     absent (malformed row), skip the original, log at `debug`, still handle variants.
3. Call `getStorage().remove(allKeys)` once (dedup'd).
4. On success: `delete from files where id in (...)` — only the rows actually processed.
5. On any storage failure: keep ALL rows for that assoc (the breadcrumb a future sweep
   or manual pass can find), log per the level policy:
   `logger.error("storage cleanup failed")` + `logger.debug({ err, ... }, ...)`.
   Never throw — the wrapper also try/catches so a handler can never 500 on cleanup.

### 3. Wire-in points (all fire-and-forget, after the soft-delete write)

| Handler | File | Assoc |
|---|---|---|
| `DELETE /entities/:id` | `routes/entities.ts` (~L274) | `{ entityId }` |
| `DELETE /comments/:id` | `routes/comments.ts` (~L208) | `{ commentId }` |
| `DELETE /conversations/:id/messages/:messageId` | `routes/chat.ts` (~L415) | `{ chatMessageId }` |
| `DELETE /events/:eventId` | `routes/events.ts` (~L290) | `{ eventId }` |

Notes:
- A deleted entity's shaped response thereafter has an empty `files` array — consistent,
  since soft-deleted content is hidden from all read paths anyway.
- `files.space_id` exists but spaces have no user-facing delete flow that should destroy
  media today; out of scope (add the same one-liner if/when one appears).
- Account-deletion and moderation paths intentionally do NOT call the helper (see
  Decisions).

### 4. Testing

**Unit (`src/lib/storage-cleanup.test.ts`, vitest, no DB):**
- `fileObjectKeys()` against realistic rows (mirror the prod row shape observed
  2026-07-03: full-URL `original_path`, variants with bare `path`): derives original +
  3 variant keys; handles missing `image` json; handles `original_path` without the
  `<projectId>/` marker (skips original, keeps variants); dedups.
- Provider `remove()`: S3 provider sends one `DeleteObjectsCommand` with the right keys
  (reuse the `@aws-sdk/client-s3` mock pattern from `storage/index.test.ts`); chunks at
  1000.
- Failure path: when `remove` rejects, `cleanupFilesFor` resolves (no throw) and does NOT
  delete rows (assert via mocked db or split the row-delete behind an injected fn).

**Integration (`test/integration/`):**
- Create entity with image (or seed `files` rows directly), `DELETE` the entity, assert
  the `files` rows are gone; storage layer mocked/no-op (the suite runs hermetic —
  `STORAGE_PROVIDER` unset ⇒ Supabase provider with no creds; inject a test provider via
  a `setStorageForTest` seam mirroring `resetStorageForTest`).
- Negative: moderation removal of an entity leaves its `files` rows intact.

### 5. Non-goals / explicitly rejected

- **Cron GC sweep** (rejected for now — immediate-only; the kept-on-failure `files` rows
  make a future sweep possible without schema changes).
- **DB triggers / pgmq queue** — no reliable-delivery requirement; keeps infra flat.
- **Deleting objects on moderation removal or account deletion** — see Decisions.

### 6. Operational notes

- `CHANGELOG.md`: entry under `[Unreleased]` → `Added` (storage cleanup on delete) when
  implemented.
- Both providers gain a delete capability for the FIRST time — the S3 bucket policy
  (public **read** only) is unaffected; deletes ride the API's credentialed client.
- Log lines added: `storage: cleaned N objects for <assoc>` at `debug`;
  failure pair at `error`(message-only)/`debug`(with `err`) per the logging policy.
