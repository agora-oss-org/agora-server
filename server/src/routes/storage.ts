// /v7/:projectId/storage/*  (uploads land in Supabase Storage; rows in `files`)
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";

export const storageRoutes = new Hono<{ Variables: Variables }>()
  .post("/", (c) => { throw Errors.notImplemented("storage/upload"); })
  .post("/images", (c) => { throw Errors.notImplemented("storage/upload-image"); }); // sharp variants -> FileImage
