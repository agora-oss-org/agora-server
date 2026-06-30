// VAPID keypair resolution: per-project (project_integrations name='vapid') first, else the global
// env keypair. Returns null when neither yields a COMPLETE pair (web push then simply disabled).
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { projectIntegrations } from "../../db/schema/index.js";
import { env } from "../env.js";

type Keys = { publicKey?: string; privateKey?: string; subject?: string };
type ResolvedVapid = { publicKey: string; privateKey: string; subject: string };

const DEFAULT_SUBJECT = "mailto:push@agora";

export function resolveVapid(perProject: Keys | null, envKeys: Keys): ResolvedVapid | null {
  const complete = (k: Keys | null): ResolvedVapid | null =>
    k && k.publicKey && k.privateKey ? { publicKey: k.publicKey, privateKey: k.privateKey, subject: k.subject || DEFAULT_SUBJECT } : null;
  return complete(perProject) ?? complete(envKeys);
}

export async function getVapidKeys(projectId: string): Promise<ResolvedVapid | null> {
  const [row] = await db.select({ data: projectIntegrations.data }).from(projectIntegrations)
    .where(and(eq(projectIntegrations.projectId, projectId), eq(projectIntegrations.name, "vapid"))).limit(1);
  const perProject = (row?.data as Keys | undefined) ?? null;
  return resolveVapid(perProject, {
    publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT,
  });
}
