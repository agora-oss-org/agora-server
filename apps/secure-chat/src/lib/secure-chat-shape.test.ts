import { describe, it, expect } from "vitest";
import {
  shapeSecureDevice, shapeSecureMessage, shapeSecureConversation,
  shapeSecureHandshake, shapeSecureKeyBackup, shapeSecureKeyPackageClaim, shapeSecureRestoreBlob,
} from "./secure-chat-shape.js";

const now = new Date("2026-06-06T12:00:00.000Z");
const buf = (s: string) => Buffer.from(s, "utf8");

describe("secure-chat shapers", () => {
  it("base64-encodes bytea columns and ISO-formats dates on a device", () => {
    const out = shapeSecureDevice({
      id: "d1", projectId: "p1", userId: "u1", deviceId: "dev-1", displayName: null,
      signaturePublicKey: buf("sigkey"), credential: buf("cred"), ciphersuite: 1,
      revokedAt: null, lastSeenAt: null, createdAt: now, updatedAt: now,
    } as any);
    expect(out.signaturePublicKey).toBe(buf("sigkey").toString("base64"));
    expect(out.credential).toBe(buf("cred").toString("base64"));
    expect(out.createdAt).toBe("2026-06-06T12:00:00.000Z");
    expect(out.revokedAt).toBeNull();
  });

  it("emits ciphertext as base64 + epoch as a string, and carries no plaintext field", () => {
    const out = shapeSecureMessage({
      id: "m1", projectId: "p1", conversationId: "c1", senderUserId: "u1", senderDeviceId: "d1",
      epoch: 7n, ciphertext: buf("\x00\x01opaque"), contentType: "application", createdAt: now,
    } as any);
    expect(out.epoch).toBe("7");
    expect(out.ciphertext).toBe(buf("\x00\x01opaque").toString("base64"));
    // The model has no content/mentions/moderation surface — only opaque ciphertext.
    expect(out).not.toHaveProperty("content");
    expect(out).not.toHaveProperty("mentions");
  });

  it("stringifies bigint epoch on a conversation and includes optional counts", () => {
    const out = shapeSecureConversation(
      {
        id: "c1", projectId: "p1", type: "group", mlsGroupId: buf("gid"), spaceId: null,
        currentEpoch: 12n, name: null, createdById: "u1", lastMessageAt: now, createdAt: now, updatedAt: now,
      } as any,
      { memberCount: 3, unreadCount: 2 }
    );
    expect(out.currentEpoch).toBe("12");
    expect(out.mlsGroupId).toBe(buf("gid").toString("base64"));
    expect(out.memberCount).toBe(3);
    expect(out.unreadCount).toBe(2);
  });

  it("shapes a targeted welcome handshake", () => {
    const out = shapeSecureHandshake({
      id: "h1", projectId: "p1", conversationId: "c1", kind: "welcome", epoch: 1n,
      payload: buf("welcome-blob"), senderDeviceId: "d1", targetDeviceId: "d2", createdAt: now,
    } as any);
    expect(out.kind).toBe("welcome");
    expect(out.targetDeviceId).toBe("d2");
    expect(out.payload).toBe(buf("welcome-blob").toString("base64"));
  });

  it("returns the key-backup blob/nonce as base64 (server can't read it)", () => {
    const out = shapeSecureKeyBackup({
      id: "b1", projectId: "p1", userId: "u1", deviceId: null, blob: buf("ciphertext-backup"),
      nonce: buf("nonce123"), kdf: "argon2id", kdfParams: { salt: "x" }, cipher: "xchacha20poly1305",
      version: 1, createdAt: now, updatedAt: now,
    } as any);
    expect(out.blob).toBe(buf("ciphertext-backup").toString("base64"));
    expect(out.nonce).toBe(buf("nonce123").toString("base64"));
    expect(out.kdf).toBe("argon2id");
  });

  it("shapes a key-package claim", () => {
    const out = shapeSecureKeyPackageClaim({
      id: "k1", projectId: "p1", deviceId: "d1", keyPackageRef: "ref1", keyPackage: buf("kp-bytes"),
      ciphersuite: 2, consumedAt: now, consumedByUserId: "u2", expiresAt: null, createdAt: now,
    } as any);
    expect(out.keyPackage).toBe(buf("kp-bytes").toString("base64"));
    expect(out.deviceId).toBe("d1");
    expect(out.ciphersuite).toBe(2);
  });

  it("shapes a restore blob: blobId from row id, opaque base64 blob, ISO dates, no key/target surface", () => {
    const out = shapeSecureRestoreBlob({
      id: "rb1", projectId: "p1", conversationId: "c1", fromDeviceId: "dA", targetDeviceId: "dB",
      blob: buf("opaque-history"), expiresAt: now, createdAt: now,
    } as any);
    expect(out.blobId).toBe("rb1");
    expect(out.conversationId).toBe("c1");
    expect(out.fromDeviceId).toBe("dA");
    expect(out.blob).toBe(buf("opaque-history").toString("base64"));
    expect(out.createdAt).toBe("2026-06-06T12:00:00.000Z");
    expect(out.expiresAt).toBe("2026-06-06T12:00:00.000Z");
    // Opaque courier only — no decryption key, integrity digest, or even the target device leaks out.
    expect(out).not.toHaveProperty("targetDeviceId");
    expect(out).not.toHaveProperty("key");
    expect(out).not.toHaveProperty("sha256");
  });
});
