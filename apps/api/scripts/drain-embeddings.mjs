// Cron-able drain of the embed backlog. Standalone — connects via DATABASE_URL (lib/pending-embeddings
// imports the Drizzle db) and replays up to --limit of the oldest pending_embeddings rows into
// content_embeddings; the Agora server need not be running. Needs VOYAGE_API_KEY to actually embed
// (no-op without it). Run from apps/api/ via tsx (resolves the .js import to the TS source):
//   npx tsx scripts/drain-embeddings.mjs                 # default batch of 100
//   npx tsx scripts/drain-embeddings.mjs --limit 500     # larger batch
// Keep the batch × cadence modest — that product is the Voyage pace this backfill imposes. Once
// deployed, an external scheduler can instead hit POST /internal/cron/drain-embeddings (X-Cron-Secret).
import { drainPendingEmbeddings } from "../src/lib/pending-embeddings.js";

const argv = process.argv.slice(2);
const i = argv.indexOf("--limit");
const limit = i !== -1 ? Math.max(1, Number(argv[i + 1]) || 100) : 100;

const res = await drainPendingEmbeddings(limit);
console.log(`✓ pending embeddings: ${res.drained} drained, ${res.failed} failed`);
process.exit(0);
