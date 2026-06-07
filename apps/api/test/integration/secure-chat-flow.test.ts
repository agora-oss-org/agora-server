// Secure chat — the full delivery-service round-trip with a real client crypto (the mock):
// register → claim → create group + targeted Welcome → relay ciphertext → second device decrypts.
// The load-bearing assertions: the stored ciphertext never contains the plaintext, and a Welcome
// reaches ONLY its target device.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { secureMessages } from "../../src/db/schema/index.js";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { provisionDevice, claimKeyPackage, b64e, b64d, enc, dec } from "./secure-helpers.js";

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

describe("secure-chat end-to-end flow (mock crypto)", () => {
  it("delivers an encrypted DM that the recipient decrypts, with the server blind to content", async () => {
    const aliceDev = await provisionDevice(projectId, alice, "alice-web");
    const bobDev = await provisionDevice(projectId, bob, "bob-web");
    const carolDev = await provisionDevice(projectId, carol, "carol-web");

    // Alice claims Bob's key package and builds the group locally.
    const claim = await claimKeyPackage(projectId, alice, bobDev.rowId);
    expect(claim.status).toBe(200);
    const { group, welcomes } = await aliceDev.crypto.createGroup({
      initialMembers: [{ deviceId: bobDev.deviceId, keyPackage: b64d(claim.keyPackage!) }],
    });

    // Create the conversation, queuing the Welcome targeted at Bob's device ROW id.
    const created = await api("POST", `${base(projectId)}/secure-chat/conversations`, {
      token: alice.token,
      body: {
        type: "dm",
        mlsGroupId: b64e(group.mlsGroupId),
        memberUserIds: [bob.id],
        welcomes: [{ targetDeviceId: bobDev.rowId, payload: b64e(welcomes[0]!.payload), epoch: "0" }],
      },
    });
    expect(created.status).toBe(201);
    const conversationId = created.body.id;

    // Bob pulls his handshake inbox → gets the Welcome; Carol's inbox sees nothing.
    const bobHs = await api("GET", `${base(projectId)}/secure-chat/devices/${bobDev.rowId}/handshakes`, { token: bob.token });
    expect(bobHs.status).toBe(200);
    expect(bobHs.body.handshakes.length).toBe(1);
    expect(bobHs.body.handshakes[0].kind).toBe("welcome");
    expect(bobHs.body.handshakes[0].targetDeviceId).toBe(bobDev.rowId);

    const carolHs = await api("GET", `${base(projectId)}/secure-chat/devices/${carolDev.rowId}/handshakes`, { token: carol.token });
    expect(carolHs.body.handshakes.length).toBe(0); // Welcome targeting isolation

    const bobGroup = await bobDev.crypto.processWelcome(b64d(bobHs.body.handshakes[0].payload));

    // Alice encrypts + sends; Bob fetches + decrypts.
    const PLAINTEXT = "meet me at the safehouse, 0300";
    const { ciphertext, epoch } = await aliceDev.crypto.encryptMessage(group, enc.encode(PLAINTEXT));
    const sent = await api("POST", `${base(projectId)}/secure-chat/conversations/${conversationId}/messages`, {
      token: alice.token,
      body: { ciphertext: b64e(ciphertext), epoch: epoch.toString(), senderDeviceId: aliceDev.rowId },
    });
    expect(sent.status).toBe(201);

    const fetched = await api("GET", `${base(projectId)}/secure-chat/conversations/${conversationId}/messages`, { token: bob.token });
    expect(fetched.body.messages.length).toBe(1);
    const got = await bobDev.crypto.decryptMessage(bobGroup, b64d(fetched.body.messages[0].ciphertext));
    expect(dec.decode(got.plaintext)).toBe(PLAINTEXT);
    expect(got.senderDeviceId).toBe("alice-web");

    // SERVER-BLINDNESS: the bytes at rest must not contain the plaintext.
    const [stored] = await db.select().from(secureMessages).where(eq(secureMessages.id, sent.body.id));
    const haystack = Buffer.from(stored!.ciphertext);
    expect(haystack.includes(Buffer.from(PLAINTEXT, "utf8"))).toBe(false);
  });

  it("refuses a message claiming a device the sender does not own", async () => {
    const aliceDev = await provisionDevice(projectId, alice, "alice-web-2");
    const bobDev = await provisionDevice(projectId, bob, "bob-web-2");
    const claim = await claimKeyPackage(projectId, alice, bobDev.rowId);
    const { group, welcomes } = await aliceDev.crypto.createGroup({ initialMembers: [{ deviceId: bobDev.deviceId, keyPackage: b64d(claim.keyPackage!) }] });
    const created = await api("POST", `${base(projectId)}/secure-chat/conversations`, {
      token: alice.token,
      body: { type: "dm", mlsGroupId: b64e(group.mlsGroupId), memberUserIds: [bob.id], welcomes: [{ targetDeviceId: bobDev.rowId, payload: b64e(welcomes[0]!.payload), epoch: "0" }] },
    });
    // Alice tries to send claiming BOB's device id.
    const { ciphertext, epoch } = await aliceDev.crypto.encryptMessage(group, enc.encode("nope"));
    const res = await api("POST", `${base(projectId)}/secure-chat/conversations/${created.body.id}/messages`, {
      token: alice.token,
      body: { ciphertext: b64e(ciphertext), epoch: epoch.toString(), senderDeviceId: bobDev.rowId },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("secure-chat/device-mismatch");
  });

  it("rejects a non-member reading or posting to a conversation", async () => {
    const aliceDev = await provisionDevice(projectId, alice, "alice-web-3");
    const created = await api("POST", `${base(projectId)}/secure-chat/conversations`, {
      token: alice.token,
      body: { type: "group", mlsGroupId: b64e(new Uint8Array([9, 9, 9, 1])), memberUserIds: [] },
    });
    const read = await api("GET", `${base(projectId)}/secure-chat/conversations/${created.body.id}/messages`, { token: carol.token });
    expect(read.status).toBe(403);
    expect(read.body.code).toBe("secure-chat/not-a-member");
  });

  it("rejects a channel without a space and a non-channel with a space", async () => {
    const noSpace = await api("POST", `${base(projectId)}/secure-chat/conversations`, {
      token: alice.token,
      body: { type: "channel", mlsGroupId: b64e(new Uint8Array([1, 2, 3, 4])) },
    });
    expect(noSpace.status).toBe(400);
    expect(noSpace.body.code).toBe("secure-chat/channel-needs-space");
  });
});
