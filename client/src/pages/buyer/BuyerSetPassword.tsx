/**
 * BuyerSetPassword — consumed when a broker-invited buyer clicks the
 * set-password link in their email. One-time token → set password → auto
 * sign-in → dashboard.
 */
import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { BuyerAuthCard } from "./shared";

export default function BuyerSetPassword() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const { data, isLoading, error: loadError } = useQuery<{ email: string; name: string }>({
    queryKey: [`/api/buyer-auth/set-password/${token}`],
    queryFn: async () => {
      const res = await fetch(`/api/buyer-auth/set-password/${token}`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Invalid link");
      }
      return res.json();
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/buyer-auth/set-password/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed to set password");
      }
      return res.json();
    },
    onSuccess: () => setLocation("/buyer/dashboard"),
  });

  if (isLoading) {
    return (
      <BuyerAuthCard>
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </BuyerAuthCard>
    );
  }

  if (loadError) {
    return (
      <BuyerAuthCard>
        <div className="text-center space-y-2">
          <AlertCircle className="h-8 w-8 text-destructive mx-auto" />
          <div className="font-semibold">Link unavailable</div>
          <p className="text-xs text-muted-foreground">{(loadError as Error).message}</p>
        </div>
      </BuyerAuthCard>
    );
  }

  return (
    <BuyerAuthCard>
      <div>
        <h1 className="text-xl font-semibold">Welcome, {data?.name}</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Set a password for your Cimple account ({data?.email}). You'll use this to sign in from now on.
        </p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => { e.preventDefault(); submit.mutate(); }}
      >
        <div className="space-y-1">
          <Label htmlFor="pw" className="text-xs">Password</Label>
          <Input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </div>
        <div className="space-y-1">
          <Label htmlFor="confirm" className="text-xs">Confirm password</Label>
          <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {password && confirm && password !== confirm && (
          <div className="text-xs text-red-400">Passwords don't match</div>
        )}
        {submit.error && (
          <div className="flex items-start gap-2 text-xs text-red-400">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
            {(submit.error as Error).message}
          </div>
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={
            submit.isPending
            || password.length < 8
            || password !== confirm
          }
        >
          {submit.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
          )}
          Set password & sign in
        </Button>
      </form>
    </BuyerAuthCard>
  );
}
