// The object-storage seam. `lib/storage.ts`'s `uploadBytes`/`publicUrl` delegate here, so callers
// (lib/images.ts, routes/storage.ts, …) are backend-agnostic. One implementation is selected once at
// boot by STORAGE_PROVIDER (lib/storage/index.ts): Supabase Storage or any S3-compatible store.
export interface StorageProvider {
  /** Lazily provision the backing bucket (public-read) if needed. Called before the first `put`. */
  init?(): Promise<void>;
  /** Upload `bytes` at `key`, overwriting. Returns the public URL of the stored object. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  /** The browser-reachable public URL for an already-stored `key` (no I/O). */
  publicUrl(key: string): string;
  /** Batch-delete stored objects. Missing keys are not an error (idempotent); empty list is a no-op. */
  remove(keys: string[]): Promise<void>;
}
