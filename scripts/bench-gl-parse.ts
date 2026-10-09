/**
 * bench-gl-parse.ts — how fast and how big a 200,000-entry ledger read is
 * (gl spec §12.3). No database, no AI: reads the file, detects, parses,
 * and counts — the database inserts are measured post-deploy (§12.4).
 *
 *   npx tsx scripts/make-sample-gl.ts --rows 200000 --out <dir>
 *   npx tsx scripts/bench-gl-parse.ts <dir>/gl-200k.csv [<dir>/gl-200k.xlsx]
 *
 * Targets: CSV ≤ 5 s, adding ≤ 150 MB to the process's RSS; XLSX (in the
 * worker, a 15 MB file) ≤ 6 s with the main thread's heap growing ≤ 100 MB
 * (the worker is capped at 900 MB; process RSS includes the worker's heap).
 */
import { ledgerFileKind, peekRows, readLedgerRows } from "../server/gl/read-file";
import { detectLayout } from "../server/gl/detect";
import { LedgerParser } from "../server/gl/parse";
import { withHeavySheetSlot } from "../server/documents/heavy-sheet";

const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;

async function bench(file: string): Promise<{ ok: boolean }> {
  const kind = ledgerFileKind(file);
  if (!kind) throw new Error(`not a ledger file: ${file}`);
  if (global.gc) global.gc();
  const rss0 = process.memoryUsage().rss;
  const heap0 = process.memoryUsage().heapUsed;
  let peak = rss0;
  let heapPeak = heap0;
  const t0 = Date.now();
  // RSS is the whole process (the Excel worker's heap included); heapUsed is the main thread's own.
  const sampler = setInterval(() => { const m = process.memoryUsage(); peak = Math.max(peak, m.rss); heapPeak = Math.max(heapPeak, m.heapUsed); }, 50);
  let entries = 0;
  let accounts = new Set<string>();
  const run = async () => {
    const det = detectLayout(await peekRows(file, kind));
    if (!det) throw new Error("no layout detected");
    const p = new LedgerParser(det.layout);
    await readLedgerRows(file, kind, (rows) => {
      for (const r of rows) p.push(r);
      for (const e of p.take()) { entries++; accounts.add(e.accountKey); }
    });
    for (const e of p.take(true)) { entries++; accounts.add(e.accountKey); }
  };
  if (kind === "xlsx") await withHeavySheetSlot(run);
  else await run();
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  const ms = Date.now() - t0;
  const growth = peak - rss0;
  const heapGrowth = heapPeak - heap0;
  const limitMs = kind === "csv" ? 5000 : 6000;
  // CSV: what the read adds to the process (the tsx loader alone is ~85 MB here); Excel: the main thread's own heap (the worker is capped).
  const ok = ms <= limitMs && (kind === "csv" ? growth <= 150e6 : heapGrowth <= 100e6 && growth <= 900e6);
  console.log(`${file}\n  ${kind}: ${entries.toLocaleString()} entries, ${accounts.size} accounts in ${(ms / 1000).toFixed(1)} s · process RSS ${mb(rss0)} → peak ${mb(peak)} (+${mb(growth)}) · main-thread heap +${mb(heapGrowth)} · ${ok ? "within target" : "OVER TARGET"} (≤ ${limitMs / 1000} s; ${kind === "csv" ? "RSS growth ≤ 150 MB" : "main-thread heap ≤ +100 MB, worker ≤ 900 MB"})`);
  return { ok };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: npx tsx scripts/bench-gl-parse.ts <ledger.csv|xlsx> [...]");
  process.exit(2);
}
let allOk = true;
for (const f of files) allOk = (await bench(f)).ok && allOk;
process.exit(allOk ? 0 : 1);
