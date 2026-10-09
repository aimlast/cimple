/**
 * The floating window (Pop out — Document Picture-in-Picture, Chrome/Edge;
 * specs/together.md §4.3): one KPI line, the listening state, the top 8
 * "To ask" items with their questions and their one button, a 3-line "Just
 * filed" ticker and Suggest next. It renders from the page's own state, so
 * while "Seller can see this screen" is on it shows the screen board too.
 * The main view for Zoom / Meet / Teams calls.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { primaryActionFor, PRIMARY_LABEL } from "@/components/coverage/CoverageItemRow";
import { CallNoteEditor } from "@/components/coverage/ItemEditors";
import { StatusIcon } from "@/components/coverage/StatusIcon";
import { boardRequest, invalidateCoverage } from "@/hooks/useCoverageBoard";
import { MASKED_VALUE, rankOpenItems, reasonText, type CoverageBoard, type CoverageItem, type NextToAskContext } from "@shared/coverage-board";
import { listenCopy, listenIsProblem, type ListenState, type TogetherSittingView } from "@shared/together";
import { ListeningPill } from "./ModeCards";
import { SuggestNext } from "./SuggestNext";
import { filedThisSession } from "./LivePanel";

export function TogetherPip({
  dealId,
  board,
  sitting,
  listenState,
  startedAt,
  suggestCtx,
  onShowItem,
}: {
  dealId: string;
  board: CoverageBoard;
  sitting: TogetherSittingView;
  listenState: ListenState;
  startedAt: number | null;
  suggestCtx?: NextToAskContext;
  onShowItem: (itemId: string, sectionKey?: string) => void;
}) {
  const audience = board.audience === "screen" ? "screen" : "broker";
  const top = rankOpenItems(board).slice(0, 8);
  const filed = filedThisSession(board, sitting.id).slice(0, 3);
  return (
    <div className="flex flex-col h-screen bg-background text-foreground" data-testid="together-pip">
      <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
        <span className="text-sm font-semibold tabular-nums">{board.percentCollected}%</span>
        <span className="text-xs text-muted-foreground">collected</span>
        <span className="text-xs">·</span>
        <span className={`text-xs ${board.totals.criticalOpen > 0 ? "text-teal font-medium" : "text-success"}`}>
          {board.totals.criticalOpen > 0 ? `${board.totals.criticalOpen} critical open` : "Every critical point on file"}
        </span>
        <span className="ml-auto"><ListeningPill state={listenState} startedAt={startedAt} compact /></span>
      </div>
      {listenIsProblem(listenState) && <p className="px-3 py-2 text-[11px] tg-warn-text tg-warn-bg border-b border-border">{listenCopy(listenState)}</p>}
      {sitting.aiDown && <p className="px-3 py-2 text-[11px] tg-warn-text tg-warn-bg border-b border-border">Cimple can't file answers right now — everything said is kept. Keep talking.</p>}
      {filed.length > 0 && (
        <ul className="px-3 py-2 border-b border-border space-y-0.5" aria-label="Just filed">
          {filed.map((i) => (
            <li key={i.id} className="text-[11px] flex items-center gap-1.5 truncate">
              <StatusIcon status={i.status} size={11} />
              <span className="font-medium truncate">{i.label}</span>
              <span className="text-muted-foreground truncate">· {i.sectionTitle}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">To ask</p>
        {top.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">Everything on the checklist is on file.</p>
        ) : (
          top.map((item) => <PipRow key={item.id} dealId={dealId} item={item} audience={audience} sittingId={sitting.id} onShowItem={onShowItem} />)
        )}
      </div>
      <div className="p-3 border-t border-border">
        <SuggestNext board={board} ctx={suggestCtx} onShow={onShowItem} size="sm" label="Suggest next" inline />
      </div>
    </div>
  );
}

/**
 * A row in the floating window: no popovers or sheets (they would open in
 * the main window) — the question, and the one button; "Resolve…" brings
 * the item up on the main board.
 */
function PipRow({ dealId, item, audience, sittingId, onShowItem }: { dealId: string; item: CoverageItem; audience: "broker" | "screen"; sittingId: string; onShowItem: (itemId: string, sectionKey?: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const action = primaryActionFor(item, "live");
  const run = async () => {
    if (action === "resolve") { onShowItem(item.id, item.sectionKey); return; }
    setBusy(true);
    try {
      if (action === "confirm") {
        await boardRequest("POST", `/api/deals/${dealId}/coverage-board/items/${encodeURIComponent(item.id)}/confirm`, { sittingId }, "Couldn't confirm it");
        invalidateCoverage(dealId);
      } else if (action === "answered") {
        try {
          await boardRequest("POST", `/api/deals/${dealId}/coverage-board/items/${encodeURIComponent(item.id)}/answer`, { sittingId, mode: "auto" }, "Couldn't file it");
          invalidateCoverage(dealId);
        } catch {
          setEditing(true);
        }
      } else if (action === "file_it") {
        await boardRequest("POST", `/api/deals/${dealId}/coverage-board/items/${encodeURIComponent(item.id)}/file-suggestion`, { sittingId, chunkId: item.suggestion?.chunkId }, "Couldn't file it");
        invalidateCoverage(dealId);
      }
    } finally {
      setBusy(false);
    }
  };
  const second = item.privateValue ? MASKED_VALUE : item.suggestion ? `Possible answer: ‘${item.suggestion.quote}’` : item.status === "missing" ? `“${item.ask}”` : reasonText(item.reason, audience) || item.ask;
  return (
    <div className="px-3 py-2 border-b border-border/60" data-testid={`pip-item-${item.id}`}>
      <div className="flex items-start gap-2">
        <StatusIcon status={item.status} size={13} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{item.label}{item.critical && <span className="ml-1.5 text-[9px] uppercase tracking-wider text-teal">Critical</span>}</p>
          <p className="text-[11px] text-muted-foreground line-clamp-2">{second}</p>
        </div>
        {action && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px] border-teal/40 text-teal hover:bg-teal/10 shrink-0" disabled={busy} onClick={() => void run()}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : PRIMARY_LABEL[action]}
          </Button>
        )}
      </div>
      {editing && <CallNoteEditor dealId={dealId} item={item} sittingId={sittingId} onCancel={() => setEditing(false)} onDone={() => setEditing(false)} />}
    </div>
  );
}
