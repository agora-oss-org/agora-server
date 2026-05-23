// Runs once before the integration suite: apply Drizzle migrations to TEST_DATABASE_URL.
// Idempotent — drizzle's journal skips already-applied migrations, and the custom SQL
// migrations are themselves idempotent (create or replace / if not exists).
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
    await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  } finally {
    await sql.end();
  }
}
