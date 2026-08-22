// Pure planning half of the native→GoTrue auth migration (unit-tested; the CLI does the I/O).
// GoTrue's admin create-user imports pre-hashed passwords for bcrypt and argon2 PHC strings —
// native hashes are @node-rs/argon2 argon2id, so they carry over and users keep their passwords.
// Anything else (corrupt/legacy) degrades to reset-required: account created WITHOUT a password;
// the user signs in again via the password-reset flow.
const IMPORTABLE_HASH = /^\$(2[aby]|argon2id|argon2i)\$/;

export function planImport(row) {
  const importable = typeof row.password_hash === "string" && IMPORTABLE_HASH.test(row.password_hash);
  return {
    credentialId: row.id,
    email: row.email,
    action: importable ? "hash-import" : "reset-required",
    ...(importable ? { passwordHash: row.password_hash } : {}),
    emailConfirm: Boolean(row.email_confirmed_at),
    banned: Boolean(row.disabled_at),
  };
}

export function summarize(plans) {
  return {
    total: plans.length,
    hashImport: plans.filter((p) => p.action === "hash-import").length,
    resetRequired: plans.filter((p) => p.action === "reset-required").length,
    banned: plans.filter((p) => p.banned).length,
  };
}
