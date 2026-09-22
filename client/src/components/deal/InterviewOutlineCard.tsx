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
import { ListChecks, Loader2, Plus, RotateCcw, Sparkles, X, ChevronDown, ChevronRight, AlertCircle } from "lucide-react";
import type { InterviewOutline, OutlineCustomTopic, SectionImportanceLevel } from "@shared/schema";

interface OutlineSection {
  key: string;
  title: string;
  order: number;
  importance: SectionImportanceLevel;
  importanceReason: string;
  excluded: boolean;
  note: string | null;
}

interface OutlineView {
  outline: InterviewOutline;
  sections: OutlineSection[];
}

interface Proposal {
  summary: string;
  addTopics: OutlineCustomTopic[];
  removeTopics: string[];
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

  const key = ["/api/deals", dealId, "interview-outline"];
  const { data, isLoading } = useQuery<OutlineView>({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/interview-outline`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r, "Failed to load the interview outline"));
      return r.json();
    },
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

  const { outline, sections } = data;
  const active = sections.filter((s) => !s.excluded);
  const excluded = sections.filter((s) => s.excluded);
  const changed = outline.customTopics.length > 0 || excluded.length > 0 || outline.emphasis.length > 0;
  const titleOf = (k: string) => sections.find((s) => s.key === k)?.title ?? outline.customTopics.find((t) => t.key === k)?.title ?? k;

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
              {active.length} sections{outline.customTopics.length > 0 ? ` + ${outline.customTopics.length} custom topic${outline.customTopics.length === 1 ? "" : "s"}` : ""}
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {changed
              ? "Adjusted for this deal. The interviewer follows this plan and the industry checklist."
              : "What the AI interviewer will cover, ranked by what buyers in this industry care about. Change it by telling Cimple what you want."}
          </p>

          {expanded && (
            <div className="mt-3 space-y-3">
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                {active.map((s) => (
                  <li key={s.key} className="group flex items-start gap-2 text-xs py-0.5" title={s.importanceReason || undefined}>
                    <span className={`w-16 shrink-0 text-[10px] uppercase tracking-wider ${LEVEL_CLASS[s.importance]}`}>{LEVEL_LABEL[s.importance]}</span>
                    <span className="min-w-0 flex-1">
                      <span>{s.title}</span>
                      {s.note && <span className="block text-muted-foreground/80 italic">“{s.note}”</span>}
                    </span>
                    {s.importance !== "critical" && (
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground/50 hover:text-foreground"
                        title="Remove from this interview"
                        onClick={() => patch.mutate({ excludeSection: s.key })}
                        disabled={patch.isPending}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </li>
                ))}
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
                  placeholder='Tell Cimple what to change — e.g. "Also cover the franchise agreement renewal and their two government contracts. Skip seasonality."'
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
