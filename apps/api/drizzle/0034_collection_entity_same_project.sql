-- Defense-in-depth backstop for cross-tenant isolation on collection_entities (security audit).
-- The handlers in routes/collections.ts (POST/DELETE/GET /:id/entities) now verify the entity
-- belongs to the request's project before mutating/reading the join — the server stays the trust
-- boundary. This trigger is the DB-level last line: collection_entities has no project_id column
-- of its own (PK is {collection_id, entity_id}), so a plain CHECK can't compare across the two FKs.
-- A BEFORE INSERT OR UPDATE trigger asserts the referenced collection and entity share a project_id,
-- so even a future handler that forgets the check can never link a foreign-project entity.
-- Idempotent per repo convention (create or replace; drop trigger if exists before create).

create or replace function assert_collection_entity_same_project() returns trigger language plpgsql as $$
declare
  coll_project uuid;
  ent_project  uuid;
begin
  select project_id into coll_project from collections where id = new.collection_id;
  select project_id into ent_project  from entities    where id = new.entity_id;
  if coll_project is null or ent_project is null or coll_project <> ent_project then
    raise exception 'collection_entities: collection % and entity % must belong to the same project',
      new.collection_id, new.entity_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
--> statement-breakpoint
drop trigger if exists trg_collection_entity_same_project on collection_entities;
--> statement-breakpoint
create trigger trg_collection_entity_same_project
  before insert or update on collection_entities
  for each row execute function assert_collection_entity_same_project();
