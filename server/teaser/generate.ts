/**
 * Writing the teaser (spec §4.5). The AI writes words; numbers come from code.
 *
 *  - startTeaserGeneration(dealId, {templateKey, replace}) runs in the
 *    background, one per deal (an in-memory set + generation.status). A run
 *    still running after 3 minutes reads as "Interrupted — try again".
 *  - The model: the supporting agent (claude-sonnet-4-5), tool-forced
 *    `write_teaser`, max_tokens 2000, retried on overload, 60 s timeout.
 *    Tests swap it with _setTeaserModelForTests.
 *  - Every returned string is guarded (fail closed, per field or bullet):
 *    identity terms and stand-ins, figures outside the allowed phrases, held
 *    names, process words, the earnings label. A failing bullet is dropped; a
 *    failing paragraph is retried once for the failed fields only ("Don't
 *    mention: …", no terms echoed), then becomes a hidden placeholder.
 *    Pinpointing wording is retried once, then kept with a warning.
 *  - The confidentiality review couldn't run, the facts couldn't be made
 *    anonymous, or the model is unavailable → the teaser starts from the
 *    template: fixed blocks filled, AI slots as hidden placeholders, with a
 *    plain sentence for the broker. It never auto-publishes.
 */
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { Deal } from "@shared/schema";
import { collectStrings } from "@shared/blind-guard";
import { BLOCKING_DISCREPANCY_STATUSES } from "@shared/discrepancy-gate";
import { headcountRange, moneyIn, parseMoney, yearsRange, type NumberStyle } from "@shared/deal-bands";
import {
  TEASER_TOKENS,
  withCellsApplied,
  type KeyCell,
  type TeaserBlock,
  type TeaserDoc,
  type TeaserGeneration,
  type TeaserHeader,
  type TeaserLayout,
} from "@shared/teaser";
import { figuresOutsideAllowed, guardTeaserText, pinpointWarnings, processWordsIn } from "@shared/teaser-guard";
import { DEFAULT_TEASER_WORDING, TEASER_TEMPLATES, templateDef, withCodenameFilled, type TeaserSlotDef, type TeaserTemplateDef } from "@shared/teaser-templates";
import { NO_CODENAME } from "@shared/teaser-view";
import { isBuiltInTeaserTemplate } from "@shared/teaser";
import { agentConfig } from "../interview/config/load-config";
import { withAiRetry, describeAiFailure } from "../ai-retry";
import { spelledNumbers } from "../cim/spoken-figures";
import { mentionsHeldName } from "../cim/sensitive-facts";
import { buildTeaserBrief, dbBriefDeps, type TeaserBrief, type TeaserBriefDeps } from "./brief";
import { FIGURE_NOTE } from "./figures";
import {
  dealCells,
  financialSnapshotCells,
  headerChips,
  keyCellsFor,
  listingRowsFor,
  operationsCells,
  trendLayoutData,
  phraseOr,
  type TeaserFigures,
} from "./key-numbers";
import { getDealTeaser, saveOwnedBlocks, setGeneration, teaserStore, type TeaserRow } from "./store";

// ── The model seam ─────────────────────────────────────────────────────────

export interface TeaserModelRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** "write_teaser" (the whole teaser) or "write_block" (one block / a rewrite). */
  tool: "write_teaser" | "write_block";
}
export interface TeaserModelReply {
  input: Record<string, unknown>;
  usage: { input: number; output: number };
}
export type TeaserModel = (req: TeaserModelRequest) => Promise<TeaserModelReply>;

const str = (max: number) => ({ type: "string", maxLength: max });
const nullableStr = (max: number) => ({ type: ["string", "null"], maxLength: max });
const point = { type: "object", additionalProperties: false, properties: { title: str(60), detail: str(180) }, required: ["title", "detail"] };

export const WRITE_TEASER_TOOL = {
  name: "write_teaser",
  description: "Write the anonymous teaser's words. The system adds every number, the price, the contact and the call to action.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      tagline: str(140),
      overview: { type: "string" },
      highlights: { type: "array", items: point },
      growth: { type: "array", items: point },
      whoItSuits: { type: "array", items: str(140) },
      reasonForSale: nullableStr(160),
      transition: nullableStr(160),
      managementNote: nullableStr(400),
      operationsNotes: { type: "array", items: { type: "object", additionalProperties: false, properties: { label: str(30), value: str(60) }, required: ["label", "value"] } },
      listingPhrases: {
        type: "object",
        additionalProperties: false,
        properties: { financing: nullableStr(60), supportTraining: nullableStr(60), reasonForSale: nullableStr(60) },
        required: ["financing", "supportTraining", "reasonForSale"],
      },
    },
    required: ["tagline", "overview", "highlights", "growth", "whoItSuits", "reasonForSale", "transition", "managementNote", "operationsNotes", "listingPhrases"],
  },
};

export const WRITE_BLOCK_TOOL = {
  name: "write_block",
  description: "Write one block of the anonymous teaser.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      title: str(120),
      body: { type: ["string", "null"] },
      items: { type: "array", items: point },
    },
    required: ["title", "body", "items"],
  },
};

let client: Anthropic | null = null;
const claudeModel: TeaserModel = async (req) => {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 0 });
  const tool = req.tool === "write_teaser" ? WRITE_TEASER_TOOL : WRITE_BLOCK_TOOL;
  const response = await withAiRetry(
    () => client!.messages.create({
      model: agentConfig.models.supportingAgents,
      max_tokens: req.maxTokens,
      temperature: 0.4,
      system: req.system,
      tools: [tool as never],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: req.user }],
    }),
    [2_000, 6_000],
  );
  const block = response.content.find((b) => b.type === "tool_use");
  return {
    input: (block && block.type === "tool_use" ? block.input : {}) as Record<string, unknown>,
    usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 },
  };
};

let model: TeaserModel = claudeModel;
/** Tests: a recorded / stubbed model (null restores Claude). */
export function _setTeaserModelForTests(fn: TeaserModel | null): void {
  model = fn ?? claudeModel;
}
let briefDeps: TeaserBriefDeps = dbBriefDeps;
/** Tests: the brief's inputs (null restores the database). */
export function _setTeaserBriefDepsForTests(d: TeaserBriefDeps | null): void {
  briefDeps = d ?? dbBriefDeps;
}
export function teaserBriefDeps(): TeaserBriefDeps {
  return briefDeps;
}

// ── Prompts ────────────────────────────────────────────────────────────────

export function teaserSystemPrompt(brief: Pick<TeaserBrief, "codename" | "spelling">): string {
  return [
    "You write the anonymous teaser a business broker sends to possible buyers before they sign an NDA.",
    `Never name or hint at the business, its people, customers, suppliers, landlord, town or street. Refer to it as "the Company" or as ${brief.codename}.`,
    "Describe what kind of business it is and how good it is — not which one it is. No superlatives or unique claims: never write only, sole, first, largest, biggest, oldest, leading, number one, exclusive, or the region's / province's best. No exact years, counts or sizes.",
    "Use only what the brief says. Never write a figure, year, count or percentage — the system adds the numbers. The only digits you may write are inside the allowed phrases, or a short duration in weeks or months.",
    FIGURE_NOTE,
    "Write in a plain, confident broker voice. No hype the brief doesn't back (no \"best-in-class\", \"world-class\").",
    "No asking price, no contact details and no call to action — the system adds those. Never mention how the information was gathered (an interview, the seller, notes, documents).",
    `Use ${brief.spelling} spelling.`,
  ].join("\n");
}

function lengthsLine(def: TeaserTemplateDef, slots: string[]): string {
  const L = def.lengths;
  const parts = [`overview: ${L.overview[0]}–${L.overview[1]} sentences`];
  if (slots.includes("highlights")) parts.push(`highlights: ${L.highlights} items`);
  if (slots.includes("growth")) parts.push(`growth: ${L.growth || 3} items`);
  if (slots.includes("opportunity") || slots.includes("deal_structure")) parts.push(`whoItSuits: ${L.whoItSuits[0] || 2}–${L.whoItSuits[1] || 3} items`);
  if (slots.includes("management")) parts.push("managementNote: 2–3 sentences");
  if (slots.includes("operations")) parts.push("operationsNotes: up to 2 short label/value pairs (no numbers)");
  if (slots.includes("listing_facts")) parts.push("listingPhrases: short phrases, null when the brief doesn't say");
  return parts.join("; ");
}

export function teaserUserMessage(brief: TeaserBrief, def: TeaserTemplateDef, extra = ""): string {
  const slots = def.slots.map((s) => s.slot);
  return JSON.stringify(
    {
      codename: brief.codename,
      industry: brief.industry,
      region: brief.region,
      allowedPhrases: brief.allowedPhrases,
      narrative: brief.narrative,
      basis: brief.basis,
      template: { key: def.key, name: def.name, lengths: lengthsLine(def, slots) },
    },
    null,
    1,
  ) + (extra ? `\n\n${extra}` : "");
}

// ── Guards on every returned string ───────────────────────────────────────

export interface FieldCheck {
  ok: boolean;
  /** Plain words, e.g. "it named a customer". */
  why: string | null;
  /** For the retry message: kinds only, never the terms. */
  kinds: string[];
  pinpoint: string[];
}

const KIND_SAID: Record<string, string> = {
  name: "the business",
  person: "a person",
  place: "the town",
  contact: "a contact detail",
  registry: "a registration number",
};

export function checkField(text: string, brief: Pick<TeaserBrief, "terms" | "allowedPhrases" | "heldNames" | "figures">): FieldCheck {
  const t = (text ?? "").trim();
  if (!t) return { ok: true, why: null, kinds: [], pinpoint: [] };
  const kinds: string[] = [];
  const g = guardTeaserText(t, brief.terms);
  if (g.leaks.length > 0) {
    for (const l of g.leaks) {
      const term = brief.terms.find((x) => x.text.toLowerCase() === l.toLowerCase());
      kinds.push(KIND_SAID[term?.kind ?? "name"] ?? "the business");
    }
  }
  if (g.placeholders.length > 0) kinds.push("a bracketed stand-in");
  if (figuresOutsideAllowed(t, brief.allowedPhrases, spelledNumbers).length > 0) kinds.push("a figure");
  if (brief.heldNames.length > 0 && mentionsHeldName(t, brief.heldNames)) kinds.push("a party kept confidential");
  if (processWordsIn(t)) kinds.push("how the information was gathered");
  const label = earningsLabelProblem(t, brief.figures);
  if (label) kinds.push(label);
  const uniq = Array.from(new Set(kinds));
  return { ok: uniq.length === 0, why: uniq.length ? `it named ${uniq.join(" and ")}` : null, kinds: uniq, pinpoint: pinpointWarnings(t) };
}

/** An "EBITDA" / "SDE" mention must match the canon's headline label. */
function earningsLabelProblem(text: string, f: TeaserFigures): string | null {
  if (!f.headline) return null;
  if (f.headline === "sde" && /\bebitda\b/i.test(text)) return "the wrong earnings measure (EBITDA)";
  if (f.headline === "ebitda" && /\bsde\b|seller'?s discretionary/i.test(text)) return "the wrong earnings measure (SDE)";
  return null;
}

// ── The model output, guarded ──────────────────────────────────────────────

export interface WriteTeaserOutput {
  tagline: string;
  overview: string;
  highlights: Array<{ title: string; detail: string }>;
  growth: Array<{ title: string; detail: string }>;
  whoItSuits: string[];
  reasonForSale: string | null;
  transition: string | null;
  managementNote: string | null;
  operationsNotes: Array<{ label: string; value: string }>;
  listingPhrases: { financing: string | null; supportTraining: string | null; reasonForSale: string | null };
}

const s = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const sn = (v: unknown, max: number): string | null => {
  const t = s(v, max);
  return t ? t : null;
};
const points = (v: unknown, n = 8) =>
  (Array.isArray(v) ? v : []).slice(0, n).map((x) => ({ title: s((x as Record<string, unknown>)?.title, 60), detail: s((x as Record<string, unknown>)?.detail, 180) })).filter((x) => x.title || x.detail);

export function parseWriteTeaser(input: Record<string, unknown>): WriteTeaserOutput {
  const lp = (input.listingPhrases ?? {}) as Record<string, unknown>;
  return {
    tagline: s(input.tagline, 140),
    overview: s(input.overview, 4000),
    highlights: points(input.highlights),
    growth: points(input.growth),
    whoItSuits: (Array.isArray(input.whoItSuits) ? input.whoItSuits : []).map((x) => s(x, 140)).filter(Boolean).slice(0, 5),
    reasonForSale: sn(input.reasonForSale, 160),
    transition: sn(input.transition, 160),
    managementNote: sn(input.managementNote, 400),
    operationsNotes: (Array.isArray(input.operationsNotes) ? input.operationsNotes : []).slice(0, 4)
      .map((x) => ({ label: s((x as Record<string, unknown>)?.label, 30), value: s((x as Record<string, unknown>)?.value, 60) }))
      .filter((x) => x.label && x.value),
    listingPhrases: { financing: sn(lp.financing, 60), supportTraining: sn(lp.supportTraining, 60), reasonForSale: sn(lp.reasonForSale, 60) },
  };
}

const PARAGRAPHS = ["tagline", "overview", "reasonForSale", "transition", "managementNote"] as const;
type Paragraph = (typeof PARAGRAPHS)[number];

export interface GuardedOutput {
  out: WriteTeaserOutput;
  /** Paragraph fields that failed after the retry (→ hidden placeholders). */
  failed: Set<Paragraph>;
  /** Paragraph fields kept with pinpointing wording. */
  pinpoint: Map<Paragraph, string[]>;
  warnings: string[];
}

const FIELD_WORDS: Record<Paragraph, string> = {
  tagline: "The one-line description",
  overview: "The business overview",
  reasonForSale: "The reason for sale",
  transition: "The owner transition",
  managementNote: "The management note",
};

/** Bullets: a failing one is dropped, with a warning. */
function guardBullets(out: WriteTeaserOutput, brief: TeaserBrief, warnings: string[]): void {
  const drop = <T>(list: T[], text: (x: T) => string, what: string): T[] =>
    list.filter((x) => {
      const c = checkField(text(x), brief);
      if (c.ok) return true;
      warnings.push(`${what} was left out: ${c.why}.`);
      return false;
    });
  out.highlights = drop(out.highlights, (x) => `${x.title}. ${x.detail}`, "One highlight");
  out.growth = drop(out.growth, (x) => `${x.title}. ${x.detail}`, "One growth point");
  out.whoItSuits = drop(out.whoItSuits, (x) => x, "One “who it suits” line");
  out.operationsNotes = drop(out.operationsNotes, (x) => `${x.label}: ${x.value}`, "One operations note");
  for (const k of ["financing", "supportTraining", "reasonForSale"] as const) {
    const v = out.listingPhrases[k];
    if (v && !checkField(v, brief).ok) {
      warnings.push(`The listing's ${k === "supportTraining" ? "support & training" : k === "reasonForSale" ? "reason for selling" : "financing"} phrase was left out: ${checkField(v, brief).why}.`);
      out.listingPhrases[k] = null;
    }
  }
}

/**
 * Guard the model's output; retry failing (or pinpointing) paragraphs once
 * with a corrective note, taking only those fields from the retry.
 */
export async function guardOutput(
  first: WriteTeaserOutput,
  brief: TeaserBrief,
  retry: (note: string) => Promise<WriteTeaserOutput | null>,
): Promise<GuardedOutput> {
  const out: WriteTeaserOutput = JSON.parse(JSON.stringify(first));
  const warnings: string[] = [];
  guardBullets(out, brief, warnings);
  const failing = new Map<Paragraph, FieldCheck>();
  const pinpointing = new Map<Paragraph, FieldCheck>();
  for (const f of PARAGRAPHS) {
    const v = out[f];
    if (!v) continue;
    const c = checkField(v, brief);
    if (!c.ok) failing.set(f, c);
    else if (c.pinpoint.length > 0) pinpointing.set(f, c);
  }
  const failed = new Set<Paragraph>();
  const pinpoint = new Map<Paragraph, string[]>();
  if (failing.size > 0 || pinpointing.size > 0) {
    const kinds = Array.from(new Set(Array.from(failing.values()).flatMap((c) => c.kinds)));
    const fields = [...Array.from(failing.keys()), ...Array.from(pinpointing.keys())];
    const note = [
      `Rewrite only these fields: ${fields.join(", ")}. Keep every other field as it was.`,
      kinds.length ? `Don't mention: ${kinds.join(", ")}.` : "",
      pinpointing.size ? "Avoid: unique claims, exact years and counts." : "",
    ].filter(Boolean).join(" ");
    let second: WriteTeaserOutput | null = null;
    try {
      second = await retry(note);
    } catch {
      second = null;
    }
    for (const f of fields) {
      const v = second?.[f] ?? null;
      const c = v ? checkField(v, brief) : null;
      if (v && c?.ok) {
        out[f] = v as never;
        if (c.pinpoint.length > 0) pinpoint.set(f, c.pinpoint);
      } else if (failing.has(f)) {
        failed.add(f);
        out[f] = (f === "tagline" || f === "overview" ? "" : null) as never;
        warnings.push(`${FIELD_WORDS[f]} couldn't be written without ${failing.get(f)!.why?.replace(/^it named /, "naming ")}, so it's left for you to write.`);
      } else {
        // Pinpointing that remains after the retry: kept, with a warning on the block.
        pinpoint.set(f, pinpointing.get(f)!.pinpoint);
      }
    }
  }
  return { out, failed, pinpoint, warnings };
}

// ── Assembly ───────────────────────────────────────────────────────────────

export interface TeaserWording {
  confidentiality?: string | null;
  nextStep?: string | null;
}

export interface AssembleInput {
  def: TeaserTemplateDef;
  figures: TeaserFigures;
  numbers: NumberStyle;
  showAskingPrice: boolean;
  wording: TeaserWording;
  /** Null = the AI wasn't used (template start): AI slots become hidden placeholders. */
  written: GuardedOutput | null;
  now?: Date;
  /** Keep these ids per slot (a re-run over an existing draft keeps block ids → analytics lineage). */
  idForSlot?: (slot: string) => string | undefined;
  /** The codename the teaser is written under: fills a saved template's {codename}. */
  codename?: string | null;
}

const nowIso = (d?: Date) => (d ?? new Date()).toISOString();

function block(slot: TeaserSlotDef, data: Record<string, unknown>, opts: Partial<TeaserBlock> & { id?: string; at: string }): TeaserBlock {
  const b: TeaserBlock = {
    id: opts.id ?? randomUUID(),
    slot: slot.slot,
    title: opts.title ?? slot.title,
    layoutType: (opts.layoutType ?? slot.layoutType) as TeaserLayout,
    layoutData: data,
    body: opts.body ?? null,
    hidden: opts.hidden ?? false,
    origin: opts.origin ?? (slot.src === "ai" ? "ai" : "fixed"),
    ...(opts.placeholder ? { placeholder: true } : {}),
    facts: opts.facts ?? [],
    updatedAt: opts.at,
  };
  return Array.isArray(data.cells) ? withCellsApplied(b) : b;
}

function placeholderFor(slot: TeaserSlotDef, at: string, id?: string): TeaserBlock {
  const empty: Record<string, unknown> =
    slot.layoutType === "prose_highlight" ? { body: "" }
    : slot.layoutType === "callout_list" ? { items: [], style: "list", columns: 1 }
    : slot.layoutType === "two_column" ? { left: { title: "", content: "", layoutType: "prose" }, right: { title: "", content: "", layoutType: "list" } }
    : {};
  return block(slot, empty, { at, id, hidden: true, placeholder: true, origin: "ai", body: slot.layoutType === "prose_highlight" ? "" : null });
}

function nextStepItems(wording: TeaserWording, def: TeaserTemplateDef): Array<{ title: string }> {
  const custom = (def.fixedText?.next_step ?? wording.nextStep ?? "").trim();
  const lines = custom ? custom.split(/\n+/).map((l) => l.trim()).filter(Boolean) : [...DEFAULT_TEASER_WORDING.nextStep];
  return [...lines, DEFAULT_TEASER_WORDING.contactLine].map((title) => ({ title }));
}

const lines = (list: string[]) => list.filter(Boolean).join("\n");

/** Assemble a TeaserDoc from the template, the figures and the (guarded) AI output. Pure. */
export function assembleTeaserDoc(input: AssembleInput): TeaserDoc {
  const { figures, written } = input;
  const def = withCodenameFilled(input.def, input.codename || NO_CODENAME);
  const at = nowIso(input.now);
  const w = written?.out ?? null;
  const failed = written?.failed ?? new Set<string>();
  const cs = { numbers: input.numbers, showAskingPrice: input.showAskingPrice };
  const blocks: TeaserBlock[] = [];
  const idOf = (slot: string) => input.idForSlot?.(slot);
  const aiOk = (field: string) => !!w && !failed.has(field as never);
  for (const slot of def.slots) {
    const id = idOf(slot.slot);
    switch (slot.slot) {
      case "key_numbers": {
        const cells = keyCellsFor(def.key, figures, cs);
        blocks.push(block(slot, { cells, columns: Math.min(4, Math.max(2, cells.length)) }, { at, id, facts: [...(figures.sources.revenue ?? []), ...(figures.sources.earnings ?? []), ...(figures.sources.employees ?? []), "askingPrice"] }));
        break;
      }
      case "listing_facts": {
        // The AI's phrases, else the facts' fixed phrases (the template start fills what the facts say plainly).
        const fp = figures.phrases;
        const lp = w?.listingPhrases;
        const cells = listingRowsFor(figures, cs, { financing: phraseOr(lp?.financing, fp?.financing), supportTraining: phraseOr(lp?.supportTraining, fp?.supportTraining), reasonForSale: phraseOr(lp?.reasonForSale, fp?.reasonForSale) });
        blocks.push(block(slot, { cells, columns: 3 }, { at, id, facts: Object.values(figures.sources).flat() }));
        break;
      }
      case "overview": {
        const body = aiOk("overview") && w!.overview ? w!.overview : "";
        blocks.push(body ? block(slot, { body }, { at, id, body, origin: "ai", facts: [] }) : placeholderFor(slot, at, id));
        break;
      }
      case "highlights": {
        const items = (w?.highlights ?? []).slice(0, def.lengths.highlights || 6).map((h) => ({ title: h.title, description: h.detail }));
        blocks.push(items.length > 0 ? block(slot, { items, style: "list", columns: 1 }, { at, id, origin: "ai" }) : placeholderFor(slot, at, id));
        break;
      }
      case "growth": {
        const items = (w?.growth ?? []).slice(0, def.lengths.growth || 3).map((h) => ({ title: h.title, description: h.detail }));
        blocks.push(items.length > 0 ? block(slot, { items, style: "list", columns: 1 }, { at, id, origin: "ai" }) : placeholderFor(slot, at, id));
        break;
      }
      case "opportunity": {
        const who = (w?.whoItSuits ?? []).slice(0, 3);
        const fp = figures.phrases;
        const cells = dealCells(figures, { reasonForSale: phraseOr(aiOk("reasonForSale") ? w?.reasonForSale : null, fp?.reasonForSale), transition: phraseOr(aiOk("transition") ? w?.transition : null, fp?.transition), financing: phraseOr(w?.listingPhrases.financing, fp?.financing) }, def.key === "two_page");
        blocks.push(block(slot, {
          left: { title: "Who it suits", layoutType: "list", content: lines(who) },
          right: { title: "Deal at a glance", layoutType: "metric", content: "" },
          cells,
        }, { at, id, origin: w ? "ai" : "fixed", facts: [...(figures.sources.saleType ?? []), ...(figures.sources.realEstate ?? [])], hidden: who.length === 0 && cells.length === 0, placeholder: who.length === 0 && cells.length === 0 }));
        break;
      }
      case "deal_structure": {
        const fp = figures.phrases;
        const aiHandover = aiOk("transition") && w?.transition?.trim() ? w.transition.trim() : null;
        const handover = aiHandover ?? (fp?.transition ? `Owner transition: ${fp.transition}` : null);
        const reason = phraseOr(aiOk("reasonForSale") ? w?.reasonForSale : null, fp?.reasonForSale);
        const transition = [handover ? (/[.!?]$/.test(handover) ? handover : `${handover}.`) : null, reason ? `Reason for sale: ${reason}` : null].filter(Boolean).join(" ");
        const cells = dealCells(figures, { financing: phraseOr(w?.listingPhrases.financing, fp?.financing) }, true).filter((c) => c.key !== "reasonForSale" && c.key !== "transition");
        blocks.push(block(slot, {
          left: { title: "Transition", layoutType: "prose", content: transition },
          right: { title: "The deal", layoutType: "metric", content: "" },
          cells,
        }, { at, id, origin: w ? "ai" : "fixed", facts: [...(figures.sources.saleType ?? []), ...(figures.sources.realEstate ?? [])], hidden: !transition && cells.length === 0, placeholder: !transition && cells.length === 0 }));
        break;
      }
      case "operations": {
        const notes: KeyCell[] = (w?.operationsNotes ?? []).slice(0, 2).map((n, i) => ({ key: `note${i + 1}`, label: n.label, value: n.value }));
        const cells = [...operationsCells(figures), ...notes];
        blocks.push(block(slot, { cells }, { at, id, origin: "fixed", facts: [...(figures.sources.employees ?? []), ...(figures.sources.years ?? [])], hidden: cells.length === 0 }));
        break;
      }
      case "financial_snapshot": {
        const cells = financialSnapshotCells(figures);
        blocks.push(block(slot, { cells }, { at, id, facts: [...(figures.sources.revenue ?? []), ...(figures.sources.earnings ?? [])], hidden: cells.length === 0 }));
        break;
      }
      case "trend": {
        const data = trendLayoutData(figures);
        if (data) blocks.push(block(slot, data, { at, id, facts: figures.sources.revenue ?? [] }));
        break;
      }
      case "management": {
        const body = aiOk("managementNote") && w!.managementNote ? w!.managementNote : "";
        blocks.push(body ? block(slot, { body }, { at, id, body, origin: "ai" }) : placeholderFor(slot, at, id));
        break;
      }
      case "next_step": {
        blocks.push(block(slot, { items: nextStepItems(input.wording, def), ordered: true }, { at, id, origin: def.fixedText?.next_step ? "broker" : "fixed" }));
        break;
      }
      case "confidentiality": {
        const body = (def.fixedText?.confidentiality ?? input.wording.confidentiality ?? "").trim() || DEFAULT_TEASER_WORDING.confidentiality;
        blocks.push(block(slot, { body }, { at, id, body, origin: def.fixedText?.confidentiality ? "broker" : "fixed" }));
        break;
      }
      default: {
        // A saved template's own block: the broker's wording, kept verbatim (still guarded at publish).
        const text = def.fixedText?.[slot.slot] ?? "";
        if (slot.layoutType === "prose_highlight") blocks.push(block(slot, { body: text }, { at, id, body: text, origin: "broker", hidden: !text, placeholder: !text }));
        else blocks.push(placeholderFor(slot, at, id));
      }
    }
  }
  return { header: null, blocks };
}

/** The header: label, the AI tagline (or the industry), chips from code. */
export function assembleHeader(figures: TeaserFigures, written: GuardedOutput | null): TeaserHeader {
  const tagline = written && !written.failed.has("tagline") && written.out.tagline ? written.out.tagline : figures.industry ?? "";
  return { label: DEFAULT_TEASER_WORDING.label, tagline, chips: headerChips(figures).slice(0, 5) };
}

// ── The gate before starting ──────────────────────────────────────────────

export interface TeaserGate {
  ok: boolean;
  /** Plain sentences, each a reason the teaser can't be written yet. */
  reasons: string[];
  /** Quiet notes (an open question that doesn't change what the teaser shows). */
  notes: string[];
}

/** Fact keys whose figures the teaser prints, with how to compare them. */
const PRINTED: Array<{ keys: RegExp; label: string; kind: "money" | "headcount" | "years" }> = [
  { keys: /^(annualRevenue|revenue|grossRevenue|totalRevenue)$/i, label: "Revenue", kind: "money" },
  { keys: /^(sde|sellersDiscretionaryEarnings|cashFlow)$/i, label: "SDE", kind: "money" },
  { keys: /^(ebitda|adjustedEbitda)$/i, label: "EBITDA", kind: "money" },
  { keys: /^askingPrice$/i, label: "The asking price", kind: "money" },
  { keys: /^(employees|employeeCount|numberOfEmployees|totalEmployees|headcount)$/i, label: "Employees", kind: "headcount" },
  { keys: /^(yearsOperating|yearsInBusiness|yearFounded|yearEstablished|dateOfIncorporation)$/i, label: "Years in business", kind: "years" },
];

function shown(kind: "money" | "headcount" | "years", v: string | null | undefined, style: NumberStyle, now: Date): string | null {
  if (!v) return null;
  if (kind === "money") {
    const n = parseMoney(v);
    return n ? moneyIn(style, n) : null;
  }
  const m = /(\d[\d,]*)/.exec(v);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (kind === "years" && n > 1800) n = now.getUTCFullYear() - n;
  return kind === "headcount" ? headcountRange(n) : yearsRange(n);
}

/**
 * Open discrepancies block only when they change what the teaser shows:
 * both sides formatted in the teaser's number style; different (or a side
 * unreadable) → blocks; the same → a quiet note.
 */
export function discrepancyGateFor(
  rows: Array<{ field: string; factKey?: string | null; status: string; interviewValue?: string | null; documentValue?: string | null }>,
  style: NumberStyle,
  now = new Date(),
): { reasons: string[]; notes: string[] } {
  const reasons: string[] = [];
  const notes: string[] = [];
  for (const d of rows) {
    if (!BLOCKING_DISCREPANCY_STATUSES.has(d.status)) continue;
    const key = d.factKey ?? "";
    const printed = PRINTED.find((p) => p.keys.test(key));
    if (!printed) continue;
    const a = shown(printed.kind, d.interviewValue, style, now);
    const b = shown(printed.kind, d.documentValue, style, now);
    if (!a || !b || a !== b) {
      reasons.push(`${printed.label} has an open question that changes what the teaser shows${a && b ? ` (${a} or ${b})` : ""}. Resolve it on the Information tab first.`);
    } else {
      notes.push(`${printed.label} has an open question, but both figures fall in the same ${style === "rounded" ? "rounded figure" : "range"} (${a}), so the teaser isn't affected.`);
    }
  }
  return { reasons: Array.from(new Set(reasons)), notes: Array.from(new Set(notes)) };
}

/** Can the teaser be written (industry, region, revenue or earnings; no blocking open question)? */
export async function teaserGate(deal: Deal, figures: TeaserFigures, style: NumberStyle): Promise<TeaserGate> {
  const reasons: string[] = [];
  if (!figures.industry || !figures.region) reasons.push("Add the industry and the province or state on the Information tab first.");
  if (!figures.revenue && !figures.earnings) reasons.push("Add the revenue or earnings on the Information tab first.");
  const { storage } = await import("../storage");
  const rows = await storage.getDiscrepanciesByDeal(deal.id).catch(() => []);
  const d = discrepancyGateFor(rows as never, style);
  reasons.push(...d.reasons);
  return { ok: reasons.length === 0, reasons, notes: d.notes };
}

// ── Running a generation ──────────────────────────────────────────────────

const running = new Set<string>();

export const SENTENCES = {
  review: "The confidentiality check couldn't run, so Cimple didn't write the text. Fill in the highlighted blocks, or try again in a few minutes.",
  redaction: "Cimple couldn't make an anonymous version of the deal's information just now. Fill in the highlighted blocks, or try again in a few minutes.",
  model: "The AI isn't available right now, so the teaser was started from the template. Write the highlighted blocks, or try again later.",
  template: "Started from the template. Write the highlighted blocks — or ask Cimple to write them.",
} as const;

async function wordingFor(deal: Deal): Promise<TeaserWording> {
  try {
    const { storage } = await import("../storage");
    const b = await storage.getBrandingByBroker(deal.brokerId);
    const t = ((b as { teaserSettings?: unknown } | undefined)?.teaserSettings ?? null) as { confidentiality?: string; nextStep?: string } | null;
    return { confidentiality: t?.confidentiality ?? null, nextStep: t?.nextStep ?? null };
  } catch {
    return {};
  }
}

async function savedDef(templateKey: string, brokerId: string): Promise<TeaserTemplateDef> {
  if (isBuiltInTeaserTemplate(templateKey)) return TEASER_TEMPLATES[templateKey];
  const { savedTemplateDef } = await import("./templates-store");
  return (await savedTemplateDef(templateKey, brokerId)) ?? TEASER_TEMPLATES.one_page;
}

export interface WrittenTeaser {
  doc: TeaserDoc;
  generation: TeaserGeneration;
  codename: string;
}

/**
 * Build a teaser doc for the deal: brief → model → guards → assembly, or the
 * template start when the review/redaction/model can't be used. Pure of
 * storage writes (startTeaserGeneration saves it).
 */
export async function writeTeaser(
  deal: Deal,
  opts: { templateKey: string; numbers: NumberStyle; showAskingPrice: boolean; mode: "ai" | "template"; startedAt: string; ownedBlockIds: string[]; idForSlot?: (slot: string) => string | undefined },
): Promise<WrittenTeaser> {
  const def = await savedDef(opts.templateKey, deal.brokerId);
  const wording = await wordingFor(deal);
  if (opts.mode === "template") {
    // No AI at all: no review call, no narrative — the fixed blocks from code, AI slots left to the broker.
    const [figures, codename] = await Promise.all([briefDeps.figures(deal), briefDeps.codename(deal)]);
    const doc = assembleTeaserDoc({ def, figures, numbers: opts.numbers, showAskingPrice: opts.showAskingPrice, wording, written: null, idForSlot: opts.idForSlot, codename });
    doc.header = assembleHeader(figures, null);
    const { codenameProblem } = await import("../cim/codenames");
    const problem = codenameProblem(deal as never, codename);
    return {
      doc,
      codename,
      generation: {
        status: "done", startedAt: opts.startedAt, finishedAt: new Date().toISOString(), error: null,
        warnings: problem ? [`The codename ${codename} needs changing before you publish: ${problem}`] : [],
        basis: "template", ownedBlockIds: opts.ownedBlockIds, fullRewrite: true, reviewFailed: false, model: null, usage: null,
      },
    };
  }
  const brief = await buildTeaserBrief(deal, briefDeps);
  const gen: TeaserGeneration = {
    status: "done",
    startedAt: opts.startedAt,
    finishedAt: null,
    error: null,
    warnings: [],
    basis: brief.basis,
    ownedBlockIds: opts.ownedBlockIds,
    fullRewrite: true,
    reviewFailed: brief.reviewFailed,
    model: null,
    usage: null,
  };
  if (brief.codenameProblem) gen.warnings.push(`The codename ${brief.codename} needs changing before you publish: ${brief.codenameProblem}`);
  let written: GuardedOutput | null = null;
  if (brief.reviewFailed) {
    gen.basis = "template";
    gen.error = SENTENCES.review;
  } else if (brief.redactionFailed) {
    gen.basis = "template";
    gen.error = SENTENCES.redaction;
  } else {
    const system = teaserSystemPrompt(brief);
    const usage = { input: 0, output: 0 };
    try {
      const first = await model({ system, user: teaserUserMessage(brief, def), maxTokens: 2000, tool: "write_teaser" });
      usage.input += first.usage.input;
      usage.output += first.usage.output;
      written = await guardOutput(parseWriteTeaser(first.input), brief, async (note) => {
        const r = await model({ system, user: teaserUserMessage(brief, def, note), maxTokens: 2000, tool: "write_teaser" });
        usage.input += r.usage.input;
        usage.output += r.usage.output;
        return parseWriteTeaser(r.input);
      });
      gen.model = agentConfig.models.supportingAgents;
      gen.usage = usage;
      gen.warnings.push(...written.warnings);
      for (const [f, phrases] of Array.from(written.pinpoint.entries())) {
        gen.warnings.push(`${FIELD_WORDS[f]} may describe the business too precisely (${phrases.slice(0, 2).map((p) => `“${p}”`).join(", ")}). Buyers will see it — reword it if it's too specific.`);
      }
    } catch (err) {
      const why = describeAiFailure(err);
      console.warn(`[teaser] model unavailable for deal ${deal.id}: ${why.reason}`);
      written = null;
      gen.basis = "template";
      gen.error = SENTENCES.model;
    }
  }
  const doc = assembleTeaserDoc({ def, figures: brief.figures, numbers: opts.numbers, showAskingPrice: opts.showAskingPrice, wording, written, idForSlot: opts.idForSlot, codename: brief.codename });
  doc.header = assembleHeader(brief.figures, written);
  gen.finishedAt = new Date().toISOString();
  return { doc, generation: gen, codename: brief.codename };
}

/** Is a run going on for this deal (in this process)? */
export function teaserRunning(dealId: string): boolean {
  return running.has(dealId);
}

/**
 * Start writing the teaser in the background. Creates the row when there is
 * none. Every edit waits (409 "writing") until it's done. A rewrite over an
 * existing draft keeps the block ids per slot (reading history) and is
 * undoable (the previous draft goes to history).
 */
export async function startTeaserGeneration(
  deal: Deal,
  opts: { templateKey: string; mode?: "ai" | "template"; numbers?: NumberStyle },
): Promise<{ started: true } | { busy: true }> {
  if (running.has(deal.id)) return { busy: true };
  const store = teaserStore();
  const existing = await getDealTeaser(deal.id);
  if (existing?.generation?.status === "running") return { busy: true };
  running.add(deal.id);
  const def = await savedDef(opts.templateKey, deal.brokerId).catch(() => TEASER_TEMPLATES.one_page);
  const numbers: NumberStyle = opts.numbers ?? (existing && existing.templateKey === opts.templateKey ? existing.numbers : def.numbers);
  const startedAt = new Date().toISOString();
  const generation: TeaserGeneration = { status: "running", startedAt, warnings: [], ownedBlockIds: [], fullRewrite: true, basis: null };
  try {
    if (!existing) await store.create(deal.id, { templateKey: opts.templateKey, numbers, generation });
    else await setGeneration(deal.id, generation, { templateKey: opts.templateKey, numbers });
  } catch (err) {
    running.delete(deal.id);
    throw err;
  }
  void (async () => {
    try {
      const row = await getDealTeaser(deal.id);
      const bySlot = new Map((row?.draft.blocks ?? []).map((b) => [b.slot, b.id]));
      const result = await writeTeaser(deal, {
        templateKey: opts.templateKey,
        numbers,
        showAskingPrice: row?.showAskingPrice ?? true,
        mode: opts.mode ?? "ai",
        startedAt,
        ownedBlockIds: [],
        idForSlot: (slot) => bySlot.get(slot),
      });
      await store.update(deal.id, (r) => ({
        draft: result.doc,
        draftRev: r.draftRev + 1,
        history: [...r.history, { at: new Date().toISOString(), reason: opts.mode === "template" ? "Started from the template" : "Written by AI", doc: r.draft }].slice(-20),
        codenameUsed: result.codename,
        generation: { ...result.generation, fullRewrite: false },
        // A fresh review that ran clears an old confirmation's need; a failed one asks again.
        ...(result.generation.reviewFailed ? { reviewConfirmed: null } : {}),
      }));
    } catch (err) {
      console.error(`[teaser] generation failed for deal ${deal.id}:`, err);
      await setGeneration(deal.id, { ...generation, status: "failed", finishedAt: new Date().toISOString(), error: "Something went wrong while writing the teaser. Try again." }).catch(() => undefined);
    } finally {
      running.delete(deal.id);
    }
  })();
  return { started: true };
}

/** Wait for a deal's background run (tests, the offline proof). */
export async function waitForTeaser(dealId: string, timeoutMs = 10_000): Promise<TeaserRow | null> {
  const end = Date.now() + timeoutMs;
  while (running.has(dealId) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return getDealTeaser(dealId);
}

// ── One block (Add with AI, Rewrite with AI, Reset an AI block) ───────────

export interface BlockProposal {
  title: string;
  layoutType: TeaserLayout;
  layoutData: Record<string, unknown>;
  body: string | null;
  pinpoint: string[];
}

export class TeaserWriteRefused extends Error {}

/**
 * Write one block with the AI (synchronous, one call, the same brief and
 * guards). Throws TeaserWriteRefused with a plain sentence when the review
 * can't run, the result names the business, or the model is unavailable.
 */
export async function writeBlock(
  deal: Deal,
  req: { layoutType: TeaserLayout; title: string; instructions?: string | null; current?: { title: string; body: string | null; layoutData: Record<string, unknown> } | null; tones?: string[]; length?: "shorter" | "same" | "longer" | null },
): Promise<BlockProposal> {
  const brief = await buildTeaserBrief(deal, briefDeps);
  if (brief.reviewFailed) throw new TeaserWriteRefused(SENTENCES.review);
  if (brief.redactionFailed) throw new TeaserWriteRefused(SENTENCES.redaction);
  const prose = req.layoutType === "prose_highlight" || req.layoutType === "stat_callout";
  const ask = [
    `Write one teaser block titled "${req.title}" as ${prose ? "a short paragraph (body; items empty)" : "3–5 items, each a short title and one-sentence detail (items; body null)"}.`,
    req.current ? `The block currently says: ${JSON.stringify({ title: req.current.title, body: req.current.body, items: collectStrings(req.current.layoutData).slice(0, 12) })}` : "",
    req.instructions ? `The broker asks: ${String(req.instructions).slice(0, 600)}` : "",
    req.tones?.length ? `Tone: ${req.tones.slice(0, 3).join(", ")}.` : "",
    req.length && req.length !== "same" ? `Make it ${req.length}.` : "",
  ].filter(Boolean).join("\n");
  const system = teaserSystemPrompt(brief);
  const user = `${JSON.stringify({ codename: brief.codename, industry: brief.industry, region: brief.region, allowedPhrases: brief.allowedPhrases, narrative: brief.narrative }, null, 1)}\n\n${ask}`;
  let reply: TeaserModelReply;
  try {
    reply = await model({ system, user, maxTokens: 900, tool: "write_block" });
  } catch (err) {
    console.warn(`[teaser] block write failed for deal ${deal.id}: ${describeAiFailure(err).reason}`);
    throw new TeaserWriteRefused("The AI isn't available right now. Try again later, or write it yourself.");
  }
  const title = s(reply.input.title, 120) || req.title;
  const body = prose ? s(reply.input.body, 4000) : null;
  const items = prose ? [] : points(reply.input.items, 8);
  const texts = [title, body ?? "", ...items.map((i) => `${i.title}. ${i.detail}`)];
  for (const t of texts) {
    const c = checkField(t, brief);
    if (!c.ok) throw new TeaserWriteRefused(`That ${req.current ? "rewrite" : "block"} named ${c.kinds.join(" and ")}, so it wasn't kept. Try different instructions.`);
  }
  const pinpoint = Array.from(new Set(texts.flatMap((t) => pinpointWarnings(t))));
  const layoutData: Record<string, unknown> = prose
    ? (req.layoutType === "stat_callout" ? { primaryValue: "", primaryLabel: title, description: body } : { body })
    : req.layoutType === "numbered_list"
      ? { items: items.map((i) => ({ title: i.title, description: i.detail })), ordered: true }
      : req.layoutType === "tag_cloud"
        ? { tags: items.map((i) => ({ label: i.title })) }
        : req.layoutType === "icon_stat_row"
          ? { stats: items.map((i) => ({ label: i.title, value: i.detail.slice(0, 40) })) }
          : { items: items.map((i) => ({ title: i.title, description: i.detail })), style: "list", columns: 1 };
  return { title, layoutType: req.layoutType, layoutData, body, pinpoint };
}

/** Fill these placeholder slots in the background (a template switch added them). */
export function fillSlotsInBackground(deal: Deal, row: TeaserRow, blockIds: string[]): void {
  if (blockIds.length === 0 || running.has(deal.id)) return;
  running.add(deal.id);
  const startedAt = new Date().toISOString();
  void (async () => {
    try {
      await setGeneration(deal.id, { status: "running", startedAt, warnings: [], ownedBlockIds: blockIds, fullRewrite: false, basis: row.generation?.basis ?? null });
      const fresh = await getDealTeaser(deal.id);
      if (!fresh) return;
      const result = await writeTeaser(deal, {
        templateKey: fresh.templateKey,
        numbers: fresh.numbers,
        showAskingPrice: fresh.showAskingPrice,
        mode: "ai",
        startedAt,
        ownedBlockIds: blockIds,
        idForSlot: (slot) => fresh.draft.blocks.find((b) => b.slot === slot && blockIds.includes(b.id))?.id,
      });
      const mine = result.doc.blocks.filter((b) => blockIds.includes(b.id));
      await saveOwnedBlocks(deal.id, { startedAt, ownedBlockIds: blockIds }, mine, { generation: { ...result.generation, ownedBlockIds: [], fullRewrite: false } }, "Written by AI");
    } catch (err) {
      console.error(`[teaser] slot fill failed for deal ${deal.id}:`, err);
      await setGeneration(deal.id, { status: "failed", startedAt, finishedAt: new Date().toISOString(), error: "Cimple couldn't write the new blocks. Write them yourself, or try again.", warnings: [], ownedBlockIds: [] }).catch(() => undefined);
    } finally {
      running.delete(deal.id);
    }
  })();
}

export { TEASER_TOKENS, templateDef };
