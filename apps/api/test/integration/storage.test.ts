// Integration: the storage routes (POST /storage, POST /storage/images). The one external dependency
// is Supabase Storage, reached lazily via getSupabase() — we mock that single seam so uploads are
// hermetic (no network, no real bucket). Everything else is real: multipart parsing, the size cap,
// sharp image processing + variant generation, and the `files` row write against the test Postgres.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Mock the Supabase client BEFORE app/lib imports load. uploadBytes()/publicUrl() (lib/storage.ts)
// and the image pipeline (lib/images.ts → uploadBytes) both funnel through getSupabase().storage,
// so this fake covers both routes. It records nothing — it just succeeds and hands back a fake URL.
vi.mock("../../src/lib/supabase.js", () => ({
  getSupabase: () => ({
    storage: {
      getBucket: async () => ({ data: { name: "agora" }, error: null }),
      createBucket: async () => ({ data: {}, error: null }),
      from: () => ({
        upload: async () => ({ data: { path: "ok" }, error: null }),
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://fake.storage.test/${path}` } }),
      }),
    },
  }),
}));

import sharp from "sharp";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/app.js";
import { getDb } from "../../src/db/index.js";
import { files } from "../../src/db/schema/index.js";
import { createProject, createUser, deleteProject, base } from "./helpers.js";

const app = createApp();

// Multipart POST against the in-process app (the JSON `api()` helper can't do multipart — leave the
// content-type unset so the Request constructor stamps the multipart boundary itself).
async function postMultipart(
  path: string,
  token: string | undefined,
  fields: Record<string, string | File>,
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof File) fd.append(k, v, v.name);
    else fd.append(k, v);
  }
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await app.request(path, { method: "POST", headers, body: fd });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("storage uploads (integration, mocked Supabase Storage)", () => {
  let projectId: string;
  let user: { id: string; token: string };
  let B: string;

  beforeAll(async () => {
    projectId = await createProject();
    user = await createUser(projectId);
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  describe("POST /storage — generic file", () => {
    it("stores a file → 201 with a shaped row and a persisted files record", async () => {
      const file = new File([new TextEncoder().encode("hello world")], "note.txt", { type: "text/plain" });
      const res = await postMultipart(`${B}/storage`, user.token, { file });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        projectId,
        userId: user.id,
        type: "document",
        originalSize: 11,
        originalMimeType: "text/plain",
      });
      expect(res.body.originalPath).toContain(`${projectId}/files/`); // fake public URL carries the path
      expect(res.body.id).toBeTruthy();

      // The files row is really in Postgres.
      const [row] = await getDb().select().from(files).where(eq(files.id, res.body.id));
      expect(row).toBeDefined();
      expect(row!.originalSize).toBe(11);
    });

    it("links associations passed in the form (entityId)", async () => {
      const { body: entity } = await jsonPost(`${B}/entities`, user.token, { content: "host" });
      const file = new File([new Uint8Array([1, 2, 3, 4])], "blob.bin", { type: "application/octet-stream" });
      const res = await postMultipart(`${B}/storage`, user.token, { file, entityId: entity.id });

      expect(res.status).toBe(201);
      expect(res.body.entityId).toBe(entity.id);
      expect(res.body.type).toBe("other"); // octet-stream → "other"
    });

    it("rejects a request with no file field (400 storage/no-file)", async () => {
      const res = await postMultipart(`${B}/storage`, user.token, { entityId: "x" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("storage/no-file");
    });

    it("requires auth (401 without a token)", async () => {
      const file = new File([new Uint8Array([0])], "x.bin");
      const res = await postMultipart(`${B}/storage`, undefined, { file });
      expect(res.status).toBe(401);
    });

    it("rejects an oversized file before buffering (413 storage/file-too-large)", async () => {
      // One byte past the 25 MiB (26_214_400) default cap; assertUploadSize reads .size and throws.
      const tooBig = new File([new Uint8Array(26_214_401)], "huge.bin", { type: "application/octet-stream" });
      const res = await postMultipart(`${B}/storage`, user.token, { file: tooBig });
      expect(res.status).toBe(413);
      expect(res.body.code).toBe("storage/file-too-large");
    });
  });

  describe("POST /storage/images — sharp pipeline", () => {
    it("processes a real image into original + variants and persists an image file row", async () => {
      // A genuine 64×64 PNG so sharp's metadata + variant pipeline runs for real.
      const png = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 100, b: 50 } },
      })
        .png()
        .toBuffer();
      const file = new File([png], "pic.png", { type: "image/png" });

      const res = await postMultipart(`${B}/storage/images`, user.token, { file });
      expect(res.status).toBe(201);
      // Image response shape (MODELS.md): fileId + original + variants + metadata + file.
      expect(res.body.fileId).toBeTruthy();
      expect(res.body.original).toBeTruthy();
      expect(res.body.variants).toBeTruthy();
      expect(res.body.file).toMatchObject({ type: "image", projectId });

      const [row] = await getDb().select().from(files).where(eq(files.id, res.body.fileId));
      expect(row).toBeDefined();
      expect(row!.type).toBe("image");
    });

    it("rejects a non-image (sharp can't read it) without persisting a row", async () => {
      const before = (await getDb().select().from(files).where(eq(files.projectId, projectId))).length;
      const notImage = new File([new TextEncoder().encode("not a png")], "fake.png", { type: "image/png" });
      const res = await postMultipart(`${B}/storage/images`, user.token, { file: notImage });

      expect(res.status).toBeGreaterThanOrEqual(400);
      const after = (await getDb().select().from(files).where(eq(files.projectId, projectId))).length;
      expect(after).toBe(before); // no orphaned files row on a failed decode
    });
  });
});

// Small JSON POST against the same in-process app (for creating an entity to associate).
async function jsonPost(path: string, token: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
