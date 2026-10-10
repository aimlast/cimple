/**
 * Suggested ways to ask the industry checklist's items (specs/together.md
 * §3.5, D9): one supporting-model call per deal writes, for each industry
 * item, one spoken question ("askAs", ≤ 22 words, no figures) and why buyers
 * care ("whyItMatters", ≤ 18 words). Generic items have hand-written ones
 * (coverage-asks.ts); until this runs, industry items read the template ask
 * (coverage-asks.ts templateAsk).
 *
 * Started after a checklist build succeeds and by a session together
 * starting (POST …/together/sittings) — never by a GET, never with the key
 * "disabled", never with schedulers off (local servers). One in flight per
 * deal; a failure retries at most hourly. Once per build: every item sent is
 * recorded (`phrasingTried`), so an item whose phrasing was refused keeps the
 * template and is never sent again until the checklist is rebuilt.
 * Input: the business in one line and each item's key | label | section — no
 * facts and no values. Every phrasing is checked (`phrasingIsSafe`): no
 * figures, no legal rule stated as fact, no add-back talk, no name that
 * isn't in the label, the deal's province/state or the industry playbook's
 * regulators and acronyms. A rejected one keeps the template. Written onto
 * the stored plan under a compare-and-set on `computedAt` (a rebuild wins).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Deal, InterviewPlan } from "@shared/schema";
import { CIM_SECTIONS } from "@shared/schema";
import { agentConfig } from "./config/load-config";
import { getInterviewPlan } from "./interview-plan";
import { findLegalAssertions } from "./fact-guards";
import { jurisdictionOf, mentionsNormalisation } from "./reply-guards";
import { buildIndustryKnowledge } from "./industry-loader";

export interface PhrasingInput { key: string; label: string; section: string }
export interface PhrasingOutput { key: string; askAs: string; whyItMatters: string }

export const PHRASE_TOOL = {
  name: "phrase_checklist",
  description: "For each checklist item: one plain spoken question a business broker can ask the owner, and why buyers care.",
  input_schema: {
    type: "object" as const,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["key", "askAs", "whyItMatters"],
          properties: {
            key: { type: "string" },
            askAs: { type: "string", description: "One spoken question, ≤ 22 words, plain words, no figures, no names" },
            whyItMatters: { type: "string", description: "Why buyers care, ≤ 18 words" },
          },
        },
      },
    },
  },
};

export const PHRASING_SYSTEM = `You write the questions a business broker asks the owner of a business being sold, one per checklist item.
- One plain, friendly, spoken question per item, at most 22 words, ending with "?".
- No figures, no years, no names of people or companies (regulators and licences named in the item are fine).
- Never state a legal rule as fact; never mention add-backs, normalised earnings, SDE, valuations or multiples.
- "whyItMatters": why a buyer cares, at most 18 words, plain words.
- Return every item you were given, by its key.`;

// ─────────────────────────────────────────────────────────────────────────
// The guard (pure)
// ─────────────────────────────────────────────────────────────────────────

const COMMON_CAPS = new Set(["I", "I'd", "I'm", "CIM", "OK", "Ok"]);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/** Names the phrasing may use: the deal's province/state and country, the playbook's regulators, licences and acronyms. */
export function allowedNames(deal: Pick<Deal, "industry"> & { subIndustry?: string | null; location?: string | null }): Set<string> {
  const out = new Set<string>();
  const loc = String(deal.location ?? "");
  for (const w of loc.match(/[A-Z][A-Za-z.'-]+/g) ?? []) out.add(w.replace(/[.,]$/, ""));
  const j = jurisdictionOf(loc);
  if (j === "CA") ["Canada", "Canadian", "CRA"].forEach((w) => out.add(w));
  if (j === "US") ["US", "USA", "IRS", "American"].forEach((w) => out.add(w));
  let playbook = "";
  try {
    playbook = buildIndustryKnowledge(deal.industry, deal.subIndustry ?? null);
  } catch {
    playbook = "";
  }
  // All-caps acronyms (TSSA, ESA, WSIB, EMR) and capitalised words next to "licence/registration/act/board/college".
  for (const m of playbook.match(/\b[A-Z][A-Z0-9&]{1,7}\b/g) ?? []) out.add(m);
  for (const m of playbook.match(/\b(?:[A-Z][a-z]+\s){1,3}(?:Licen[cs]e|Registration|Act|Board|College|Authority|Association|Ministry|Certificate|Code)\b/g) ?? []) {
    for (const w of m.split(/\s+/)) out.add(w);
  }
  return out;
}

/** Is a phrasing safe to show? (no figures, no legal claims, no add-back talk, no stray names) Pure. */
export function phrasingIsSafe(item: { label: string }, out: { askAs: string; whyItMatters: string }, allowed: ReadonlySet<string>): boolean {
  const ask = String(out.askAs ?? "").trim();
  const why = String(out.whyItMatters ?? "").trim();
  if (!ask || !why || !ask.endsWith("?")) return false;
  if (words(ask).length > 22 || words(why).length > 18) return false;
  if (/\d{2,}/.test(ask) || /\d{2,}/.test(why)) return false;
  if (findLegalAssertions(ask).length > 0 || findLegalAssertions(why).length > 0) return false;
  if (mentionsNormalisation(ask) || mentionsNormalisation(why)) return false;
  const labelWords = new Set(words(item.label).map((w) => w.replace(/[^A-Za-z0-9&'-]/g, "")));
  for (const text of [ask, why]) {
    const ws = words(text);
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i].replace(/[^A-Za-z0-9&'-]/g, "");
      if (!w || !/^[A-Z]/.test(w)) continue;
      const sentenceStart = i === 0 || /[.?!:]$/.test(ws[i - 1]);
      if (sentenceStart && !/^[A-Z]{2,}/.test(w)) continue;
      if (COMMON_CAPS.has(w) || labelWords.has(w) || allowed.has(w)) continue;
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// The call
// ─────────────────────────────────────────────────────────────────────────

export type PhrasingModel = (args: { system: string; user: string }) => Promise<unknown>;

let modelOverride: PhrasingModel | null = null;
export function _setPhrasingModelForTests(fn: PhrasingModel | null): void {
  modelOverride = fn;
}

let client: Anthropic | null = null;
const realModel: PhrasingModel = async ({ system, user }) => {
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000 });
  const res = await client.messages.create({
    model: agentConfig.models.supportingAgents,
    temperature: 0,
    max_tokens: 3000,
    system,
    tools: [PHRASE_TOOL as unknown as Anthropic.Tool],
    tool_choice: { type: "tool", name: PHRASE_TOOL.name },
    messages: [{ role: "user", content: user }],
  });
  const block = res.content.find((b) => b.type === "tool_use");
  return block && block.type === "tool_use" ? block.input : null;
};

/** The user message: the business in one line, then one line per item (no facts, no values). Pure. */
export function phrasingUser(deal: Pick<Deal, "industry"> & { subIndustry?: string | null; location?: string | null }, items: PhrasingInput[]): string {
  const where = String(deal.location ?? "").trim();
  const head = `The business: ${[deal.industry, deal.subIndustry].filter(Boolean).join(" — ") || "a small business"}${where ? `, ${where}` : ""}.`;
  return [head, "", "Checklist items (key | label | CIM section):", ...items.map((i) => `${i.key} | ${i.label} | ${i.section}`)].join("\n");
}

const inFlight = new Set<string>();
const lastFailure = new Map<string, number>();
const RETRY_AFTER_MS = 60 * 60_000;

export interface PhrasingDeps {
  readDeal(id: string): Promise<Deal | undefined>;
  /** Writes the plan when its computedAt is still `expectedComputedAt` (compare-and-set); false when a rebuild won. */
  writePlan(id: string, plan: InterviewPlan, expectedComputedAt: string): Promise<boolean>;
}

const defaultDeps: PhrasingDeps = {
  async readDeal(id) {
    const { storage } = await import("../storage");
    return storage.getDeal(id);
  },
  async writePlan(id, plan, expectedComputedAt) {
    const { withDealFactsLock } = await import("../documents/facts-lock");
    const { storage } = await import("../storage");
    return withDealFactsLock(id, async () => {
      const fresh = await storage.getDeal(id);
      const stored = fresh?.interviewPlan as InterviewPlan | null | undefined;
      if (!stored || stored.computedAt !== expectedComputedAt) return false;
      await storage.updateDeal(id, { interviewPlan: plan } as never);
      return true;
    });
  },
};

export type PhrasingResult = "skipped" | "busy" | "done" | "failed" | "lost_race";

/**
 * Writes the suggested ways to ask onto the deal's ready plan (background).
 * A no-op with the key off or schedulers off, when the plan isn't ready or
 * is already phrased, while one is in flight, and within an hour of a failure.
 */
export async function ensurePlanPhrasing(deal: Deal, deps: PhrasingDeps = defaultDeps, opts: { now?: number } = {}): Promise<PhrasingResult> {
  if (process.env.ANTHROPIC_API_KEY === "disabled" || process.env.DISABLE_SCHEDULERS === "1") return "skipped";
  const now = opts.now ?? Date.now();
  const plan = getInterviewPlan(deal);
  if (!plan || plan.status !== "ready") return "skipped";
  // (Once per build: an item already sent — even one whose phrasing was refused — is never sent again.)
  const tried = new Set(plan.phrasingTried ?? []);
  const todo = plan.items.filter((i) => !i.askAs && !tried.has(i.key));
  if (todo.length === 0) return "skipped";
  if (inFlight.has(deal.id)) return "busy";
  const failedAt = lastFailure.get(deal.id);
  if (failedAt && now - failedAt < RETRY_AFTER_MS) return "skipped";
  inFlight.add(deal.id);
  try {
    const sectionTitle = (k: string) => CIM_SECTIONS.find((s) => s.key === k)?.title ?? k;
    const input = todo.map((i) => ({ key: i.key, label: i.label, section: sectionTitle(i.sectionKey) }));
    const raw = await (modelOverride ?? realModel)({ system: PHRASING_SYSTEM, user: phrasingUser(deal as never, input) });
    const outs = Array.isArray((raw as { items?: unknown })?.items) ? ((raw as { items: unknown[] }).items as PhrasingOutput[]) : [];
    const allowed = allowedNames(deal as never);
    const byKey = new Map(outs.filter((o) => o && typeof o.key === "string").map((o) => [o.key, o] as const));
    const items = plan.items.map((it) => {
      if (it.askAs) return it;
      const o = byKey.get(it.key);
      if (!o || !phrasingIsSafe(it, o, allowed)) return it;
      return { ...it, askAs: o.askAs.trim(), whyItMatters: o.whyItMatters.trim() };
    });
    const phrasingTried = Array.from(new Set([...Array.from(tried), ...todo.map((i) => i.key)]));
    const ok = await deps.writePlan(deal.id, { ...plan, items, phrasedAt: new Date(now).toISOString(), phrasingTried }, plan.computedAt);
    lastFailure.delete(deal.id);
    return ok ? "done" : "lost_race";
  } catch (err) {
    lastFailure.set(deal.id, now);
    console.warn(`[plan-phrasing] couldn't phrase the checklist for ${deal.id}:`, (err as Error).message);
    return "failed";
  } finally {
    inFlight.delete(deal.id);
  }
}

/**
 * Right after a checklist build succeeds (background): its suggested ways to
 * ask, once per deal (new items only after a rebuild — phrased items keep
 * theirs). So the Overview card, the checklist and the call sheet read as
 * questions on every deal, not only once a session together has started.
 * Never with the key off or schedulers off; never from a GET of its own.
 */
export async function phraseAfterPlanBuild(dealId: string, deps: PhrasingDeps = defaultDeps): Promise<PhrasingResult> {
  if (process.env.ANTHROPIC_API_KEY === "disabled" || process.env.DISABLE_SCHEDULERS === "1") return "skipped";
  const deal = await deps.readDeal(dealId);
  if (!deal) return "skipped";
  return ensurePlanPhrasing(deal, deps);
}

export function _resetPhrasingForTests(): void {
  inFlight.clear();
  lastFailure.clear();
}
