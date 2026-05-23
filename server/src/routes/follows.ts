// /v7/:projectId/follows/*
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const followRoutes = new Hono<{ Variables: Variables }>()
  .get("/followers", (c) => { throw Errors.notImplemented("follows/followers"); })
  .get("/following", (c) => { throw Errors.notImplemented("follows/following"); })
  .get("/followers-count", (c) => { throw Errors.notImplemented("follows/followers-count"); })
  .get("/following-count", (c) => { throw Errors.notImplemented("follows/following-count"); })
  .delete("/:id", (c) => { throw Errors.notImplemented("follows/delete"); });
