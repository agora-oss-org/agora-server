// Integration: /crypto/sign-testing-jwt/v2 + the verify-external-user pairing it feeds.
// The signed RS256 JWT must satisfy verify-external-user (issuer=projectId, aud="replyke.com",
// sub=userData.id), so a round-trip is the real test. RS256 keypair generated per-run with jose.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";
import { eq } from "drizzle-orm";
import { api, createProject, deleteProject, base } from "./helpers.js";
import { db } from "../../src/db/index.js";
import { projects } from "../../src/db/schema/index.js";

describe("crypto sign-testing-jwt + verify-external-user (integration)", () => {
  let projectId: string;
  let B: string;
  let privateKeyPem: string;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
    privateKeyPem = await exportPKCS8(privateKey);
    const publicKeyPem = await exportSPKI(publicKey);
    projectId = await createProject();
    await db.update(projects).set({ externalAuthPublicKey: publicKeyPem }).where(eq(projects.id, projectId));
    B = base(projectId);
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("signs a JWT that verify-external-user accepts (round-trip mints a session)", async () => {
    const signed = await api("POST", `${B}/crypto/sign-testing-jwt/v2`, {
      body: { projectId, privateKey: privateKeyPem, userData: { id: "ext-1", name: "Ext User", username: "extu" } },
    });
    expect(signed.status).toBe(200);
    expect(typeof signed.body).toBe("string"); // bare JWT string
    expect(signed.body.split(".")).toHaveLength(3);

    const verified = await api("POST", `${B}/auth/verify-external-user`, { body: { userJwt: signed.body } });
    expect(verified.status).toBe(200);
    expect(verified.body.accessToken).toBeTruthy();
    expect(verified.body.refreshToken).toBeTruthy();
    expect(verified.body.user).toMatchObject({ foreignId: "ext-1", name: "Ext User" });
  });

  it("verify-external-user also accepts the legacy `token` field", async () => {
    const signed = await api("POST", `${B}/crypto/sign-testing-jwt/v2`, {
      body: { projectId, privateKey: privateKeyPem, userData: { id: "ext-2" } },
    });
    const verified = await api("POST", `${B}/auth/verify-external-user`, { body: { token: signed.body } });
    expect(verified.status).toBe(200);
    expect(verified.body.user.foreignId).toBe("ext-2");
  });

  it("rejects an invalid private key with 400 crypto/sign-failed", async () => {
    const res = await api("POST", `${B}/crypto/sign-testing-jwt/v2`, {
      body: { projectId, privateKey: "not-a-real-key", userData: { id: "x" } },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("crypto/sign-failed");
  });

  it("requires privateKey + userData.id", async () => {
    const noKey = await api("POST", `${B}/crypto/sign-testing-jwt/v2`, { body: { userData: { id: "x" } } });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe("crypto/invalid-body");

    const noId = await api("POST", `${B}/crypto/sign-testing-jwt/v2`, { body: { privateKey: privateKeyPem, userData: {} } });
    expect(noId.status).toBe(400);
    expect(noId.body.code).toBe("crypto/invalid-body");
  });

  it("verify-external-user requires a token (userJwt or legacy token)", async () => {
    const res = await api("POST", `${B}/auth/verify-external-user`, { body: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("auth/invalid-body");
  });
});
