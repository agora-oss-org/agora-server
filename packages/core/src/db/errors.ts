// Classifies a thrown DB error as a *connection/reachability* failure — the database could not be
// reached (host down, connection refused, DNS failure, connect timeout, or the socket dropped) —
// as opposed to a query/constraint error (a code bug or bad data), which must stay a 500 so real
// defects aren't masked. Callers map a true here to a retryable 503 (project/db-unavailable),
// mirroring the resolver's own unavailable path. Core owns "what is a connection failure" because
// the answer is postgres.js-version-specific; the HTTP mapping lives in the app layer.
//
// Two code families, both confirmed against the pinned postgres.js (^3.4.9):
//   - postgres.js connection-lifecycle codes minted by `Errors.connection` (src/errors.js).
//   - raw Node socket/DNS errors, which the driver passes through verbatim with their errno `code`
//     (src/connection.js `socket.on('error', ...)`).
// Postgres SQLSTATE query codes (e.g. 23503 FK, 42601 syntax) never collide with this set, so
// query/constraint errors are deliberately NOT matched.
const CONNECTION_ERROR_CODES = new Set<string>([
  // postgres.js connection-lifecycle codes
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  // Node socket / DNS codes postgres.js surfaces for an unreachable host
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ECONNRESET",
]);

/** True when `err` is a failure to REACH the database (not a query/constraint error). */
export function isDbConnectionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && CONNECTION_ERROR_CODES.has(code);
}
