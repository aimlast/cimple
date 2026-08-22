/**
 * BuyerSignup — self-serve account creation for buyers who visit
 * cimple.app directly looking for CIMs to buy.
 *
 * If the email already belongs to a broker-invited account that hasn't
 * set a password yet, the server refuses (409 INVITED_ACCOUNT_EXISTS) —
 * only the emailed link can claim that account — so we point the buyer
 * at the reset flow to get a fresh link.
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BuyerAuthCard, readErrorBody } from "./shared";

class SignupError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export default function BuyerSignup() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signup = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/buyer-auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password }),
      });
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new SignupError(body.error || "Signup failed. Please try again.", body.code);
      }
      return res.json();
    },
    onSuccess: () => setLocation("/buyer/profile?welcome=1"),
    onError: (e: SignupError) =>
      toast({ title: "Couldn't create account", description: e.message, variant: "destructive" }),
  });

  const signupError = signup.error as SignupError | null;
  const invitedExists = signupError?.code === "INVITED_ACCOUNT_EXISTS";
  const accountExists = !invitedExists && signupError?.message?.toLowerCase().includes("already exists");

  return (
    <BuyerAuthCard>
      <div>
        <h1 className="text-xl font-semibold">Create a buyer account</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Get matched with confidential business-for-sale opportunities from brokers across North America.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => { e.preventDefault(); signup.mutate(); }}
      >
        <div className="space-y-1">
          <Label htmlFor="name" className="text-xs">Full name</Label>
          <Input
            id="name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            data-testid="input-signup-name"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="email" className="text-xs">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="input-signup-email"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="password" className="text-xs">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="input-signup-password"
          />
          <p className="text-[10px] text-muted-foreground">At least 8 characters.</p>
        </div>
        {signupError && (
          <div
            className="flex items-start gap-2 text-xs text-red-400"
            data-testid="text-signup-error"
          >
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p>{signupError.message}</p>
              {invitedExists && (
                <p className="text-muted-foreground">
                  <Link
                    href="/buyer/login?mode=forgot"
                    className="text-primary hover:underline"
                    data-testid="link-request-reset"
                  >
                    Email me a new link
                  </Link>
                  {" "}to set your password.
                </p>
              )}
              {accountExists && (
                <p className="text-muted-foreground">
                  <Link href="/buyer/login" className="text-primary hover:underline">Sign in</Link>
                  {" "}or{" "}
                  <Link href="/buyer/login?mode=forgot" className="text-primary hover:underline">
                    reset your password
                  </Link>.
                </p>
              )}
            </div>
          </div>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={signup.isPending || !name.trim() || !email.trim() || password.length < 8}
          data-testid="button-create-account"
        >
          {signup.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
          Create account
        </Button>
      </form>
      <div className="text-center text-xs text-muted-foreground pt-2 border-t border-border">
        Already have an account?{" "}
        <Link href="/buyer/login" className="text-primary hover:underline">Sign in</Link>
      </div>
    </BuyerAuthCard>
  );
}
