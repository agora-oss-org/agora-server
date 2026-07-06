// Request-scoped DB accessor (spec §4.2). resolveProject runs each request inside
// runWithDb(<tenant handle>); getDb() reads it back anywhere downstream — including
// detached fire-and-forget promises, which inherit the ALS context automatically.
// Outside any scope (crons, scripts, boot) it falls back to the env-mode singleton.
// SAFETY: nothing per-request ever writes module scope; the ALS store is per-continuation.
import { AsyncLocalStorage } from "node:async_hooks";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "./schema/index.js";
import { sharedDb } from "./shared.js";

export type Db = PostgresJsDatabase<typeof schema>;

const als = new AsyncLocalStorage<Db>();

export function getDb(): Db {
  return als.getStore() ?? sharedDb;
}

export function runWithDb<T>(db: Db, fn: () => T): T {
  return als.run(db, fn);
}
