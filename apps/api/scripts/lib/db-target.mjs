// Pure helpers shared by the destructive DB scripts (drop.mjs / genesis.mjs) to classify a target and
// decide how strong a confirmation to require. A "local" target (the selfhost `db` container, or a
// localhost Postgres) is safe to --force; anything else is treated as a cloud/shared DB that must not
// be wiped without an explicit, louder opt-in. Fail-safe: an unknown/unparseable host is NOT local.

/** Hostname of a Postgres connection URL, or null if it can't be parsed. */
export function dbTargetHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(["db", "localhost", "127.0.0.1"]);

/** True when the target is the local selfhost DB (safe to --force), false otherwise (require louder confirm). */
export function isLocalTarget({ agoraEnv, databaseUrl } = {}) {
  if (agoraEnv === "selfhost") return true;
  const host = dbTargetHost(databaseUrl);
  return host !== null && LOCAL_HOSTS.has(host);
}
