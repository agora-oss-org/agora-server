// Shared image-upload pipeline: sharp → variants → Supabase Storage → `files` row.
// Used by both POST /storage/images and POST /entities (multipart image attachments) so the
// processing/variant logic lives in exactly one place.
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { db } from "../db/index.js";
import { files } from "../db/schema/index.js";
import { Errors } from "../http/errors.js";
import { uploadBytes, inferFileType } from "./storage.js";
import { parseImageOptions, computeVariants, resolveOutput, variantPath } from "./image-variants.js";

export interface ImageAssoc {
  entityId?: string | null;
  commentId?: string | null;
  chatMessageId?: string | null;
  spaceId?: string | null;
}

/**
 * Process a single uploaded image: build the original + variants (sharp), upload each to
 * Supabase Storage, insert the `files` row (optionally associated to an entity/comment/etc.),
 * and return both the DB row and the API-shaped image response.
 */
export async function storeImageFromUpload(args: {
  projectId: string;
  userId: string;
  file: File;
  optionsBody?: Record<string, unknown>;
  assoc?: ImageAssoc;
}) {
  const { projectId, userId, file, optionsBody = {}, assoc = {} } = args;
  const started = Date.now();
  if (!file.type.startsWith("image/")) {
    throw Errors.badRequest("storage/not-an-image", "File is not an image", "file");
  }
  const input = Buffer.from(await file.arrayBuffer());
  const fileId = randomUUID();

  let meta: sharp.Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw Errors.badRequest("storage/bad-image", "Could not read image");
  }

  // SDK UploadImageOptions: mode (exact-dimensions | aspect-ratio-* | original-aspect |
  // multi-aspect-ratio) + per-mode params; absent → legacy thumbnail/small/medium.
  const opts = parseImageOptions(optionsBody);
  const out = resolveOutput(opts, meta.format);
  const stripExif = opts.stripExif !== false; // default true
  const specs = computeVariants(opts);

  const make = async (name: string, spec?: { width?: number; height?: number; fit?: string }) => {
    let pipeline = sharp(input).rotate(); // applies + strips EXIF orientation
    if (!stripExif) pipeline = pipeline.withMetadata();
    if (spec && (spec.width || spec.height)) {
      const noEnlarge = !spec.height || spec.fit === "inside" || spec.fit === "outside";
      pipeline = pipeline.resize({ width: spec.width, height: spec.height, fit: (spec.fit as any) ?? "cover", withoutEnlargement: noEnlarge });
    }
    const { data, info } = await out.apply(pipeline).toBuffer({ resolveWithObject: true });
    const publicPath = await uploadBytes(variantPath(projectId, opts.pathParts, fileId, name, out.ext), new Uint8Array(data), out.mime);
    return { path: variantPath(projectId, opts.pathParts, fileId, name, out.ext), publicPath, width: info.width, height: info.height, size: info.size, format: out.format };
  };

  const original = await make("original");
  const variants: Record<string, unknown> = {};
  for (const s of specs) {
    // Skip width-only variants larger than the source (legacy behavior); explicit dims are honored.
    if (s.width && !s.height && meta.width && s.width > meta.width) continue;
    variants[s.name] = await make(s.name, s);
  }

  const image = {
    fileId, originalWidth: meta.width ?? null, originalHeight: meta.height ?? null,
    variants, processingStatus: "completed", processingError: null,
    format: out.format, quality: opts.quality ?? 85, exifStripped: stripExif,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const [row] = await db.insert(files).values({
    id: fileId, projectId, userId, type: "image",
    originalPath: original.publicPath, originalSize: original.size, originalMimeType: out.mime,
    image,
    entityId: assoc.entityId ?? null, commentId: assoc.commentId ?? null,
    chatMessageId: assoc.chatMessageId ?? null, spaceId: assoc.spaceId ?? null,
  }).returning();

  // Image response shape (MODELS.md): fileId + original + variants + metadata.
  const imageResponse = {
    fileId, imageId: fileId, status: "completed", original, variants,
    metadata: { originalFormat: meta.format, originalSize: input.length, exifStripped: stripExif, processingTime: Date.now() - started },
    createdAt: image.createdAt,
  };
  return { fileRow: row!, imageResponse };
}

/**
 * Store a non-image upload as-is (no processing): upload the bytes to Supabase Storage and insert
 * a `files` row, optionally associated to an entity/comment/chat message.
 */
export async function storeFileFromUpload(args: {
  projectId: string;
  userId: string;
  file: File;
  assoc?: ImageAssoc;
}) {
  const { projectId, userId, file, assoc = {} } = args;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileId = randomUUID();
  const ext = file.name.includes(".") ? "." + file.name.split(".").pop() : "";
  const url = await uploadBytes(`${projectId}/files/${fileId}${ext}`, bytes, file.type || "application/octet-stream");
  const [row] = await db.insert(files).values({
    id: fileId, projectId, userId,
    type: inferFileType(file.type), originalPath: url, originalSize: bytes.length,
    originalMimeType: file.type || null,
    entityId: assoc.entityId ?? null, commentId: assoc.commentId ?? null,
    chatMessageId: assoc.chatMessageId ?? null, spaceId: assoc.spaceId ?? null,
  }).returning();
  return { fileRow: row! };
}

/**
 * Store any upload: images go through the variant pipeline, everything else is stored as-is.
 * Returns the inserted `files` row.
 */
export async function storeUpload(args: {
  projectId: string;
  userId: string;
  file: File;
  optionsBody?: Record<string, unknown>;
  assoc?: ImageAssoc;
}) {
  if (args.file.type.startsWith("image/")) {
    const { fileRow } = await storeImageFromUpload(args);
    return { fileRow };
  }
  return storeFileFromUpload(args);
}
