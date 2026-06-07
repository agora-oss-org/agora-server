// A deterministic, dependency-free MOCK implementation of `SecureChatCrypto`.
//
// It is NOT cryptographically secure — it is the test double that lets the server's MLS
// Delivery Service be exercised end-to-end WITHOUT a real MLS library, and a placeholder the
// web client can wire against before the concrete core lands. Two properties make it useful:
//
//  1. **Reversible + plaintext-hiding.** `encryptMessage` XORs the plaintext with a non-zero
//     keystream derived from a per-group secret, so the wrapped bytes never contain the
//     plaintext — the server-blindness assertion in the integration tests is meaningful.
//  2. **Cross-instance.** The group secret travels inside the Welcome, so a *different* mock
//     instance (a second "device") can `processWelcome` and then decrypt the first one's
//     messages — modelling real two-party delivery.
import type {
  SecureChatCrypto,
  DeviceIdentity,
  KeyPackageBundle,
  GroupHandle,
  CommitResult,
  PassphraseBackup,
  TargetedWelcome,
} from "./interface.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const BACKUP_MAGIC = "AGORA_MOCK_BACKUP_V1";

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Deterministic non-zero keystream (FNV-seeded LCG). Non-zero guarantees ciphertext≠plaintext. */
function keystream(seed: Uint8Array, len: number): Uint8Array {
  let state = 2166136261 >>> 0;
  for (const b of seed) state = ((state ^ b) * 16777619) >>> 0;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
    if (out[i] === 0) out[i] = 0xa5;
  }
  return out;
}
function bytesFrom(s: string, len: number): Uint8Array {
  return keystream(enc.encode(s), len);
}
function xor(data: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i]! ^ key[i % key.length]!;
  return out;
}
function jsonBytes(v: unknown): Uint8Array {
  return enc.encode(JSON.stringify(v));
}
function parseJson<T>(b: Uint8Array): T {
  return JSON.parse(dec.decode(b)) as T;
}

interface GroupState {
  secret: Uint8Array; // per-group symmetric secret (the mock's stand-in for MLS group secrets)
  epoch: bigint;
}
interface WelcomePayload {
  groupId: string; // hex
  secret: string; // hex
  epoch: string;
}

export class MockSecureChatCrypto implements SecureChatCrypto {
  private identity?: DeviceIdentity;
  private privateState?: Uint8Array;
  private groups = new Map<string, GroupState>(); // groupIdHex -> state
  private kpCounter = 0;

  async generateDeviceIdentity(opts: { deviceId: string; ciphersuite?: number }) {
    const ciphersuite = opts.ciphersuite ?? 1;
    const identity: DeviceIdentity = {
      deviceId: opts.deviceId,
      signaturePublicKey: bytesFrom(`sig:${opts.deviceId}`, 32),
      credential: enc.encode(opts.deviceId), // mock credential = the device id
      ciphersuite,
    };
    this.identity = identity;
    this.privateState = bytesFrom(`priv:${opts.deviceId}`, 32);
    return { identity, privateState: this.privateState };
  }

  async generateKeyPackages(count: number): Promise<KeyPackageBundle[]> {
    const did = this.identity?.deviceId ?? "unknown";
    const cs = this.identity?.ciphersuite ?? 1;
    const out: KeyPackageBundle[] = [];
    for (let i = 0; i < count; i++) {
      const ref = `${did}:kp:${this.kpCounter++}`;
      out.push({ keyPackageRef: ref, keyPackage: bytesFrom(`kp:${ref}`, 48), ciphersuite: cs });
    }
    return out;
  }

  async createGroup(opts: {
    mlsGroupId?: Uint8Array;
    initialMembers: { deviceId: string; keyPackage: Uint8Array }[];
  }): Promise<{ group: GroupHandle; welcomes: TargetedWelcome[] }> {
    const did = this.identity?.deviceId ?? "creator";
    const mlsGroupId = opts.mlsGroupId ?? bytesFrom(`grp:${did}:${opts.initialMembers.map((m) => m.deviceId).join(",")}`, 16);
    const idHex = toHex(mlsGroupId);
    const secret = bytesFrom(`secret:${idHex}:${did}`, 32);
    this.groups.set(idHex, { secret, epoch: 0n });
    const welcomes = opts.initialMembers.map((m) => ({
      targetDeviceId: m.deviceId,
      payload: jsonBytes({ groupId: idHex, secret: toHex(secret), epoch: "0" } satisfies WelcomePayload),
    }));
    return { group: { mlsGroupId, epoch: 0n }, welcomes };
  }

  async addMember(group: GroupHandle, newDevice: { deviceId: string; keyPackage: Uint8Array }): Promise<CommitResult> {
    const idHex = toHex(group.mlsGroupId);
    const st = this.groups.get(idHex);
    if (!st) throw new Error("mock: unknown group");
    st.epoch += 1n;
    const epoch = st.epoch;
    return {
      commit: jsonBytes({ type: "commit", groupId: idHex, epoch: epoch.toString() }),
      welcomes: [
        {
          targetDeviceId: newDevice.deviceId,
          payload: jsonBytes({ groupId: idHex, secret: toHex(st.secret), epoch: epoch.toString() } satisfies WelcomePayload),
        },
      ],
      epoch,
    };
  }

  async removeMember(group: GroupHandle, _leafDeviceId: string): Promise<CommitResult> {
    const idHex = toHex(group.mlsGroupId);
    const st = this.groups.get(idHex);
    if (!st) throw new Error("mock: unknown group");
    st.epoch += 1n;
    return { commit: jsonBytes({ type: "commit", groupId: idHex, epoch: st.epoch.toString() }), welcomes: [], epoch: st.epoch };
  }

  async encryptMessage(group: GroupHandle, plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; epoch: bigint }> {
    const idHex = toHex(group.mlsGroupId);
    const st = this.groups.get(idHex);
    if (!st) throw new Error("mock: unknown group");
    const sender = this.identity?.deviceId ?? "unknown";
    const ks = keystream(st.secret, plaintext.length);
    const body = xor(plaintext, ks);
    const header = enc.encode(`${sender}|${st.epoch}|`);
    const ciphertext = new Uint8Array(header.length + body.length);
    ciphertext.set(header, 0);
    ciphertext.set(body, header.length);
    return { ciphertext, epoch: st.epoch };
  }

  async decryptMessage(
    group: GroupHandle,
    ciphertext: Uint8Array
  ): Promise<{ plaintext: Uint8Array; senderDeviceId: string; epoch: bigint }> {
    const idHex = toHex(group.mlsGroupId);
    const st = this.groups.get(idHex);
    if (!st) throw new Error("mock: unknown group");
    // header = "<deviceId>|<epoch>|" — split on the SECOND pipe.
    let pipes = 0;
    let cut = -1;
    for (let i = 0; i < ciphertext.length; i++) {
      if (ciphertext[i] === 0x7c /* | */) {
        pipes++;
        if (pipes === 2) {
          cut = i + 1;
          break;
        }
      }
    }
    if (cut < 0) throw new Error("mock: malformed ciphertext");
    const [senderDeviceId, epochStr] = dec.decode(ciphertext.slice(0, cut - 1)).split("|");
    const body = ciphertext.slice(cut);
    const ks = keystream(st.secret, body.length);
    return { plaintext: xor(body, ks), senderDeviceId: senderDeviceId ?? "", epoch: BigInt(epochStr ?? "0") };
  }

  async processWelcome(welcome: Uint8Array): Promise<GroupHandle> {
    const w = parseJson<WelcomePayload>(welcome);
    this.groups.set(w.groupId, { secret: fromHex(w.secret), epoch: BigInt(w.epoch) });
    return { mlsGroupId: fromHex(w.groupId), epoch: BigInt(w.epoch) };
  }

  async processCommit(group: GroupHandle, commit: Uint8Array): Promise<GroupHandle> {
    const c = parseJson<{ epoch: string }>(commit);
    const idHex = toHex(group.mlsGroupId);
    const st = this.groups.get(idHex);
    if (st) st.epoch = BigInt(c.epoch);
    return { mlsGroupId: group.mlsGroupId, epoch: BigInt(c.epoch) };
  }

  async processProposal(_group: GroupHandle, _proposal: Uint8Array): Promise<void> {
    /* mock: proposals are no-ops until their Commit arrives */
  }

  async exportGroupState(group: GroupHandle): Promise<Uint8Array> {
    const idHex = toHex(group.mlsGroupId);
    const st = this.groups.get(idHex);
    if (!st) throw new Error("mock: unknown group");
    return jsonBytes({ groupId: idHex, secret: toHex(st.secret), epoch: st.epoch.toString() });
  }

  async importGroupState(state: Uint8Array): Promise<GroupHandle> {
    const s = parseJson<{ groupId: string; secret: string; epoch: string }>(state);
    this.groups.set(s.groupId, { secret: fromHex(s.secret), epoch: BigInt(s.epoch) });
    return { mlsGroupId: fromHex(s.groupId), epoch: BigInt(s.epoch) };
  }

  async exportBackup(passphrase: string): Promise<PassphraseBackup> {
    const groups = [...this.groups.entries()].map(([id, st]) => ({ id, secret: toHex(st.secret), epoch: st.epoch.toString() }));
    const plain = jsonBytes({
      magic: BACKUP_MAGIC,
      identityPriv: this.privateState ? toHex(this.privateState) : null,
      deviceId: this.identity?.deviceId ?? null,
      groups,
    });
    const salt = bytesFrom(`salt:${passphrase}`, 16);
    const key = keystream(enc.encode(`${passphrase}:${toHex(salt)}`), plain.length);
    return {
      blob: xor(plain, key),
      kdf: "argon2id",
      kdfParams: { salt: toHex(salt), m: 65536, t: 3, p: 1 },
      cipher: "xchacha20poly1305",
      nonce: bytesFrom(`nonce:${passphrase}`, 24),
      version: 1,
    };
  }

  async importBackup(passphrase: string, backup: PassphraseBackup): Promise<void> {
    const salt = (backup.kdfParams as { salt?: string }).salt ?? toHex(bytesFrom(`salt:${passphrase}`, 16));
    const key = keystream(enc.encode(`${passphrase}:${salt}`), backup.blob.length);
    const plain = xor(backup.blob, key);
    let parsed: { magic: string; identityPriv: string | null; deviceId: string | null; groups: { id: string; secret: string; epoch: string }[] };
    try {
      parsed = parseJson(plain);
    } catch {
      throw new Error("mock: backup decrypt failed (wrong passphrase?)");
    }
    if (parsed.magic !== BACKUP_MAGIC) throw new Error("mock: backup decrypt failed (wrong passphrase?)");
    if (parsed.identityPriv) this.privateState = fromHex(parsed.identityPriv);
    for (const g of parsed.groups) this.groups.set(g.id, { secret: fromHex(g.secret), epoch: BigInt(g.epoch) });
  }
}
