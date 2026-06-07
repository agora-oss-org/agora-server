// The `SecureChatCrypto` seam.
//
// All MLS (RFC 9420) crypto lives CLIENT-side behind this one interface. The Agora server is
// a blind Delivery Service and depends on none of this. The concrete core — ts-mls (pure TS)
// or OpenMLS compiled to WASM — is a swappable implementation of `SecureChatCrypto`; the
// abstraction is what lets that choice be deferred and changed without touching call sites.
//
// Binary is `Uint8Array` IN MEMORY here; the network layer base64-encodes at the wire
// boundary (see @agora/contract secure-chat envelopes). MLS epochs are u64 → `bigint`.

/** A device's long-lived MLS identity (one device = one leaf). The public half is published
 *  to the server; the private half stays on the device (and in the passphrase backup). */
export interface DeviceIdentity {
  deviceId: string;
  signaturePublicKey: Uint8Array;
  credential: Uint8Array;
  ciphersuite: number;
}

/** A one-time KeyPackage others consume to add this device to a group. */
export interface KeyPackageBundle {
  keyPackageRef: string;
  keyPackage: Uint8Array;
  ciphersuite: number;
  expiresAt?: string;
}

/** A handle to a local MLS group the client holds the secrets for. */
export interface GroupHandle {
  mlsGroupId: Uint8Array;
  epoch: bigint;
}

/** A Welcome destined for exactly one new-member device (the one whose KeyPackage was used). */
export interface TargetedWelcome {
  targetDeviceId: string;
  payload: Uint8Array;
}

/** The output of a group mutation: a Commit to broadcast + per-device Welcomes to deliver. */
export interface CommitResult {
  commit: Uint8Array;
  welcomes: TargetedWelcome[];
  epoch: bigint;
}

/** A serialized, passphrase-encrypted backup of all local key material (history-restore on a
 *  new browser; also the basis for cross-device history sync later). */
export interface PassphraseBackup {
  blob: Uint8Array;
  kdf: string;
  kdfParams: Record<string, unknown>;
  cipher: string;
  nonce: Uint8Array;
  version: number;
}

export interface SecureChatCrypto {
  // ── identity / device ──────────────────────────────────────────────────────
  generateDeviceIdentity(opts: { deviceId: string; ciphersuite?: number }): Promise<{
    identity: DeviceIdentity;
    privateState: Uint8Array;
  }>;
  generateKeyPackages(count: number): Promise<KeyPackageBundle[]>;

  // ── group lifecycle (client-side; the server only relays the outputs) ───────
  createGroup(opts: {
    mlsGroupId?: Uint8Array;
    initialMembers: { deviceId: string; keyPackage: Uint8Array }[];
  }): Promise<{ group: GroupHandle; welcomes: TargetedWelcome[] }>;
  addMember(group: GroupHandle, newDevice: { deviceId: string; keyPackage: Uint8Array }): Promise<CommitResult>;
  removeMember(group: GroupHandle, leafDeviceId: string): Promise<CommitResult>;

  // ── application messages ────────────────────────────────────────────────────
  encryptMessage(group: GroupHandle, plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; epoch: bigint }>;
  decryptMessage(
    group: GroupHandle,
    ciphertext: Uint8Array
  ): Promise<{ plaintext: Uint8Array; senderDeviceId: string; epoch: bigint }>;

  // ── processing inbound handshakes ───────────────────────────────────────────
  processWelcome(welcome: Uint8Array): Promise<GroupHandle>;
  processCommit(group: GroupHandle, commit: Uint8Array): Promise<GroupHandle>; // advances epoch
  processProposal(group: GroupHandle, proposal: Uint8Array): Promise<void>;

  // ── local MLS state persistence (IndexedDB on web; opaque serialization) ────
  exportGroupState(group: GroupHandle): Promise<Uint8Array>;
  importGroupState(state: Uint8Array): Promise<GroupHandle>;

  // ── passphrase backup of all local key material ─────────────────────────────
  exportBackup(passphrase: string): Promise<PassphraseBackup>;
  importBackup(passphrase: string, backup: PassphraseBackup): Promise<void>;
}
