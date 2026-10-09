/**
 * The data room's Activity view and what other screens read from it (vdr
 * spec §5.9, §9.1 activity.ts, §9.4 timeline, §11.4). Pure aggregations over
 * the views (one row per opening of a document, server-issued) and the
 * append-only log. No AI.
 *
 *  - By buyer: one row per buyer (email) — documents opened, time, last
 *    visit, downloads, what's new for them and not opened, each document
 *    (time, pages, opens, "from the DD CIM") and each person on their team.
 *  - By document: readers, time, downloads, a page strip.
 *  - Full log: plain sentences, newest first, filters, CSV, and a trace
 *    code from a leaked page finds the view (and so the reader).
 *  - Profile timeline, analytics signals and broker totals for other tabs.
 *
 * The broker's own previews (source "preview") are never counted.
 */
import type { BuyerAccess, VdrActivity, VdrItem, VdrTeamMember, VdrView } from "@shared/schema";
import { buyerKey } from "@shared/vdr";
import type { ActivityBuyerRow, ActivityDocRow, ActivityLogRow, ActivityPerson, TraceHit } from "@shared/vdr-api";

/** CSV cell: quoted; a cell starting with = + - @ (or a tab/CR) is prefixed with ' (no formula injection). */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const counted = (v: Pick<VdrView, "source">) => v.source !== "preview";

export type ReportContext = {
  items: ReadonlyArray<Pick<VdrItem, "id" | "title" | "removedAt" | "prepared">>;
  numbers: ReadonlyMap<string, string>;
  accessRows: ReadonlyArray<BuyerAccess>;
  team: ReadonlyArray<Pick<VdrTeamMember, "id" | "name" | "role" | "principalEmail">>;
  /** Buyer key → the items they can open right now (live visibility). */
  canSee: ReadonlyMap<string, ReadonlySet<string>>;
  /** Buyer key → items new for them since their last visit. */
  newFor?: ReadonlyMap<string, ReadonlySet<string>>;
};

/** "Northgate Pharmacy Group" — company, else name, else email. */
export function labelForKey(key: string, rows: ReadonlyArray<BuyerAccess>): string {
  const link = rows.filter((r) => buyerKey(r.buyerEmail) === key).sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
  return (link?.buyerCompany && link.buyerCompany.trim()) || (link?.buyerName && link.buyerName.trim()) || link?.buyerEmail || key;
}

function principalName(key: string, rows: ReadonlyArray<BuyerAccess>): string {
  const link = rows.find((r) => buyerKey(r.buyerEmail) === key);
  return (link?.buyerName && link.buyerName.trim()) || link?.buyerEmail || key;
}

function pagesOf(v: Pick<VdrView, "pageMs">): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, ms] of Object.entries((v.pageMs as Record<string, number> | null) ?? {})) if (/^\d+$/.test(k) && ms > 0) out[k] = ms;
  return out;
}

/** By buyer (§5.9): every buyer who can open the room or has opened something. */
export function activityByBuyer(views: ReadonlyArray<VdrView>, ctx: ReportContext): ActivityBuyerRow[] {
  const keys = new Set<string>([...Array.from(ctx.canSee.keys()), ...views.filter(counted).map((v) => v.buyerEmail)]);
  const out: ActivityBuyerRow[] = [];
  for (const key of Array.from(keys)) {
    const mine = views.filter((v) => counted(v) && v.buyerEmail === key);
    const docs = new Map<string, ActivityBuyerRow["documents"][number]>();
    for (const v of mine) {
      const it = ctx.items.find((x) => x.id === v.itemId);
      const d = docs.get(v.itemId) ?? { itemId: v.itemId, number: ctx.numbers.get(v.itemId) ?? null, title: it?.title ?? "A document no longer in the room", activeMs: 0, opens: 0, pages: [], downloads: 0, fromCim: false, lastAt: iso(v.lastSeenAt)! };
      d.activeMs += v.activeMs ?? 0;
      d.opens += 1;
      d.downloads += v.downloaded ? 1 : 0;
      d.fromCim ||= v.source === "cim";
      d.pages = Array.from(new Set([...d.pages, ...Object.keys(pagesOf(v)).map(Number)])).sort((a, b) => a - b);
      if (new Date(v.lastSeenAt).getTime() > new Date(d.lastAt).getTime()) d.lastAt = iso(v.lastSeenAt)!;
      docs.set(v.itemId, d);
    }
    const people = new Map<string, ActivityPerson>();
    for (const v of mine) {
      const id = v.teamMemberId ?? "";
      const m = v.teamMemberId ? ctx.team.find((t) => t.id === v.teamMemberId) : null;
      const p = people.get(id) ?? { memberId: v.teamMemberId ?? null, name: m ? m.name : principalName(key, ctx.accessRows), role: m ? m.role : "principal", activeMs: 0, opens: 0 };
      p.activeMs += v.activeMs ?? 0;
      p.opens += 1;
      people.set(id, p);
    }
    const documents = Array.from(docs.values()).sort((a, b) => b.activeMs - a.activeMs);
    const visible = ctx.canSee.get(key) ?? new Set<string>();
    const openedIds = new Set(mine.map((v) => v.itemId));
    const newSet = ctx.newFor?.get(key) ?? new Set<string>();
    const last = mine.reduce((m, v) => Math.max(m, new Date(v.lastSeenAt).getTime()), 0);
    const link = ctx.accessRows.filter((r) => buyerKey(r.buyerEmail) === key).sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
    out.push({
      key,
      accessId: link?.id ?? null,
      label: labelForKey(key, ctx.accessRows),
      email: link?.buyerEmail ?? key,
      canSee: visible.size,
      openedDocs: openedIds.size,
      activeMs: documents.reduce((n, d) => n + d.activeMs, 0),
      downloads: documents.reduce((n, d) => n + d.downloads, 0),
      lastAt: last ? new Date(last).toISOString() : null,
      newNotOpened: Array.from(newSet).filter((id) => visible.has(id) && !openedIds.has(id)).length,
      top: documents.slice(0, 3).map((d) => ({ itemId: d.itemId, number: d.number, title: d.title, activeMs: d.activeMs })),
      documents,
      people: Array.from(people.values()).sort((a, b) => (a.memberId === null ? -1 : b.memberId === null ? 1 : b.activeMs - a.activeMs)),
    });
  }
  return out.sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || b.canSee - a.canSee || a.label.localeCompare(b.label));
}

/** By document (§5.9): every live item. */
export function activityByDocument(views: ReadonlyArray<VdrView>, ctx: ReportContext): ActivityDocRow[] {
  return ctx.items
    .filter((i) => !i.removedAt)
    .map((it) => {
      const mine = views.filter((v) => counted(v) && v.itemId === it.id);
      const pages: Record<string, number> = {};
      for (const v of mine) for (const [k, ms] of Object.entries(pagesOf(v))) pages[k] = (pages[k] ?? 0) + ms;
      const last = mine.reduce((m, v) => Math.max(m, new Date(v.lastSeenAt).getTime()), 0);
      let canSee = 0;
      for (const set of Array.from(ctx.canSee.values())) if (set.has(it.id)) canSee++;
      return {
        itemId: it.id,
        number: ctx.numbers.get(it.id) ?? null,
        title: it.title,
        readers: new Set(mine.map((v) => v.buyerEmail)).size,
        canSee,
        activeMs: mine.reduce((n, v) => n + (v.activeMs ?? 0), 0),
        downloads: mine.filter((v) => v.downloaded).length,
        pageCount: (it.prepared as { pages?: unknown[] } | null)?.pages?.length ?? 0,
        pages,
        lastAt: last ? new Date(last).toISOString() : null,
      };
    })
    .sort((a, b) => b.activeMs - a.activeMs || (a.number ?? "~").localeCompare(b.number ?? "~", undefined, { numeric: true }));
}

// ── The log in plain sentences ─────────────────────────────────────────────

const ACTION_LABEL: Record<string, string> = {
  buyer_opened_room: "Opened the data room",
  buyer_opened_item: "Opened a document",
  buyer_downloaded: "Downloaded a document",
  buyer_searched: "Searched",
  buyer_requested: "Asked for a document",
  buyer_asked: "Asked about a document",
  buyer_denied: "Tried a document not shared with them",
  index_downloaded: "Downloaded the index",
  shared: "Sharing changed",
  unshared: "Stopped sharing",
  plan_applied: "Sharing plan",
  checked_by_broker: "Checked by you",
  item_added: "Added to the room",
  item_removed: "Taken out of the room",
  seller_removed_shared: "Removed by the seller",
  request_resolved: "Request answered",
  request_ready: "Request ready to share",
  seller_emailed: "Seller emailed",
  told_buyer: "Buyer told",
  buyers_emailed: "Buyers emailed",
  room_closed: "Room closed",
  room_opened: "Room opened",
};

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export const LOG_ACTION_FILTERS: ReadonlyArray<{ key: string; label: string }> = [
  "buyer_opened_room", "buyer_opened_item", "buyer_downloaded", "buyer_requested", "buyer_asked", "buyer_denied", "index_downloaded",
  "shared", "plan_applied", "checked_by_broker", "request_resolved", "seller_emailed", "told_buyer", "buyers_emailed",
].map((key) => ({ key, label: actionLabel(key) }));

/** One log row as a sentence (§5.9): "Priya Shah for Northgate Pharmacy Group opened 1.2.2 T2 … (from the DD CIM)". */
export function logSentence(row: Pick<VdrActivity, "action" | "actorKind" | "actorId" | "itemId" | "buyerEmail" | "detail">, ctx: Pick<ReportContext, "items" | "numbers" | "accessRows" | "team">): { text: string; person: string | null } {
  const d = (row.detail ?? {}) as Record<string, any>;
  const item = row.itemId ? ctx.items.find((i) => i.id === row.itemId) : null;
  const doc = item ? `${ctx.numbers.get(item.id) ? `${ctx.numbers.get(item.id)} ` : ""}${item.title}` : typeof d.title === "string" ? `'${d.title}'` : "a document";
  const buyer = row.buyerEmail ? labelForKey(row.buyerEmail, ctx.accessRows) : "a buyer";
  const member = row.actorKind === "team" && row.actorId ? ctx.team.find((t) => t.id === row.actorId) : null;
  const who = member ? `${member.name} for ${buyer}` : buyer;
  const person = member ? member.name : row.actorKind === "buyer" ? principalName(row.buyerEmail ?? "", ctx.accessRows) : null;
  const from = d.source === "cim" ? " (from the DD CIM)" : d.source === "search" ? " (from search)" : d.source === "new" ? " (from New since your last visit)" : d.source === "question" ? " (from a question)" : "";
  const n = (k: string) => (typeof d[k] === "number" ? d[k] : 0);
  switch (row.action) {
    case "buyer_opened_room": return { text: `${who} opened the data room`, person };
    case "buyer_opened_item": return { text: `${who} opened ${doc}${from}`, person };
    case "buyer_downloaded": return { text: `${who} downloaded ${doc}`, person };
    case "buyer_searched": return { text: `${who} searched the data room`, person };
    case "buyer_requested": return { text: `${who} asked for ${n("count") > 1 ? `${n("count")} documents` : d.kind === "room_access" ? "access to the data room" : "a document"}`, person };
    case "buyer_asked": return { text: `${who} asked a question about ${doc}`, person };
    case "buyer_denied": return { text: `${who} tried to open a document not shared with them`, person };
    case "index_downloaded": return { text: `${who} downloaded the index`, person };
    case "room_set_up": return { text: row.actorKind === "system" ? "The data room was set up" : "You set up the data room", person: null };
    case "plan_applied": return { text: `You confirmed the sharing plan (${n("shared")} ${n("shared") === 1 ? "document" : "documents"} shared)`, person: null };
    case "room_closed": return { text: "You closed the data room", person: null };
    case "room_opened": return { text: "You reopened the data room", person: null };
    case "settings_changed": return { text: d.autoAddNew === false ? "You stopped adding new documents automatically" : "You turned on adding new documents automatically", person: null };
    case "folder_created": return { text: `You added the folder '${d.name ?? ""}'`, person: null };
    case "folder_renamed": return { text: `You renamed the folder '${d.from ?? ""}' to '${d.to ?? ""}'`, person: null };
    case "folder_moved": return { text: "You moved a folder", person: null };
    case "folder_deleted": return { text: `You deleted the folder '${d.name ?? ""}'`, person: null };
    case "item_added": return { text: `${doc} was added to the room${d.addedBy === "seller" ? " (the seller's upload)" : d.addedBy === "auto" ? " automatically" : ""}`, person: null };
    case "item_moved": return { text: `You moved ${doc}`, person: null };
    case "item_renamed": return { text: `You renamed '${d.from ?? ""}' to '${d.to ?? ""}'`, person: null };
    case "item_removed": return { text: `You took ${doc} out of the room`, person: null };
    case "item_restored": return { text: `${doc} is back in the room`, person: null };
    case "item_tombstoned": return { text: `${doc} left the room (its file was deleted or made private)`, person: null };
    case "seller_removed_shared": return { text: `The seller removed ${doc}, which buyers could open`, person: null };
    case "new_version": return { text: `New version from the seller: ${doc}`, person: null };
    case "clean_copy_added": return { text: `You uploaded a cleaned copy of ${doc}`, person: null };
    case "clean_copy_removed": return { text: `You removed the cleaned copy of ${doc}`, person: null };
    case "shared": return { text: `You shared ${doc}: ${d.from ?? "Not shared"} → ${d.to ?? ""}`, person: null };
    case "unshared": return { text: `You stopped sharing ${doc} (${d.from ?? ""} → ${d.to ?? "Not shared"})`, person: null };
    case "downloads_changed": return { text: d.downloadable ? `You let buyers download ${doc}` : `You made ${doc} view-only`, person: null };
    case "original_offered": return { text: d.on ? `You offered the original file of ${doc}` : `You stopped offering the original file of ${doc}`, person: null };
    case "checked_by_broker": return { text: `You checked ${doc}`, person: null };
    case "summary_drafted": return { text: `Cimple wrote a description of ${doc}`, person: null };
    case "summary_accepted": return { text: `You accepted the description of ${doc}`, person: null };
    case "summary_edited": return { text: `You edited the description of ${doc}`, person: null };
    case "buyer_room_changed": return { text: `You turned the data room ${d.roomAccess === "off" ? "off" : "on"} for ${buyer}`, person: null };
    case "buyer_downloads_changed": return { text: d.allowDownloads ? `You allowed ${buyer} to download` : `You made the room view-only for ${buyer}`, person: null };
    case "request_resolved": {
      const what = typeof d.text === "string" && d.text ? `'${d.text}'` : "a document";
      if (d.how === "ask_seller") return { text: `You asked the seller for ${what} (${buyer} asked for it)`, person: null };
      if (d.how === "declined") return { text: `You declined ${buyer}'s request for ${what}`, person: null };
      if (d.how === "room_access") return { text: `You gave ${buyer} the data room`, person: null };
      return { text: `You shared ${doc} with ${buyer} (they asked for ${what})`, person: null };
    }
    case "request_ready": return { text: `The seller uploaded a document ${buyer} asked for`, person: null };
    case "seller_emailed": return { text: `You emailed the seller about ${n("count") || 1} ${n("count") > 1 ? "documents" : "document"}${d.demo ? " (example deal: recorded, not sent)" : ""}`, person: null };
    case "told_buyer": return { text: `You told ${buyer} about ${doc}${d.demo ? " (example deal: recorded, not sent)" : ""}`, person: null };
    case "buyers_emailed": return { text: `You emailed ${n("count") || 1} ${n("count") > 1 ? "buyers" : "buyer"} about new documents${d.demo ? " (example deal: recorded, not sent)" : ""}`, person: null };
    case "team_requested": return { text: `${buyer} asked to add someone from their team`, person: null };
    case "team_added": return { text: `You added someone from ${buyer}'s team`, person: null };
    case "team_link_sent": return { text: `You sent ${buyer}'s team member their link`, person: null };
    case "team_removed": return { text: `You removed someone from ${buyer}'s team`, person: null };
    case "team_acknowledged": return { text: `${who} accepted the confidentiality terms`, person };
    case "todo_dismissed": return { text: "You set a to-do aside", person: null };
    default: return { text: actionLabel(row.action), person: null };
  }
}

export type LogFilter = { buyer?: string | null; person?: string | null; item?: string | null; action?: string | null; from?: Date | null; to?: Date | null };

/** The full log, filtered, newest first. `person` is a team member id, or "principal". */
export function activityLog(rows: ReadonlyArray<VdrActivity>, ctx: Pick<ReportContext, "items" | "numbers" | "accessRows" | "team">, f: LogFilter = {}): ActivityLogRow[] {
  return rows
    .filter((r) => !f.buyer || r.buyerEmail === f.buyer)
    .filter((r) => !f.person || (f.person === "principal" ? r.actorKind === "buyer" : r.actorKind === "team" && r.actorId === f.person))
    .filter((r) => !f.item || r.itemId === f.item)
    .filter((r) => !f.action || r.action === f.action)
    .filter((r) => !f.from || new Date(r.at).getTime() >= f.from.getTime())
    .filter((r) => !f.to || new Date(r.at).getTime() <= f.to.getTime())
    .slice()
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .map((r) => {
      const s = logSentence(r, ctx);
      // The time is shown by the broker's browser, in their own time zone.
      return { id: r.id, at: new Date(r.at).toISOString(), action: r.action, actorKind: r.actorKind, text: s.text, buyerKey: r.buyerEmail ?? null, itemId: r.itemId ?? null, person: s.person };
    });
}

/** The log as CSV (UTC times; formula-safe). */
export function activityCsv(rows: ReadonlyArray<ActivityLogRow>, ctx: Pick<ReportContext, "items" | "numbers" | "accessRows">): string {
  const head = ["When (UTC)", "What happened", "Buyer", "Buyer email", "Person", "Document number", "Document"].map(csvCell).join(",");
  const lines = rows.map((r) => {
    const item = r.itemId ? ctx.items.find((i) => i.id === r.itemId) : null;
    return [r.at.slice(0, 16).replace("T", " "), r.text, r.buyerKey ? labelForKey(r.buyerKey, ctx.accessRows) : "", r.buyerKey ?? "", r.person ?? "", item ? ctx.numbers.get(item.id) ?? "" : "", item?.title ?? ""].map(csvCell).join(",");
  });
  return "﻿" + [head, ...lines].join("\r\n") + "\r\n";
}

/** A trace code from a leaked page → the view(s) it came from (§9.7). */
export function findTrace(views: ReadonlyArray<VdrView>, q: string, ctx: Pick<ReportContext, "items" | "numbers" | "accessRows" | "team">): TraceHit[] {
  const t = q.trim().toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (t.length !== 6) return [];
  return views
    .filter((v) => v.trace === t)
    .slice(0, 20)
    .map((v) => {
      const it = ctx.items.find((i) => i.id === v.itemId);
      const m = v.teamMemberId ? ctx.team.find((x) => x.id === v.teamMemberId) : null;
      return {
        trace: t,
        at: new Date(v.startedAt).toISOString(),
        buyerLabel: labelForKey(v.buyerEmail, ctx.accessRows),
        email: v.buyerEmail,
        person: m ? `${m.name} (${m.role})` : v.source === "preview" ? "You (preview)" : null,
        itemId: v.itemId,
        number: ctx.numbers.get(v.itemId) ?? null,
        title: it?.title ?? "A document no longer in the room",
      };
    });
}

// ── Other screens (§9.4 timeline, §11.4 analytics) ─────────────────────────

export type TimelineLike = { id: string; at: string; kind: "data_room"; title: string; detail?: string | null; dealId?: string | null; tone?: "positive" | "negative" | "neutral" };

/**
 * The buyer profile's "data_room" timeline events for one buyer's links:
 * "Given the data room", "Opened 6 documents in the data room · 22 min" (one
 * per day), "Downloaded 'T2 2023'", "Asked for a document", "Added their
 * accountant to the data room".
 */
export function vdrTimelineEvents(
  i: {
    accesses: ReadonlyArray<Pick<BuyerAccess, "id" | "dealId" | "buyerEmail">>;
    views: ReadonlyArray<VdrView>;
    activity: ReadonlyArray<VdrActivity>;
    items: ReadonlyArray<Pick<VdrItem, "id" | "title">>;
  },
  /** Seconds → "22 min" (the profile's own formatter). */
  fmtDuration: (seconds: number) => string,
): TimelineLike[] {
  const out: TimelineLike[] = [];
  const keysByDeal = new Map<string, Set<string>>();
  for (const a of i.accesses) {
    const set = keysByDeal.get(a.dealId) ?? new Set<string>();
    set.add(buyerKey(a.buyerEmail));
    keysByDeal.set(a.dealId, set);
  }
  const mine = (dealId: string, key: string | null | undefined) => !!key && !!keysByDeal.get(dealId)?.has(key);
  // Opened documents, one line per deal per day.
  const days = new Map<string, { dealId: string; at: number; docs: Set<string>; ms: number }>();
  for (const v of i.views) {
    if (!counted(v) || !mine(v.dealId, v.buyerEmail)) continue;
    const day = new Date(v.startedAt).toISOString().slice(0, 10);
    const k = `${v.dealId}|${day}`;
    const e = days.get(k) ?? { dealId: v.dealId, at: 0, docs: new Set<string>(), ms: 0 };
    e.docs.add(v.itemId);
    e.ms += v.activeMs ?? 0;
    e.at = Math.max(e.at, new Date(v.lastSeenAt).getTime());
    days.set(k, e);
  }
  for (const [k, e] of Array.from(days.entries())) {
    out.push({ id: `vdr-day-${k}`, at: new Date(e.at).toISOString(), kind: "data_room", title: `Opened ${e.docs.size} ${e.docs.size === 1 ? "document" : "documents"} in the data room${e.ms >= 1000 ? ` · ${fmtDuration(Math.round(e.ms / 1000))}` : ""}`, dealId: e.dealId });
  }
  const title = (id: string | null | undefined) => i.items.find((x) => x.id === id)?.title ?? null;
  for (const r of i.activity) {
    if (!mine(r.dealId, r.buyerEmail)) continue;
    const d = (r.detail ?? {}) as Record<string, any>;
    const at = new Date(r.at).toISOString();
    if (r.action === "buyer_room_changed" && d.roomAccess && d.roomAccess !== "off") out.push({ id: `vdr-${r.id}`, at, kind: "data_room", title: "Given the data room", dealId: r.dealId, tone: "positive" });
    else if (r.action === "buyer_room_changed" && d.roomAccess === "off") out.push({ id: `vdr-${r.id}`, at, kind: "data_room", title: "Data room turned off for them", dealId: r.dealId });
    else if (r.action === "buyer_downloaded") out.push({ id: `vdr-${r.id}`, at, kind: "data_room", title: title(r.itemId) ? `Downloaded '${title(r.itemId)}' from the data room` : "Downloaded a document from the data room", dealId: r.dealId });
    else if (r.action === "buyer_requested") out.push({ id: `vdr-${r.id}`, at, kind: "data_room", title: d.kind === "room_access" ? "Asked for access to the data room" : (d.count ?? 1) > 1 ? `Asked for ${d.count} documents` : "Asked for a document", dealId: r.dealId });
    else if (r.action === "team_added" || r.action === "team_requested") out.push({ id: `vdr-${r.id}`, at, kind: "data_room", title: `Added their ${typeof d.role === "string" ? d.role : "adviser"} to the data room`, dealId: r.dealId });
  }
  return out;
}

/** Per buyer, the last 7 days in the data room (analytics' proposed "data_room_diligence" signal, §11.4). */
export function vdrSignals(
  views: ReadonlyArray<VdrView>,
  items: ReadonlyArray<Pick<VdrItem, "id" | "folderId">>,
  financialFolderIds: ReadonlySet<string>,
  now: Date,
): Map<string, { activeMs7d: number; docsOpened7d: number; financialMs7d: number; downloads7d: number; teamMembersActive7d: number; lastAt: string | null }> {
  const since = now.getTime() - 7 * 86_400_000;
  const out = new Map<string, { activeMs7d: number; docsOpened7d: number; financialMs7d: number; downloads7d: number; teamMembersActive7d: number; lastAt: string | null }>();
  const docs = new Map<string, Set<string>>();
  const team = new Map<string, Set<string>>();
  for (const v of views) {
    if (!counted(v) || new Date(v.lastSeenAt).getTime() < since) continue;
    const s = out.get(v.buyerEmail) ?? { activeMs7d: 0, docsOpened7d: 0, financialMs7d: 0, downloads7d: 0, teamMembersActive7d: 0, lastAt: null };
    s.activeMs7d += v.activeMs ?? 0;
    const folder = items.find((i) => i.id === v.itemId)?.folderId;
    if (folder && financialFolderIds.has(folder)) s.financialMs7d += v.activeMs ?? 0;
    s.downloads7d += v.downloaded ? 1 : 0;
    if (!s.lastAt || new Date(v.lastSeenAt).getTime() > new Date(s.lastAt).getTime()) s.lastAt = new Date(v.lastSeenAt).toISOString();
    const d = docs.get(v.buyerEmail) ?? new Set<string>();
    d.add(v.itemId);
    docs.set(v.buyerEmail, d);
    if (v.teamMemberId) {
      const t = team.get(v.buyerEmail) ?? new Set<string>();
      t.add(v.teamMemberId);
      team.set(v.buyerEmail, t);
    }
    out.set(v.buyerEmail, s);
  }
  for (const [k, s] of Array.from(out.entries())) {
    s.docsOpened7d = docs.get(k)?.size ?? 0;
    s.teamMembersActive7d = team.get(k)?.size ?? 0;
  }
  return out;
}
