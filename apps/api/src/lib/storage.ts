// Supabase Storage helpers. Bytes live in a public bucket; the `files` table holds metadata.
import { getSupabase } from "./supabase.js";
import { env } from "./env.js";
import { Errors } from "../http/errors.js";

const BUCKET = "agora";
let bucketReady = false;

/** Reject oversized uploads (413) before buffering/processing — app-level cap, defense-in-depth
 *  behind the proxy's body limit. Uses File.size (no need to read the body first). */
export function assertUploadSize(file: { size: number }): void {
  if (file.size > env.MAX_UPLOAD_BYTES) {
    throw Errors.tooLarge("storage/file-too-large", `File exceeds the ${Math.floor(env.MAX_UPLOAD_BYTES / 1_048_576)} MiB upload limit`, "file");
  }
}

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
