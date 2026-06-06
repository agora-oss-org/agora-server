import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL! },
  // Don't let drizzle-kit try to manage the PostGIS extension's objects.
  extensionsFilters: ["postgis"],
  schemaFilter: ["public"],
  // Journal lives in the `drizzle` schema (drizzle-orm's default) — the runtime migrator
  // (scripts/migrate.mjs, `pnpm db:migrate:run`) writes it there, so drizzle-kit MUST read the same
  // one. With `public` here, drizzle-kit saw an empty journal and tried to re-apply from 0000.
  migrations: { table: "__drizzle_migrations", schema: "drizzle" },
  strict: true,
  verbose: true,
});
