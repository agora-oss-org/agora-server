// postgres.js runs decodeURIComponent on connection-string parts, so a password with a
// literal `%` (or other reserved chars) throws "URI malformed". Test connection strings are
// often pasted raw, so we percent-encode the userinfo here. Only used for the test DB — the
// app's real DATABASE_URL is assumed already valid (re-encoding it could double-encode).
export function normalizeConnString(raw: string): string {
  const m = raw.match(/^(postgres(?:ql)?:\/\/)(.*)@([^@]*)$/s); // split at the LAST @
  if (!m) return raw;
  const [, scheme, userinfo, rest] = m;
  const i = userinfo!.indexOf(":");
  const user = i === -1 ? userinfo! : userinfo!.slice(0, i);
  const pass = i === -1 ? undefined : userinfo!.slice(i + 1);
  return scheme! + encodeURIComponent(user) + (pass !== undefined ? `:${encodeURIComponent(pass)}` : "") + "@" + rest;
}
