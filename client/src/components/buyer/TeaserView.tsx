/**
 * TeaserView — what a buyer on a teaser link reads (/view/:token, spec §5.4).
 *
 * The summary on real paper pages (the deal's look, theme-locked), with the
 * brokerage's own brand only; a side card "Interested in {codename}?" with
 * [Ask for the CIM] (about 3 minutes), a quiet "Not for me", and the
 * broker's contact. Banners say where a request stands (asked · approved,
 * CIM not live yet · declined). Phones: one paper sheet at full width and a
 * sticky bottom bar [Ask for the CIM]; the side card's content moves below.
 *
 * Buyers see the word "summary" everywhere ("Confidential summary"). No
 * chatbot, no decision panel. Reading is measured on the summary itself
 * (the reading tracker, as in the CIM) and never mixed into CIM reading.
 */
import { useMemo, useState } from "react";
import { Building, CheckCircle2, Clock, Mail, Phone, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TeaserPageSize } from "@shared/teaser";
import type { BuyerSection } from "@shared/cim-buyer-view";
import type { ViewRoomReading } from "@shared/analytics-v2";
import { buildCimDesign, type CimDesignPayload } from "@/components/cim/CimDesignContext";
import { useCimReading } from "@/lib/cim-reading";
import { TeaserPages } from "@/components/teaser/TeaserPages";
import { TeaserRequestFlow } from "./TeaserRequestFlow";
import { TeaserPassSheet } from "./TeaserPassSheet";

export interface TeaserViewData {
  document: "teaser";
  access: {
    id: string;
    dealId: string;
    buyerEmail: string;
    buyerName: string | null;
    accessLevel: string;
    ndaSigned: boolean | null;
    watermarkEnabled: boolean | null;
    expiresAt: string | null;
  };
  deal: { id: string; businessName: string; industry: string | null };
  teaser: { header: { label: string; codename: string; tagline: string; chips: string[] }; blocks: BuyerSection[]; pageSize: TeaserPageSize };
  design: CimDesignPayload | null;
  branding: { companyName: string | null; logoUrl: string | null; disclaimer: string | null } | null;
  contact: { firm: string | null; name: string | null; email: string | null; phone: string | null };
  ndaRequired: boolean;
  emailCheck: { needed: boolean; maskedEmail: string | null; verified: boolean; method: string | null };
  cimRequest: { state: "none" | "requested" | "approved_waiting" | "declined" | "granted"; at: string | null };
  passed: { at: string; reasons: string[] } | null;
  reading?: ViewRoomReading;
}

function day(v: string | null): string {
  if (!v) return "";
  return new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The banner above the side card / the sheet for where the request stands. */
export function requestBanner(state: TeaserViewData["cimRequest"], firm: string): { tone: "info" | "ok" | "muted"; text: string } | null {
  switch (state.state) {
    case "requested": return { tone: "info", text: `You asked for the CIM on ${day(state.at)}. ${firm} will review your request and email you. The CIM will open on this same page.` };
    case "approved_waiting": return { tone: "ok", text: "Your request was approved. The CIM opens here as soon as it's ready." };
    case "granted": return { tone: "ok", text: "Your request was approved — reload this page to open the CIM." };
    case "declined": return { tone: "muted", text: `${firm} isn't sharing more on this opportunity right now. Thank you for your interest.` };
    default: return null;
  }
}

function Watermark({ email }: { email: string }) {
  return (
    <div className="cim-watermark pointer-events-none fixed inset-0 z-40 overflow-hidden opacity-[0.05]" aria-hidden>
      <div className="absolute inset-0 flex -rotate-45 flex-wrap items-center justify-center gap-24">
        {Array.from({ length: 24 }).map((_, i) => (
          <span key={i} className="select-none whitespace-nowrap text-xl font-bold" style={{ color: "#46423B" }}>{email}</span>
        ))}
      </div>
    </div>
  );
}

export function TeaserView({ token, data, onChanged }: { token: string; data: TeaserViewData; onChanged: () => void }) {
  const [flowOpen, setFlowOpen] = useState(false);
  const [passOpen, setPassOpen] = useState(false);
  const [passedNow, setPassedNow] = useState(false);
  const design = useMemo(() => buildCimDesign(data.design ?? null, "blind"), [data.design]);
  const firm = data.contact.firm?.trim() || data.branding?.companyName?.trim() || "the broker";
  const codename = data.teaser.header.codename || data.deal.businessName;
  const logo = design.brokerage.logoUrl || data.branding?.logoUrl || null;
  const banner = requestBanner(data.cimRequest, firm);
  const canAsk = data.cimRequest.state === "none";
  const passed = passedNow || !!data.passed;

  const tracker = useCimReading({
    token,
    accessId: data.access.id,
    reading: data.reading ?? null,
    enabled: data.teaser.blocks.length > 0 && !flowOpen,
  });

  const askButton = (className?: string) => (
    <Button className={`bg-teal text-teal-foreground hover:bg-teal/90 ${className ?? ""}`} onClick={() => setFlowOpen(true)} data-testid="button-ask-for-cim">
      Ask for the CIM
    </Button>
  );

  const card = (
    <div className="space-y-4" data-testid="teaser-side-card">
      {banner && (
        <div
          className={`flex gap-2 rounded-lg border px-3 py-2.5 text-sm ${banner.tone === "ok" ? "border-success/40 bg-success-muted/40" : banner.tone === "info" ? "border-teal/40 bg-teal/5" : "border-border bg-muted/30"}`}
          role="status"
          data-testid="teaser-request-banner"
        >
          {banner.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : banner.tone === "info" ? <Clock className="mt-0.5 h-4 w-4 shrink-0 text-teal" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
          <span>{banner.text}</span>
        </div>
      )}
      {canAsk && (
        <div className="space-y-3">
          <h2 className="text-base font-semibold">Interested in {codename}?</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Ask for the confidential information memorandum (CIM) — the full picture: financials, operations, people and the deal.
            You'll confirm your email, {data.ndaRequired ? "sign a short NDA online, " : "tell us a little about you, "}then {firm} reviews your request.
          </p>
          <div className="hidden items-center gap-3 lg:flex">
            {askButton()}
            <span className="text-xs text-muted-foreground">About 3 minutes.</span>
          </div>
        </div>
      )}
      {canAsk && (
        passed ? (
          <p className="text-xs text-muted-foreground" data-testid="teaser-passed">Thanks — {firm} will know this one isn't for you. You can still ask for the CIM.</p>
        ) : (
          <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setPassOpen(true)} data-testid="button-not-for-me">
            Not for me
          </button>
        )
      )}
      {(data.contact.name || data.contact.email || data.contact.phone) && (
        <div className="space-y-1 border-t border-border pt-3 text-xs">
          <p className="text-muted-foreground">Questions? {data.contact.name ? <span className="font-medium text-foreground">{data.contact.name}</span> : null}{data.contact.name ? "" : firm}</p>
          {data.contact.email && <a className="flex items-center gap-1.5 text-foreground/85 hover:text-teal" href={`mailto:${data.contact.email}`}><Mail className="h-3 w-3" /> {data.contact.email}</a>}
          {data.contact.phone && <a className="flex items-center gap-1.5 text-foreground/85 hover:text-teal" href={`tel:${data.contact.phone.replace(/[^\d+]/g, "")}`}><Phone className="h-3 w-3" /> {data.contact.phone}</a>}
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-background pb-24 lg:pb-0" data-testid="teaser-view">
      {data.access.watermarkEnabled && <Watermark email={data.access.buyerEmail} />}
      <header data-reading-chrome="" className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {logo ? (
              <img src={logo} alt={`${firm} logo`} className="h-8 w-auto max-w-[110px] shrink-0 rounded bg-white object-contain px-1" />
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-teal"><Building className="h-4 w-4 text-teal-foreground" /></div>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-tight">{codename}</h1>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Confidential summary</p>
            </div>
          </div>
          {canAsk && <div className="hidden sm:block">{askButton("h-9")}</div>}
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-0 py-6 sm:px-6 lg:py-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
          <main className="min-w-0 flex-1 px-3 sm:px-0">
            <TeaserPages
              header={data.teaser.header}
              sections={data.teaser.blocks}
              pageSize={data.teaser.pageSize}
              design={design}
              mode="buyer"
              readingHost={tracker}
            />
          </main>
          <aside className="px-4 sm:px-0 lg:sticky lg:top-24 lg:w-[320px] lg:shrink-0">
            <div className="lg:rounded-xl lg:border lg:border-border lg:bg-card lg:p-5">{card}</div>
          </aside>
        </div>
        <footer className="mt-10 space-y-1 px-4 text-center sm:px-0">
          <p className="text-xs text-muted-foreground/80">
            This summary doesn't name the business. Please don't contact the business, its staff, customers or suppliers — all questions go to {firm}.
          </p>
          <p className="text-xs text-muted-foreground/60" data-testid="teaser-reading-notice">{firm} can see that you opened this summary and how long you read it.</p>
        </footer>
      </div>

      {/* Phones: the request is always one tap away. */}
      {canAsk && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-4 pt-3 backdrop-blur lg:hidden" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          {askButton("h-11 w-full")}
        </div>
      )}

      {flowOpen && (
        <TeaserRequestFlow
          token={token}
          codename={codename}
          firm={firm}
          buyerEmail={data.access.buyerEmail}
          buyerName={data.access.buyerName}
          ndaRequired={data.ndaRequired}
          emailCheck={data.emailCheck}
          onClose={() => { setFlowOpen(false); onChanged(); }}
          onRequested={() => onChanged()}
        />
      )}
      <TeaserPassSheet token={token} firm={firm} open={passOpen} onOpenChange={setPassOpen} onSent={() => { setPassedNow(true); onChanged(); }} />
    </div>
  );
}

/** "This summary's link has expired." — the buyer can ask the broker for a fresh link (recorded once a day). */
export function ExpiredTeaserCard({ token, firm }: { token: string; firm: string | null }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const name = firm?.trim() || "your broker";
  const ask = async () => {
    setState("sending");
    try {
      const res = await fetch(`/api/view/${token}/fresh-link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      setState(res.ok || res.status === 429 ? "sent" : "error");
    } catch {
      setState("error");
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-sm space-y-3 text-center" data-testid="teaser-expired">
        <Clock className="mx-auto h-8 w-8 text-muted-foreground/60" />
        <h2 className="text-lg font-semibold">This summary's link has expired</h2>
        {state === "sent" ? (
          <p className="text-sm text-muted-foreground">Thanks — {name} will send you a new link if the opportunity is still available.</p>
        ) : (
          <>
            <Button className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={ask} disabled={state === "sending"} data-testid="button-ask-fresh-link">
              Ask {name} for a fresh link
            </Button>
            {state === "error" && <p className="text-xs text-destructive">Couldn't send that. Try again, or contact {name}.</p>}
          </>
        )}
      </div>
    </div>
  );
}

/** "This summary isn't available right now." (taken offline, or not published yet). */
export function TeaserNotAvailable() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-sm space-y-3 text-center" data-testid="teaser-not-available">
        <Clock className="mx-auto h-8 w-8 text-muted-foreground/60" />
        <h2 className="text-lg font-semibold">This summary isn't available right now</h2>
        <p className="text-sm text-muted-foreground">Your broker will let you know when it is.</p>
      </div>
    </div>
  );
}
