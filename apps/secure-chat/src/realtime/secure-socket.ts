// Secure-chat realtime — a SEPARATE socket.io namespace ("/secure") for defense-in-depth, so
// ciphertext delivery never mixes with the plaintext-chat handlers in socket.ts. Payloads are
// ciphertext-only (the contract's Secure*Model shapes). Realtime is a notification optimization;
// the REST `GET /handshakes?since=` + `GET /messages` endpoints remain the durable source of
// truth for offline catch-up.
//
// Rooms:
//   secure:conv:{conversationId}  — membership-gated; broadcast Commits + application messages
//   secure:device:{deviceId}      — auto-joined for each device the user owns; targeted Welcomes
import { Server, type Namespace, type Socket } from "socket.io";
import { type Server as HttpServer } from "node:http";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@agora/core/db";
import { secureConversationMembers, secureDevices } from "@agora/core/db/schema";
import { jwtVerify } from "jose";
import { env } from "@agora/core/lib/env";
import { hasActiveSuspension } from "@agora/core/lib/suspensions";
import { logger } from "@agora/core/lib/logger";
import type { SecureMessageModel, SecureHandshakeModel } from "@agora-server/contract";

export interface SecureServerToClientEvents {
  "secure:message": (p: SecureMessageModel) => void;
  "secure:handshake": (p: SecureHandshakeModel) => void; // broadcast Commit/Proposal
  "secure:welcome": (p: SecureHandshakeModel) => void; // targeted to a device room
  "secure:member:joined": (p: { conversationId: string; userId: string; epoch: string }) => void;
  "secure:member:left": (p: { conversationId: string; userId: string; epoch: string }) => void;
  "secure:key-packages-low": (p: { deviceId: string; available: number }) => void;
  "secure:typing:start": (p: { userId: string; conversationId: string }) => void;
  "secure:typing:stop": (p: { userId: string; conversationId: string }) => void;
}

export interface SecureClientToServerEvents {
  "join:secure-conversation": (p: { conversationId: string }) => void;
  "leave:secure-conversation": (p: { conversationId: string }) => void;
  "join:secure-device": (p: { deviceId: string }) => void;
  "secure:typing:start": (p: { conversationId: string }) => void;
  "secure:typing:stop": (p: { conversationId: string }) => void;
}

interface SecureSocketData {
  userId: string;
  projectId: string;
}

type SecureNamespace = Namespace<SecureClientToServerEvents, SecureServerToClientEvents, Record<string, never>, SecureSocketData>;
type SecureSocket = Socket<SecureClientToServerEvents, SecureServerToClientEvents, Record<string, never>, SecureSocketData>;

const accessSecret = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);
const convRoom = (conversationId: string) => `secure:conv:${conversationId}`;
const deviceRoom = (deviceId: string) => `secure:device:${deviceId}`;

// Client-supplied ids are untrusted: a malformed payload (e.g. `{ conversationId: undefined }`)
// must be rejected at the boundary — never fed to a query, where postgres throws `UNDEFINED_VALUE`.
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// socket.io does NOT catch rejections from async listeners — an unhandled one crashes the process.
// Wrap every handler so a thrown/rejected handler logs (message-only `error` + raw `err` on `debug`,
// per Log-with-intent) and is contained. Realtime is best-effort; a bad event must not take the API down.
function safeOn<E extends keyof SecureClientToServerEvents>(
  socket: SecureSocket,
  event: E,
  handler: (...args: Parameters<SecureClientToServerEvents[E]>) => void | Promise<void>,
) {
  const on = socket.on.bind(socket) as (e: E, l: (...a: Parameters<SecureClientToServerEvents[E]>) => void) => void;
  on(event, (...args) => {
    try {
      const r = handler(...args);
      if (r instanceof Promise) r.catch((err) => logHandlerFailure(event, err));
    } catch (err) {
      logHandlerFailure(event, err);
    }
  });
}

function logHandlerFailure(event: string, err: unknown) {
  logger.error(`secure-socket: handler "${String(event)}" failed`);
  logger.debug({ err, event }, `secure-socket: handler "${String(event)}" failed`);
}

// Module-level handle so REST handlers can fan out without threading the namespace through.
let secureRef: SecureNamespace | null = null;

async function isSecureMember(projectId: string, conversationId: string, userId: string): Promise<boolean> {
  const [m] = await db.select({ id: secureConversationMembers.id }).from(secureConversationMembers)
    .where(and(
      eq(secureConversationMembers.projectId, projectId),
      eq(secureConversationMembers.conversationId, conversationId),
      eq(secureConversationMembers.userId, userId),
      eq(secureConversationMembers.isActive, true),
    )).limit(1);
  return !!m;
}

// Stand up the secure realtime server (called from index.ts with the Node HTTP server).
//
// Unlike the plaintext chat socket, @agora/secure-chat runs in its OWN process, so it owns its OWN
// socket.io server. socket.io namespaces ("/secure") multiplex over a single engine.io PATH and the
// namespace is in the Socket.IO packet, NOT the URL — so a path-routing reverse proxy can't split a
// shared "/socket.io/" between two backends. We therefore give this server a DISTINCT engine.io path,
// "/secure-socket/", which the edge CAN route to this process. The namespace name "/secure" and every
// event name stay byte-identical to the contract (docs/MANIFEST.md §4); only the connection path moves.
// SDK consumers connect with: io(`${secureOrigin}/secure`, { path: "/secure-socket/", auth, query }).
export function attachSecureRealtime(httpServer: HttpServer): Server {
  const io = new Server(httpServer, { path: "/secure-socket/", cors: { origin: env.CORS_ORIGIN } });
  const secure = io.of("/secure") as unknown as SecureNamespace;
  secureRef = secure;

  // Same handshake auth as the main namespace: auth.token (HS256 over ACCESS_TOKEN_SECRET) + query.projectId.
  secure.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      const projectId = socket.handshake.query?.projectId as string | undefined;
      if (!token || !projectId) {
        logger.trace({ projectId: projectId ?? null, hasToken: !!token }, "secure-socket: handshake rejected (missing token/projectId)");
        return next(new Error("unauthorized"));
      }
      const { payload } = await jwtVerify(token, accessSecret, { algorithms: ["HS256"] });
      if (!payload.sub) {
        logger.trace({ projectId }, "secure-socket: handshake rejected (no subject)");
        return next(new Error("unauthorized"));
      }
      // Enforce suspensions here too — the /secure namespace must not let a suspended user keep
      // receiving E2E traffic (mirrors middleware/auth.ts requireAuth). Operators AND project
      // owners bypass (deployment god-view / no owner self-lockout).
      const privileged = payload.operator === true || payload.powner === true;
      if (!privileged && (await hasActiveSuspension(payload.sub))) {
        logger.debug({ projectId, userId: payload.sub }, "secure-socket: handshake rejected (suspended)");
        return next(new Error("suspended"));
      }
      socket.data.userId = payload.sub;
      socket.data.projectId = projectId;
      next();
    } catch {
      logger.trace("secure-socket: handshake rejected (token verify failed)");
      next(new Error("unauthorized"));
    }
  });

  secure.on("connection", (socket: SecureSocket) => {
    logger.trace({ projectId: socket.data.projectId, userId: socket.data.userId, socketId: socket.id }, "secure-socket: connected");
    // Auto-join the device rooms for every active device this user owns, so targeted Welcomes arrive.
    void (async () => {
      const devices = await db.select({ id: secureDevices.id }).from(secureDevices)
        .where(and(
          eq(secureDevices.projectId, socket.data.projectId),
          eq(secureDevices.userId, socket.data.userId),
          isNull(secureDevices.revokedAt),
        ));
      for (const d of devices) socket.join(deviceRoom(d.id));
      // Diagnostic for the "waiting for key update" failure: a targeted Welcome only arrives in
      // realtime if THIS socket joined that device's room. The set of joined device-row ids tells
      // you exactly whether the browser's live device is reachable — and surfaces device churn
      // (many stale rows ⇒ Welcomes addressed to a device this connection no longer represents).
      logger.debug({ projectId: socket.data.projectId, userId: socket.data.userId, socketId: socket.id, deviceRooms: devices.map((d) => d.id) }, "secure-socket: device rooms auto-joined");
    })().catch((err) => logHandlerFailure("connection", err)); // a DB hiccup here must not crash the server

    safeOn(socket, "join:secure-conversation", async ({ conversationId }) => {
      if (!isId(conversationId)) {
        logger.trace({ projectId: socket.data.projectId, userId: socket.data.userId }, "secure-socket: join conversation rejected (invalid conversationId)");
        return;
      }
      const ok = await isSecureMember(socket.data.projectId, conversationId, socket.data.userId);
      if (ok) socket.join(convRoom(conversationId));
      logger.trace({ projectId: socket.data.projectId, userId: socket.data.userId, conversationId, joined: ok }, "secure-socket: join conversation");
    });
    safeOn(socket, "leave:secure-conversation", ({ conversationId }) => {
      if (!isId(conversationId)) return;
      socket.leave(convRoom(conversationId));
      logger.trace({ projectId: socket.data.projectId, userId: socket.data.userId, conversationId }, "secure-socket: leave conversation");
    });
    safeOn(socket, "join:secure-device", async ({ deviceId }) => {
      if (!isId(deviceId)) {
        logger.trace({ projectId: socket.data.projectId, userId: socket.data.userId }, "secure-socket: join device rejected (invalid deviceId)");
        return;
      }
      // Only join a device room the caller actually owns.
      const [own] = await db.select({ id: secureDevices.id }).from(secureDevices)
        .where(and(
          eq(secureDevices.projectId, socket.data.projectId),
          eq(secureDevices.id, deviceId),
          eq(secureDevices.userId, socket.data.userId),
        )).limit(1);
      if (own) socket.join(deviceRoom(deviceId));
      logger.trace({ projectId: socket.data.projectId, userId: socket.data.userId, deviceId, joined: !!own }, "secure-socket: join device room");
    });
    safeOn(socket, "secure:typing:start", ({ conversationId }) => {
      if (!isId(conversationId)) return;
      socket.to(convRoom(conversationId)).emit("secure:typing:start", { userId: socket.data.userId, conversationId });
    });
    safeOn(socket, "secure:typing:stop", ({ conversationId }) => {
      if (!isId(conversationId)) return;
      socket.to(convRoom(conversationId)).emit("secure:typing:stop", { userId: socket.data.userId, conversationId });
    });
  });

  // Return the socket.io Server (not the namespace) so callers/tests can close it; the module-level
  // `secureRef` namespace is what the REST fan-out helpers use.
  return io;
}

// REST handlers call these after writing to Postgres. No-op if the namespace isn't attached (tests).
export function emitToSecureConversation<E extends keyof SecureServerToClientEvents>(
  conversationId: string,
  event: E,
  ...args: Parameters<SecureServerToClientEvents[E]>
) {
  logger.trace({ conversationId, event, attached: !!secureRef }, "secure-socket: emit to conversation");
  secureRef?.to(convRoom(conversationId)).emit(event, ...args);
}

export function emitToSecureDevice<E extends keyof SecureServerToClientEvents>(
  deviceId: string,
  event: E,
  ...args: Parameters<SecureServerToClientEvents[E]>
) {
  logger.trace({ deviceId, event, attached: !!secureRef }, "secure-socket: emit to device");
  secureRef?.to(deviceRoom(deviceId)).emit(event, ...args);
}
