// Replays a recorded live interview (a driver run log: {turns:[{role,text,shouldEnd,why,…}]})
// through the real processTurn with the recorded model replies scripted in
// place of the model — the guards, stop detection, governance and save run
// exactly as in production, offline. Not a test file (no .test.ts suffix):
// run it by hand to re-check a live transcript after a guard change.
// usage: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/replay-live.ts <run.json> [minTurns]
import fs from "node:fs";
import { installHarness, baseDeal, ai, seller } from "./turn-harness";
import { processTurn } from "../../server/interview/session-manager";

(async () => {
  const run = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const turns: Array<{ role: string; text: string; shouldEnd?: boolean; why?: string; section?: string; importance?: string }> = run.turns;
  const h = installHarness(baseDeal(), { messages: [ai(turns[0].text)] });
  let sellerTurns = 0;
  for (let i = 1; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "seller") continue;
    sellerTurns++;
    const reply = turns[i + 1];
    if (!reply || reply.role !== "ai") break;
    h.script.length = 0;
    h.script.push({ message: reply.text, shouldEnd: !!reply.shouldEnd, endReason: reply.shouldEnd ? "Seller wants to stop" : undefined, whyItMatters: reply.why, targetSection: reply.section, importance: reply.importance });
    // Anything the guards ask the model again gets a plain next question.
    for (let k = 0; k < 4; k++) h.script.push({ message: "On the Hillhurst lease: is there a personal guarantee from you on it?", targetSection: "location", importance: "important" });
    const before = h.logs.length;
    const out = await processTurn("deal-1", "sess-1", t.text);
    const logs = h.logs.slice(before).filter((l) => /stop signal|Blocked|Forcing|Filler guard|Output guard|Retraction|appended/.test(l));
    process.stdout.write(`\n[SELLER ${sellerTurns}] ${t.text.replace(/\s+/g, " ").slice(0, 140)}\n`);
    for (const l of logs) process.stdout.write(`   log: ${l.slice(0, 200)}\n`);
    process.stdout.write(`[AI ${sellerTurns}] shouldEnd=${out.shouldEnd} ${out.message.replace(/\s+/g, " ").slice(0, 400)}\n`);
    if (out.shouldEnd) { process.stdout.write(`INTERVIEW ENDED at seller turn ${sellerTurns}; interviewCompleted=${h.deal.interviewCompleted}\n`); break; }
  }
  process.stdout.write(`\nseller turns replayed: ${sellerTurns}; interviewCompleted=${h.deal.interviewCompleted}\n`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
