// LIVE evaluation of the seller-intent classifier (supporting model) over the
// phrase corpus — needs a real ANTHROPIC_API_KEY. Not part of the offline
// suite (no .test.ts suffix).
// Run: ANTHROPIC_API_KEY=… DATABASE_URL=postgres://unused/x npx tsx tests/interview/seller-intent-live.ts
import { classifySellerIntent, combineIntent, quickIntent, planIntentEdits, type SellerIntent } from "../../server/interview/seller-intent";
import { STOP_FIRM, STOP_SOFT, BUSINESS, NEUTRAL, CORRECTIONS, RETRACTIONS, PRIVACY, CONTEXT, DEFERRALS, DEFERRAL_PREV } from "./seller-intent-corpus.data";

type Case = { kind: string; message: string; prevAi?: string; facts?: Array<{ key: string; value: string }>; check: (i: SellerIntent) => string | null };

const PREV = "What's the lease term on the main location, and who holds it?";
const cases: Case[] = [
  ...STOP_FIRM.map((m) => ({ kind: "stop-firm", message: m, check: (i: SellerIntent) => (i.stop === "firm" ? null : `stop=${i.stop}`) })),
  ...STOP_SOFT.map((m) => ({ kind: "stop-soft", message: m, check: (i: SellerIntent) => (i.stop !== "none" ? null : "stop=none") })),
  ...BUSINESS.map((m) => ({ kind: "business", message: m, check: (i: SellerIntent) => (i.stop === "none" && !i.retractions.length && !i.privacyRequests.length ? null : `stop=${i.stop} r=${i.retractions.length} p=${i.privacyRequests.length}`) })),
  ...NEUTRAL.map((m) => ({ kind: "neutral", message: m, check: (i: SellerIntent) => (i.stop === "none" && !i.retractions.length && !i.corrections.length && !i.privacyRequests.length ? null : JSON.stringify(i)) })),
  ...CORRECTIONS.map((c) => ({
    kind: "correction", message: c.message, facts: c.facts,
    check: (i: SellerIntent) => {
      if (i.stop !== "none") return `stop=${i.stop}`;
      if (i.retractions.length) return `listed as a withdrawal: ${JSON.stringify(i.retractions)}`;
      const k = i.corrections[0];
      if (!k) return c.fieldHint ? "no correction" : null; // nothing on file to correct: the interview records the new value
      if (!c.newValue.test(k.new)) return `new=${k.new}`;
      if (c.fieldHint && k.fieldHint !== c.fieldHint) return `fieldHint=${k.fieldHint}`;
      if (c.fieldHint && !(k.correctedValue && c.newValue.test(k.correctedValue))) return `correctedValue=${k.correctedValue}`;
      return null;
    },
  })),
  ...RETRACTIONS.map((r) => ({
    kind: "retraction", message: r.message, facts: r.facts,
    check: (i: SellerIntent) => {
      if (i.stop !== "none") return `stop=${i.stop}`;
      if (i.corrections.length) return `listed as a correction: ${JSON.stringify(i.corrections)}`;
      const x = i.retractions[0];
      if (!x) return "no withdrawal";
      if (x.fieldHint !== r.fieldHint) return `fieldHint=${x.fieldHint}`;
      // What the plan does with it: only the withdrawn claim goes.
      const info: Record<string, unknown> = { [r.fieldHint]: r.facts[0].value, _fieldSources: { [r.fieldHint]: { source: "interview", sessionId: "s", turn: 1 } } };
      const plan = planIntentEdits({ intent: i, info, changes: [], modelRetracted: [], modelPrivateNotes: [], sellerMessage: r.message, sessionId: "s", turn: 2 });
      if (r.keeps) {
        const e = plan.partialEdits[0];
        if (!e || !r.keeps.test(e.to)) return `partial edit wrong: ${JSON.stringify(plan.partialEdits)} ${JSON.stringify(plan.retractions)}`;
      } else if (plan.retractions.length !== 1 && plan.partialEdits.length !== 1) return `nothing withdrawn: ${plan.log.join("; ")}`;
      return null;
    },
  })),
  ...PRIVACY.map((p) => ({
    kind: "privacy", message: p.message, facts: p.facts,
    check: (i: SellerIntent) => {
      if (i.retractions.length) return `listed as a withdrawal: ${JSON.stringify(i.retractions)}`;
      const x = i.privacyRequests[0];
      if (!x) return "no privacy request";
      if (!p.sensitive.test(x.detail)) return `detail=${x.detail}`;
      if (!x.sensitiveTerms.some((t) => p.sensitive.test(t))) return `terms=${x.sensitiveTerms.join(",")}`;
      return null;
    },
  })),
  ...CONTEXT.map((c) => ({ kind: "context", message: c.message, prevAi: c.prevAi, check: (i: SellerIntent) => ((i.stop !== "none") === c.stop ? null : `stop=${i.stop}`) })),
  // A task promised for later / one question set aside: the interview goes on.
  ...DEFERRALS.map((m) => ({ kind: "deferral", message: m, prevAi: DEFERRAL_PREV, check: (i: SellerIntent) => (i.stop === "none" && !i.retractions.length ? null : `stop=${i.stop} r=${i.retractions.length}`) })),
];

(async () => {
  const results: Array<{ kind: string; message: string; err: string | null; ms: number }> = [];
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const c = cases[next++];
      const t = Date.now();
      const m = await classifySellerIntent({ sellerMessage: c.message, prevAiMessage: c.prevAi ?? PREV, recentFacts: c.facts ?? [] }, 30_000);
      const ms = Date.now() - t;
      if (!m) { results.push({ kind: c.kind, message: c.message, err: "classifier failed", ms }); continue; }
      const intent = combineIntent(quickIntent(c.message, c.prevAi ?? PREV), m);
      // The business/neutral checks judge the classifier alone (the patterns are tested offline).
      results.push({ kind: c.kind, message: c.message, err: c.check(["business", "neutral"].includes(c.kind) ? m : intent), ms });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const kinds = Array.from(new Set(results.map((r) => r.kind)));
  for (const k of kinds) {
    const rs = results.filter((r) => r.kind === k);
    console.log(`${k.padEnd(12)} ${rs.filter((r) => !r.err).length}/${rs.length}`);
  }
  const fails = results.filter((r) => r.err);
  for (const f of fails) console.log(`FAIL [${f.kind}] ${f.message.slice(0, 90)} — ${f.err}`);
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`latency p50 ${lat[Math.floor(lat.length / 2)]}ms p90 ${lat[Math.floor(lat.length * 0.9)]}ms max ${lat[lat.length - 1]}ms`);
  console.log(`TOTAL ${results.length - fails.length}/${results.length}`);
})();
