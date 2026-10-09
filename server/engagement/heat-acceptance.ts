/**
 * The heat map's acceptance check (heat-map spec §7.3, release gate §8):
 * does the Document view the founder opens actually show colour? Run by
 * scripts/check-demo-heat.ts (and after scripts/seed-demo-reading.ts
 * --apply) over the very response the Engagement tab's GET builds —
 * loadDealReadingFacts + buildDocumentResponse — with no writes and no
 * sign-in. Pure: it only reads the response. No AI.
 */
import type { DocumentPage, EngagementDocumentResponse } from "@shared/analytics-v2";
import { headingKey } from "@shared/cim-blocks";

export type HeatExpect = "pacific" | "beacon";

const COLOURED = new Set(["parts", "mixed"]);
const fmt = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`;
};

/** One line per viewer page: label, title, basis, reading time, readers, recorded. */
export function heatTable(doc: EngagementDocumentResponse): string[] {
  return doc.pages.map((p) => [
    p.label.padStart(4),
    (p.title.length > 44 ? `${p.title.slice(0, 43)}…` : p.title).padEnd(45),
    p.heat.basis.padEnd(6),
    fmt(p.attentionMs).padStart(13),
    `${p.readers} reader${p.readers === 1 ? "" : "s"}`.padEnd(11),
    p.reachRecorded ? "" : "not recorded",
  ].join("  ").trimEnd());
}

/** Distinct pages (a split page's parts count once) and how many of them are coloured part by part. */
function distinctPages(doc: EngagementDocumentResponse): { all: string[]; coloured: string[] } {
  const by = new Map<string, DocumentPage[]>();
  for (const p of doc.pages) by.set(p.pageId, [...(by.get(p.pageId) ?? []), p]);
  const all = Array.from(by.keys());
  const coloured = all.filter((id) => by.get(id)!.some((p) => COLOURED.has(p.heat.basis)));
  return { all, coloured };
}

/**
 * Pass/fail with the failing lines. Generic: every page with ≥ 1 s of
 * reading is coloured part by part (never a whole-page wash), the reading is
 * marked as sample data (skipped in --qa-copy-preview, which has no tag),
 * and no page carries another page's title (the page-19 mix-up). Then the
 * deal's own expectations (pacific / beacon). --preview (untagged sample
 * visits) skips what depends on the tag: the sample flag and the reach basis.
 */
export function heatAcceptance(
  doc: EngagementDocumentResponse,
  expect: HeatExpect | null,
  opts: { preview?: boolean } = {},
): { pass: boolean; lines: string[] } {
  const fails: string[] = [];
  const read = doc.pages.filter((p) => p.attentionMs >= 1000);
  for (const p of read) {
    if (!COLOURED.has(p.heat.basis)) fails.push(`page ${p.label} “${p.title}” has ${fmt(p.attentionMs)} of reading but is shaded as a whole page (basis ${p.heat.basis})`);
  }
  if (!opts.preview && !doc.sampleReading) fails.push("the reading isn't marked as sample data (sampleReading is false)");
  // The page-19 mix-up: a page titled with the page that continues it, or two pages with one title.
  for (const p of doc.pages) {
    if (p.update && p.update.status === "renamed" && headingKey(p.update.title) === headingKey(p.title)) {
      fails.push(`page ${p.label} is titled “${p.title}”, the title of the page that continues it`);
    }
  }
  const titles = new Map<string, string>();
  for (const p of doc.pages) {
    const k = headingKey(p.title);
    const prev = titles.get(k);
    if (prev && prev !== p.pageId) fails.push(`two different pages are both titled “${p.title}”`);
    titles.set(k, p.pageId);
  }
  const { all, coloured } = distinctPages(doc);

  if (expect === "pacific") {
    const capex = doc.pages.filter((p) => headingKey(p.title) === headingKey("Capital Expenditures & Fleet Replacement"));
    if (capex.length === 0) fails.push("no page is titled “Capital Expenditures & Fleet Replacement”");
    else if (!capex.some((p) => COLOURED.has(p.heat.basis))) fails.push(`“Capital Expenditures & Fleet Replacement” isn't coloured part by part (basis ${capex[0].heat.basis})`);
    if (doc.pages.some((p) => headingKey(p.title) === headingKey("Working Capital Summary"))) {
      fails.push("a page buyers read is titled “Working Capital Summary” (the version buyers read has no such page)");
    }
    if (coloured.length < 24) fails.push(`only ${coloured.length} of ${all.length} pages are coloured part by part (need ≥ 24)`);
    if (doc.openedTotal !== 13) fails.push(`“opened it” is ${doc.openedTotal}, expected 13`);
    if (doc.openedBy !== 12) fails.push(`“with reading recorded” is ${doc.openedBy}, expected 12`);
    // Preview mode writes untagged visits, which read as part-by-part tracking
    // (reach from each visit's furthest page): the reach basis needs the tag.
    if (!opts.preview) {
      if (doc.reachBasis !== "old_tracking") fails.push(`reach basis is ${doc.reachBasis}, expected old_tracking`);
      const last = doc.lastRecordedIndex != null ? doc.pages[doc.lastRecordedIndex] : null;
      if (!last || last.label !== "27") fails.push(`the last recorded page is ${last ? last.label : "none"}, expected 27`);
    }
  }
  if (expect === "beacon") {
    if (doc.versionNote?.kind !== "held" || (!opts.preview && !doc.versionNote.sample)) {
      fails.push(`the version note is ${JSON.stringify(doc.versionNote)}, expected held${opts.preview ? "" : " with sample"}`);
    }
    if (coloured.length < 14) fails.push(`only ${coloured.length} of ${all.length} pages are coloured part by part (need ≥ 14)`);
    const unmatched = doc.legacyUnmatched?.pages ?? [];
    if (unmatched.length < 3) fails.push(`earlier reading on pages this version doesn't have: ${unmatched.length} page(s) reported, expected 3`);
    // The pages new in the rebuild have no reading: never a drop, never "skipped".
    if (!opts.preview) {
      if (!doc.reachHeadline) fails.push("there is no “how far buyers got” sentence");
      const pageMs = new Map<string, number>();
      for (const p of doc.pages) pageMs.set(p.pageId, (pageMs.get(p.pageId) ?? 0) + p.attentionMs);
      for (const p of doc.pages.filter((x) => pageMs.get(x.pageId) === 0 && x.reachRecorded)) {
        fails.push(`page ${p.label} “${p.title}” has no reading but counts as recorded (it can show a drop or “skipped”)`);
      }
    }
  }
  // The reach sentence never names a page the old tracking couldn't record,
  // and the page it names has reading.
  if (doc.reachHeadline) {
    for (const p of doc.pages.filter((x) => !x.reachRecorded)) {
      if (doc.reachHeadline.includes(p.title)) fails.push(`the reach sentence names page ${p.label} “${p.title}”, which wasn't recorded`);
    }
    const named = /\bpage (\S+) · /.exec(doc.reachHeadline)?.[1];
    const page = named ? doc.pages.find((p) => p.label === named) : null;
    if (named && (!page || page.attentionMs < 1000)) fails.push(`the reach sentence names page ${named}, which has no reading`);
  }
  // A page nobody read never says buyers skipped it.
  for (const p of doc.pages.filter((x) => !x.reachRecorded && x.readLabel)) {
    fails.push(`page ${p.label} “${p.title}” wasn't recorded but is labelled “${p.readLabel}”`);
  }
  const lines = [
    `${coloured.length} of ${all.length} pages coloured part by part · ${read.length} with reading · opened ${doc.openedTotal} · with reading ${doc.openedBy}`
      + ` · reach ${doc.reachBasis}${doc.lastRecordedIndex != null ? ` (last recorded page ${doc.pages[doc.lastRecordedIndex]?.label ?? "?"})` : ""}`
      + ` · sample ${doc.sampleReading ? "yes" : "no"} · version note ${doc.versionNote ? doc.versionNote.kind : "none"}`,
    ...(doc.reachHeadline ? [`Reach sentence: ${doc.reachHeadline}`] : []),
    ...(doc.legacyUnmatched?.pages.length ? [`Earlier reading on pages this version doesn't have: ${doc.legacyUnmatched.pages.map((p) => `${p.label} (${fmt(p.attentionMs)})`).join(", ")}`] : []),
    ...fails.map((f) => `FAIL ${f}`),
  ];
  return { pass: fails.length === 0, lines };
}
