#!/usr/bin/env bash
# End-to-end CO_PARTICIPATES seam smoke test.
# Spec: docs/superpowers/specs/2026-06-16-co-participates-smoke-test-design.md
#
# Proves the writer↔reader seam against a LIVE Neo4j: the REAL Python scorer writer
# (worker.neo4j_writer.write_co_participates_edge) MERGEs an edge, then the REAL TS API reader
# (getSocialNeighborhood) reads it back. A label/property drift between the two surfaces here as a
# silent zero-result — the class of regression the stubbed-driver unit suites can't see.
#
# Needs only Neo4j (no Postgres / pgmq): the writer is called with explicit ids; the reader stubs
# profiles. (DATABASE_URL / ACCESS_TOKEN_SECRET are still required at import by the API's lib/env, so
# they're read from .env below — but no query is ever issued.)
#
# Run with the local stack up:
#   TEST_NEO4J_URI=bolt://localhost:7687 TEST_NEO4J_AUTH=neo4j/please_change_me ./scripts/smoke/co-participates.sh
# Credentials fall back to TEST_NEO4J_URI / TEST_NEO4J_AUTH in apps/api/.env when not exported.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
ENV_FILE="apps/api/.env"

# --- preflight: resolve env (explicit shell env wins; else grep it out of .env) ---
read_env() { # $1 = var name → echo its value from ENV_FILE (empty if absent)
  [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true
}
TEST_NEO4J_URI="${TEST_NEO4J_URI:-$(read_env TEST_NEO4J_URI)}"
TEST_NEO4J_AUTH="${TEST_NEO4J_AUTH:-$(read_env TEST_NEO4J_AUTH)}"
DATABASE_URL="${DATABASE_URL:-$(read_env DATABASE_URL)}"
ACCESS_TOKEN_SECRET="${ACCESS_TOKEN_SECRET:-$(read_env ACCESS_TOKEN_SECRET)}"
: "${TEST_NEO4J_URI:?set TEST_NEO4J_URI (e.g. bolt://localhost:7687) — is the stack up?}"
: "${TEST_NEO4J_AUTH:?set TEST_NEO4J_AUTH (e.g. neo4j/please_change_me)}"
: "${DATABASE_URL:?DATABASE_URL not set and not found in $ENV_FILE (required at import by lib/env)}"
: "${ACCESS_TOKEN_SECRET:?ACCESS_TOKEN_SECRET not set and not found in $ENV_FILE}"
export TEST_NEO4J_URI TEST_NEO4J_AUTH DATABASE_URL ACCESS_TOKEN_SECRET

PROJECT="$(uuidgen)"
ACTOR="$(uuidgen)"
PARTICIPANT="$(uuidgen)"

run_reader() { # forwards remaining args to the TS reader CLI
  ( cd apps/api && pnpm exec tsx scripts/smoke-read-co-participates.ts \
      --project "$PROJECT" --actor "$ACTOR" --participant "$PARTICIPANT" "$@" )
}

finish() {
  local code=$?
  run_reader --cleanup || true   # best-effort node teardown (idempotent DETACH DELETE)
  if [[ $code -ne 0 ]]; then
    echo "❌ FAIL — CO_PARTICIPATES seam check failed (exit $code)"
  fi
  exit $code
}
trap finish EXIT

echo "▸ project=$PROJECT  actor=$ACTOR  participant=$PARTICIPANT"

echo "▸ [1/2] writing CO_PARTICIPATES via the real Python scorer writer …"
( cd services/scorer && PYTHONPATH=. .venv/bin/python scripts/smoke_write_co_participates.py \
    --project "$PROJECT" --actor "$ACTOR" --participant "$PARTICIPANT" )

echo "▸ [2/2] reading it back via the real TS API reader …"
run_reader

echo "✅ PASS — CO_PARTICIPATES writer↔reader seam verified against $TEST_NEO4J_URI"
