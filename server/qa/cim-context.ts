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
 *    every published answer on the deal plus the requesting buyer's own
 *    still-pending questions (so they survive a reload), each flagged with
 *    ownership. Fields are whitelisted — the seller-approval token and the
 *    broker's unapproved draft never leave the server.
 */
import { storage } from "../storage";

type AnyRecord = Record<string, any>;

/** Presentation-only keys that carry no facts — skipped by the generic walker. */
const SKIP_KEYS = new Set([
  "color", "icon", "highlight", "columns", "style", "accentColor", "relatedSections",
  "url", "alt", "isTotal", "isSectionHeader", "indent", "bold", "trend", "weight",
  "category", "layoutType", "id", "reportsTo", "isKeyPerson", "ordered", "stacked",
  "showPercentages", "preparedByLogo", "businessLogo", "xLabel", "yLabel",
]);

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
        const headers: string[] = Array.isArray(d.headers) ? d.headers.map(fmt) : [];
        for (const r of Array.isArray(d.rows) ? d.rows : []) {
          if (!r) continue;
          const values: string[] = Array.isArray(r.values) ? r.values.map(fmt) : [];
          if (r.isSectionHeader && values.every((v) => !v)) {
            lines.push(`[${fmt(r.label)}]`);
            continue;
          }
          const cells = values
            .map((v, i) => {
              const h = headers[i + 1];
              return v ? (h ? `${h} ${v}` : v) : "";
            })
            .filter(Boolean);
          if (cells.length) lines.push(`${fmt(r.label)}: ${cells.join(" | ")}`);
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
          if (fmt(loc.sqft)) facts.push(`${fmt(loc.sqft)} sq ft`);
          if (fmt(loc.leaseType)) facts.push(fmt(loc.leaseType).replace(/_/g, " "));
          if (fmt(loc.monthlyRent)) facts.push(`monthly rent ${fmt(loc.monthlyRent)}`);
          if (fmt(loc.annualRent)) facts.push(`annual rent ${fmt(loc.annualRent)}`);
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
      case "image_gallery": {
        push("Title", d.title);
        for (const img of Array.isArray(d.images) ? d.images : []) push("Image", img?.caption);
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

/**
 * Everything the requesting buyer may see: published Q&A from any buyer on
 * the deal, plus their own unanswered questions (answers withheld until
 * published). Ordered oldest → newest so the chat reads chronologically.
 */
export async function buildBuyerQuestionFeed(dealId: string, buyerAccessId: string): Promise<BuyerQuestionFeedItem[]> {
  const all = await storage.getQuestionsByDeal(dealId);
  const feed: BuyerQuestionFeedItem[] = [];
  for (const q of all) {
    const isMine = !!q.buyerAccessId && q.buyerAccessId === buyerAccessId;
    const published = !!q.isPublished && !!(q.publishedAnswer || q.aiAnswer);
    if (!published && !isMine) continue;
    feed.push({
      id: q.id,
      question: q.question,
      status: published ? "published" : q.status,
      isPublished: published,
      aiAnswer: published ? q.aiAnswer ?? null : null,
      publishedAnswer: published ? q.publishedAnswer ?? null : null,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
      isMine,
    });
  }
  feed.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return feed;
}
