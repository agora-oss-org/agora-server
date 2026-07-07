import { Errors } from "../http/errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate the SDK's space-reputation params (scaffold — no enrichment emitted this cycle).
 *  context endpoints: uuid | "none" | "context". user-direct (/users/*): uuid | "none" ("context" → 400).
 *  spaceReputationDescendants is only meaningful with an explicit uuid. Absent params are a no-op. */
export function validateSpaceReputationParams(
  raw: { spaceReputationId?: string; spaceReputationDescendants?: string },
  endpointClass: "context" | "user-direct",
): void {
  const id = raw.spaceReputationId;
  if (id !== undefined) {
    const isSpecial = id === "none" || id === "context";
    const isUuid = UUID_RE.test(id);
    if (!isSpecial && !isUuid) {
      throw Errors.badRequest("space-reputation/invalid-id", "spaceReputationId must be a uuid, 'none', or 'context'", "spaceReputationId");
    }
    if (id === "context" && endpointClass === "user-direct") {
      throw Errors.badRequest("space-reputation/context-not-allowed", "'context' is not valid on user-direct endpoints", "spaceReputationId");
    }
  }
  if (raw.spaceReputationDescendants === "true" && (id === undefined || id === "none" || id === "context")) {
    throw Errors.badRequest("space-reputation/descendants-needs-uuid", "spaceReputationDescendants requires an explicit space id", "spaceReputationDescendants");
  }
}
