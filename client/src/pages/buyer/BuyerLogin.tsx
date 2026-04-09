/**
 * BuyerLogin — email + password sign-in for buyer accounts.
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertCircle } from "lucide-react";
import { BuyerAuthCard } from "./shared";

export default function BuyerLogin() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/buyer-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Login failed");
      }
      return res.json();
    },
    onSuccess: () => setLocation("/buyer/dashboard"),
  });

  return (
    <BuyerAuthCard>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <form
        className="space-y-3"
        onSubmit={(e) => { e.preventDefault(); login.mutate(); }}
      >
        <div className="space-y-1">
          <Label htmlFor="email" className="text-xs">Email</Label>
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div className="space-y-1">
          <Label htmlFor="password" className="text-xs">Password</Label>
          <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {login.error && (
          <div className="flex items-start gap-2 text-xs text-red-400">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
            {(login.error as Error).message}
          </div>
        )}
        <Button type="submit" className="w-full" disabled={login.isPending || !email || !password}>
          {login.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
          Sign in
        </Button>
      </form>
      <div className="text-center text-xs text-muted-foreground pt-2 border-t border-border">
        Don't have an account?{" "}
        <Link href="/buyer/signup"><a className="text-primary hover:underline">Sign up</a></Link>
      </div>
    </BuyerAuthCard>
  );
}
