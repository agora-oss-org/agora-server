// Secure chat (end-to-end-encrypted, MLS/RFC-9420) — the server's blind Delivery Service.
//
// SEPARATE from the plaintext chat (chat.ts). The server stores/relays OPAQUE bytes only
// (KeyPackages, Welcomes, Commits, application ciphertext, passphrase-encrypted key backups)
// and never reads content — there are deliberately NO content/moderation/embedding columns
// here. Binary is `bytea` (≈33% smaller at rest than base64-text; commits/welcomes get large);
// the wire stays base64 and routes decode→Buffer / encode→base64 at the boundary.
//
// RLS: these tables are enabled deny-all in a custom migration (no SELECT grant, unlike
// plaintext chat) — they are server-only relays with no client-direct read path.
import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, bigint, bigserial, boolean, jsonb, timestamp, index, uniqueIndex, unique, check, customType,
} from "drizzle-orm/pg-core";
import {
  secureConversationType, secureMemberRole, secureHandshakeKind,
} from "./_shared.js";
import { projects, profiles } from "./projects.js";
import { spaces } from "./spaces.js";

// Drizzle has no first-class bytea — map it to Buffer (postgres.js binds Buffer natively).
// (Same customType escape-hatch the PostGIS geography columns use; kept opaque to the app.)
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return "bytea"; },
  toDriver(v) { return v; },
});

// A device = one MLS leaf. Multi-device-ready: no unique on userId alone (v1 registers one).
export const secureDevices = pgTable("secure_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull(),               // client-generated stable id
  displayName: text("display_name"),
  signaturePublicKey: bytea("signature_public_key").notNull(),
  credential: bytea("credential").notNull(),           // serialized MLS Credential
  ciphersuite: integer("ciphersuite").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("secure_devices_user_device_unique").on(t.userId, t.deviceId),
  index("secure_devices_user_idx").on(t.userId, t.revokedAt),
]);

// One-time KeyPackages, consumed-on-claim (claim is atomic FOR UPDATE SKIP LOCKED in the route).
export const secureKeyPackages = pgTable("secure_key_packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => secureDevices.id, { onDelete: "cascade" }),
  keyPackageRef: text("key_package_ref").notNull(),    // opaque dedupe ref (hash) from the client
  keyPackage: bytea("key_package").notNull(),
  ciphersuite: integer("ciphersuite").notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedByUserId: uuid("consumed_by_user_id").references(() => profiles.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("secure_key_packages_ref_unique").on(t.deviceId, t.keyPackageRef),
  // Partial index over the claimable set (the hot path: pick one unconsumed package for a device).
  index("secure_key_packages_claimable_idx").on(t.deviceId).where(sql`consumed_at is null`),
]);

// The MLS group. currentEpoch is the DS's commit-LINEARIZATION counter (optimistic concurrency on
// membership commits) — NOT authoritative MLS state, which the clients hold.
export const secureConversations = pgTable("secure_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  type: secureConversationType("type").notNull(),
  mlsGroupId: bytea("mls_group_id").notNull(),
  spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "cascade" }), // channels only
  currentEpoch: bigint("current_epoch", { mode: "bigint" }).notNull().default(sql`0`),
  name: text("name"),                                  // optional plaintext label (metadata concession)
  createdById: uuid("created_by_id").references(() => profiles.id, { onDelete: "set null" }),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("secure_conversations_mls_group_unique").on(t.projectId, t.mlsGroupId),
  index("secure_conversations_recent_idx").on(t.projectId, t.lastMessageAt.desc()),
  index("secure_conversations_space_idx").on(t.spaceId),
  // space_id is present iff this is a channel.
  check("secure_conversations_channel_space", sql`(${t.type} = 'channel') = (${t.spaceId} is not null)`),
]);

// User-level authorization metadata (NOT the MLS roster — that lives in the clients' group state).
export const secureConversationMembers = pgTable("secure_conversation_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => secureConversations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  role: secureMemberRole("role").notNull().default("member"),
  isActive: boolean("is_active").notNull().default(true),
  joinedAtEpoch: bigint("joined_at_epoch", { mode: "bigint" }),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  leftAt: timestamp("left_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("secure_conversation_members_unique").on(t.conversationId, t.userId),
  index("secure_conversation_members_user_idx").on(t.userId, t.isActive),
]);

// Application ciphertext. No content/edited/mentions/moderation columns — the server can't read it.
export const secureMessages = pgTable("secure_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => secureConversations.id, { onDelete: "cascade" }),
  senderUserId: uuid("sender_user_id").references(() => profiles.id, { onDelete: "set null" }),
  senderDeviceId: uuid("sender_device_id").references(() => secureDevices.id, { onDelete: "set null" }),
  epoch: bigint("epoch", { mode: "bigint" }).notNull(),
  ciphertext: bytea("ciphertext").notNull(),           // serialized MLS PrivateMessage
  contentType: text("content_type").notNull().default("application"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("secure_messages_recent_idx").on(t.conversationId, t.createdAt.desc(), t.id.desc()),
  index("secure_messages_epoch_idx").on(t.conversationId, t.epoch),
]);

// Welcome/Commit/Proposal relay queue. targetDeviceId set → a Welcome to ONE device; null →
// a Commit/Proposal broadcast to the whole group. Delivery uses a client-held `since` cursor (id).
export const secureHandshakeMessages = pgTable("secure_handshake_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Monotonic delivery cursor — clients page handshakes by `seq > since` (UUIDs aren't ordered, and
  // commits MUST be replayed in order). bigserial is process-global; clients store the last seq.
  seq: bigserial("seq", { mode: "bigint" }).notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => secureConversations.id, { onDelete: "cascade" }),
  kind: secureHandshakeKind("kind").notNull(),
  epoch: bigint("epoch", { mode: "bigint" }).notNull(),
  payload: bytea("payload").notNull(),
  senderDeviceId: uuid("sender_device_id").references(() => secureDevices.id, { onDelete: "set null" }),
  targetDeviceId: uuid("target_device_id").references(() => secureDevices.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("secure_handshake_broadcast_idx").on(t.conversationId, t.seq), // commits/proposals (broadcast)
  index("secure_handshake_targeted_idx").on(t.targetDeviceId, t.seq),  // welcomes (per-device inbox)
]);

// Passphrase-encrypted opaque key backup (option 2: history-restore on a new browser). The server
// stores/returns the blob verbatim and CANNOT decrypt it (no passphrase; KDF params alone are useless).
export const secureKeyBackups = pgTable("secure_key_backups", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  deviceId: text("device_id"),                         // multi-device-ready (nullable in v1)
  blob: bytea("blob").notNull(),
  nonce: bytea("nonce").notNull(),
  kdf: text("kdf").notNull(),
  kdfParams: jsonb("kdf_params").notNull().default(sql`'{}'::jsonb`),
  cipher: text("cipher").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("secure_key_backups_user_device_unique").on(t.userId, t.deviceId),
]);

// IUC restore-blob courier (ENVELOPE history restore). An EPHEMERAL, targeted, opaque drop-box: device
// A uploads a client-sealed AEAD blob addressed to a re-provisioned device B; only B fetches it; it is
// DELETEd on confirm and TTL-swept otherwise. The server is blind — there are deliberately NO key /
// sha256 / count / transferId columns (those ride MLS only). RLS deny-all ships in the creating
// migration (the one-time 0017 enablement guard doesn't cover new tables). See docs/RESTORE.md.
export const secureRestoreBlobs = pgTable("secure_restore_blobs", {
  id: uuid("id").primaryKey().defaultRandom(),         // this IS the blobId
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => secureConversations.id, { onDelete: "cascade" }),
  fromDeviceId: uuid("from_device_id").notNull().references(() => secureDevices.id, { onDelete: "cascade" }),     // uploader A
  targetDeviceId: uuid("target_device_id").notNull().references(() => secureDevices.id, { onDelete: "cascade" }), // recipient B
  blob: bytea("blob").notNull(),                        // opaque XChaCha20-Poly1305 ciphertext
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("secure_restore_blobs_target_idx").on(t.targetDeviceId, t.createdAt),   // B's authz lookup + per-target count
  index("secure_restore_blobs_pair_idx").on(t.fromDeviceId, t.targetDeviceId),  // per-pair quota count
  index("secure_restore_blobs_expiry_idx").on(t.expiresAt),                     // cron TTL sweep
]);
