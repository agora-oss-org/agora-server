// Shared Hono context variable types, set by middleware and read by handlers.
// AuthContext lives in @agora-server/contract (shared with admin); re-exported here.
import type { AuthContext, SpaceReputationDirective } from "@agora-server/contract";
export type { AuthContext };

export type Variables = {
  projectId: string;
  auth: AuthContext | null;   // null when route is unauthenticated / token absent
  spaceRep?: SpaceReputationDirective | null; // resolved space-reputation directive (v7.8.2 #6)
};
