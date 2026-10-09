/**
 * "Waiting on you" — the broker's To do list for the data room (vdr spec
 * §5.8). Pure: built from what the tab already loaded. Every row has its own
 * one-click action on the client; nothing here shares or sends anything.
 *
 * Order (the spec's table): buyer requests (a pasted list is one row) ·
 * team members a buyer asked to add ·
 * requests ready to share · document questions · new seller versions ·
 * new files in a folder the plan shares · flags that need a look · what the
 * DD CIM points to · descriptions to accept · links ending · shared files the
 * seller removed. Items the broker set aside ("Not now" / "Dismiss") stay
 * set aside: their keys are in `dismissed`.
 */
import type { BuyerAccess, BuyerQuestion, VdrItem, VdrRequest, VdrShare, VdrTeamMember } from "@shared/schema";
import { VDR_LIMITS, buyerKey, shownQuestionPage } from "@shared/vdr";
import type { RoomBuyerRow, RoomItemRow, WaitingItem } from "@shared/vdr-api";
import { newInHintedFolder } from "./auto-file";
import { readersOf, type BuyerGroup } from "./broker-room";

export type WaitingInput = {
  now: Date;
  items: ReadonlyArray<RoomItemRow>;
  rawItems: ReadonlyArray<VdrItem>;
  folders: ReadonlyArray<{ id: string; number: string; name: string; shareHint: { levels: string[] } | null }>;
  shares: ReadonlyArray<VdrShare>;
  groups: ReadonlyArray<BuyerGroup>;
  buyers: ReadonlyArray<RoomBuyerRow>;
  accessRows: ReadonlyArray<BuyerAccess>;
  requests: ReadonlyArray<VdrRequest>;
  questions: ReadonlyArray<Pick<BuyerQuestion, "id" | "status" | "vdrItemId" | "vdrPage" | "vdrTeamMemberId" | "buyerAccessId" | "createdAt">>;
  team: ReadonlyArray<Pick<VdrTeamMember, "id" | "name" | "role" | "principalEmail"> & Partial<Pick<VdrTeamMember, "status" | "email" | "createdAt" | "addedViaAccessId">>>;
  dismissed: ReadonlySet<string>;
  ddCited: { available: boolean; total: number; notShared: number };
  /** Document names (a seller's upload may not be in the room yet). */
  docNames?: ReadonlyMap<string, string>;
};

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** "Northgate Pharmacy Group" — the buyer's company, else name, else email. */
export function buyerLabelFor(key: string, groups: ReadonlyArray<BuyerGroup>, accessRows: ReadonlyArray<BuyerAccess> = []): string {
  const g = groups.find((x) => x.key === key);
  const link = g?.eligible ?? g?.rows[0] ?? accessRows.find((a) => buyerKey(a.buyerEmail) === key) ?? null;
  return (link?.buyerCompany && link.buyerCompany.trim()) || (link?.buyerName && link.buyerName.trim()) || link?.buyerEmail || key;
}

const ROLE_WORD: Record<string, string> = { accountant: "accountant", lawyer: "lawyer", lender: "lender", adviser: "adviser", colleague: "colleague" };
/** "Priya Shah (Northgate's accountant)" for a team member, else the buyer. */
export function askerLabel(buyerLabel: string, member: Pick<VdrTeamMember, "name" | "role"> | null | undefined): string {
  if (!member) return buyerLabel;
  return `${member.name} (${buyerLabel}'s ${ROLE_WORD[member.role] ?? "adviser"})`;
}

function ago(at: Date | string, now: Date): string {
  const ms = now.getTime() - new Date(at).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) {
    const h = Math.floor(ms / 3_600_000);
    return h <= 0 ? "just now" : h === 1 ? "an hour ago" : `${h} hours ago`;
  }
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function waitingItems(i: WaitingInput): WaitingItem[] {
  const out: WaitingItem[] = [];
  const live = i.items.filter((x) => !x.removed);
  const byId = new Map(i.items.map((x) => [x.id, x]));
  const label = (key: string) => buyerLabelFor(key, i.groups, i.accessRows);

  // 1. Buyer requests (open). A pasted list is one row.
  const open = i.requests.filter((r) => r.status === "open");
  const seenLists = new Set<string>();
  for (const r of open.slice().sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())) {
    if (r.listId) {
      if (seenLists.has(r.listId)) continue;
      seenLists.add(r.listId);
      const n = i.requests.filter((x) => x.listId === r.listId).length;
      const waiting = open.filter((x) => x.listId === r.listId).length;
      out.push({ key: `list:${r.listId}`, kind: "request", text: `${label(r.buyerEmail)} sent a list of ${n} requests${waiting < n ? ` (${waiting} still open)` : ""} · ${ago(r.createdAt, i.now)}`, at: iso(r.createdAt), requestId: r.id, buyerLabel: label(r.buyerEmail) });
      continue;
    }
    const member = r.teamMemberId ? i.team.find((t) => t.id === r.teamMemberId) : null;
    const who = askerLabel(label(r.buyerEmail), member);
    const text = r.kind === "room_access"
      ? `${who} asked for access to the data room · ${ago(r.createdAt, i.now)}`
      : `${who} asked for: '${r.text.length > 140 ? `${r.text.slice(0, 139)}…` : r.text}' · ${ago(r.createdAt, i.now)}`;
    out.push({ key: `req:${r.id}`, kind: "request", text, at: iso(r.createdAt), requestId: r.id, buyerLabel: label(r.buyerEmail) });
  }

  // 1b. A buyer asked to add someone from their team (Approve and send the link · Decline).
  for (const m of i.team.filter((x) => x.status === "requested")) {
    const role = ROLE_WORD[m.role] ?? "adviser";
    out.push({ key: `team:${m.id}`, kind: "team_request", text: `${label(m.principalEmail)} asked to add ${m.name} (${role}${m.email ? `, ${m.email}` : ""}) to the data room${m.createdAt ? ` · ${ago(m.createdAt, i.now)}` : ""}`, at: iso(m.createdAt ?? null), teamMemberId: m.id, teamMemberName: m.name, accessId: m.addedViaAccessId ?? null, buyerLabel: label(m.principalEmail) });
  }

  // 2. Ready to share: the seller uploaded what a buyer asked for.
  for (const r of i.requests.filter((x) => x.status === "ready_to_share")) {
    const item = r.readyDocumentId ? live.find((x) => x.documentId === r.readyDocumentId) ?? null : null;
    const name = item?.title ?? item?.doc?.name ?? (r.readyDocumentId ? i.docNames?.get(r.readyDocumentId) : null) ?? "a document";
    out.push({ key: `ready:${r.id}`, kind: "request_ready", text: `The seller uploaded '${name}' that ${label(r.buyerEmail)} asked for.`, at: iso(r.createdAt), requestId: r.id, itemId: item?.id ?? null, buyerLabel: label(r.buyerEmail) });
  }

  // 3. Document questions waiting for the broker.
  for (const q of i.questions.filter((x) => x.vdrItemId && x.status === "pending_broker")) {
    const item = byId.get(q.vdrItemId!);
    const link = i.accessRows.find((a) => a.id === q.buyerAccessId) ?? null;
    const key = link ? buyerKey(link.buyerEmail) : "";
    const member = q.vdrTeamMemberId ? i.team.find((t) => t.id === q.vdrTeamMemberId) : null;
    const who = askerLabel(key ? label(key) : "A buyer", member);
    const where = item ? `${item.number ? `${item.number} ` : ""}${item.title}` : "a document";
    out.push({ key: `q:${q.id}`, kind: "question", text: `${who} asked about ${where}${shownQuestionPage(item?.prepared?.kind, q.vdrPage) ? ` page ${q.vdrPage}` : ""}`, at: iso(q.createdAt), questionId: q.id, itemId: item?.id ?? null });
  }

  // 4. A new version from the seller whose old version buyers could open.
  for (const it of live.filter((x) => x.newVersion?.oldWasShared)) {
    const old = i.rawItems.find((x) => x.id === it.newVersion!.replaces);
    const oldShares = i.shares.filter((s) => s.itemId === old?.id);
    const n = readersOf(i.groups, oldShares, it.isLedger).size;
    out.push({ key: `ver:${it.id}`, kind: "new_version", text: `New version from the seller: '${it.title}'. The old one was shared with ${n === 0 ? "buyers" : `${n} ${n === 1 ? "buyer" : "buyers"}`}.`, at: iso(it.addedAt), itemId: it.id });
  }

  // 5. A new file in a folder the plan shares: "Share it like the rest?" (never shared on its own).
  const hinted = newInHintedFolder(i.folders, i.rawItems, i.shares);
  for (const h of hinted) {
    const it = live.find((x) => x.id === h.itemId);
    // A file that needs the broker's check shows as that check first (sharing it would wait for the tick anyway).
    if (!it || it.newVersion || it.unchecked.length > 0 || i.dismissed.has(`hint:${h.itemId}`)) continue;
    const f = i.folders.find((x) => x.id === h.folderId);
    out.push({ key: `hint:${h.itemId}`, kind: "hinted", text: `New in ${f ? `${f.number} ${f.name}` : "a shared folder"}: '${it.title}'. Share it like the rest?`, at: iso(it.addedAt), itemId: it.id, levels: h.levels });
  }

  // 6. Flags that need a look (a shared one is held back from buyers until ticked).
  for (const it of live.filter((x) => x.unchecked.length > 0)) {
    const flags = it.flags.filter((f) => it.unchecked.includes(f.key));
    out.push({ key: `flag:${it.id}`, kind: "flag", text: `${it.number ? `${it.number} ` : ""}${it.title}`, at: iso(it.addedAt), itemId: it.id, flags, shared: it.sharing.shared });
  }

  // 7. What the DD CIM points to that due-diligence buyers can't open yet.
  if (i.ddCited.available && i.ddCited.notShared > 0 && !i.dismissed.has("dd_cited")) {
    out.push({ key: "dd_cited", kind: "dd_cited", text: `The DD CIM points to ${i.ddCited.total} ${i.ddCited.total === 1 ? "document" : "documents"}. ${i.ddCited.notShared} ${i.ddCited.notShared === 1 ? "isn't" : "aren't"} shared with due diligence buyers.`, at: null });
  }

  // 8. Descriptions Cimple wrote for shared documents, waiting for the broker.
  const drafted = live.filter((x) => x.sharing.shared && x.summary.status === "drafted" && !!x.summary.text);
  if (drafted.length > 0) {
    out.push({ key: "descriptions", kind: "descriptions", text: `Cimple wrote descriptions for ${drafted.length} shared ${drafted.length === 1 ? "document" : "documents"}. Buyers see a basic line until you accept ${drafted.length === 1 ? "it" : "them"}.`, at: null, itemIds: drafted.map((x) => x.id) });
  }

  // 9. Links ending within 5 days for buyers with the room.
  for (const b of i.buyers.filter((x) => x.hasRoom && x.endsInDays != null && x.endsInDays <= VDR_LIMITS.expiryWarnDays)) {
    const who = b.company || b.name || b.email;
    out.push({ key: `end:${b.key}`, kind: "link_ending", text: `${who}'s access ends ${b.endsInDays === 0 ? "today" : `in ${b.endsInDays} ${b.endsInDays === 1 ? "day" : "days"}`}.`, at: b.expiresAt, accessId: b.accessId, buyerLabel: who });
  }

  // 10. A shared file the seller removed (Dismiss = "Remove from the list").
  for (const it of i.items.filter((x) => x.removed && x.removed.reason === "seller_removed" && x.removed.wasShared)) {
    const n = it.removed!.buyersCouldOpen;
    out.push({ key: `removed:${it.id}`, kind: "seller_removed", text: `The seller removed '${it.title}', which ${n > 0 ? `${n} ${n === 1 ? "buyer" : "buyers"}` : "buyers"} could open.`, at: it.removed!.at, itemId: it.id });
  }
  return out;
}
