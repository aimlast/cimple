/**
 * Suggested ways to ask the industry checklist (specs/together.md §3.5, §9):
 * NOT needed for correctness — a deal's checklist phrases itself the first
 * time a session together starts there; until then its industry items read
 * "Can you tell me about …?".
 *
 * DRY RUN by default (reads only, no AI): lists the deals whose ready
 * checklist has items with no suggested question, with the item counts and
 * the estimated cost.
 *
 * --apply --deal <id> phrases ONE deal's checklist: ONE supporting-model call
 * (≈ $0.02–0.04). COSTS AI — only with the founder's go-ahead. It needs the
 * real key in the environment and refuses with ANTHROPIC_API_KEY=disabled.
 *
 *   ANTHROPIC_API_KEY=disabled DATABASE_URL=… npx tsx scripts/backfill-plan-phrasing.ts            # dry run
 *   ANTHROPIC_API_KEY=… DATABASE_URL=… npx tsx scripts/backfill-plan-phrasing.ts --apply --deal <id>   # costs AI
 */
import { db } from "../server/db";
import { deals, type Deal, type InterviewPlan } from "@shared/schema";

const COST_PER_DEAL = "$0.02–0.04";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dealId = (() => { const i = args.indexOf("--deal"); return i >= 0 ? args[i + 1] : undefined; })();
  const rows = (await db.select({ id: deals.id, businessName: deals.businessName, industry: deals.industry, interviewPlan: deals.interviewPlan, archivedAt: deals.archivedAt, demoKey: deals.demoKey }).from(deals)) as Array<Pick<Deal, "id" | "businessName" | "industry" | "interviewPlan" | "archivedAt" | "demoKey">>;
  const todo = rows
    .map((d) => {
      const plan = d.interviewPlan as InterviewPlan | null;
      const items = plan?.status === "ready" ? plan.items ?? [] : [];
      const missing = items.filter((i) => !i.askAs).length;
      return { d, items: items.length, missing };
    })
    .filter((x) => x.missing > 0);

  if (!apply) {
    console.log(`DRY RUN — no AI, nothing written. ${todo.length} deal(s) have checklist items with no suggested question:`);
    for (const x of todo) {
      console.log(`  ${x.d.id}  ${x.d.businessName}  (${x.d.industry ?? "no industry"})  ${x.missing} of ${x.items} items${x.d.archivedAt ? "  [archived]" : ""}${x.d.demoKey ? "  [demo]" : ""}`);
    }
    console.log(`Estimated cost if every one were phrased: ${todo.length} call(s), ${COST_PER_DEAL} each. Each phrases itself the first time a session together starts there.`);
    process.exit(0);
  }
  if (!dealId) throw new Error("--apply needs --deal <id> (one deal at a time, with the founder's go-ahead)");
  if (process.env.ANTHROPIC_API_KEY === "disabled" || !process.env.ANTHROPIC_API_KEY) throw new Error("--apply calls the AI: it needs the real key (and the founder's go-ahead)");
  const { storage } = await import("../server/storage");
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error("no such deal");
  // (The scheduler switch doesn't apply to a one-off run.)
  delete process.env.DISABLE_SCHEDULERS;
  const { ensurePlanPhrasing } = await import("../server/interview/plan-phrasing");
  const result = await ensurePlanPhrasing(deal);
  console.log(`${deal.businessName}: ${result}`);
  process.exit(0);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
