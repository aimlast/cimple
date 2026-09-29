/**
 * Buyer Q&A helpers.
 *
 * 1. `sectionToContextText` — flattens a CIM section (prose + layoutData)
 *    into plain text for the chatbot's answer step. Most of a bespoke CIM's
 *    facts live in structured layoutData (metric grids, location cards,
 *    financial tables, two-column blocks) rather than prose, so answering
 *    from `contentOverride`/prose alone escalated questions the document
 *    already answered ("What is the monthly rent?").
 *
 * 2. `buildBuyerQuestionFeed` — the Q&A feed a buyer is allowed to see:
 *    the published answers they're entitled to (answer scope + identity
 *    check, shared/buyer-qa-scope.ts) plus the requesting buyer's own
 *    questions (so they survive a reload), each flagged with ownership.
 *    Fields are whitelisted — the seller-approval token and the broker's
 *    unapproved draft never leave the server.
 */
import { storage } from "../storage";
import { CIM_PRESENTATION_KEYS } from "@shared/cim-layouts";
import { blindLeakTerms } from "@shared/blind-guard";
import { readerMaySeeRow, rowScope } from "@shared/buyer-qa-scope";
import type { BuyerQuestion } from "@shared/schema";
import { normalizeFinancialTable } from "@shared/financial-table";
import { formatSqft, rentLabel, splitLeaseType } from "@shared/cim-location";
import { buildBuyerCim, cimHeldFromBuyers } from "@shared/cim-buyer-view";
import { cimModeForAccessLevel } from "@shared/cim-layouts";
import { isKnownFigure, knownFiguresFrom, parseFigures } from "../cim/figure-check";
import { loadMediaAssets } from "../cim/media-store";
import { loadPublishedVersions } from "../cim/published-versions";
import { listedAskingPrice } from "../information/deal-mirror";
import { stripDdMarkers } from "../cim/dd-enrichment";

type AnyRecord = Record<string, any>;

/**
 * Presentation-only keys that carry no facts — skipped by the generic walker.
 * Owned by the layout registry (shared/cim-layouts.ts): each layout declares
 * its own presentation keys (logos, media URLs, colours).
 */
const SKIP_KEYS: ReadonlySet<string> = CIM_PRESENTATION_KEYS;

/** Keep a single section's structured text bounded so the prompt stays small. */
const MAX_SECTION_CHARS = 4000;

function fmt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function withUnit(value: unknown, unit?: unknown): string {
  const v = fmt(value);
  const u = fmt(unit);
  if (!v) return "";
  return u ? `${v} ${u}` : v;
}

/** Generic walker for layouts without a dedicated serializer. */
function genericToLines(value: unknown, depth = 0): string[] {
  if (value == null) return [];
  if (typeof value !== "object") {
    const s = fmt(value);
    return s ? [s] : [];
  }
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item !== null && typeof item === "object"
          ? genericToLines(item, depth + 1).join("; ")
          : fmt(item),
      )
      .filter(Boolean);
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as AnyRecord)) {
    if (SKIP_KEYS.has(k) || v == null || v === "") continue;
    if (typeof v === "object") {
      const inner = genericToLines(v, depth + 1);
      if (inner.length) out.push(`${humanize(k)}: ${inner.join(depth > 0 ? "; " : "\n")}`);
    } else {
      out.push(`${humanize(k)}: ${fmt(v)}`);
    }
  }
  return out;
}

function seriesLines(data: unknown, unit?: unknown, secondaryLabel?: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((d: AnyRecord) => {
      if (!d || typeof d !== "object") return "";
      const primary = withUnit(d.value, d.unit ?? unit);
      const secondary =
        d.secondaryValue != null
          ? ` (${fmt(secondaryLabel) || "secondary"}: ${withUnit(d.secondaryValue, unit)})`
          : "";
      return primary ? `${fmt(d.name)}: ${primary}${secondary}` : "";
    })
    .filter(Boolean);
}

/**
 * Serialize one section's layoutData into plain-text facts.
 * Never throws — a malformed layoutData yields an empty string.
 */
export function serializeLayoutData(layoutType: string | null | undefined, layoutData: unknown): string {
  if (!layoutData || typeof layoutData !== "object" || Array.isArray(layoutData)) return "";
  const d = layoutData as AnyRecord;
  const lines: string[] = [];
  const push = (label: string, value: unknown) => {
    const v = fmt(value);
    if (v) lines.push(`${label}: ${v}`);
  };

  try {
    switch (layoutType) {
      case "cover_page": {
        push("Business", d.businessName);
        push("Tagline", d.tagline);
        push("Industry", d.industry);
        push("Location", d.location);
        push("Asking price", d.askingPrice);
        push("Annual revenue", d.revenue);
        push("EBITDA", d.ebitda);
        push("Date", d.date);
        break;
      }
      case "metric_grid": {
        push("Title", d.title);
        for (const m of Array.isArray(d.metrics) ? d.metrics : []) {
          if (!m) continue;
          const v = withUnit(m.value, m.unit);
          if (!v) continue;
          const delta = fmt(m.delta) ? ` (${fmt(m.delta)})` : "";
          const note = fmt(m.footnote) ? ` — ${fmt(m.footnote)}` : "";
          lines.push(`${fmt(m.label)}: ${v}${delta}${note}`);
        }
        break;
      }
      case "bar_chart":
      case "horizontal_bar_chart":
      case "pie_chart":
      case "donut_chart":
      case "waterfall_chart": {
        push("Title", d.title);
        push(fmt(d.totalLabel) || "Total", d.totalValue);
        if (fmt(d.centerLabel) || fmt(d.centerValue)) push(fmt(d.centerLabel) || "Center", d.centerValue);
        lines.push(...seriesLines(d.data, d.unit, d.secondaryLabel));
        break;
      }
      case "line_chart": {
        push("Title", d.title);
        const series: AnyRecord[] = Array.isArray(d.series) ? d.series : [];
        for (const row of Array.isArray(d.data) ? d.data : []) {
          if (!row || typeof row !== "object") continue;
          const parts = series
            .map((s) => (row[s.key] != null ? `${fmt(s.label) || fmt(s.key)} ${withUnit(row[s.key], d.unit)}` : ""))
            .filter(Boolean);
          if (parts.length) lines.push(`${fmt(row.name)}: ${parts.join(", ")}`);
        }
        break;
      }
      case "timeline": {
        push("Title", d.title);
        for (const e of Array.isArray(d.events) ? d.events : []) {
          if (!e) continue;
          const when = fmt(e.date) || fmt(e.year);
          const desc = fmt(e.description) ? ` — ${fmt(e.description)}` : "";
          lines.push(`${when ? `${when}: ` : ""}${fmt(e.title)}${desc}`);
        }
        break;
      }
      case "financial_table": {
        push("Table", d.caption);
        push("Currency", d.currency);
        // Same header/value pairing as the CIM renderer (shared/financial-table).
        const table = normalizeFinancialTable(d);
        for (const r of table.rows) {
          const label = fmt(r.label);
          if (r.isSectionHeader && r.cells.every((v) => !v)) {
            lines.push(`[${label}]`);
            continue;
          }
          const cells = r.cells
            .map((v, i) => {
              if (!v) return "";
              const h = table.columns[i];
              return h ? `${h} ${fmt(v)}` : fmt(v);
            })
            .filter(Boolean);
          if (cells.length) lines.push(`${label}: ${cells.join(" | ")}`);
        }
        for (const f of Array.isArray(d.footnotes) ? d.footnotes : []) push("Note", f);
        break;
      }
      case "comparison_table": {
        push("Title", d.title);
        const left = fmt(d.leftLabel) || "Left";
        const right = fmt(d.rightLabel) || "Right";
        for (const r of Array.isArray(d.rows) ? d.rows : []) {
          if (!r) continue;
          lines.push(`${fmt(r.label)}: ${left} ${fmt(r.left)} vs ${right} ${fmt(r.right)}`);
        }
        break;
      }
      case "callout_list":
      case "numbered_list": {
        push("Title", d.title);
        (Array.isArray(d.items) ? d.items : []).forEach((it: AnyRecord, i: number) => {
          if (!it) return;
          const badge = fmt(it.badge) ? ` [${fmt(it.badge)}]` : "";
          const desc = fmt(it.description) ? `: ${fmt(it.description)}` : "";
          lines.push(`${layoutType === "numbered_list" ? `${i + 1}. ` : ""}${fmt(it.title)}${badge}${desc}`);
        });
        break;
      }
      case "icon_stat_row": {
        push("Title", d.title);
        for (const s of Array.isArray(d.stats) ? d.stats : []) {
          if (!s) continue;
          const v = withUnit(s.value, s.unit);
          const desc = fmt(s.description) ? ` — ${fmt(s.description)}` : "";
          if (v) lines.push(`${fmt(s.label)}: ${v}${desc}`);
        }
        break;
      }
      case "prose_highlight": {
        push("Subheading", d.subheading);
        push("Body", d.body);
        push("Quote", d.pullQuote);
        for (const h of Array.isArray(d.highlights) ? d.highlights : []) push("Highlight", h);
        break;
      }
      case "two_column": {
        push("Title", d.title);
        for (const side of [d.left, d.right]) {
          if (!side || typeof side !== "object") continue;
          const content = fmt(side.content);
          if (content) lines.push(`${fmt(side.title) || "Column"}: ${content}`);
        }
        break;
      }
      case "org_chart": {
        push("Title", d.title);
        push("Total headcount", d.totalHeadcount);
        push("Owner dependency", d.ownerDependency);
        const nodes: AnyRecord[] = Array.isArray(d.nodes) ? d.nodes : [];
        const byId = new Map(nodes.map((n) => [fmt(n?.id), n]));
        for (const n of nodes) {
          if (!n) continue;
          const bits: string[] = [];
          if (n.isOwner) bits.push("owner");
          if (n.isKeyPerson) bits.push("key person");
          if (fmt(n.yearsAtCompany)) bits.push(`${fmt(n.yearsAtCompany)} at company`);
          const boss = n.reportsTo ? byId.get(fmt(n.reportsTo)) : undefined;
          if (boss) bits.push(`reports to ${fmt(boss.name)}`);
          if (fmt(n.notes)) bits.push(fmt(n.notes));
          lines.push(`${fmt(n.name)} — ${fmt(n.role)}${bits.length ? ` (${bits.join(", ")})` : ""}`);
        }
        break;
      }
      case "location_card": {
        push("Title", d.title);
        push("Total square footage", d.totalSqft);
        for (const loc of Array.isArray(d.locations) ? d.locations : []) {
          if (!loc) continue;
          const facts: string[] = [];
          if (fmt(loc.address)) facts.push(`address ${fmt(loc.address)}`);
          if (fmt(loc.sqft)) facts.push(formatSqft(fmt(loc.sqft)));
          // Worded the way the card renders it (shared/cim-location.ts): a
          // per-square-foot rate is base rent, never "annual rent $12.00 per sq ft".
          const lease = splitLeaseType(fmt(loc.leaseType).replace(/_/g, " "));
          if (lease.badge) facts.push(lease.badge);
          const terms = [lease.terms, fmt(loc.leaseTerms)].filter(Boolean).join(" ");
          if (terms) facts.push(`lease terms: ${terms}`);
          if (fmt(loc.monthlyRent)) facts.push(`${rentLabel("monthlyRent", fmt(loc.monthlyRent)).toLowerCase()} ${fmt(loc.monthlyRent)}`);
          if (fmt(loc.annualRent)) facts.push(`${rentLabel("annualRent", fmt(loc.annualRent)).toLowerCase()} ${fmt(loc.annualRent)}`);
          if (fmt(loc.leaseExpiry)) facts.push(`lease expires ${fmt(loc.leaseExpiry)}`);
          if (fmt(loc.renewalOptions)) facts.push(`renewal options ${fmt(loc.renewalOptions)}`);
          if (fmt(loc.notes)) facts.push(fmt(loc.notes));
          lines.push(`${fmt(loc.label) || "Location"}: ${facts.join("; ")}`);
        }
        break;
      }
      case "stat_callout": {
        push(fmt(d.primaryLabel) || "Headline", d.primaryValue);
        for (const s of Array.isArray(d.secondaryStats) ? d.secondaryStats : []) {
          if (s) push(fmt(s.label), s.value);
        }
        push("Description", d.description);
        break;
      }
      case "tag_cloud": {
        push("Title", d.title);
        const tags = (Array.isArray(d.tags) ? d.tags : []).map((t: AnyRecord) => fmt(t?.label)).filter(Boolean);
        if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
        break;
      }
      case "scorecard": {
        push("Title", d.title);
        const max = fmt(d.maxScore) || "100";
        for (const it of Array.isArray(d.items) ? d.items : []) {
          if (!it) continue;
          const bench = it.benchmark != null ? ` (benchmark ${fmt(it.benchmark)})` : "";
          const desc = fmt(it.description) ? ` — ${fmt(it.description)}` : "";
          lines.push(`${fmt(it.label)}: ${fmt(it.score)}/${max}${bench}${desc}`);
        }
        break;
      }
      // Media blocks: only their words (the buyer view has already reduced
      // them to what this buyer may see — region-only maps when blind).
      case "image_gallery": {
        push("Title", d.title);
        for (const img of Array.isArray(d.images) ? d.images : []) push("Photo", img?.caption || img?.alt);
        break;
      }
      case "video": {
        push("Title", d.title);
        for (const v of Array.isArray(d.items) ? d.items : []) {
          const t = [fmt(v?.title), fmt(v?.caption)].filter(Boolean).join(" — ");
          if (t) lines.push(`Video: ${t}`);
        }
        break;
      }
      case "location_map": {
        push("Title", d.title);
        for (const l of Array.isArray(d.locations) ? d.locations : []) {
          if (!l) continue;
          const where = fmt(l.address) || (fmt(l.region) ? `${fmt(l.region)} (general area only)` : "");
          const t = [fmt(l.label), where, fmt(l.note)].filter(Boolean).join(" — ");
          if (t) lines.push(`Location: ${t}`);
        }
        push("Note", d.caption);
        break;
      }
      case "divider": {
        push("Divider", d.label);
        break;
      }
      default: {
        lines.push(...genericToLines(d));
      }
    }
  } catch {
    return "";
  }

  const text = lines.filter(Boolean).join("\n");
  return text.length > MAX_SECTION_CHARS ? `${text.slice(0, MAX_SECTION_CHARS)}…` : text;
}

export interface AnswerSection {
  title: string;
  body: string;
  layoutType?: string | null;
  layoutData?: unknown;
}

/** Full plain-text rendering of one section: prose first, then structured facts. */
export function sectionToContextText(section: AnswerSection): string {
  const prose = (section.body || "").trim();
  const facts = serializeLayoutData(section.layoutType, section.layoutData);
  if (!prose && !facts) return "";
  const parts = [`## ${section.title || "Section"}`];
  if (prose) parts.push(prose);
  if (facts) parts.push(facts);
  return parts.join("\n");
}

/** Build the complete CIM context string for the answer model. */
export function buildAnswerContext(sections: AnswerSection[]): string {
  return sections.map(sectionToContextText).filter(Boolean).join("\n\n");
}

// ── Buyer question feed ───────────────────────────────────────────────────

export interface BuyerQuestionFeedItem {
  id: string;
  question: string;
  /** pending_ai | pending_broker | pending_seller | published | declined */
  status: string;
  isPublished: boolean;
  aiAnswer: string | null;
  publishedAnswer: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** True when the requesting buyer asked this question */
  isMine: boolean;
}

/** The buyer reading the feed. */
export interface QaReader {
  id: string;
  accessLevel: string | null | undefined;
}

type QaDeal = {
  id: string;
  businessName?: string | null;
  extractedInfo?: unknown;
  blindCodename?: string | null;
  isLive?: boolean | null;
  cimGeneration?: unknown;
  askingPrice?: string | null;
};

// ── Answers the AI wrote from the CIM ─────────────────────────────────────

/**
 * A published answer the AI wrote from the CIM that nobody reviewed: the
 * broker didn't draft or edit it and the seller didn't approve it. (A
 * reviewed answer is the broker's word — it stays until they change it.)
 */
export function isUnreviewedAiAnswer(q: Pick<BuyerQuestion, "aiAnswer" | "publishedAnswer" | "brokerDraft" | "sellerApproved">): boolean {
  if (!q.aiAnswer || q.sellerApproved || q.brokerDraft) return false;
  return (q.publishedAnswer ?? q.aiAnswer) === q.aiAnswer;
}

/**
 * The broker publishing an AI answer as it stands (PATCH isPublished with
 * no draft) makes it their word: the answer is recorded as their draft, so
 * it no longer counts as unreviewed and isn't withdrawn the next time any
 * section changes — an approval tick included (free round 2 check, C4).
 * Returns the draft to record, or null when there is nothing to record.
 */
export function endorsedDraftOnPublish(
  existing: Pick<BuyerQuestion, "aiAnswer" | "publishedAnswer" | "brokerDraft" | "sellerApproved" | "status">,
  body: { isPublished?: unknown; brokerDraft?: unknown; publishedAnswer?: unknown; status?: unknown },
): string | null {
  if (body.isPublished !== true || body.brokerDraft !== undefined) return null;
  if (existing.brokerDraft || existing.sellerApproved) return null;
  // Only a published answer: a draft on a question back with the broker reads as "sent back by the seller".
  if ((typeof body.status === "string" ? body.status : existing.status) !== "published") return null;
  const answer = typeof body.publishedAnswer === "string" ? body.publishedAnswer : existing.publishedAnswer ?? existing.aiAnswer;
  return typeof answer === "string" && answer.trim() ? answer : null;
}

/** What a reader's CIM says now, for checking earlier AI answers against it. */
export interface ReaderCim {
  /** The text the answer step would read for this reader (their version, sections they may open). */
  text: string;
  /** The latest change to any of the deal's sections (content, visibility, access tier, a regenerate). */
  changedAt: Date | null;
  /** A regenerated CIM waiting for the broker: nothing is answered from it. */
  held: boolean;
}

/** Figures an answer states (amounts, percentages, comma-written counts — not years). */
function answerFigures(text: string) {
  return parseFigures(text).filter((f) => f.kind !== "plain" || f.text.includes(","));
}

/**
 * Does an earlier answer still hold for this reader's CIM? A reviewed
 * answer always does. An unreviewed AI answer only when the CIM hasn't
 * changed since it was written (a regenerate, an edit, a section hidden or
 * moved to full access), the CIM isn't held for the broker's review, and
 * every figure it states is still in what this reader can see — "2024
 * revenue was $2.3M" stops being given out once the CIM says $1.82M, and a
 * concentration answer stops reaching teasers once that section is
 * full-access only (free round 2, C4).
 */
export function answerStillHolds(q: Pick<BuyerQuestion, "aiAnswer" | "publishedAnswer" | "brokerDraft" | "sellerApproved" | "createdAt" | "updatedAt">, cim: ReaderCim): boolean {
  if (!isUnreviewedAiAnswer(q)) return true;
  if (cim.held) return false;
  const at = new Date((q.updatedAt ?? q.createdAt) as Date | string).getTime();
  if (cim.changedAt && Number.isFinite(at) && at < cim.changedAt.getTime()) return false;
  const figs = answerFigures(q.publishedAnswer || q.aiAnswer || "");
  if (figs.length === 0) return true;
  const known = knownFiguresFrom(cim.text);
  return figs.every((f) => isKnownFigure(f, known));
}

/**
 * The CIM a reader gets now, as the answer step reads it — the same
 * authority as the view room (buildBuyerCim), so an answer is only ever
 * checked against what this buyer may see.
 */
export async function readerCim(deal: QaDeal, reader: QaReader): Promise<ReaderCim> {
  const sections = await storage.getCimSectionsByDeal(deal.id);
  const changedAt = sections.reduce<Date | null>((m, s) => {
    const t = s.updatedAt ? new Date(s.updatedAt) : null;
    return t && (!m || t > m) ? t : m;
  }, null);
  if (cimHeldFromBuyers(deal)) return { text: "", changedAt, held: true };
  const mode = cimModeForAccessLevel(reader.accessLevel);
  const [overrides, media, published] = await Promise.all([
    mode === "normal" ? Promise.resolve([]) : storage.getCimSectionOverrides(deal.id, mode),
    loadMediaAssets(deal.id),
    loadPublishedVersions(deal).catch(() => []),
  ]);
  const cim = buildBuyerCim({
    deal,
    accessLevel: reader.accessLevel,
    sections,
    overrides,
    media,
    askingPrice: listedAskingPrice(deal as Parameters<typeof listedAskingPrice>[0]),
    published,
  });
  const text = stripDdMarkers(buildAnswerContext(cim.sections.filter((s) => !s.locked).map((s) => ({
    title: s.sectionTitle,
    body: s.brokerEditedContent || s.aiDraftContent || "",
    layoutType: s.layoutType,
    layoutData: s.layoutData,
  }))));
  return { text, changedAt, held: false };
}

/**
 * Published rows another buyer's question may be answered from, or shown
 * to `reader` in the feed: within the answer's scope (a teaser never gets
 * an answer drawn from full-access sections; nobody gets another buyer's
 * named-CIM answer), for a Blind reader free of anything that identifies
 * the business (shared/buyer-qa-scope.ts), and — for an unreviewed AI
 * answer — still true of the CIM this reader gets now (answerStillHolds).
 * `cim` is the reader's CIM when the caller already has it.
 */
export async function publishedQuestionsFor(deal: QaDeal, reader: QaReader, cim?: ReaderCim): Promise<BuyerQuestion[]> {
  const [all, accesses] = await Promise.all([storage.getQuestionsByDeal(deal.id), storage.getBuyerAccessByDeal(deal.id)]);
  const levelOf = new Map(accesses.map((a) => [a.id, a.accessLevel]));
  const terms = blindLeakTerms(deal, { codename: deal.blindCodename });
  const inScope = all.filter((q) => {
    if (!q.isPublished || !(q.publishedAnswer || q.aiAnswer)) return false;
    const scope = rowScope(q, q.buyerAccessId && levelOf.has(q.buyerAccessId) ? levelOf.get(q.buyerAccessId) : false);
    return readerMaySeeRow(q, scope, reader, terms);
  });
  if (!inScope.some(isUnreviewedAiAnswer)) return inScope;
  const current = cim ?? (await readerCim(deal, reader));
  return inScope.filter((q) => answerStillHolds(q, current));
}

/**
 * Everything the requesting buyer may see: published Q&A they're entitled
 * to (see publishedQuestionsFor), plus their own questions (answers shown
 * once answered, including ones kept private to them). Ordered oldest →
 * newest so the chat reads chronologically.
 */
export async function buildBuyerQuestionFeed(deal: QaDeal, reader: QaReader): Promise<BuyerQuestionFeedItem[]> {
  const [all, visible] = await Promise.all([storage.getQuestionsByDeal(deal.id), publishedQuestionsFor(deal, reader)]);
  const visibleIds = new Set(visible.map((q) => q.id));
  const feed: BuyerQuestionFeedItem[] = [];
  for (const q of all) {
    const isMine = !!q.buyerAccessId && q.buyerAccessId === reader.id;
    const published = visibleIds.has(q.id);
    if (!published && !isMine) continue;
    // The asker also sees an AI answer kept private to them (answered from
    // the named CIM — see the chatbot route).
    const answerVisible = published || (isMine && q.status === "published");
    feed.push({
      id: q.id,
      question: q.question,
      status: published ? "published" : q.status,
      isPublished: published,
      aiAnswer: answerVisible ? q.aiAnswer ?? null : null,
      publishedAnswer: answerVisible ? q.publishedAnswer ?? null : null,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
      isMine,
    });
  }
  feed.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return feed;
}
