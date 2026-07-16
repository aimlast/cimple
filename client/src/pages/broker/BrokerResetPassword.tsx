/**
 * BrokerResetPassword — set a new password from an emailed reset link.
 *
 * Route: /broker/reset-password/:token — rendered OUTSIDE BrokerAuthGate
 * (the whole point is the broker can't log in). On success the server also
 * starts a session, so we land straight on the dashboard.
 */
import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export default function BrokerResetPassword() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const reset = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/broker-auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Reset failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/broker-auth/me"] });
      setLocation("/broker");
    },
    onError: (e: Error) => setError(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    reset.mutate();
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
        </div>

        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          <h1 className="text-lg font-semibold mb-1">Set a new password</h1>
          <p className="text-xs text-muted-foreground mb-4">
            Choose a new password for your broker account.
          </p>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label htmlFor="new-password" className="block text-xs font-medium text-muted-foreground mb-1.5">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                data-testid="input-new-password"
              />
            </div>
            <div>
              <label htmlFor="confirm-password" className="block text-xs font-medium text-muted-foreground mb-1.5">
                Confirm password
              </label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                data-testid="input-confirm-password"
              />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <button
              type="submit"
              disabled={reset.isPending || !password || !confirm}
              className="w-full h-9 rounded-md bg-teal text-teal-foreground text-sm font-medium hover:bg-teal/90 transition-colors disabled:opacity-50"
              data-testid="button-reset-password"
            >
              {reset.isPending ? "Saving..." : "Set password and sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
