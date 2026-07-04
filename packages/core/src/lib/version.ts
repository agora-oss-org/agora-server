// The running code's version, read from @agora/core's own package.json at runtime.
//
// The monorepo bumps every package (root / contract / core / api / secure-chat / admin) in lockstep
// via scripts/release.sh, so @agora/core's version IS the release version of the whole stack — the same
// value for the api, secure-chat, and the shared logger. Reading it here (instead of a SERVICE_VERSION
// env var, which nothing sets, or a YAML placeholder that goes stale) means logs + traces always report
// the ACTUAL executing version, with nothing to keep in sync. Resolves under both tsx (src) and dist:
// `../../package.json` is packages/core/package.json from src/lib and from dist/lib alike.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const serviceVersion: string = (require("../../package.json") as { version: string }).version;
