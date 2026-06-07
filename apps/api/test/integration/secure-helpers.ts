// Shared helpers for the secure-chat (E2E) integration suite. The server is a blind relay, so
// these tests drive a real client crypto — the deterministic MockSecureChatCrypto — to produce
// the opaque blobs the API stores, proving the round-trip works without the server ever seeing
// plaintext.
import { MockSecureChatCrypto } from "@agora/secure-chat-core";
import { api, base } from "./helpers.js";

export const b64e = (u8: Uint8Array): string => Buffer.from(u8).toString("base64");
export const b64d = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
export const enc = new TextEncoder();
export const dec = new TextDecoder();

export interface Provisioned {
  crypto: MockSecureChatCrypto;
  rowId: string; // the server device-row uuid (used as targetDeviceId / senderDeviceId)
  deviceId: string; // the client device id string
}

/** Register a device for a user and publish `kpCount` one-time key packages. */
export async function provisionDevice(
  projectId: string,
  user: { id: string; token: string },
  deviceId: string,
  kpCount = 5
): Promise<Provisioned> {
  const crypto = new MockSecureChatCrypto();
  const { identity } = await crypto.generateDeviceIdentity({ deviceId });
  const reg = await api("POST", `${base(projectId)}/secure-chat/devices`, {
    token: user.token,
    body: {
      deviceId,
      signaturePublicKey: b64e(identity.signaturePublicKey),
      credential: b64e(identity.credential),
      ciphersuite: identity.ciphersuite,
    },
  });
  if (reg.status !== 201) throw new Error(`device register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const kps = await crypto.generateKeyPackages(kpCount);
  const pub = await api("POST", `${base(projectId)}/secure-chat/devices/${reg.body.id}/key-packages`, {
    token: user.token,
    body: { keyPackages: kps.map((k) => ({ keyPackageRef: k.keyPackageRef, keyPackage: b64e(k.keyPackage), ciphersuite: k.ciphersuite })) },
  });
  if (pub.status !== 201) throw new Error(`key-package publish failed: ${pub.status} ${JSON.stringify(pub.body)}`);
  return { crypto, rowId: reg.body.id, deviceId };
}

/** Claim one of `target`'s key packages (as `claimer`). Returns the base64 KeyPackage. */
export async function claimKeyPackage(
  projectId: string,
  claimer: { token: string },
  targetRowId: string
): Promise<{ status: number; keyPackage?: string; body: any }> {
  const res = await api("POST", `${base(projectId)}/secure-chat/devices/${targetRowId}/key-packages/claim`, { token: claimer.token });
  return { status: res.status, keyPackage: res.body?.keyPackage, body: res.body };
}
