// The env-mode singleton — Drizzle over a direct postgres.js connection built from
// DATABASE_URL. INTERNAL: application code must use getDb() (context.js), never this
// directly; the ALS seam is what makes per-tenant routing possible (spec §4).
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../lib/env.js";
import * as schema from "./schema/index.js";

// DATABASE_URL points at a transaction-mode pooler (e.g. Supabase :6543), so prepared
// statements must be disabled — pgbouncer transaction mode doesn't support them.
const client = postgres(env.DATABASE_URL, { prepare: false });

export const sharedDb = drizzle(client, { schema });
