/**
 * InterviewOutlineCard — what the AI interview will cover for this deal, and
 * a plain-language way to change it.
 *
 * Shows the standard CIM sections with their buyer-importance labels (and
 * any broker notes / removals) plus the broker's custom topics. The broker
 * types what they want changed; Cimple proposes concrete changes; the broker
 * reviews and applies. Direct remove/restore controls exist for the simple
 * cases, but nothing here is a section-by-section form.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { ListChecks, Loader2, Plus, RotateCcw, Sparkles, X, ChevronDown, ChevronRight, AlertCircle, CheckCircle2, Circle } from "lucide-react";
import type { InterviewOutline, OutlineCustomTopic, SectionImportanceLevel } from "@shared/schema";

interface OutlineItem {
  key: string;
  label: string;
  onFile: boolean;
  value: string | null;
  /** Answered in a source or an earlier session (not yet a recorded fact): where. */
  onFileIn?: string | null;
  industrySpecific: boolean;
  critical: boolean;
  addedByBroker: boolean;
}

interface OutlineSection {
  key: string;
  title: string;
  order: number;
  importance: SectionImportanceLevel;
  importanceReason: string;
  excluded: boolean;
  note: string | null;
  items: OutlineItem[];
  removedItems: { key: string; label: string }[];
}

interface OutlineView {
  outline: InterviewOutline;
  plan: {
    status: "ready" | "building" | "unavailable" | "no_industry";
    industry: string | null;
    itemCount: number;
    /** The checklist changed without a broker edit (new checklist rules). */
    revision?: { at: string; reason: "rules"; previousItemCount: number; removed: string[]; added: string[] } | null;
  };
  sections: OutlineSection[];
}

/** Every CIM needs these — the server refuses to remove them too. */
const UNREMOVABLE = new Set(["askingPrice", "annualRevenue"]);

interface Proposal {
  summary: string;
  addTopics: OutlineCustomTopic[];
  removeTopics: string[];
  addItems: { sectionKey: string; label: string; key?: string }[];
  removeItems: string[];
  restoreItems: string[];
  excludeSections: string[];
  restoreSections: string[];
  emphasis: { key: string; note: string }[];
  clearEmphasis: string[];
  refused: { request: string; why: string }[];
}

const LEVEL_LABEL: Record<SectionImportanceLevel, string> = { critical: "Critical", important: "Important", helpful: "Helpful" };
const LEVEL_CLASS: Record<SectionImportanceLevel, string> = {
  critical: "text-teal",
  important: "text-muted-foreground/80",
  helpful: "text-muted-foreground/50",
};

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === "string" && body.error) || fallback;
}

export function InterviewOutlineCard({ dealId, interviewStarted }: { dealId: string; interviewStarted: boolean }) {
  const { toast } = useToast();
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState<{ instruction: string; proposal: Proposal } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const toggleSection = (k: string) => setOpenSections((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const key = ["/api/deals", dealId, "interview-outline"];
  const { data, isLoading } = useQuery<OutlineView>({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/interview-outline`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r, "Failed to load the interview outline"));
      return r.json();
    },
    // The industry checklist builds in the background (~30s) — poll until ready.
    refetchInterval: (q) => (q.state.data?.plan.status === "building" ? 5000 : false),
  });
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-readiness"] });
  };

  const propose = useMutation({
    mutationFn: async (text: string) => {
      const r = await fetch(`/api/deals/${dealId}/interview-outline/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: text }),
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r, "Couldn't work out the change"));
      return r.json() as Promise<{ instruction: string; proposal: Proposal }>;
    },
    onSuccess: (res) => setPending(res),
    onError: (e: Error) => toast({ title: "Couldn't work out the change", description: e.message, variant: "destructive" }),
  });

  const apply = useMutation({
    mutationFn: async (p: { instruction: string; proposal: Proposal }) => {
      const r = await fetch(`/api/deals/${dealId}/interview-outline/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r, "Couldn't apply the change"));
      return r.json();
    },
    onSuccess: () => {
      setPending(null);
      setInstruction("");
      invalidate();
      toast({ title: "Interview outline updated", description: interviewStarted ? "The interviewer picks this up from the next question." : undefined });
    },
    onError: (e: Error) => toast({ title: "Couldn't apply the change", description: e.message, variant: "destructive" }),
  });

  const patch = useMutation({
    mutationFn: async (body: Record<string, string>) => {
      const r = await fetch(`/api/deals/${dealId}/interview-outline`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r, "Couldn't update the outline"));
      return r.json();
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast({ title: "Not changed", description: e.message, variant: "destructive" }),
  });

  if (isLoading || !data) {
    return (
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading interview outline…</div>
      </div>
    );
  }

  const { outline, sections, plan } = data;
  const active = sections.filter((s) => !s.excluded);
  const allItems = active.flatMap((s) => s.items);
  const onFileCount = allItems.filter((i) => i.onFile).length;
  const industryCount = allItems.filter((i) => i.industrySpecific && !i.addedByBroker).length;
  const excluded = sections.filter((s) => s.excluded);
  const changed = outline.customTopics.length > 0 || excluded.length > 0 || outline.emphasis.length > 0
    || (outline.addedItems?.length ?? 0) > 0 || (outline.removedItems?.length ?? 0) > 0;
  const titleOf = (k: string) => sections.find((s) => s.key === k)?.title ?? outline.customTopics.find((t) => t.key === k)?.title ?? k;
  const itemLabel = (k: string) =>
    sections.flatMap((s) => [...s.items, ...s.removedItems]).find((i) => i.key === k)?.label ?? k;

  return (
    <div className="rounded-lg border border-border bg-card p-5" data-testid="interview-outline-card">
      <div className="flex items-start gap-3">
        <ListChecks className="h-[1.125rem] w-[1.125rem] text-muted-foreground/40 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Interview outline</p>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              onClick={() => setExpanded((v) => !v)}
              data-testid="button-toggle-outline"
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {allItems.length} data points · {onFileCount} on file{outline.customTopics.length > 0 ? ` · ${outline.customTopics.length} custom topic${outline.customTopics.length === 1 ? "" : "s"}` : ""}
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {changed
              ? "Adjusted for this deal. The interviewer works through this checklist, section by section."
              : "Every data point the AI interviewer is after, section by section — ranked by what buyers in this industry care about. Change it by telling Cimple what you want."}
          </p>
          <p className="text-[11px] text-muted-foreground/80 mt-1" data-testid="outline-plan-status">
            {plan.status === "ready" && `Includes ${industryCount} data points specific to ${plan.industry ?? "this industry"}.`}
            {plan.status === "building" && <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Building the {plan.industry ?? "industry"} checklist from the industry playbook…</span>}
            {plan.status === "unavailable" && "Standard checklist — no industry playbook matched this business type yet."}
            {plan.status === "no_industry" && "Add the business's industry to get its industry-specific checklist."}
          </p>
          {plan.status === "ready" && plan.revision && (plan.revision.removed.length > 0 || plan.revision.added.length > 0) && (
            <p
              className="text-[11px] text-muted-foreground/70 mt-0.5"
              title={[
                plan.revision.removed.length > 0 ? `No longer asked: ${plan.revision.removed.join("; ")}` : "",
                plan.revision.added.length > 0 ? `Added: ${plan.revision.added.join("; ")}` : "",
              ].filter(Boolean).join("\n")}
              data-testid="outline-plan-revision"
            >
              Checklist refreshed {new Date(plan.revision.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              {plan.revision.removed.length > 0 && ` — ${plan.revision.removed.length} item${plan.revision.removed.length === 1 ? "" : "s"} that don't apply to this business removed`}
              {plan.revision.added.length > 0 && `${plan.revision.removed.length > 0 ? "," : " —"} ${plan.revision.added.length} critical item${plan.revision.added.length === 1 ? "" : "s"} added`}
              {` (was ${plan.revision.previousItemCount}).`}
            </p>
          )}

          {expanded && (
            <div className="mt-3 space-y-3">
              <ul className="divide-y divide-border/50 rounded-md border border-border/50" data-testid="outline-sections">
                {active.map((s) => {
                  const open = openSections.has(s.key);
                  const have = s.items.filter((i) => i.onFile).length;
                  return (
                    <li key={s.key} className="text-xs">
                      <div className="group flex items-center gap-2 px-2.5 py-1.5">
                        <button type="button" className="flex items-center gap-2 flex-1 min-w-0 text-left" onClick={() => toggleSection(s.key)} title={s.importanceReason || undefined} data-testid={`outline-section-${s.key}`}>
                          {open ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                          <span className={`w-16 shrink-0 text-[10px] uppercase tracking-wider ${LEVEL_CLASS[s.importance]}`}>{LEVEL_LABEL[s.importance]}</span>
                          <span className="truncate">{s.title}</span>
                          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{have}/{s.items.length}</span>
                        </button>
                        {s.importance !== "critical" && (
                          <button
                            type="button"
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground/50 hover:text-foreground"
                            title="Remove this section from the interview"
                            onClick={() => patch.mutate({ excludeSection: s.key })}
                            disabled={patch.isPending}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                      {open && (
                        <div className="px-2.5 pb-2 pl-9 space-y-0.5">
                          {s.note && <p className="text-muted-foreground/80 italic pb-1">“{s.note}”</p>}
                          {s.items.map((it) => (
                            <div key={it.key} className="group/item flex items-start gap-2 py-0.5" data-testid={`outline-item-${it.key}`}>
                              {it.onFile
                                ? <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0 text-success" />
                                : <Circle className={`h-3 w-3 mt-0.5 shrink-0 ${it.critical ? "text-teal" : "text-muted-foreground/40"}`} />}
                              <span className="min-w-0 flex-1">
                                <span className={it.onFile ? "text-muted-foreground" : ""}>{it.label}</span>
                                {it.critical && !it.onFile && <span className="ml-1.5 text-[9px] uppercase tracking-wider text-teal">critical</span>}
                                {it.industrySpecific && !it.addedByBroker && <span className="ml-1.5 text-[9px] uppercase tracking-wider text-muted-foreground/60">industry</span>}
                                {it.addedByBroker && <span className="ml-1.5 text-[9px] uppercase tracking-wider text-muted-foreground/60">added</span>}
                                {it.onFile && it.value && <span className="block text-[11px] text-muted-foreground/70 truncate" title={it.value}>{it.value}</span>}
                                {it.onFile && it.onFileIn && <span className="block text-[10px] text-muted-foreground/50 truncate" title={it.onFileIn}>{/^on file as /i.test(it.onFileIn) ? `On file as ${it.onFileIn.replace(/^on file as /i, "")}` : `In ${it.onFileIn}`}</span>}
                              </span>
                              {!UNREMOVABLE.has(it.key) && (
                                <button
                                  type="button"
                                  className="opacity-0 group-hover/item:opacity-100 text-muted-foreground/50 hover:text-foreground"
                                  title="Don't ask for this"
                                  onClick={() => patch.mutate({ removeItem: it.key })}
                                  disabled={patch.isPending}
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              )}
                            </div>
                          ))}
                          {s.removedItems.length > 0 && (
                            <p className="pt-1 text-muted-foreground/70">
                              Not asking:{" "}
                              {s.removedItems.map((r, i) => (
                                <span key={r.key}>
                                  {i > 0 && ", "}
                                  <span className="line-through">{r.label}</span>{" "}
                                  <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => patch.mutate({ restoreItem: r.key })} disabled={patch.isPending}>restore</button>
                                </span>
                              ))}
                            </p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                {outline.customTopics.map((t) => (
                  <li key={t.key} className="group flex items-start gap-2 text-xs py-0.5" title={t.description || undefined}>
                    <span className={`w-16 shrink-0 text-[10px] uppercase tracking-wider ${LEVEL_CLASS[t.importance]}`}>{LEVEL_LABEL[t.importance]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="inline-flex items-center gap-1"><Plus className="h-2.5 w-2.5 text-teal" />{t.title}</span>
                      {t.capture.length > 0 && (
                        <span className="block text-muted-foreground/70">{t.capture.join(" · ")}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground/50 hover:text-foreground"
                      title="Remove this topic"
                      onClick={() => patch.mutate({ removeTopic: t.key })}
                      disabled={patch.isPending}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
              {excluded.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Removed:{" "}
                  {excluded.map((s, i) => (
                    <span key={s.key}>
                      {i > 0 && ", "}
                      <span className="line-through">{s.title}</span>{" "}
                      <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => patch.mutate({ restoreSection: s.key })} disabled={patch.isPending}>
                        restore
                      </button>
                    </span>
                  ))}
                </p>
              )}
            </div>
          )}

          {/* Plain-language change */}
          <div className="mt-3">
            {!pending ? (
              <div className="flex gap-2 items-start">
                <Textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder='Tell Cimple what to change — e.g. "Also get the number of chairs in use and the recall rate. Skip the mission statement. Cover the two government contracts."'
                  className="text-xs min-h-[3.25rem] resize-none bg-muted/20 flex-1"
                  data-testid="input-outline-instruction"
                />
                <Button
                  size="sm"
                  className="h-8 text-xs gap-1.5 shrink-0 bg-teal text-teal-foreground hover:bg-teal/90"
                  onClick={() => propose.mutate(instruction)}
                  disabled={propose.isPending || !instruction.trim()}
                  data-testid="button-outline-propose"
                >
                  {propose.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  {propose.isPending ? "Working…" : "Adjust"}
                </Button>
              </div>
            ) : (
              <div className="rounded border border-teal/30 bg-teal/5 p-3 space-y-2" data-testid="outline-proposal">
                <p className="text-xs"><span className="font-medium">Proposed:</span> {pending.proposal.summary}</p>
                <ul className="text-xs space-y-1">
                  {pending.proposal.addTopics.map((t) => (
                    <li key={t.key} className="flex items-start gap-1.5">
                      <Plus className="h-3 w-3 text-teal mt-0.5 shrink-0" />
                      <span>
                        <span className="font-medium">{t.title}</span> <span className={`text-[10px] uppercase tracking-wider ${LEVEL_CLASS[t.importance]}`}>{LEVEL_LABEL[t.importance]}</span>
                        {t.capture.length > 0 && <span className="block text-muted-foreground">{t.capture.join(" · ")}</span>}
                      </span>
                    </li>
                  ))}
                  {pending.proposal.addItems.map((a, i) => (
                    <li key={`add-${i}`} className="flex items-start gap-1.5"><Plus className="h-3 w-3 text-teal mt-0.5 shrink-0" /><span>Also get <span className="font-medium">{a.label}</span> <span className="text-muted-foreground">({titleOf(a.sectionKey)})</span></span></li>
                  ))}
                  {pending.proposal.removeItems.map((k) => (
                    <li key={`rm-${k}`} className="flex items-start gap-1.5"><X className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" /><span>Don't ask for <span className="font-medium">{itemLabel(k)}</span></span></li>
                  ))}
                  {pending.proposal.restoreItems.map((k) => (
                    <li key={`rs-${k}`} className="flex items-start gap-1.5"><RotateCcw className="h-3 w-3 text-teal mt-0.5 shrink-0" /><span>Ask for <span className="font-medium">{itemLabel(k)}</span> again</span></li>
                  ))}
                  {pending.proposal.emphasis.map((e) => (
                    <li key={e.key} className="flex items-start gap-1.5"><Sparkles className="h-3 w-3 text-teal mt-0.5 shrink-0" /><span><span className="font-medium">{titleOf(e.key)}</span>: {e.note}</span></li>
                  ))}
                  {pending.proposal.excludeSections.map((k) => (
                    <li key={k} className="flex items-start gap-1.5"><X className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" /><span>Remove <span className="font-medium">{titleOf(k)}</span> from this interview</span></li>
                  ))}
                  {pending.proposal.restoreSections.map((k) => (
                    <li key={k} className="flex items-start gap-1.5"><RotateCcw className="h-3 w-3 text-teal mt-0.5 shrink-0" /><span>Restore <span className="font-medium">{titleOf(k)}</span></span></li>
                  ))}
                  {pending.proposal.removeTopics.map((k) => (
                    <li key={k} className="flex items-start gap-1.5"><X className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" /><span>Drop topic <span className="font-medium">{titleOf(k)}</span></span></li>
                  ))}
                  {pending.proposal.clearEmphasis.map((k) => (
                    <li key={k} className="flex items-start gap-1.5"><X className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" /><span>Clear the note on <span className="font-medium">{titleOf(k)}</span></span></li>
                  ))}
                  {pending.proposal.refused.map((r, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-muted-foreground"><AlertCircle className="h-3 w-3 mt-0.5 shrink-0" /><span><span className="line-through">{r.request}</span> — {r.why}</span></li>
                  ))}
                </ul>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => apply.mutate(pending)} disabled={apply.isPending} data-testid="button-outline-apply">
                    {apply.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}Apply
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPending(null)} disabled={apply.isPending}>
                    Discard
                  </Button>
                </div>
              </div>
            )}
          </div>

          {outline.history.length > 0 && (
            <p className="text-[11px] text-muted-foreground/60 mt-2">
              Last change: “{outline.history[0].instruction}” — {outline.history[0].summary}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
