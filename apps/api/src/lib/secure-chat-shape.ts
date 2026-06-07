// Row → API-model shapers for secure chat. Mirror lib/shape.ts conventions (camelCase,
// Date→ISO) with two secure-specific rules: `bytea` (Buffer) columns are base64-encoded for
// the wire, and `bigint` MLS epochs become decimal strings (u64-safe). These shapers ONLY
// ever emit ciphertext/opaque bytes — there is no plaintext to leak.
import type {
  secureDevices, secureConversations, secureConversationMembers,
  secureMessages, secureHandshakeMessages, secureKeyBackups, secureKeyPackages,
} from "../db/schema/index.js";
import type {
  SecureDeviceModel, SecureConversationModel, SecureConversationMemberModel,
  SecureMessageModel, SecureHandshakeModel, SecureKeyBackupModel, SecureKeyPackageClaim,
} from "@agora/contract";

const iso = (d: Date | null | undefined): string | null => (d instanceof Date ? d.toISOString() : null);
const b64 = (buf: Buffer): string => Buffer.from(buf).toString("base64");

type DeviceRow = typeof secureDevices.$inferSelect;
type ConversationRow = typeof secureConversations.$inferSelect;
type MemberRow = typeof secureConversationMembers.$inferSelect;
type MessageRow = typeof secureMessages.$inferSelect;
type HandshakeRow = typeof secureHandshakeMessages.$inferSelect;
type KeyBackupRow = typeof secureKeyBackups.$inferSelect;
type KeyPackageRow = typeof secureKeyPackages.$inferSelect;

export function shapeSecureDevice(row: DeviceRow): SecureDeviceModel {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    deviceId: row.deviceId,
    displayName: row.displayName ?? null,
    signaturePublicKey: b64(row.signaturePublicKey),
    credential: b64(row.credential),
    ciphersuite: row.ciphersuite,
    revokedAt: iso(row.revokedAt),
    lastSeenAt: iso(row.lastSeenAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

export function shapeSecureKeyPackageClaim(row: KeyPackageRow): SecureKeyPackageClaim {
  return {
    deviceId: row.deviceId,
    keyPackageRef: row.keyPackageRef,
    keyPackage: b64(row.keyPackage),
    ciphersuite: row.ciphersuite,
  };
}

export function shapeSecureConversationMember(row: MemberRow): SecureConversationMemberModel {
  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    userId: row.userId,
    role: row.role,
    isActive: row.isActive,
    joinedAtEpoch: row.joinedAtEpoch != null ? String(row.joinedAtEpoch) : null,
    lastReadAt: iso(row.lastReadAt),
    leftAt: iso(row.leftAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

export function shapeSecureConversation(
  row: ConversationRow,
  opts: { memberCount?: number; unreadCount?: number; currentMember?: SecureConversationMemberModel } = {}
): SecureConversationModel {
  const convo: SecureConversationModel = {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    mlsGroupId: b64(row.mlsGroupId),
    spaceId: row.spaceId ?? null,
    currentEpoch: String(row.currentEpoch),
    name: row.name ?? null,
    createdById: row.createdById ?? null,
    lastMessageAt: iso(row.lastMessageAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
  if (opts.memberCount !== undefined) convo.memberCount = opts.memberCount;
  if (opts.unreadCount !== undefined) convo.unreadCount = opts.unreadCount;
  if (opts.currentMember !== undefined) convo.currentMember = opts.currentMember;
  return convo;
}

export function shapeSecureMessage(row: MessageRow): SecureMessageModel {
  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    senderUserId: row.senderUserId ?? null,
    senderDeviceId: row.senderDeviceId ?? null,
    epoch: String(row.epoch),
    ciphertext: b64(row.ciphertext),
    contentType: row.contentType,
    createdAt: iso(row.createdAt)!,
  };
}

export function shapeSecureHandshake(row: HandshakeRow): SecureHandshakeModel {
  return {
    id: row.id,
    seq: String(row.seq),
    kind: row.kind,
    conversationId: row.conversationId,
    epoch: String(row.epoch),
    payload: b64(row.payload),
    senderDeviceId: row.senderDeviceId ?? null,
    targetDeviceId: row.targetDeviceId ?? null,
  };
}

export function shapeSecureKeyBackup(row: KeyBackupRow): SecureKeyBackupModel {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    deviceId: row.deviceId ?? null,
    blob: b64(row.blob),
    nonce: b64(row.nonce),
    kdf: row.kdf,
    kdfParams: (row.kdfParams as Record<string, unknown>) ?? {},
    cipher: row.cipher,
    version: row.version,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}
