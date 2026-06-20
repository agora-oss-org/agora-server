// IUC restore-blob courier (ENVELOPE history restore) — the targeted, ephemeral, opaque relay device A
// uses to hand a re-provisioned device B its plaintext back-history off the MLS channel. The server is
// blind: it stores opaque bytes + routing metadata only. Security negatives are the priority here — the
// non-recipient is blocked with a non-distinguishing 404 (no existence oracle), and the gates fire.
//
// Caps are shrunk for the run via vitest.integration.config.ts: MAX_SECURE_RESTORE_BLOB_BYTES=1024,
// MAX_SECURE_RESTORE_BLOBS_PER_PAIR=3, CRON_SECRET set (so the purge sweep endpoint is live).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@agora/core/db";
import { secureRestoreBlobs } from "@agora/core/db/schema";
import { createSecureApp } from "../../src/app.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { provisionDevice, b64e, enc } from "./secure-helpers.js";

const cronApp = createSecureApp();
const CRON_SECRET = process.env.CRON_SECRET!;

let projectId: string;
let alice: { id: string; token: string }; // uploader A (member)
let bob: { id: string; token: string }; // recipient B (member)
let carol: { id: string; token: string }; // non-member
let aliceDev: string; // device row id A
let bobDev: string; // device row id B
let carolDev: string; // device row id whose owner is NOT a member
let conversationId: string;
let blobId: string; // the happy-path blob, reused across the GET/DELETE cases

const restoreBase = (pid: string) => `${base(pid)}/secure-chat/restore-blobs`;
const blobOf = (s: string) => b64e(enc.encode(s));

beforeAll(async () => {
  projectId = await createProject();
  alice = await createUser(projectId);
  bob = await createUser(projectId);
  carol = await createUser(projectId);
  aliceDev = (await provisionDevice(projectId, alice, "alice-web")).rowId;
  bobDev = (await provisionDevice(projectId, bob, "bob-web")).rowId;
  carolDev = (await provisionDevice(projectId, carol, "carol-web")).rowId;
  const conv = await api("POST", `${base(projectId)}/secure-chat/conversations`, {
    token: alice.token,
    body: { type: "group", mlsGroupId: b64e(enc.encode(`grp-${randomUUID()}`)), memberUserIds: [bob.id] },
  });
  expect(conv.status).toBe(201);
  conversationId = conv.body.id;
});
afterAll(async () => {
  if (projectId) await deleteProject(projectId);
});

describe("secure-chat IUC restore blobs", () => {
  it("uploads a blob A→B (201) and stores opaque bytes the server can't read", async () => {
    const SECRET = "history: meeting at dawn";
    const res = await api("POST", restoreBase(projectId), {
      token: alice.token,
      body: { conversationId, fromDeviceId: aliceDev, targetDeviceId: bobDev, blob: blobOf(SECRET) },
    });
    expect(res.status).toBe(201);
    expect(res.body.blobId).toBeTruthy();
    expect(typeof res.body.expiresAt).toBe("string");
    blobId = res.body.blobId;

    // The server stored the bytes verbatim — but they ARE the plaintext here only because the test
    // "seal" is identity; the point is the row carries no key/sha256/transferId column to leak.
    const [row] = await db.select().from(secureRestoreBlobs).where(eq(secureRestoreBlobs.id, blobId));
    expect(row!.fromDeviceId).toBe(aliceDev);
    expect(row!.targetDeviceId).toBe(bobDev);
    expect(Object.keys(row!)).not.toContain("key");
  });

  it("GET by the target owner returns the blob round-tripped", async () => {
    const res = await api("GET", `${restoreBase(projectId)}/${blobId}`, { token: bob.token });
    expect(res.status).toBe(200);
    expect(res.body.blobId).toBe(blobId);
    expect(res.body.conversationId).toBe(conversationId);
    expect(res.body.fromDeviceId).toBe(aliceDev);
    expect(res.body.blob).toBe(blobOf("history: meeting at dawn"));
    // The target device id is NOT echoed (B knows it's them; nothing extra leaks).
    expect(res.body).not.toHaveProperty("targetDeviceId");
  });

  it("GET by a non-owner (the uploader) is 404 — no existence oracle", async () => {
    const res = await api("GET", `${restoreBase(projectId)}/${blobId}`, { token: alice.token });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("secure-chat/restore-blob-not-found");
  });

  it("DELETE by a non-owner is 404 and leaves the blob fetchable by the owner", async () => {
    const del = await api("DELETE", `${restoreBase(projectId)}/${blobId}`, { token: alice.token });
    expect(del.status).toBe(404);
    const stillThere = await api("GET", `${restoreBase(projectId)}/${blobId}`, { token: bob.token });
    expect(stillThere.status).toBe(200);
  });

  it("DELETE by the owner is 204 and consumes the blob (subsequent GET 404)", async () => {
    const del = await api("DELETE", `${restoreBase(projectId)}/${blobId}`, { token: bob.token });
    expect(del.status).toBe(204);
    const gone = await api("GET", `${restoreBase(projectId)}/${blobId}`, { token: bob.token });
    expect(gone.status).toBe(404);
  });

  it("rejects an uploader who is not a member of the conversation (403)", async () => {
    const res = await api("POST", restoreBase(projectId), {
      token: carol.token,
      body: { conversationId, fromDeviceId: carolDev, targetDeviceId: bobDev, blob: blobOf("x") },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("secure-chat/not-a-member");
  });

  it("rejects a target device whose owner is not a member (404)", async () => {
    const res = await api("POST", restoreBase(projectId), {
      token: alice.token,
      body: { conversationId, fromDeviceId: aliceDev, targetDeviceId: carolDev, blob: blobOf("x") },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("secure-chat/restore-target-not-member");
  });

  it("rejects an oversize blob with a distinct 413 (the SDK's fallback signal)", async () => {
    const tooBig = b64e(new Uint8Array(2000)); // > MAX_SECURE_RESTORE_BLOB_BYTES (1024 in tests)
    const res = await api("POST", restoreBase(projectId), {
      token: alice.token,
      body: { conversationId, fromDeviceId: aliceDev, targetDeviceId: bobDev, blob: tooBig },
    });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("secure-chat/restore-blob-too-large");
  });

  it("enforces the per-pair outstanding quota (429 past the cap)", async () => {
    // Pair A→B is empty again (the happy-path blob was DELETEd). Cap is 3.
    for (let i = 0; i < 3; i++) {
      const ok = await api("POST", restoreBase(projectId), {
        token: alice.token,
        body: { conversationId, fromDeviceId: aliceDev, targetDeviceId: bobDev, blob: blobOf(`chunk-${i}`) },
      });
      expect(ok.status).toBe(201);
    }
    const over = await api("POST", restoreBase(projectId), {
      token: alice.token,
      body: { conversationId, fromDeviceId: aliceDev, targetDeviceId: bobDev, blob: blobOf("chunk-4") },
    });
    expect(over.status).toBe(429);
  });

  it("hides an expired blob on GET (lazy expiry) and the cron sweep purges only expired rows", async () => {
    // Insert directly (bypassing the TTL) on an isolated pair (A→carol) so quota math elsewhere is
    // unaffected; carol owns the target so she's the authorized fetcher here.
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    const [expired] = await db.insert(secureRestoreBlobs)
      .values({ projectId, conversationId, fromDeviceId: aliceDev, targetDeviceId: carolDev, blob: Buffer.from("old"), expiresAt: past })
      .returning({ id: secureRestoreBlobs.id });
    const [live] = await db.insert(secureRestoreBlobs)
      .values({ projectId, conversationId, fromDeviceId: aliceDev, targetDeviceId: carolDev, blob: Buffer.from("new"), expiresAt: future })
      .returning({ id: secureRestoreBlobs.id });

    // Lazy expiry: the expired row still exists but GET hides it.
    const got = await api("GET", `${restoreBase(projectId)}/${expired!.id}`, { token: carol.token });
    expect(got.status).toBe(404);

    // Cron sweep deletes the expired row, keeps the live one.
    const res = await cronApp.request("/internal/cron/purge-restore-blobs", {
      method: "POST",
      headers: { "x-cron-secret": CRON_SECRET },
    });
    expect(res.status).toBe(200);
    const expiredRows = await db.select().from(secureRestoreBlobs).where(eq(secureRestoreBlobs.id, expired!.id));
    expect(expiredRows.length).toBe(0);
    const liveRows = await db.select().from(secureRestoreBlobs).where(eq(secureRestoreBlobs.id, live!.id));
    expect(liveRows.length).toBe(1);
  });
});
