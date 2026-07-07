// Public surface of @agora/core/db. Application code uses getDb() (request-scoped,
// ALS-backed); the module-singleton `db` export is GONE — importing it is a type error,
// which is the mechanically-enforced ban (export removal is stronger than an ESLint rule).
//
// EMBEDDER CONTRACT: getDb / runWithDb / Db / getDbForDsn / endAllPools / setDbResolver /
// resolveDbFor are a stability surface external deployments build against — renaming or
// removing one is a breaking change (CHANGELOG required). Semantics that must hold: resolver
// errors propagate (never a silent shared-db fallback); registry pools are always
// prepare:false (transaction-mode poolers); never hoist getDb() to module scope (it freezes
// the handle and defeats the seam).
import * as schema from "./schema/index.js";

export { schema };
export { getDb, runWithDb, type Db } from "./context.js";
export { getDbForDsn, endAllPools } from "./registry.js";
export { setDbResolver, resetDbResolver, resolveDbFor, type DbResolver } from "./resolver.js";
