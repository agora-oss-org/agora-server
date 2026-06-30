export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  url?: string;
}

export type DeviceLike = { id: string; platform: string; token: string | null; subscription: unknown };

export interface PushProvider {
  // Returns { ok } on delivery; { prune: true } when the token/subscription is dead (delete the row).
  send(device: DeviceLike, payload: PushPayload): Promise<{ ok: boolean; prune?: boolean }>;
}

export type ProviderMap = Record<"ios" | "android" | "web", PushProvider | null>;
