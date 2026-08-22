/**
 * BuyerSetPassword — consumed when a broker-invited buyer clicks the
 * set-password link in their email, or when any buyer follows a
 * password-reset link. One-time token → set password → auto sign-in →
 * dashboard.
 *
 * If the link is invalid or expired, the buyer can request a fresh one
 * right here (email → /api/buyer-auth/request-reset) or go sign in.
 */
import { useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BuyerAuthCard, BuyerRequestResetForm, readErrorBody } from "./shared";

export default function BuyerSetPassword() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [requestingNew, setRequestingNew] = useState(false);

  const { data, isLoading, error: loadError, refetch, isFetching } = useQuery<{ email: string; name: string }>({
    queryKey: [`/api/buyer-auth/set-password/${token}`],
    queryFn: async () => {
      const res = await fetch(`/api/buyer-auth/set-password/${token}`);
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new Error(body.error || "Invalid or expired link");
      }
      return res.json();
    },
    // 404/410 are final answers — retrying only prolongs the spinner.
    retry: false,
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
        const body = await readErrorBody(res);
        throw new Error(body.error || "Failed to set password. Please try again.");
      }
      return res.json();
    },
    onSuccess: () => setLocation("/buyer/dashboard"),
    onError: (e: Error) =>
      toast({ title: "Couldn't set password", description: e.message, variant: "destructive" }),
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
          <p className="text-xs text-muted-foreground" data-testid="text-link-error">
            {(loadError as Error).message}
          </p>
        </div>

        {requestingNew ? (
          <div className="pt-2 border-t border-border">
            <BuyerRequestResetForm
              onBack={() => setRequestingNew(false)}
              backLabel="Cancel"
              submitLabel="Send me a new link"
            />
          </div>
        ) : (
          <div className="space-y-2 pt-2 border-t border-border">
            <Button
              type="button"
              className="w-full"
              onClick={() => setRequestingNew(true)}
              data-testid="button-request-new-link"
            >
              Request a new link
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-retry-link"
            >
              {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Try again
            </Button>
          </div>
        )}

        <div className="text-center text-xs text-muted-foreground">
          Already have a password?{" "}
          <Link href="/buyer/login" className="text-primary hover:underline" data-testid="link-sign-in">
            Sign in instead
          </Link>
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
          <Input
            id="pw"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            data-testid="input-new-password"
          />
          <p className="text-[10px] text-muted-foreground">At least 8 characters.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="confirm" className="text-xs">Confirm password</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            data-testid="input-confirm-password"
          />
        </div>
        {password && confirm && password !== confirm && (
          <div className="text-xs text-red-400">Passwords don't match</div>
        )}
        {submit.error && (
          <div className="flex items-start gap-2 text-xs text-red-400" data-testid="text-set-password-error">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
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
          data-testid="button-set-password"
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
