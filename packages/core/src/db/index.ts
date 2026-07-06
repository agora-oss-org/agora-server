// Public surface of @agora/core/db. Application code uses getDb() (request-scoped);
// the legacy `db` export remains TEMPORARILY for the incremental rename and is
// removed at the end of Phase 0 (typecheck then enforces the ban).
import * as schema from "./schema/index.js";

export { schema };
export { getDb, runWithDb, type Db } from "./context.js";
// export { getDbForDsn, endAllPools } from "./registry.js"; // added in Task 2 — leave this line commented until then
export { sharedDb as db } from "./shared.js"; // LEGACY — removed in Task 8
