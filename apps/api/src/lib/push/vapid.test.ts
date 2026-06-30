import { describe, it, expect } from "vitest";
import { resolveVapid } from "./vapid.js";

describe("resolveVapid", () => {
  const env = { publicKey: "ENVpub", privateKey: "ENVpriv", subject: "mailto:ops@x" };
  it("prefers a complete per-project keypair", () => {
    expect(resolveVapid({ publicKey: "Ppub", privateKey: "Ppriv", subject: "mailto:p@x" }, env))
      .toEqual({ publicKey: "Ppub", privateKey: "Ppriv", subject: "mailto:p@x" });
  });
  it("falls back to env when per-project is null/incomplete", () => {
    expect(resolveVapid(null, env)).toEqual(env);
    expect(resolveVapid({ publicKey: "Ppub" }, env)).toEqual(env); // missing private → fall back
  });
  it("returns null when neither is complete", () => {
    expect(resolveVapid(null, { publicKey: "only" })).toBeNull();
  });
  it("defaults the subject when absent", () => {
    expect(resolveVapid({ publicKey: "a", privateKey: "b" }, { publicKey: "a", privateKey: "b" })!.subject)
      .toBe("mailto:push@agora");
  });
});
