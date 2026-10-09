/**
 * "What buyers read most" across the broker's CIMs (spec §3.4, §8.1). Pure.
 *
 *   by topic   reading per page role (Financials, Customers, Price & deal
 *              terms …) against the time a careful read of what was opened
 *              needs — works with page-level (old-tracker) reading too
 *   by kind    tables vs charts vs text — ONLY from part-by-part reading: a
 *              (buyer, page) pair counts when that buyer has block counters
 *              on that page. Page-level reading alone leaves it empty
 *              (hasPartByPart false) instead of claiming buyers "skipped"
 *              every kind (the old panel's P4 bug)
 *   by layout  reading per layout type (as the old "Your deals compared")
 *
 * Front matter and locked pages never count. Teaser-only links have no CIM
 * reading and are left out.
 */
import { blockId, type DealReadingFacts, type KindAttention, type LayoutAttention } from "@shared/analytics-v2";
import type { RoleAttention } from "@shared/analytics-dashboard";
import { KIND_GROUPS, kindGroupOf, type KindGroup } from "@shared/cim-blocks";
import { getCimLayout } from "@shared/cim-layouts";
import { PAGE_ROLE_TEXT } from "@shared/cim-page-role";
import type { CaptureFacts } from "../engagement/facts";
import { cimOnly } from "./kpis";

type Items = Array<{ facts: CaptureFacts | DealReadingFacts }>;

const KIND_LABEL = new Map<string, string>(KIND_GROUPS.map((g) => [g.key, g.label]));

function layoutLabel(layoutType: string): string {
  return getCimLayout(layoutType)?.label ?? layoutType.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const cim = (f: CaptureFacts | DealReadingFacts) => cimOnly(f as CaptureFacts);

/** The buyer has part-level counters on this page (attention + skim + visible > 0). */
function hasBlockCounters(b: { blocks: Record<string, [number, number, number, number]> }, pageId: string): boolean {
  const prefix = `${pageId}|`;
  for (const [k, c] of Object.entries(b.blocks)) {
    if (k.startsWith(prefix) && c[0] + c[1] + c[2] > 0) return true;
  }
  return false;
}

/** Any part-by-part reading at all (the "By kind" panel shows only then). */
export function hasPartByPart(items: Items): boolean {
  for (const { facts } of items) {
    for (const b of cim(facts).buyers) {
      if (b.visits.length === 0) continue;
      for (const p of facts.pages) {
        if (p.role === "front_matter" || p.locked) continue;
        if (hasBlockCounters(b, p.pageId)) return true;
      }
    }
  }
  return false;
}

export function roleAttention(items: Items): RoleAttention[] {
  const roles = new Map<string, { att: number; exp: number; readers: Set<string>; pages: Set<string> }>();
  for (const { facts } of items) {
    for (const b of cim(facts).buyers) {
      if (b.visits.length === 0) continue;
      for (const p of facts.pages) {
        if (p.role === "front_matter" || p.locked) continue;
        const r = b.pages[`${p.pageId}#${p.part}`];
        if (!r || r.attentionMs <= 0) continue;
        const acc = roles.get(p.role) ?? { att: 0, exp: 0, readers: new Set<string>(), pages: new Set<string>() };
        acc.att += r.attentionMs;
        acc.exp += p.expectedMs;
        acc.readers.add(`${facts.dealId}|${b.accessId}`);
        acc.pages.add(`${facts.dealId}|${p.pageId}|${p.part}`);
        roles.set(p.role, acc);
      }
    }
  }
  const ratio = (x: { att: number; exp: number }) => (x.exp > 0 ? x.att / x.exp : 0);
  return Array.from(roles.entries())
    .map(([role, x]) => ({
      role: role as RoleAttention["role"],
      label: PAGE_ROLE_TEXT[role as RoleAttention["role"]] ?? role,
      attentionMs: Math.round(x.att),
      expectedMs: Math.round(x.exp),
      readers: x.readers.size,
      pages: x.pages.size,
    }))
    .sort((a, b) => ratio({ att: b.attentionMs, exp: b.expectedMs }) - ratio({ att: a.attentionMs, exp: a.expectedMs }) || b.attentionMs - a.attentionMs);
}

export function kindAttention(items: Items): KindAttention[] {
  const kinds = new Map<KindGroup, { att: number; exp: number; blocks: Set<string> }>();
  for (const { facts } of items) {
    for (const b of cim(facts).buyers) {
      if (b.visits.length === 0) continue;
      for (const p of facts.pages) {
        if (p.role === "front_matter" || p.locked) continue;
        const r = b.pages[`${p.pageId}#${p.part}`];
        if (!r || r.attentionMs <= 0) continue;
        if (!hasBlockCounters(b, p.pageId)) continue; // page totals only: not evidence about kinds
        for (const bl of p.blocks) {
          if (bl.virtual || bl.when || bl.part !== p.part || bl.kind === "column" || bl.kind === "point") continue;
          const g = kindGroupOf(bl.kind);
          const k = kinds.get(g) ?? { att: 0, exp: 0, blocks: new Set<string>() };
          k.att += b.blocks[blockId(p.pageId, bl.key)]?.[0] ?? 0;
          k.exp += bl.expectedMs;
          k.blocks.add(`${facts.dealId}|${p.pageId}|${bl.key}`);
          kinds.set(g, k);
        }
      }
    }
  }
  return Array.from(kinds.entries())
    .filter(([g]) => g !== "other")
    .map(([group, k]) => ({ group, label: KIND_LABEL.get(group) ?? group, attentionMs: Math.round(k.att), expectedMs: Math.round(k.exp), blocks: k.blocks.size }))
    .sort((a, b) => b.attentionMs - a.attentionMs);
}

export function layoutAttention(items: Items): LayoutAttention[] {
  const layouts = new Map<string, { att: number; exp: number; pages: Set<string> }>();
  for (const { facts } of items) {
    for (const b of cim(facts).buyers) {
      if (b.visits.length === 0) continue;
      for (const p of facts.pages) {
        if (p.role === "front_matter" || p.locked) continue;
        const r = b.pages[`${p.pageId}#${p.part}`];
        if (!r || r.attentionMs <= 0) continue;
        const l = layouts.get(p.layoutType) ?? { att: 0, exp: 0, pages: new Set<string>() };
        l.att += r.attentionMs;
        l.exp += p.expectedMs;
        l.pages.add(`${facts.dealId}|${p.pageId}|${p.part}`);
        layouts.set(p.layoutType, l);
      }
    }
  }
  return Array.from(layouts.entries())
    .map(([layoutType, l]) => ({ layoutType, label: layoutLabel(layoutType), attentionMs: Math.round(l.att), expectedMs: Math.round(l.exp), pages: l.pages.size }))
    .sort((a, b) => b.attentionMs - a.attentionMs);
}

/** "Based on {n} buyers across {k} deals · {total reading}." */
export function attentionBasis(items: Items): { buyers: number; deals: number; attentionMs: number } {
  let buyers = 0;
  let deals = 0;
  let att = 0;
  for (const { facts } of items) {
    let dealHas = false;
    for (const b of cim(facts).buyers) {
      if (b.visits.length === 0) continue;
      let mine = 0;
      for (const p of facts.pages) {
        if (p.role === "front_matter" || p.locked) continue;
        mine += b.pages[`${p.pageId}#${p.part}`]?.attentionMs ?? 0;
      }
      if (mine > 0) {
        buyers++;
        dealHas = true;
        att += mine;
      }
    }
    if (dealHas) deals++;
  }
  return { buyers, deals, attentionMs: Math.round(att) };
}
