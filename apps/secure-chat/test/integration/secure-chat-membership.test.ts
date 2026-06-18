// Secure chat — membership commits + the DS's optimistic epoch linearization.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { randomUUID } from "node:crypto";
import { provisionDevice, claimKeyPackage, b64e, b64d } from "./secure-helpers.js";

let projectId: string;
let alice: { id: string; token: string };
let bob: { id: string; token: string };
let carol: { id: string; token: string };

beforeAll(async () => {
  projectId = await createProject();
  alice = await createUser(projectId);
  bob = await createUser(projectId);
  carol = await createUser(projectId);
});
afterAll(async () => {
  if (projectId) await deleteProject(projectId);
});

async function createGroupConversation() {
  const aliceDev = await provisionDevice(projectId, alice, "alice-web");
  // Unique group id per conversation — the deterministic mock would otherwise collide on the
  // (projectId, mlsGroupId) unique index when two empty groups are created in the same project.
  const mlsGroupId = new Uint8Array(Buffer.from(randomUUID().replace(/-/g, ""), "hex"));
  const { group } = await aliceDev.crypto.createGroup({ mlsGroupId, initialMembers: [] });
  const created = await api("POST", `${base(projectId)}/secure-chat/conversations`, {
    token: alice.token,
    body: { type: "group", mlsGroupId: b64e(group.mlsGroupId), memberUserIds: [] },
  });
  return { aliceDev, group, conversationId: created.body.id as string };
}

describe("secure-chat membership + epoch ordering", () => {
  it("adds a member, relaying a broadcast Commit + a targeted Welcome, and advances the epoch", async () => {
    const { aliceDev, group, conversationId } = await createGroupConversation();
    const bobDev = await provisionDevice(projectId, bob, "bob-web");
    const claim = await claimKeyPackage(projectId, alice, bobDev.rowId);
    const commit = await aliceDev.crypto.addMember(group, { deviceId: bobDev.deviceId, keyPackage: b64d(claim.keyPackage!) });

    const add = await api("POST", `${base(projectId)}/secure-chat/conversations/${conversationId}/members`, {
      token: alice.token,
      body: {
        userId: bob.id,
        commit: { payload: b64e(commit.commit), epoch: commit.epoch.toString() }, // epoch "1"
        welcomes: [{ targetDeviceId: bobDev.rowId, payload: b64e(commit.welcomes[0]!.payload), epoch: commit.epoch.toString() }],
      },
    });
    expect(add.status).toBe(201);
    expect(add.body.userId).toBe(bob.id);

    // Conversation epoch is now 1.
    const convo = await api("GET", `${base(projectId)}/secure-chat/conversations/${conversationId}`, { token: alice.token });
    expect(convo.body.currentEpoch).toBe("1");

    // Bob (now a member) sees the targeted Welcome AND the broadcast Commit in his inbox.
    const hs = await api("GET", `${base(projectId)}/secure-chat/devices/${bobDev.rowId}/handshakes`, { token: bob.token });
    const kinds = hs.body.handshakes.map((h: any) => h.kind).sort();
    expect(kinds).toContain("welcome");
    expect(kinds).toContain("commit");
  });

  it("rejects a stale commit with epoch-conflict (optimistic ordering)", async () => {
    const { aliceDev, group, conversationId } = await createGroupConversation();
    const bobDev = await provisionDevice(projectId, bob, "bob-web-2");
    const carolDev = await provisionDevice(projectId, carol, "carol-web-2");
    const claimB = await claimKeyPackage(projectId, alice, bobDev.rowId);
    const claimC = await claimKeyPackage(projectId, alice, carolDev.rowId);
    const commitB = await aliceDev.crypto.addMember(group, { deviceId: bobDev.deviceId, keyPackage: b64d(claimB.keyPackage!) });

    // First add at epoch 1 → ok.
    const add1 = await api("POST", `${base(projectId)}/secure-chat/conversations/${conversationId}/members`, {
      token: alice.token,
      body: { userId: bob.id, commit: { payload: b64e(commitB.commit), epoch: commitB.epoch.toString() }, welcomes: [{ targetDeviceId: bobDev.rowId, payload: b64e(commitB.welcomes[0]!.payload), epoch: commitB.epoch.toString() }] },
    });
    expect(add1.status).toBe(201);

    // Second add ALSO claiming epoch 1 (stale — the DS is already at 1) → 409.
    const add2 = await api("POST", `${base(projectId)}/secure-chat/conversations/${conversationId}/members`, {
      token: alice.token,
      body: { userId: carol.id, commit: { payload: b64e(new Uint8Array([1, 1])), epoch: "1" }, welcomes: [{ targetDeviceId: carolDev.rowId, payload: b64e(claimC.keyPackage ? b64d(claimC.keyPackage) : new Uint8Array([2])), epoch: "1" }] },
    });
    expect(add2.status).toBe(409);
    expect(add2.body.code).toBe("secure-chat/epoch-conflict");
  });

  it("lets an admin remove a member (deactivates + broadcasts the Commit)", async () => {
    const { aliceDev, group, conversationId } = await createGroupConversation();
    const bobDev = await provisionDevice(projectId, bob, "bob-web-3");
    const claim = await claimKeyPackage(projectId, alice, bobDev.rowId);
    const addCommit = await aliceDev.crypto.addMember(group, { deviceId: bobDev.deviceId, keyPackage: b64d(claim.keyPackage!) });
    await api("POST", `${base(projectId)}/secure-chat/conversations/${conversationId}/members`, {
      token: alice.token,
      body: { userId: bob.id, commit: { payload: b64e(addCommit.commit), epoch: addCommit.epoch.toString() }, welcomes: [{ targetDeviceId: bobDev.rowId, payload: b64e(addCommit.welcomes[0]!.payload), epoch: addCommit.epoch.toString() }] },
    });

    const rmCommit = await aliceDev.crypto.removeMember(group, bobDev.deviceId); // epoch 2
    const rm = await api("DELETE", `${base(projectId)}/secure-chat/conversations/${conversationId}/members/${bob.id}`, {
      token: alice.token,
      body: { commit: { payload: b64e(rmCommit.commit), epoch: rmCommit.epoch.toString() } },
    });
    expect(rm.status).toBe(200);
    expect(rm.body.epoch).toBe("2");

    // Bob is no longer an active member.
    const bobView = await api("GET", `${base(projectId)}/secure-chat/conversations/${conversationId}`, { token: bob.token });
    expect(bobView.status).toBe(403);
  });
});
