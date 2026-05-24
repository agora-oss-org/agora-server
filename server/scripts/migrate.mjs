// Apply Drizzle migrations using only runtime deps (drizzle-orm + postgres) — no drizzle-kit.
// This is what the container runs (drizzle-kit is a devDependency, absent from the prod image).
// Idempotent: the journal skips already-applied migrations and the custom SQL is itself idempotent.
//   node scripts/migrate.mjs            # uses DATABASE_URL
import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice() {} });
try {
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  console.log("✓ migrations applied");
} finally {
  await sql.end();
}
process.exit(0);
