import { describe, it, expect } from "vitest";
import {
  base64,
  epochString,
  registerDeviceSchema,
  publishKeyPackagesSchema,
  createSecureConversationSchema,
  addSecureMemberSchema,
  sendSecureMessageSchema,
  uploadKeyBackupSchema,
} from "./secure-chat.js";

const UUID = "11111111-1111-1111-1111-111111111111";
const B64 = "aGVsbG8="; // "hello"

describe("base64 + epochString primitives", () => {
  it("accepts valid base64 and rejects non-base64 / empty", () => {
    expect(base64.safeParse(B64).success).toBe(true);
    expect(base64.safeParse("not base64!").success).toBe(false);
    expect(base64.safeParse("").success).toBe(false);
  });

  it("accepts a decimal epoch string and rejects numbers / negatives / non-digits", () => {
    expect(epochString.safeParse("0").success).toBe(true);
    expect(epochString.safeParse("18446744073709551615").success).toBe(true); // u64 max
    expect(epochString.safeParse(0 as unknown as string).success).toBe(false);
    expect(epochString.safeParse("-1").success).toBe(false);
    expect(epochString.safeParse("1.5").success).toBe(false);
  });
});

describe("registerDeviceSchema", () => {
  it("accepts a full device registration", () => {
    expect(
      registerDeviceSchema.safeParse({
        deviceId: "dev-1",
        signaturePublicKey: B64,
        credential: B64,
        ciphersuite: 1,
      }).success
    ).toBe(true);
  });
  it("rejects a missing key / non-base64 key", () => {
    expect(registerDeviceSchema.safeParse({ deviceId: "d", credential: B64, ciphersuite: 1 }).success).toBe(false);
    expect(
      registerDeviceSchema.safeParse({ deviceId: "d", signaturePublicKey: "!!", credential: B64, ciphersuite: 1 }).success
    ).toBe(false);
  });
});

describe("publishKeyPackagesSchema", () => {
  it("accepts 1..100 packages and rejects empty", () => {
    const kp = { keyPackageRef: "ref1", keyPackage: B64, ciphersuite: 1 };
    expect(publishKeyPackagesSchema.safeParse({ keyPackages: [kp] }).success).toBe(true);
    expect(publishKeyPackagesSchema.safeParse({ keyPackages: [] }).success).toBe(false);
  });
});

describe("createSecureConversationSchema", () => {
  it("defaults memberUserIds/welcomes to [] and accepts a dm", () => {
    const parsed = createSecureConversationSchema.safeParse({ type: "dm", mlsGroupId: B64 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.memberUserIds).toEqual([]);
      expect(parsed.data.welcomes).toEqual([]);
    }
  });
  it("rejects an unknown conversation type", () => {
    expect(createSecureConversationSchema.safeParse({ type: "broadcast", mlsGroupId: B64 }).success).toBe(false);
  });
});

describe("addSecureMemberSchema", () => {
  it("requires a commit and at least one welcome", () => {
    expect(
      addSecureMemberSchema.safeParse({
        userId: UUID,
        commit: { payload: B64, epoch: "1" },
        welcomes: [{ targetDeviceId: UUID, payload: B64, epoch: "1" }],
      }).success
    ).toBe(true);
    expect(
      addSecureMemberSchema.safeParse({ userId: UUID, commit: { payload: B64, epoch: "1" }, welcomes: [] }).success
    ).toBe(false);
  });
});

describe("sendSecureMessageSchema", () => {
  it("accepts ciphertext + epoch + senderDeviceId", () => {
    expect(sendSecureMessageSchema.safeParse({ ciphertext: B64, epoch: "3", senderDeviceId: UUID }).success).toBe(true);
  });
  it("rejects a missing epoch or a non-uuid device", () => {
    expect(sendSecureMessageSchema.safeParse({ ciphertext: B64, senderDeviceId: UUID }).success).toBe(false);
    expect(sendSecureMessageSchema.safeParse({ ciphertext: B64, epoch: "3", senderDeviceId: "x" }).success).toBe(false);
  });
});

describe("uploadKeyBackupSchema", () => {
  it("accepts an argon2id backup envelope", () => {
    expect(
      uploadKeyBackupSchema.safeParse({
        blob: B64,
        nonce: B64,
        kdf: "argon2id",
        kdfParams: { salt: B64, m: 65536, t: 3, p: 1 },
        cipher: "xchacha20poly1305",
        version: 1,
      }).success
    ).toBe(true);
  });
  it("rejects an unknown KDF or cipher", () => {
    const ok = { blob: B64, nonce: B64, kdfParams: {}, version: 1 };
    expect(uploadKeyBackupSchema.safeParse({ ...ok, kdf: "md5", cipher: "aes-256-gcm" }).success).toBe(false);
    expect(uploadKeyBackupSchema.safeParse({ ...ok, kdf: "pbkdf2", cipher: "rot13" }).success).toBe(false);
  });
});
