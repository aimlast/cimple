/**
 * Shared buyer-side UI primitives — auth card layout, buyer nav bar,
 * password-reset request form.
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, UserCircle, LogOut, Loader2, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

/**
 * Parse an error body defensively. Railway returns HTML during deploys
 * (502/504), so `res.json()` can throw — never surface a SyntaxError.
 */
export async function readErrorBody(res: Response): Promise<{ error?: string; code?: string }> {
  return res.json().catch(() => ({}));
}

export function BuyerAuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <div
            className="h-6 w-24 mx-auto"
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
          <div className="text-xs text-muted-foreground mt-1">
            Matched CIMs for private business acquirers
          </div>
        </div>
        <div className="border border-border rounded-lg bg-card p-6 space-y-4">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * BuyerRequestResetForm — email → POST /api/buyer-auth/request-reset →
 * neutral "check your inbox" confirmation. The server always answers
 * success (it never leaks which emails exist), so the confirmation copy
 * is deliberately hedged.
 *
 * Used by BuyerLogin ("Forgot password?") and by BuyerSetPassword when
 * an invite/reset link has expired.
 */
export function BuyerRequestResetForm({
  initialEmail = "",
  onBack,
  backLabel = "Back to sign in",
  submitLabel = "Email me a reset link",
}: {
  initialEmail?: string;
  onBack?: () => void;
  backLabel?: string;
  submitLabel?: string;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);

  const requestReset = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/buyer-auth/request-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new Error(body.error || "Could not request a reset link. Please try again.");
      }
      return res.json();
    },
    onSuccess: () => setSent(true),
    onError: (e: Error) =>
      toast({ title: "Couldn't send reset link", description: e.message, variant: "destructive" }),
  });

  if (sent) {
    return (
      <div className="space-y-3" data-testid="reset-sent">
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <MailCheck className="h-4 w-4 mt-0.5 text-primary shrink-0" />
          <p>
            If an account exists for{" "}
            <span className="text-foreground font-medium">{email.trim()}</span>, a
            link to set a new password is on its way. The link is valid for 7 days —
            check your inbox (and spam folder).
          </p>
        </div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="w-full text-center text-xs text-muted-foreground hover:text-primary transition-colors"
            data-testid="button-back-after-reset"
          >
            {backLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => { e.preventDefault(); if (email.trim()) requestReset.mutate(); }}
    >
      <div className="space-y-1">
        <Label htmlFor="reset-email" className="text-xs">Email for the reset link</Label>
        <Input
          id="reset-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoFocus
          data-testid="input-reset-email"
        />
      </div>
      {requestReset.error && (
        <p className="text-xs text-red-400" data-testid="text-reset-error">
          {(requestReset.error as Error).message}
        </p>
      )}
      <Button
        type="submit"
        variant="outline"
        className="w-full"
        disabled={requestReset.isPending || !email.trim()}
        data-testid="button-send-reset"
      >
        {requestReset.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
        {submitLabel}
      </Button>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="w-full text-center text-xs text-muted-foreground hover:text-primary transition-colors"
          data-testid="button-back-to-login"
        >
          {backLabel}
        </button>
      )}
    </form>
  );
}

export function BuyerNav() {
  const [location] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const finishLogout = () => {
    // Client-side logout is always safe: drop cached data and leave.
    qc.clear();
    window.location.href = "/buyer/login";
  };

  const logout = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/buyer-auth/logout", { method: "POST", credentials: "include" });
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new Error(body.error || "Sign out failed");
      }
      return res.json().catch(() => ({}));
    },
    onSuccess: finishLogout,
    onError: (e: Error) => {
      toast({
        title: "Couldn't reach the server",
        description: `${e.message}. You've been signed out on this device.`,
        variant: "destructive",
      });
      finishLogout();
    },
  });

  const NavLink = ({ href, icon: Icon, label }: { href: string; icon: any; label: string }) => {
    const active = location.startsWith(href);
    return (
      <Link href={href} className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm ${
          active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
        }`}>
        <Icon className="h-4 w-4" />
        {label}
      </Link>
    );
  };

  return (
    <nav className="border-b border-border bg-card">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/buyer/dashboard">
            <div
              className="h-4 w-16"
              style={{
                backgroundColor: "hsl(162, 65%, 38%)",
                WebkitMaskImage: "url('/cimple-text.png')",
                WebkitMaskSize: "contain",
                WebkitMaskRepeat: "no-repeat",
                maskImage: "url('/cimple-text.png')",
                maskSize: "contain",
                maskRepeat: "no-repeat",
              }}
            />
          </Link>
          <div className="flex items-center gap-1">
            <NavLink href="/buyer/dashboard" icon={LayoutDashboard} label="Dashboard" />
            <NavLink href="/buyer/profile" icon={UserCircle} label="Profile" />
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          data-testid="button-buyer-signout"
        >
          {logout.isPending ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <LogOut className="h-4 w-4 mr-1.5" />
          )}
          {logout.isPending ? "Signing out..." : "Sign out"}
        </Button>
      </div>
    </nav>
  );
}

export async function fetchBuyerMe() {
  const res = await fetch("/api/buyer-auth/me", { credentials: "include" });
  if (!res.ok) throw new Error("Not authenticated");
  return res.json();
}
