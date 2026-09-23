/**
 * TogetherSetupDialog — how will the broker run the interview with the seller?
 *
 * In Cimple's own video call (suggested — arrives with the video setup), on
 * the broker's Zoom / Google Meet / Teams call with a floating question
 * window, or in person on one laptop. Navigates to the together-interview
 * page with the choice in the URL.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Users, Video, MonitorSmartphone } from "lucide-react";

type Via = "cimple" | "zoom" | "meet" | "teams" | "person";

const OPTIONS: { via: Via; label: string; hint: string; soon?: boolean }[] = [
  { via: "cimple", label: "Video call in Cimple", hint: "One link for the seller; questions and progress beside the video. Who said what is exact." },
  { via: "zoom", label: "Zoom", hint: "Use your own call. Questions float in a small window over Zoom." },
  { via: "meet", label: "Google Meet", hint: "Use your own call. Questions float in a small window over Meet." },
  { via: "teams", label: "Microsoft Teams", hint: "Use your own call. Questions float in a small window over Teams." },
  { via: "person", label: "In person / phone", hint: "Same room or on speaker — one laptop, the mic captures the answers." },
];

export function TogetherSetupDialog({ dealId, open, onOpenChange }: { dealId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [, setLocation] = useLocation();
  const { data: services } = useQuery<{ deepgram: boolean; daily: boolean; recall: boolean }>({
    queryKey: ["/api/calls/status"],
    queryFn: async () => (await fetch("/api/calls/status", { credentials: "include" })).json(),
    staleTime: 60_000,
  });
  const dailyReady = !!services?.daily;
  const [via, setVia] = useState<Via>("zoom");
  const effectiveVia: Via = via === "cimple" && !dailyReady ? "zoom" : via;
  const [link, setLink] = useState("");
  const needsLink = effectiveVia === "zoom" || effectiveVia === "meet" || effectiveVia === "teams";

  const start = () => {
    const qs = new URLSearchParams({ via: effectiveVia });
    if (needsLink && link.trim()) qs.set("link", link.trim());
    onOpenChange(false);
    setLocation(`/deal/${dealId}/interview/together?${qs.toString()}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Users className="h-4 w-4 text-teal" /> Interview together</DialogTitle>
          <DialogDescription>
            You ask, the seller answers out loud, Cimple fills in the profile. Choose where the conversation happens.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5" role="radiogroup">
          {OPTIONS.map((o) => {
            const soon = o.via === "cimple" ? !dailyReady : !!o.soon;
            const selected = effectiveVia === o.via;
            return (
              <button
                key={o.via}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={soon}
                onClick={() => setVia(o.via)}
                className={`w-full text-left rounded-md border px-3 py-2.5 transition-colors ${
                  selected ? "border-teal/60 bg-teal/10" : "border-border hover:bg-accent"
                } ${soon ? "opacity-60 cursor-not-allowed" : ""}`}
                data-testid={`option-together-${o.via}`}
              >
                <div className="flex items-center gap-2">
                  {o.via === "cimple" ? <Video className="h-3.5 w-3.5 text-teal" /> : o.via === "person" ? <Users className="h-3.5 w-3.5 text-muted-foreground" /> : <MonitorSmartphone className="h-3.5 w-3.5 text-muted-foreground" />}
                  <span className="text-sm font-medium">{o.label}</span>
                  {soon && <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">Coming soon</span>}
                  {o.via === "cimple" && !soon && <span className="ml-auto text-[10px] uppercase tracking-wider text-teal">Suggested</span>}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 pl-5.5">{o.hint}</p>
              </button>
            );
          })}
        </div>
        {needsLink && (
          <div className="space-y-1">
            <Input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="Paste the meeting link (optional for now)"
              className="h-8 text-xs"
              data-testid="input-meeting-link"
            />
            <p className="text-[11px] text-muted-foreground">
              Automatic transcription from the call is coming; for now use the mic button in the floating window to capture answers, or type them.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={start} data-testid="button-together-start">
            Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
