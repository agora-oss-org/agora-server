// Supabase Storage helpers. Bytes live in a public bucket; the `files` table holds metadata.
import { getSupabase } from "./supabase.js";

const BUCKET = "agora";
let bucketReady = false;

async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const sb = getSupabase();
  const { data } = await sb.storage.getBucket(BUCKET);
  if (!data) await sb.storage.createBucket(BUCKET, { public: true });
  bucketReady = true;
}

export async function uploadBytes(path: string, bytes: Uint8Array, contentType: string): Promise<string> {
  await ensureBucket();
  const { error } = await getSupabase().storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  return publicUrl(path);
}

export function publicUrl(path: string): string {
  return getSupabase().storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

export function inferFileType(mime: string | undefined): "image" | "video" | "document" | "other" {
  if (!mime) return "other";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || mime.includes("document") || mime.startsWith("text/")) return "document";
  return "other";
}
