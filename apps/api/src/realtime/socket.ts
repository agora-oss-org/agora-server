// Socket.io realtime server — must speak the EXACT event contract the SDK expects
// (docs/MANIFEST.md §4). Drop-in-incompatible with raw ws / Supabase Realtime.
//
// Connection from SDK: io(origin, { auth: { token }, query: { projectId } })
import { Server, type Socket } from "socket.io";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { conversationMembers } from "../db/schema/index.js";
import type { Server as HttpServer } from "node:http";
import { jwtVerify } from "jose";
import { env } from "../lib/env.js";
import { hasActiveSuspension } from "../lib/suspensions.js";
import { attachSecureRealtime } from "./secure-socket.js";

// ── Event payload contracts (mirror @replyke/core/src/types/socket.ts) ──────────
export interface ServerToClientEvents {
  "message:created": (m: unknown) => void;
  "message:updated": (p: { messageId: string; conversationId: string; content: string | null; gif: unknown; mentions: unknown; metadata: Record<string, unknown>; editedAt: Date | null }) => void;
  "message:deleted": (p: { messageId: string; conversationId: string; userDeletedAt: Date }) => void;
  "message:removed": (p: { messageId: string; conversationId: string }) => void;
  "message:reaction": (p: { messageId: string; conversationId: string; emoji: string; userId: string; delta: 1 | -1; reactionCounts: Record<string, number> }) => void;
  "thread:reply_count": (p: { messageId: string; conversationId: string; threadReplyCount: number }) => void;
  "typing:start": (p: { userId: string; conversationId: string }) => void;
  "typing:stop": (p: { userId: string; conversationId: string }) => void;
  "member:joined": (p: { conversationId: string; member: unknown }) => void;
  "member:left": (p: { conversationId: string; userId: string }) => void;
  "conversation:updated": (patch: { id: string } & Record<string, unknown>) => void;
  "conversation:deleted": (p: { conversationId: string }) => void;
}

export interface ClientToServerEvents {
  "join:conversation": (p: { conversationId: string }) => void;
  "leave:conversation": (p: { conversationId: string }) => void;
  "typing:start": (p: { conversationId: string }) => void;
  "typing:stop": (p: { conversationId: string }) => void;
}

interface SocketData {
  userId: string;
  projectId: string;
}

const accessSecret = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);
const room = (conversationId: string) => `conversation:${conversationId}`;

type AgoraIO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

async function isConversationMember(projectId: string, conversationId: string, userId: string): Promise<boolean> {
  const [m] = await db.select({ id: conversationMembers.id }).from(conversationMembers)
    .where(and(
      eq(conversationMembers.projectId, projectId),
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
      eq(conversationMembers.isActive, true)
    )).limit(1);
  return !!m;
}

// Module-level handle so REST handlers can fan out events without threading `io` through.
let ioRef: AgoraIO | null = null;

export function attachRealtime(httpServer: HttpServer) {
  const io: AgoraIO = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
    httpServer,
    { cors: { origin: env.CORS_ORIGIN } }
  );
  ioRef = io;

  // Secure chat (E2E) gets its own "/secure" namespace on the same server (ciphertext only).
  attachSecureRealtime(io);

  // Authenticate from handshake auth.token + scope by query.projectId.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      const projectId = socket.handshake.query?.projectId as string | undefined;
      if (!token || !projectId) return next(new Error("unauthorized"));
      const { payload } = await jwtVerify(token, accessSecret, { algorithms: ["HS256"] });
      if (!payload.sub) return next(new Error("unauthorized"));
      // Enforce suspensions on the realtime path too (mirrors middleware/auth.ts requireAuth):
      // a suspended user must not keep receiving live events. Operators bypass (no self-lockout).
      if (payload.operator !== true && (await hasActiveSuspension(payload.sub))) {
        return next(new Error("suspended"));
      }
      socket.data.userId = payload.sub;
      socket.data.projectId = projectId;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>) => {
    socket.on("join:conversation", async ({ conversationId }) => {
      // Only members may subscribe to a conversation's room.
      if (await isConversationMember(socket.data.projectId, conversationId, socket.data.userId)) {
        socket.join(room(conversationId));
      }
    });
    socket.on("leave:conversation", ({ conversationId }) => {
      socket.leave(room(conversationId));
    });
    socket.on("typing:start", ({ conversationId }) => {
      socket.to(room(conversationId)).emit("typing:start", { userId: socket.data.userId, conversationId });
    });
    socket.on("typing:stop", ({ conversationId }) => {
      socket.to(room(conversationId)).emit("typing:stop", { userId: socket.data.userId, conversationId });
    });
  });

  return io;
}

// REST handlers call this to fan out durable events after writing to Postgres.
// No-op if the socket server isn't attached (e.g. in tests). e.g. after sending a message:
//   emitToConversation(convId, "message:created", shapedMessage)
export function emitToConversation<E extends keyof ServerToClientEvents>(
  conversationId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
) {
  ioRef?.to(room(conversationId)).emit(event, ...args);
}
