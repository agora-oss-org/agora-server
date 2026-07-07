import { ilike, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

type Field = "username" | "name";

/** Pure normalization of the SDK's (query, searchFields) params. `like` is null when no filtering. */
export function normalizeUserSearch(query: string | undefined, searchFields: string | undefined) {
  const q = (query ?? "").trim();
  const fields: Field[] = searchFields === "username" || searchFields === "name" ? [searchFields] : ["username", "name"];
  return { like: q ? `%${q}%` : null, fields };
}

/** Build the ilike OR-filter over the given username/name columns, or undefined when no query. */
export function userSearchCondition(
  like: string | null,
  fields: Field[],
  cols: { username: AnyPgColumn; name: AnyPgColumn },
): SQL | undefined {
  if (!like) return undefined;
  const parts = fields.map((f) => ilike(cols[f], like));
  return parts.length === 1 ? parts[0] : or(...parts);
}
