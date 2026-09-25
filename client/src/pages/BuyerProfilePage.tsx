/**
 * BuyerProfilePage — the full page for one buyer (/broker/buyers/:buyerId).
 *
 * Everything Cimple knows about the buyer, with where each value came from
 * (the buyer, their NDA answers, the broker's CRM, a CSV, the broker's own
 * edits). The broker can edit any field; edits live in the broker's private
 * overlay and never change the buyer's own profile. Right column: AI summary,
 * deals & engagement, activity, notes & tags, NDA answers, CRM record.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Mail, KeyRound, PencilLine, MoreHorizontal, Trash2, MapPin, AlertCircle, RefreshCw, Loader2, Wallet, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  BackgroundSection, CapacitySection, ContactSection, CriteriaSection, TargetsSection, type Draft, type DraftEntry,
} from "@/components/buyers/profile/ProfileSections";
import { AiSummaryCard, CrmRecordCard, DealsCard, NdaAnswersCard, NotesTagsCard, TimelineCard } from "@/components/buyers/profile/SidePanels";
import { EmailDialog, GrantAccessDialog, RemoveBuyerDialog } from "@/components/buyers/profile/ActionDialogs";
import {
  INTEREST_OPTIONS, SOURCE_META, buyerTypeLabel, relTime, requestJson, type BuyerProfileResponse, type InterestStatus,
} from "@/components/buyers/profile/types";

function initials(name: string) {
  const words = name.split(/\s+/).filter((w) => /^[A-Za-zÀ-ÿ]/.test(w));
  const picks = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return picks.map((p) => p[0]?.toUpperCase()).join("") || "?";
}

function currentValue(data: BuyerProfileResponse, key: string): unknown {
  return key.startsWith("criteria.") ? data.profile.buyerCriteria?.[key.slice(9)] : (data.profile as any)[key];
}

/** PATCH body for the overlay from the pending draft (null = revert to the buyer / CRM value). */
function draftToPatch(draft: Draft): Record<string, any> {
  const body: Record<string, any> = {};
  const crit: Record<string, any> = {};
  for (const [key, e] of Object.entries(draft)) {
    const value = e.action === "revert" ? null : e.value;
    if (key.startsWith("criteria.")) crit[key.slice(9)] = value === "" ? null : value;
    else if (key === "hasProofOfFunds") body[key] = value === undefined ? null : value;
    else if (key === "targetIndustries" || key === "targetLocations") body[key] = value === null ? (e.action === "revert" ? null : []) : value;
    else body[key] = typeof value === "string" ? value.trim() : value;
  }
  if (Object.keys(crit).length) body.buyerCriteria = crit;
  return body;
}

function InterestPicker({ buyerId, value }: { buyerId: string; value: InterestStatus | null }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const set = useMutation({
    mutationFn: (interestStatus: InterestStatus | null) => requestJson("PATCH", `/api/broker/buyers/${buyerId}/contact`, { interestStatus }),
    onMutate: async (interestStatus) => {
      const key = ["/api/broker/buyers", buyerId, "profile"];
      const prev = qc.getQueryData<BuyerProfileResponse>(key);
      if (prev) qc.setQueryData(key, { ...prev, contact: { ...prev.contact, interestStatus } });
      return { prev };
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["/api/broker/buyers", buyerId, "profile"], ctx.prev);
      toast({ title: "Couldn't update", description: e.message, variant: "destructive" });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["/api/broker/buyers"] }),
  });
  const current = INTEREST_OPTIONS.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${current ? current.chip : "border-dashed border-border text-muted-foreground hover:text-foreground"}`}
          data-testid="button-interest"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${current ? current.dot : "bg-muted-foreground/40"}`} />
          {current ? current.label : "Set interest"}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {INTEREST_OPTIONS.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => set.mutate(o.value)} data-testid={`interest-${o.value}`}>
            <span className={`mr-2 h-2 w-2 rounded-full ${o.dot}`} />{o.label}
            {o.value === value && <Check className="ml-auto h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
        {value && <><DropdownMenuSeparator /><DropdownMenuItem onClick={() => set.mutate(null)}>Clear</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PageSkeleton() {
  return (
    <div className="mx-auto max-w-[1280px] p-4 sm:p-6 lg:p-8 space-y-6">
      <Skeleton className="h-4 w-24" />
      <div className="flex items-center gap-4"><Skeleton className="h-14 w-14 rounded-full" /><div className="space-y-2"><Skeleton className="h-6 w-56" /><Skeleton className="h-4 w-72" /></div></div>
      <Skeleton className="h-20 w-full rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4"><Skeleton className="h-48 rounded-xl" /><Skeleton className="h-64 rounded-xl" /></div>
        <div className="space-y-4"><Skeleton className="h-32 rounded-xl" /><Skeleton className="h-48 rounded-xl" /></div>
      </div>
    </div>
  );
}

export default function BuyerProfilePage() {
  const { buyerId } = useParams<{ buyerId: string }>();
  const qc = useQueryClient();
  const { toast } = useToast();
  const queryKey = ["/api/broker/buyers", buyerId, "profile"];
  const { data, isLoading, error, refetch, isFetching } = useQuery<BuyerProfileResponse>({
    queryKey,
    queryFn: () => requestJson("GET", `/api/broker/buyers/${buyerId}/profile`),
    enabled: !!buyerId,
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [emailOpen, setEmailOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const changes = Object.keys(draft).length;

  useEffect(() => { setEditing(false); setDraft({}); }, [buyerId]);
  useEffect(() => {
    if (!changes) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [changes]);

  const setEntry = (key: string, entry: DraftEntry | undefined) => {
    setDraft((prev) => {
      const next = { ...prev };
      // Typing a field back to what's already there isn't a change.
      if (!entry || (entry.action === "set" && data && JSON.stringify(entry.value ?? null) === JSON.stringify(currentValue(data, key) ?? null))) delete next[key];
      else next[key] = entry;
      return next;
    });
  };

  const save = useMutation({
    mutationFn: () => {
      const body = draftToPatch(draft);
      if (body.name !== undefined && body.name !== null && !String(body.name).trim()) throw new Error("A buyer needs a name — use Revert to go back to theirs.");
      return requestJson<BuyerProfileResponse>("PATCH", `/api/broker/buyers/${buyerId}/profile`, body);
    },
    onSuccess: (view) => {
      qc.setQueryData(queryKey, view);
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers", buyerId, "timeline"] });
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers"], exact: true });
      setDraft({});
      setEditing(false);
      toast({ title: "Profile saved", description: "Your edits are private to you — the buyer's own profile is unchanged." });
    },
    onError: (e: Error) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const dealNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of data?.deals ?? []) m[d.dealId] = d.businessName;
    for (const n of data?.ndaAnswers ?? []) m[n.dealId] = n.businessName;
    return m;
  }, [data]);

  const sourceSummary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of Object.values(data?.sources ?? {})) counts[s.source] = (counts[s.source] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [data?.sources]);

  if (isLoading) return <PageSkeleton />;
  if (error || !data) {
    const notFound = error instanceof Error && /not found/i.test(error.message);
    return (
      <div className="mx-auto max-w-xl p-6 sm:p-10">
        <div className="rounded-xl border border-border p-8 text-center" role="alert">
          <AlertCircle className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">{notFound ? "This buyer isn't on your list" : "Couldn't load this buyer"}</p>
          <p className="mt-1 text-xs text-muted-foreground">{notFound ? "They may have been removed, or the link is from another account." : error instanceof Error ? error.message : "Try again in a moment."}</p>
          <div className="mt-5 flex justify-center gap-2">
            <Link href="/broker/buyers"><Button size="sm" variant="outline"><ArrowLeft className="h-3.5 w-3.5 mr-1.5" />All buyers</Button></Link>
            {!notFound && <Button size="sm" onClick={() => refetch()} disabled={isFetching}><RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />Retry</Button>}
          </div>
        </div>
      </div>
    );
  }

  const p = data.profile;
  const ctx = { data, editing, draft, setEntry, dealNames };
  const subline = [p.title && p.company ? `${p.title} · ${p.company}` : p.title || p.company, buyerTypeLabel(p.buyerType)].filter(Boolean);
  const lastActivity = data.deals.map((d) => d.lastAccessedAt).filter(Boolean).sort().pop() ?? null;
  const pct = data.buyer.profileCompletionPct;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-[1280px] px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
        {/* ── Header ───────────────────────────────────────────── */}
        <Link href="/broker/buyers" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="link-back-buyers">
          <ArrowLeft className="h-3.5 w-3.5" /> Buyers
        </Link>

        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3.5 sm:gap-4">
            <div className="flex h-12 w-12 sm:h-14 sm:w-14 shrink-0 items-center justify-center rounded-full border border-teal/40 bg-teal/10 font-mono text-base sm:text-lg font-medium text-teal">
              {initials(p.name)}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl sm:text-[1.6rem] font-semibold tracking-tight leading-tight text-foreground break-words" data-testid="text-buyer-name">{p.name}</h1>
                {/* A claim, not a check: neutral chip, never a "verified" shield. */}
                {p.hasProofOfFunds === true && (
                  <span
                    title="Proof of funds available, as stated by the buyer, their NDA answers, your CRM or you — no document has been reviewed in Cimple"
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                    data-testid="chip-proof-of-funds"
                  >
                    <Wallet className="h-3 w-3" /> Proof of funds
                  </span>
                )}
                <InterestPicker buyerId={data.buyer.id} value={data.contact.interestStatus} />
              </div>
              {subline.length > 0 && <p className="mt-1 text-sm text-muted-foreground">{subline.join(" · ")}</p>}
              {p.targetLocations.length > 0 && (
                <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><MapPin className="h-3 w-3 shrink-0" /><span className="truncate">Looking in {p.targetLocations.slice(0, 4).join(", ")}{p.targetLocations.length > 4 ? ` +${p.targetLocations.length - 4}` : ""}</span></p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <Button size="sm" variant="outline" onClick={() => setEmailOpen(true)} data-testid="button-email-buyer"><Mail className="h-3.5 w-3.5 mr-1.5" />Email</Button>
            <Button size="sm" variant="outline" className="hidden sm:inline-flex" onClick={() => setGrantOpen(true)} data-testid="button-grant-access"><KeyRound className="h-3.5 w-3.5 mr-1.5" />Give access</Button>
            {!editing && <Button size="sm" onClick={() => setEditing(true)} data-testid="button-edit-profile"><PencilLine className="h-3.5 w-3.5 mr-1.5" />Edit profile</Button>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-9 w-9 p-0" aria-label="More actions" data-testid="button-more"><MoreHorizontal className="h-4 w-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setGrantOpen(true)} className="sm:hidden"><KeyRound className="h-3.5 w-3.5 mr-2" />Give access to a deal</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setRemoveOpen(true)} className="text-destructive focus:text-destructive" data-testid="menu-remove-buyer">
                  <Trash2 className="h-3.5 w-3.5 mr-2" />Remove from my list
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* ── Meta strip ───────────────────────────────────────── */}
        <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/70 bg-border/70 md:grid-cols-4">
          <div className="bg-card p-3 sm:p-4">
            <p className="font-mono text-2xs uppercase tracking-[0.16em] text-muted-foreground">Profile</p>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="font-mono text-lg font-medium tabular-nums">{pct}%</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-teal" style={{ width: `${pct}%` }} /></div>
            </div>
          </div>
          <div className="bg-card p-3 sm:p-4">
            <p className="font-mono text-2xs uppercase tracking-[0.16em] text-muted-foreground">Deals</p>
            <p className="mt-1.5 font-mono text-lg font-medium tabular-nums">{data.deals.length}<span className="ml-1.5 text-xs font-sans font-normal text-muted-foreground">{data.deals.filter((d) => d.ndaSignedAt).length} NDA signed</span></p>
          </div>
          <div className="bg-card p-3 sm:p-4">
            <p className="font-mono text-2xs uppercase tracking-[0.16em] text-muted-foreground">Last seen</p>
            <p className="mt-1.5 text-sm">{lastActivity ? relTime(lastActivity) : <span className="text-muted-foreground">Not yet</span>}</p>
          </div>
          <div className="bg-card p-3 sm:p-4 min-w-0">
            <p className="font-mono text-2xs uppercase tracking-[0.16em] text-muted-foreground">Sources</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {sourceSummary.length ? sourceSummary.map(([s, n]) => (
                <span key={s} className={`inline-flex items-center rounded-full border px-1.5 py-px text-2xs font-medium leading-4 ${SOURCE_META[s]?.chip ?? ""}`} title={`${n} field${n === 1 ? "" : "s"}`}>
                  {s === "crm" && data.layers.crm?.provider && data.layers.crm.provider !== "pipedrive" ? data.layers.crm.provider : SOURCE_META[s]?.label ?? s}
                </span>
              )) : <span className="text-xs text-muted-foreground">Nothing yet</span>}
            </div>
          </div>
        </div>

        <div className="mt-5 lg:hidden"><AiSummaryCard buyerId={data.buyer.id} summary={data.contact.aiSummary} /></div>

        {/* ── Body ─────────────────────────────────────────────── */}
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-8">
          <div className="min-w-0 space-y-7">
            {editing && (
              <div className="sticky top-0 z-20 -mx-1 flex flex-col gap-2 rounded-xl border border-teal/40 bg-card/95 px-3 py-2.5 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between" data-testid="edit-bar">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Editing {p.name.split(" ")[0]}'s profile</p>
                  <p className="text-2xs text-muted-foreground">Private to you — the buyer's own profile isn't changed. {changes ? `${changes} unsaved change${changes === 1 ? "" : "s"}.` : ""}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="ghost" onClick={() => { setDraft({}); setEditing(false); }} disabled={save.isPending} data-testid="button-cancel-edit">Cancel</Button>
                  <Button size="sm" onClick={() => save.mutate()} disabled={!changes || save.isPending} data-testid="button-save-profile">
                    {save.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                    {changes ? `Save ${changes} change${changes === 1 ? "" : "s"}` : "Save"}
                  </Button>
                </div>
              </div>
            )}
            <ContactSection ctx={ctx} />
            <CapacitySection ctx={ctx} />
            <BackgroundSection ctx={ctx} />
            <TargetsSection ctx={ctx} />
            <CriteriaSection ctx={ctx} />
            <p className="text-2xs text-muted-foreground">
              Added {relTime(data.contact.addedAt)}{data.buyer.hasAccount ? ` · has a Cimple account${data.buyer.lastLoginAt ? `, last signed in ${relTime(data.buyer.lastLoginAt)}` : ""}` : " · no Cimple account yet"}.
              {" "}When sources disagree, your edits win, then what the buyer told us, then your CRM.
            </p>
          </div>

          <aside className="min-w-0 space-y-4">
            <div className="hidden lg:block"><AiSummaryCard buyerId={data.buyer.id} summary={data.contact.aiSummary} /></div>
            <DealsCard data={data} onGrant={() => setGrantOpen(true)} />
            <TimelineCard buyerId={data.buyer.id} />
            <NotesTagsCard buyerId={data.buyer.id} tags={data.contact.tags} notes={data.contact.notes} />
            <NdaAnswersCard answers={data.ndaAnswers} />
            <CrmRecordCard crm={data.layers.crm} />
          </aside>
        </div>
      </div>

      <EmailDialog open={emailOpen} onOpenChange={setEmailOpen} buyerId={data.buyer.id} buyerName={p.name} buyerEmail={data.buyer.email} />
      <GrantAccessDialog open={grantOpen} onOpenChange={setGrantOpen} buyerId={data.buyer.id} buyerName={p.name} buyerEmail={data.buyer.email} buyerCompany={p.company} existingDealIds={data.deals.filter((d) => d.status === "active").map((d) => d.dealId)} />
      <RemoveBuyerDialog open={removeOpen} onOpenChange={setRemoveOpen} buyerId={data.buyer.id} buyerName={p.name} />
    </div>
  );
}
