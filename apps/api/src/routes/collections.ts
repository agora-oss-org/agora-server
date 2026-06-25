// /v7/:projectId/collections/*  — user-owned saved-entity folders (nestable).
import { Hono } from "hono";
import { and, eq, isNull, desc, count } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { collections, collectionEntities, entities } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { shapeCollection, shapeEntity } from "../lib/shape.js";
import { parseBody, createCollectionSchema, updateCollectionSchema, addEntitySchema } from "../lib/validation.js";

// Fetch a collection owned by the auth user, or throw 404/403.
async function ownedCollection(c: any) {
  const [row] = await db.select().from(collections)
    .where(and(eq(collections.projectId, c.var.projectId), eq(collections.id, c.req.param("id")))).limit(1);
  if (!row) throw Errors.notFound("collections/not-found", "Collection not found");
  if (row.userId !== c.var.auth.userId) throw Errors.forbidden("collections/not-owner", "Not your collection");
  return row;
}

export const collectionRoutes = new Hono<{ Variables: Variables }>()
  .post("/", requireAuth, async (c) => {
    const body = parseBody(createCollectionSchema, await c.req.json().catch(() => ({})), "collections");
    const [row] = await db.insert(collections)
      .values({ projectId: c.var.projectId, userId: c.var.auth!.userId, name: body.name, parentId: body.parentId })
      .returning();
    return c.json(shapeCollection(row!), 201);
  })
  .get("/root", requireAuth, async (c) => {
    const rows = await db.select().from(collections)
      .where(and(eq(collections.projectId, c.var.projectId), eq(collections.userId, c.var.auth!.userId), isNull(collections.parentId)))
      .orderBy(desc(collections.createdAt));
    return c.json({ data: rows.map(shapeCollection) });
  })
  .get("/:id", requireAuth, async (c) => {
    return c.json(shapeCollection(await ownedCollection(c)));
  })
  // SDK (useUpdateCollectionMutation) — rename / reparent a collection.
  .patch("/:id", requireAuth, async (c) => {
    await ownedCollection(c);
    const body = parseBody(updateCollectionSchema, await c.req.json().catch(() => ({})), "collections");
    const patch: { name?: string; parentId?: string | null } = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.parentId !== undefined) patch.parentId = body.parentId;
    const [row] = await db.update(collections).set(patch)
      .where(and(eq(collections.projectId, c.var.projectId), eq(collections.id, c.req.param("id"))))
      .returning();
    return c.json(shapeCollection(row!));
  })
  // SDK (useDeleteCollectionMutation) — delete a collection; FK cascades drop its
  // collection_entities rows and any sub-collections (parent_id → on delete cascade).
  .delete("/:id", requireAuth, async (c) => {
    await ownedCollection(c);
    await db.delete(collections)
      .where(and(eq(collections.projectId, c.var.projectId), eq(collections.id, c.req.param("id"))));
    return c.json({ success: true });
  })
  .get("/:id/sub-collections", requireAuth, async (c) => {
    await ownedCollection(c);
    const rows = await db.select().from(collections)
      .where(and(eq(collections.projectId, c.var.projectId), eq(collections.parentId, c.req.param("id"))))
      .orderBy(desc(collections.createdAt));
    return c.json({ data: rows.map(shapeCollection) });
  })
  .post("/:id/sub-collections", requireAuth, async (c) => {
    await ownedCollection(c);
    const body = parseBody(createCollectionSchema, await c.req.json().catch(() => ({})), "collections");
    const [row] = await db.insert(collections)
      .values({ projectId: c.var.projectId, userId: c.var.auth!.userId, name: body.name, parentId: c.req.param("id") })
      .returning();
    return c.json(shapeCollection(row!), 201);
  })
  .get("/:id/entities", requireAuth, async (c) => {
    await ownedCollection(c);
    const { page, limit, offset } = readPagination(c);
    const id = c.req.param("id");
    // Scope to the current project on the JOIN so a cross-project entity reference (defence in depth)
    // never leaks into this project's collection view — count and rows use the same predicate.
    const inProject = and(
      eq(collectionEntities.collectionId, id),
      eq(entities.projectId, c.var.projectId),
      isNull(entities.deletedAt),
    );
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(collectionEntities)
      .innerJoin(entities, eq(entities.id, collectionEntities.entityId))
      .where(inProject);
    const rows = await db
      .select({ e: entities })
      .from(collectionEntities)
      .innerJoin(entities, eq(entities.id, collectionEntities.entityId))
      .where(inProject)
      .orderBy(desc(collectionEntities.createdAt))
      .limit(limit).offset(offset);
    return c.json(paginate(rows.map((r) => shapeEntity(r.e)), n, page, limit));
  })
  .post("/:id/entities", requireAuth, async (c) => {
    await ownedCollection(c);
    const body = parseBody(addEntitySchema, await c.req.json().catch(() => ({})), "collections");
    const [entity] = await db.select({ id: entities.id }).from(entities)
      .where(and(eq(entities.projectId, c.var.projectId), eq(entities.id, body.entityId)))
      .limit(1);
    if (!entity) throw Errors.notFound("entity/not-found", "Entity not found in this project");
    await db.insert(collectionEntities)
      .values({ collectionId: c.req.param("id"), entityId: body.entityId })
      .onConflictDoNothing();
    return c.json({ success: true }, 201);
  })
  .delete("/:id/entities/:entityId", requireAuth, async (c) => {
    await ownedCollection(c);
    const [entity] = await db.select({ id: entities.id }).from(entities)
      .where(and(eq(entities.projectId, c.var.projectId), eq(entities.id, c.req.param("entityId"))))
      .limit(1);
    if (!entity) throw Errors.notFound("entity/not-found", "Entity not found in this project");
    await db.delete(collectionEntities).where(and(
      eq(collectionEntities.collectionId, c.req.param("id")),
      eq(collectionEntities.entityId, c.req.param("entityId"))
    ));
    return c.json({ success: true });
  });
