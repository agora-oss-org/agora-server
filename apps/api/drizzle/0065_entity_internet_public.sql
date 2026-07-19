-- apps/api/drizzle/0065_entity_internet_public.sql
-- Internet-public flag (visibility-ladder top rung): opts an entity (and its comment thread) into
-- the anonymous GET-only /public/* read surface. Privileged write (operator/project-admin/space-
-- admin) via PATCH /entities/:id/visibility; the read gate re-derives is_public AND space-is-public
-- live on every request (fail closed). Column mirrors is_draft naming. Idempotent.
-- Spec: docs/superpowers/specs/2026-07-18-internet-public-entities-design.md
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;
