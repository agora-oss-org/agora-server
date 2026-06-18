// Drizzle client over a direct Postgres connection (postgres.js). This is the
// primary data layer; the Supabase client is reserved for Auth + Storage.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../lib/env.js";
import * as schema from "./schema/index.js";

// DATABASE_URL points at Supabase's transaction pooler (port 6543), so prepared
// statements must be disabled — pgbouncer transaction mode doesn't support them.
const client = postgres(env.DATABASE_URL, { prepare: false });

export const db = drizzle(client, { schema });
export { schema };
