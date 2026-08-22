/**
 * BuyerLogin — email + password sign-in for buyer accounts, plus the
 * "Forgot password?" flow (email → /api/buyer-auth/request-reset →
 * neutral "check your inbox" confirmation).
 *
 * Deep link: /buyer/login?mode=forgot opens the reset panel directly
 * (used by BuyerSignup when an invited account already exists).
 */
import { useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BuyerAuthCard, BuyerRequestResetForm, readErrorBody } from "./shared";

type Mode = "login" | "forgot";

export default function BuyerLogin() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(search).get("mode") === "forgot" ? "forgot" : "login",
  );

  const login = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/buyer-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new Error(body.error || "Sign in failed. Please try again.");
      }
      return res.json();
    },
    onSuccess: () => setLocation("/buyer/dashboard"),
    onError: (e: Error) =>
      toast({ title: "Sign in failed", description: e.message, variant: "destructive" }),
  });

  if (mode === "forgot") {
    return (
      <BuyerAuthCard>
        <div>
          <h1 className="text-xl font-semibold">Reset your password</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Enter the email on your Cimple account and we'll send you a link to
            choose a new password.
          </p>
        </div>
        <BuyerRequestResetForm
          initialEmail={email}
          onBack={() => setMode("login")}
        />
      </BuyerAuthCard>
    );
  }

  return (
    <BuyerAuthCard>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <form
        className="space-y-3"
        onSubmit={(e) => { e.preventDefault(); login.mutate(); }}
      >
        <div className="space-y-1">
          <Label htmlFor="email" className="text-xs">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            data-testid="input-buyer-email"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="password" className="text-xs">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="input-buyer-password"
          />
        </div>
        {login.error && (
          <div className="flex items-start gap-2 text-xs text-red-400" data-testid="text-login-error">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            {(login.error as Error).message}
          </div>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={login.isPending || !email.trim() || !password}
          data-testid="button-buyer-signin"
        >
          {login.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
          Sign in
        </Button>
        <button
          type="button"
          onClick={() => setMode("forgot")}
          className="w-full text-center text-xs text-muted-foreground hover:text-primary transition-colors"
          data-testid="button-forgot-password"
        >
          Forgot password?
        </button>
      </form>
      <div className="text-center text-xs text-muted-foreground pt-2 border-t border-border">
        Don't have an account?{" "}
        <Link href="/buyer/signup" className="text-primary hover:underline">Sign up</Link>
      </div>
    </BuyerAuthCard>
  );
}
