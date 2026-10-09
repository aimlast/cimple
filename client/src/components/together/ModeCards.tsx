/**
 * The listening card for each way of running "Interview together"
 * (specs/together.md §4.4, §4.5), and the listening pill in the top bar.
 *
 *   In person            Start / Pause listening; basic listening note.
 *   Cimple call          the call (our own stage) + the seller's link.
 *   Zoom / Meet / Teams  paste the link → Send notetaker; joining; in the call.
 *
 * Every problem state says what happened and what to do, in plain words,
 * and turns the pill amber.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Copy, Loader2, Mail, Mic, Pause, Play, RefreshCw, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { CallStage } from "@/components/call/CallStage";
import type { LiveListening } from "@/hooks/useLiveListening";
import { VIA_LABEL, formatClock, listenCopy, listenIsActive, listenIsProblem, type ListenState, type TogetherVia } from "@shared/together";

/** "● Listening · 24:10" — brass and pulsing while listening, amber on a problem, grey when paused. */
export function ListeningPill({ state, startedAt, compact }: { state: ListenState; startedAt: number | null; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const problem = listenIsProblem(state);
  const active = listenIsActive(state);
  const timer = startedAt ? formatClock(now - startedAt) : null;
  const label = problem
    ? state === "silent" || state === "notetaker_silent" ? "Quiet" : state === "notetaker_waiting_room" ? "Waiting room" : "Not listening"
    : active ? "Listening" : state === "paused" || state === "call_left" ? "Paused" : state === "notetaker_joining" || state === "call_joining" || state === "starting" ? "Starting" : "Not listening";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-xs tabular-nums whitespace-nowrap ${
        problem ? "tg-warn-border tg-warn-bg tg-warn-text" : active ? "border-teal/50 bg-teal/10 text-foreground" : "border-border text-muted-foreground"
      }`}
      data-testid="listening-pill"
      data-state={state}
      aria-live="polite"
    >
      <span className={`h-2 w-2 rounded-full ${problem ? "tg-warn-dot" : active ? "bg-teal tg-pulse" : "bg-muted-foreground/50"}`} aria-hidden />
      {compact ? (timer && active ? timer : <span className="sr-only">{label}</span>) : <>{label}{timer && (active || state === "paused") ? ` · ${timer}` : ""}</>}
    </span>
  );
}

function Problem({ state, detail, action }: { state: ListenState; detail?: string | null; action?: React.ReactNode }) {
  return (
    <div className="rounded-md border tg-warn-border tg-warn-bg px-3 py-2.5 text-xs space-y-2" role="alert" data-testid={`listen-problem-${state}`}>
      <p className="flex items-start gap-2"><AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0 tg-warn-text" /><span>{state === "unavailable" && detail ? detail : listenCopy(state)}</span></p>
      {detail && state === "stopped" && <p className="text-[11px] text-muted-foreground pl-5">{detail}</p>}
      {action && <div className="pl-5">{action}</div>}
    </div>
  );
}

export function InPersonCard({ listening, ended }: { listening: LiveListening; ended?: boolean }) {
  const s = listening.state;
  const start = () => void listening.start();
  if (s === "mic_blocked" || s === "no_mic") return <Problem state={s} action={<Button size="sm" variant="outline" className="h-7 text-xs" onClick={start}>Try again</Button>} />;
  if (s === "stopped") return <Problem state={s} detail={listening.detail} action={<Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={start}><RefreshCw className="h-3 w-3" /> Resume listening</Button>} />;
  if (s === "unavailable") return <Problem state={s} detail={listening.detail} />;
  return (
    <div className="space-y-2.5" data-testid="mode-card-person">
      {s === "silent" && <Problem state={s} action={<Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={start}><Mic className="h-3 w-3" /> Check microphone</Button>} />}
      {s === "listening" || s === "silent" ? (
        <Button variant="outline" className="w-full gap-2" onClick={listening.pause} data-testid="button-pause-listening"><Pause className="h-4 w-4" /> Pause listening</Button>
      ) : (
        <Button className="w-full gap-2 bg-teal text-teal-foreground hover:bg-teal/90" onClick={start} disabled={ended || s === "starting"} data-testid="button-start-listening">
          {s === "starting" ? <Loader2 className="h-4 w-4 animate-spin" /> : s === "paused" ? <Play className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          {s === "paused" ? "Resume listening" : "Start listening"}
        </Button>
      )}
      {listening.basic && (s === "listening" || s === "silent") && (
        <p className="text-[11px] text-muted-foreground" data-testid="basic-listening-note">Basic listening can't tell voices apart, so Cimple suggests answers and you tick the right ones.</p>
      )}
    </div>
  );
}

interface SellerLinkInfo { link: string | null; sellerEmail?: string | null; sellerName?: string | null }

export function CimpleCallCard({ dealId, listening, ended }: { dealId: string; listening: LiveListening; ended?: boolean }) {
  const { toast } = useToast();
  const [info, setInfo] = useState<SellerLinkInfo | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"copy" | "send" | null>(null);
  useEffect(() => {
    fetch(`/api/interview/${dealId}/call/seller-link`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SellerLinkInfo | null) => { if (d) { setInfo(d); if (d.sellerEmail) setEmail(d.sellerEmail); } })
      .catch(() => {});
  }, [dealId]);
  const linkAction = async (send: boolean) => {
    setBusy(send ? "send" : "copy");
    try {
      const r = await fetch(`/api/interview/${dealId}/call/seller-link`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerEmail: email.trim(), sellerName: info?.sellerName ?? "", send }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Couldn't get the seller's link");
      setInfo((p) => ({ ...(p ?? {}), link: d.link }));
      if (send) toast(d.emailSent ? { title: "Link sent", description: `Emailed to ${email.trim()}.` } : { title: "Email didn't send", description: "Copy the link and send it yourself.", variant: "destructive" });
      else {
        const ok = await navigator.clipboard?.writeText(d.link).then(() => true).catch(() => false);
        toast({ title: ok ? "Seller's link copied" : "Seller's link ready", description: ok ? "Paste it into a text or email to the seller." : d.link });
      }
    } catch (e) {
      toast({ title: "Couldn't get the seller's link", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };
  const s = listening.state;
  const inCall = !!listening.callObject;
  return (
    <div className="space-y-2.5" data-testid="mode-card-cimple">
      {inCall ? (
        <div className="aspect-video w-full overflow-hidden rounded-md border border-border bg-black">
          <CallStage call={listening.callObject} selfLabel="You" otherLabel="Seller" waitingText="Waiting for the seller to join…" onLeave={() => void listening.leaveCall()} className="h-full w-full" />
        </div>
      ) : s === "unavailable" ? (
        <Problem state={s} detail={listening.detail} />
      ) : s === "stopped" ? (
        <Problem state={s} detail={listening.detail} action={<Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => void listening.start()}><RefreshCw className="h-3 w-3" /> Resume listening</Button>} />
      ) : s === "mic_blocked" || s === "no_mic" ? (
        <Problem state={s} action={<Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void listening.start()}>Try again</Button>} />
      ) : (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center space-y-2">
          <Video className="h-5 w-5 mx-auto text-muted-foreground" />
          <p className="text-xs text-muted-foreground">{s === "call_left" ? listenCopy("call_left") : "The call opens here, beside the checklist. The seller joins from their link."}</p>
          <Button size="sm" className="gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => void listening.start()} disabled={ended || s === "call_joining"} data-testid="button-start-call">
            {s === "call_joining" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Video className="h-3.5 w-3.5" />}
            {s === "call_left" ? "Rejoin the call" : "Start the call"}
          </Button>
        </div>
      )}
      {inCall && s === "call_waiting" && <p className="text-[11px] text-muted-foreground">{listenCopy("call_waiting")}</p>}
      {inCall && s === "stopped" && <Problem state={s} detail={listening.detail} action={<Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => void listening.start()}><RefreshCw className="h-3 w-3" /> Resume listening</Button>} />}
      {inCall && s === "silent" && <Problem state={s} />}
      <div className="space-y-1.5">
        <p className="text-[11px] text-muted-foreground">The seller's link</p>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1 flex-1" onClick={() => void linkAction(false)} disabled={busy !== null} data-testid="button-copy-seller-link">
            {busy === "copy" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />} Copy the seller's link
          </Button>
        </div>
        <div className="flex gap-1.5">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Seller's email" className="h-7 text-xs" aria-label="Seller's email" />
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1 shrink-0" onClick={() => void linkAction(true)} disabled={busy !== null || !email.trim()} data-testid="button-email-seller-link">
            {busy === "send" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mail className="h-3 w-3" />} Email it
          </Button>
        </div>
      </div>
    </div>
  );
}

export function NotetakerCard({ via, listening, initialLink, ended }: { via: TogetherVia; listening: LiveListening; initialLink?: string; ended?: boolean }) {
  const [link, setLink] = useState(initialLink ?? "");
  const s = listening.state;
  const platform = VIA_LABEL[via];
  const send = () => void listening.sendNotetaker(link);
  const sendAgain = <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={send} disabled={!link.trim()}><RefreshCw className="h-3 w-3" /> Send again</Button>;
  const notSent = s === "idle" || s === "consent";
  return (
    <div className="space-y-2.5" data-testid="mode-card-notetaker">
      <p className="text-xs text-muted-foreground">Cimple files the seller's answers as they talk.</p>
      {(notSent || s === "notetaker_failed" || s === "notetaker_ended" || s === "notetaker_removed" || s === "unavailable") && (
        <div className="flex gap-1.5">
          <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder={`Paste the ${platform} meeting link`} className="h-8 text-xs" aria-label="Meeting link" data-testid="input-notetaker-link" />
          {notSent && (
            <Button size="sm" className="h-8 shrink-0 bg-teal text-teal-foreground hover:bg-teal/90" onClick={send} disabled={ended || !link.trim()} data-testid="button-send-notetaker">Send notetaker</Button>
          )}
        </div>
      )}
      {s === "notetaker_joining" && <p className="text-xs flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin text-teal" />{listenCopy("notetaker_joining")}</p>}
      {s === "notetaker_live" && <p className="text-xs flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-teal tg-pulse" />In the call — transcribing.</p>}
      {s === "notetaker_waiting_room" && <div className="rounded-md border tg-warn-border tg-warn-bg px-3 py-2.5 text-xs" role="alert">{listenCopy("notetaker_waiting_room", platform)}</div>}
      {s === "notetaker_silent" && <Problem state={s} />}
      {s === "notetaker_removed" && <Problem state={s} action={sendAgain} />}
      {s === "notetaker_failed" && <Problem state={s} detail={listening.detail} action={sendAgain} />}
      {s === "notetaker_ended" && <p className="text-xs text-muted-foreground flex items-center gap-2">{listenCopy("notetaker_ended")} {sendAgain}</p>}
      {s === "unavailable" && <Problem state={s} detail={listening.detail} />}
      <p className="text-[11px] text-muted-foreground">It joins as “Cimple Notetaker”. Pop the checklist out to keep it over the call.</p>
    </div>
  );
}
