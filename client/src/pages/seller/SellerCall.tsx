/**
 * SellerCall — the seller's side of an "Interview together" video call.
 *
 * Nothing to learn: if the broker has a call open for this deal, the seller
 * lands straight in it; otherwise a waiting card polls until the broker
 * starts. Route: /seller/:token/call (fullscreen).
 */
import { useEffect, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { createDailyCall, joinDailyCall, type CallHandle } from "@/lib/daily-call";
import { CallStage } from "@/components/call/CallStage";
import type { DailyCall } from "@daily-co/daily-js";
import { Button } from "@/components/ui/button";
import { Loader2, Video, ArrowLeft } from "lucide-react";

interface CallInfo {
  active: boolean;
  roomUrl?: string;
  token?: string;
  startedAt?: string;
  businessName?: string;
  /** The broker confirmed you know Cimple is taking notes of this call. */
  notetaking?: boolean;
}

export default function SellerCall() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const handleRef = useRef<CallHandle | null>(null);
  const [callObject, setCallObject] = useState<DailyCall | null>(null);
  const [joined, setJoined] = useState(false);
  const [left, setLeft] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<CallInfo>({
    queryKey: ["/api/seller", token, "call"],
    enabled: !!token && !joined && !left,
    queryFn: async () => {
      const r = await fetch(`/api/seller/${token}/call`);
      if (!r.ok) throw new Error("Couldn't check the call");
      return r.json();
    },
    refetchInterval: (q) => (q.state.data?.active ? false : 5000),
  });

  useEffect(() => {
    if (!data?.active || !data.roomUrl || !data.token || joined || handleRef.current) return;
    let cancelled = false;
    const call = createDailyCall();
    setCallObject(call);
    joinDailyCall(call, {
      roomUrl: data.roomUrl,
      token: data.token,
      onLeft: () => { setLeft(true); },
      onError: (m) => setError(m),
    })
      .then((h) => { if (cancelled) void h.leave(); else { handleRef.current = h; setJoined(true); } })
      .catch((e) => setError(e?.message || "Couldn't join the call"));
    return () => { cancelled = true; };
  }, [data, joined]);

  useEffect(() => () => { void handleRef.current?.leave(); }, []);

  // While in the call: is Cimple taking notes? (Checked every 15 s — the broker may start it after you joined.)
  const { data: status } = useQuery<{ active: boolean; notetaking?: boolean }>({
    queryKey: ["/api/seller", token, "call", "status"],
    enabled: !!token && joined && !left,
    queryFn: async () => {
      const r = await fetch(`/api/seller/${token}/call?status=1`);
      if (!r.ok) throw new Error("Couldn't check the call");
      return r.json();
    },
    refetchInterval: 15_000,
  });
  const notetaking = joined ? !!status?.notetaking || (!!data?.notetaking && status === undefined) : !!data?.notetaking;

  return (
    <div className="h-screen w-full bg-background flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <span className="text-sm font-semibold">{data?.businessName || "Business Overview"}</span>
        <span className="text-xs text-muted-foreground">· Video call with your broker</span>
        {notetaking && !left && (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-teal/40 bg-teal/10 px-2.5 py-0.5 text-[11px] text-foreground" data-testid="badge-taking-notes" title="Only the words are kept, as text — no audio.">
            <span className="h-1.5 w-1.5 rounded-full bg-teal" aria-hidden /> Cimple is taking notes
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 p-3">
        {left ? (
          <div className="h-full flex items-center justify-center">
            <div className="max-w-sm text-center space-y-3">
              <p className="text-sm font-medium">You've left the call</p>
              <p className="text-xs text-muted-foreground">Everything you said has been captured. Your broker will follow up if anything else is needed.</p>
              <Button size="sm" variant="outline" onClick={() => setLocation(`/seller/${token}/progress`)}>
                <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back to your progress
              </Button>
            </div>
          </div>
        ) : (
          <>
            {data?.active && (
              <CallStage
                call={callObject}
                selfLabel="You"
                otherLabel="Your broker"
                waitingText="Waiting for your broker…"
                onLeave={() => { const h = handleRef.current; handleRef.current = null; setCallObject(null); setLeft(true); void h?.leave(); }}
                className="h-full w-full"
              />
            )}
            {!data?.active && (
              <div className="h-full flex items-center justify-center">
                <div className="max-w-sm text-center space-y-3">
                  {isLoading ? (
                    <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                  ) : (
                    <Video className="h-6 w-6 mx-auto text-muted-foreground/60" />
                  )}
                  <p className="text-sm font-medium">Waiting for your broker to start the call</p>
                  <p className="text-xs text-muted-foreground">Keep this page open — you'll join automatically the moment it starts.</p>
                </div>
              </div>
            )}
            {error && <p className="mt-2 text-xs text-red-400 text-center">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
