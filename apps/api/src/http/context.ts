// Shared Hono context variable types, set by middleware and read by handlers.
// AuthContext lives in @agora/contract (shared with admin); re-exported here.
import type { AuthContext } from "@agora/contract";
export type { AuthContext };

export type Variables = {
  projectId: string;
  auth: AuthContext | null;   // null when route is unauthenticated / token absent
};
