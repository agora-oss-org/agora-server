// Optional deployment boot hook. Runs an operator-supplied module ONCE at startup, before the server
// serves — the documented way for a PREBUILT image to register a per-project DB resolver (setDbResolver)
// or warm a tenant directory without editing the bundled entrypoint. AGORA_BOOT_MODULE is the SOLE
// supported mechanism. Loaded as a side-effect import: the module does its work at evaluation time
// (top-level await is fine). Unset/empty → no-op, byte-for-byte today's boot.
//
// An import failure PROPAGATES unchanged so the entrypoint can fail CLOSED (refuse to start). There is
// deliberately no swallow-and-continue branch: serving without the configured resolver would silently
// fall back to the shared DB — cross-tenant contamination, the exact failure the resolver seam prevents.
export async function loadBootModule(specifier: string | undefined): Promise<string | null> {
  if (!specifier) return null;
  await import(specifier);
  return specifier;
}
