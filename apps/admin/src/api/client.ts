// The proof that the contract is shared 1:1: this client imports a response *type* and a
// request *zod schema* straight from @agora/contract — the same definitions the server enforces.
import type { Entity, PaginatedResponse } from "@agora/contract";
import { createEntitySchema } from "@agora/contract";
import type { z } from "zod";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/v7";

// Form input type derived from the shared schema (no hand-written request types to drift).
export type CreateEntityInput = z.input<typeof createEntitySchema>;

/** Validate a new-entity form with the SAME schema the server uses (returns zod's SafeParse). */
export function validateNewEntity(input: unknown) {
  return createEntitySchema.safeParse(input);
}

// The admin addresses the same multi-tenant API as the SDK: /v7/:projectId/<domain>.
/** List entities for a project — response typed by the shared contract. */
export async function listEntities(projectId: string, page = 1): Promise<PaginatedResponse<Entity>> {
  const res = await fetch(`${BASE}/${projectId}/entities?page=${page}`);
  if (!res.ok) throw new Error(`listEntities failed: ${res.status}`);
  return (await res.json()) as PaginatedResponse<Entity>;
}

/** Create an entity, validating client-side first with the shared schema. */
export async function createEntity(
  projectId: string,
  input: CreateEntityInput,
  token: string,
): Promise<Entity> {
  const body = createEntitySchema.parse(input); // throws on invalid input, mirroring the server
  const res = await fetch(`${BASE}/${projectId}/entities`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`createEntity failed: ${res.status}`);
  return (await res.json()) as Entity;
}
