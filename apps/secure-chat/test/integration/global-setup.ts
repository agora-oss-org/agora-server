// Runs once before the secure-chat integration suite: apply Drizzle migrations to TEST_DATABASE_URL.
// The migrations live in @agora/api (apps/api/drizzle) — in v1 secure-chat shares the main Postgres and
// the single migrator, so we point at that folder ("../api/drizzle", relative to the apps/secure-chat
// cwd). Idempotent: drizzle's journal skips applied migrations and the custom SQL is itself idempotent.
import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { normalizeConnString } from "./db-url.js";

export default async function setup() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("TEST_DATABASE_URL is required for integration tests");
  const sql = postgres(normalizeConnString(raw), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: "../api/drizzle" });
  } finally {
    await sql.end();
  }
}
