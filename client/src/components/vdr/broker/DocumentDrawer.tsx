/**
 * The document drawer (vdr spec §5.4; right, 480 px; full screen on phones;
 * `?item=`). Three tabs: Cimple's notes · Sharing · Activity.
 *
 * Cimple's notes: what it is, what buyers read about it (the broker writes or
 * accepts it — buyers see the basic line until then, V12), and the panel only
 * the broker sees (flags with "I've checked it"). Sharing: the Share dialog's
 * controls inline. Activity: who opened it, for how long, which pages.
 */
import { useState } from "react";
import { AlertTriangle, Eye, FileText, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { RoomItemRow } from "@shared/vdr-api";
import { durationLabel, shortDate, useItemActivity } from "@/hooks/useDataRoom";
import { FlagChip, ItemMeta, SharingChip } from "./parts";
import { ShareForm } from "./ShareDialog";
import { useRoomActions } from "./actions";

type DrawerTab = "notes" | "sharing" | "activity";

export function DocumentDrawer({ dealId, item, onClose, onOpenViewer, onViewAs }: { dealId: string; item: RoomItemRow | null; onClose: () => void; onOpenViewer: (id: string) => void; onViewAs: () => void }) {
  const [tab, setTab] = useState<DrawerTab>("notes");
  return (
    <Sheet open={!!item} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-[480px]" data-testid="document-drawer">
        {item && (
          <>
            <SheetHeader className="space-y-2 border-b border-border px-5 pb-4 pt-5 text-left">
              <SheetTitle className="pr-6 text-base leading-snug">
                <span className="mr-2 font-mono text-xs text-muted-foreground">{item.number}</span>{item.title}
              </SheetTitle>
              <SheetDescription asChild><div><ItemMeta item={item} /></div></SheetDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" onClick={() => onOpenViewer(item.id)} disabled={item.prepared?.status !== "ready"}><FileText className="mr-1.5 h-3.5 w-3.5" /> Open</Button>
                <Button size="sm" variant="outline" onClick={onViewAs}><Eye className="mr-1.5 h-3.5 w-3.5" /> View as a buyer</Button>
                <SharingChip item={item} />
              </div>
            </SheetHeader>
            <div className="flex border-b border-border px-3" role="tablist">
              {(["notes", "sharing", "activity"] as DrawerTab[]).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("border-b-2 px-3 py-2.5 text-sm font-medium", tab === t ? "border-teal text-teal" : "border-transparent text-muted-foreground hover:text-foreground")}>
                  {t === "notes" ? "Cimple's notes" : t === "sharing" ? "Sharing" : "Activity"}
                </button>
              ))}
            </div>
            <div className="px-5 py-5">
              {tab === "notes" && <Notes dealId={dealId} item={item} />}
              {tab === "sharing" && <ShareForm key={item.id} dealId={dealId} target={{ kind: "item", item }} inline />}
              {tab === "activity" && <Activity dealId={dealId} item={item} />}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Notes({ dealId, item }: { dealId: string; item: RoomItemRow }) {
  const actions = useRoomActions(dealId);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const what = [
    item.doc?.typeLabel,
    item.doc?.periodLabel ? `period ending ${item.doc.periodLabel}` : null,
    item.prepared?.pages ? `${item.prepared.pages} ${item.prepared.pages === 1 ? "page" : "pages"}` : item.prepared?.sheets ? `${item.prepared.sheets} ${item.prepared.sheets === 1 ? "sheet" : "sheets"}` : null,
    item.doc ? `uploaded by ${item.doc.uploadedBy === "seller" ? "the seller" : "you"} on ${shortDate(item.doc.createdAt)}` : null,
  ].filter(Boolean).join(" · ");
  const s = item.summary;
  const showing = s.status === "accepted" && s.text && !s.hidden ? s.text : s.basic;
  const chip = s.status === "drafted" ? "Written by Cimple · not shown to buyers yet" : s.status === "accepted" && s.source === "broker" && s.text ? "Written by you" : s.status === "accepted" && s.source === "ai" ? "Written by Cimple · accepted" : "Basic description";
  const look = item.flags.filter((f) => f.look);
  const notes = item.flags.filter((f) => !f.look && f.key !== "private_notes");
  return (
    <div className="space-y-6 text-sm">
      <section>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">What it is</h4>
        <p className="text-foreground/90">{what ? `${what}.` : "A document in this deal."}</p>
        {item.cleanCopy && <p className="mt-1 text-xs text-muted-foreground">Buyers see your cleaned copy{item.cleanCopy.name ? ` (${item.cleanCopy.name})` : ""}, uploaded {shortDate(item.cleanCopy.at)}.</p>}
      </section>

      <section>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What buyers read about it</h4>
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{chip}</span>
        </div>
        {editing ? (
          <div className="space-y-2">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={600} rows={4} autoFocus />
            <p className="text-xs text-muted-foreground">Describe what the document is and what it shows. Buyers read this beside the document.</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              <Button size="sm" onClick={async () => { await actions.saveSummary(item.id, text); setEditing(false); }} disabled={actions.pending}>Save</Button>
            </div>
          </div>
        ) : (
          <>
            <p className="rounded-md border border-border bg-muted/20 px-3 py-2 text-foreground/90" data-testid="drawer-description">{showing}</p>
            {s.status === "drafted" && s.text && <p className="mt-2 rounded-md border border-dashed border-border px-3 py-2 text-foreground/80">{s.text}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {s.status === "drafted" && s.text && <Button size="sm" variant="outline" onClick={() => actions.acceptSummary(item.id)}>Use this</Button>}
              <Button size="sm" variant="outline" onClick={() => { setText(s.status === "accepted" && s.text ? s.text : ""); setEditing(true); }}>Edit</Button>
              {s.status === "accepted" && s.text && (
                <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={!s.hidden} onCheckedChange={(v) => actions.hideSummary(item.id, !v)} /> Show to buyers
                </label>
              )}
            </div>
          </>
        )}
      </section>

      <section className="rounded-lg border border-border bg-muted/20 p-4">
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Lock className="h-3.5 w-3.5" /> Only you see this</h4>
        {look.length === 0 && notes.length === 0 && <p className="text-muted-foreground">Nothing for you to check on this document.</p>}
        <div className="space-y-3">
          {look.map((f) => {
            const open = item.unchecked.includes(f.key);
            return (
              <div key={f.key} className="space-y-1">
                <FlagChip flag={f} checked={open ? null : item.checked ? shortDate(item.checked.at) : null} />
                <p className="text-xs text-muted-foreground">{f.copy}</p>
                {open && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => actions.check(item.id, [f.key])}>I've checked it</Button>}
              </div>
            );
          })}
          {notes.map((f) => (
            <div key={f.key} className="space-y-1">
              <FlagChip flag={f} />
              <p className="text-xs text-muted-foreground">{f.copy}</p>
            </div>
          ))}
        </div>
        {item.unchecked.length > 0 && item.sharing.shared && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-teal"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Shared, but buyers can't open it until you've checked it.</p>
        )}
      </section>
    </div>
  );
}

function Activity({ dealId, item }: { dealId: string; item: RoomItemRow }) {
  const { data, isLoading, error } = useItemActivity(dealId, item.id);
  if (isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;
  if (error || !data) return <p className="text-sm text-muted-foreground">Couldn't load the activity. Try again.</p>;
  if (data.buyers.length === 0) return <p className="text-sm text-muted-foreground" data-testid="drawer-activity-empty">No buyer has opened it yet.</p>;
  const max = Math.max(1, ...Object.values(data.pages));
  return (
    <div className="space-y-5 text-sm">
      {data.pageCount > 0 && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Time on each page</h4>
          <div className="flex flex-wrap gap-0.5" data-testid="page-strip">
            {Array.from({ length: Math.min(data.pageCount, 200) }, (_, i) => {
              const ms = data.pages[String(i + 1)] ?? 0;
              return <span key={i} title={`Page ${i + 1} · ${ms ? durationLabel(ms) : "not read"}`} className="h-5 w-3 rounded-sm border border-border" style={{ background: ms ? `hsl(var(--teal) / ${0.15 + 0.85 * (ms / max)})` : undefined }} />;
            })}
          </div>
        </section>
      )}
      <section className="space-y-2">
        {data.buyers.map((b) => (
          <div key={b.key} className="rounded-md border border-border px-3 py-2">
            <p className="font-medium">{b.company || b.name || b.email}</p>
            <p className="text-xs text-muted-foreground">
              opened {b.opens} {b.opens === 1 ? "time" : "times"} · {durationLabel(b.activeMs)}
              {b.pagesRead.length ? ` · read ${pageRange(b.pagesRead)}` : ""}
              {b.downloaded ? " · downloaded" : ""} · last {shortDate(b.lastAt)}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}

function pageRange(pages: number[]): string {
  const ps = pages.slice().sort((a, b) => a - b);
  if (ps.length === 1) return `page ${ps[0]}`;
  const consecutive = ps.every((p, i) => i === 0 || p === ps[i - 1] + 1);
  return consecutive ? `pages ${ps[0]}–${ps[ps.length - 1]}` : `${ps.length} pages`;
}
