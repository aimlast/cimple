/**
 * AI deep check — every buyer who passes the first-pass match gets read
 * against the deal by the supporting model, not just the top few.
 *
 * The model sees the deal's full verified fact base (the same extractedInfo
 * the CIM is written from — the industry-specific depth included), and each
 * buyer's whole profile: what they told us (NDA answers, "looking for"),
 * their criteria, and — broker-facing only — the broker's private CRM
 * summary and the listings they've asked about. It returns a verdict, a
 * 0-100 fit, a specific reason, watch-outs, and a blind-safe hook the
 * outreach draft can use.
 *
 * Results are cached per buyer (profile fingerprint) and per deal (fact
 * fingerprint): re-running only re-checks what changed. Broker-facing only —
 * nothing here is ever shown to a buyer.
 */
import { effectiveAskingPrice } from "../information/deal-mirror";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { storage } from "../storage";
import { agentConfig } from "../interview/config/load-config";
import { scoreBuyersForDeal, suggestionPools, reachedBuyers, type ScoredBuyer } from "./suggested";
import type { BuyerDeepCheck, BuyerDeepCheckResult, CrmBuyerProfile, Deal } from "@shared/schema";
import { blindLeakTerms, isBlindSafe } from "@shared/blind-guard";
import { keepOutFor } from "../cim/keep-out";
import { outreachAngleGuard, angleKeepsOut, type AngleGuard } from "./angle-keep-out";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BATCH = 6;
const CONCURRENCY = 3;
const running = new Set<string>();

const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);

function valueText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && "value" in (v as any)) return valueText((v as any).value);
  return JSON.stringify(v);
}

/** The deal's verified facts, as the model reads them. */
export function dealBrief(deal: Deal): string {
  const info = ((deal as any).extractedInfo || {}) as Record<string, unknown>;
  const lines = [
    `Industry: ${deal.industry || "unknown"}${(deal as any).subIndustry ? ` / ${(deal as any).subIndustry}` : ""}`,
    effectiveAskingPrice(deal) ? `Asking price: ${effectiveAskingPrice(deal)}` : "",
  ];
  for (const [k, v] of Object.entries(info)) {
    if (k.startsWith("_")) continue;             // broker-private notes / provenance
    const t = valueText(v).replace(/\s+/g, " ").trim();
    if (!t) continue;
    lines.push(`${k}: ${t.slice(0, 600)}`);
  }
  return lines.filter(Boolean).join("\n").slice(0, 16000);
}

function buyerCard(s: ScoredBuyer): Record<string, unknown> {
  const b = s.buyer;
  const c = (b.buyerCriteria as Record<string, unknown>) || {};
  const crm = (s.contact?.crmProfile as CrmBuyerProfile | null) || null;
  const criteria = Object.fromEntries(Object.entries(c).filter(([k, v]) => k !== "lookingFor" && v != null && v !== "" && !(Array.isArray(v) && !v.length)));
  return {
    type: b.buyerType || null,
    company: b.company || null,
    background: b.background || null,
    lookingFor: c.lookingFor || null,
    targetIndustries: b.targetIndustries || [],
    targetLocations: b.targetLocations || [],
    criteria,
    liquidFunds: s.fundsRange ?? b.liquidFunds ?? null,
    proofOfFunds: !!b.hasProofOfFunds,
    brokerCrmSummary: crm?.background || null,
    listingsTheyAskedAbout: (crm?.inquiries || []).slice(0, 8).map((q) => q.title),
    ruleBasedMatch: s.breakdown ? `${s.breakdown.criteriaMatched}/${s.breakdown.criteriaTested} criteria met` : "not testable",
    // An exclusion the rules couldn't settle (a market the business only serves, or a narrower slice) — the AI judges it.
    ...(s.breakdown?.exclusionCaution ? { exclusionToJudge: `Buyer rules out "${s.breakdown.exclusionCaution.by}"; ${s.breakdown.exclusionCaution.why === "market" ? "the business names it only as a market it serves" : "that may be narrower than this business"} — decide whether the exclusion applies.` } : {}),
  };
}

const TOOL: Anthropic.Tool = {
  name: "buyer_fit",
  description: "Fit of each buyer for this business.",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref: { type: "string" },
            verdict: { type: "string", enum: ["strong", "good", "possible", "unlikely"] },
            fitScore: { type: "integer", minimum: 0, maximum: 100 },
            whyFit: { type: "string", description: "1-2 sentences, specific to this buyer AND this business (name the actual overlap: industry, size, location, model, their stated goals). No generic praise." },
            watchOuts: { type: "array", items: { type: "string" }, description: "0-2 short concerns (budget short of price, wants owner-absent but owner works 50h, etc.)." },
            outreachAngle: { type: ["string", "null"], description: "One sentence the broker could open the email with. MUST be blind-safe: no business name, owner, city/street, or exact figures — only industry, region, ranges, qualities." },
          },
          required: ["ref", "verdict", "fitScore", "whyFit", "watchOuts", "outreachAngle"],
        },
      },
    },
    required: ["results"],
  },
};

async function checkBatch(brief: string, batch: Array<{ ref: string; card: Record<string, unknown> }>, guard: AngleGuard) {
  const heldNote = guard.clauses.length > 0
    ? `\n\nKEPT FROM BUYERS (the seller or broker asked that these not reach buyers — you may weigh them for whyFit and watchOuts, but the outreachAngle must not mention, describe or hint at any of them):\n${guard.clauses.map((c) => `- ${c.slice(0, 300)}`).join("\n")}`
    : "";
  const response = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 3000,
    temperature: 0,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "buyer_fit" },
    system: [
      {
        type: "text",
        text: [
          "You are a senior sell-side M&A advisor judging which buyers genuinely fit a business for sale.",
          "Weigh: industry/sub-industry and business-model fit; size vs budget, SDE/EBITDA and price ranges; geography; buyer type (an individual operator vs strategic add-on vs PE platform) against owner involvement, management depth, and transition; stated goals and exclusions; financing capacity and proof of funds; signals from the listings they've enquired about.",
          "Be critical and calibrated: 'strong' (80-100) only for a clear, specific fit on most dimensions; 'good' (60-79); 'possible' (35-59) when it could work with caveats or the profile is thin; 'unlikely' (<35) when there's a real mismatch. A thin profile is 'possible' at most — say what's missing.",
          "Never invent facts about the buyer or the business. Return one entry per buyer ref.",
        ].join(" "),
      },
      { type: "text", text: `THE BUSINESS (verified facts from the CIM):\n${brief}${heldNote}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: batch.map((b) => `<buyer ref="${b.ref}">\n${JSON.stringify(b.card)}\n</buyer>`).join("\n") }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  return ((block && block.type === "tool_use" ? block.input : {}) as { results?: any[] }).results ?? [];
}

export function isDeepCheckRunning(dealId: string) {
  return running.has(dealId);
}

/** Start (or refresh) the deep check for a deal in the background. */
export async function startBuyerDeepCheck(dealId: string): Promise<{ started: boolean; reason?: string }> {
  if (running.has(dealId)) return { started: false, reason: "already_running" };
  const deal = await storage.getDeal(dealId);
  if (!deal) return { started: false, reason: "not_found" };
  if (!process.env.ANTHROPIC_API_KEY) return { started: false, reason: "no_ai" };
  running.add(dealId);
  void runDeepCheck(deal)
    .catch(async (err) => {
      console.error("[deep-check] failed:", err);
      const current = ((await storage.getDeal(dealId))?.buyerDeepCheck as BuyerDeepCheck | null) || null;
      if (current) await storage.updateDeal(dealId, { buyerDeepCheck: { ...current, status: "failed", finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) } } as any);
    })
    .finally(() => running.delete(dealId));
  return { started: true };
}

async function runDeepCheck(deal: Deal) {
  const brief = dealBrief(deal);
  const angleTerms = blindLeakTerms(deal as any, { codename: deal.blindCodename });
  // The angle opens a pre-NDA email: it is held to the same keep-out as the CIM.
  const info = ((deal as any).extractedInfo || {}) as Record<string, unknown>;
  const guard = outreachAngleGuard(info, await keepOutFor(deal.id, info));
  const dealKey = hash([brief, guard]);
  const previous = (deal.buyerDeepCheck as BuyerDeepCheck | null) || null;
  const reusable = previous && previous.dealKey === dealKey ? previous.results : {};

  const [scored, outreach, access] = await Promise.all([
    scoreBuyersForDeal(deal),
    storage.getDealOutreachByDeal(deal.id),
    storage.getBuyerAccessByDeal(deal.id),
  ]);
  // Exactly the buyers the Suggested list would show and the button counted:
  // never those who already have access or who rule out the industry.
  const { pool, candidates } = suggestionPools(scored, reachedBuyers(outreach, access));
  const results: Record<string, BuyerDeepCheckResult> = {};
  const todo: Array<{ id: string; ref: string; card: Record<string, unknown>; key: string }> = [];
  candidates.forEach((s, i) => {
    const card = buyerCard(s);
    const key = hash(card);
    const prev = reusable[s.buyer.id];
    if (prev && prev.buyerKey === key) results[s.buyer.id] = prev;
    else todo.push({ id: s.buyer.id, ref: String(i + 1), card, key });
  });

  const state: BuyerDeepCheck = {
    status: "running", startedAt: new Date().toISOString(), dealKey,
    // skipped = clear rule mismatches the list still shows (0 of 2+ criteria met).
    total: candidates.length, done: Object.keys(results).length, skipped: pool.length - candidates.length, results,
  };
  await storage.updateDeal(deal.id, { buyerDeepCheck: state } as any);

  const batches: typeof todo[] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  let next = 0;
  let failures = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        const out = await checkBatch(brief, batch.map((b) => ({ ref: b.ref, card: b.card })), guard);
        for (const r of out) {
          const item = batch.find((b) => b.ref === String(r?.ref));
          if (!item) continue;
          results[item.id] = {
            verdict: ["strong", "good", "possible", "unlikely"].includes(r.verdict) ? r.verdict : "possible",
            fitScore: Math.max(0, Math.min(100, Math.round(Number(r.fitScore) || 0))),
            whyFit: String(r.whyFit || "").slice(0, 500),
            watchOuts: (Array.isArray(r.watchOuts) ? r.watchOuts : []).map(String).slice(0, 2),
            // Pre-NDA hook: dropped if it names anything identifying or draws on an item kept from buyers.
            outreachAngle: r.outreachAngle && isBlindSafe(String(r.outreachAngle), angleTerms) && angleKeepsOut(String(r.outreachAngle), guard) ? String(r.outreachAngle).slice(0, 300) : null,
            buyerKey: item.key,
            checkedAt: new Date().toISOString(),
          };
        }
      } catch (err) {
        failures++;
        console.error("[deep-check] batch failed:", err);
      }
      state.done = Object.keys(results).length;
      await storage.updateDeal(deal.id, { buyerDeepCheck: { ...state, results } } as any);
    }
  }));

  await storage.updateDeal(deal.id, {
    buyerDeepCheck: {
      ...state, results, done: Object.keys(results).length,
      status: failures && failures === batches.length && batches.length > 0 ? "failed" : "done",
      error: failures ? `${failures} of ${batches.length} batches failed — run again to finish` : undefined,
      finishedAt: new Date().toISOString(),
    },
  } as any);
}
