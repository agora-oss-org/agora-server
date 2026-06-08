// Secure-chat realtime — a SEPARATE socket.io namespace ("/secure") for defense-in-depth, so
// ciphertext delivery never mixes with the plaintext-chat handlers in socket.ts. Payloads are
// ciphertext-only (the contract's Secure*Model shapes). Realtime is a notification optimization;
// the REST `GET /handshakes?since=` + `GET /messages` endpoints remain the durable source of
// truth for offline catch-up.
//
// Rooms:
//   secure:conv:{conversationId}  — membership-gated; broadcast Commits + application messages
//   secure:device:{deviceId}      — auto-joined for each device the user owns; targeted Welcomes
import { type Server, type Namespace, type Socket } from "socket.io";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { secureConversationMembers, secureDevices } from "../db/schema/index.js";
import { jwtVerify } from "jose";
import { env } from "../lib/env.js";
import { hasActiveSuspension } from "../lib/suspensions.js";
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

// Attach the /secure namespace to the shared socket.io server (called from attachRealtime).
export function attachSecureRealtime(io: Server): SecureNamespace {
  const secure = io.of("/secure") as unknown as SecureNamespace;
  secureRef = secure;

  // Same handshake auth as the main namespace: auth.token (HS256 over ACCESS_TOKEN_SECRET) + query.projectId.
  secure.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      const projectId = socket.handshake.query?.projectId as string | undefined;
      if (!token || !projectId) return next(new Error("unauthorized"));
      const { payload } = await jwtVerify(token, accessSecret, { algorithms: ["HS256"] });
      if (!payload.sub) return next(new Error("unauthorized"));
      // Enforce suspensions here too — the /secure namespace must not let a suspended user keep
      // receiving E2E traffic (mirrors middleware/auth.ts requireAuth). Operators bypass.
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

  secure.on("connection", (socket: SecureSocket) => {
    // Auto-join the device rooms for every active device this user owns, so targeted Welcomes arrive.
    void (async () => {
      const devices = await db.select({ id: secureDevices.id }).from(secureDevices)
        .where(and(
          eq(secureDevices.projectId, socket.data.projectId),
          eq(secureDevices.userId, socket.data.userId),
          isNull(secureDevices.revokedAt),
        ));
      for (const d of devices) socket.join(deviceRoom(d.id));
    })();

    socket.on("join:secure-conversation", async ({ conversationId }) => {
      if (await isSecureMember(socket.data.projectId, conversationId, socket.data.userId)) {
        socket.join(convRoom(conversationId));
      }
    });
    socket.on("leave:secure-conversation", ({ conversationId }) => {
      socket.leave(convRoom(conversationId));
    });
    socket.on("join:secure-device", async ({ deviceId }) => {
      // Only join a device room the caller actually owns.
      const [own] = await db.select({ id: secureDevices.id }).from(secureDevices)
        .where(and(
          eq(secureDevices.projectId, socket.data.projectId),
          eq(secureDevices.id, deviceId),
          eq(secureDevices.userId, socket.data.userId),
        )).limit(1);
      if (own) socket.join(deviceRoom(deviceId));
    });
    socket.on("secure:typing:start", ({ conversationId }) => {
      socket.to(convRoom(conversationId)).emit("secure:typing:start", { userId: socket.data.userId, conversationId });
    });
    socket.on("secure:typing:stop", ({ conversationId }) => {
      socket.to(convRoom(conversationId)).emit("secure:typing:stop", { userId: socket.data.userId, conversationId });
    });
  });

  return secure;
}

// REST handlers call these after writing to Postgres. No-op if the namespace isn't attached (tests).
export function emitToSecureConversation<E extends keyof SecureServerToClientEvents>(
  conversationId: string,
  event: E,
  ...args: Parameters<SecureServerToClientEvents[E]>
) {
  secureRef?.to(convRoom(conversationId)).emit(event, ...args);
}

export function emitToSecureDevice<E extends keyof SecureServerToClientEvents>(
  deviceId: string,
  event: E,
  ...args: Parameters<SecureServerToClientEvents[E]>
) {
  secureRef?.to(deviceRoom(deviceId)).emit(event, ...args);
}
