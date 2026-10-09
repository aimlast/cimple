/**
 * One data point on the coverage board: status icon, label, tags, a second
 * line by status, ONE context-aware primary button and a ⋯ menu.
 *
 *   missing / partial      → Add answer (checklist) — the broker's edit
 *   to verify (estimate, a guard flag, a lead, your AI-session notes,
 *              "come back later")   → ✓ Confirmed
 *   to verify (sources disagree / sent to the seller) → Resolve…
 *   on file                → ⋯ only
 *
 * Hover (desktop) shows the detail popover; on a phone a tap opens it as a
 * bottom sheet with the same actions.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Check, Loader2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { boardRequest, fetchItemDetail, invalidateCoverage, type BrokerAudience } from "@/hooks/useCoverageBoard";
import { StatusIcon } from "./StatusIcon";
import { NoteEditor, ValueEditor } from "./ItemEditors";
import {
  CHIP,
  MASKED_VALUE,
  STATUS_LABEL,
  reasonText,
  type CoverageItem,
} from "@shared/coverage-board";

/** Never removable from the checklist (the server refuses too). */
const UNREMOVABLE = new Set(["askingPrice", "annualRevenue"]);
const CONFIRMABLE = new Set(["estimate", "guard", "lead", "broker_notes", "marked"]);

export type RowMode = "checklist" | "live" | "panel";

export type PrimaryAction = "add" | "confirm" | "resolve" | null;

/** The one primary button a row gets (pure — tested). */
export function primaryActionFor(item: CoverageItem, mode: RowMode): PrimaryAction {
  if (mode === "panel") return null;
  if (item.status === "on_file") return null;
  if (item.status === "verify") {
    const code = item.reason?.code;
    // (A conflict keeps its id on every audience, even when its reason is hidden.)
    if (code === "conflict" || code === "routed" || item.conflictId) return item.conflictId ? "resolve" : null;
    if (code && CONFIRMABLE.has(code)) return "confirm";
    // (The screen audience drops some reasons' detail, never the code.)
    return item.moneyTalk ? "confirm" : null;
  }
  return item.members.some((m) => m.writable) ? "add" : null;
}

export const PRIMARY_LABEL: Record<Exclude<PrimaryAction, null>, string> = {
  add: "Add answer",
  confirm: "✓ Confirmed",
  resolve: "Resolve…",
};

function Tag({ children, tone = "muted" }: { children: ReactNode; tone?: "brass" | "muted" }) {
  return (
    <span className={`text-[9.5px] font-semibold uppercase tracking-[0.08em] ${tone === "brass" ? "text-teal" : "text-muted-foreground/70"}`}>{children}</span>
  );
}

function Chip({ children, tone = "muted", testId }: { children: ReactNode; tone?: "brass" | "muted" | "success"; testId?: string }) {
  const cls = tone === "brass" ? "border-teal/40 text-teal" : tone === "success" ? "border-success/40 text-success" : "border-border text-muted-foreground";
  return <span className={`inline-flex items-center rounded-full border px-1.5 py-[1px] text-[10px] leading-4 ${cls}`} data-testid={testId}>{children}</span>;
}

function SecondLine({ item, audience }: { item: CoverageItem; audience: BrokerAudience }) {
  const reason = reasonText(item.reason, audience);
  if (item.privateValue) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {MASKED_VALUE}
        {item.status === "verify" && reason && <span className="not-italic cov-text-verify"> · {reason}</span>}
      </p>
    );
  }
  if (item.moneyTalk) {
    return <p className="text-xs text-muted-foreground">{item.status === "on_file" ? STATUS_LABEL.on_file : item.status === "verify" ? "To verify." : `Ask: “${item.ask}”`}</p>;
  }
  switch (item.status) {
    case "missing":
      if (item.suggestion) return <p className="text-xs italic text-muted-foreground">Possible answer: ‘{item.suggestion.quote}’</p>;
      return <p className="text-xs text-muted-foreground">Ask: <span className="text-foreground/80">“{item.ask}”</span></p>;
    case "partial":
      return (
        <div className="space-y-0.5">
          <p className="text-xs cov-text-partial">{reason}</p>
          {item.value && item.reason?.code !== "not_known" && <p className="text-xs text-muted-foreground line-clamp-1">{item.value}</p>}
        </div>
      );
    case "verify":
      return (
        <div className="space-y-0.5">
          {item.value && <p className="text-xs text-muted-foreground line-clamp-1">{item.value}</p>}
          <p className="text-xs cov-text-verify line-clamp-2" title={reason}>{reason || "To verify."}</p>
        </div>
      );
    default:
      return (
        <div className="space-y-0.5 min-w-0">
          {item.value && <p className="text-xs text-muted-foreground line-clamp-1" title={item.value}>{item.value}</p>}
          {item.source && (
            <p className="text-[11px] text-muted-foreground/70 line-clamp-1">
              {item.source.label}
              {item.source.excerpt ? ` · “${item.source.excerpt}”` : ""}
            </p>
          )}
        </div>
      );
  }
}

/** The detail shown on hover (desktop) or in the bottom sheet (phone). */
export function ItemDetailBody({ dealId, item, audience }: { dealId: string; item: CoverageItem; audience: BrokerAudience }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["/api/deals", dealId, "coverage-board", audience, "item", item.id],
    queryFn: () => fetchItemDetail(dealId, item.id, audience),
    staleTime: 15_000,
  });
  const heading = (t: string) => <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-1">{t}</p>;
  return (
    <div className="space-y-3 text-sm" data-testid={`detail-${item.id}`}>
      {isLoading && <p className="text-xs text-muted-foreground inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>}
      {error && <p className="text-xs text-destructive">{(error as Error).message}</p>}
      {data && (
        <>
          <div>
            {heading(STATUS_LABEL[data.item.status])}
            {data.item.privateValue ? (
              <p className="text-xs italic text-muted-foreground">{MASKED_VALUE}</p>
            ) : data.item.moneyTalk ? (
              <p className="text-xs text-muted-foreground">Not shown while the seller can see this screen.</p>
            ) : data.fullValue ? (
              <p className="text-sm whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{data.fullValue}</p>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing on file yet.</p>
            )}
            {data.item.reason && <p className="text-xs mt-1 text-muted-foreground">{reasonText(data.item.reason, audience)}</p>}
          </div>
          {data.item.source && (
            <div>
              {heading("Where it came from")}
              <p className="text-xs">{data.item.source.label}{data.item.source.at ? ` · ${new Date(data.item.source.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : ""}</p>
            </div>
          )}
          {data.item.source?.excerpt && (
            <div>
              {heading("What the seller said")}
              <p className="text-xs italic">“{data.item.source.excerpt}”</p>
            </div>
          )}
          {data.otherValues.length > 0 && (
            <div>
              {heading("Other values on file")}
              <ul className="space-y-1">
                {data.otherValues.map((o, i) => (
                  <li key={i} className="text-xs"><span className="text-foreground/90">{o.value}</span> <span className="text-muted-foreground">— {o.source}</span></li>
                ))}
              </ul>
            </div>
          )}
          {data.members.length > 1 && (
            <p className="text-xs text-muted-foreground">
              {data.members.some((m) => m.onFile) && <>On file: {data.members.filter((m) => m.onFile).map((m) => m.label).join(", ")}. </>}
              {data.members.some((m) => !m.onFile) && <>Not on file: {data.members.filter((m) => !m.onFile).map((m) => m.label).join(", ")}.</>}
            </p>
          )}
          {data.item.why && (
            <div>
              {heading("Why buyers care")}
              <p className="text-xs text-muted-foreground">{data.item.why}</p>
            </div>
          )}
          {data.note && (
            <div>
              {heading("Your note")}
              <p className="text-xs whitespace-pre-wrap">{data.note}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function CoverageItemRow({
  dealId,
  item,
  audience,
  mode,
  touch,
  dataIndex,
  justFiled,
  onResolve,
  onMenuOpenChange,
}: {
  dealId: string;
  item: CoverageItem;
  audience: BrokerAudience;
  mode: RowMode;
  /** Phone: tap opens the detail sheet (no hover). */
  touch?: boolean;
  dataIndex?: number;
  justFiled?: boolean;
  onResolve?: (discrepancyId: string) => void;
  /** Freeze the list while a menu, editor, popover or sheet is open (key = "<itemId>:<what>"). */
  onMenuOpenChange?: (key: string, open: boolean) => void;
}) {
  const { toast } = useToast();
  const [editor, setEditor] = useState<null | "add" | "edit" | "note">(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const action = primaryActionFor(item, mode);
  const verifyLater = item.marks.some((m) => m.kind === "verify_later");
  const note = item.marks.find((m) => m.kind === "note")?.note ?? null;
  const removable = item.origin !== "figures" && !item.members.some((m) => UNREMOVABLE.has(m.key));
  const writable = item.members.some((m) => m.writable);
  const opened = (what: string) => (open: boolean) => onMenuOpenChange?.(`${item.id}:${what}`, open);
  const closeSheet = () => {
    setSheetOpen(false);
    opened("sheet")(false);
  };
  const openEditor = (e: typeof editor) => {
    setEditor(e);
    opened("editor")(e !== null);
  };
  useEffect(() => () => {
    // (A row leaving the list never keeps it frozen.)
    for (const what of ["editor", "menu", "hover", "sheet"]) onMenuOpenChange?.(`${item.id}:${what}`, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      invalidateCoverage(dealId);
      if (ok) toast({ title: ok });
    } catch (e) {
      toast({ title: "That didn't work", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  const confirm = () =>
    run(() => boardRequest("POST", `/api/deals/${dealId}/coverage-board/items/${encodeURIComponent(item.id)}/confirm`, {}, "Couldn't confirm it"), "Confirmed by you");
  const mark = (kind: "verify_later", on: boolean) =>
    run(() =>
      on
        ? boardRequest("POST", `/api/deals/${dealId}/coverage-board/items/${encodeURIComponent(item.id)}/marks`, { kind }, "Couldn't save that")
        : boardRequest("DELETE", `/api/deals/${dealId}/coverage-board/items/${encodeURIComponent(item.id)}/marks/${kind}`, undefined, "Couldn't clear that"),
    );
  const notNeeded = () =>
    run(async () => {
      await boardRequest("PATCH", `/api/deals/${dealId}/interview-outline`, { removeItems: item.members.map((m) => m.key) }, "Couldn't take it off the checklist");
      toast({
        title: "Removed from the checklist",
        description: `${item.label} won't be asked for on this deal.`,
        action: (
          <ToastAction
            altText="Undo"
            onClick={() =>
              void boardRequest("PATCH", `/api/deals/${dealId}/interview-outline`, { restoreItems: item.members.map((m) => m.key) }).then(() => invalidateCoverage(dealId))
            }
          >
            Undo
          </ToastAction>
        ),
      });
    });

  const primary =
    action === null ? null : (
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2.5 text-xs border-teal/40 text-teal hover:bg-teal/10 hover:text-teal shrink-0"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          if (action === "add") openEditor(editor === "add" ? null : "add");
          else if (action === "confirm") void confirm();
          else if (action === "resolve" && item.conflictId) onResolve?.(item.conflictId);
        }}
        data-testid={`button-primary-${item.id}`}
      >
        {busy && action === "confirm" ? <Loader2 className="h-3 w-3 animate-spin" /> : touch && action === "confirm" ? <Check className="h-3.5 w-3.5" aria-label="Confirmed" /> : touch && action === "resolve" ? "Resolve" : touch && action === "add" ? "Add" : PRIMARY_LABEL[action]}
      </Button>
    );

  const menu =
    mode === "panel" ? (
      <DropdownMenu onOpenChange={opened("menu")}>
        <DropdownMenuTrigger asChild>
          <button type="button" className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" aria-label={`More for ${item.label}`} onClick={(e) => e.stopPropagation()}>
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => void mark("verify_later", !verifyLater)}>{verifyLater ? "Clear ‘come back later’" : "Come back to this later"}</DropdownMenuItem>
          <DropdownMenuItem asChild><Link href={`/deal/${dealId}/interview/together?listen=0&view=section&section=${item.sectionKey}`}>Open in the full checklist</Link></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <DropdownMenu onOpenChange={opened("menu")}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
            aria-label={`More for ${item.label}`}
            onClick={(e) => e.stopPropagation()}
            data-testid={`button-more-${item.id}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {writable && <DropdownMenuItem onSelect={() => openEditor(item.status === "on_file" || item.value ? "edit" : "add")}>{item.value || item.privateValue ? "Edit" : "Add answer"}</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => void mark("verify_later", !verifyLater)}>{verifyLater ? "Clear ‘come back later’" : "Come back to this later"}</DropdownMenuItem>
          {audience === "broker" && <DropdownMenuItem onSelect={() => openEditor("note")}>{note ? "Edit your private note" : "Add a private note"}</DropdownMenuItem>}
          {removable && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void notNeeded()}>Not needed for this deal</DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild><Link href={`/deal/${dealId}/information`}>Open in Information</Link></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

  const tags = (
    <>
      {item.critical && <Tag tone="brass">{CHIP.critical}</Tag>}
      {item.origin === "industry" && <Tag>{CHIP.industry}</Tag>}
      {item.origin === "broker" && <Tag>{CHIP.added}</Tag>}
      {item.origin === "noted" && <Tag>{CHIP.alsoNoted}</Tag>}
      {item.origin === "figures" && <Tag tone="brass">{CHIP.numbers}</Tag>}
      {justFiled && <Chip tone="brass" testId={`chip-just-filed-${item.id}`}>{CHIP.justFiled}</Chip>}
      {item.confirmedByYou && <Chip tone="success">{CHIP.confirmedByYou}</Chip>}
      {item.estimate && <Chip>{CHIP.estimate}</Chip>}
      {item.yourNote && <Chip>{CHIP.yourNote}</Chip>}
      {verifyLater && item.status !== "verify" && <Chip>Come back later</Chip>}
      {note && audience === "broker" && <Chip>Note</Chip>}
    </>
  );

  const label = (
    <span
      className={`font-medium ${mode === "panel" ? "text-xs" : "text-sm"} ${item.status === "on_file" ? "text-foreground/90" : ""}`}
      title={mode === "panel" ? (item.privateValue ? MASKED_VALUE : item.value ?? item.ask) || undefined : undefined}
    >
      {item.label || "Item your broker added"}
    </span>
  );

  const body = (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {!touch && mode !== "panel" ? (
          <HoverCard openDelay={350} closeDelay={80} onOpenChange={opened("hover")}>
            <HoverCardTrigger asChild>
              <button type="button" className="text-left hover:underline decoration-dotted underline-offset-4" data-testid={`label-${item.id}`}>{label}</button>
            </HoverCardTrigger>
            <HoverCardContent align="start" className="w-[22rem] max-w-[90vw]">
              <ItemDetailBody dealId={dealId} item={item} audience={audience} />
            </HoverCardContent>
          </HoverCard>
        ) : (
          label
        )}
        {mode !== "panel" && tags}
      </div>
      {mode !== "panel" && <div className="mt-0.5"><SecondLine item={item} audience={audience} /></div>}
      {mode === "panel" && item.status !== "on_file" && item.reason && (
        <p className="text-[11px] text-muted-foreground line-clamp-1">{reasonText(item.reason, audience)}</p>
      )}
      {(editor === "add" || editor === "edit") && (
        <ValueEditor
          dealId={dealId}
          item={item}
          mode={editor}
          initialValue={editor === "edit" && !item.privateValue ? item.value : ""}
          onCancel={() => openEditor(null)}
          onDone={() => openEditor(null)}
        />
      )}
      {editor === "note" && <NoteEditor dealId={dealId} item={item} initial={note} onCancel={() => openEditor(null)} onDone={() => openEditor(null)} />}
    </div>
  );

  return (
    <div
      className={`group flex items-start gap-3 ${mode === "panel" ? "px-2 py-1.5" : touch ? "px-3 py-2.5" : "px-3 py-3"} border-b border-border/60 last:border-b-0 cov-animate transition-colors ${justFiled ? "cov-just-filed" : ""} ${touch ? "active:bg-accent/40" : ""}`}
      data-index={dataIndex}
      data-item-id={item.id}
      data-status={item.status}
      data-testid={`coverage-item-${item.id}`}
      onClick={touch && mode !== "panel" ? () => { setSheetOpen(true); opened("sheet")(true); } : undefined}
    >
      <span className="mt-0.5"><StatusIcon status={item.status} size={mode === "panel" ? 14 : 16} /></span>
      {body}
      <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
        {primary}
        {menu}
      </div>
      {touch && (
        <Sheet open={sheetOpen} onOpenChange={(o) => { setSheetOpen(o); opened("sheet")(o); }}>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-xl px-4 pb-6" onClick={(e) => e.stopPropagation()}>
            <SheetHeader className="text-left">
              <SheetTitle className="text-base">{item.label}</SheetTitle>
              <SheetDescription className="text-xs">{item.ask ? `Ask: “${item.ask}”` : STATUS_LABEL[item.status]}</SheetDescription>
            </SheetHeader>
            <div className="mt-3"><ItemDetailBody dealId={dealId} item={item} audience={audience} /></div>
            <div className="mt-4 flex flex-wrap gap-2">
              {action === "add" && <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => { closeSheet(); openEditor("add"); }}>Add answer</Button>}
              {action === "confirm" && <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90" disabled={busy} onClick={() => { void confirm(); closeSheet(); }}>✓ Confirmed</Button>}
              {action === "resolve" && item.conflictId && <Button size="sm" variant="outline" onClick={() => { closeSheet(); onResolve?.(item.conflictId!); }}>Resolve…</Button>}
              {writable && item.status === "on_file" && <Button size="sm" variant="outline" onClick={() => { closeSheet(); openEditor("edit"); }}>Edit</Button>}
              <Button size="sm" variant="ghost" onClick={() => { void mark("verify_later", !verifyLater); closeSheet(); }}>{verifyLater ? "Clear ‘come back later’" : "Come back later"}</Button>
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
