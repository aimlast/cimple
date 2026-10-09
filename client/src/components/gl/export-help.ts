/**
 * export-help.ts — how to export the general ledger from each program (gl
 * spec §3.9). Each names the report and its settings first; the menu path is
 * "usually" (menus change). Shown to the seller and the broker.
 */
import { fiscalYearRange } from "@shared/fiscal-year";

export type ExportSoftware = "quickbooks_online" | "quickbooks_desktop" | "xero" | "sage50" | "wave" | "freshbooks" | "other";

export interface ExportSteps {
  key: ExportSoftware;
  label: string;
  steps: string[];
}

/** The steps for a date range ("Jan 1, 2022", "Dec 31, 2024"). Bold is marked with **…**. */
export function exportSteps(start: string, end: string): ExportSteps[] {
  const range = `${start} – ${end}`;
  return [
    { key: "quickbooks_online", label: "QuickBooks Online", steps: [
      "Go to **Reports** and search for **General Ledger**.",
      `Set the dates to **${range}** and, in the report's settings, **Accounting method: Accrual**.`,
      "Click **Export** (the arrow icon) → **Export to Excel**.",
      "Upload the file here.",
    ] },
    { key: "quickbooks_desktop", label: "QuickBooks Desktop", steps: [
      "Go to **Reports → Accountant & Taxes → General Ledger**.",
      `Set From **${start}** To **${end}**; under **Customize Report**, set **Report Basis: Accrual**.`,
      "Click **Excel → Create New Worksheet** and save it.",
      "Upload the file here.",
    ] },
    { key: "xero", label: "Xero", steps: [
      "Go to **Accounting → Reports → General Ledger Detail** (or **Account Transactions**).",
      `Set the date range to **${range}** (accrual is the default).`,
      "Click **Export → Excel**.",
      "Upload the file here.",
    ] },
    { key: "sage50", label: "Sage 50", steps: [
      "Go to **Reports & Forms → Financials → General Ledger**.",
      `Set the dates to **${range}** and run it.`,
      "Choose **File → Export** → Excel or CSV.",
      "Upload the file here.",
    ] },
    { key: "wave", label: "Wave", steps: [
      "Go to **Reports → Account Transactions (General Ledger)**.",
      `Choose **${range}** and **Report type: Accrual (Paid & Unpaid)**.`,
      "Click **Export** → CSV.",
      "Upload the file here.",
    ] },
    { key: "freshbooks", label: "FreshBooks", steps: [
      "Go to **Reports → General Ledger**.",
      `Set the dates to **${range}**.`,
      "Click **Export → CSV**.",
      "Upload the file here.",
    ] },
    { key: "other", label: "Something else", steps: [
      `Look for a report called **General Ledger** or **Transaction Detail by Account**, on an accrual basis, for **${range}**.`,
      "Export it to Excel or CSV and upload the file here.",
    ] },
  ];
}

/** The two lines every panel ends with, and the last resort. */
export const EXPORT_FOOTER = [
  "Set the accounting method to **Accrual** if the report asks.",
  "Export after your accountant has posted the year-end entries. If they aren't in your software, ask your accountant for their **adjusting entries** and add that file too.",
];
export const EXPORT_LAST_RESORT = "Can't find it? Your accountant can send you the 'General Ledger' report as Excel or CSV.";

const STORAGE_KEY = "cimple.gl.software";

/** The software the person picked last time (per browser; never required). */
export function rememberedSoftware(): ExportSoftware | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return (v as ExportSoftware | null) ?? null;
  } catch {
    return null;
  }
}

export function rememberSoftware(v: ExportSoftware): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* private window — fine */
  }
}

/**
 * The dates to export, for the fiscal years the broker needs ("Jan 1, 2022" –
 * "Dec 31, 2024"); without them, the three fiscal years before this one.
 */
export function exportRange(fye: string | null, years: string[] = [], today = new Date()): { start: string; end: string } {
  const f = fye ?? "12-31";
  const [fm, fd] = f.split("-").map(Number);
  const currentKey = today.getUTCMonth() + 1 > fm || (today.getUTCMonth() + 1 === fm && today.getUTCDate() > fd) ? today.getUTCFullYear() + 1 : today.getUTCFullYear();
  const sorted = years.filter((y) => /^\d{4}$/.test(y)).sort();
  const first = fiscalYearRange(sorted[0] ?? String(currentKey - 3), f);
  const last = fiscalYearRange(sorted[sorted.length - 1] ?? String(currentKey - 1), f);
  const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return { start: first ? fmt(first.start) : "", end: last ? fmt(last.end) : "" };
}
