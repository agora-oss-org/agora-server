// Storage facade. Bytes live in a public bucket; the `files` table holds metadata. The backing store
// (Supabase Storage or any S3-compatible store, e.g. MinIO) is chosen by STORAGE_PROVIDER behind the
// StorageProvider seam (lib/storage/), so callers here are backend-agnostic.
import { getStorage } from "./storage/index.js";
import { env } from "./env.js";
import { Errors } from "../http/errors.js";

/** Reject oversized uploads (413) before buffering/processing — app-level cap, defense-in-depth
 *  behind the proxy's body limit. Uses File.size (no need to read the body first). */
export function assertUploadSize(file: { size: number }): void {
  if (file.size > env.MAX_UPLOAD_BYTES) {
    throw Errors.tooLarge("storage/file-too-large", `File exceeds the ${Math.floor(env.MAX_UPLOAD_BYTES / 1_048_576)} MiB upload limit`, "file");
  }
}

export async function uploadBytes(path: string, bytes: Uint8Array, contentType: string): Promise<string> {
  const store = getStorage();
  await store.init?.();
  return store.put(path, bytes, contentType);
}

export function publicUrl(path: string): string {
  return getStorage().publicUrl(path);
}

export function inferFileType(mime: string | undefined): "image" | "video" | "document" | "other" {
  if (!mime) return "other";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || mime.includes("document") || mime.startsWith("text/")) return "document";
  return "other";
}
