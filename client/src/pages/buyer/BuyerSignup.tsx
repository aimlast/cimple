/**
 * BuyerSignup — self-serve account creation for buyers who visit
 * cimple.app directly looking for CIMs to buy.
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertCircle } from "lucide-react";
import { BuyerAuthCard } from "./shared";

export default function BuyerSignup() {
  const [, setLocation] = useLocation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signup = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/buyer-auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Signup failed");
      }
      return res.json();
    },
    onSuccess: () => setLocation("/buyer/profile?welcome=1"),
  });

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
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="space-y-1">
          <Label htmlFor="email" className="text-xs">Email</Label>
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="password" className="text-xs">Password</Label>
          <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="text-[10px] text-muted-foreground">At least 8 characters.</p>
        </div>
        {signup.error && (
          <div className="flex items-start gap-2 text-xs text-red-400">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
            {(signup.error as Error).message}
          </div>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={signup.isPending || !name || !email || password.length < 8}
        >
          {signup.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
          Create account
        </Button>
      </form>
      <div className="text-center text-xs text-muted-foreground pt-2 border-t border-border">
        Already have an account?{" "}
        <Link href="/buyer/login"><a className="text-primary hover:underline">Sign in</a></Link>
      </div>
    </BuyerAuthCard>
  );
}
