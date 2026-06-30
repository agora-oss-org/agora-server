// apps/api/src/lib/push/native.ts — FCM/APNs providers (full impl in Task 8).
import type { PushProvider } from "./provider.js";
export async function getFcmProvider(_projectId: string): Promise<PushProvider | null> { return null; }
export async function getApnsProvider(_projectId: string): Promise<PushProvider | null> { return null; }
