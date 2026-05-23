// Socket.io realtime server — must speak the EXACT event contract the SDK expects
// (docs/MANIFEST.md §4). Drop-in-incompatible with raw ws / Supabase Realtime.
//
// Connection from SDK: io(origin, { auth: { token }, query: { projectId } })
import { Server, type Socket } from "socket.io";
import type { Server as HttpServer } from "node:http";
import { jwtVerify } from "jose";
import { env } from "../lib/env.js";

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

export function attachRealtime(httpServer: HttpServer) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
    httpServer,
    { cors: { origin: env.CORS_ORIGIN } }
  );

  // Authenticate from handshake auth.token + scope by query.projectId.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      const projectId = socket.handshake.query?.projectId as string | undefined;
      if (!token || !projectId) return next(new Error("unauthorized"));
      const { payload } = await jwtVerify(token, accessSecret);
      if (!payload.sub) return next(new Error("unauthorized"));
      socket.data.userId = payload.sub;
      socket.data.projectId = projectId;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>) => {
    socket.on("join:conversation", ({ conversationId }) => {
      // TODO: verify membership before joining
      socket.join(room(conversationId));
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

// REST handlers call these to fan out durable events after writing to Postgres.
// e.g. after POST /chat/.../messages: emitToConversation(io, convId, "message:created", row)
export function emitToConversation<E extends keyof ServerToClientEvents>(
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
  conversationId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
) {
  io.to(room(conversationId)).emit(event, ...args);
}
