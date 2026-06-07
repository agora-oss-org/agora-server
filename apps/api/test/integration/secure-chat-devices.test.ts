// Secure chat — device registration + one-time KeyPackage lifecycle (publish / count / claim /
// exhaustion). The server stores public key material + opaque KeyPackages and never more.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { provisionDevice, claimKeyPackage } from "./secure-helpers.js";

let projectId: string;
let alice: { id: string; token: string };
let bob: { id: string; token: string };

beforeAll(async () => {
  projectId = await createProject();
  alice = await createUser(projectId);
  bob = await createUser(projectId);
});
afterAll(async () => {
  if (projectId) await deleteProject(projectId);
});

describe("secure-chat devices + key packages", () => {
  it("registers a device and lists only public fields for a user", async () => {
    const dev = await provisionDevice(projectId, alice, "alice-web", 3);
    const list = await api("GET", `${base(projectId)}/secure-chat/devices?userId=${alice.id}`, { token: bob.token });
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(1);
    const d = list.body.data[0];
    expect(d.id).toBe(dev.rowId);
    expect(d.deviceId).toBe("alice-web");
    expect(typeof d.signaturePublicKey).toBe("string"); // base64 public key
    // No private material is even stored; the model must not carry anything secret-shaped.
    expect(d).not.toHaveProperty("privateState");
  });

  it("reports the available key-package count and decrements it on claim", async () => {
    const bd = await provisionDevice(projectId, bob, "bob-web", 2);
    const c0 = await api("GET", `${base(projectId)}/secure-chat/devices/${bd.rowId}/key-packages/count`, { token: bob.token });
    expect(c0.body.available).toBe(2);

    // Alice claims one of Bob's packages.
    const claim1 = await claimKeyPackage(projectId, alice, bd.rowId);
    expect(claim1.status).toBe(200);
    expect(typeof claim1.keyPackage).toBe("string");

    const c1 = await api("GET", `${base(projectId)}/secure-chat/devices/${bd.rowId}/key-packages/count`, { token: bob.token });
    expect(c1.body.available).toBe(1);
  });

  it("409s with key-packages-exhausted once the last package is consumed", async () => {
    const cd = await provisionDevice(projectId, bob, "bob-phone", 1);
    const ok = await claimKeyPackage(projectId, alice, cd.rowId);
    expect(ok.status).toBe(200);
    const empty = await claimKeyPackage(projectId, alice, cd.rowId);
    expect(empty.status).toBe(409);
    expect(empty.body.code).toBe("secure-chat/key-packages-exhausted");
  });

  it("lets a user revoke their own device, and revoked devices drop out of the public list", async () => {
    const dd = await provisionDevice(projectId, alice, "alice-old", 1);
    const del = await api("DELETE", `${base(projectId)}/secure-chat/devices/${dd.rowId}`, { token: alice.token });
    expect(del.status).toBe(200);
    const list = await api("GET", `${base(projectId)}/secure-chat/devices?userId=${alice.id}`, { token: alice.token });
    expect(list.body.data.find((d: any) => d.id === dd.rowId)).toBeUndefined();
  });

  it("won't let a user publish key packages to someone else's device", async () => {
    const bd = await provisionDevice(projectId, bob, "bob-tablet", 1);
    const res = await api("POST", `${base(projectId)}/secure-chat/devices/${bd.rowId}/key-packages`, {
      token: alice.token, // Alice is not the owner
      body: { keyPackages: [{ keyPackageRef: "x", keyPackage: Buffer.from("kp").toString("base64"), ciphersuite: 1 }] },
    });
    expect(res.status).toBe(404); // getMyDevice scopes to the caller → not found
  });
});
