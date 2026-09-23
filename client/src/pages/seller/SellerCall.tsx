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
import { joinDailyCall, type CallHandle } from "@/lib/daily-call";
import { Button } from "@/components/ui/button";
import { Loader2, Video, ArrowLeft } from "lucide-react";

interface CallInfo {
  active: boolean;
  roomUrl?: string;
  token?: string;
  startedAt?: string;
  businessName?: string;
}

export default function SellerCall() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<CallHandle | null>(null);
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
    if (!data?.active || !data.roomUrl || !data.token || joined || !containerRef.current) return;
    let cancelled = false;
    joinDailyCall({
      container: containerRef.current,
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

  return (
    <div className="h-screen w-full bg-background flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <span className="text-sm font-semibold">{data?.businessName || "Business Overview"}</span>
        <span className="text-xs text-muted-foreground">· Video call with your broker</span>
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
            <div ref={containerRef} className={`h-full w-full ${data?.active ? "" : "hidden"}`} data-testid="seller-call-frame" />
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
