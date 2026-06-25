// pending_embeddings — the durable backlog behind the outbound embed throttle. Real Postgres, isolated
// by project_id. The integration env forces VOYAGE_API_KEY empty, so drain is a no-op here (real
// re-embedding is covered at unit level); this asserts the enqueue/dedup/cap DB mechanics + the table.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { pendingEmbeddings } from "../../src/db/schema/index.js";
import { enqueuePending, drainPendingEmbeddings } from "../../src/lib/pending-embeddings.js";
import { env } from "../../src/lib/env.js";
import { createProject, deleteProject } from "./helpers.js";

describe("pending-embeddings (integration)", () => {
  let projectId: string;
  beforeAll(async () => { projectId = await createProject(); });
  afterAll(async () => { await deleteProject(projectId); });

  const rowsFor = (sourceId: string) =>
    db.select().from(pendingEmbeddings)
      .where(and(eq(pendingEmbeddings.projectId, projectId), eq(pendingEmbeddings.sourceId, sourceId)));

  const globalCount = async () =>
    Number(((await db.execute(sql`select count(*)::int as n from pending_embeddings`)) as unknown as { n: number }[])[0]!.n);

  it("enqueues a durable needs-embedding flag", async () => {
    const id = randomUUID();
    await enqueuePending(projectId, "entity", id, "hello world");
    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("hello world");
    expect(rows[0]!.attempts).toBe(0);
  });

  it("dedups on (sourceType, sourceId) — latest text wins, no second row", async () => {
    const id = randomUUID();
    await enqueuePending(projectId, "comment", id, "first");
    await enqueuePending(projectId, "comment", id, "second");
    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("second");
  });

  it("respects EMBED_THROTTLE_MAX_PENDING — drops NEW flags at the cap", async () => {
    const cap = (await globalCount()) + 1; // one more new row fits, then we're at the cap
    const prev = env.EMBED_THROTTLE_MAX_PENDING;
    env.EMBED_THROTTLE_MAX_PENDING = cap;
    try {
      const a = randomUUID();
      const b = randomUUID();
      await enqueuePending(projectId, "entity", a, "fits");      // count -> cap
      await enqueuePending(projectId, "entity", b, "over-cap");  // blocked
      expect(await rowsFor(a)).toHaveLength(1);
      expect(await rowsFor(b)).toHaveLength(0);
    } finally {
      env.EMBED_THROTTLE_MAX_PENDING = prev;
    }
  });

  it("drain is a no-op (leaves rows queued) when embeddings are disabled", async () => {
    const id = randomUUID();
    await enqueuePending(projectId, "message", id, "queued");
    const res = await drainPendingEmbeddings(100);
    expect(res.drained).toBe(0);
    expect(await rowsFor(id)).toHaveLength(1); // still queued for a future drain with VOYAGE configured
  });
});
