// /v7/:projectId/db/:tableName/*  — the SDK's generic custom-table store (useTable / tablesApi).
// A schemaless per-project JSONB row store. Access model: PER-ROW OWNERSHIP — a caller sees and
// mutates only the rows they created; project admins/operators bypass (god-view). All filter inputs
// (column names + values) are bound as parameters, never interpolated, per the security-first rule.
import { Hono } from "hono";
import { and, eq, isNull, isNotNull, desc, asc, count, or, sql, type SQL } from "drizzle-orm";
import type { Variables } from "../http/context.js";
import { Errors } from "../http/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { isProjectAdmin } from "../lib/project-roles.js";
import { getDb } from "../db/index.js";
import { tableRows } from "../db/schema/index.js";
import { readPagination, paginate } from "../http/envelope.js";
import { parseBody, tableRowBodySchema } from "../lib/validation.js";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Flatten managed columns + the free `data` object into the SDK's TableRow shape.
function shapeRow(row: typeof tableRows.$inferSelect) {
  return {
    ...(row.data as Record<string, unknown>),
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
  };
}

const NUMERIC = sql.raw("'^-?[0-9]+(\\.[0-9]+)?$'"); // guard so ::numeric never throws on a text column

// One DbFilter → a parameterized SQL predicate. `column` and `value` are bound, not interpolated.
function filterPredicate(f: { column?: unknown; operator?: unknown; value?: unknown }): SQL {
  const column = typeof f.column === "string" ? f.column : "";
  if (!column) throw Errors.badRequest("db/bad-filter", "Filter is missing a column", "filters");
  const col = sql`(${tableRows.data} ->> ${column})`;
  const numeric = (cmp: SQL) => sql`(${col} ~ ${NUMERIC} AND ${cmp})`;
  switch (f.operator) {
    case "eq": return sql`${col} = ${String(f.value)}`;
    case "ne": return sql`${col} IS DISTINCT FROM ${String(f.value)}`;
    case "gt": return numeric(sql`(${col})::numeric > ${Number(f.value)}`);
    case "gte": return numeric(sql`(${col})::numeric >= ${Number(f.value)}`);
    case "lt": return numeric(sql`(${col})::numeric < ${Number(f.value)}`);
    case "lte": return numeric(sql`(${col})::numeric <= ${Number(f.value)}`);
    case "in": {
      const arr = Array.isArray(f.value) ? f.value : [];
      if (!arr.length) return sql`false`;
      return sql`(${sql.join(arr.map((v) => sql`${col} = ${String(v)}`), sql` OR `)})`;
    }
    case "contains": return sql`${col} ILIKE ${"%" + String(f.value) + "%"}`;
    case "like": return sql`${col} LIKE ${String(f.value)}`;
    case "isNull": return sql`${col} IS NULL`;
    default: throw Errors.badRequest("db/bad-filter", `Unknown filter operator: ${String(f.operator)}`, "filters");
  }
}

function parseFilters(raw: string | undefined): SQL[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw Errors.badRequest("db/bad-filter", "filters must be valid JSON", "filters"); }
  if (!Array.isArray(parsed)) throw Errors.badRequest("db/bad-filter", "filters must be an array", "filters");
  return parsed.map((f) => filterPredicate(f as Record<string, unknown>));
}

// Per-row ownership: non-admins are scoped to rows they own. Admins/operators bypass.
function ownerScope(c: any): SQL | undefined {
  return isProjectAdmin(c.var.auth!) ? undefined : eq(tableRows.userId, c.var.auth!.userId);
}

export const dbRoutes = new Hono<{ Variables: Variables }>()
  .get("/:tableName", requireAuth, async (c) => {
    const { page, limit, offset } = readPagination(c);
    const includeDeleted = c.req.query("includeDeleted") === "true";
    const where = and(
      eq(tableRows.projectId, c.var.projectId),
      eq(tableRows.tableName, c.req.param("tableName")),
      ownerScope(c),
      includeDeleted ? undefined : isNull(tableRows.deletedAt),
      ...parseFilters(c.req.query("filters")),
    );
    const sortBy = c.req.query("sortBy");
    const dir = c.req.query("sortDir") === "asc" ? asc : desc;
    const orderBy = sortBy ? dir(sql`(${tableRows.data} ->> ${sortBy})`) : desc(tableRows.createdAt);
    const [{ n } = { n: 0 }] = await getDb().select({ n: count() }).from(tableRows).where(where);
    const rows = await getDb().select().from(tableRows).where(where).orderBy(orderBy).limit(limit).offset(offset);
    return c.json(paginate(rows.map(shapeRow), n, page, limit));
  })
  .post("/:tableName", requireAuth, async (c) => {
    const body = parseBody(tableRowBodySchema, await c.req.json().catch(() => ({})), "db");
    const [row] = await getDb().insert(tableRows).values({
      projectId: c.var.projectId, tableName: c.req.param("tableName"),
      userId: c.var.auth!.userId, data: body.data,
    }).returning();
    return c.json({ row: shapeRow(row!) }, 201);
  })
  .patch("/:tableName/:rowId", requireAuth, async (c) => {
    const body = parseBody(tableRowBodySchema, await c.req.json().catch(() => ({})), "db");
    const [row] = await getDb().update(tableRows).set({ data: body.data, updatedAt: new Date() }).where(and(
      eq(tableRows.projectId, c.var.projectId),
      eq(tableRows.tableName, c.req.param("tableName")),
      eq(tableRows.id, c.req.param("rowId")),
      ownerScope(c),
    )).returning();
    if (!row) throw Errors.notFound("db/row-not-found", "Row not found");
    return c.json({ row: shapeRow(row) });
  })
  .delete("/:tableName/:rowId", requireAuth, async (c) => {
    const force = c.req.query("force") === "true";
    const scope = and(
      eq(tableRows.projectId, c.var.projectId),
      eq(tableRows.tableName, c.req.param("tableName")),
      eq(tableRows.id, c.req.param("rowId")),
      ownerScope(c),
    );
    if (force) {
      const [row] = await getDb().delete(tableRows).where(scope).returning({ id: tableRows.id });
      if (!row) throw Errors.notFound("db/row-not-found", "Row not found");
      return c.json({ deleted: true, soft: false });
    }
    const [row] = await getDb().update(tableRows).set({ deletedAt: new Date() }).where(scope).returning({ id: tableRows.id });
    if (!row) throw Errors.notFound("db/row-not-found", "Row not found");
    return c.json({ deleted: true, soft: true });
  })
  .post("/:tableName/:rowId/restore", requireAuth, async (c) => {
    const [row] = await getDb().update(tableRows).set({ deletedAt: null, updatedAt: new Date() }).where(and(
      eq(tableRows.projectId, c.var.projectId),
      eq(tableRows.tableName, c.req.param("tableName")),
      eq(tableRows.id, c.req.param("rowId")),
      isNotNull(tableRows.deletedAt),
      ownerScope(c),
    )).returning();
    if (!row) throw Errors.notFound("db/row-not-found", "Row not found or not deleted");
    return c.json({ row: shapeRow(row) });
  });
