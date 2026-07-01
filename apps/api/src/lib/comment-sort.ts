// Comment list sort resolver (SDK CommentsSortByOptions: createdAt | top | controversial | new | old).
// Split into a pure decision (resolveCommentSort) and the Drizzle ORDER BY builder (commentOrderBy) so
// the branching is unit-testable without a DB. `controversial` reuses the entity formula
// (min(up,down) then sum) for one consistent definition across the codebase (see lib/ranking.ts).
import { asc, desc, sql, type SQL } from "drizzle-orm";
import { comments } from "../db/schema/index.js";

export type CommentSort = {
  column: "createdAt" | "top" | "controversial";
  dir: "asc" | "desc";
  deprecated: boolean;
};

export function resolveCommentSort(sortBy: string | undefined, sortDir: string | undefined): CommentSort {
  const dir: "asc" | "desc" = sortDir === "asc" ? "asc" : "desc";
  switch (sortBy) {
    case "top": return { column: "top", dir: "desc", deprecated: false };
    case "controversial": return { column: "controversial", dir: "desc", deprecated: false };
    case "new": return { column: "createdAt", dir: "desc", deprecated: true };
    case "old": return { column: "createdAt", dir: "asc", deprecated: true };
    case "createdAt": return { column: "createdAt", dir, deprecated: false };
    default: return { column: "createdAt", dir: "desc", deprecated: false }; // unknown/absent → canonical default
  }
}

// Reaction-count accessor. `k` is a code-literal reaction key (never user input); the `sql` tag binds
// it as a parameter. Typed to the two keys we rank on so a stray call can't compile.
const rc = (k: "upvote" | "downvote"): SQL => sql`coalesce((${comments.reactionCounts}->>${k})::int, 0)`;

export function commentOrderBy(sort: CommentSort): SQL[] {
  const dirFn = sort.dir === "asc" ? asc : desc;
  switch (sort.column) {
    case "top":
      return [desc(rc("upvote")), desc(comments.createdAt)];
    case "controversial":
      return [desc(sql`least(${rc("upvote")}, ${rc("downvote")})`), desc(sql`${rc("upvote")} + ${rc("downvote")}`), desc(comments.id)];
    case "createdAt":
    default:
      return [dirFn(comments.createdAt), desc(comments.id)];
  }
}
