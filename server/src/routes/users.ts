// /v7/:projectId/users/*
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const userRoutes = new Hono<{ Variables: Variables }>()
  .get("/by-foreign-id", (c) => { throw Errors.notImplemented("users/by-foreign-id"); })
  .get("/by-username", (c) => { throw Errors.notImplemented("users/by-username"); })
  .get("/check-username", (c) => { throw Errors.notImplemented("users/check-username"); })
  .get("/suggestions", (c) => { throw Errors.notImplemented("users/suggestions"); })
  .get("/:id", (c) => { throw Errors.notImplemented("users/get"); })
  .patch("/:id", (c) => { throw Errors.notImplemented("users/update"); })
  // follow relationship under the user resource
  .get("/:id/follow", (c) => { throw Errors.notImplemented("users/follow-status"); })
  .post("/:id/follow", (c) => { throw Errors.notImplemented("users/follow"); })
  .delete("/:id/follow", (c) => { throw Errors.notImplemented("users/unfollow"); })
  .get("/:id/followers", (c) => { throw Errors.notImplemented("users/followers"); })
  .get("/:id/following", (c) => { throw Errors.notImplemented("users/following"); })
  .get("/:id/followers-count", (c) => { throw Errors.notImplemented("users/followers-count"); })
  .get("/:id/following-count", (c) => { throw Errors.notImplemented("users/following-count"); })
  .get("/:id/connections-count", (c) => { throw Errors.notImplemented("users/connections-count"); });
