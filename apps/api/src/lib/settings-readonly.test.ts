import { afterEach, describe, expect, it, vi } from "vitest";

// settings-readonly.ts builds its email allowlist Set at import time from env.SETTINGS_READONLY_EMAILS.
// Each case clears the var, resets the module registry, assigns the test env, and re-imports.
const ORIGINAL_ENV = { ...process.env };

async function loadIsSettingsReadonly(value?: string) {
  vi.resetModules();
  delete process.env.SETTINGS_READONLY_EMAILS;
  if (value !== undefined) process.env.SETTINGS_READONLY_EMAILS = value;
  return (await import("./settings-readonly.js")).isSettingsReadonly;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("isSettingsReadonly", () => {
  it("returns false for everyone when unconfigured", async () => {
    const f = await loadIsSettingsReadonly();
    expect(f({ email: "someone@example.com" })).toBe(false);
    expect(f({ email: null })).toBe(false);
    expect(f({})).toBe(false);
  });

  it("matches a configured email case-insensitively (both directions)", async () => {
    let f = await loadIsSettingsReadonly("Demo-Admin@Agora-OSS.org");
    expect(f({ email: "demo-admin@agora-oss.org" })).toBe(true);
    f = await loadIsSettingsReadonly("demo-admin@agora-oss.org");
    expect(f({ email: "Demo-Admin@Agora-OSS.org" })).toBe(true);
  });

  it("matches one of a comma-separated, whitespace-padded list", async () => {
    const f = await loadIsSettingsReadonly(" a@x.io , demo-admin@agora-oss.org ,b@y.io ");
    expect(f({ email: "demo-admin@agora-oss.org" })).toBe(true);
    expect(f({ email: "a@x.io" })).toBe(true);
  });

  it("returns false for a non-matching, null, undefined, or empty email", async () => {
    const f = await loadIsSettingsReadonly("demo-admin@agora-oss.org");
    expect(f({ email: "other@example.com" })).toBe(false);
    expect(f({ email: null })).toBe(false);
    expect(f({ email: undefined })).toBe(false);
    expect(f({ email: "" })).toBe(false);
  });

  it("treats an empty-string env value as unset", async () => {
    const f = await loadIsSettingsReadonly("");
    expect(f({ email: "" })).toBe(false);
    expect(f({ email: "anyone@example.com" })).toBe(false);
  });
});
