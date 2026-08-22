/**
 * BrokerLogin — full-screen sign-in for brokers.
 *
 * Rendered in two places: by BrokerAuthGate in place of any broker page when
 * no session exists (so deep links survive login), and by the standalone
 * /broker/login route that Log out lands on. Mirrors the buyer auth card
 * styling.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface BrokerLoginProps {
  /**
   * Optional one-line notice shown above the form — used by /broker/login
   * when the session probe failed for a reason other than "not signed in".
   */
  notice?: string;
}

/** Pull the server's error body off a failed response, with a fallback. */
async function errorFromResponse(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => ({} as { error?: string }));
  return new Error(body?.error || `${fallback} (${res.status})`);
}

export default function BrokerLogin({ notice }: BrokerLoginProps = {}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // The reset flow gets its own field — it previously borrowed the login
  // form's username box, which read as "nowhere to enter your username".
  const [resetUsername, setResetUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"login" | "forgot" | "forgot-sent">("login");
  const queryClient = useQueryClient();
  const requestReset = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/broker-auth/request-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: resetUsername.trim() }),
        credentials: "include",
      });
      if (!res.ok) throw await errorFromResponse(res, "Could not request a reset");
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      setMode("forgot-sent");
    },
    onError: (e: Error) => setError(e.message),
  });

  const login = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/broker-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "include",
      });
      if (!res.ok) throw await errorFromResponse(res, "Sign in failed");
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      // The auth gate re-queries /me and swaps in the app
      queryClient.invalidateQueries({ queryKey: ["/api/broker-auth/me"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    login.mutate();
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <div
            role="img"
            aria-label="Cimple"
            className="h-6 w-24"
            style={{
              backgroundColor: "hsl(42, 26%, 92%)",
              WebkitMaskImage: "url('/cimple-text.png')",
              WebkitMaskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
              maskImage: "url('/cimple-text.png')",
              maskSize: "contain",
              maskRepeat: "no-repeat",
              maskPosition: "center",
            }}
          />
          <p className="text-xs text-muted-foreground mt-2">
            CIM workspace for business brokers
          </p>
        </div>

        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          <h1 className="text-lg font-semibold mb-4">Sign in</h1>
          {notice && (
            <p
              className="text-xs text-amber-500/90 bg-amber-500/5 border border-amber-500/20 rounded-md px-3 py-2 mb-4"
              role="status"
              data-testid="text-login-notice"
            >
              {notice}
            </p>
          )}
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label htmlFor="broker-username" className="block text-xs font-medium text-muted-foreground mb-1.5">
                Username
              </label>
              <input
                id="broker-username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                data-testid="input-broker-username"
              />
            </div>
            <div>
              <label htmlFor="broker-password" className="block text-xs font-medium text-muted-foreground mb-1.5">
                Password
              </label>
              <input
                id="broker-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                data-testid="input-broker-password"
              />
            </div>

            {error && (
              <p className="text-xs text-destructive" data-testid="text-login-error">{error}</p>
            )}

            <button
              type="submit"
              disabled={login.isPending || !username.trim() || !password}
              className="w-full h-9 rounded-md bg-teal text-teal-foreground text-sm font-medium hover:bg-teal/90 transition-colors disabled:opacity-50"
              data-testid="button-broker-signin"
            >
              {login.isPending ? "Signing in..." : "Sign in"}
            </button>

            {mode === "login" && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setResetUsername(username);
                  setMode("forgot");
                }}
                className="w-full text-center text-xs text-muted-foreground hover:text-teal transition-colors"
                data-testid="button-forgot-password"
              >
                Forgot password?
              </button>
            )}
          </form>

          {mode === "forgot" && (
            <div className="mt-4 pt-4 border-t border-border space-y-3">
              <div>
                <label
                  htmlFor="broker-reset-username"
                  className="block text-xs font-medium text-muted-foreground mb-1.5"
                >
                  Username for the reset link
                </label>
                <input
                  id="broker-reset-username"
                  type="text"
                  autoComplete="username"
                  value={resetUsername}
                  onChange={(e) => setResetUsername(e.target.value)}
                  placeholder="your-username"
                  className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                  data-testid="input-reset-username"
                />
              </div>
              <button
                onClick={() => requestReset.mutate()}
                disabled={requestReset.isPending || !resetUsername.trim()}
                className="w-full h-9 rounded-md border border-teal/40 text-teal text-sm font-medium hover:bg-teal/5 transition-colors disabled:opacity-50"
                data-testid="button-send-reset"
              >
                {requestReset.isPending ? "Sending..." : "Email me a reset link"}
              </button>
              <button
                type="button"
                onClick={() => { setError(null); setMode("login"); }}
                className="w-full text-center text-xs text-muted-foreground hover:text-teal transition-colors"
                data-testid="button-back-to-login"
              >
                Back to sign in
              </button>
            </div>
          )}

          {mode === "forgot-sent" && (
            <div className="mt-4 pt-4 border-t border-border space-y-3">
              <p className="text-xs text-muted-foreground">
                If an account exists for{" "}
                <span className="text-foreground font-medium">{resetUsername.trim()}</span>, a
                reset link is on its way. The link is valid for one hour — check
                the inbox for that account&apos;s email.
              </p>
              <button
                type="button"
                onClick={() => { setError(null); setMode("login"); }}
                className="w-full text-center text-xs text-muted-foreground hover:text-teal transition-colors"
                data-testid="button-back-to-login-sent"
              >
                Back to sign in
              </button>
            </div>
          )}

        </div>

        <p className="text-center text-[11px] text-muted-foreground mt-4">
          Broker accounts are created by your Cimple administrator.
        </p>
      </div>
    </div>
  );
}
