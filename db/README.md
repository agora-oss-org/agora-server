# Agora — Database

Postgres schema for the Replyke-compatible backend, designed for **Supabase**
(uses `auth.users`, `vector`, `postgis`).

## Apply order

Migrations are ordered and idempotent-ish; apply in sequence:

| File | Contents |
|---|---|
| `0001_init_extensions_projects.sql` | extensions, enums, `projects`, `profiles`, oauth, suspensions |
| `0002_entities_comments_reactions.sql` | `entities`, `comments`, `reactions` (+ feed indexes) |
| `0003_spaces_relationships.sql` | `spaces`, `space_members`, `space_rules`, `follows`, `connections` |
| `0004_chat.sql` | `conversations`, `conversation_members`, `chat_messages`, reactions |
| `0005_collections_files_notifications_reports.sql` | collections, files, notifications, reports, embeddings |
| `0006_triggers.sql` | denormalized counts (reactions, replies, members, threads…) + reputation |
| `0007_functions_rpc.sql` | `toggle_reaction`, `hot_score`/`refresh_entity_score`, `fetch_comment_thread`, `match_entities` |
| `0008_rls.sql` | enable RLS (deny-all to non-service callers) |

```bash
# via Supabase CLI
supabase db reset            # local
# or pipe each file to psql in order:
for f in db/migrations/0*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

## Key design decisions

- **Multi-tenant by `project_id`** — every table carries it because the SDK addresses
  `/v7/:projectId/...`. A single-project deployment just uses one row in `projects`.
- **Denormalized counts** (`reaction_counts`, `replies_count`, `members_count`,
  `thread_reply_count`, `entity_count`) are maintained by triggers — never recomputed per request.
- **v6 + v7 reactions coexist**: `entities`/`comments` keep legacy `upvotes[]`/`downvotes[]`
  arrays *and* the v7 `reaction_counts` jsonb, because the SDK types expose both.
- **Reactions are normalized** in `reactions`; the jsonb counts are derived (trigger `0006`).
- **Comments** use adjacency list (`parent_id`) + recursive CTE (`fetch_comment_thread`);
  swap to materialized-path if threads get very deep.
- **Embedding dim = 1536** (OpenAI `text-embedding-3-small`). Change `vector(N)` + the
  ivfflat index if you use another model.
- **Scores**: call `refresh_entity_score(id)` after vote changes, or batch via a cron /
  Edge Function for the whole hot feed. Formula tunable in `hot_score()`.

## Not yet covered (intentional gaps)

- Refresh-token family/rotation tables (lives in the auth service — see server scaffold).
- Digest webhook delivery log.
- Partitioning / archival for high-volume `chat_messages` and `app_notifications`.
