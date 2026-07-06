// /v7/:projectId/secure-chat/* — the blind MLS Delivery Service (E2E chat).
//
// SEPARATE from the Replyke-compatible plaintext chat (chat.ts). The server stores/relays OPAQUE
// bytes only and never reads content; it enforces membership/authorization + commit ordering on
// those bytes. All crypto is client-side (see @agora-sdk/secure-chat-crypto). Binary crosses the wire as
// base64 and is stored as bytea; MLS epochs are decimal strings on the wire / bigint in the DB.
//
// NOTE: deliberately no analytics/embedding/moderation calls here — secure chat is private by design.
import { Hono } from "hono";
import { and, eq, desc, asc, count, gt, lt, or, inArray, isNull, sql } from "drizzle-orm";
import type { Variables } from "@agora/core/http/context";
import { Errors } from "@agora/core/http/errors";
import { requireAuth } from "@agora/core/middleware/auth";
import { getDb } from "@agora/core/db";
import {
  secureDevices, secureKeyPackages, secureConversations, secureConversationMembers,
  secureMessages, secureHandshakeMessages, secureKeyBackups, secureRestoreBlobs,
} from "@agora/core/db/schema";
import {
  shapeSecureDevice, shapeSecureConversation, shapeSecureConversationMember,
  shapeSecureMessage, shapeSecureHandshake, shapeSecureKeyBackup, shapeSecureRestoreBlob,
} from "../lib/secure-chat-shape.js";
import { assertSpaceAccess } from "../lib/space-access.js";
import {
  parseBody, registerDeviceSchema, publishKeyPackagesSchema, createSecureConversationSchema,
  addSecureMemberSchema, removeSecureMemberSchema, sendSecureMessageSchema, uploadKeyBackupSchema,
  uploadRestoreBlobSchema,
} from "@agora/core/lib/validation";
import { emitToSecureConversation, emitToSecureDevice } from "../realtime/secure-socket.js";
import { env } from "@agora/core/lib/env";
import { logger } from "@agora/core/lib/logger";

type DeviceRow = typeof secureDevices.$inferSelect;
type ConversationRow = typeof secureConversations.$inferSelect;
type MemberRow = typeof secureConversationMembers.$inferSelect;

// How far ahead of the DS's tracked epoch a client may claim to be (the DS can't fully validate
// epochs — it isn't running MLS — so this is a lenient sanity bound against garbage/abuse).
const EPOCH_WINDOW = 1000n;
const KEY_PACKAGE_LOW_WATER = 5;

const b64ToBuf = (s: string): Buffer => Buffer.from(s, "base64");

function assertSize(b64: string, cap: number, code: string): Buffer {
  const buf = b64ToBuf(b64);
  if (buf.length > cap) throw Errors.tooLarge(code, `Payload exceeds ${cap} bytes`);
  return buf;
}

// A device the CALLER owns (by row id), in this project, not revoked.
async function getMyDevice(c: any, deviceId: string): Promise<DeviceRow> {
  const [row] = await getDb().select().from(secureDevices)
    .where(and(
      eq(secureDevices.projectId, c.var.projectId),
      eq(secureDevices.id, deviceId),
      eq(secureDevices.userId, c.var.auth.userId),
      isNull(secureDevices.revokedAt),
    )).limit(1);
  if (!row) throw Errors.notFound("secure-chat/device-not-found", "Device not found");
  return row;
}

async function getSecureConversation(c: any): Promise<ConversationRow> {
  const [row] = await getDb().select().from(secureConversations)
    .where(and(eq(secureConversations.projectId, c.var.projectId), eq(secureConversations.id, c.req.param("id")))).limit(1);
  if (!row) throw Errors.notFound("secure-chat/conversation-not-found", "Conversation not found");
  return row;
}

async function requireSecureMember(c: any, conversationId: string): Promise<MemberRow> {
  const [m] = await getDb().select().from(secureConversationMembers)
    .where(and(
      eq(secureConversationMembers.projectId, c.var.projectId),
      eq(secureConversationMembers.conversationId, conversationId),
      eq(secureConversationMembers.userId, c.var.auth.userId),
      eq(secureConversationMembers.isActive, true),
    )).limit(1);
  if (!m) throw Errors.forbidden("secure-chat/not-a-member", "Not a member of this conversation");
  return m;
}

// Restore-blob fetch/delete authz: does the CALLER own this (non-revoked) device row? Tokens are
// user-scoped, so "only device B may fetch" is enforced at USER granularity (docs/RESTORE.md §3).
async function callerOwnsDevice(c: any, deviceId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: secureDevices.id }).from(secureDevices)
    .where(and(
      eq(secureDevices.projectId, c.var.projectId),
      eq(secureDevices.id, deviceId),
      eq(secureDevices.userId, c.var.auth.userId),
      isNull(secureDevices.revokedAt),
    )).limit(1);
  return !!row;
}

// Resolve a restore-blob target device + assert its owning user is an active member. A missing/revoked
// device OR a non-member owner both throw the SAME 404 — no existence/membership oracle for the target.
async function assertTargetDeviceMember(c: any, conversationId: string, targetDeviceId: string): Promise<void> {
  const [dev] = await getDb().select({ userId: secureDevices.userId }).from(secureDevices)
    .where(and(
      eq(secureDevices.projectId, c.var.projectId),
      eq(secureDevices.id, targetDeviceId),
      isNull(secureDevices.revokedAt),
    )).limit(1);
  const ok = dev && (await getDb().select({ id: secureConversationMembers.id }).from(secureConversationMembers)
    .where(and(
      eq(secureConversationMembers.projectId, c.var.projectId),
      eq(secureConversationMembers.conversationId, conversationId),
      eq(secureConversationMembers.userId, dev.userId),
      eq(secureConversationMembers.isActive, true),
    )).limit(1)).length > 0;
  if (!ok) throw Errors.notFound("secure-chat/restore-target-not-member", "Target device is not a member of this conversation");
}


export const secureChatRoutes = new Hono<{ Variables: Variables }>()
  // ── devices ─────────────────────────────────────────────────────────────────
  .post("/devices", requireAuth, async (c) => {
    const me = c.var.auth!.userId;
    const body = parseBody(registerDeviceSchema, await c.req.json().catch(() => ({})), "secure-chat");
    const sig = assertSize(body.signaturePublicKey, env.MAX_SECURE_HANDSHAKE_BYTES, "secure-chat/invalid-key");
    const cred = assertSize(body.credential, env.MAX_SECURE_HANDSHAKE_BYTES, "secure-chat/invalid-key");
    const [row] = await getDb().insert(secureDevices)
      .values({
        projectId: c.var.projectId, userId: me, deviceId: body.deviceId, displayName: body.displayName ?? null,
        signaturePublicKey: sig, credential: cred, ciphersuite: body.ciphersuite,
      })
      .onConflictDoUpdate({
        target: [secureDevices.userId, secureDevices.deviceId],
        set: { signaturePublicKey: sig, credential: cred, ciphersuite: body.ciphersuite, displayName: body.displayName ?? null, revokedAt: null, updatedAt: new Date() },
      })
      .returning();
    logger.debug({ projectId: c.var.projectId, userId: me, deviceId: body.deviceId, deviceRowId: row!.id, ciphersuite: body.ciphersuite, hasDisplayName: !!body.displayName }, "secure-chat: device registered");
    return c.json(shapeSecureDevice(row!), 201);
  })
  .get("/devices", requireAuth, async (c) => {
    // Public device records for a user (signature key + credential) so peers can build a group.
    const userId = c.req.query("userId");
    if (!userId) throw Errors.badRequest("secure-chat/missing-user", "userId query param required", "userId");
    const rows = await getDb().select().from(secureDevices)
      .where(and(eq(secureDevices.projectId, c.var.projectId), eq(secureDevices.userId, userId), isNull(secureDevices.revokedAt)))
      .orderBy(asc(secureDevices.createdAt));
    return c.json({ data: rows.map(shapeSecureDevice) });
  })
  .delete("/devices/:deviceId", requireAuth, async (c) => {
    const dev = await getMyDevice(c, c.req.param("deviceId"));
    await getDb().update(secureDevices).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(secureDevices.id, dev.id));
    logger.debug({ projectId: c.var.projectId, userId: c.var.auth!.userId, deviceRowId: dev.id, deviceId: dev.deviceId }, "secure-chat: device revoked");
    return c.json({ success: true });
  })
  // ── key packages ──────────────────────────────────────────────────────────
  .post("/devices/:deviceId/key-packages", requireAuth, async (c) => {
    const dev = await getMyDevice(c, c.req.param("deviceId"));
    const body = parseBody(publishKeyPackagesSchema, await c.req.json().catch(() => ({})), "secure-chat");
    const values = body.keyPackages.map((kp) => ({
      projectId: c.var.projectId, deviceId: dev.id, keyPackageRef: kp.keyPackageRef,
      keyPackage: assertSize(kp.keyPackage, env.MAX_SECURE_HANDSHAKE_BYTES, "secure-chat/key-package-too-large"),
      ciphersuite: kp.ciphersuite, expiresAt: kp.expiresAt ? new Date(kp.expiresAt) : null,
    }));
    const inserted = await getDb().insert(secureKeyPackages).values(values)
      .onConflictDoNothing({ target: [secureKeyPackages.deviceId, secureKeyPackages.keyPackageRef] })
      .returning({ id: secureKeyPackages.id });
    logger.debug({ projectId: c.var.projectId, deviceRowId: dev.id, submitted: values.length, published: inserted.length }, "secure-chat: key packages published");
    return c.json({ published: inserted.length }, 201);
  })
  .get("/devices/:deviceId/key-packages/count", requireAuth, async (c) => {
    const dev = await getMyDevice(c, c.req.param("deviceId"));
    const [{ n } = { n: 0 }] = await getDb().select({ n: count() }).from(secureKeyPackages)
      .where(and(eq(secureKeyPackages.deviceId, dev.id), isNull(secureKeyPackages.consumedAt),
        or(isNull(secureKeyPackages.expiresAt), gt(secureKeyPackages.expiresAt, new Date()))));
    logger.trace({ projectId: c.var.projectId, deviceRowId: dev.id, available: n }, "secure-chat: key packages counted");
    return c.json({ available: n });
  })
  .post("/devices/:deviceId/key-packages/claim", requireAuth, async (c) => {
    // Any authed user claims a one-time KeyPackage for the TARGET device (to add it to a group).
    const targetDeviceId = c.req.param("deviceId");
    const me = c.var.auth!.userId;
    const [dev] = await getDb().select({ id: secureDevices.id, userId: secureDevices.userId }).from(secureDevices)
      .where(and(eq(secureDevices.projectId, c.var.projectId), eq(secureDevices.id, targetDeviceId), isNull(secureDevices.revokedAt))).limit(1);
    if (!dev) throw Errors.notFound("secure-chat/device-not-found", "Device not found");
    // Atomic claim: lock one unconsumed, unexpired package and consume it.
    const claimed = (await getDb().execute(sql`
      update secure_key_packages set consumed_at = now(), consumed_by_user_id = ${me}::uuid
      where id = (
        select id from secure_key_packages
        where device_id = ${targetDeviceId}::uuid and consumed_at is null
          and (expires_at is null or expires_at > now())
        order by created_at asc
        for update skip locked
        limit 1
      )
      returning device_id, key_package_ref, key_package, ciphersuite
    `)) as unknown as { device_id: string; key_package_ref: string; key_package: Buffer; ciphersuite: number }[];
    const r = claimed[0];
    if (!r) {
      logger.debug({ projectId: c.var.projectId, targetDeviceId, claimedByUserId: me }, "secure-chat: key package claim found none (exhausted)");
      throw Errors.conflict("secure-chat/key-packages-exhausted", "No key packages available for this device");
    }
    // Nudge the device owner to replenish if we're running low.
    const [{ n } = { n: 0 }] = await getDb().select({ n: count() }).from(secureKeyPackages)
      .where(and(eq(secureKeyPackages.deviceId, targetDeviceId), isNull(secureKeyPackages.consumedAt),
        or(isNull(secureKeyPackages.expiresAt), gt(secureKeyPackages.expiresAt, new Date()))));
    logger.debug({ projectId: c.var.projectId, targetDeviceId, claimedByUserId: me, keyPackageRef: r.key_package_ref, remaining: n }, "secure-chat: key package claimed");
    if (n < KEY_PACKAGE_LOW_WATER) {
      logger.trace({ projectId: c.var.projectId, targetDeviceId, available: n, lowWater: KEY_PACKAGE_LOW_WATER }, "secure-chat: key packages low, nudging device");
      emitToSecureDevice(targetDeviceId, "secure:key-packages-low", { deviceId: targetDeviceId, available: n });
    }
    return c.json({
      deviceId: r.device_id, keyPackageRef: r.key_package_ref,
      keyPackage: Buffer.from(r.key_package).toString("base64"), ciphersuite: r.ciphersuite,
    });
  })
  // ── handshakes (Welcome/Commit/Proposal) inbox for a device ─────────────────
  .get("/devices/:deviceId/handshakes", requireAuth, async (c) => {
    const dev = await getMyDevice(c, c.req.param("deviceId"));
    const me = c.var.auth!.userId;
    const since = (() => { try { return BigInt(c.req.query("since") ?? "0"); } catch { return 0n; } })();
    const limit = Math.min(Number(c.req.query("limit")) || 100, 500);
    // The caller's active conversations (broadcast Commits/Proposals are visible to all members).
    const convRows = await getDb().select({ id: secureConversationMembers.conversationId }).from(secureConversationMembers)
      .where(and(eq(secureConversationMembers.projectId, c.var.projectId), eq(secureConversationMembers.userId, me), eq(secureConversationMembers.isActive, true)));
    const convIds = convRows.map((r) => r.id);
    const broadcastCond = convIds.length
      ? and(isNull(secureHandshakeMessages.targetDeviceId), inArray(secureHandshakeMessages.conversationId, convIds))
      : sql`false`;
    const rows = await getDb().select().from(secureHandshakeMessages)
      .where(and(
        eq(secureHandshakeMessages.projectId, c.var.projectId),
        gt(secureHandshakeMessages.seq, since),
        or(eq(secureHandshakeMessages.targetDeviceId, dev.id), broadcastCond),
      ))
      .orderBy(asc(secureHandshakeMessages.seq))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const delivered = rows.slice(0, limit);
    logger.trace({ projectId: c.var.projectId, deviceRowId: dev.id, userId: me, since: String(since), limit, returned: delivered.length, hasMore, activeConvs: convIds.length }, "secure-chat: handshakes polled");
    if (delivered.length) {
      // The per-row breakdown is the core diagnostic for the "waiting for key update" failure:
      // `targeted:true` = a Welcome addressed to THIS device row; `targeted:false` = a broadcast
      // Commit/Proposal. A device that never sees a targeted Welcome can't build its local group.
      logger.debug({
        projectId: c.var.projectId, deviceRowId: dev.id,
        delivered: delivered.map((r) => ({ seq: String(r.seq), kind: r.kind, epoch: String(r.epoch), targeted: !!r.targetDeviceId, conversationId: r.conversationId })),
      }, "secure-chat: handshakes delivered");
    }
    return c.json({ handshakes: delivered.map(shapeSecureHandshake), hasMore });
  })
  // ── passphrase key backup (opaque; server can't decrypt) ────────────────────
  .put("/key-backup", requireAuth, async (c) => {
    const me = c.var.auth!.userId;
    const body = parseBody(uploadKeyBackupSchema, await c.req.json().catch(() => ({})), "secure-chat");
    const blob = assertSize(body.blob, env.MAX_SECURE_HANDSHAKE_BYTES, "secure-chat/backup-too-large");
    const nonce = b64ToBuf(body.nonce);
    const deviceId = body.deviceId ?? null;
    // Manual upsert: a NULL deviceId won't match the unique constraint, so match with IS NOT DISTINCT FROM.
    const [existing] = await getDb().select({ id: secureKeyBackups.id }).from(secureKeyBackups)
      .where(and(eq(secureKeyBackups.projectId, c.var.projectId), eq(secureKeyBackups.userId, me), sql`${secureKeyBackups.deviceId} is not distinct from ${deviceId}`)).limit(1);
    if (existing) {
      const [row] = await getDb().update(secureKeyBackups)
        .set({ blob, nonce, kdf: body.kdf, kdfParams: body.kdfParams, cipher: body.cipher, version: body.version, updatedAt: new Date() })
        .where(eq(secureKeyBackups.id, existing.id)).returning();
      logger.debug({ projectId: c.var.projectId, userId: me, deviceId, mode: "update", blobBytes: blob.length, version: body.version }, "secure-chat: key backup stored");
      return c.json({ success: true, updatedAt: row!.updatedAt.toISOString() });
    }
    const [row] = await getDb().insert(secureKeyBackups)
      .values({ projectId: c.var.projectId, userId: me, deviceId, blob, nonce, kdf: body.kdf, kdfParams: body.kdfParams, cipher: body.cipher, version: body.version })
      .returning();
    logger.debug({ projectId: c.var.projectId, userId: me, deviceId, mode: "insert", blobBytes: blob.length, version: body.version }, "secure-chat: key backup stored");
    return c.json({ success: true, updatedAt: row!.updatedAt.toISOString() }, 201);
  })
  .get("/key-backup", requireAuth, async (c) => {
    const me = c.var.auth!.userId;
    const deviceId = c.req.query("deviceId") ?? null;
    const [row] = await getDb().select().from(secureKeyBackups)
      .where(and(eq(secureKeyBackups.projectId, c.var.projectId), eq(secureKeyBackups.userId, me), sql`${secureKeyBackups.deviceId} is not distinct from ${deviceId}`)).limit(1);
    if (!row) {
      // Benign: the SDK probes for a backup on bootstrap and treats 404 as "none yet" (→ null).
      logger.trace({ projectId: c.var.projectId, userId: me, deviceId }, "secure-chat: key backup miss (none stored)");
      throw Errors.notFound("secure-chat/backup-not-found", "No key backup found");
    }
    logger.trace({ projectId: c.var.projectId, userId: me, deviceId }, "secure-chat: key backup fetched");
    return c.json(shapeSecureKeyBackup(row));
  })
  // ── IUC restore blobs (ephemeral, targeted, opaque courier — docs/RESTORE.md) ─
  .post("/restore-blobs", requireAuth, async (c) => {
    const body = parseBody(uploadRestoreBlobSchema, await c.req.json().catch(() => ({})), "secure-chat");
    // Caller owns uploader A (404), is a member (403), and the target's user is a member (404).
    await getMyDevice(c, body.fromDeviceId);
    await requireSecureMember(c, body.conversationId);
    await assertTargetDeviceMember(c, body.conversationId, body.targetDeviceId);
    const blob = assertSize(body.blob, env.MAX_SECURE_RESTORE_BLOB_BYTES, "secure-chat/restore-blob-too-large");
    // Quota over UNEXPIRED outstanding blobs: per (A→B) pair, then aggregate per target B (429).
    const now = new Date();
    const [{ pair } = { pair: 0 }] = await getDb().select({ pair: count() }).from(secureRestoreBlobs)
      .where(and(
        eq(secureRestoreBlobs.fromDeviceId, body.fromDeviceId),
        eq(secureRestoreBlobs.targetDeviceId, body.targetDeviceId),
        gt(secureRestoreBlobs.expiresAt, now),
      ));
    if (pair >= env.MAX_SECURE_RESTORE_BLOBS_PER_PAIR) {
      logger.debug({ projectId: c.var.projectId, fromDeviceId: body.fromDeviceId, targetDeviceId: body.targetDeviceId, outstanding: pair, cap: env.MAX_SECURE_RESTORE_BLOBS_PER_PAIR }, "secure-chat: restore-blob pair quota exceeded");
      throw Errors.rateLimited("Too many outstanding restore blobs for this recipient");
    }
    const [{ tgt } = { tgt: 0 }] = await getDb().select({ tgt: count() }).from(secureRestoreBlobs)
      .where(and(eq(secureRestoreBlobs.targetDeviceId, body.targetDeviceId), gt(secureRestoreBlobs.expiresAt, now)));
    if (tgt >= env.MAX_SECURE_RESTORE_BLOBS_PER_TARGET) {
      logger.debug({ projectId: c.var.projectId, targetDeviceId: body.targetDeviceId, outstanding: tgt, cap: env.MAX_SECURE_RESTORE_BLOBS_PER_TARGET }, "secure-chat: restore-blob target quota exceeded");
      throw Errors.rateLimited("Too many outstanding restore blobs for this recipient");
    }
    const expiresAt = new Date(now.getTime() + env.SECURE_RESTORE_BLOB_TTL_SECONDS * 1000);
    const [row] = await getDb().insert(secureRestoreBlobs)
      .values({ projectId: c.var.projectId, conversationId: body.conversationId, fromDeviceId: body.fromDeviceId, targetDeviceId: body.targetDeviceId, blob, expiresAt })
      .returning({ id: secureRestoreBlobs.id });
    // Latency nicety: nudge the target device. Payload is conversationId ONLY (no blobId/key).
    emitToSecureDevice(body.targetDeviceId, "secure:restore-blob-available", { conversationId: body.conversationId });
    logger.debug({ projectId: c.var.projectId, conversationId: body.conversationId, fromDeviceId: body.fromDeviceId, targetDeviceId: body.targetDeviceId, blobId: row!.id, blobBytes: blob.length, expiresAt: expiresAt.toISOString() }, "secure-chat: restore blob uploaded");
    return c.json({ blobId: row!.id, expiresAt: expiresAt.toISOString() }, 201);
  })
  .get("/restore-blobs/:blobId", requireAuth, async (c) => {
    // Non-destructive (B may retry before persisting). 404 on miss/expired OR caller-not-owner — one
    // code, no existence oracle for non-recipients.
    const [row] = await getDb().select().from(secureRestoreBlobs)
      .where(and(
        eq(secureRestoreBlobs.projectId, c.var.projectId),
        eq(secureRestoreBlobs.id, c.req.param("blobId")),
        gt(secureRestoreBlobs.expiresAt, new Date()),
      )).limit(1);
    if (!row || !(await callerOwnsDevice(c, row.targetDeviceId))) {
      logger.trace({ projectId: c.var.projectId, userId: c.var.auth!.userId, blobId: c.req.param("blobId"), found: !!row }, "secure-chat: restore blob fetch miss");
      throw Errors.notFound("secure-chat/restore-blob-not-found", "Restore blob not found");
    }
    logger.trace({ projectId: c.var.projectId, blobId: row.id, targetDeviceId: row.targetDeviceId }, "secure-chat: restore blob fetched");
    return c.json(shapeSecureRestoreBlob(row));
  })
  .delete("/restore-blobs/:blobId", requireAuth, async (c) => {
    // Confirm + remove (after B has persisted). Same authz + single 404 code as GET.
    const [row] = await getDb().select({ id: secureRestoreBlobs.id, targetDeviceId: secureRestoreBlobs.targetDeviceId }).from(secureRestoreBlobs)
      .where(and(eq(secureRestoreBlobs.projectId, c.var.projectId), eq(secureRestoreBlobs.id, c.req.param("blobId")))).limit(1);
    if (!row || !(await callerOwnsDevice(c, row.targetDeviceId))) {
      throw Errors.notFound("secure-chat/restore-blob-not-found", "Restore blob not found");
    }
    await getDb().delete(secureRestoreBlobs).where(eq(secureRestoreBlobs.id, row.id));
    logger.debug({ projectId: c.var.projectId, blobId: row.id, targetDeviceId: row.targetDeviceId }, "secure-chat: restore blob deleted");
    return c.body(null, 204);
  })
  // ── conversations ────────────────────────────────────────────────────────────
  .post("/conversations", requireAuth, async (c) => {
    const me = c.var.auth!.userId;
    const body = parseBody(createSecureConversationSchema, await c.req.json().catch(() => ({})), "secure-chat");
    if (body.type === "channel") {
      if (!body.spaceId) throw Errors.badRequest("secure-chat/channel-needs-space", "Channels require a spaceId", "spaceId");
      await assertSpaceAccess(c.var.projectId, body.spaceId, c.var.auth!.userId);
    } else if (body.spaceId) {
      throw Errors.badRequest("secure-chat/space-only-channel", "spaceId is only valid for channels", "spaceId");
    }
    const mlsGroupId = b64ToBuf(body.mlsGroupId);
    const welcomeValues = (body.welcomes ?? []).map((w) => ({
      projectId: c.var.projectId, conversationId: "", kind: "welcome" as const, epoch: BigInt(w.epoch),
      payload: assertSize(w.payload, env.MAX_SECURE_HANDSHAKE_BYTES, "secure-chat/welcome-too-large"),
      targetDeviceId: w.targetDeviceId, senderDeviceId: null,
    }));
    // A conversation created with peers already added in one shot (the DM/group case) ships its
    // Welcomes at the POST-add epoch — the creation Commit already advanced the MLS group past 0. Seed
    // currentEpoch from those Welcomes so the DS linearization counter matches the real group epoch;
    // leaving it at the column default 0 desyncs the counter and makes the NEXT commit (add member, or
    // add a newly-registered device) fail the `currentEpoch == newEpoch - 1` guard with a spurious
    // secure-chat/epoch-conflict. No Welcomes (solo group) → stays at epoch 0.
    const initialEpoch = welcomeValues.reduce((mx, w) => (w.epoch > mx ? w.epoch : mx), 0n);
    let result: { convo: ConversationRow; welcomeRows: (typeof secureHandshakeMessages.$inferSelect)[]; memberCount: number };
    try {
      result = await getDb().transaction(async (tx) => {
        const [convo] = await tx.insert(secureConversations)
          .values({ projectId: c.var.projectId, type: body.type, mlsGroupId, spaceId: body.spaceId ?? null, name: body.name ?? null, createdById: me, currentEpoch: initialEpoch })
          .returning();
        const memberIds = [...new Set([me, ...(body.memberUserIds ?? [])])];
        await tx.insert(secureConversationMembers).values(memberIds.map((uid) => ({
          projectId: c.var.projectId, conversationId: convo!.id, userId: uid,
          role: uid === me ? ("admin" as const) : ("member" as const), joinedAtEpoch: 0n,
        }))).onConflictDoNothing();
        let welcomeRows: (typeof secureHandshakeMessages.$inferSelect)[] = [];
        if (welcomeValues.length) {
          welcomeRows = await tx.insert(secureHandshakeMessages)
            .values(welcomeValues.map((w) => ({ ...w, conversationId: convo!.id }))).returning();
        }
        return { convo: convo!, welcomeRows, memberCount: memberIds.length };
      });
    } catch (e: any) {
      // Drizzle wraps the postgres.js error, so the unique-violation code lives on `.cause`.
      if (e?.code === "23505" || e?.cause?.code === "23505") {
        throw Errors.conflict("secure-chat/duplicate-group", "An MLS group with this id already exists");
      }
      throw e;
    }
    for (const w of result.welcomeRows) {
      if (w.targetDeviceId) {
        emitToSecureDevice(w.targetDeviceId, "secure:welcome", shapeSecureHandshake(w));
        logger.trace({ projectId: c.var.projectId, conversationId: result.convo.id, targetDeviceId: w.targetDeviceId, seq: String(w.seq), epoch: String(w.epoch) }, "secure-chat: welcome emitted");
      }
    }
    logger.debug({ projectId: c.var.projectId, conversationId: result.convo.id, type: result.convo.type, members: result.memberCount, initialEpoch: String(initialEpoch), welcomes: result.welcomeRows.length }, "secure-chat: conversation created");
    return c.json(shapeSecureConversation(result.convo, { memberCount: result.memberCount }), 201);
  })
  .get("/conversations", requireAuth, async (c) => {
    const me = c.var.auth!.userId;
    const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
    const boundary = c.req.query("cursor"); // ISO timestamp of COALESCE(lastMessageAt, createdAt)
    const conds = [
      eq(secureConversationMembers.projectId, c.var.projectId),
      eq(secureConversationMembers.userId, me),
      eq(secureConversationMembers.isActive, true),
    ];
    if (boundary) conds.push(sql`COALESCE(${secureConversations.lastMessageAt}, ${secureConversations.createdAt}) < ${boundary}::timestamptz`);
    const rows = await getDb().select({ convo: secureConversations, member: secureConversationMembers })
      .from(secureConversationMembers)
      .innerJoin(secureConversations, eq(secureConversations.id, secureConversationMembers.conversationId))
      .where(and(...conds))
      .orderBy(sql`COALESCE(${secureConversations.lastMessageAt}, ${secureConversations.createdAt}) DESC`)
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const conversations = await Promise.all(rows.slice(0, limit).map(async ({ convo, member }) => {
      const [{ mc } = { mc: 0 }] = await getDb().select({ mc: count() }).from(secureConversationMembers)
        .where(and(eq(secureConversationMembers.conversationId, convo.id), eq(secureConversationMembers.isActive, true)));
      const [{ u } = { u: 0 }] = await getDb().select({ u: count() }).from(secureMessages)
        .where(and(eq(secureMessages.conversationId, convo.id), member.lastReadAt ? gt(secureMessages.createdAt, member.lastReadAt) : sql`true`));
      return shapeSecureConversation(convo, { memberCount: mc, unreadCount: u, currentMember: shapeSecureConversationMember(member) });
    }));
    return c.json({ conversations, hasMore });
  })
  .get("/conversations/:id", requireAuth, async (c) => {
    const convo = await getSecureConversation(c);
    const member = await requireSecureMember(c, convo.id);
    const [{ mc } = { mc: 0 }] = await getDb().select({ mc: count() }).from(secureConversationMembers)
      .where(and(eq(secureConversationMembers.conversationId, convo.id), eq(secureConversationMembers.isActive, true)));
    return c.json(shapeSecureConversation(convo, { memberCount: mc, currentMember: shapeSecureConversationMember(member) }));
  })
  .post("/conversations/:id/read", requireAuth, async (c) => {
    const convo = await getSecureConversation(c);
    await requireSecureMember(c, convo.id);
    await getDb().update(secureConversationMembers).set({ lastReadAt: new Date(), updatedAt: new Date() })
      .where(and(eq(secureConversationMembers.conversationId, convo.id), eq(secureConversationMembers.userId, c.var.auth!.userId)));
    return c.json({ success: true });
  })
  // ── membership (client supplies the MLS Commit + Welcomes; the DS linearizes by epoch) ──
  .post("/conversations/:id/members", requireAuth, async (c) => {
    const convo = await getSecureConversation(c);
    const member = await requireSecureMember(c, convo.id);
    if (member.role !== "admin") throw Errors.forbidden("secure-chat/not-admin", "Admin only");
    const body = parseBody(addSecureMemberSchema, await c.req.json().catch(() => ({})), "secure-chat");
    const newEpoch = BigInt(body.commit.epoch);
    const commitBuf = assertSize(body.commit.payload, env.MAX_SECURE_HANDSHAKE_BYTES, "secure-chat/commit-too-large");
    const welcomeValues = body.welcomes.map((w) => ({
      projectId: c.var.projectId, conversationId: convo.id, kind: "welcome" as const, epoch: BigInt(w.epoch),
      payload: assertSize(w.payload, env.MAX_SECURE_HANDSHAKE_BYTES, "secure-chat/welcome-too-large"),
      targetDeviceId: w.targetDeviceId, senderDeviceId: null,
    }));
    const out = await getDb().transaction(async (tx) => {
      // Optimistic commit ordering: only advance if we're exactly one epoch behind the commit.
      const bumped = await tx.update(secureConversations).set({ currentEpoch: newEpoch, updatedAt: new Date() })
        .where(and(eq(secureConversations.id, convo.id), eq(secureConversations.currentEpoch, newEpoch - 1n))).returning({ id: secureConversations.id });
      if (!bumped.length) {
        logger.debug({ projectId: c.var.projectId, conversationId: convo.id, op: "add-member", addUserId: body.userId, attemptedEpoch: String(newEpoch), expectedPrev: String(newEpoch - 1n), dsEpoch: String(convo.currentEpoch) }, "secure-chat: epoch conflict (commit must rebase)");
        throw Errors.conflict("secure-chat/epoch-conflict", "Conversation epoch advanced; rebase your commit");
      }
      const [mrow] = await tx.insert(secureConversationMembers)
        .values({ projectId: c.var.projectId, conversationId: convo.id, userId: body.userId, role: "member", joinedAtEpoch: newEpoch })
        .onConflictDoUpdate({ target: [secureConversationMembers.conversationId, secureConversationMembers.userId], set: { isActive: true, leftAt: null, joinedAtEpoch: newEpoch, updatedAt: new Date() } })
        .returning();
      const [commitRow] = await tx.insert(secureHandshakeMessages)
        .values({ projectId: c.var.projectId, conversationId: convo.id, kind: "commit", epoch: newEpoch, payload: commitBuf, targetDeviceId: null, senderDeviceId: null }).returning();
      const welcomeRows = welcomeValues.length ? await tx.insert(secureHandshakeMessages).values(welcomeValues).returning() : [];
      return { mrow: mrow!, commitRow: commitRow!, welcomeRows };
    });
    emitToSecureConversation(convo.id, "secure:handshake", shapeSecureHandshake(out.commitRow));
    emitToSecureConversation(convo.id, "secure:member:joined", { conversationId: convo.id, userId: body.userId, epoch: String(newEpoch) });
    for (const w of out.welcomeRows) {
      if (w.targetDeviceId) {
        emitToSecureDevice(w.targetDeviceId, "secure:welcome", shapeSecureHandshake(w));
        logger.trace({ projectId: c.var.projectId, conversationId: convo.id, targetDeviceId: w.targetDeviceId, seq: String(w.seq), epoch: String(w.epoch) }, "secure-chat: welcome emitted");
      }
    }
    logger.debug({ projectId: c.var.projectId, conversationId: convo.id, addUserId: body.userId, epoch: String(newEpoch), commitSeq: String(out.commitRow.seq), welcomes: out.welcomeRows.length }, "secure-chat: member added");
    return c.json(shapeSecureConversationMember(out.mrow), 201);
  })
  .delete("/conversations/:id/members/:userId", requireAuth, async (c) => {
    const convo = await getSecureConversation(c);
    const member = await requireSecureMember(c, convo.id);
    const target = c.req.param("userId");
    const isSelfLeave = target === c.var.auth!.userId;
    if (!isSelfLeave && member.role !== "admin") throw Errors.forbidden("secure-chat/not-admin", "Admin only");
    const body = parseBody(removeSecureMemberSchema, await c.req.json().catch(() => ({})), "secure-chat");
    const newEpoch = BigInt(body.commit.epoch);
    const commitBuf = assertSize(body.commit.payload, env.MAX_SECURE_HANDSHAKE_BYTES, "secure-chat/commit-too-large");
    const out = await getDb().transaction(async (tx) => {
      const bumped = await tx.update(secureConversations).set({ currentEpoch: newEpoch, updatedAt: new Date() })
        .where(and(eq(secureConversations.id, convo.id), eq(secureConversations.currentEpoch, newEpoch - 1n))).returning({ id: secureConversations.id });
      if (!bumped.length) {
        logger.debug({ projectId: c.var.projectId, conversationId: convo.id, op: "remove-member", removeUserId: target, attemptedEpoch: String(newEpoch), expectedPrev: String(newEpoch - 1n), dsEpoch: String(convo.currentEpoch) }, "secure-chat: epoch conflict (commit must rebase)");
        throw Errors.conflict("secure-chat/epoch-conflict", "Conversation epoch advanced; rebase your commit");
      }
      await tx.update(secureConversationMembers).set({ isActive: false, leftAt: new Date(), updatedAt: new Date() })
        .where(and(eq(secureConversationMembers.conversationId, convo.id), eq(secureConversationMembers.userId, target)));
      const [commitRow] = await tx.insert(secureHandshakeMessages)
        .values({ projectId: c.var.projectId, conversationId: convo.id, kind: "commit", epoch: newEpoch, payload: commitBuf, targetDeviceId: null, senderDeviceId: null }).returning();
      return { commitRow: commitRow! };
    });
    emitToSecureConversation(convo.id, "secure:handshake", shapeSecureHandshake(out.commitRow));
    emitToSecureConversation(convo.id, "secure:member:left", { conversationId: convo.id, userId: target, epoch: String(newEpoch) });
    logger.debug({ projectId: c.var.projectId, conversationId: convo.id, removeUserId: target, selfLeave: isSelfLeave, epoch: String(newEpoch), commitSeq: String(out.commitRow.seq) }, "secure-chat: member removed");
    return c.json({ success: true, epoch: String(newEpoch) });
  })
  // ── messages (opaque application ciphertext) ────────────────────────────────
  .post("/conversations/:id/messages", requireAuth, async (c) => {
    const convo = await getSecureConversation(c);
    await requireSecureMember(c, convo.id);
    const me = c.var.auth!.userId;
    const body = parseBody(sendSecureMessageSchema, await c.req.json().catch(() => ({})), "secure-chat");
    const [dev] = await getDb().select({ id: secureDevices.id }).from(secureDevices)
      .where(and(eq(secureDevices.projectId, c.var.projectId), eq(secureDevices.id, body.senderDeviceId), eq(secureDevices.userId, me), isNull(secureDevices.revokedAt))).limit(1);
    if (!dev) {
      logger.debug({ projectId: c.var.projectId, conversationId: convo.id, userId: me, senderDeviceId: body.senderDeviceId }, "secure-chat: message rejected (device mismatch)");
      throw Errors.forbidden("secure-chat/device-mismatch", "senderDeviceId does not belong to you");
    }
    const epoch = BigInt(body.epoch);
    if (epoch > convo.currentEpoch + EPOCH_WINDOW) {
      logger.debug({ projectId: c.var.projectId, conversationId: convo.id, msgEpoch: String(epoch), dsEpoch: String(convo.currentEpoch), window: String(EPOCH_WINDOW) }, "secure-chat: message rejected (epoch out of range)");
      throw Errors.badRequest("secure-chat/epoch-out-of-range", "Message epoch is implausibly far ahead", "epoch");
    }
    const ciphertext = assertSize(body.ciphertext, env.MAX_SECURE_MESSAGE_BYTES, "secure-chat/message-too-large");
    const [row] = await getDb().insert(secureMessages)
      .values({ projectId: c.var.projectId, conversationId: convo.id, senderUserId: me, senderDeviceId: dev.id, epoch, ciphertext, contentType: body.contentType ?? "application" })
      .returning();
    const shaped = shapeSecureMessage(row!);
    emitToSecureConversation(convo.id, "secure:message", shaped);
    logger.debug({ projectId: c.var.projectId, conversationId: convo.id, senderUserId: me, senderDeviceId: dev.id, epoch: String(epoch), dsEpoch: String(convo.currentEpoch), bytes: ciphertext.length, contentType: body.contentType ?? "application" }, "secure-chat: message sent");
    return c.json(shaped, 201);
  })
  .get("/conversations/:id/messages", requireAuth, async (c) => {
    const convo = await getSecureConversation(c);
    await requireSecureMember(c, convo.id);
    const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
    const before = c.req.query("before"); // ISO timestamp keyset cursor
    const conds = [eq(secureMessages.conversationId, convo.id)];
    if (before) conds.push(lt(secureMessages.createdAt, new Date(before)));
    const rows = await getDb().select().from(secureMessages)
      .where(and(...conds))
      .orderBy(desc(secureMessages.createdAt), desc(secureMessages.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    logger.trace({ projectId: c.var.projectId, conversationId: convo.id, returned: Math.min(rows.length, limit), hasMore, before: before ?? null }, "secure-chat: messages listed");
    return c.json({ messages: rows.slice(0, limit).map(shapeSecureMessage), hasMore });
  });
