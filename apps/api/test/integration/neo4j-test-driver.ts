// Shared Neo4j credential resolution for the opt-in live-graph tests.
//
// Auth is the single combined `TEST_NEO4J_AUTH=user/password` var — the standard Neo4j form, mirroring
// the app's own `NEO4J_AUTH`. (The live tests previously read split `TEST_NEO4J_USER`/`TEST_NEO4J_PASSWORD`
// vars, which weren't set, so the driver silently authenticated with an EMPTY password → "unauthorized
// due to authentication failure", and the repeated attempts tripped Neo4j's auth rate-limiter:
// "provided incorrect authentication details too many times in a row" — a temporary lockout.)
//
// `TEST_NEO4J_AUTH` is "user/password", split on the FIRST "/" (so a "/" inside the password is preserved).
import neo4j, { type AuthToken, type Driver } from "neo4j-driver";

export const TEST_NEO4J_URI = process.env.TEST_NEO4J_URI;

export function testNeo4jAuth(): AuthToken {
  const combined = process.env.TEST_NEO4J_AUTH ?? "";
  const slash = combined.indexOf("/");
  const user = slash === -1 ? "neo4j" : combined.slice(0, slash) || "neo4j";
  const password = slash === -1 ? combined : combined.slice(slash + 1);
  return neo4j.auth.basic(user, password);
}

export function testNeo4jDriver(): Driver {
  if (!TEST_NEO4J_URI) throw new Error("TEST_NEO4J_URI is not set");
  return neo4j.driver(TEST_NEO4J_URI, testNeo4jAuth());
}
