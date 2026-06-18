// Supabase Storage backend (the default). Bytes live in a public bucket; the `files` table holds
// metadata. This is the original lib/storage.ts logic, moved verbatim behind the StorageProvider seam.
import { getSupabase } from "../supabase.js";
import type { StorageProvider } from "./provider.js";

const BUCKET = "agora";

export class SupabaseStorageProvider implements StorageProvider {
  private bucketReady = false;

  async init(): Promise<void> {
    if (this.bucketReady) return;
    const sb = getSupabase();
    const { data } = await sb.storage.getBucket(BUCKET);
    if (!data) await sb.storage.createBucket(BUCKET, { public: true });
    this.bucketReady = true;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    const { error } = await getSupabase().storage.from(BUCKET).upload(key, bytes, { contentType, upsert: true });
    if (error) throw new Error(`storage upload failed: ${error.message}`);
    return this.publicUrl(key);
  }

  publicUrl(key: string): string {
    return getSupabase().storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
  }
}
