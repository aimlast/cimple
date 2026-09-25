/**
 * One fact: label, value (edit in place), where it came from, how sure we
 * are, what other sources said, and delete.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { Check, Loader2, Pencil, Trash2, Layers, X } from "lucide-react";
import type { FactAlternate, FactSourceInfo, InformationFact } from "@shared/information";
import { KIND_META, sourceChipText, formatShortDate, UNTRACKED_HINT, INFERRED_HINT } from "./source-kinds";
import { useInformationAction } from "./useInformation";

const LONG_TEXT = 260;

/** Clickable chip naming a fact's source — opens it (document, transcript turn, email…). */
export function SourceChip({
  source,
  onOpen,
  size = "sm",
}: {
  source: FactSourceInfo;
  onOpen?: (src: FactSourceInfo) => void;
  size?: "sm" | "xs";
}) {
  const meta = KIND_META[source.kind] ?? KIND_META.unknown;
  const Icon = meta.icon;
  const openable = !!onOpen && (!!source.documentId || !!source.sessionId || source.kind === "website");
  const tone =
    source.kind === "broker"
      ? "border-teal/40 bg-teal/10 text-teal"
      : source.kind === "unknown"
        // Quiet, not alarming: plain text with no border.
        ? "border-transparent bg-muted/30 text-muted-foreground"
        : ((source.kind === "crm" || source.kind === "website" || source.kind === "social") && !source.acceptedByBroker) || source.inferred
          ? "border-dashed border-border text-muted-foreground"
          : "border-border bg-muted/40 text-foreground/80";
  const text = sourceChipText(source);
  const detail =
    source.kind === "unknown"
      ? UNTRACKED_HINT
      : [
          source.label,
          source.note && !source.label.includes(source.note) ? source.note : null,
          source.at ? `Recorded ${formatShortDate(source.at, true)}` : null,
          source.inferred ? INFERRED_HINT : null,
        ].filter(Boolean).join(" · ");
  const chip = (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full border ${tone} ${
        size === "xs" ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-[11px]"
      } ${openable ? "hover:border-teal/50 hover:text-foreground transition-colors" : ""}`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{text}</span>
      {source.inferred && <span className="shrink-0 italic text-muted-foreground">(inferred)</span>}
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {openable ? (
          <button type="button" onClick={() => onOpen!(source)} className="max-w-full min-w-0 text-left" data-testid="fact-source-chip">
            {chip}
          </button>
        ) : (
          <span className="max-w-full min-w-0 inline-flex" data-testid="fact-source-chip">{chip}</span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        {detail}
        {openable && <span className="block text-muted-foreground mt-0.5">Click to open the source</span>}
      </TooltipContent>
    </Tooltip>
  );
}

const CONFIDENCE_TEXT: Record<string, { text: string; cls: string; hint: string } | undefined> = {
  approximate: { text: "Approximate", cls: "text-amber-500", hint: "The seller gave a rough figure, or it couldn't be matched to their exact words — confirm it." },
  unverified: { text: "Unverified", cls: "text-muted-foreground italic", hint: "Second-hand or public information — the interview confirms it with the seller." },
};

function AlternatesPopover({
  alternates,
  onUse,
  onOpenSource,
  busy,
}: {
  alternates: FactAlternate[];
  onUse: (alt: FactAlternate) => void;
  onOpenSource: (src: FactSourceInfo) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[11px] text-teal hover:underline underline-offset-2"
          data-testid="fact-alternates"
        >
          <Layers className="h-3 w-3" />
          {alternates.length} other value{alternates.length === 1 ? "" : "s"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <p className="px-3 pt-3 pb-2 text-xs text-muted-foreground">
          Other sources said something different. Pick the one that should be on file.
        </p>
        <ul className="max-h-72 overflow-y-auto divide-y divide-border/60">
          {alternates.map((a) => (
            <li key={`${a.altKey}:${a.index}`} className="px-3 py-2.5 space-y-1.5">
              <p className="text-sm whitespace-pre-wrap break-words line-clamp-5">{a.displayValue}</p>
              <div className="flex items-center justify-between gap-2">
                <SourceChip source={a.source} onOpen={(s) => { setOpen(false); onOpenSource(s); }} size="xs" />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px] shrink-0"
                  disabled={busy}
                  onClick={() => { onUse(a); setOpen(false); }}
                >
                  Use this
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function initialDraft(fact: InformationFact): string {
  if (fact.isMap && fact.value && typeof fact.value === "object") {
    return Object.entries(fact.value as Record<string, unknown>)
      .sort(([a], [b]) => (/^\d{4}$/.test(a) && /^\d{4}$/.test(b) ? Number(b) - Number(a) : a.localeCompare(b)))
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
  }
  return fact.displayValue;
}

export function FactRow({
  dealId,
  fact,
  onOpenSource,
  highlight,
}: {
  dealId: string;
  fact: InformationFact;
  onOpenSource: (src: FactSourceInfo) => void;
  highlight?: string;
}) {
  const { toast } = useToast();
  const action = useInformationAction(dealId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      const el = taRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  const startEdit = () => {
    setDraft(initialDraft(fact));
    setEditing(true);
  };

  const save = () => {
    const value = draft.trim();
    if (!value) return;
    if (value === initialDraft(fact).trim()) { setEditing(false); return; }
    action.mutate(
      { method: "PUT", path: `/facts/${encodeURIComponent(fact.key)}`, body: { value } },
      {
        onSuccess: () => setEditing(false),
        onError: (e) => toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" }),
      },
    );
  };

  const remove = () => {
    action.mutate(
      { method: "DELETE", path: `/facts/${encodeURIComponent(fact.key)}` },
      {
        onSuccess: () =>
          toast({
            title: `Deleted "${fact.label}"`,
            description: "New documents won't bring it back.",
            action: (
              <ToastAction
                altText="Undo"
                onClick={() => action.mutate({ method: "POST", path: `/facts/${encodeURIComponent(fact.key)}/restore` })}
              >
                Undo
              </ToastAction>
            ),
          }),
        onError: (e) => toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }),
      },
    );
  };

  const adoptAlternate = (alt: FactAlternate) =>
    action.mutate(
      { method: "POST", path: `/facts/${encodeURIComponent(alt.altKey)}/use-alternate`, body: { index: alt.index } },
      {
        onSuccess: () => toast({ title: "Updated", description: `${fact.label} now uses that value.` }),
        onError: (e) => toast({ title: "Couldn't use that value", description: (e as Error).message, variant: "destructive" }),
      },
    );

  const long = fact.displayValue.length > LONG_TEXT || fact.displayValue.split("\n").length > 4;
  const conf = CONFIDENCE_TEXT[fact.confidence];
  const multiline = fact.isMap || draft.length > 60 || draft.includes("\n");

  return (
    <div
      id={`fact-${fact.key}`}
      className={`group relative grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,12.5rem)_minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-4 py-3 border-t border-border/40 first:border-t-0 transition-colors ${
        highlight === fact.key ? "bg-teal/5" : "hover:bg-muted/20"
      }`}
      data-testid={`fact-row-${fact.key}`}
    >
      <div className={`min-w-0 pt-0.5 ${editing ? "" : "pr-16 sm:pr-0"}`}>
        <p className="text-xs font-medium text-muted-foreground leading-snug break-words">{fact.label}</p>
        {(fact.critical || fact.industrySpecific) && (
          <p className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {fact.critical ? <span className="text-teal">Critical</span> : null}
            {fact.critical && fact.industrySpecific ? " · " : null}
            {fact.industrySpecific ? "Industry" : null}
          </p>
        )}
      </div>

      <div className="min-w-0">
        {editing ? (
          <div className="space-y-2">
            {multiline ? (
              <Textarea
                ref={taRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(false);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                }}
                rows={Math.min(10, Math.max(3, draft.split("\n").length + 1))}
                className="text-sm"
                data-testid="fact-edit-input"
              />
            ) : (
              <input
                ref={taRef as unknown as React.RefObject<HTMLInputElement>}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(false);
                  if (e.key === "Enter") save();
                }}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-teal"
                data-testid="fact-edit-input"
              />
            )}
            {fact.isMap && <p className="text-[10px] text-muted-foreground">One per line, e.g. "2024: $2.1M".</p>}
            <div className="flex items-center gap-2">
              <Button size="sm" className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1" onClick={save} disabled={action.isPending || !draft.trim()}>
                {action.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Save
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(false)} disabled={action.isPending}>
                Cancel
              </Button>
              <span className="hidden sm:inline text-[10px] text-muted-foreground/70">{multiline ? "⌘↵ to save · Esc to cancel" : "↵ to save · Esc to cancel"}</span>
            </div>
          </div>
        ) : (
          <>
            <p
              className={`text-sm leading-relaxed whitespace-pre-wrap break-words ${long && !expanded ? "line-clamp-4" : ""}`}
              onDoubleClick={startEdit}
            >
              {fact.displayValue}
            </p>
            {long && (
              <button type="button" onClick={() => setExpanded((e) => !e)} className="text-[11px] text-muted-foreground hover:text-foreground mt-0.5">
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <SourceChip source={fact.source} onOpen={onOpenSource} />
              {(fact.corroboratedBy?.length ?? 0) > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-[11px] text-muted-foreground cursor-default" data-testid="fact-corroborated">
                      Also in {fact.corroboratedBy!.length === 1 ? sourceChipText(fact.corroboratedBy![0]) : `${fact.corroboratedBy!.length} other sources`}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-xs">
                    <span className="block mb-0.5">Other sources that say the same — if one is removed, the fact stays:</span>
                    {fact.corroboratedBy!.map((s, i) => <span key={i} className="block text-muted-foreground">{s.label}</span>)}
                  </TooltipContent>
                </Tooltip>
              )}
              {conf && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className={`text-[11px] cursor-default ${conf.cls}`}>{conf.text}</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-xs">{conf.hint}</TooltipContent>
                </Tooltip>
              )}
              {fact.alternates.length > 0 && (
                <AlternatesPopover alternates={fact.alternates} onUse={adoptAlternate} onOpenSource={onOpenSource} busy={action.isPending} />
              )}
            </div>
          </>
        )}
      </div>

      {!editing && (
        <div className="absolute right-2 top-2 sm:static flex items-start gap-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity sm:-mt-0.5">
          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={startEdit} aria-label={`Edit ${fact.label}`}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-red-400" onClick={remove} disabled={action.isPending} aria-label={`Delete ${fact.label}`}>
            {action.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Inline "add" row: a label + value form (new fact) or a value for a missing checklist item. */
export function AddFactForm({
  dealId,
  sectionKey,
  missingKey,
  missingLabel,
  onDone,
}: {
  dealId: string;
  sectionKey: string | null;
  missingKey?: string;
  missingLabel?: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const action = useInformationAction(dealId);
  const [label, setLabel] = useState(missingLabel ?? "");
  const [value, setValue] = useState("");
  const submit = () => {
    if (!value.trim() || (!missingKey && !label.trim())) return;
    const req = missingKey
      ? { method: "PUT" as const, path: `/facts/${encodeURIComponent(missingKey)}`, body: { value: value.trim() } }
      : { method: "POST" as const, path: `/facts`, body: { label: label.trim(), value: value.trim(), section: sectionKey } };
    action.mutate(req, {
      onSuccess: () => {
        toast({ title: "Added", description: `${missingLabel ?? label.trim()} is on file.` });
        onDone();
      },
      onError: (e) => toast({ title: "Couldn't add it", description: (e as Error).message, variant: "destructive" }),
    });
  };
  return (
    <div className="px-4 py-3 border-t border-border/40 bg-muted/20 space-y-2" data-testid="add-fact-form">
      {missingKey ? (
        <p className="text-xs font-medium text-muted-foreground">{missingLabel}</p>
      ) : (
        <input
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="What is it? e.g. Number of dental chairs"
          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-teal"
        />
      )}
      <Textarea
        autoFocus={!!missingKey}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        placeholder="The value, as it should read"
        rows={2}
        className="text-sm"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1" onClick={submit} disabled={action.isPending || !value.trim() || (!missingKey && !label.trim())}>
          {action.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Add
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={onDone}>
          <X className="h-3 w-3" /> Cancel
        </Button>
      </div>
    </div>
  );
}
