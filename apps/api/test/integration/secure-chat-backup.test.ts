// Secure chat — passphrase key backup (option 2). The server stores/returns the blob verbatim and
// cannot decrypt it; a fresh device restores history with the passphrase, and a wrong passphrase
// fails client-side.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { MockSecureChatCrypto } from "@agora-sdk/secure-chat-crypto/testing";
import { db } from "../../src/db/index.js";
import { secureKeyBackups } from "../../src/db/schema/index.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { b64e, b64d, enc, dec } from "./secure-helpers.js";

let projectId: string;
let alice: { id: string; token: string };

beforeAll(async () => {
  projectId = await createProject();
  alice = await createUser(projectId);
});
afterAll(async () => {
  if (projectId) await deleteProject(projectId);
});

describe("secure-chat passphrase key backup", () => {
  it("404s before any backup exists", async () => {
    const res = await api("GET", `${base(projectId)}/secure-chat/key-backup`, { token: alice.token });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("secure-chat/backup-not-found");
  });

  it("round-trips an opaque backup blob the server can't read, and restores history on a new device", async () => {
    const device = new MockSecureChatCrypto();
    await device.generateDeviceIdentity({ deviceId: "alice-web" });
    const { group } = await device.createGroup({ initialMembers: [] });
    const SECRET = "diary entry: trust no proxy";
    const { ciphertext } = await device.encryptMessage(group, enc.encode(SECRET));

    const backup = await device.exportBackup("correct horse battery staple");
    const put = await api("PUT", `${base(projectId)}/secure-chat/key-backup`, {
      token: alice.token,
      body: {
        blob: b64e(backup.blob), nonce: b64e(backup.nonce), kdf: backup.kdf,
        kdfParams: backup.kdfParams, cipher: backup.cipher, version: backup.version,
      },
    });
    expect([200, 201]).toContain(put.status);

    // The server stored the blob verbatim and it does NOT contain the plaintext.
    const [stored] = await db.select().from(secureKeyBackups).where(eq(secureKeyBackups.userId, alice.id));
    expect(Buffer.from(stored!.blob).includes(Buffer.from(SECRET, "utf8"))).toBe(false);

    // A fresh device fetches the backup and restores → can decrypt the old message.
    const got = await api("GET", `${base(projectId)}/secure-chat/key-backup`, { token: alice.token });
    expect(got.status).toBe(200);
    const restored = new MockSecureChatCrypto();
    await restored.importBackup("correct horse battery staple", {
      blob: b64d(got.body.blob), nonce: b64d(got.body.nonce), kdf: got.body.kdf,
      kdfParams: got.body.kdfParams, cipher: got.body.cipher, version: got.body.version,
    });
    const out = await restored.decryptMessage(group, ciphertext);
    expect(dec.decode(out.plaintext)).toBe(SECRET);
  });

  it("a wrong passphrase fails to restore (client-side)", async () => {
    const got = await api("GET", `${base(projectId)}/secure-chat/key-backup`, { token: alice.token });
    const wrong = new MockSecureChatCrypto();
    await expect(
      wrong.importBackup("hunter2", {
        blob: b64d(got.body.blob), nonce: b64d(got.body.nonce), kdf: got.body.kdf,
        kdfParams: got.body.kdfParams, cipher: got.body.cipher, version: got.body.version,
      })
    ).rejects.toThrow();
  });

  it("upserts: a second PUT replaces the blob rather than creating a duplicate", async () => {
    const first = await api("PUT", `${base(projectId)}/secure-chat/key-backup`, {
      token: alice.token,
      body: { blob: b64e(enc.encode("v1")), nonce: b64e(enc.encode("n1")), kdf: "argon2id", kdfParams: { salt: "a" }, cipher: "aes-256-gcm", version: 1 },
    });
    expect([200, 201]).toContain(first.status);
    const second = await api("PUT", `${base(projectId)}/secure-chat/key-backup`, {
      token: alice.token,
      body: { blob: b64e(enc.encode("v2")), nonce: b64e(enc.encode("n2")), kdf: "argon2id", kdfParams: { salt: "b" }, cipher: "aes-256-gcm", version: 2 },
    });
    expect(second.status).toBe(200); // existing → update path
    const rows = await db.select().from(secureKeyBackups).where(eq(secureKeyBackups.userId, alice.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.version).toBe(2);
  });
});
