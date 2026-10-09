/**
 * TeaserPanel — the CIM tab's "Teaser" view (spec §5.2).
 *
 *   Not written yet: the template picker (your templates, then the four
 *     built-in starting points) and "Write my teaser" (about 30 seconds,
 *     written from the Blind CIM so it starts anonymous) — or "Start from
 *     the template without AI". Blocked → the reason in amber.
 *   Writing: a progress row (polls every 2 s); you can leave the page.
 *   Failed: the reason, Try again / Start from the template.
 *   Draft / Published / Offline: the pages as thumbnails, the check line,
 *     held and pinpoint warnings, the seller line, buyers' counts, changes
 *     since publishing, facts changed since publishing, the settings, and the
 *     ⋯ menu (Print preview · Save as my teaser template · Take it offline ·
 *     Delete the teaser).
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Eye, Loader2, MoreHorizontal, PauseCircle,
  PenLine, Printer, RefreshCw, Save, ShieldAlert, Sparkles, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PanelError } from "@/components/deal/PanelError";
import { buildCimDesign } from "@/components/cim/CimDesignContext";
import { cn } from "@/lib/utils";
import { useDeal } from "@/contexts/DealContext";
import { TeaserApiError, hasTeaser, shortDay, type TeaserEmpty, type TeaserState } from "./api";
import { useTeaser, type TeaserApi } from "./useTeaser";
import { TeaserTemplatePicker } from "./TeaserTemplatePicker";
import { TeaserPages, type TeaserLayoutInfo } from "./TeaserPages";
import { TeaserSettingsFields } from "./TeaserSettings";
import { TeaserSellerCheck } from "./TeaserSellerCheck";
import { TeaserPublishButton } from "./TeaserPublishDialog";
import { SaveTeaserTemplateDialog } from "./SaveTeaserTemplateDialog";
import { CHECK_HELP, CHECK_LINE, blockName, draftSections, heldBlocks, pinpointBlocks } from "./draft-view";
import { templateTargetPages } from "./template-order";
import { fitSentence } from "./paginate";

export const WRITE_TIME = "About 30 seconds. Written from the Blind CIM, so it starts anonymous.";
export const WRITE_TIME_NO_BLIND = "Written from the deal's information after it's made anonymous — about 40 seconds.";

export function TeaserPanel({ dealId }: { dealId: string }) {
  const api = useTeaser(dealId);
  const { query } = api;
  if (query.isLoading) {
    return (
      <div className="space-y-3" data-testid="teaser-panel-loading">
        <Skeleton className="h-6 w-40" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-72 rounded-xl" />)}</div>
      </div>
    );
  }
  if (query.error || !query.data) return <PanelError what="the teaser" onRetry={() => query.refetch()} />;
  const data = query.data;
  if (hasTeaser(data) && data.teaser.draft.blocks.length > 0) return <TeaserWritten dealId={dealId} api={api} state={data} />;
  return <TeaserStart dealId={dealId} api={api} data={data} />;
}

// ── Not written yet / writing / failed ─────────────────────────────────────
function TeaserStart({ dealId, api, data }: { dealId: string; api: TeaserApi; data: TeaserEmpty | TeaserState }) {
  const [, navigate] = useLocation();
  const empty = hasTeaser(data) ? null : data;
  const gen = hasTeaser(data) ? data.teaser.generation : data.summary.generation;
  const running = gen?.status === "running";
  const failed = gen?.status === "failed";
  const saved = empty?.templates ?? [];
  const [choice, setChoice] = useState<string>(() => empty?.defaultTemplate ?? (hasTeaser(data) ? data.teaser.templateKey : "one_page"));
  const [gateReasons, setGateReasons] = useState<string[] | null>(null);
  const canWrite = empty ? empty.canWrite : { ok: true, reasons: [], notes: [] };
  const reasons = gateReasons ?? (canWrite.ok ? [] : canWrite.reasons);
  const basisLine = !empty || empty.basis === "blind_cim" ? WRITE_TIME : WRITE_TIME_NO_BLIND;
  const replace = hasTeaser(data);

  const write = () => {
    setGateReasons(null);
    api.generate.mutate({ templateKey: choice, replace }, {
      onError: (err) => {
        if (err instanceof TeaserApiError && err.code === "gate") setGateReasons((err.body?.reasons as string[]) ?? [err.message]);
      },
    });
  };
  const fromTemplate = () => {
    setGateReasons(null);
    api.fromTemplate.mutate({ templateKey: choice, replace }, {
      onSuccess: () => navigate(`/deal/${dealId}/teaser`),
      onError: (err) => {
        if (err instanceof TeaserApiError && err.code === "gate") setGateReasons((err.body?.reasons as string[]) ?? [err.message]);
      },
    });
  };

  if (running) {
    return (
      <div className="space-y-4" data-testid="teaser-writing">
        <Intro />
        <div className="flex items-start gap-3 rounded-lg border border-teal/30 bg-teal/5 p-4">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-teal" />
          <div className="space-y-1">
            <p className="text-sm font-medium">Writing your teaser — about 30 seconds. You can leave this page.</p>
            <p className="text-xs text-muted-foreground">Cimple writes from the anonymous Blind CIM, with every figure taken out — the numbers come from the deal's information as ranges.</p>
            <div className="mt-2 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-muted"><div className="h-full w-1/3 animate-[pulse_1.6s_ease-in-out_infinite] rounded-full bg-teal/70" /></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="teaser-start">
      <Intro />
      {failed && (
        <div className="flex flex-wrap items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm" role="alert" data-testid="teaser-failed">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          <p className="min-w-0 flex-1">Couldn't write the teaser: {gen?.error ?? "something went wrong"}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={write} disabled={api.generate.isPending}>Try again</Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={fromTemplate} disabled={api.fromTemplate.isPending}>Start from the template</Button>
          </div>
        </div>
      )}
      <TeaserTemplatePicker value={choice} onChange={setChoice} saved={saved} defaultKey={empty?.defaultTemplate ?? null} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <Button
          className="w-full gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90 sm:w-auto"
          onClick={write}
          disabled={reasons.length > 0 || api.generate.isPending}
          data-testid="button-write-teaser"
        >
          {api.generate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Write my teaser
        </Button>
        <p className="text-xs text-muted-foreground">{basisLine}</p>
      </div>
      {reasons.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-500" role="status" data-testid="teaser-blocked">
          {reasons.map((r, i) => <li key={i} className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {r}</li>)}
        </ul>
      )}
      {canWrite.notes.length > 0 && reasons.length === 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">{canWrite.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      )}
      <button
        type="button"
        className="text-xs text-teal underline-offset-2 hover:underline disabled:opacity-50"
        onClick={fromTemplate}
        disabled={reasons.length > 0 || api.fromTemplate.isPending}
        data-testid="button-teaser-from-template"
      >
        {api.fromTemplate.isPending ? "Starting…" : "Start from the template without AI"}
      </button>
    </div>
  );
}

function Intro() {
  return (
    <div>
      <h3 className="text-base font-semibold">Teaser</h3>
      <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
        A short anonymous summary you send before the NDA. Buyers who like it ask for the CIM — you decide who gets which version.
      </p>
    </div>
  );
}

// ── Draft / published / offline ────────────────────────────────────────────
function TeaserWritten({ dealId, api, state }: { dealId: string; api: TeaserApi; state: TeaserState }) {
  const [, navigate] = useLocation();
  const { deal } = useDeal();
  // While a live CIM's update waits for review, blind buyers still read the
  // published copy — under the codename it was published with.
  const dealCodename = (deal as { blindCodename?: string | null } | undefined)?.blindCodename ?? null;
  const t = state.teaser;
  const s = state.summary;
  const [layout, setLayout] = useState<TeaserLayoutInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [showPinpoint, setShowPinpoint] = useState(false);
  const design = useMemo(() => buildCimDesign(state.design ?? null, "blind"), [state.design]);
  const sections = useMemo(() => draftSections(t.draft, dealId, state.fill), [t.draft, dealId, state.fill]);
  const header = t.draft.header ? { ...t.draft.header, codename: t.codename } : null;
  const held = heldBlocks(t.draft, t.checks);
  const pin = pinpointBlocks(t.draft, t.checks);
  const visibleBlocks = t.draft.blocks.filter((b) => !b.hidden && !b.placeholder).length;
  const placeholders = t.draft.blocks.filter((b) => b.placeholder).length;
  const target = templateTargetPages(t.templateKey);
  const openEditor = (block?: string) => navigate(`/deal/${dealId}/teaser${block ? `?block=${block}` : ""}`);
  const statusText = s.status === "published" ? `Published ${shortDay(s.publishedAt)}` : s.status === "offline" ? `Offline since ${shortDay(s.unpublishedAt)}` : "Draft — not shared yet";
  const keyBlock = t.draft.blocks.find((b) => b.slot === "key_numbers" || b.slot === "listing_facts");

  return (
    <div className="space-y-4" data-testid="teaser-written">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            Teaser
            <span className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium",
              s.status === "published" ? "bg-success-muted text-success-muted-foreground" : s.status === "offline" ? "bg-muted text-muted-foreground" : "bg-amber-500/10 text-amber-500",
            )} data-testid="teaser-status">{statusText}</span>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t.templateName} · {layout ? `${layout.pages} page${layout.pages === 1 ? "" : "s"}` : "…"} · {visibleBlocks} block{visibleBlocks === 1 ? "" : "s"}
            {layout && fitSentence({ pages: layout.pages, targetPages: target, lastPageUsed: layout.lastPageUsed }).over && <span className="text-amber-500"> · longer than the template's {target === 1 ? "one page" : `${target} pages`}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => openEditor()} data-testid="button-open-teaser-editor">
            <PenLine className="h-3.5 w-3.5" /> Open teaser editor
          </Button>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => navigate(`/deal/${dealId}/teaser?preview=1`)} data-testid="button-preview-teaser">
            <Eye className="h-3.5 w-3.5" /> Preview
          </Button>
          {s.status !== "published" || s.changedSincePublish > 0 ? <TeaserPublishButton api={api} state={state} /> : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="More teaser actions" data-testid="button-teaser-more">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => navigate(`/deal/${dealId}/teaser/print`)}><Printer className="mr-2 h-3.5 w-3.5" /> Print preview</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSaveOpen(true)}><Save className="mr-2 h-3.5 w-3.5" /> Save as my teaser template</DropdownMenuItem>
              <DropdownMenuSeparator />
              {s.status === "published" && <DropdownMenuItem onSelect={() => setOfflineOpen(true)}><PauseCircle className="mr-2 h-3.5 w-3.5" /> Take it offline</DropdownMenuItem>}
              <DropdownMenuItem className="text-red-500 focus:text-red-500" onSelect={() => setDeleteOpen(true)}><Trash2 className="mr-2 h-3.5 w-3.5" /> Delete the teaser</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-col gap-4 md:flex-row">
        {/* The pages, small (clicking opens the editor) */}
        <button type="button" onClick={() => openEditor()} className="-mx-4 shrink-0 overflow-x-auto px-4 text-left md:mx-0 md:px-0" aria-label="Open the teaser in the editor">
          <div className="w-max rounded-lg bg-muted/30 p-3">
            <TeaserPages header={header} sections={sections} pageSize={t.pageSize} design={design} mode="thumb" thumbScale={0.24} onLayout={setLayout} />
          </div>
        </button>

        <div className="min-w-0 flex-1 space-y-3">
          {/* The check line — always this wording; it never says "Anonymous ✓". */}
          <div className="flex gap-2 text-xs" data-testid="teaser-check-summary">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
            <span><span className="text-foreground">{CHECK_LINE}.</span> <span className="text-muted-foreground">Check it doesn't describe the business so precisely that someone could recognise it.</span></span>
          </div>
          {held.length > 0 && (
            <div className="flex gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs" role="alert" data-testid="teaser-held-line">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
              <span className="min-w-0 flex-1">
                {held.length === 1 ? "1 block is held back" : `${held.length} blocks are held back`} from buyers: {held.map((b) => blockName(b)).join(", ")}. Open {held.length === 1 ? "it" : "them"} in the editor to reword.
              </span>
              <button type="button" className="shrink-0 text-teal hover:underline" onClick={() => openEditor(held[0].id)}>Open it</button>
            </div>
          )}
          {placeholders > 0 && (
            <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs" data-testid="teaser-placeholder-line">
              <PenLine className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="min-w-0 flex-1">
                {t.generation?.reviewFailed
                  ? "The confidentiality check couldn't run, so Cimple didn't write the text. Try again — or fill in the highlighted blocks yourself."
                  : `${placeholders === 1 ? "1 block isn't" : `${placeholders} blocks aren't`} written yet — buyers don't see ${placeholders === 1 ? "it" : "them"} until ${placeholders === 1 ? "it has" : "they have"} words.`}
              </span>
              {t.generation?.reviewFailed && <button type="button" className="shrink-0 text-teal hover:underline" onClick={() => api.generate.mutate({ templateKey: t.templateKey, replace: true })}>Try again</button>}
            </div>
          )}
          {pin.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs" data-testid="teaser-pinpoint-line">
              <div className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span className="min-w-0 flex-1">
                  {pin.length === 1 ? "1 block may describe" : `${pin.length} blocks may describe`} the business too precisely ({pin.flatMap((p) => p.phrases).slice(0, 2).map((x) => `“${x}”`).join(", ")}).
                </span>
                <button type="button" className="shrink-0 text-teal hover:underline" onClick={() => setShowPinpoint((o) => !o)}>{showPinpoint ? "Hide" : "Show me"}</button>
              </div>
              {showPinpoint && (
                <ul className="mt-2 space-y-1 pl-5">
                  {pin.map(({ block, phrases }) => (
                    <li key={block.id}><button type="button" className="text-left hover:underline" onClick={() => openEditor(block.id)}><span className="font-medium">{blockName(block)}:</span> {phrases.map((p) => `“${p}”`).join(", ")}</button></li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {t.codenameProblem && (
            <p className="flex gap-2 text-xs text-amber-500" data-testid="teaser-codename-problem">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {dealCodename && dealCodename !== t.codename ? (
                <span>Blind buyers still read the published CIM under “{t.codename}”, which could point to the business: {t.codenameProblem} Publish the CIM update on the Overview so they get “{dealCodename}”, then publish the teaser.</span>
              ) : (
                <span>The codename could point buyers to the business: {t.codenameProblem} Change it on the Versions tab (Blind CIM card) before publishing.</span>
              )}
            </p>
          )}

          {s.status !== "none" && (s.status === "published" || s.status === "offline" || s.counts.links > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs" data-testid="teaser-counts">
              <span className="text-muted-foreground">
                <span className="text-foreground">{s.counts.links} buyer{s.counts.links === 1 ? " has" : "s have"} it</span>
                {" · "}{s.counts.opened} opened{s.counts.asked > 0 ? ` · ${s.counts.asked} asked for the CIM` : ""}{s.counts.passed > 0 ? ` · ${s.counts.passed} said not for me` : ""}
              </span>
              <button type="button" className="inline-flex items-center gap-1 text-teal hover:underline" onClick={() => navigate(`/deal/${dealId}/buyers?stage=teaser`)}>
                Have the teaser <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          )}

          <TeaserSellerCheck dealId={dealId} api={api} state={state} onOpenEditor={() => openEditor()} />

          {t.hasPublished && s.changedSincePublish > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid="teaser-changed-line">
              <span className="text-muted-foreground">You've changed {s.changedSincePublish} block{s.changedSincePublish === 1 ? "" : "s"} since publishing. Buyers still see the published version.</span>
            </div>
          )}
          {state.staleness.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-xs" data-testid="teaser-staleness">
              <span className="min-w-0 flex-1">
                Facts changed since you published: {state.staleness.map((x) => `${x.label} is now ${x.now} (was ${x.published})`).join("; ")}.
              </span>
              {keyBlock && (
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={api.reset.isPending} onClick={() => api.reset.mutate(keyBlock.id)}>
                  {api.reset.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Update the key numbers
                </Button>
              )}
            </div>
          )}
          {state.notes.length > 0 && <ul className="space-y-0.5 text-[11px] text-muted-foreground">{state.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}

          <div className="rounded-md border border-border">
            <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium" onClick={() => setSettingsOpen((o) => !o)} aria-expanded={settingsOpen} data-testid="button-teaser-settings">
              {settingsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Teaser settings
              <span className="ml-auto truncate font-normal text-muted-foreground">{t.numbers === "ranges" ? "Ranges" : "Rounded figures"} · {t.showAskingPrice ? "price shown" : "price on request"}</span>
            </button>
            {settingsOpen && <TeaserSettingsFields api={api} state={state} className="border-t border-border p-3" />}
          </div>
        </div>
      </div>

      <SaveTeaserTemplateDialog api={api} open={saveOpen} onOpenChange={setSaveOpen} />
      <AlertDialog open={offlineOpen} onOpenChange={setOfflineOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Take the teaser offline?</AlertDialogTitle>
            <AlertDialogDescription>Buyers with a teaser link will see “not available right now” until you publish it again. Buyers who have the CIM aren't affected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it online</AlertDialogCancel>
            <AlertDialogAction onClick={() => api.unpublish.mutate()} data-testid="button-confirm-teaser-offline">Take it offline</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the teaser?</AlertDialogTitle>
            <AlertDialogDescription>
              The draft{t.hasPublished ? " and the published version are" : " is"} removed. Buyers with a teaser link will see “not available right now”. Buyers who have the CIM aren't affected. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => api.remove.mutate()} data-testid="button-confirm-teaser-delete">Delete the teaser</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
