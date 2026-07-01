// Pure helpers shared by the destructive DB scripts (drop.mjs / genesis.mjs) to classify a target and
// decide whether a drop needs an explicit typed-ref confirmation.
//
// The per-mode env templates are dual-mode (local Postgres by default, cloud Supabase as an in-file
// switch), so the AGORA_ENV marker alone can't say whether DATABASE_URL points at a throwaway local DB
// or a real one — the HOST is the authoritative signal. A target is "protected" (must be confirmed) when:
//   • the DATABASE_URL host is NOT local (cloud/remote), OR
//   • AGORA_ENV=prod — a production deployment's DB is precious even when it's a local `db`/localhost.
// Only a LOCAL host on a non-prod deployment is a safe throwaway that `--force` may drop unattended.
// Fail-safe: an unknown/unparseable host is treated as non-local → protected.

/** Hostname of a Postgres connection URL, or null if it can't be parsed. */
export function dbTargetHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(["db", "localhost", "127.0.0.1"]);

/** True when DATABASE_URL points at a local host (the selfhost `db` container or a localhost Postgres). */
export function isLocalHost(databaseUrl) {
  const host = dbTargetHost(databaseUrl);
  return host !== null && LOCAL_HOSTS.has(host);
}

/**
 * True when a destructive drop against this target MUST be confirmed (typed project ref) rather than
 * skipped with `--force`: any cloud/remote host, or any `AGORA_ENV=prod` deployment (even a local db).
 * False only for a local throwaway that isn't marked prod — the case `--force` may drop unattended.
 */
export function isProtectedTarget({ agoraEnv, databaseUrl } = {}) {
  if (agoraEnv === "prod") return true;
  return !isLocalHost(databaseUrl);
}
