// /v7/:projectId/chat/*  — conversations, members, messages.
// REST writes fan out durable socket.io events (realtime/socket.ts) after the DB commit.
import { Hono } from "hono";
import { and, eq, desc, asc, count, inArray, gt, ne, sql } from "drizzle-orm";
import { muteConversationSchema } from "@agora-server/contract";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { getDb } from "../db/index.js";
import {
  conversations, conversationMembers, chatMessages, chatMessageReactions, reports, profiles,
  spaces, spaceMembers,
} from "../db/schema/index.js";
import { shapeConversation, shapeConversationMember, shapeChatMessage, shapeFile, shapeUser, loadMessageFiles, shapeConversationPreview, pickOtherMembers } from "../lib/shape.js";
import { storeUpload } from "../lib/images.js";
import { env } from "../lib/env.js";
import { collectFileRows, removeMediaAsync } from "../lib/storage-cleanup.js";
import { muteDurationToState } from "../lib/mute.js";
import {
  parseBody, createConversationSchema, directConversationSchema, updateConversationSchema,
  sendMessageSchema, editMessageSchema, messageReactionSchema, reportMessageSchema,
  addConversationMemberSchema, convMemberRoleSchema,
} from "../lib/validation.js";
import { emitToConversation, emitToUser, emitMessageCreated } from "../realtime/socket.js";
import { removedPolicy, excludeRemovedSql } from "../lib/moderation-visibility.js";
import { logger } from "../lib/logger.js";
import { indexContentAsync } from "../lib/embeddings.js";
import * as webhooks from "../lib/webhooks.js";
import { sanitizeMentions } from "../lib/mentions.js";
import { spaceRepGate } from "../middleware/space-rep.js";
import { enrichSpaceReputation } from "../lib/space-reputation-enrich.js";

type ConversationRow = typeof conversations.$inferSelect;
type MemberRow = typeof conversationMembers.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

async function getConversation(c: any): Promise<ConversationRow> {
  const [row] = await getDb().select().from(conversations)
    .where(and(eq(conversations.projectId, c.var.projectId), eq(conversations.id, c.req.param("id")))).limit(1);
  if (!row) throw Errors.notFound("chat/conversation-not-found", "Conversation not found");
  return row;
}

async function requireMember(c: any, conversationId: string): Promise<MemberRow> {
  const [m] = await getDb().select().from(conversationMembers)
    .where(and(
      eq(conversationMembers.projectId, c.var.projectId),
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, c.var.auth.userId),
      eq(conversationMembers.isActive, true)
    )).limit(1);
  if (!m) throw Errors.forbidden("chat/not-a-member", "Not a member of this conversation");
  return m;
}

// Emojis the user has reacted with, grouped per message (batched).
async function userReactionsByMessage(messageIds: string[], userId: string | undefined): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!userId || messageIds.length === 0) return map;
  const rows = await getDb().select({ messageId: chatMessageReactions.messageId, emoji: chatMessageReactions.emoji })
    .from(chatMessageReactions)
    .where(and(eq(chatMessageReactions.userId, userId), inArray(chatMessageReactions.messageId, messageIds)));
  for (const r of rows) map.set(r.messageId, [...(map.get(r.messageId) ?? []), r.emoji]);
  return map;
}

// Build the inbox ConversationPreview for one (conversation, viewing member): latest message,
// unread count vs the member's lastReadAt, and ≤5 other active members (empty for space chats).
async function buildConversationPreview(c: any, convo: ConversationRow, member: MemberRow) {
  const [last] = await getDb().select().from(chatMessages)
    .where(eq(chatMessages.conversationId, convo.id)).orderBy(desc(chatMessages.createdAt)).limit(1);
  const [{ u } = { u: 0 }] = await getDb().select({ u: count() }).from(chatMessages)
    .where(and(eq(chatMessages.conversationId, convo.id), member.lastReadAt ? gt(chatMessages.createdAt, member.lastReadAt) : sql`true`));
  let otherMembers: ReturnType<typeof pickOtherMembers> = [];
  if (convo.type !== "space") {
    const rows = await getDb().select({ p: profiles }).from(conversationMembers)
      .innerJoin(profiles, eq(profiles.id, conversationMembers.userId))
      .where(and(
        eq(conversationMembers.conversationId, convo.id),
        eq(conversationMembers.isActive, true),
        ne(conversationMembers.userId, member.userId),
      ))
      .limit(5);
    otherMembers = pickOtherMembers(rows.map((r) => shapeUser(r.p) as any));
  }
  return shapeConversationPreview(convo, {
    unreadCount: u,
    lastMessage: last ? (shapeChatMessage(last) as Record<string, unknown>) : null,
    otherMembers,
    currentMember: shapeConversationMember(member),
  });
}

// Notify each member's inbox of a new conversation. Zero-state preview (unreadCount 0, no lastMessage);
// otherMembers is the rest of the roster (excluding the recipient). Skipped for space chats. The actor
// is included in memberIds but already has the conversation from the REST response — emitting to their
// user room is harmless (their other tabs upsert it) and keeps the helper simple.
async function emitConversationCreated(c: any, convo: ConversationRow, memberIds: string[]) {
  if (convo.type === "space" || memberIds.length === 0) return;
  try {
    const profs = await getDb().select().from(profiles).where(inArray(profiles.id, memberIds));
    const byId = new Map(profs.map((p) => [p.id, p]));
    for (const recipientId of memberIds) {
      const others = memberIds
        .filter((id) => id !== recipientId)
        .map((id) => byId.get(id))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map((p) => shapeUser(p) as any);
      const preview = shapeConversationPreview(convo, {
        unreadCount: 0,
        lastMessage: null,
        otherMembers: pickOtherMembers(others),
      });
      emitToUser(c.var.projectId, recipientId, "conversation:created", preview);
    }
  } catch (err) {
    logger.error("[chat] emitConversationCreated failed");
    logger.debug({ err }, "[chat] emitConversationCreated failed");
  }
}

export const chatRoutes = new Hono<{ Variables: Variables }>()
  .use("*", spaceRepGate("context"))
  // ── conversations ─────────────────────────────────────────────────────────
  .get("/conversations", requireAuth, async (c) => {
    // SDK contract (useConversations): cursor pagination, response `{ conversations, hasMore }`.
    // It sends `limit`, optional `types` (csv), and a cursor as `cursor` (last item's lastMessageAt,
    // omitted when null) + `cursorCreatedAt` (last item's createdAt). We order by recent activity
    // — COALESCE(lastMessageAt, createdAt) DESC — and keyset on that same boundary.
    const uid = c.var.auth!.userId;
    const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
    const typesParam = c.req.query("types");
    const types = typesParam ? typesParam.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const boundary = c.req.query("cursor") || c.req.query("cursorCreatedAt"); // ISO timestamp

    const conds = [
      eq(conversationMembers.projectId, c.var.projectId),
      eq(conversationMembers.userId, uid),
      eq(conversationMembers.isActive, true),
    ];
    if (types && types.length) conds.push(inArray(conversations.type, types as any));
    if (boundary) conds.push(sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt}) < ${boundary}::timestamptz`);

    const rows = await getDb().select({ convo: conversations, member: conversationMembers })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .where(and(...conds))
      .orderBy(sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt}) DESC`)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const data = await Promise.all(rows.slice(0, limit).map(({ convo, member }) => buildConversationPreview(c, convo, member)));
    return c.json(await enrichSpaceReputation(c, { conversations: data, hasMore }));
  })
  .post("/conversations", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const uid = c.var.auth!.userId;
    const body = parseBody(createConversationSchema, await c.req.json().catch(() => ({})), "chat");
    const [convo] = await getDb().insert(conversations).values({
      projectId, type: body.type ?? "group", name: body.name, description: body.description,
      spaceId: body.spaceId, createdById: uid, postingPermission: body.postingPermission,
    }).returning();
    // Creator is admin; supplied members join as members.
    const memberIds = [...new Set([uid, ...(body.memberIds ?? [])])];
    await getDb().insert(conversationMembers).values(memberIds.map((userId) => ({
      projectId, conversationId: convo!.id, userId, role: userId === uid ? "admin" as const : "member" as const,
    }))).onConflictDoNothing();
    logger.info({ projectId, conversationId: convo!.id, userId: uid, type: convo!.type, spaceId: convo!.spaceId ?? null, members: memberIds.length }, "chat: conversation created");
    await emitConversationCreated(c, convo!, memberIds);
    return c.json(shapeConversation(convo!, { memberCount: memberIds.length }), 201);
  })
  .post("/conversations/direct", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const uid = c.var.auth!.userId;
    const { userId: other } = parseBody(directConversationSchema, await c.req.json().catch(() => ({})), "chat");
    if (other === uid) throw Errors.badRequest("chat/self-direct", "Cannot start a direct chat with yourself");
    // Get-or-create the 1:1 direct conversation between the two users.
    const existing = await getDb().execute(sql`
      select c.id from conversations c
      join conversation_members a on a.conversation_id = c.id and a.user_id = ${uid}::uuid
      join conversation_members b on b.conversation_id = c.id and b.user_id = ${other}::uuid
      where c.project_id = ${projectId}::uuid and c.type = 'direct' limit 1`);
    const foundId = (existing as any)[0]?.id as string | undefined;
    if (foundId) {
      const [row] = await getDb().select().from(conversations).where(eq(conversations.id, foundId)).limit(1);
      return c.json(shapeConversation(row!));
    }
    const [convo] = await getDb().insert(conversations).values({ projectId, type: "direct", createdById: uid }).returning();
    await getDb().insert(conversationMembers).values([
      { projectId, conversationId: convo!.id, userId: uid, role: "member" as const },
      { projectId, conversationId: convo!.id, userId: other, role: "member" as const },
    ]);
    await emitConversationCreated(c, convo!, [uid, other]);
    return c.json(shapeConversation(convo!, { memberCount: 2 }), 201);
  })
  // Total unread across the user's active conversations. MUST stay above /conversations/:id
  // (the SDK's chat-context fetches this on load; otherwise "unread-count" is captured as an :id → 500).
  .get("/conversations/unread-count", requireAuth, async (c) => {
    const me = c.var.auth!.userId;
    const rows = (await getDb().execute(sql`
      select count(*)::int as total_unread,
             count(distinct m.conversation_id)::int as unread_conversation_count
      from conversation_members cm
      join chat_messages m on m.conversation_id = cm.conversation_id
      where cm.project_id = ${c.var.projectId} and cm.user_id = ${me} and cm.is_active = true
        and m.user_deleted_at is null
        and (m.user_id is null or m.user_id <> ${me})
        and (cm.last_read_at is null or m.created_at > cm.last_read_at)
    `)) as unknown as { total_unread: number; unread_conversation_count: number }[];
    const r = rows[0] ?? { total_unread: 0, unread_conversation_count: 0 };
    return c.json({ totalUnread: r.total_unread, unreadConversationCount: r.unread_conversation_count });
  })
  .get("/conversations/:id/preview", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    return c.json(await enrichSpaceReputation(c, await buildConversationPreview(c, convo, member)));
  })
  .get("/conversations/:id", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    const [{ mc } = { mc: 0 }] = await getDb().select({ mc: count() }).from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.isActive, true)));
    return c.json(await enrichSpaceReputation(c, shapeConversation(convo, { memberCount: mc, currentMember: shapeConversationMember(member) })));
  })
  .patch("/conversations/:id", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    if (member.role !== "admin") throw Errors.forbidden("chat/not-admin", "Admin only");
    const body = parseBody(updateConversationSchema, await c.req.json().catch(() => ({})), "chat");
    const [row] = await getDb().update(conversations).set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    }).where(eq(conversations.id, convo.id)).returning();
    emitToConversation(convo.id, "conversation:updated", { id: convo.id, name: row!.name, description: row!.description } as any);
    return c.json(shapeConversation(row!));
  })
  .delete("/conversations/:id", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    if (member.role !== "admin" && convo.createdById !== c.var.auth!.userId) throw Errors.forbidden("chat/not-admin", "Admin only");
    await getDb().delete(conversations).where(eq(conversations.id, convo.id));
    emitToConversation(convo.id, "conversation:deleted", { conversationId: convo.id });
    return c.json({ success: true });
  })
  .delete("/conversations/:id/leave", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    await getDb().update(conversationMembers).set({ isActive: false, leftAt: new Date() })
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.userId, c.var.auth!.userId)));
    emitToConversation(convo.id, "member:left", { conversationId: convo.id, userId: c.var.auth!.userId });
    return c.json({ success: true });
  })
  .post("/conversations/:id/read", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    await getDb().update(conversationMembers).set({ lastReadAt: new Date() })
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.userId, c.var.auth!.userId)));
    return c.json({ success: true });
  })
  .post("/conversations/:id/mute", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id); // acting user must be a member
    const body = parseBody(muteConversationSchema, await c.req.json().catch(() => ({})), "chat");
    const { mutedUntil, mutedForever } = muteDurationToState(body.duration, new Date());
    const [row] = await getDb().update(conversationMembers)
      .set({ mutedUntil, mutedForever, updatedAt: new Date() })
      .where(and(
        eq(conversationMembers.projectId, c.var.projectId),
        eq(conversationMembers.conversationId, convo.id),
        eq(conversationMembers.userId, c.var.auth!.userId),
      ))
      .returning();
    // Self-serialized: only the caller's own row, carrying the mute fields. Never another member's.
    return c.json(await enrichSpaceReputation(c, { currentMember: shapeConversationMember(row!) }));
  })
  // ── members ────────────────────────────────────────────────────────────────
  .get("/conversations/:id/members", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    const rows = await getDb().select({ m: conversationMembers, p: profiles })
      .from(conversationMembers).innerJoin(profiles, eq(profiles.id, conversationMembers.userId))
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.isActive, true)))
      .orderBy(asc(conversationMembers.createdAt));
    return c.json(await enrichSpaceReputation(c, { data: rows.map((r) => shapeConversationMember(r.m, shapeUser(r.p))) }));
  })
  .post("/conversations/:id/members", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    if (member.role !== "admin") throw Errors.forbidden("chat/not-admin", "Admin only");
    const body = parseBody(addConversationMemberSchema, await c.req.json().catch(() => ({})), "chat");
    const [row] = await getDb().insert(conversationMembers)
      .values({ projectId: c.var.projectId, conversationId: convo.id, userId: body.userId, role: body.role ?? "member" })
      .onConflictDoUpdate({ target: [conversationMembers.conversationId, conversationMembers.userId], set: { isActive: true, leftAt: null } })
      .returning();
    const [p] = await getDb().select().from(profiles).where(eq(profiles.id, body.userId)).limit(1);
    const shaped = shapeConversationMember(row!, p ? shapeUser(p) : null);
    emitToConversation(convo.id, "member:joined", { conversationId: convo.id, member: shaped });
    return c.json(await enrichSpaceReputation(c, shaped), 201);
  })
  .delete("/conversations/:id/members/:memberId", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    if (member.role !== "admin") throw Errors.forbidden("chat/not-admin", "Admin only");
    const target = c.req.param("memberId");
    await getDb().update(conversationMembers).set({ isActive: false, leftAt: new Date() })
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.userId, target)));
    emitToConversation(convo.id, "member:left", { conversationId: convo.id, userId: target });
    return c.json({ success: true });
  })
  .patch("/conversations/:id/members/:memberId/role", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    if (member.role !== "admin") throw Errors.forbidden("chat/not-admin", "Admin only");
    const { role } = parseBody(convMemberRoleSchema, await c.req.json().catch(() => ({})), "chat");
    const [row] = await getDb().update(conversationMembers).set({ role })
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.userId, c.req.param("memberId")))).returning();
    if (!row) throw Errors.notFound("chat/member-not-found", "Member not found");
    return c.json(await enrichSpaceReputation(c, shapeConversationMember(row)));
  })
  // ── messages ───────────────────────────────────────────────────────────────
  .get("/conversations/:id/messages", requireAuth, async (c) => {
    // SDK contract (useChatMessages): cursor pagination, response `{ messages, hasMore }`.
    // Params: `limit`, `sort` (desc main stream / asc thread), `before` (ISO timestamp — fetch
    // messages created strictly before it), `parentId` (thread replies; absent ⇒ top-level stream).
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
    const parentId = c.req.query("parentId");
    const before = c.req.query("before"); // ISO timestamp cursor (back-pagination)
    const after = c.req.query("after");   // ISO timestamp cursor (reconnect catch-up — forward)
    if (after !== undefined && Number.isNaN(new Date(after).getTime())) {
      throw Errors.badRequest("chat/invalid-after", "after must be an ISO timestamp", "after");
    }
    // Reconnect catch-up reads forward (ascending) regardless of sort; back-pagination respects sort.
    const order = (after !== undefined || c.req.query("sort") === "asc") ? asc(chatMessages.createdAt) : desc(chatMessages.createdAt);

    const conds = [eq(chatMessages.conversationId, convo.id)];
    // Main stream = top-level messages; thread view = replies to a specific parent.
    conds.push(parentId ? eq(chatMessages.parentMessageId, parentId) : sql`${chatMessages.parentMessageId} is null`);
    if (before) conds.push(sql`${chatMessages.createdAt} < ${before}::timestamptz`);
    // date_trunc: the API returns ms-precision timestamps; DB stores µs. Without truncation,
    // a cursor of '...123Z' (ms) would include the cursor message (db: ...123456µs > ...123000µs).
    if (after !== undefined) conds.push(sql`date_trunc('milliseconds', ${chatMessages.createdAt}) > ${after}::timestamptz`);
    // Hide moderation-removed messages from members (operators bypass for review) — mirrors entities/comments.
    const removedFilter = excludeRemovedSql(await removedPolicy(c), chatMessages);
    if (removedFilter) conds.push(removedFilter);

    const rows = await getDb().select().from(chatMessages)
      .where(and(...conds))
      .orderBy(order)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const reactionMap = await userReactionsByMessage(pageRows.map((r) => r.id), c.var.auth!.userId);
    const fileMap = await loadMessageFiles(c.var.projectId, pageRows.map((r) => r.id));
    const messages = pageRows.map((r) => shapeChatMessage(r, {
      userReactions: reactionMap.get(r.id) ?? [],
      ...(fileMap.has(r.id) ? { files: fileMap.get(r.id) } : {}),
    }));
    return c.json(await enrichSpaceReputation(c, { messages, hasMore }));
  })
  .post("/conversations/:id/messages", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    if (convo.postingPermission === "admins" && member.role !== "admin") {
      throw Errors.forbidden("chat/posting-restricted", "Only admins can post in this conversation");
    }
    // The SDK's useSendMessage sends multipart/form-data when files are attached, JSON otherwise.
    let body: any;
    let attachedFiles: File[] = [];
    if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      const form = await c.req.parseBody({ all: true });
      const str = (k: string): string | undefined => {
        const v = form[k]; return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
      };
      const json = (k: string): unknown => { const s = str(k); if (s === undefined) return undefined; try { return JSON.parse(s); } catch { return undefined; } };
      body = {
        content: str("content"), gif: json("gif"), mentions: json("mentions"), metadata: json("metadata"),
        parentMessageId: str("parentMessageId"), quotedMessageId: str("quotedMessageId"), localId: str("localId"),
      };
      const f = form["files"];
      attachedFiles = (Array.isArray(f) ? f : f ? [f] : []).filter((x): x is File => typeof x !== "string");
      // File-only messages are valid; otherwise require content or a gif (mirrors sendMessageSchema).
      if (!body.content && !body.gif && attachedFiles.length === 0) {
        throw Errors.badRequest("chat/empty-message", "Message needs content, a gif, or a file");
      }
    } else {
      body = parseBody(sendMessageSchema, await c.req.json().catch(() => ({})), "chat");
    }
    const check = await webhooks.validate(c.var.projectId, "message.created", { ...body, conversationId: convo.id, userId: c.var.auth!.userId });
    if (!check.valid) throw Errors.forbidden("chat/rejected", check.message ?? "Message rejected by validation webhook");
    // Trigger (0002) bumps conversation.last_message_at + parent thread_reply_count.
    const [row] = await getDb().insert(chatMessages).values({
      projectId: c.var.projectId, conversationId: convo.id, userId: c.var.auth!.userId,
      content: body.content, gif: body.gif, mentions: await sanitizeMentions(c.var.projectId, body.mentions), metadata: body.metadata,
      parentMessageId: body.parentMessageId, quotedMessageId: body.quotedMessageId,
    }).returning();
    // Upload any attached files (images → variants, others as-is), linked to this message.
    const fileRows = [];
    for (const file of attachedFiles) {
      const { fileRow } = await storeUpload({ projectId: c.var.projectId, userId: c.var.auth!.userId, file, assoc: { chatMessageId: row!.id } });
      fileRows.push(fileRow);
    }
    const shaped = shapeChatMessage(row!, { localId: body.localId, ...(fileRows.length ? { files: fileRows.map(shapeFile) } : {}) });
    indexContentAsync(c.var.projectId, "message", row!.id, row!.content);
    logger.debug({ projectId: c.var.projectId, conversationId: convo.id, messageId: row!.id, userId: c.var.auth!.userId, parentMessageId: row!.parentMessageId ?? null, files: fileRows.length }, "chat: message created");
    const memberRows = await getDb().select({ userId: conversationMembers.userId }).from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.isActive, true)));
    emitMessageCreated(convo.id, c.var.projectId, memberRows.map((m) => m.userId), shaped);
    webhooks.broadcast(c.var.projectId, "message.created.complete", shaped);
    if (row!.parentMessageId) {
      const [parent] = await getDb().select({ n: chatMessages.threadReplyCount }).from(chatMessages).where(eq(chatMessages.id, row!.parentMessageId)).limit(1);
      emitToConversation(convo.id, "thread:reply_count", { messageId: row!.parentMessageId, conversationId: convo.id, threadReplyCount: parent?.n ?? 0 });
    }
    return c.json(await enrichSpaceReputation(c, shaped), 201);
  })
  .patch("/conversations/:id/messages/:messageId", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    const [msg] = await getDb().select().from(chatMessages)
      .where(and(eq(chatMessages.conversationId, convo.id), eq(chatMessages.id, c.req.param("messageId")))).limit(1);
    if (!msg) throw Errors.notFound("chat/message-not-found", "Message not found");
    if (msg.userId !== c.var.auth!.userId) throw Errors.forbidden("chat/not-author", "Not the message author");
    const body = parseBody(editMessageSchema, await c.req.json().catch(() => ({})), "chat");
    const [row] = await getDb().update(chatMessages).set({
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.gif !== undefined ? { gif: body.gif } : {}),
      ...(body.mentions !== undefined ? { mentions: await sanitizeMentions(c.var.projectId, body.mentions) } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      editedAt: new Date(),
    }).where(eq(chatMessages.id, msg.id)).returning();
    emitToConversation(convo.id, "message:updated", {
      messageId: row!.id, conversationId: convo.id, content: row!.content, gif: row!.gif as any,
      mentions: row!.mentions as any, metadata: row!.metadata as any, editedAt: row!.editedAt,
    });
    return c.json(await enrichSpaceReputation(c, shapeChatMessage(row!)));
  })
  .delete("/conversations/:id/messages/:messageId", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    const [msg] = await getDb().select().from(chatMessages)
      .where(and(eq(chatMessages.conversationId, convo.id), eq(chatMessages.id, c.req.param("messageId")))).limit(1);
    if (!msg) throw Errors.notFound("chat/message-not-found", "Message not found");
    if (msg.userId !== c.var.auth!.userId) throw Errors.forbidden("chat/not-author", "Not the message author");
    const now = new Date();
    if (env.CONTENT_DELETE_MODE === "hard") {
      // Collect files rows BEFORE the delete — the FK cascade takes them with the message row.
      const fileRows = await collectFileRows(c.var.projectId, { chatMessageId: msg.id });
      await getDb().delete(chatMessages).where(eq(chatMessages.id, msg.id));
      removeMediaAsync(fileRows, `chat message ${msg.id}`);
    } else {
      await getDb().update(chatMessages).set({ userDeletedAt: now }).where(eq(chatMessages.id, msg.id));
    }
    // Same socket event in both modes — clients drop the message from view either way.
    emitToConversation(convo.id, "message:deleted", { messageId: msg.id, conversationId: convo.id, userDeletedAt: now });
    return c.json({ success: true });
  })
  .post("/conversations/:id/messages/:messageId/reactions", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    const messageId = c.req.param("messageId");
    const { emoji } = parseBody(messageReactionSchema, await c.req.json().catch(() => ({})), "chat");
    const uid = c.var.auth!.userId;
    const [existing] = await getDb().select({ id: chatMessageReactions.id }).from(chatMessageReactions)
      .where(and(eq(chatMessageReactions.messageId, messageId), eq(chatMessageReactions.userId, uid), eq(chatMessageReactions.emoji, emoji))).limit(1);
    const delta = existing ? -1 : 1;
    if (existing) await getDb().delete(chatMessageReactions).where(eq(chatMessageReactions.id, existing.id));
    else await getDb().insert(chatMessageReactions).values({ projectId: c.var.projectId, messageId, userId: uid, emoji });
    // Maintain the denormalized emoji->count map; drop the key when it hits 0.
    const [row] = await getDb().execute(sql`
      update chat_messages set reaction_counts =
        case when greatest(0, coalesce((reaction_counts->>${emoji})::int,0) + ${delta}) = 0
          then reaction_counts - ${emoji}
          else jsonb_set(reaction_counts, ${sql.raw(`'{${emoji.replace(/'/g, "''")}}'`)}, to_jsonb(greatest(0, coalesce((reaction_counts->>${emoji})::int,0) + ${delta}))) end
      where id = ${messageId}::uuid returning reaction_counts`) as any;
    const reactionCounts = (row?.reaction_counts as Record<string, number>) ?? {};
    emitToConversation(convo.id, "message:reaction", { messageId, conversationId: convo.id, emoji, userId: uid, delta, reactionCounts });
    return c.json({ reactionCounts });
  })
  .post("/conversations/:id/messages/:messageId/report", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    const body = parseBody(reportMessageSchema, await c.req.json().catch(() => ({})), "chat");
    await getDb().insert(reports).values({
      projectId: c.var.projectId, reporterId: c.var.auth!.userId,
      targetType: "message", targetId: c.req.param("messageId"), reason: body.reason, details: body.details,
    });
    return c.json({ success: true }, 201);
  })
  // ── space conversation (get-or-create, space-member gated) ──────────────────
  // One persistent group chat bound to a space (a community channel). The caller must be the space
  // owner or an active space member; on fetch they're auto-joined to the conversation so EVERY space
  // member can read/post (not just whoever created it first). Posting is gated by the conversation's
  // postingPermission, seeded from the space (admins-only spaces ⇒ admins-only chat).
  .get("/spaces/:spaceId/conversation", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const spaceId = c.req.param("spaceId");
    const uid = c.var.auth!.userId;

    const [space] = await getDb().select().from(spaces)
      .where(and(eq(spaces.projectId, projectId), eq(spaces.id, spaceId))).limit(1);
    if (!space) throw Errors.notFound("spaces/not-found", "Space not found");

    // Effective space role: owner ⇒ admin, else the active membership row's role.
    let spaceRole: "admin" | "moderator" | "member" | null = null;
    if (space.userId === uid) spaceRole = "admin";
    else {
      const [sm] = await getDb().select().from(spaceMembers)
        .where(and(eq(spaceMembers.projectId, projectId), eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, uid))).limit(1);
      if (sm && sm.status === "active") spaceRole = sm.role;
    }
    if (!spaceRole) throw Errors.forbidden("chat/space-not-member", "Join the space to access its chat");
    const convRole = spaceRole === "admin" ? "admin" : "member";

    // Get-or-create the single space conversation (seed posting permission from the space).
    let [convo] = await getDb().select().from(conversations)
      .where(and(eq(conversations.projectId, projectId), eq(conversations.spaceId, spaceId), eq(conversations.type, "space"))).limit(1);
    const created = !convo;
    if (!convo) {
      const seedPosting = space.postingPermission === "admins" ? "admins" : "members";
      [convo] = await getDb().insert(conversations)
        .values({ projectId, type: "space", spaceId, createdById: uid, postingPermission: seedPosting }).returning();
    }

    // Auto-join the caller (re)activating their membership; don't clobber an existing role.
    await getDb().insert(conversationMembers)
      .values({ projectId, conversationId: convo!.id, userId: uid, role: convRole })
      .onConflictDoUpdate({ target: [conversationMembers.conversationId, conversationMembers.userId], set: { isActive: true, leftAt: null } });

    const [me] = await getDb().select().from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, convo!.id), eq(conversationMembers.userId, uid))).limit(1);
    const [{ n } = { n: 0 }] = await getDb().select({ n: count() }).from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, convo!.id), eq(conversationMembers.isActive, true)));
    return c.json(await enrichSpaceReputation(c, shapeConversation(convo!, { currentMember: me ? shapeConversationMember(me) : undefined, memberCount: n })), created ? 201 : 200);
  });
