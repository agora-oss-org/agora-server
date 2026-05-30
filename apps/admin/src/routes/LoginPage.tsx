import { Hexagon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../lib/api";
import { DEMO_EMAIL, DEMO_PASSWORD, ENV_PROJECT_ID } from "../config";
import { Button } from "../components/ui/Button";
import { Input, Label } from "../components/ui/Input";

export function LoginPage() {
  const { session, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/dashboard";

  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [projectId, setProjectId] = useState(ENV_PROJECT_ID ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to={from} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password, projectId.trim());
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <Hexagon className="size-8 text-primary" />
          <h1 className="text-lg font-semibold text-fg">Agora Admin</h1>
          <p className="text-sm text-muted">Sign in to manage your community.</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 rounded-[var(--radius-card)] border border-border bg-surface p-6">
          {!ENV_PROJECT_ID && (
            <div className="space-y-1.5">
              <Label htmlFor="projectId">Project ID</Label>
              <Input id="projectId" value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="00000000-0000-…" required autoComplete="off" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required autoComplete="current-password" />
          </div>

          {error ? <p className="rounded-md bg-danger/15 px-3 py-2 text-sm text-danger">{error}</p> : null}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
