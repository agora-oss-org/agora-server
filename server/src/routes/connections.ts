// /v7/:projectId/connections/*
// State machine: none → pending(sent/received) → connected | declined.
// NOTE: exact paths to be confirmed against the OpenAPI spec (see MANIFEST §3 — the
// connections module wasn't fully visible in the axios sweep). Stubs below reflect the
// operations the SDK exposes; connections also use a NON-standard pagination envelope.
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const connectionRoutes = new Hono<{ Variables: Variables }>()
  .get("/", (c) => { throw Errors.notImplemented("connections/list"); })          // established connections
  .get("/pending", (c) => { throw Errors.notImplemented("connections/pending"); }) // received + sent
  .get("/status/:userId", (c) => { throw Errors.notImplemented("connections/status"); })
  .get("/count", (c) => { throw Errors.notImplemented("connections/count"); })
  .post("/", (c) => { throw Errors.notImplemented("connections/request"); })       // send request
  .post("/:id/accept", (c) => { throw Errors.notImplemented("connections/accept"); })
  .post("/:id/decline", (c) => { throw Errors.notImplemented("connections/decline"); })
  .delete("/:id", (c) => { throw Errors.notImplemented("connections/withdraw-or-disconnect"); });
