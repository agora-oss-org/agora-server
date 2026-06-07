// Secure chat (end-to-end-encrypted, MLS/RFC-9420) wire contract.
//
// This is a SEPARATE surface from the Replyke-compatible plaintext chat (types.ts /
// schemas.ts) — it is NOT consumed by the forked Replyke SDK. The server is a blind MLS
// Delivery Service: every binary value (KeyPackages, Welcomes, Commits, application
// ciphertext, key-backup blobs) crosses the wire as **base64** and the server never parses
// it. MLS epochs are u64 (exceed JS safe-int) so they travel as **decimal strings**.
//
// Pure zod + TS — no hono/drizzle. Request schemas feed the server's parseBody(); the
// model interfaces are the response shapes the route shapers produce.
import { z } from "zod";

// Base64 (standard alphabet, optional padding). The server enforces the real DECODED byte
// caps (MAX_SECURE_MESSAGE_BYTES / MAX_SECURE_HANDSHAKE_BYTES); this just rejects non-base64
// and an absurd pre-decode length so a garbage body fails fast at validation.
const MAX_B64_CHARS = 16_777_216; // ~12 MiB decoded — generous upper guard, real cap is server-side
export const base64 = z
  .string()
  .min(1)
  .max(MAX_B64_CHARS)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64");

// MLS epoch as a non-negative decimal string (u64-safe on the wire).
export const epochString = z.string().regex(/^\d+$/, "epoch must be a non-negative integer string");

const ciphersuite = z.number().int().positive();

// ─── reusable sub-objects ────────────────────────────────────────────────────
// A Welcome is targeted at the ONE device whose claimed KeyPackage was consumed.
export const welcomeSchema = z.object({
  targetDeviceId: z.string().uuid(),
  payload: base64,
  epoch: epochString,
});
// A Commit/Proposal is broadcast to the whole group (no target device).
export const handshakeBlobSchema = z.object({
  payload: base64,
  epoch: epochString,
});

// ─── request schemas (server: parseBody(schema, raw, "secure-chat")) ─────────
export const registerDeviceSchema = z.object({
  deviceId: z.string().min(1).max(200), // client-generated stable id (one device = one MLS leaf)
  displayName: z.string().max(200).nullish(),
  signaturePublicKey: base64,
  credential: base64,
  ciphersuite,
});

export const publishKeyPackagesSchema = z.object({
  keyPackages: z
    .array(
      z.object({
        keyPackageRef: z.string().min(1).max(512),
        keyPackage: base64,
        ciphersuite,
        expiresAt: z.string().datetime().nullish(),
      })
    )
    .min(1)
    .max(100),
});

export const createSecureConversationSchema = z.object({
  type: z.enum(["dm", "group", "channel"]),
  mlsGroupId: base64,
  spaceId: z.string().uuid().nullish(), // required when type === "channel" (enforced server-side)
  name: z.string().max(300).nullish(), // optional plaintext label; prefer null (metadata concession)
  memberUserIds: z.array(z.string().uuid()).max(1000).default([]),
  welcomes: z.array(welcomeSchema).max(1000).default([]),
});

export const addSecureMemberSchema = z.object({
  userId: z.string().uuid(),
  commit: handshakeBlobSchema,
  welcomes: z.array(welcomeSchema).min(1).max(50),
});

export const removeSecureMemberSchema = z.object({
  commit: handshakeBlobSchema,
});

export const sendSecureMessageSchema = z.object({
  ciphertext: base64,
  epoch: epochString,
  senderDeviceId: z.string().uuid(),
  contentType: z.string().max(100).nullish(),
});

export const uploadKeyBackupSchema = z.object({
  deviceId: z.string().max(200).nullish(),
  blob: base64,
  nonce: base64,
  kdf: z.enum(["argon2id", "pbkdf2"]),
  kdfParams: z.record(z.string(), z.unknown()),
  cipher: z.enum(["xchacha20poly1305", "aes-256-gcm"]),
  version: z.number().int().positive(),
});

// ─── response models (route shapers emit these; base64 binary, string epochs) ─
export interface SecureDeviceModel {
  id: string;
  projectId: string;
  userId: string;
  deviceId: string;
  displayName: string | null;
  signaturePublicKey: string; // base64
  credential: string; // base64
  ciphersuite: number;
  revokedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SecureKeyPackageClaim {
  deviceId: string; // the device row id whose KeyPackage was consumed
  keyPackageRef: string;
  keyPackage: string; // base64
  ciphersuite: number;
}

export interface SecureConversationMemberModel {
  id: string;
  projectId: string;
  conversationId: string;
  userId: string;
  role: "admin" | "member";
  isActive: boolean;
  joinedAtEpoch: string | null;
  lastReadAt: string | null;
  leftAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SecureConversationModel {
  id: string;
  projectId: string;
  type: "dm" | "group" | "channel";
  mlsGroupId: string; // base64
  spaceId: string | null;
  currentEpoch: string;
  name: string | null;
  createdById: string | null;
  lastMessageAt: string | null;
  memberCount?: number;
  unreadCount?: number;
  currentMember?: SecureConversationMemberModel;
  createdAt: string;
  updatedAt: string;
}

export interface SecureMessageModel {
  id: string;
  projectId: string;
  conversationId: string;
  senderUserId: string | null;
  senderDeviceId: string | null;
  epoch: string;
  ciphertext: string; // base64 (opaque MLS application message)
  contentType: string;
  createdAt: string;
}

export interface SecureHandshakeModel {
  id: string;
  seq: string; // monotonic delivery cursor — clients page handshakes by `since` = last seq processed
  kind: "welcome" | "commit" | "proposal";
  conversationId: string;
  epoch: string;
  payload: string; // base64
  senderDeviceId: string | null;
  targetDeviceId: string | null;
}

export interface SecureKeyBackupModel {
  id: string;
  projectId: string;
  userId: string;
  deviceId: string | null;
  blob: string; // base64 (passphrase-encrypted; the server cannot decrypt)
  nonce: string; // base64
  kdf: string;
  kdfParams: Record<string, unknown>;
  cipher: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
