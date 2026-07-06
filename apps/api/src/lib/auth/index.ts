import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { projects } from "../../db/schema/index.js";
import { SupabaseAuthProvider } from "./supabase-provider.js";
import { NativeAuthProvider } from "./native-provider.js";
import { resolveEmailSender } from "./email/sender.js";
import type { AuthProvider } from "./provider.js";

export type { AuthProvider, SignUpResult } from "./provider.js";

const TTL_MS = 30_000;
const cache = new Map<string, { name: "supabase" | "native"; at: number }>();

async function resolveProviderName(projectId: string): Promise<"supabase" | "native"> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name;
  const [p] = await getDb().select({ ap: projects.authProvider }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const name = p?.ap === "native" ? "native" : "supabase"; // fail safe: default supabase
  cache.set(projectId, { name, at: Date.now() });
  return name;
}

export async function getAuthProvider(projectId: string): Promise<AuthProvider> {
  const name = await resolveProviderName(projectId);
  return name === "native" ? new NativeAuthProvider(resolveEmailSender()) : new SupabaseAuthProvider();
}

export function invalidateAuthProvider(projectId: string): void {
  cache.delete(projectId);
}
