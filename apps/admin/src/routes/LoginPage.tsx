import { Hexagon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../lib/api";
import { DEMO_EMAIL, DEMO_PASSWORD, ENV_PROJECT_ID, OAUTH_PROVIDERS } from "../config";
import { PROVIDER_LABELS, parseCallbackError, parseCallbackHash, type OAuthProvider } from "../auth/oauth";
import { Button } from "../components/ui/Button";
import { Input, Label } from "../components/ui/Input";

// Email/password sign-in against the Agora server, plus an optional one-click operator path modelled
// on the demo login screen. There is deliberately no self-service sign-up: the admin runs on operator
// accounts, provisioned server-side, not registered here.
//
// The one-click button only appears when the deployment configured seeded demo credentials
// (VITE_DEMO_EMAIL + VITE_DEMO_PASSWORD). Both halves are required — an email with no password can't
// sign in, and a dangling "or" with nothing under it reads as a bug. Real deployments leave these
// unset and only the ordinary form shows.
const ADMIN_LOGIN = Boolean(DEMO_EMAIL && DEMO_PASSWORD);

// Social sign-in (bundled GoTrue / Supabase) is opt-in per deployment: no configured providers ⇒
// no buttons, and this screen is exactly what it was before.
const OAUTH_LOGIN = OAUTH_PROVIDERS.length > 0;

export function LoginPage() {
  const { session, signIn, signInWithOAuth, completeOAuth } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/dashboard";

  // Not prefilled with the demo credentials any more: the operator account has its own button below,
  // so this form is unambiguously "your own account".
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // StrictMode mounts effects twice in dev; the callback's refresh token is single-use, so a second
  // redemption would 401. Latch it.
  const completing = useRef(false);

  // Social sign-in lands back HERE with either tokens in the fragment or ?error= in the query.
  useEffect(() => {
    if (completing.current) return;
    const failure = parseCallbackError(window.location.search);
    const tokens = parseCallbackHash(window.location.hash);
    if (!failure && !tokens) return;
    completing.current = true;
    // Never leave tokens (or a stale error) in the address bar or session history.
    window.history.replaceState(null, "", window.location.pathname);
    if (failure) {
      setError(failure);
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        await completeOAuth(tokens!, ENV_PROJECT_ID);
        navigate("/dashboard", { replace: true });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Couldn't finish signing in with that provider.");
      } finally {
        setBusy(false);
      }
    })();
  }, [completeOAuth, navigate]);

  if (session) return <Navigate to={from} replace />;

  async function authenticate(withEmail: string, withPassword: string, fallbackMessage: string) {
    setError(null);
    setBusy(true);
    try {
      await signIn(withEmail.trim(), withPassword, ENV_PROJECT_ID);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallbackMessage);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void authenticate(email, password, "Sign-in failed. Check your connection and try again.");
  }

  function onOAuth(provider: OAuthProvider) {
    setError(null);
    setBusy(true);
    // Success navigates away from this page, so `busy` is only cleared on failure.
    void signInWithOAuth(provider, ENV_PROJECT_ID).catch((err) => {
      setError(err instanceof ApiError ? err.message : "Couldn't start sign-in with that provider.");
      setBusy(false);
    });
  }

  function onAdminLogin() {
    void authenticate(DEMO_EMAIL, DEMO_PASSWORD, "Couldn't sign in as the demo admin.");
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <Hexagon className="size-8 text-primary" />
          <h1 className="text-lg font-semibold text-fg">Agora Admin</h1>
          <p className="text-sm text-muted">
            Manage your community — moderation, members, settings, and the health dashboard. Sign in
            with an operator account.
          </p>
        </div>

        <div className="space-y-4 rounded-[var(--radius-card)] border border-border bg-surface p-6">
          <form onSubmit={onSubmit} className="space-y-4">
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

          {OAUTH_LOGIN ? (
            <>
              <div className="flex items-center gap-3 text-xs text-muted">
                <span className="h-px flex-1 bg-border" />
                or continue with
                <span className="h-px flex-1 bg-border" />
              </div>
              <div className="space-y-2">
                {OAUTH_PROVIDERS.map((provider) => (
                  <Button
                    key={provider}
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={busy}
                    onClick={() => onOAuth(provider)}
                  >
                    {PROVIDER_LABELS[provider]}
                  </Button>
                ))}
              </div>
            </>
          ) : null}

          {ADMIN_LOGIN ? (
            <>
              <div className="flex items-center gap-3 text-xs text-muted">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={onAdminLogin}>
                🛠️ Log in as admin
              </Button>
              <p className="text-sm text-muted">
                Signs you in with the seeded demo <strong className="text-fg">operator</strong>{" "}
                account, so you can explore the full admin surface — the moderation queue, member and
                report tools, the community dashboard, and settings — without provisioning your own.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
