/**
 * held-private — what the CIM holds back about the deal's staff, as the
 * broker sees it on the CIM tab ("Held back from the CIM: … — Include").
 *
 * The list is read live from the facts (the deterministic screen, so it is
 * there before the first generation and follows every edit), plus what the
 * last generation's AI review held on top (kept on `cimGeneration`), while
 * those words are still on file. Each item carries the broker's include
 * decision; switching one on puts its words back into the CIM inputs on the
 * next generation (STAFF_PRIVATE_INCLUDED_KEY on the deal's facts).
 *
 * No model call here.
 */
import type { CimGenerationStatus, Deal } from "@shared/schema";
import { STAFF_PRIVATE_INCLUDED_KEY, type StaffPrivateItem, type StaffPrivateListItem } from "@shared/staff-private";
import { brokerFactsView, factDisplayLabel, mutateDealInfo } from "../information/facts";
import { splitFactsForCim } from "../information/cim-facts";
import { includedStaffPrivate, screenStaffPrivatePairs, staffContextFrom } from "./staff-private";

type Info = Record<string, unknown>;

/** The held items for a deal's current facts (pure over the info + last generation). */
export function heldPrivateItems(info: Info, lastRun: ReadonlyArray<StaffPrivateItem> = []): StaffPrivateListItem[] {
  const included = includedStaffPrivate(info);
  const split = splitFactsForCim(info);
  const pairs = [...split.confirmed, ...split.leads];
  // Everything the screen would hold, whatever the broker decided — an
  // included item stays listed, switched on.
  const { items } = screenStaffPrivatePairs(pairs, { ctx: staffContextFrom(info) });
  const out: StaffPrivateItem[] = [...items];
  // What only the AI review held, while the words are still in that fact.
  const factText = (key: string) => {
    const pair = pairs.find(([k]) => k === key);
    return pair ? JSON.stringify(pair[1]).toLowerCase() : "";
  };
  for (const item of lastRun) {
    if (item.by !== "ai" || out.some((o) => o.id === item.id)) continue;
    if (factText(item.key).includes(item.text.toLowerCase().slice(0, 60))) out.push(item);
  }
  return out.map((i) => ({ ...i, included: included.has(i.id), label: factDisplayLabel(info, i.key) }));
}

/** The list for a deal, as the CIM tab shows it. */
export function heldPrivateForDeal(deal: Deal): StaffPrivateListItem[] {
  const info = (brokerFactsView(deal).extractedInfo as Info | null) || {};
  const lastRun = (deal.cimGeneration as CimGenerationStatus | null | undefined)?.heldPrivate ?? [];
  return heldPrivateItems(info, lastRun);
}

/** Switch one item into (or back out of) the CIM inputs. Kept with the deal's facts. */
export async function setHeldPrivateIncluded(dealId: string, id: string, include: boolean): Promise<void> {
  await mutateDealInfo(dealId, (info) => {
    const current = Array.from(includedStaffPrivate(info));
    const next = include ? Array.from(new Set([...current, id])) : current.filter((x) => x !== id);
    if (next.length > 0) info[STAFF_PRIVATE_INCLUDED_KEY] = next;
    else delete info[STAFF_PRIVATE_INCLUDED_KEY];
  });
}
