/**
 * xlsx-worker.ts — the code that reads an Excel workbook inside a
 * worker_threads worker (gl spec D10, E12, E13).
 *
 * Why a worker: the installed SheetJS (xlsx 0.18.5) has two published flaws
 * a crafted workbook can trigger — prototype pollution (CVE-2023-30533) and
 * a regular-expression hang (CVE-2024-22363) — and a big workbook peaks at
 * ~640 MB while it is read. In a worker, polluted prototypes stay in the
 * worker's own realm, a hang is cut off by the timeout, and the memory cap
 * (resourceLimits) kills the worker, never the web server.
 *
 * The worker runs this source with `eval: true` (no separate build entry),
 * loading SheetJS by the absolute path the parent resolved. Runtime code is
 * embedded here as a string (CLAUDE.md: runtime files must be in the bundle).
 *
 * Protocol (backpressure — the parent asks for each batch):
 *   workerData = { xlsxPath, filePath, mode: "rows" | "csv", sheetRows?, batch, testPollute? }
 *   rows mode:  worker → { type: "rows", sheet, rows: [{ rowNo, cells }] }, waits for "next";
 *               finally { type: "done", sheets: [{ name, rows }] }
 *   csv mode:   worker → { type: "csv", text }   (exactly what parser.ts produced in-thread)
 *   errors:     worker → { type: "error", code: "unreadable", message }
 *
 * Cells: text as is; numbers as numbers; a number in a date-formatted cell
 * as { date: "yyyy-mm-dd" } read from the serial day (SSF.parse_date_code —
 * never through a JavaScript Date, which shifts by the server's time zone);
 * booleans as "TRUE"/"FALSE"; errors and blanks as null. Fully blank rows
 * are not sent, but every row counts toward rowNo (1-based across sheets,
 * so "row 18,422" is the row the broker sees in Excel, offset by earlier sheets).
 */
export const XLSX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
let waiting = null;
parentPort.on("message", (m) => { if (m === "next" && waiting) { const w = waiting; waiting = null; w(); } });
const nextBatch = () => new Promise((resolve) => { waiting = resolve; });
function pad(n) { return String(n).padStart(2, "0"); }
(async () => {
  try {
    if (workerData.testPollute) { Object.prototype.glWorkerPolluted = true; }
    const XLSX = require(workerData.xlsxPath);
    const buf = fs.readFileSync(workerData.filePath);
    if (workerData.mode === "csv") {
      const workbook = XLSX.read(buf);
      const lines = [];
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        if (csv.trim()) { lines.push("--- Sheet: " + sheetName + " ---"); lines.push(csv); }
      }
      parentPort.postMessage({ type: "csv", text: lines.join("\n") });
      return;
    }
    const opts = { dense: true, cellDates: false, cellNF: true, cellText: false, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false };
    if (workerData.sheetRows) opts.sheetRows = workerData.sheetRows;
    const wb = XLSX.read(buf, opts);
    const isDate = (z) => { try { return typeof z === "string" && z !== "General" && XLSX.SSF.is_date(z); } catch (e) { return false; } };
    const batchSize = workerData.batch || 2000;
    const sheets = [];
    let offset = 0;
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws || !ws["!ref"]) { sheets.push({ name, rows: 0 }); continue; }
      const range = XLSX.utils.decode_range(ws["!ref"]);
      const data = Array.isArray(ws["!data"]) ? ws["!data"] : ws;
      let batch = [];
      let sent = 0;
      for (let R = 0; R <= range.e.r; R++) {
        const row = Array.isArray(data[R]) ? data[R] : null;
        if (!row) continue;
        const cells = [];
        let any = false;
        for (let C = 0; C <= range.e.c; C++) {
          const cell = row[C];
          let v = null;
          if (cell && cell.v !== undefined && cell.v !== null) {
            if (cell.t === "n") {
              if (isDate(cell.z)) {
                const d = XLSX.SSF.parse_date_code(cell.v);
                v = d && d.y ? { date: d.y + "-" + pad(d.m) + "-" + pad(d.d) } : cell.v;
              } else v = cell.v;
            } else if (cell.t === "s" || cell.t === "str") v = String(cell.v);
            else if (cell.t === "b") v = cell.v ? "TRUE" : "FALSE";
            else if (cell.t === "d") { const dt = cell.v instanceof Date ? cell.v : new Date(cell.v); v = isNaN(dt.getTime()) ? null : { date: dt.toISOString().slice(0, 10) }; }
            else v = null;
          }
          if (v !== null && v !== "") any = true;
          cells.push(v === "" ? null : v);
        }
        while (cells.length && cells[cells.length - 1] === null) cells.pop();
        if (!any) continue;
        batch.push({ rowNo: offset + R + 1, cells });
        if (batch.length >= batchSize) {
          parentPort.postMessage({ type: "rows", sheet: name, rows: batch });
          sent += batch.length;
          batch = [];
          await nextBatch();
        }
      }
      if (batch.length) {
        parentPort.postMessage({ type: "rows", sheet: name, rows: batch });
        sent += batch.length;
        await nextBatch();
      }
      sheets.push({ name, rows: sent });
      offset += range.e.r + 1;
    }
    parentPort.postMessage({ type: "done", sheets });
  } catch (err) {
    parentPort.postMessage({ type: "error", code: "unreadable", message: String((err && err.message) || err).slice(0, 300) });
  }
})();
`;
