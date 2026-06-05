// Barrel: re-exports every table/enum so the Drizzle client gets the full schema.
export * from "./_shared.js";
export * from "./projects.js";
export * from "./content.js";
export * from "./spaces.js";
export * from "./chat.js";
export * from "./misc.js";
export * from "./auth.js";
export * from "./steward.js";
// re-export inferred row types are available via table.$inferSelect at call sites
