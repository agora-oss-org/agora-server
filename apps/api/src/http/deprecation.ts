// RFC 8594 deprecation signaling for legacy sort aliases (`new`/`old`). We emit only the
// `Deprecation` header — no `Sunset`, because there is no scheduled removal ("v8") date. The
// aliases keep working; this is the warning, not the removal.
import type { Context } from "hono";

export function markDeprecated(c: Context): void {
  c.header("Deprecation", "true");
}

/** The entity feed's only deprecated sort alias is `new` (→ canonical `createdAt`). */
export function isDeprecatedEntitySort(rawSortBy: string | undefined): boolean {
  return rawSortBy === "new";
}
