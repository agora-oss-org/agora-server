// Shared Hono context variable types, set by middleware and read by handlers.
export interface AuthContext {
  userId: string;       // Agora profile id
  role: "admin" | "moderator" | "visitor";
}

export type Variables = {
  projectId: string;
  auth: AuthContext | null;   // null when route is unauthenticated / token absent
};
