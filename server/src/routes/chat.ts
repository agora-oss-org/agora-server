// /v7/:projectId/chat/*  (REST side; realtime is socket.io — see realtime/socket.ts)
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const chatRoutes = new Hono<{ Variables: Variables }>()
  .get("/conversations", (c) => { throw Errors.notImplemented("chat/conversations"); })
  .post("/conversations", (c) => { throw Errors.notImplemented("chat/create-conversation"); })
  .post("/conversations/direct", (c) => { throw Errors.notImplemented("chat/direct-conversation"); })
  .get("/conversations/:id", (c) => { throw Errors.notImplemented("chat/conversation"); })
  .patch("/conversations/:id", (c) => { throw Errors.notImplemented("chat/update-conversation"); })
  .delete("/conversations/:id", (c) => { throw Errors.notImplemented("chat/delete-conversation"); })
  .delete("/conversations/:id/leave", (c) => { throw Errors.notImplemented("chat/leave"); })
  .post("/conversations/:id/read", (c) => { throw Errors.notImplemented("chat/mark-read"); })
  .get("/conversations/:id/members", (c) => { throw Errors.notImplemented("chat/members"); })
  .post("/conversations/:id/members", (c) => { throw Errors.notImplemented("chat/add-member"); })
  .delete("/conversations/:id/members/:memberId", (c) => { throw Errors.notImplemented("chat/remove-member"); })
  .patch("/conversations/:id/members/:memberId/role", (c) => { throw Errors.notImplemented("chat/member-role"); })
  .get("/conversations/:id/messages", (c) => { throw Errors.notImplemented("chat/messages"); })
  .post("/conversations/:id/messages", (c) => { throw Errors.notImplemented("chat/send-message"); })
  .patch("/conversations/:id/messages/:messageId", (c) => { throw Errors.notImplemented("chat/edit-message"); })
  .delete("/conversations/:id/messages/:messageId", (c) => { throw Errors.notImplemented("chat/delete-message"); })
  .post("/conversations/:id/messages/:messageId/reactions", (c) => { throw Errors.notImplemented("chat/react"); })
  .post("/conversations/:id/messages/:messageId/report", (c) => { throw Errors.notImplemented("chat/report-message"); })
  .get("/spaces/:spaceId/conversation", (c) => { throw Errors.notImplemented("chat/space-conversation"); });
