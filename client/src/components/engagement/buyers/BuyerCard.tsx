/**
 * One buyer on the call list: who they are, where they stand (status in
 * words), why (one line built from the evidence), where they read (the page
 * strip), what to say (up to three talking points, each with its evidence),
 * and what to do (See where they read · Their visits · Email · Mark
 * contacted · Summarise). The broker writes and sends every email.
 */
import { useState } from "react";
import {
  formatReadingTime,
  type BuyerEngagementCard,
  type PageRef,
  type PageStripCell,
} from "@shared/analytics-v2";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Check, ChevronDown, ChevronUp, FileSearch, History, Loader2, Mail, MessageSquare, PhoneCall, Sparkles, X,
} from "lucide-react";
import { PageStrip, StatusChip, agoText, buyerTypeWord, initials } from "./parts";
import type { EngagementNav } from "../types";

const VERDICT: Record<string, string> = { strong: "Strong fit", good: "Good fit", possible: "Possible fit", unlikely: "Unlikely fit" };

function fitText(card: BuyerEngagementCard): string | null {
  const f = card.fit;
  if (!f) return null;
  if (f.deepCheckVerdict) return `AI check: ${VERDICT[f.deepCheckVerdict] ?? f.deepCheckVerdict}`;
  if (f.criteriaMatched != null && f.criteriaTotal) return `${f.criteriaMatched} of ${f.criteriaTotal} criteria`;
  return null;
}

export interface BuyerCardProps {
  card: BuyerEngagementCard;
  titles: Map<string, string>;
  maxMs: number;
  nav: EngagementNav;
  first?: boolean;
  onEmail?: () => void;
  emailDisabledReason?: string | null;
  onContacted: () => void;
  contacting: boolean;
  onBrief: () => void;
  briefing: boolean;
  brief: { text: string; generatedAt: string } | null;
  onCloseBrief: () => void;
}

function PageLink({ refs, onOpen }: { refs: PageRef[]; onOpen: (r: PageRef) => void }) {
  if (refs.length === 0) return null;
  const r = refs[0];
  return (
    <button type="button" onClick={() => onOpen(r)} className="whitespace-nowrap text-teal hover:underline" data-testid="talking-point-page">
      See page {r.label}
    </button>
  );
}

export function BuyerCard(props: BuyerCardProps) {
  const { card, titles, maxMs, nav, first } = props;
  const [more, setMore] = useState(false);
  const type = buyerTypeWord(card.buyerType);
  const fit = fitText(card);
  const contactedRecently = !!card.contactedAt && Date.now() - Date.parse(card.contactedAt) < 48 * 3_600_000;
  const openPage = (r: { pageId: string; part: number }) => nav.openDocument({ accessId: card.accessId, pageId: r.pageId, part: r.part });
  const extraSignals = card.signals.filter((s) => !card.talkingPoints.some((t) => t.evidence === s.evidence));
  const unanswered = card.questions.filter((q) => !q.answered).length;

  return (
    <article
      className={cn(
        "rounded-xl border bg-card p-4 sm:p-5 transition-colors",
        first ? "border-teal/40 shadow-[0_0_0_1px_hsl(var(--teal)/0.08)]" : "border-border",
      )}
      data-testid={`buyer-card-${card.accessId}`}
    >
      {/* Who, and where they stand */}
      <div className="flex items-start gap-3">
        <div className="hidden sm:flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 font-mono text-xs text-muted-foreground">
          {initials(card.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[15px] font-semibold leading-tight text-foreground">{card.name}</h3>
            {card.company && <span className="text-sm text-muted-foreground">{card.company}</span>}
            <StatusChip status={card.status} label={card.statusLabel} />
            {contactedRecently && !/^Contacted/.test(card.statusLabel) && (
              <span className="inline-flex items-center gap-1 text-[11px] text-sky-400"><PhoneCall className="h-3 w-3" />Contacted {agoText(card.contactedAt)}</span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {[type, fit, card.mode === "blind" ? "Has the blind CIM" : card.accessLevel === "due_diligence" ? "Due diligence access" : "Named CIM"].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-medium tabular-nums text-foreground">{formatReadingTime(card.activeMs)}</p>
          <p className="text-2xs text-muted-foreground">{card.visits} visit{card.visits === 1 ? "" : "s"} · {agoText(card.lastSeenAt)}</p>
        </div>
      </div>

      {/* Why */}
      <p className="mt-3 text-sm leading-relaxed text-foreground/90" data-testid="buyer-why">{card.why}</p>

      {/* Where they read */}
      <div className="mt-3">
        <PageStrip cells={card.pageStrip} titles={titles} maxMs={maxMs} onOpen={(c: PageStripCell) => openPage(c)} />
      </div>

      {/* What to say */}
      {card.talkingPoints.length > 0 && (
        <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5">
          <p className="mb-1.5 flex items-center gap-1.5 font-mono text-2xs uppercase tracking-[0.14em] text-muted-foreground">
            <MessageSquare className="h-3 w-3" /> What to say
          </p>
          <ol className="space-y-2">
            {card.talkingPoints.map((t, i) => (
              <li key={`${t.signalId}-${i}`} className="flex gap-2.5 text-sm">
                <span className="mt-px font-mono text-xs text-teal tabular-nums">{i + 1}</span>
                <div className="min-w-0">
                  <p className="text-foreground">{t.text}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t.evidence} <PageLink refs={t.pageRefs} onOpen={openPage} />
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {extraSignals.length > 0 && (
            <>
              <button type="button" onClick={() => setMore((m) => !m)} className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                {more ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {more ? "Less" : `${extraSignals.length} more thing${extraSignals.length === 1 ? "" : "s"} we noticed`}
              </button>
              {more && (
                <ul className="mt-1.5 space-y-1 border-t border-border/60 pt-1.5">
                  {extraSignals.map((s, i) => (
                    <li key={`${s.id}-${i}`} className="text-xs text-muted-foreground">
                      {s.evidence} <PageLink refs={s.pageRefs} onOpen={openPage} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {/* The AI summary, when asked for */}
      {props.brief && (
        <div className="mt-3 rounded-lg border border-teal/30 bg-teal/[0.05] px-3 py-2.5" data-testid="buyer-brief">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-[0.14em] text-teal"><Sparkles className="h-3 w-3" /> Summary</p>
            <button type="button" onClick={props.onCloseBrief} className="text-muted-foreground hover:text-foreground" aria-label="Close summary"><X className="h-3.5 w-3.5" /></button>
          </div>
          <p className="text-sm leading-relaxed text-foreground/90">{props.brief.text}</p>
          <p className="mt-1 text-2xs text-muted-foreground">Written by AI from the reading above · check before you use it</p>
        </div>
      )}

      {/* Do */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => nav.openDocument({ accessId: card.accessId })} data-testid="button-see-where">
          <FileSearch className="h-3.5 w-3.5 mr-1.5" />See where they read
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => nav.openJourney(card.accessId)} data-testid="button-visits">
          <History className="h-3.5 w-3.5 mr-1.5" />Their visits
        </Button>
        <Button
          size="sm" variant="outline" className="h-8 text-xs"
          onClick={props.onEmail} disabled={!props.onEmail}
          title={props.emailDisabledReason ?? undefined}
          data-testid="button-email"
        >
          <Mail className="h-3.5 w-3.5 mr-1.5" />Email
        </Button>
        <Button
          size="sm" variant="outline"
          className={cn("h-8 text-xs", contactedRecently && "border-sky-500/30 text-sky-400")}
          onClick={props.onContacted} disabled={props.contacting}
          data-testid="button-contacted"
        >
          {props.contacting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : contactedRecently ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <PhoneCall className="h-3.5 w-3.5 mr-1.5" />}
          {contactedRecently ? "Contacted" : "Mark contacted"}
        </Button>
        <Button size="sm" variant="ghost" className="col-span-2 h-8 text-xs text-muted-foreground hover:text-teal sm:col-span-1 sm:ml-auto" onClick={props.onBrief} disabled={props.briefing} data-testid="button-brief">
          {props.briefing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
          Summarise for my call
        </Button>
      </div>
      {unanswered > 0 && (
        <p className="mt-2 text-2xs text-muted-foreground">{unanswered} unanswered question{unanswered === 1 ? "" : "s"} — answer in the Q&amp;A tab.</p>
      )}
    </article>
  );
}
