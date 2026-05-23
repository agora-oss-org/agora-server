// /v7/:projectId/entities/*
// GET /:id is fleshed out as the reference pattern (Supabase + project scoping +
// error envelope). The rest are wired stubs — same shape, fill in the query.
import { Hono } from "hono";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { supabase } from "../lib/supabase.js";

export const entityRoutes = new Hono<{ Variables: Variables }>()
  .get("/", (c) => { throw Errors.notImplemented("entities/list"); })          // feed (filters, sort, pagination)
  .post("/", (c) => { throw Errors.notImplemented("entities/create"); })
  .get("/drafts", (c) => { throw Errors.notImplemented("entities/drafts"); })
  .get("/by-foreign-id", (c) => { throw Errors.notImplemented("entities/by-foreign-id"); })
  .get("/by-short-id", (c) => { throw Errors.notImplemented("entities/by-short-id"); })
  .get("/is-entity-saved", (c) => { throw Errors.notImplemented("entities/is-saved"); })
  .get("/:id", async (c) => {
    const projectId = c.var.projectId;
    const id = c.req.param("id");
    const { data, error } = await supabase
      .from("entities")
      .select("*")
      .eq("project_id", projectId)
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw Errors.badRequest("entities/lookup-failed", error.message);
    if (!data) throw Errors.notFound("entities/not-found", "Entity not found");
    // TODO: shape row -> Entity (camelCase, include space/user/topComment/saved per ?include=)
    return c.json(data);
  })
  .patch("/:id", (c) => { throw Errors.notImplemented("entities/update"); })
  .delete("/:id", (c) => { throw Errors.notImplemented("entities/delete"); })
  .post("/:id/publish", (c) => { throw Errors.notImplemented("entities/publish"); })
  // reaction toggle -> supabase.rpc('toggle_reaction', {...}) then refresh_entity_score
  .post("/:id/reactions", (c) => { throw Errors.notImplemented("entities/react"); })
  .delete("/:id/reactions", (c) => { throw Errors.notImplemented("entities/unreact"); });
