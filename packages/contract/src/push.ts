// Push device registration identifiers (SDK PushDeviceIdentifier union). Pure zod + types.
import { z } from "zod";

const nativeDevice = z.object({
  platform: z.enum(["ios", "android"]),
  token: z.string().min(1),
});
const webDevice = z.object({
  platform: z.literal("web"),
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
});
export const pushDeviceSchema = z.discriminatedUnion("platform", [nativeDevice, webDevice]);

export type PushDeviceIdentifier = z.infer<typeof pushDeviceSchema>;
export interface PushDevice {
  id: string; projectId: string; userId: string;
  platform: "ios" | "android" | "web";
  token: string | null;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } } | null;
  createdAt: string; updatedAt: string;
}
