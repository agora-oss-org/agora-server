import { describe, it, expect } from "vitest";
import { MockSecureChatCrypto } from "./mock-crypto.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const contains = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

describe("MockSecureChatCrypto", () => {
  it("round-trips a message across two devices and hides the plaintext", async () => {
    const alice = new MockSecureChatCrypto();
    const bob = new MockSecureChatCrypto();
    await alice.generateDeviceIdentity({ deviceId: "alice-dev" });
    const { identity: bobId } = await bob.generateDeviceIdentity({ deviceId: "bob-dev" });
    const [bobKp] = await bob.generateKeyPackages(1);

    // Alice creates the group with Bob as an initial member, sends a Welcome to Bob's device.
    const { group, welcomes } = await alice.createGroup({
      initialMembers: [{ deviceId: bobId.deviceId, keyPackage: bobKp!.keyPackage }],
    });
    expect(welcomes[0]!.targetDeviceId).toBe("bob-dev");
    const bobGroup = await bob.processWelcome(welcomes[0]!.payload);

    const secret = enc.encode("the eagle lands at midnight");
    const { ciphertext } = await alice.encryptMessage(group, secret);

    // The server-blindness property: the plaintext bytes never appear in the ciphertext.
    expect(contains(ciphertext, secret)).toBe(false);

    const { plaintext, senderDeviceId } = await bob.decryptMessage(bobGroup, ciphertext);
    expect(dec.decode(plaintext)).toBe("the eagle lands at midnight");
    expect(senderDeviceId).toBe("alice-dev");
  });

  it("generates unique key package refs", async () => {
    const c = new MockSecureChatCrypto();
    await c.generateDeviceIdentity({ deviceId: "d" });
    const kps = [...(await c.generateKeyPackages(3)), ...(await c.generateKeyPackages(2))];
    expect(new Set(kps.map((k) => k.keyPackageRef)).size).toBe(5);
  });

  it("restores group state from a passphrase backup, and rejects the wrong passphrase", async () => {
    const a = new MockSecureChatCrypto();
    await a.generateDeviceIdentity({ deviceId: "a" });
    const { group } = await a.createGroup({ initialMembers: [] });
    const msg = enc.encode("remember me");
    const { ciphertext } = await a.encryptMessage(group, msg);
    const backup = await a.exportBackup("correct horse battery staple");

    // A fresh device restores from the backup and can decrypt history.
    const restored = new MockSecureChatCrypto();
    await restored.importBackup("correct horse battery staple", backup);
    const { plaintext } = await restored.decryptMessage(group, ciphertext);
    expect(dec.decode(plaintext)).toBe("remember me");

    const wrong = new MockSecureChatCrypto();
    await expect(wrong.importBackup("hunter2", backup)).rejects.toThrow();
  });
});
