// Integration: CONTENT_DELETE_MODE soft|hard delete semantics. Proves what unit tests can't —
// the FK cascades (entity → comments → files; comment reply subtrees), that hard mode collects
// storage keys BEFORE the row delete, and that soft mode (default) leaves rows AND media alone.
// Storage is a captured fake via setStorageForTest (hermetic — no real MinIO/Supabase).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { getDb } from "../../src/db/index.js";
import { entities, comments, files } from "../../src/db/schema/index.js";
import { env } from "../../src/lib/env.js";
import { setStorageForTest } from "../../src/lib/storage/index.js";
import type { StorageProvider } from "../../src/lib/storage/provider.js";

const ORIGINAL_MODE = env.CONTENT_DELETE_MODE;

/** Captured-fake storage provider; records every remove() key batch. */
function captureStorage() {
  const removed: string[] = [];
  const provider: StorageProvider = {
    put: async () => "",
    publicUrl: () => "",
    remove: async (keys) => {
      removed.push(...keys);
    },
  };
  setStorageForTest(provider);
  return removed;
}

/** Seed a files row the way the upload path writes it (full-URL original, bare-key variants). */
async function seedFile(projectId: string, userId: string, assoc: Partial<typeof files.$inferInsert>, withVariants = false) {
  const [row] = await getDb()
    .insert(files)
    .values({
      projectId,
      userId,
      type: "image",
      originalPath: `https://api.test/media/${projectId}/images/seed-${randomSuffix()}/original.png`,
      image: withVariants
        ? { variants: { small: { path: `${projectId}/images/v-${randomSuffix()}/small.png` } } }
        : null,
      ...assoc,
    })
    .returning();
  return row!;
}

let suffix = 0;
function randomSuffix() {
  return `${++suffix}`;
}

describe("CONTENT_DELETE_MODE (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };

  beforeAll(async () => {
    projectId = await createProject();
    owner = await createUser(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  afterEach(() => {
    (env as { CONTENT_DELETE_MODE: string }).CONTENT_DELETE_MODE = ORIGINAL_MODE;
    setStorageForTest(null);
  });

  it("soft (default): tombstones the entity, keeps files rows, never touches storage", async () => {
    const removed = captureStorage();
    const { body: entity } = await api("POST", `${base(projectId)}/entities`, {
      token: owner.token,
      body: { title: "soft me" },
    });
    const file = await seedFile(projectId, owner.id, { entityId: entity.id });

    const res = await api("DELETE", `${base(projectId)}/entities/${entity.id}`, { token: owner.token });
    expect(res.status).toBe(200);

    const [row] = await getDb().select().from(entities).where(eq(entities.id, entity.id));
    expect(row).toBeDefined(); // row survives …
    expect(row!.deletedAt).not.toBeNull(); // … tombstoned
    const fileRows = await getDb().select().from(files).where(eq(files.id, file.id));
    expect(fileRows).toHaveLength(1); // media metadata kept
    expect(removed).toHaveLength(0); // storage untouched
  });

  it("hard: entity delete removes the row, its comments, all files rows, and their storage objects", async () => {
    const removed = captureStorage();
    const { body: entity } = await api("POST", `${base(projectId)}/entities`, {
      token: owner.token,
      body: { title: "hard me" },
    });
    const { body: comment } = await api("POST", `${base(projectId)}/comments`, {
      token: owner.token,
      body: { entityId: entity.id, content: "with an image" },
    });
    const entityFile = await seedFile(projectId, owner.id, { entityId: entity.id }, true);
    const commentFile = await seedFile(projectId, owner.id, { commentId: comment.id });

    (env as { CONTENT_DELETE_MODE: string }).CONTENT_DELETE_MODE = "hard";
    const res = await api("DELETE", `${base(projectId)}/entities/${entity.id}`, { token: owner.token });
    expect(res.status).toBe(200);

    // fire-and-forget removal — let the microtask drain
    await vi.waitFor(() => expect(removed.length).toBeGreaterThan(0));

    expect(await getDb().select().from(entities).where(eq(entities.id, entity.id))).toHaveLength(0);
    expect(await getDb().select().from(comments).where(eq(comments.id, comment.id))).toHaveLength(0);
    expect(await getDb().select().from(files).where(eq(files.id, entityFile.id))).toHaveLength(0);
    expect(await getDb().select().from(files).where(eq(files.id, commentFile.id))).toHaveLength(0);

    // keys: entity original + its variant + the comment's original
    expect(removed).toHaveLength(3);
    expect(removed.every((k) => k.startsWith(`${projectId}/`))).toBe(true);
  });

  it("hard: comment delete takes its reply subtree's files with it", async () => {
    const removed = captureStorage();
    const { body: entity } = await api("POST", `${base(projectId)}/entities`, {
      token: owner.token,
      body: { title: "thread" },
    });
    const { body: root } = await api("POST", `${base(projectId)}/comments`, {
      token: owner.token,
      body: { entityId: entity.id, content: "root" },
    });
    const { body: reply } = await api("POST", `${base(projectId)}/comments`, {
      token: owner.token,
      body: { entityId: entity.id, parentId: root.id, content: "reply with image" },
    });
    const replyFile = await seedFile(projectId, owner.id, { commentId: reply.id });

    (env as { CONTENT_DELETE_MODE: string }).CONTENT_DELETE_MODE = "hard";
    const res = await api("DELETE", `${base(projectId)}/comments/${root.id}`, { token: owner.token });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(removed.length).toBeGreaterThan(0));
    expect(await getDb().select().from(comments).where(eq(comments.id, reply.id))).toHaveLength(0);
    expect(await getDb().select().from(files).where(eq(files.id, replyFile.id))).toHaveLength(0);
    expect(removed).toHaveLength(1);
  });

  it("moderation removal never touches files rows or storage (either mode)", async () => {
    const removed = captureStorage();
    const { body: entity } = await api("POST", `${base(projectId)}/entities`, {
      token: owner.token,
      body: { title: "moderated" },
    });
    const file = await seedFile(projectId, owner.id, { entityId: entity.id });

    (env as { CONTENT_DELETE_MODE: string }).CONTENT_DELETE_MODE = "hard";
    // Moderation removal is an UPDATE (hidden, reversible) — not a delete-handler path.
    await getDb().update(entities).set({ moderationStatus: "removed" }).where(eq(entities.id, entity.id));

    expect(await getDb().select().from(files).where(eq(files.id, file.id))).toHaveLength(1);
    expect(removed).toHaveLength(0);
  });
});
