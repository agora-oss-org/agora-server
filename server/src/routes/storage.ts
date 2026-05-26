// /v7/:projectId/storage/*  — uploads land in Supabase Storage; rows in `files`.
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { files } from "../db/schema/index.js";
import { uploadBytes, inferFileType } from "../lib/storage.js";
import { shapeFile } from "../lib/shape.js";
import { storeImageFromUpload } from "../lib/images.js";

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
    const { file, body, assoc } = await readUpload(c);
    const { fileRow, imageResponse } = await storeImageFromUpload({
      projectId, userId: c.var.auth!.userId, file, optionsBody: body, assoc,
    });
    // Image response shape (MODELS.md): fileId + original + variants + metadata + file.
    return c.json({ ...imageResponse, file: shapeFile(fileRow) }, 201);
  });
