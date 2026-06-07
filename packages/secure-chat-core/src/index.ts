// @agora/secure-chat-core — the client crypto seam for end-to-end-encrypted chat.
// Phase 1 ships the interface + a deterministic mock; the concrete MLS core (ts-mls /
// OpenMLS-WASM) plugs in behind `SecureChatCrypto` later. The server depends on NONE of this.
export * from "./interface.js";
export { MockSecureChatCrypto } from "./mock-crypto.js";
