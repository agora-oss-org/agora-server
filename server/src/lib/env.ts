// Centralized, validated environment access.
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().optional(),
  ACCESS_TOKEN_TTL: z.coerce.number().default(1800),
  REFRESH_TOKEN_TTL: z.coerce.number().default(2592000),
  ACCESS_TOKEN_SECRET: z.string().min(1),
  REFRESH_TOKEN_GRACE_SECONDS: z.coerce.number().default(30),
  CORS_ORIGIN: z.string().default("*"),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
