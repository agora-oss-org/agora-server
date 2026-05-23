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
import { parseBody, createCollectionSchema, addEntitySchema } from "../lib/validation.js";

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
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(collectionEntities)
      .where(eq(collectionEntities.collectionId, id));
    const rows = await db
      .select({ e: entities })
      .from(collectionEntities)
      .innerJoin(entities, eq(entities.id, collectionEntities.entityId))
      .where(and(eq(collectionEntities.collectionId, id), isNull(entities.deletedAt)))
      .orderBy(desc(collectionEntities.createdAt))
      .limit(limit).offset(offset);
    return c.json(paginate(rows.map((r) => shapeEntity(r.e)), n, page, limit));
  })
  .post("/:id/entities", requireAuth, async (c) => {
    await ownedCollection(c);
    const body = parseBody(addEntitySchema, await c.req.json().catch(() => ({})), "collections");
    await db.insert(collectionEntities)
      .values({ collectionId: c.req.param("id"), entityId: body.entityId })
      .onConflictDoNothing();
    return c.json({ success: true }, 201);
  })
  .delete("/:id/entities/:entityId", requireAuth, async (c) => {
    await ownedCollection(c);
    await db.delete(collectionEntities).where(and(
      eq(collectionEntities.collectionId, c.req.param("id")),
      eq(collectionEntities.entityId, c.req.param("entityId"))
    ));
    return c.json({ success: true });
  });
