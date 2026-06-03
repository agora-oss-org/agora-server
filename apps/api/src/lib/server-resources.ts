// Server container resource snapshot — free memory + disk for the container the API runs in.
// Operator-only deployment infra (surfaced on the admin dashboard beside the DB size).
//
// Memory is CGROUP-AWARE so it reflects the *container's* limit, not the host: plain os.freemem()
// reports the host's RAM inside a container. We read cgroup v2 (then v1), falling back to os.* when
// there's no limit. Disk uses fs.statfs on the app's filesystem.
//
// Caveat: with multiple replicas this reflects whichever container served the request.
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import { logger } from "./logger.js";

export interface ServerResources {
  memoryTotalBytes: number | null;
  memoryUsedBytes: number | null;
  memoryFreeBytes: number | null;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
}

async function readNum(path: string): Promise<number | null> {
  try {
    const s = (await readFile(path, "utf8")).trim();
    if (s === "max") return null; // cgroup v2 "unlimited"
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function memory(): Promise<{ total: number | null; used: number | null; free: number | null }> {
  // cgroup v2, then v1.
  let limit = await readNum("/sys/fs/cgroup/memory.max");
  let usage = await readNum("/sys/fs/cgroup/memory.current");
  if (limit === null && usage === null) {
    limit = await readNum("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    usage = await readNum("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  }
  // cgroup v1 represents "unlimited" as a huge sentinel — treat absurd values as no limit.
  if (limit !== null && limit > os.totalmem() * 4) limit = null;

  if (limit === null) {
    // No container limit (or not on Linux/cgroups, e.g. local dev) → report host memory.
    const total = os.totalmem();
    const free = os.freemem();
    return { total, used: total - free, free };
  }
  const used = usage ?? 0;
  return { total: limit, used, free: Math.max(0, limit - used) };
}

async function disk(): Promise<{ total: number | null; free: number | null }> {
  try {
    const s = await statfs(process.cwd());
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; // bavail = available to unprivileged
  } catch (e) {
    logger.debug({ err: e }, "server-resources: statfs failed");
    return { total: null, free: null };
  }
}

/** Free/total memory + disk for the running container. Fail-soft — fields are null on read failure. */
export async function getServerResources(): Promise<ServerResources> {
  const [m, d] = await Promise.all([memory(), disk()]);
  return {
    memoryTotalBytes: m.total,
    memoryUsedBytes: m.used,
    memoryFreeBytes: m.free,
    diskTotalBytes: d.total,
    diskFreeBytes: d.free,
  };
}
