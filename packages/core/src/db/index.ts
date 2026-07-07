// Public surface of @agora/core/db. Application code uses getDb() (request-scoped,
// ALS-backed); the module-singleton `db` export is GONE — importing it is a type error,
// which is the mechanically-enforced ban (spec §4.2, adapted: export removal > ESLint).
import * as schema from "./schema/index.js";

export { schema };
export { getDb, runWithDb, type Db } from "./context.js";
export { getDbForDsn, endAllPools } from "./registry.js";
export { setDbResolver, resetDbResolver, resolveDbFor, type DbResolver } from "./resolver.js";
