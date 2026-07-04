// Picks the storage backend once, at first use, from STORAGE_PROVIDER. `lib/storage.ts` delegates
// `uploadBytes`/`publicUrl` to the returned provider, so the choice is invisible to call sites.
import { env } from "../env.js";
import type { StorageProvider } from "./provider.js";
import { SupabaseStorageProvider } from "./supabase.js";
import { S3StorageProvider } from "./s3.js";

let provider: StorageProvider | null = null;

/** The configured storage backend (memoized singleton). `s3` with missing S3_* throws a clear error. */
export function getStorage(): StorageProvider {
  if (provider) return provider;
  provider = env.STORAGE_PROVIDER === "s3" ? new S3StorageProvider() : new SupabaseStorageProvider();
  return provider;
}

/** Test-only: drop the memoized provider so a fresh STORAGE_PROVIDER takes effect. */
export function resetStorageForTest(): void {
  provider = null;
}

/** Test-only: inject a fake provider (integration tests run hermetic — no real storage backend). */
export function setStorageForTest(p: StorageProvider | null): void {
  provider = p;
}

export type { StorageProvider } from "./provider.js";
