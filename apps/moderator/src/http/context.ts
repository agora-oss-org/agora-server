// Shared Hono context variable types, set by middleware and read by handlers.
import type { AuthContext } from "@agora-server/contract";
export type { AuthContext };

export type Variables = {
  auth: AuthContext | null; // set by requireOperator on the admin-facing routes
};
