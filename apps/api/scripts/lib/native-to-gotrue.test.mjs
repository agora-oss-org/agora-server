import { describe, it, expect } from "vitest";
import { planImport, summarize } from "./native-to-gotrue.mjs";

const base = {
  id: "11111111-2222-3333-4444-555555555555",
  email: "user@example.org",
  password_hash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA",
  email_confirmed_at: new Date("2026-01-01T00:00:00Z"),
  disabled_at: null,
};

describe("planImport", () => {
  it("imports an argon2id hash for a confirmed active credential", () => {
    expect(planImport(base)).toEqual({
      credentialId: base.id,
      email: "user@example.org",
      action: "hash-import",
      passwordHash: base.password_hash,
      emailConfirm: true,
      banned: false,
    });
  });

  it("also accepts bcrypt-format hashes", () => {
    const p = planImport({ ...base, password_hash: "$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345" });
    expect(p.action).toBe("hash-import");
  });

  it("falls back to reset-required on an unrecognized hash format", () => {
    const p = planImport({ ...base, password_hash: "plain-or-unknown" });
    expect(p.action).toBe("reset-required");
    expect(p.passwordHash).toBeUndefined();
  });

  it("carries unconfirmed and disabled states", () => {
    const p = planImport({ ...base, email_confirmed_at: null, disabled_at: new Date() });
    expect(p.emailConfirm).toBe(false);
    expect(p.banned).toBe(true);
  });
});

describe("summarize", () => {
  it("counts actions and bans", () => {
    const plans = [
      planImport(base),
      planImport({ ...base, password_hash: "nope" }),
      planImport({ ...base, disabled_at: new Date() }),
    ];
    expect(summarize(plans)).toEqual({ total: 3, hashImport: 2, resetRequired: 1, banned: 1 });
  });
});
