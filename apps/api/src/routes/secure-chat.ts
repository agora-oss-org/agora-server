// /v7/:projectId/secure-chat/* — the blind MLS Delivery Service (E2E chat).
//
// SEPARATE from the Replyke-compatible plaintext chat (chat.ts). The server stores/relays OPAQUE
// bytes only and never reads content; it enforces membership/authorization + commit ordering on
// those bytes. All crypto is client-side (see @agora/secure-chat-core). Binary crosses the wire as
// base64 and is stored as bytea; MLS epochs are decimal strings on the wire / bigint in the DB.
//
// NOTE: deliberately no umami/embedding/moderation calls here — secure chat is private by design.
import { Hono } from "hono";
import { and, eq, desc, asc, count, gt, lt, or, inArray, isNull, sql } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import {
  secureDevices, secureKeyPackages, secureConversations, secureConversationMembers,
  secureMessages, secureHandshakeMessages, secureKeyBackups, spaces, spaceMembers,
} from "../db/schema/index.js";
import {
  shapeSecureDevice, shapeSecureConversation, shapeSecureConversationMember,
  shapeSecureMessage, shapeSecureHandshake, shapeSecureKeyBackup,
} from "../lib/secure-chat-shape.js";
import {
  parseBody, registerDeviceSchema, publishKeyPackagesSchema, createSecureConversationSchema,
  addSecureMemberSchema, removeSecureMemberSchema, sendSecureMessageSchema, uploadKeyBackupSchema,
} from "../lib/validation.js";
import { emitToSecureConversation, emitToSecureDevice } from "../realtime/secure-socket.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

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
  const [row] = await db.select().from(secureDevices)
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
  const [row] = await db.select().from(secureConversations)
    .where(and(eq(secureConversations.projectId, c.var.projectId), eq(secureConversations.id, c.req.param("id")))).limit(1);
  if (!row) throw Errors.notFound("secure-chat/conversation-not-found", "Conversation not found");
  return row;
}

async function requireSecureMember(c: any, conversationId: string): Promise<MemberRow> {
  const [m] = await db.select().from(secureConversationMembers)
    .where(and(
      eq(secureConversationMembers.projectId, c.var.projectId),
      eq(secureConversationMembers.conversationId, conversationId),
      eq(secureConversationMembers.userId, c.var.auth.userId),
      eq(secureConversationMembers.isActive, true),
    )).limit(1);
  if (!m) throw Errors.forbidden("secure-chat/not-a-member", "Not a member of this conversation");
  return m;
}

// Channel conversations are gated by space membership (owner ⇒ allowed), mirroring chat.ts.
async function assertSpaceAccess(c: any, spaceId: string): Promise<void> {
  const [space] = await db.select().from(spaces)
    .where(and(eq(spaces.projectId, c.var.projectId), eq(spaces.id, spaceId))).limit(1);
  if (!space) throw Errors.notFound("secure-chat/space-not-found", "Space not found");
  if (space.userId === c.var.auth.userId) return;
  const [sm] = await db.select().from(spaceMembers)
    .where(and(eq(spaceMembers.projectId, c.var.projectId), eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, c.var.auth.userId))).limit(1);
  if (!sm || sm.status !== "active") throw Errors.forbidden("secure-chat/space-not-member", "Join the space to access its channel");
}

export const secureChatRoutes = new Hono<{ Variables: Variables }>()
  // ── devices ─────────────────────────────────────────────────────────────────
  .post("/devices", requireAuth, async (c) => {
    const me = c.var.auth!.userId;
    const body = parseBody(registerDeviceSchema, await c.req.json().catch(() => ({})), "secure-chat");
    const sig = assertSize(body.signaturePublicKey, env.MAX_SECURE_HANDSHAKE_BYTES, "secure-chat/invalid-key");
    const cred = assertSize(body.credential, env.MAX_SECURE_HANDSHAKE_BYTES, "secure-chat/invalid-key");
    const [row] = await db.insert(secureDevices)
      .values({
        projectId: c.var.projectId, userId: me, deviceId: body.deviceId, displayName: body.displayName ?? null,
        signaturePublicKey: sig, credential: cred, ciphersuite: body.ciphersuite,
      })
      .onConflictDoUpdate({
        target: [secureDevices.userId, secureDevices.deviceId],
        set: { signaturePublicKey: sig, credential: cred, ciphersuite: body.ciphersuite, displayName: body.displayName ?? null, revokedAt: null, updatedAt: new Date() },
      })
      .returning();
    logger.debug({ projectId: c.var.projectId, userId: me, deviceId: body.deviceId }, "secure-chat: device registered");
    return c.json(shapeSecureDevice(row!), 201);
  })
  .get("/devices", requireAuth, async (c) => {
    // Public device records for a user (signature key + credential) so peers can build a group.
    const userId = c.req.query("userId");
    if (!userId) throw Errors.badRequest("secure-chat/missing-user", "userId query param required", "userId");
    const rows = await db.select().from(secureDevices)
      .where(and(eq(secureDevices.projectId, c.var.projectId), eq(secureDevices.userId, userId), isNull(secureDevices.revokedAt)))
      .orderBy(asc(secureDevices.createdAt));
    return c.json({ data: rows.map(shapeSecureDevice) });
  })
  .delete("/devices/:deviceId", requireAuth, async (c) => {
    const dev = await getMyDevice(c, c.req.param("deviceId"));
    await db.update(secureDevices).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(secureDevices.id, dev.id));
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
    const inserted = await db.insert(secureKeyPackages).values(values)
      .onConflictDoNothing({ target: [secureKeyPackages.deviceId, secureKeyPackages.keyPackageRef] })
      .returning({ id: secureKeyPackages.id });
    return c.json({ published: inserted.length }, 201);
  })
  .get("/devices/:deviceId/key-packages/count", requireAuth, async (c) => {
    const dev = await getMyDevice(c, c.req.param("deviceId"));
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(secureKeyPackages)
      .where(and(eq(secureKeyPackages.deviceId, dev.id), isNull(secureKeyPackages.consumedAt),
        or(isNull(secureKeyPackages.expiresAt), gt(secureKeyPackages.expiresAt, new Date()))));
    return c.json({ available: n });
  })
  .post("/devices/:deviceId/key-packages/claim", requireAuth, async (c) => {
    // Any authed user claims a one-time KeyPackage for the TARGET device (to add it to a group).
    const targetDeviceId = c.req.param("deviceId");
    const me = c.var.auth!.userId;
    const [dev] = await db.select({ id: secureDevices.id, userId: secureDevices.userId }).from(secureDevices)
      .where(and(eq(secureDevices.projectId, c.var.projectId), eq(secureDevices.id, targetDeviceId), isNull(secureDevices.revokedAt))).limit(1);
    if (!dev) throw Errors.notFound("secure-chat/device-not-found", "Device not found");
    // Atomic claim: lock one unconsumed, unexpired package and consume it.
    const claimed = (await db.execute(sql`
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
    if (!r) throw Errors.conflict("secure-chat/key-packages-exhausted", "No key packages available for this device");
    // Nudge the device owner to replenish if we're running low.
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(secureKeyPackages)
      .where(and(eq(secureKeyPackages.deviceId, targetDeviceId), isNull(secureKeyPackages.consumedAt),
        or(isNull(secureKeyPackages.expiresAt), gt(secureKeyPackages.expiresAt, new Date()))));
    if (n < KEY_PACKAGE_LOW_WATER) emitToSecureDevice(targetDeviceId, "secure:key-packages-low", { deviceId: targetDeviceId, available: n });
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
    const convRows = await db.select({ id: secureConversationMembers.conversationId }).from(secureConversationMembers)
      .where(and(eq(secureConversationMembers.projectId, c.var.projectId), eq(secureConversationMembers.userId, me), eq(secureConversationMembers.isActive, true)));
    const convIds = convRows.map((r) => r.id);
    const broadcastCond = convIds.length
      ? and(isNull(secureHandshakeMessages.targetDeviceId), inArray(secureHandshakeMessages.conversationId, convIds))
      : sql`false`;
    const rows = await db.select().from(secureHandshakeMessages)
      .where(and(
        eq(secureHandshakeMessages.projectId, c.var.projectId),
        gt(secureHandshakeMessages.seq, since),
        or(eq(secureHandshakeMessages.targetDeviceId, dev.id), broadcastCond),
      ))
      .orderBy(asc(secureHandshakeMessages.seq))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    return c.json({ handshakes: rows.slice(0, limit).map(shapeSecureHandshake), hasMore });
  })
  // ── passphrase key backup (opaque; server can't decrypt) ────────────────────
  .put("/key-backup", requireAuth, async (c) => {
    const me = c.var.auth!.userId;
    const body = parseBody(uploadKeyBackupSchema, await c.req.json().catch(() => ({})), "secure-chat");
    const blob = assertSize(body.blob, env.MAX_SECURE_HANDSHAKE_BYTES, "secure-chat/backup-too-large");
    const nonce = b64ToBuf(body.nonce);
    const deviceId = body.deviceId ?? null;
    // Manual upsert: a NULL deviceId won't match the unique constraint, so match with IS NOT DISTINCT FROM.
    const [existing] = await db.select({ id: secureKeyBackups.id }).from(secureKeyBackups)
      .where(and(eq(secureKeyBackups.projectId, c.var.projectId), eq(secureKeyBackups.userId, me), sql`${secureKeyBackups.deviceId} is not distinct from ${deviceId}`)).limit(1);
    if (existing) {
      const [row] = await db.update(secureKeyBackups)
        .set({ blob, nonce, kdf: body.kdf, kdfParams: body.kdfParams, cipher: body.cipher, version: body.version, updatedAt: new Date() })
        .where(eq(secureKeyBackups.id, existing.id)).returning();
      return c.json({ success: true, updatedAt: row!.updatedAt.toISOString() });
    }
    const [row] = await db.insert(secureKeyBackups)
      .values({ projectId: c.var.projectId, userId: me, deviceId, blob, nonce, kdf: body.kdf, kdfParams: body.kdfParams, cipher: body.cipher, version: body.version })
      .returning();
    return c.json({ success: true, updatedAt: row!.updatedAt.toISOString() }, 201);
  })
  .get("/key-backup", requireAuth, async (c) => {
    const me = c.var.auth!.userId;
    const deviceId = c.req.query("deviceId") ?? null;
    const [row] = await db.select().from(secureKeyBackups)
      .where(and(eq(secureKeyBackups.projectId, c.var.projectId), eq(secureKeyBackups.userId, me), sql`${secureKeyBackups.deviceId} is not distinct from ${deviceId}`)).limit(1);
    if (!row) throw Errors.notFound("secure-chat/backup-not-found", "No key backup found");
    return c.json(shapeSecureKeyBackup(row));
  })
  // ── conversations ────────────────────────────────────────────────────────────
  .post("/conversations", requireAuth, async (c) => {
    const me = c.var.auth!.userId;
    const body = parseBody(createSecureConversationSchema, await c.req.json().catch(() => ({})), "secure-chat");
    if (body.type === "channel") {
      if (!body.spaceId) throw Errors.badRequest("secure-chat/channel-needs-space", "Channels require a spaceId", "spaceId");
      await assertSpaceAccess(c, body.spaceId);
    } else if (body.spaceId) {
      throw Errors.badRequest("secure-chat/space-only-channel", "spaceId is only valid for channels", "spaceId");
    }
    const mlsGroupId = b64ToBuf(body.mlsGroupId);
    const welcomeValues = (body.welcomes ?? []).map((w) => ({
      projectId: c.var.projectId, conversationId: "", kind: "welcome" as const, epoch: BigInt(w.epoch),
      payload: assertSize(w.payload, env.MAX_SECURE_HANDSHAKE_BYTES, "secure-chat/welcome-too-large"),
      targetDeviceId: w.targetDeviceId, senderDeviceId: null,
    }));
    let result: { convo: ConversationRow; welcomeRows: (typeof secureHandshakeMessages.$inferSelect)[]; memberCount: number };
    try {
      result = await db.transaction(async (tx) => {
        const [convo] = await tx.insert(secureConversations)
          .values({ projectId: c.var.projectId, type: body.type, mlsGroupId, spaceId: body.spaceId ?? null, name: body.name ?? null, createdById: me })
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
      if (w.targetDeviceId) emitToSecureDevice(w.targetDeviceId, "secure:welcome", shapeSecureHandshake(w));
    }
    logger.debug({ projectId: c.var.projectId, conversationId: result.convo.id, type: result.convo.type, members: result.memberCount }, "secure-chat: conversation created");
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
    const rows = await db.select({ convo: secureConversations, member: secureConversationMembers })
      .from(secureConversationMembers)
      .innerJoin(secureConversations, eq(secureConversations.id, secureConversationMembers.conversationId))
      .where(and(...conds))
      .orderBy(sql`COALESCE(${secureConversations.lastMessageAt}, ${secureConversations.createdAt}) DESC`)
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const conversations = await Promise.all(rows.slice(0, limit).map(async ({ convo, member }) => {
      const [{ mc } = { mc: 0 }] = await db.select({ mc: count() }).from(secureConversationMembers)
        .where(and(eq(secureConversationMembers.conversationId, convo.id), eq(secureConversationMembers.isActive, true)));
      const [{ u } = { u: 0 }] = await db.select({ u: count() }).from(secureMessages)
        .where(and(eq(secureMessages.conversationId, convo.id), member.lastReadAt ? gt(secureMessages.createdAt, member.lastReadAt) : sql`true`));
      return shapeSecureConversation(convo, { memberCount: mc, unreadCount: u, currentMember: shapeSecureConversationMember(member) });
    }));
    return c.json({ conversations, hasMore });
  })
  .get("/conversations/:id", requireAuth, async (c) => {
    const convo = await getSecureConversation(c);
    const member = await requireSecureMember(c, convo.id);
    const [{ mc } = { mc: 0 }] = await db.select({ mc: count() }).from(secureConversationMembers)
      .where(and(eq(secureConversationMembers.conversationId, convo.id), eq(secureConversationMembers.isActive, true)));
    return c.json(shapeSecureConversation(convo, { memberCount: mc, currentMember: shapeSecureConversationMember(member) }));
  })
  .post("/conversations/:id/read", requireAuth, async (c) => {
    const convo = await getSecureConversation(c);
    await requireSecureMember(c, convo.id);
    await db.update(secureConversationMembers).set({ lastReadAt: new Date(), updatedAt: new Date() })
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
    const out = await db.transaction(async (tx) => {
      // Optimistic commit ordering: only advance if we're exactly one epoch behind the commit.
      const bumped = await tx.update(secureConversations).set({ currentEpoch: newEpoch, updatedAt: new Date() })
        .where(and(eq(secureConversations.id, convo.id), eq(secureConversations.currentEpoch, newEpoch - 1n))).returning({ id: secureConversations.id });
      if (!bumped.length) throw Errors.conflict("secure-chat/epoch-conflict", "Conversation epoch advanced; rebase your commit");
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
    for (const w of out.welcomeRows) if (w.targetDeviceId) emitToSecureDevice(w.targetDeviceId, "secure:welcome", shapeSecureHandshake(w));
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
    const out = await db.transaction(async (tx) => {
      const bumped = await tx.update(secureConversations).set({ currentEpoch: newEpoch, updatedAt: new Date() })
        .where(and(eq(secureConversations.id, convo.id), eq(secureConversations.currentEpoch, newEpoch - 1n))).returning({ id: secureConversations.id });
      if (!bumped.length) throw Errors.conflict("secure-chat/epoch-conflict", "Conversation epoch advanced; rebase your commit");
      await tx.update(secureConversationMembers).set({ isActive: false, leftAt: new Date(), updatedAt: new Date() })
        .where(and(eq(secureConversationMembers.conversationId, convo.id), eq(secureConversationMembers.userId, target)));
      const [commitRow] = await tx.insert(secureHandshakeMessages)
        .values({ projectId: c.var.projectId, conversationId: convo.id, kind: "commit", epoch: newEpoch, payload: commitBuf, targetDeviceId: null, senderDeviceId: null }).returning();
      return { commitRow: commitRow! };
    });
    emitToSecureConversation(convo.id, "secure:handshake", shapeSecureHandshake(out.commitRow));
    emitToSecureConversation(convo.id, "secure:member:left", { conversationId: convo.id, userId: target, epoch: String(newEpoch) });
    return c.json({ success: true, epoch: String(newEpoch) });
  })
  // ── messages (opaque application ciphertext) ────────────────────────────────
  .post("/conversations/:id/messages", requireAuth, async (c) => {
    const convo = await getSecureConversation(c);
    await requireSecureMember(c, convo.id);
    const me = c.var.auth!.userId;
    const body = parseBody(sendSecureMessageSchema, await c.req.json().catch(() => ({})), "secure-chat");
    const [dev] = await db.select({ id: secureDevices.id }).from(secureDevices)
      .where(and(eq(secureDevices.projectId, c.var.projectId), eq(secureDevices.id, body.senderDeviceId), eq(secureDevices.userId, me), isNull(secureDevices.revokedAt))).limit(1);
    if (!dev) throw Errors.forbidden("secure-chat/device-mismatch", "senderDeviceId does not belong to you");
    const epoch = BigInt(body.epoch);
    if (epoch > convo.currentEpoch + EPOCH_WINDOW) throw Errors.badRequest("secure-chat/epoch-out-of-range", "Message epoch is implausibly far ahead", "epoch");
    const ciphertext = assertSize(body.ciphertext, env.MAX_SECURE_MESSAGE_BYTES, "secure-chat/message-too-large");
    const [row] = await db.insert(secureMessages)
      .values({ projectId: c.var.projectId, conversationId: convo.id, senderUserId: me, senderDeviceId: dev.id, epoch, ciphertext, contentType: body.contentType ?? "application" })
      .returning();
    const shaped = shapeSecureMessage(row!);
    emitToSecureConversation(convo.id, "secure:message", shaped);
    return c.json(shaped, 201);
  })
  .get("/conversations/:id/messages", requireAuth, async (c) => {
    const convo = await getSecureConversation(c);
    await requireSecureMember(c, convo.id);
    const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
    const before = c.req.query("before"); // ISO timestamp keyset cursor
    const conds = [eq(secureMessages.conversationId, convo.id)];
    if (before) conds.push(lt(secureMessages.createdAt, new Date(before)));
    const rows = await db.select().from(secureMessages)
      .where(and(...conds))
      .orderBy(desc(secureMessages.createdAt), desc(secureMessages.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    return c.json({ messages: rows.slice(0, limit).map(shapeSecureMessage), hasMore });
  });
