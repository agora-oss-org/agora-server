// /v7/:projectId/storage/*  — uploads land in Supabase Storage; rows in `files`.
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { files } from "../db/schema/index.js";
import { uploadBytes, inferFileType } from "../lib/storage.js";
import { shapeFile } from "../lib/shape.js";
import { parseImageOptions, computeVariants, resolveOutput, variantPath } from "../lib/image-variants.js";

// Pull the uploaded File + optional associations (+ the raw body for image options) out of multipart.
async function readUpload(c: any) {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!file || typeof file === "string") throw Errors.badRequest("storage/no-file", "Expected a multipart 'file' field", "file");
  return {
    file: file as File,
    body,
    assoc: {
      entityId: (body["entityId"] as string) || null,
      commentId: (body["commentId"] as string) || null,
      chatMessageId: (body["chatMessageId"] as string) || null,
      spaceId: (body["spaceId"] as string) || null,
    },
  };
}

export const storageRoutes = new Hono<{ Variables: Variables }>()
  .post("/", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const { file, assoc } = await readUpload(c);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileId = randomUUID();
    const ext = file.name.includes(".") ? "." + file.name.split(".").pop() : "";
    const path = `${projectId}/files/${fileId}${ext}`;
    const url = await uploadBytes(path, bytes, file.type || "application/octet-stream");
    const [row] = await db.insert(files).values({
      id: fileId, projectId, userId: c.var.auth!.userId,
      type: inferFileType(file.type), originalPath: url, originalSize: bytes.length,
      originalMimeType: file.type || null, ...assoc,
    }).returning();
    return c.json(shapeFile(row!), 201);
  })
  .post("/images", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const started = Date.now();
    const { file, body, assoc } = await readUpload(c);
    if (!file.type.startsWith("image/")) throw Errors.badRequest("storage/not-an-image", "File is not an image", "file");
    const input = Buffer.from(await file.arrayBuffer());
    const fileId = randomUUID();

    let meta: sharp.Metadata;
    try { meta = await sharp(input).metadata(); }
    catch { throw Errors.badRequest("storage/bad-image", "Could not read image"); }

    // SDK UploadImageOptions: mode (exact-dimensions | aspect-ratio-width|height-based |
    // original-aspect | multi-aspect-ratio) + per-mode params; absent → legacy thumbnail/small/medium.
    const opts = parseImageOptions(body);
    const out = resolveOutput(opts, meta.format);
    const stripExif = opts.stripExif !== false; // default true
    const specs = computeVariants(opts);

    const make = async (name: string, spec?: { width?: number; height?: number; fit?: string }) => {
      let pipeline = sharp(input).rotate(); // applies + strips EXIF orientation
      if (!stripExif) pipeline = pipeline.withMetadata();
      if (spec && (spec.width || spec.height)) {
        // original-aspect / legacy bound the size (don't upscale); exact/aspect honor requested dims.
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
      id: fileId, projectId, userId: c.var.auth!.userId, type: "image",
      originalPath: original.publicPath, originalSize: original.size, originalMimeType: out.mime,
      image, ...assoc,
    }).returning();
    // Image response shape (MODELS.md): fileId + original + variants + metadata.
    return c.json({
      fileId, imageId: fileId, status: "completed", original, variants,
      metadata: { originalFormat: meta.format, originalSize: input.length, exifStripped: stripExif, processingTime: Date.now() - started },
      file: shapeFile(row!), createdAt: image.createdAt,
    }, 201);
  });
