/**
 * keep-out — what must not reach buyers, read the way a person reads it.
 *
 * The rules in sensitive-facts.ts catch the common ways a fact or a private
 * note says "keep this out" ("(RFP shortlist, confidential)", "marked
 * CONFIDENTIAL — keep out of CIM"). Intent is phrased endlessly, though, and
 * the same word means different things: a sale kept confidential FROM STAFF,
 * a contract's confidentiality clause and a buyer-facing "confidential"
 * memorandum are not items to hold; an unannounced bid the seller asked to
 * keep quiet is. So before a CIM (or its DD version) is written, every fact
 * clause and private note that could carry such an instruction is read by
 * the supporting model (tool-forced JSON), and its answers are checked
 * against the text: a held clause must be one we sent, a party must appear
 * in the text it was read from and in the facts. The rules always run too —
 * the AI can only add holds, never remove one — and when the review can't
 * run the broker is told that only the rules were applied.
 *
 * Cached per deal and content (a regenerate or DD run with unchanged facts
 * doesn't call the model again).
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { agentConfig } from "../interview/config/load-config";
import { holdableParty, keepOutFromNotes, mentionsHeldName, mergeKeepOut, namesIn, privateNoteTexts, type KeepOut } from "./sensitive-facts";

export interface KeepOutResult extends KeepOut {
  /** "ai" = the review ran; "rules" = only the rules were applied. */
  by: "ai" | "rules";
  /** A broker warning when the review could not run and candidates existed. */
  warning?: string;
}

/** Words that can carry a keep-out instruction (a wide net — the model decides). */
const CANDIDATE = /\bbuyers?\b|would rather|rather not|confiden|secre|private|privately|off[- ]the[- ]record|in confidence|\bnda\b|not (?:for|in|to be|be|yet)\b|don'?t|do not|never|keep|kept|stay|out of|disclos|shar(?:e|ed|ing)|mention|unannounced|announce|public|quiet|wraps|internal only|sensitive|rumou?r|shortlist|\brfp\b|\bbid\b|tender|negotiat|\bloi\b|letter of intent|term sheet|verbal/i;

const MAX_CANDIDATES = 120;

let client: Pick<Anthropic, "messages"> | null = null;
function anthropic(): Pick<Anthropic, "messages"> {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 });
  return client;
}
/** Tests swap the model. */
export function _setKeepOutModelForTests(m: Pick<Anthropic, "messages"> | null): void {
  client = m;
  cache.clear();
}

const cache = new Map<string, KeepOutResult>();

interface Candidate {
  ref: string;
  kind: "fact" | "note";
  key?: string;
  text: string;
}

function clausesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9])|\s*;\s*|\n+/).map((s) => s.trim()).filter(Boolean);
}

function textOf(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return [v];
  if (typeof v === "number") return [String(v)];
  if (Array.isArray(v)) return v.flatMap(textOf);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).flatMap(textOf);
  return [];
}

/** Fact clauses and private notes that could carry a keep-out instruction. */
export function keepOutCandidates(info: Record<string, unknown> | null | undefined): Candidate[] {
  const out: Candidate[] = [];
  for (const [key, value] of Object.entries(info ?? {})) {
    if (key.startsWith("_")) continue;
    for (const t of textOf(value)) for (const c of clausesOf(t)) if (CANDIDATE.test(c)) out.push({ ref: `F${out.length + 1}`, kind: "fact", key, text: c });
  }
  for (const n of privateNoteTexts(info)) if (CANDIDATE.test(n)) out.push({ ref: `N${out.length + 1}`, kind: "note", text: n });
  return out.slice(0, MAX_CANDIDATES);
}

const TOOL = {
  name: "keep_out_review",
  description: "List the items that must be kept out of what buyers see.",
  input_schema: {
    type: "object" as const,
    properties: {
      holds: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref: { type: "string", description: "The item's ref (F3, N12)." },
            parties: {
              type: "array",
              items: { type: "string" },
              description: "The specific company, person or project the confidential item is about, copied exactly as written in the item. Empty when the item is about one attribute (pricing, terms) of a party the CIM may name.",
            },
            attribute: { type: "string", description: "When only one attribute of a party is confidential (e.g. 'pricing', 'termination clause'): that attribute; else empty." },
            reason: { type: "string" },
          },
          required: ["ref", "parties", "reason"],
        },
      },
    },
    required: ["holds"],
  },
};

const SYSTEM = `You review a business-for-sale file before a Confidential Information Memorandum (CIM) is written for prospective buyers. Each item is a clause from the deal's facts (F…) or a private note the broker wrote to themselves (N…).

Hold an item ONLY when it says that the item, or a party in it, must not reach buyers: marked confidential or secret as to buyers or the CIM, off the record, not to be disclosed or shared, not public yet, the seller or broker asked to keep it out of the CIM or away from buyers, or an unannounced bid / RFP / negotiation the seller wants kept quiet.

Do NOT hold:
- confidentiality from staff or employees (the sale kept quiet from the team);
- confidentiality clauses, agreements, NDAs or obligations as contract terms;
- the CIM, the sale process or a document being "confidential" in general;
- details that are merely sensitive or negative but carry no keep-out instruction;
- information the note says may go in a fuller version ("disclose in the full CIM only").

For each hold give the party it is about exactly as the item writes it (the RFP's prospective customer, the target of an unannounced deal) — never the business being sold, its owners, its region or a party only mentioned in passing. When only one attribute of a party is confidential (their pricing, a termination clause), give that attribute and no party.`;

function fingerprint(c: Candidate[]): string {
  return createHash("sha1").update(JSON.stringify(c.map((x) => [x.kind, x.key ?? "", x.text]))).digest("hex");
}

/**
 * The review for a deal: rules (the facts' own notes are applied in
 * sensitive-facts; the private notes here) plus the AI review of every
 * candidate. Never throws.
 */
export async function keepOutFor(dealId: string, info: Record<string, unknown> | null | undefined): Promise<KeepOutResult> {
  const rules = keepOutFromNotes(info);
  const candidates = keepOutCandidates(info);
  if (candidates.length === 0) return { ...rules, by: "rules" };
  const fp = `${dealId}:${fingerprint(candidates)}`;
  const hit = cache.get(fp);
  if (hit) return hit;
  let result: KeepOutResult;
  try {
    const ai = await review(candidates, info);
    result = { ...mergeKeepOut(rules, ai), by: "ai" };
    cache.set(fp, result);
  } catch (err) {
    console.warn("[keep-out] review failed; rules only:", (err as Error).message);
    result = {
      ...rules,
      by: "rules",
      warning:
        "The confidentiality review couldn't run, so only facts and private notes that say plainly to keep something out of the CIM were held back. Check the CIM for anything the seller asked to keep confidential before sharing it.",
    };
  }
  return result;
}

async function review(candidates: Candidate[], info: Record<string, unknown> | null | undefined): Promise<KeepOut> {
  const list = candidates.map((c) => `${c.ref}${c.key ? ` [${c.key}]` : " [private note]"}: ${c.text.replace(/\s+/g, " ").slice(0, 500)}`).join("\n");
  const response = await anthropic().messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 2000,
    temperature: 0,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content: list }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  const holds = ((block && block.type === "tool_use" ? block.input : {}) as { holds?: Array<{ ref?: string; parties?: string[]; attribute?: string }> }).holds ?? [];
  const facts = Object.entries(info ?? {})
    .filter(([k]) => !k.startsWith("_"))
    .flatMap(([, v]) => textOf(v))
    .join("\n");
  const out: KeepOut = { clauses: [], names: [], pairs: [] };
  for (const h of holds) {
    const c = candidates.find((x) => x.ref === String(h.ref ?? "").trim());
    if (!c) continue;
    if (c.kind === "fact" && c.key) out.clauses.push({ key: c.key, text: c.text });
    const attribute = typeof h.attribute === "string" ? h.attribute.trim().toLowerCase() : "";
    // A party counts only as the item writes it, and only when the facts name it.
    const parties = (h.parties ?? []).filter((p) => typeof p === "string" && p.trim().length >= 3 && mentionsHeldName(c.text, [p.trim()]) && mentionsHeldName(facts, [p.trim()]));
    // Keep to names (a capitalised party), never a common word the model returned.
    const named = parties.map((p) => p.trim()).filter((p) => (namesIn(p).length > 0 || /[A-Z]/.test(p.charAt(0))) && holdableParty(info, p));
    for (const p of named) {
      if (attribute) out.pairs.push({ name: p, attribute });
      else out.names.push(p);
    }
  }
  out.names = Array.from(new Set(out.names));
  return out;
}
