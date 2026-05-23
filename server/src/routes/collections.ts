// /v7/:projectId/collections/*
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const collectionRoutes = new Hono<{ Variables: Variables }>()
  .get("/root", (c) => { throw Errors.notImplemented("collections/root"); })
  .get("/:id", (c) => { throw Errors.notImplemented("collections/get"); })
  .get("/:id/sub-collections", (c) => { throw Errors.notImplemented("collections/sub-collections"); })
  .post("/:id/sub-collections", (c) => { throw Errors.notImplemented("collections/create-sub"); })
  .get("/:id/entities", (c) => { throw Errors.notImplemented("collections/entities"); })
  .post("/:id/entities", (c) => { throw Errors.notImplemented("collections/add-entity"); })
  .delete("/:id/entities/:entityId", (c) => { throw Errors.notImplemented("collections/remove-entity"); });
