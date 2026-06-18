// Optional Redis client — used ONLY by the cross-replica rate limiter (lib/rate-limit.ts) when
// REDIS_URL is set. Lazily constructed (the server boots without it) and fail-soft: a connection error
// is logged, not thrown, and the limiter degrades to its in-memory store. Mirrors lib/supabase.ts.
import Redis from "ioredis";
import { env } from "./env.js";
import { logger } from "./logger.js";

let client: Redis | null = null;
let attempted = false;

/** The shared Redis client, or null when REDIS_URL is unset. Constructed once. */
export function getRedis(): Redis | null {
  if (attempted) return client;
  attempted = true;
  if (!env.REDIS_URL) return null;
  client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1, // fail fast instead of hanging when Redis is down
    enableOfflineQueue: false,
    enableReadyCheck: false, // skip the INFO ready-probe so a least-privilege ACL user needs no INFO
    connectTimeout: 2000,
  });
  client.on("error", (err) =>
    logger.warn({ err: err.message }, "redis: connection error (rate limiting falls back to in-memory)"));
  logger.info("redis: cross-replica rate-limit store enabled");
  return client;
}
