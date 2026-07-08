/**
 * BrokerLogin — full-screen sign-in for brokers.
 *
 * Rendered by BrokerAuthGate whenever no broker session exists (there is no
 * separate /broker/login route — the gate shows this in place, so deep links
 * survive login). Mirrors the buyer auth card styling.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export default function BrokerLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const login = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/broker-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Sign in failed");
      }
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
              backgroundColor: "hsl(162, 65%, 38%)",
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
          </form>
        </div>

        <p className="text-center text-[11px] text-muted-foreground mt-4">
          Broker accounts are created by your Cimple administrator.
        </p>
      </div>
    </div>
  );
}
