/**
 * SellerNdaPage — Standalone page for a seller to e-sign an NDA
 * sent by their broker via a unique token link.
 *
 * No login required — the token IS the auth. The seller opens the link,
 * reads the agreement, types their full legal name, and signs.
 * One page, one action, done.
 */
import { useState } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  CheckCircle2, Loader2, AlertCircle, Building, Lock, PenLine,
} from "lucide-react";

interface NdaData {
  businessName: string;
  brokerName: string | null;
  ndaText: string;
  ndaSigned: boolean;
  ndaSignedAt: string | null;
  signerName: string | null;
}

function formatSignedDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function SellerNdaPage() {
  const { token } = useParams<{ token: string }>();
  const [name, setName] = useState("");
  const [signError, setSignError] = useState<string | null>(null);
  // Set after a successful sign in this session — mirrors the server state
  // without needing a refetch.
  const [justSigned, setJustSigned] = useState<{ name: string; at: string } | null>(null);

  const { data, isLoading, error } = useQuery<NdaData>({
    queryKey: ["/api/sign-nda", token],
    enabled: !!token,
    queryFn: async () => {
      const res = await fetch(`/api/sign-nda/${token}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Invalid link");
      }
      return res.json();
    },
  });

  const sign = useMutation({
    mutationFn: async (signerName: string) => {
      const res = await fetch(`/api/sign-nda/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signerName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Could not sign the agreement. Please try again.");
      }
      return body;
    },
    onSuccess: (body, signerName) => {
      // If someone already signed, show the signer of record — not the name
      // this (second) person just typed.
      if (body?.alreadySigned) {
        setJustSigned({
          name: body.signerName || "another party",
          at: body.ndaSignedAt || new Date().toISOString(),
        });
      } else {
        setJustSigned({ name: signerName, at: new Date().toISOString() });
      }
    },
    onError: (err) => {
      setSignError(err instanceof Error ? err.message : "Could not sign the agreement.");
    },
  });

  // Loading
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Error / invalid token
  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-3">
          <AlertCircle className="h-8 w-8 mx-auto text-destructive/60" />
          <h2 className="text-lg font-semibold">Invalid signing link</h2>
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "This link is invalid or has expired."}
          </p>
        </div>
      </div>
    );
  }

  // Signed state — either already signed when the page loaded, or just now
  const signedName = justSigned?.name ?? (data.ndaSigned ? data.signerName : null);
  const signedAt = justSigned?.at ?? (data.ndaSigned ? data.ndaSignedAt : null);
  if (signedName || data.ndaSigned || justSigned) {
    const dateLabel = formatSignedDate(signedAt);
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-3">
          <CheckCircle2 className="h-10 w-10 mx-auto text-emerald-400" />
          <h2 className="text-lg font-semibold">Agreement signed</h2>
          <p className="text-sm text-muted-foreground">
            Signed by {signedName || "the seller"}
            {dateLabel ? ` on ${dateLabel}` : ""}. No further action is needed —
            your broker has been notified.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="max-w-lg w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="h-12 w-12 rounded-xl bg-teal/10 flex items-center justify-center mx-auto">
            <Lock className="h-6 w-6 text-teal" />
          </div>
          <h1 className="text-xl font-semibold">Confidentiality Agreement</h1>
          <p className="text-sm text-muted-foreground flex items-center justify-center gap-1.5">
            <Building className="h-3.5 w-3.5" />
            {data.businessName}
          </p>
        </div>

        {/* Agreement card */}
        <Card className="border-border">
          <CardContent className="pt-5 space-y-4">
            <p className="text-sm text-muted-foreground leading-relaxed">
              {data.brokerName
                ? `Your broker ${data.brokerName} has requested your signature on this confidentiality agreement.`
                : "Your broker has requested your signature on this confidentiality agreement."}{" "}
              Please read it carefully before signing.
            </p>

            <div className="max-h-72 overflow-y-auto rounded-lg bg-muted/30 border border-border p-4">
              <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">
                {data.ndaText}
              </p>
            </div>

            <div className="border-t border-border pt-4 space-y-2">
              <label
                htmlFor="signer-name"
                className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1"
              >
                <PenLine className="h-3 w-3" /> Type your full legal name to sign
              </label>
              <Input
                id="signer-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (signError) setSignError(null);
                }}
                placeholder="e.g. Jane A. Smith"
                autoComplete="name"
              />
            </div>

            {signError && (
              <p className="text-xs text-red-400 leading-relaxed" role="alert">
                {signError}
              </p>
            )}

            <Button
              className="w-full bg-teal text-white hover:bg-teal/90 gap-1.5"
              onClick={() => {
                setSignError(null);
                sign.mutate(name.trim());
              }}
              disabled={!name.trim() || sign.isPending}
            >
              {sign.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              {sign.isPending ? "Signing…" : "Sign Agreement"}
            </Button>

            <p className="text-[10px] text-muted-foreground text-center">
              By clicking Sign Agreement, you agree that typing your name above
              constitutes your legal electronic signature.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
