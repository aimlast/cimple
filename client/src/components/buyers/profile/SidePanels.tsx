/**
 * Right column of the buyer profile page: AI summary, deals & engagement,
 * activity timeline, notes & tags, NDA answers, CRM record.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sparkles, RefreshCw, Eye, Clock, MessageSquare, FileSignature, ArrowUpRight, ChevronDown,
  UserPlus, KeyRound, Ban, CalendarClock, ThumbsUp, ThumbsDown, Hourglass, Mail, Send, CheckCircle2,
  PencilLine, Database, LogIn, Timer, Layers, ShieldCheck, AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { TagEditor } from "./FieldEditors";
import { Eyebrow } from "./ProfileSections";
import {
  BUYER_CRITERIA_FIELDS, formatCriterion, fmtDuration, humanize, relTime, requestJson, shortDate,
  type BuyerProfileResponse, type DealRow, type TimelineEvent,
} from "./types";

const Card = ({ children, className = "", testId }: { children: ReactNode; className?: string; testId?: string }) => (
  <div className={`rounded-xl border border-border/70 bg-card p-4 ${className}`} data-testid={testId}>{children}</div>
);

// ── AI summary ───────────────────────────────────────────────────────────
export function AiSummaryCard({ buyerId, summary }: { buyerId: string; summary: BuyerProfileResponse["contact"]["aiSummary"] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const gen = useMutation({
    mutationFn: (force: boolean) => requestJson("POST", `/api/broker/buyers/${buyerId}/ai-summary`, { force }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/broker/buyers", buyerId, "profile"] }),
    onError: (e: Error) => toast({ title: "Couldn't write the summary", description: e.message, variant: "destructive" }),
  });
  return (
    <Card testId="card-ai-summary" className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-teal/60 to-transparent" />
      <Eyebrow right={summary && !gen.isPending ? (
        <button type="button" onClick={() => gen.mutate(true)} className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground" data-testid="button-refresh-summary">
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      ) : null}>
        <span className="inline-flex items-center gap-1.5"><Sparkles className="h-3 w-3" />AI summary</span>
      </Eyebrow>
      {gen.isPending ? (
        <div className="space-y-2" aria-live="polite">
          <Skeleton className="h-3.5 w-full" /><Skeleton className="h-3.5 w-11/12" /><Skeleton className="h-3.5 w-4/5" />
          <p className="pt-1 text-2xs text-muted-foreground">Reading their profile, NDA answers and activity…</p>
        </div>
      ) : summary ? (
        <>
          <p className="text-sm leading-relaxed text-foreground/90" data-testid="text-ai-summary">{summary.text}</p>
          <p className="mt-2 text-2xs text-muted-foreground">
            Written {relTime(summary.at)}
            {summary.stale && (
              <> · <button type="button" onClick={() => gen.mutate(true)} className="text-teal hover:underline">new activity since — refresh</button></>
            )}
          </p>
        </>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">A few sentences on who they are, what they want, how serious they look and how they've engaged with your listings.</p>
          <Button size="sm" variant="outline" onClick={() => gen.mutate(false)} data-testid="button-generate-summary">
            <Sparkles className="h-3.5 w-3.5 mr-1.5" /> Write summary
          </Button>
        </div>
      )}
    </Card>
  );
}

// ── Deals & engagement ───────────────────────────────────────────────────
const VERDICT: Record<string, { label: string; cls: string }> = {
  strong: { label: "Strong fit", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" },
  good: { label: "Good fit", cls: "border-teal/40 bg-teal/10 text-teal" },
  possible: { label: "Possible fit", cls: "border-amber-500/30 bg-amber-500/10 text-amber-400" },
  unlikely: { label: "Unlikely fit", cls: "border-border bg-muted/40 text-muted-foreground" },
};
const DECISION: Record<string, { label: string; cls: string }> = {
  interested: { label: "Interested", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" },
  not_interested: { label: "Not interested", cls: "border-border bg-muted/40 text-muted-foreground" },
  lapsed: { label: "Lapsed", cls: "border-border bg-muted/40 text-muted-foreground" },
};
const Pill = ({ children, cls }: { children: ReactNode; cls: string }) => (
  <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-2xs font-medium leading-4 whitespace-nowrap ${cls}`}>{children}</span>
);

function DealEngagementRow({ d }: { d: DealRow }) {
  const status = d.status === "active" ? null : d.status === "expired" ? "Link expired" : "Revoked";
  return (
    <div className="rounded-lg border border-border/60 p-3 hover:border-border transition-colors" data-testid={`deal-row-${d.dealId}`}>
      <div className="flex items-start justify-between gap-2">
        <Link href={`/deal/${d.dealId}/buyers`} className="group min-w-0">
          <span className="text-sm font-medium text-foreground group-hover:text-teal inline-flex items-center gap-1 min-w-0">
            <span className="truncate">{d.businessName}</span>
            <ArrowUpRight className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100" />
          </span>
        </Link>
        <div className="flex flex-wrap justify-end gap-1 shrink-0">
          {d.decision && DECISION[d.decision] && <Pill cls={DECISION[d.decision].cls}>{DECISION[d.decision].label}</Pill>}
          {status && <Pill cls="border-destructive/30 bg-destructive/10 text-destructive">{status}</Pill>}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground tabular-nums">
        <span>{d.accessLevel === "full" ? "Full CIM" : humanize(d.accessLevel)} access</span>
        <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" />{d.views} visit{d.views === 1 ? "" : "s"}</span>
        <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{fmtDuration(d.seconds)}</span>
        {d.questions > 0 && <span className="inline-flex items-center gap-1"><MessageSquare className="h-3 w-3" />{d.questions}</span>}
        {d.ndaSignedAt ? <span className="inline-flex items-center gap-1 text-foreground/70"><FileSignature className="h-3 w-3" />NDA {shortDate(d.ndaSignedAt)}</span> : <span>NDA not signed</span>}
      </div>
      {d.topSections.length > 0 && (
        <p className="mt-1.5 text-2xs text-muted-foreground truncate">Most time on: <span className="text-foreground/80">{d.topSections.map((s) => s.title).join(" · ")}</span></p>
      )}
      {d.deepCheck && (
        <Tooltip delayDuration={150}>
          <TooltipTrigger asChild>
            <div className="mt-2 flex items-start gap-2 rounded-md bg-muted/30 px-2 py-1.5 cursor-default">
              <Pill cls={VERDICT[d.deepCheck.verdict]?.cls ?? ""}>{VERDICT[d.deepCheck.verdict]?.label ?? d.deepCheck.verdict} · {d.deepCheck.fitScore}</Pill>
              <span className="text-2xs text-muted-foreground line-clamp-2">{d.deepCheck.whyFit}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-sm text-xs leading-relaxed">
            <p className="font-medium mb-1">AI deep check</p>
            <p>{d.deepCheck.whyFit}</p>
            {d.deepCheck.watchOuts?.length > 0 && <ul className="mt-1 list-disc pl-4 text-muted-foreground">{d.deepCheck.watchOuts.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function DealsCard({ data, onGrant }: { data: BuyerProfileResponse; onGrant: () => void }) {
  const totals = useMemo(() => ({
    views: data.deals.reduce((s, d) => s + d.views, 0),
    seconds: data.deals.reduce((s, d) => s + d.seconds, 0),
  }), [data.deals]);
  return (
    <Card testId="card-deals">
      <Eyebrow right={data.deals.length > 0 ? <span className="text-2xs text-muted-foreground tabular-nums">{totals.views} visit{totals.views === 1 ? "" : "s"} · {fmtDuration(totals.seconds)}</span> : null}>
        Deals &amp; engagement
      </Eyebrow>
      {data.deals.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">Not on any of your deals yet.</p>
          <Button size="sm" variant="outline" onClick={onGrant} data-testid="button-grant-empty"><KeyRound className="h-3.5 w-3.5 mr-1.5" />Give access to a deal</Button>
        </div>
      ) : (
        <div className="space-y-2">{data.deals.map((d) => <DealEngagementRow key={d.accessId} d={d} />)}</div>
      )}
      {data.approvals.length > 0 && (
        <div className="mt-3 border-t border-border/60 pt-3 space-y-1.5">
          <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Approval requests</p>
          {data.approvals.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-foreground/90">{a.businessName}</span>
              <span className="shrink-0 text-muted-foreground">{humanize(a.status)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Activity timeline ────────────────────────────────────────────────────
const KIND_ICON: Record<string, typeof Eye> = {
  added: UserPlus, account: LogIn, login: LogIn, crm_synced: Database, access_granted: KeyRound, access_extended: CalendarClock,
  access_level: Layers, access_revoked: Ban, link_expired: Timer, first_view: Eye, viewing: Eye, nda_signed: FileSignature,
  decision: CheckCircle2, question: MessageSquare, outreach: Send, email: Mail, approval: ShieldCheck, profile_edit: PencilLine,
};

export function TimelineCard({ buyerId }: { buyerId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error, refetch } = useQuery<{ events: TimelineEvent[] }>({
    queryKey: ["/api/broker/buyers", buyerId, "timeline"],
    queryFn: () => requestJson("GET", `/api/broker/buyers/${buyerId}/timeline`),
  });
  const events = data?.events ?? [];
  const shown = expanded ? events : events.slice(0, 8);
  return (
    <Card testId="card-timeline">
      <Eyebrow right={events.length ? <span className="text-2xs text-muted-foreground tabular-nums">{events.length}</span> : null}>Activity</Eyebrow>
      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
      ) : error ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><AlertCircle className="h-4 w-4 text-destructive" />Couldn't load the activity. <button className="text-teal hover:underline" onClick={() => refetch()}>Retry</button></div>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <>
          <ol className="relative">
            {shown.map((e, i) => {
              const Icon = e.kind === "decision" ? (e.tone === "positive" ? ThumbsUp : e.tone === "negative" ? ThumbsDown : Hourglass) : KIND_ICON[e.kind] ?? Eye;
              const tone = e.tone === "positive" ? "text-emerald-400 border-emerald-500/30" : e.tone === "negative" ? "text-muted-foreground border-border" : "text-teal border-teal/30";
              return (
                <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0" data-testid={`timeline-${e.kind}`}>
                  {i < shown.length - 1 && <span className="absolute left-[11px] top-6 bottom-0 w-px bg-border/70" />}
                  <span className={`relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-card ${tone}`}>
                    <Icon className="h-3 w-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm text-foreground leading-snug">{e.title}</p>
                      <time className="shrink-0 text-2xs text-muted-foreground tabular-nums" title={new Date(e.at).toLocaleString()}>{relTime(e.at)}</time>
                    </div>
                    {e.dealName && <p className="text-2xs text-muted-foreground truncate">{e.dealName}</p>}
                    {e.detail && <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed break-words">{e.detail}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
          {events.length > 8 && (
            <button type="button" className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setExpanded((x) => !x)} data-testid="button-timeline-more">
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
              {expanded ? "Show less" : `Show all ${events.length}`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}

// ── Notes & tags ─────────────────────────────────────────────────────────
export function NotesTagsCard({ buyerId, tags, notes }: { buyerId: string; tags: string[]; notes: string | null }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [t, setT] = useState<string[]>(tags);
  const [n, setN] = useState(notes ?? "");
  useEffect(() => { setT(tags); setN(notes ?? ""); }, [buyerId, tags.join("|"), notes]);
  const dirty = t.join("|") !== tags.join("|") || n !== (notes ?? "");
  const save = useMutation({
    mutationFn: () => requestJson("PATCH", `/api/broker/buyers/${buyerId}/contact`, { tags: t, notes: n.trim() ? n : null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers", buyerId, "profile"] });
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers"] });
      toast({ title: "Saved" });
    },
    onError: (e: Error) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });
  return (
    <Card testId="card-notes">
      <Eyebrow>Notes &amp; tags <span className="normal-case tracking-normal text-muted-foreground/70">· private</span></Eyebrow>
      <div className="space-y-2.5">
        <TagEditor values={t} onChange={setT} placeholder="Add a tag — e.g. repeat buyer, SBA" testId="edit-tags" />
        <Textarea value={n} onChange={(e) => setN(e.target.value)} rows={4} placeholder="What you know about this buyer that isn't anywhere else…" data-testid="edit-notes" />
        <div className="flex items-center justify-end gap-2">
          {dirty && <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => { setT(tags); setN(notes ?? ""); }}>Discard</button>}
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="button-save-notes">
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ── NDA answers ──────────────────────────────────────────────────────────
const NDA_LABELS: Array<[string, string]> = [
  ["buyerType", "Buyer type"], ["financialKind", "Investor kind"], ["company", "Company"], ["companyWebsite", "Website"],
  ["title", "Title"], ["background", "Background"], ["lookingFor", "Looking for"], ["priceMin", "Price from"], ["priceMax", "Price to"],
  ["funding", "Funding"], ["proofOfFunds", "Proof of funds"], ["timeline", "Timeline"], ["operateSelf", "Will run it"],
  ["fitReason", "How it would fit"], ["dealRole", "Platform / add-on"], ["checkSize", "Cheque size"], ["appealedTo", "What appealed"],
  ["bestTimeToContact", "Best time to reach"],
];
const NDA_VALUE: Record<string, Record<string, string>> = {
  buyerType: { individual: "Individual", strategic: "Company (strategic)", financial: "Investor (financial)" },
  funding: { cash: "Cash / own equity", bank_loan: "Bank or SBA / BDC loan", investors: "Investors or partners", fund: "Committed fund", combination: "A combination" },
  proofOfFunds: { yes: "Yes, available now", can_provide: "Can provide on request", no: "Not yet" },
  timeline: { "0_3": "Within 3 months", "3_6": "3–6 months", "6_12": "6–12 months", "12_plus": "More than a year" },
  operateSelf: { yes: "Yes, will run it", hire_manager: "Will hire a manager", no: "Passive / not decided" },
  dealRole: { platform: "Platform", add_on: "Add-on", either: "Either" },
};

export function NdaAnswersCard({ answers }: { answers: BuyerProfileResponse["ndaAnswers"] }) {
  const [open, setOpen] = useState<string | null>(answers[0]?.dealId ?? null);
  if (!answers.length) return null;
  return (
    <Card testId="card-nda-answers">
      <Eyebrow>NDA answers</Eyebrow>
      <div className="space-y-2">
        {answers.map((a) => {
          const isOpen = open === a.dealId;
          return (
            <div key={a.dealId} className="rounded-lg border border-border/60">
              <button type="button" className="flex w-full items-start justify-between gap-2 p-3 text-left" onClick={() => setOpen(isOpen ? null : a.dealId)}>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{a.businessName}</p>
                  <p className="text-2xs text-muted-foreground">Signed {shortDate(a.signedAt)}{a.summary ? ` · ${a.summary}` : ""}</p>
                </div>
                <ChevronDown className={`mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
              </button>
              {isOpen && (
                <dl className="grid grid-cols-1 gap-x-4 gap-y-2 border-t border-border/60 p-3 sm:grid-cols-2">
                  {NDA_LABELS.filter(([k]) => a.answers[k] != null && a.answers[k] !== "").map(([k, label]) => {
                    const raw = a.answers[k];
                    const val = k === "priceMin" || k === "priceMax" ? formatCriterion("askingPriceMax", raw) : NDA_VALUE[k]?.[raw] ?? (k === "financialKind" ? humanize(String(raw)) : String(raw));
                    const long = String(val).length > 60;
                    return (
                      <div key={k} className={long ? "sm:col-span-2" : ""}>
                        <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
                        <dd className="text-xs text-foreground/90 leading-relaxed whitespace-pre-line break-words">{val}</dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── CRM record ───────────────────────────────────────────────────────────
const TOP_LABEL: Record<string, string> = {
  buyerType: "Buyer type", background: "Summary", liquidFunds: "Liquid funds", hasProofOfFunds: "Proof of funds",
  targetIndustries: "Industries", targetLocations: "Locations",
};

export function CrmRecordCard({ crm }: { crm: BuyerProfileResponse["layers"]["crm"] }) {
  const [showAll, setShowAll] = useState(false);
  if (!crm) return null;
  const p = crm.profile;
  const provider = crm.provider === "pipedrive" ? "Pipedrive" : humanize(crm.provider);
  const rows: Array<{ label: string; value: string; quote: string | null; inferred: boolean }> = [];
  const ev = p.evidence ?? {};
  const inferred = new Set(p.inferred ?? []);
  const add = (key: string, label: string, value: string, quoteKey = key) => rows.push({ label, value, quote: ev[quoteKey] ?? null, inferred: inferred.has(key.replace(/^criteria\./, "")) || inferred.has(key) });
  if (p.buyerType) add("buyerType", TOP_LABEL.buyerType, humanize(p.buyerType));
  if (p.liquidFunds) add("liquidFunds", TOP_LABEL.liquidFunds, p.liquidFunds);
  if (typeof p.hasProofOfFunds === "boolean") add("hasProofOfFunds", TOP_LABEL.hasProofOfFunds, p.hasProofOfFunds ? "Yes" : "No");
  if (p.targetIndustries?.length) add("targetIndustries", TOP_LABEL.targetIndustries, p.targetIndustries.join(", "));
  if (p.targetLocations?.length) add("targetLocations", TOP_LABEL.targetLocations, p.targetLocations.join(", "));
  for (const [k, v] of Object.entries(p.buyerCriteria ?? {})) {
    if (!BUYER_CRITERIA_FIELDS[k]) continue;
    add(`criteria.${k}`, BUYER_CRITERIA_FIELDS[k].label, formatCriterion(k, v));
  }
  const shown = showAll ? rows : rows.slice(0, 6);
  return (
    <Card testId="card-crm" className="border-orange-500/20">
      <Eyebrow right={<span className="text-2xs text-muted-foreground">synced {relTime(crm.syncedAt)}</span>}>
        <span className="text-orange-400">From your {provider}</span>
      </Eyebrow>
      <p className="text-2xs text-muted-foreground -mt-1 mb-2.5">Private to you — never shown to the buyer.</p>
      {p.background && <p className="text-sm leading-relaxed text-foreground/90 mb-3">{p.background}</p>}
      {rows.length > 0 && (
        <div className="space-y-2">
          {shown.map((r) => (
            <div key={r.label} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-muted-foreground">{r.label}{r.inferred ? " · inferred" : ""}</span>
                <span className="text-right text-foreground/90">{r.value}</span>
              </div>
              {r.quote && <p className="mt-0.5 border-l-2 border-orange-500/30 pl-2 italic text-muted-foreground">“{r.quote}”</p>}
            </div>
          ))}
          {rows.length > 6 && (
            <button type="button" className="text-2xs text-muted-foreground hover:text-foreground" onClick={() => setShowAll((x) => !x)}>
              {showAll ? "Show less" : `Show all ${rows.length}`}
            </button>
          )}
        </div>
      )}
      {!!p.inquiries?.length && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5">Listings they asked about</p>
          <ul className="space-y-1">
            {p.inquiries.slice(0, 10).map((q, i) => (
              <li key={i} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate text-foreground/90">{q.title}</span>
                {q.stage && <span className="shrink-0 text-muted-foreground">{q.stage}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
