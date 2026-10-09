/**
 * map-columns-ai.ts — reads an unusual spreadsheet layout the rules couldn't
 * (gl spec §7.3, D8). Installed as the ledger reader's column mapper
 * (setGlColumnMapper) when this module loads.
 *
 * One forced tool call (map_ledger_columns) on the file's first ≤40 rows,
 * each cell cut to 40 characters (≤8,000 characters in all). The answer is
 * never trusted as is: indices must be inside the sample, exactly one date
 * column, an amount (or debit + credit), and a dry parse of the next 200
 * rows must read a date and an amount on ≥80% of the non-heading rows with
 * at least one account — else "needs columns". "Not a general ledger" →
 * the file fails with the plain message. An outage → needs columns (never
 * silent). Budget reserved first; key disabled → no call at all.
 * Cost ≈ $0.012 a file.
 */
import { agentConfig } from "../interview/config/load-config";
import { describeAiFailure, withAiRetry } from "../ai-retry";
import type { GlLedger } from "@shared/schema";
import type { GlLayout, GlRawRow, GlRole, GlSoftware } from "@shared/gl-types";
import { glAiClient, reserveGlAi, toolInput } from "./ai";
import { parseLedgerRows } from "./parse";
import { cellText } from "./text";
import { setGlColumnMapper } from "./ingest";

const ROLES: GlRole[] = ["date", "account", "account_number", "account_type", "name", "memo", "type", "number", "debit", "credit", "amount", "balance", "ignore"];
const SOFTWARE: GlSoftware[] = ["quickbooks_online", "quickbooks_desktop", "xero", "sage50", "wave", "freshbooks", "other"];

export const MAP_COLUMNS_TOOL = {
  name: "map_ledger_columns",
  description: "Say whether the spreadsheet is a general ledger and which column holds what.",
  input_schema: {
    type: "object",
    properties: {
      isGeneralLedger: { type: "boolean" },
      headerRow: { type: "integer", description: "0-based row index of the column headings, -1 if none" },
      columns: {
        type: "array",
        items: {
          type: "object",
          properties: { index: { type: "integer" }, role: { type: "string", enum: ROLES } },
          required: ["index", "role"],
        },
      },
      accountInHeadingRows: { type: "boolean" },
      dateOrder: { type: "string", enum: ["ymd", "mdy", "dmy", "unknown"] },
      software: { type: "string", enum: SOFTWARE },
      reason: { type: "string", maxLength: 200 },
    },
    required: ["isGeneralLedger", "headerRow", "columns", "accountInHeadingRows", "dateOrder"],
  },
} as const;

const SYSTEM =
  "You are given the first rows of a spreadsheet a business exported from its accounting software. Decide whether it is a general ledger (every bookkeeping entry, listed under or labelled with its account) and which column holds what. Only map columns you can see. Answer with the tool.";

/** The sheet the mapping is about: the first with real rows. */
function sheetRows(sample: GlRawRow[]): { sheet: string | null; rows: GlRawRow[] } {
  const groups: Array<{ sheet: string | null; rows: GlRawRow[] }> = [];
  for (const r of sample) {
    const last = groups[groups.length - 1];
    if (last && last.sheet === r.sheet) last.rows.push(r);
    else groups.push({ sheet: r.sheet, rows: [r] });
  }
  return groups.find((g) => g.rows.length >= 5) ?? groups[0] ?? { sheet: null, rows: [] };
}

/** "[r0] Date | Account | …" — the first ≤40 rows, cells cut to 40 characters, ≤8,000 characters. */
export function sampleText(rows: GlRawRow[]): { text: string; width: number } {
  const lines: string[] = [];
  let width = 0;
  let size = 0;
  for (let i = 0; i < Math.min(40, rows.length); i++) {
    const cells = rows[i].cells.map((c) => cellText(c, 40).replace(/\s+/g, " ").replace(/\|/g, "/"));
    width = Math.max(width, cells.length);
    const line = `[r${i}] ${cells.join(" | ")}`;
    if (size + line.length > 8000) break;
    lines.push(line);
    size += line.length + 1;
  }
  return { text: lines.join("\n"), width };
}

export interface MappingCheck { layout: GlLayout | null; problem: string | null }

/**
 * The model's answer → a layout the parser can read, or why not (pure). The
 * dry parse decides: dates and amounts on ≥80% of the data rows, ≥1 account.
 */
export function layoutFromAnswer(input: Record<string, unknown>, rows: GlRawRow[], sheet: string | null, width: number): MappingCheck {
  const headerRow = Number(input.headerRow);
  if (!Number.isInteger(headerRow) || headerRow < -1 || headerRow >= Math.min(rows.length, 40)) return { layout: null, problem: "heading row outside the sample" };
  const raw = Array.isArray(input.columns) ? input.columns : [];
  const seen = new Set<number>();
  const columns: GlLayout["columns"] = [];
  for (const c of raw) {
    const index = Number((c as { index?: unknown })?.index);
    const role = String((c as { role?: unknown })?.role) as GlRole;
    if (!Number.isInteger(index) || index < 0 || index >= width || !ROLES.includes(role) || seen.has(index)) return { layout: null, problem: "a column outside the sample" };
    seen.add(index);
    const header = headerRow >= 0 ? cellText(rows[headerRow]?.cells[index], 120) : "";
    columns.push({ index, role, header });
  }
  const count = (r: GlRole) => columns.filter((c) => c.role === r).length;
  if (count("date") !== 1) return { layout: null, problem: "not exactly one date column" };
  const singleAmount = count("amount") === 1;
  const debitCredit = count("debit") === 1 && count("credit") === 1;
  if (!singleAmount && !debitCredit) return { layout: null, problem: "no amount (or debit and credit) column" };
  const hasAccountCol = count("account") >= 1;
  if (!hasAccountCol && input.accountInHeadingRows !== true) return { layout: null, problem: "no account column or account headings" };
  const amountMode: GlLayout["amountMode"] = debitCredit ? "debit_credit" : "single";
  const orders: GlLayout["dateOrder"][] = input.dateOrder === "ymd" || input.dateOrder === "mdy" || input.dateOrder === "dmy" ? [input.dateOrder] : ["mdy", "dmy", "ymd"];
  const dry = rows.slice(0, Math.max(0, headerRow) + 1 + 200);
  let best: { layout: GlLayout; ratio: number; accounts: number } | null = null;
  for (const dateOrder of orders) {
    for (const mode of hasAccountCol ? (["column", "column_fill_down"] as const) : (["heading_rows"] as const)) {
      const layout: GlLayout = { headerRow, columns, accountMode: mode, dateOrder, amountMode, sheet };
      const { entries, stats } = parseLedgerRows(dry, layout);
      const looked = stats.dataLike + stats.skipped;
      const ratio = looked === 0 ? 0 : stats.dataLike / looked;
      const accounts = new Set(entries.map((e) => e.accountKey).filter((k) => k && k !== "no account")).size;
      if (entries.length > 0 && (!best || ratio > best.ratio || (ratio === best.ratio && accounts > best.accounts))) best = { layout, ratio, accounts };
    }
  }
  if (!best || best.ratio < 0.8) return { layout: null, problem: "the dry read didn't find dates and amounts on most rows" };
  if (best.accounts < 1) return { layout: null, problem: "no accounts found" };
  return { layout: best.layout, problem: null };
}

/**
 * The column mapper the ledger reader calls (ingest.ts): a layout, "not_ledger",
 * or null (no key, no budget, an outage, an answer that doesn't read) → the
 * ledger waits for its columns.
 */
export async function mapColumnsWithAi(ledger: Pick<GlLedger, "id" | "dealId" | "uploadedBy">, sample: GlRawRow[]): Promise<GlLayout | "not_ledger" | null> {
  const client = glAiClient();
  if (!client) return null;
  const { sheet, rows } = sheetRows(sample);
  if (rows.length < 2) return null;
  const { text, width } = sampleText(rows);
  if (!(await reserveGlAi(ledger.dealId, ledger.uploadedBy === "seller" ? "seller" : "broker", "mapping"))) {
    console.warn(`[gl] column mapping for ledger ${ledger.id}: today's assistant budget is used up`);
    return null;
  }
  try {
    const res = await withAiRetry(() => client.messages.create({
      model: agentConfig.models.supportingAgents,
      max_tokens: 1500,
      temperature: 0,
      system: SYSTEM,
      tools: [MAP_COLUMNS_TOOL],
      tool_choice: { type: "tool", name: MAP_COLUMNS_TOOL.name },
      messages: [{ role: "user", content: `First rows of the spreadsheet (one per line, cells separated by " | "):\n${text}` }],
    }), [5_000, 20_000]);
    const input = toolInput(res, MAP_COLUMNS_TOOL.name);
    if (!input) return null;
    if (input.isGeneralLedger === false) return "not_ledger";
    const checked = layoutFromAnswer(input, rows, sheet, width);
    if (!checked.layout) {
      console.warn(`[gl] column mapping for ledger ${ledger.id} refused: ${checked.problem}`);
      return null;
    }
    return checked.layout;
  } catch (err) {
    const f = describeAiFailure(err);
    console.warn(`[gl] column mapping for ledger ${ledger.id} failed (${f.reason}) — the ledger waits for its columns`);
    return null;
  }
}

setGlColumnMapper(mapColumnsWithAi);
