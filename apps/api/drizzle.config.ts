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
  migrations: { table: "__drizzle_migrations", schema: "public" },
  strict: true,
  verbose: true,
});
