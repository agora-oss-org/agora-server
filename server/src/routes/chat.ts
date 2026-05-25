// /v7/:projectId/chat/*  — conversations, members, messages.
// REST writes fan out durable socket.io events (realtime/socket.ts) after the DB commit.
import { Hono } from "hono";
import { and, eq, desc, asc, count, inArray, gt, sql } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import {
  conversations, conversationMembers, chatMessages, chatMessageReactions, reports, profiles,
} from "../db/schema/index.js";
import { shapeConversation, shapeConversationMember, shapeChatMessage, shapeUser } from "../lib/shape.js";
import {
  parseBody, createConversationSchema, directConversationSchema, updateConversationSchema,
  sendMessageSchema, editMessageSchema, messageReactionSchema, reportMessageSchema,
  addConversationMemberSchema, convMemberRoleSchema,
} from "../lib/validation.js";
import { emitToConversation } from "../realtime/socket.js";
import { indexContentAsync } from "../lib/embeddings.js";
import * as webhooks from "../lib/webhooks.js";

type ConversationRow = typeof conversations.$inferSelect;
type MemberRow = typeof conversationMembers.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

async function getConversation(c: any): Promise<ConversationRow> {
  const [row] = await db.select().from(conversations)
    .where(and(eq(conversations.projectId, c.var.projectId), eq(conversations.id, c.req.param("id")))).limit(1);
  if (!row) throw Errors.notFound("chat/conversation-not-found", "Conversation not found");
  return row;
}

async function requireMember(c: any, conversationId: string): Promise<MemberRow> {
  const [m] = await db.select().from(conversationMembers)
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
  const rows = await db.select({ messageId: chatMessageReactions.messageId, emoji: chatMessageReactions.emoji })
    .from(chatMessageReactions)
    .where(and(eq(chatMessageReactions.userId, userId), inArray(chatMessageReactions.messageId, messageIds)));
  for (const r of rows) map.set(r.messageId, [...(map.get(r.messageId) ?? []), r.emoji]);
  return map;
}

export const chatRoutes = new Hono<{ Variables: Variables }>()
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

    const rows = await db.select({ convo: conversations, member: conversationMembers })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .where(and(...conds))
      .orderBy(sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt}) DESC`)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    // Per-conversation lastMessage + unreadCount (page is small).
    const data = await Promise.all(rows.slice(0, limit).map(async ({ convo, member }) => {
      const [last] = await db.select().from(chatMessages)
        .where(eq(chatMessages.conversationId, convo.id)).orderBy(desc(chatMessages.createdAt)).limit(1);
      const [{ u } = { u: 0 }] = await db.select({ u: count() }).from(chatMessages)
        .where(and(eq(chatMessages.conversationId, convo.id), member.lastReadAt ? gt(chatMessages.createdAt, member.lastReadAt) : sql`true`));
      return shapeConversation(convo, {
        unreadCount: u,
        lastMessage: last ? shapeChatMessage(last) : null,
        currentMember: shapeConversationMember(member),
      });
    }));
    return c.json({ conversations: data, hasMore });
  })
  .post("/conversations", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const uid = c.var.auth!.userId;
    const body = parseBody(createConversationSchema, await c.req.json().catch(() => ({})), "chat");
    const [convo] = await db.insert(conversations).values({
      projectId, type: body.type ?? "group", name: body.name, description: body.description,
      spaceId: body.spaceId, createdById: uid, postingPermission: body.postingPermission,
    }).returning();
    // Creator is admin; supplied members join as members.
    const memberIds = [...new Set([uid, ...(body.memberIds ?? [])])];
    await db.insert(conversationMembers).values(memberIds.map((userId) => ({
      projectId, conversationId: convo!.id, userId, role: userId === uid ? "admin" as const : "member" as const,
    }))).onConflictDoNothing();
    return c.json(shapeConversation(convo!, { memberCount: memberIds.length }), 201);
  })
  .post("/conversations/direct", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const uid = c.var.auth!.userId;
    const { userId: other } = parseBody(directConversationSchema, await c.req.json().catch(() => ({})), "chat");
    if (other === uid) throw Errors.badRequest("chat/self-direct", "Cannot start a direct chat with yourself");
    // Get-or-create the 1:1 direct conversation between the two users.
    const existing = await db.execute(sql`
      select c.id from conversations c
      join conversation_members a on a.conversation_id = c.id and a.user_id = ${uid}::uuid
      join conversation_members b on b.conversation_id = c.id and b.user_id = ${other}::uuid
      where c.project_id = ${projectId}::uuid and c.type = 'direct' limit 1`);
    const foundId = (existing as any)[0]?.id as string | undefined;
    if (foundId) {
      const [row] = await db.select().from(conversations).where(eq(conversations.id, foundId)).limit(1);
      return c.json(shapeConversation(row!));
    }
    const [convo] = await db.insert(conversations).values({ projectId, type: "direct", createdById: uid }).returning();
    await db.insert(conversationMembers).values([
      { projectId, conversationId: convo!.id, userId: uid, role: "member" as const },
      { projectId, conversationId: convo!.id, userId: other, role: "member" as const },
    ]);
    return c.json(shapeConversation(convo!, { memberCount: 2 }), 201);
  })
  // Total unread across the user's active conversations. MUST stay above /conversations/:id
  // (the SDK's chat-context fetches this on load; otherwise "unread-count" is captured as an :id → 500).
  .get("/conversations/unread-count", requireAuth, async (c) => {
    const me = c.var.auth!.userId;
    const rows = (await db.execute(sql`
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
  .get("/conversations/:id", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    const [{ mc } = { mc: 0 }] = await db.select({ mc: count() }).from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.isActive, true)));
    return c.json(shapeConversation(convo, { memberCount: mc, currentMember: shapeConversationMember(member) }));
  })
  .patch("/conversations/:id", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    if (member.role !== "admin") throw Errors.forbidden("chat/not-admin", "Admin only");
    const body = parseBody(updateConversationSchema, await c.req.json().catch(() => ({})), "chat");
    const [row] = await db.update(conversations).set({
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
    await db.delete(conversations).where(eq(conversations.id, convo.id));
    emitToConversation(convo.id, "conversation:deleted", { conversationId: convo.id });
    return c.json({ success: true });
  })
  .delete("/conversations/:id/leave", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    await db.update(conversationMembers).set({ isActive: false, leftAt: new Date() })
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.userId, c.var.auth!.userId)));
    emitToConversation(convo.id, "member:left", { conversationId: convo.id, userId: c.var.auth!.userId });
    return c.json({ success: true });
  })
  .post("/conversations/:id/read", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    await db.update(conversationMembers).set({ lastReadAt: new Date() })
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.userId, c.var.auth!.userId)));
    return c.json({ success: true });
  })
  // ── members ────────────────────────────────────────────────────────────────
  .get("/conversations/:id/members", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    const rows = await db.select({ m: conversationMembers, p: profiles })
      .from(conversationMembers).innerJoin(profiles, eq(profiles.id, conversationMembers.userId))
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.isActive, true)))
      .orderBy(asc(conversationMembers.createdAt));
    return c.json({ data: rows.map((r) => shapeConversationMember(r.m, shapeUser(r.p))) });
  })
  .post("/conversations/:id/members", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    if (member.role !== "admin") throw Errors.forbidden("chat/not-admin", "Admin only");
    const body = parseBody(addConversationMemberSchema, await c.req.json().catch(() => ({})), "chat");
    const [row] = await db.insert(conversationMembers)
      .values({ projectId: c.var.projectId, conversationId: convo.id, userId: body.userId, role: body.role ?? "member" })
      .onConflictDoUpdate({ target: [conversationMembers.conversationId, conversationMembers.userId], set: { isActive: true, leftAt: null } })
      .returning();
    const [p] = await db.select().from(profiles).where(eq(profiles.id, body.userId)).limit(1);
    const shaped = shapeConversationMember(row!, p ? shapeUser(p) : null);
    emitToConversation(convo.id, "member:joined", { conversationId: convo.id, member: shaped });
    return c.json(shaped, 201);
  })
  .delete("/conversations/:id/members/:memberId", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    if (member.role !== "admin") throw Errors.forbidden("chat/not-admin", "Admin only");
    const target = c.req.param("memberId");
    await db.update(conversationMembers).set({ isActive: false, leftAt: new Date() })
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.userId, target)));
    emitToConversation(convo.id, "member:left", { conversationId: convo.id, userId: target });
    return c.json({ success: true });
  })
  .patch("/conversations/:id/members/:memberId/role", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    if (member.role !== "admin") throw Errors.forbidden("chat/not-admin", "Admin only");
    const { role } = parseBody(convMemberRoleSchema, await c.req.json().catch(() => ({})), "chat");
    const [row] = await db.update(conversationMembers).set({ role })
      .where(and(eq(conversationMembers.conversationId, convo.id), eq(conversationMembers.userId, c.req.param("memberId")))).returning();
    if (!row) throw Errors.notFound("chat/member-not-found", "Member not found");
    return c.json(shapeConversationMember(row));
  })
  // ── messages ───────────────────────────────────────────────────────────────
  .get("/conversations/:id/messages", requireAuth, async (c) => {
    // SDK contract (useChatMessages): cursor pagination, response `{ messages, hasMore }`.
    // Params: `limit`, `sort` (desc main stream / asc thread), `before` (ISO timestamp — fetch
    // messages created strictly before it), `parentId` (thread replies; absent ⇒ top-level stream).
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
    const order = c.req.query("sort") === "asc" ? asc(chatMessages.createdAt) : desc(chatMessages.createdAt);
    const parentId = c.req.query("parentId");
    const before = c.req.query("before"); // ISO timestamp cursor

    const conds = [eq(chatMessages.conversationId, convo.id)];
    // Main stream = top-level messages; thread view = replies to a specific parent.
    conds.push(parentId ? eq(chatMessages.parentMessageId, parentId) : sql`${chatMessages.parentMessageId} is null`);
    if (before) conds.push(sql`${chatMessages.createdAt} < ${before}::timestamptz`);

    const rows = await db.select().from(chatMessages)
      .where(and(...conds))
      .orderBy(order)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const reactionMap = await userReactionsByMessage(pageRows.map((r) => r.id), c.var.auth!.userId);
    const messages = pageRows.map((r) => shapeChatMessage(r, { userReactions: reactionMap.get(r.id) ?? [] }));
    return c.json({ messages, hasMore });
  })
  .post("/conversations/:id/messages", requireAuth, async (c) => {
    const convo = await getConversation(c);
    const member = await requireMember(c, convo.id);
    if (convo.postingPermission === "admins" && member.role !== "admin") {
      throw Errors.forbidden("chat/posting-restricted", "Only admins can post in this conversation");
    }
    const body = parseBody(sendMessageSchema, await c.req.json().catch(() => ({})), "chat");
    const check = await webhooks.validate(c.var.projectId, "message.created", { ...body, conversationId: convo.id, userId: c.var.auth!.userId });
    if (!check.valid) throw Errors.forbidden("chat/rejected", check.message ?? "Message rejected by validation webhook");
    // Trigger (0002) bumps conversation.last_message_at + parent thread_reply_count.
    const [row] = await db.insert(chatMessages).values({
      projectId: c.var.projectId, conversationId: convo.id, userId: c.var.auth!.userId,
      content: body.content, gif: body.gif, mentions: body.mentions, metadata: body.metadata,
      parentMessageId: body.parentMessageId, quotedMessageId: body.quotedMessageId,
    }).returning();
    const shaped = shapeChatMessage(row!);
    indexContentAsync(c.var.projectId, "message", row!.id, row!.content);
    emitToConversation(convo.id, "message:created", shaped);
    webhooks.broadcast(c.var.projectId, "message.created.complete", shaped);
    if (row!.parentMessageId) {
      const [parent] = await db.select({ n: chatMessages.threadReplyCount }).from(chatMessages).where(eq(chatMessages.id, row!.parentMessageId)).limit(1);
      emitToConversation(convo.id, "thread:reply_count", { messageId: row!.parentMessageId, conversationId: convo.id, threadReplyCount: parent?.n ?? 0 });
    }
    return c.json(shaped, 201);
  })
  .patch("/conversations/:id/messages/:messageId", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    const [msg] = await db.select().from(chatMessages)
      .where(and(eq(chatMessages.conversationId, convo.id), eq(chatMessages.id, c.req.param("messageId")))).limit(1);
    if (!msg) throw Errors.notFound("chat/message-not-found", "Message not found");
    if (msg.userId !== c.var.auth!.userId) throw Errors.forbidden("chat/not-author", "Not the message author");
    const body = parseBody(editMessageSchema, await c.req.json().catch(() => ({})), "chat");
    const [row] = await db.update(chatMessages).set({
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.gif !== undefined ? { gif: body.gif } : {}),
      ...(body.mentions !== undefined ? { mentions: body.mentions } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      editedAt: new Date(),
    }).where(eq(chatMessages.id, msg.id)).returning();
    emitToConversation(convo.id, "message:updated", {
      messageId: row!.id, conversationId: convo.id, content: row!.content, gif: row!.gif as any,
      mentions: row!.mentions as any, metadata: row!.metadata as any, editedAt: row!.editedAt,
    });
    return c.json(shapeChatMessage(row!));
  })
  .delete("/conversations/:id/messages/:messageId", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    const [msg] = await db.select().from(chatMessages)
      .where(and(eq(chatMessages.conversationId, convo.id), eq(chatMessages.id, c.req.param("messageId")))).limit(1);
    if (!msg) throw Errors.notFound("chat/message-not-found", "Message not found");
    if (msg.userId !== c.var.auth!.userId) throw Errors.forbidden("chat/not-author", "Not the message author");
    const now = new Date();
    await db.update(chatMessages).set({ userDeletedAt: now }).where(eq(chatMessages.id, msg.id));
    emitToConversation(convo.id, "message:deleted", { messageId: msg.id, conversationId: convo.id, userDeletedAt: now });
    return c.json({ success: true });
  })
  .post("/conversations/:id/messages/:messageId/reactions", requireAuth, async (c) => {
    const convo = await getConversation(c);
    await requireMember(c, convo.id);
    const messageId = c.req.param("messageId");
    const { emoji } = parseBody(messageReactionSchema, await c.req.json().catch(() => ({})), "chat");
    const uid = c.var.auth!.userId;
    const [existing] = await db.select({ id: chatMessageReactions.id }).from(chatMessageReactions)
      .where(and(eq(chatMessageReactions.messageId, messageId), eq(chatMessageReactions.userId, uid), eq(chatMessageReactions.emoji, emoji))).limit(1);
    const delta = existing ? -1 : 1;
    if (existing) await db.delete(chatMessageReactions).where(eq(chatMessageReactions.id, existing.id));
    else await db.insert(chatMessageReactions).values({ projectId: c.var.projectId, messageId, userId: uid, emoji });
    // Maintain the denormalized emoji->count map; drop the key when it hits 0.
    const [row] = await db.execute(sql`
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
    await db.insert(reports).values({
      projectId: c.var.projectId, reporterId: c.var.auth!.userId,
      targetType: "message", targetId: c.req.param("messageId"), reason: body.reason, details: body.details,
    });
    return c.json({ success: true }, 201);
  })
  // ── space conversation (get-or-create) ──────────────────────────────────────
  .get("/spaces/:spaceId/conversation", requireAuth, async (c) => {
    const projectId = c.var.projectId;
    const spaceId = c.req.param("spaceId");
    const [existing] = await db.select().from(conversations)
      .where(and(eq(conversations.projectId, projectId), eq(conversations.spaceId, spaceId), eq(conversations.type, "space"))).limit(1);
    if (existing) return c.json(shapeConversation(existing));
    const [convo] = await db.insert(conversations).values({ projectId, type: "space", spaceId, createdById: c.var.auth!.userId }).returning();
    await db.insert(conversationMembers).values({ projectId, conversationId: convo!.id, userId: c.var.auth!.userId, role: "admin" }).onConflictDoNothing();
    return c.json(shapeConversation(convo!), 201);
  });
