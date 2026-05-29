import { useState } from "react";
import { REACTION_TYPES } from "@agora/contract";
import { validateNewEntity } from "./api/client";

// Skeleton admin shell — a placeholder that demonstrates the shared contract is wired in.
export function App() {
  const [title, setTitle] = useState("");
  const check = validateNewEntity({ title });

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 560, margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Agora Admin</h1>
      <p>
        Frontend skeleton wired to <code>@agora/contract</code>. The reaction taxonomy and the entity
        request schema below come straight from the shared package — the same source the API enforces.
      </p>

      <label style={{ display: "block", margin: "1rem 0 0.25rem" }}>New entity title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: "100%", padding: 8 }} />
      <p>Validates against the shared <code>createEntitySchema</code>: {check.success ? "✅ valid" : "—"}</p>

      <h2 style={{ marginTop: "2rem" }}>Reaction types (from contract)</h2>
      <ul>
        {REACTION_TYPES.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </main>
  );
}
