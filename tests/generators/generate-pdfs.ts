/**
 * generate-pdfs.ts
 *
 * Generates realistic PDF business documents for 5 fake businesses.
 * Run: npx tsx tests/generators/generate-pdfs.ts
 */

import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

const BASE = path.resolve(import.meta.dirname, "../test-data");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function fullPath(relPath: string): string {
  return path.join(BASE, relPath);
}

function writePdf(relPath: string, build: (doc: PDFKit.PDFDocument) => void) {
  const fp = fullPath(relPath);
  ensureDir(fp);
  const doc = new PDFDocument({ size: "LETTER", margins: { top: 72, bottom: 72, left: 72, right: 72 } });
  const stream = fs.createWriteStream(fp);
  doc.pipe(stream);
  build(doc);
  doc.end();
  return new Promise<void>((resolve, reject) => {
    stream.on("finish", () => {
      console.log(`  -> ${relPath}`);
      resolve();
    });
    stream.on("error", reject);
  });
}

/** Format number as currency with commas */
function $(n: number): string {
  if (n < 0) return `($${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format number with commas, no dollar sign */
function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** Add a horizontal rule */
function hr(doc: PDFKit.PDFDocument, y?: number) {
  const yPos = y ?? doc.y;
  doc.moveTo(72, yPos).lineTo(540, yPos).strokeColor("#999999").lineWidth(0.5).stroke();
  doc.y = yPos + 8;
}

/** Add a thick horizontal rule */
function hrThick(doc: PDFKit.PDFDocument, y?: number) {
  const yPos = y ?? doc.y;
  doc.moveTo(72, yPos).lineTo(540, yPos).strokeColor("#333333").lineWidth(1.5).stroke();
  doc.y = yPos + 8;
}

/** Draw a simple row with label and value columns for financial docs */
function finRow(doc: PDFKit.PDFDocument, label: string, value: string, opts?: { bold?: boolean; indent?: number }) {
  const x = 72 + (opts?.indent ?? 0);
  const font = opts?.bold ? "Helvetica-Bold" : "Helvetica";
  doc.font(font).fontSize(9);
  doc.text(label, x, doc.y, { width: 320 - (opts?.indent ?? 0), continued: false });
  const labelBottom = doc.y;
  doc.y = labelBottom - doc.currentLineHeight();
  doc.text(value, 400, doc.y, { width: 140, align: "right" });
  doc.y = labelBottom + 2;
}

/** Section header for legal documents */
function legalSection(doc: PDFKit.PDFDocument, num: number | string, title: string) {
  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").fontSize(10).text(`${num}. ${title}`, 72);
  doc.moveDown(0.3);
}

/** Body paragraph for legal documents */
function legalBody(doc: PDFKit.PDFDocument, text: string, indent: number = 0) {
  doc.font("Helvetica").fontSize(9).text(text, 72 + indent, doc.y, { width: 468 - indent, lineGap: 2, align: "justify" });
  doc.moveDown(0.3);
}

/** Add page numbers to a multi-page doc (footer) */
function addPageNumber(doc: PDFKit.PDFDocument, pageNum: number) {
  doc.font("Helvetica").fontSize(8).fillColor("#999999")
    .text(`Page ${pageNum}`, 72, 720, { width: 468, align: "center" });
  doc.fillColor("#000000");
}

// ─── Bank statement helpers ───────────────────────────────────────────────────

interface Transaction {
  date: string;
  description: string;
  debit?: number;
  credit?: number;
}

function bankStatementPage(
  doc: PDFKit.PDFDocument,
  bankName: string,
  accountHolder: string,
  transit: string,
  accountNum: string,
  period: string,
  openingBalance: number,
  transactions: Transaction[],
  closingBalance: number
) {
  // Header
  doc.font("Helvetica-Bold").fontSize(14).text(bankName, 72, 72);
  doc.font("Helvetica").fontSize(8).text("Business Banking Division", 72, doc.y);
  doc.moveDown(0.5);
  hrThick(doc);

  doc.font("Helvetica-Bold").fontSize(11).text("ACCOUNT STATEMENT", 72, doc.y);
  doc.moveDown(0.5);

  doc.font("Helvetica").fontSize(9);
  doc.text(`Account Holder: ${accountHolder}`, 72, doc.y);
  doc.text(`Transit: ${transit}    Account: ${accountNum}`, 72, doc.y);
  doc.text(`Statement Period: ${period}`, 72, doc.y);
  doc.moveDown(0.5);

  doc.font("Helvetica-Bold").fontSize(9);
  doc.text(`Opening Balance: ${$(openingBalance)}`, 72, doc.y);
  doc.moveDown(0.5);
  hr(doc);

  // Table header
  const colDate = 72;
  const colDesc = 145;
  const colDebit = 360;
  const colCredit = 430;
  const colBalance = 490;

  doc.font("Helvetica-Bold").fontSize(8);
  const headerY = doc.y;
  doc.text("Date", colDate, headerY);
  doc.text("Description", colDesc, headerY);
  doc.text("Debit", colDebit, headerY, { width: 60, align: "right" });
  doc.text("Credit", colCredit, headerY, { width: 60, align: "right" });
  doc.text("Balance", colBalance, headerY, { width: 60, align: "right" });
  doc.y = headerY + 12;
  hr(doc);

  // Transactions
  let runningBalance = openingBalance;
  doc.font("Helvetica").fontSize(8);
  for (const tx of transactions) {
    if (tx.credit) runningBalance += tx.credit;
    if (tx.debit) runningBalance -= tx.debit;

    const rowY = doc.y;
    if (rowY > 680) {
      doc.addPage();
      doc.y = 72;
    }
    const ry = doc.y;
    doc.text(tx.date, colDate, ry, { width: 65 });
    doc.text(tx.description, colDesc, ry, { width: 210 });
    if (tx.debit) doc.text($(tx.debit), colDebit, ry, { width: 60, align: "right" });
    if (tx.credit) doc.text($(tx.credit), colCredit, ry, { width: 60, align: "right" });
    doc.text($(runningBalance), colBalance, ry, { width: 60, align: "right" });
    doc.y = ry + 12;
  }

  doc.moveDown(0.5);
  hr(doc);
  doc.font("Helvetica-Bold").fontSize(9);
  doc.text(`Closing Balance: ${$(closingBalance)}`, 72, doc.y);
  doc.moveDown(1);

  doc.font("Helvetica").fontSize(7).fillColor("#999999");
  doc.text("This statement is provided for informational purposes only. Please report any discrepancies within 30 days.", 72, doc.y, { width: 468 });
  doc.fillColor("#000000");
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTRUCTION ONTARIO
// ═══════════════════════════════════════════════════════════════════════════════

// 1. T2 Corporate Tax Return 2023
function constructionT2_2023() {
  return writePdf("construction-ontario/tax/t2-corporate-2023.pdf", (doc) => {
    // Header
    doc.font("Helvetica-Bold").fontSize(12).text("T2 Corporation Income Tax Return", 72, 72, { align: "center", width: 468 });
    doc.font("Helvetica").fontSize(10).text("2023 Taxation Year", { align: "center", width: 468 });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(8).text("Canada Revenue Agency / Agence du revenu du Canada", { align: "center", width: 468 });
    doc.moveDown(1);
    hrThick(doc);

    // Corporation info
    doc.font("Helvetica-Bold").fontSize(10).text("CORPORATION INFORMATION");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Corporation Name:    Amlin Contracting Ltd.");
    doc.text("Business Number:     123456789RC0001");
    doc.text("Address:             45 Industrial Parkway, Unit 7");
    doc.text("                     Hamilton, Ontario  L8W 3N2");
    doc.text("Fiscal Year End:     December 31, 2023");
    doc.text("Tax Year:            January 1, 2023 to December 31, 2023");
    doc.text("Type of Corporation: Canadian-Controlled Private Corporation (CCPC)");
    doc.moveDown(1);
    hr(doc);

    // Income calculation
    doc.font("Helvetica-Bold").fontSize(10).text("SCHEDULE 1 — NET INCOME (LOSS) FOR INCOME TAX PURPOSES");
    doc.moveDown(0.5);

    finRow(doc, "Net income per financial statements", "185,000.00", { bold: true });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(9).text("Add:", 72);
    finRow(doc, "Non-deductible expenses", "8,200.00", { indent: 20 });
    finRow(doc, "Meals & entertainment (50% non-deductible)", "4,500.00", { indent: 20 });
    finRow(doc, "Total additions", "12,700.00", { indent: 20, bold: true });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(9).text("Deduct:", 72);
    finRow(doc, "Capital cost allowance (CCA) claimed", "(52,000.00)", { indent: 20 });
    finRow(doc, "Total deductions", "(52,000.00)", { indent: 20, bold: true });
    doc.moveDown(0.3);
    hr(doc);
    finRow(doc, "Taxable Income (Line 360)", "145,700.00", { bold: true });
    doc.moveDown(1);
    hr(doc);

    // Tax calculation
    doc.font("Helvetica-Bold").fontSize(10).text("SCHEDULE 5 — TAX CALCULATION");
    doc.moveDown(0.5);
    finRow(doc, "Taxable income", "145,700.00");
    finRow(doc, "Small business deduction rate (12.2% on first $500,000)", "12.2%");
    finRow(doc, "Federal tax — small business rate", "17,775.40", { bold: true });
    doc.moveDown(0.3);
    finRow(doc, "Ontario small business rate (3.2%)", "4,662.40");
    finRow(doc, "Total tax payable (federal + provincial)", "22,437.80", { bold: true });
    doc.moveDown(1);
    hr(doc);

    // Shareholder info
    doc.font("Helvetica-Bold").fontSize(10).text("SCHEDULE 50 — SHAREHOLDER INFORMATION");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Shareholder Name:      John Amlin");
    doc.text("SIN:                   XXX-XXX-XXX");
    doc.text("Ownership:             100% of issued shares");
    doc.text("Share Class:           Common");
    doc.moveDown(0.5);

    finRow(doc, "Management bonus paid", "60,000.00");
    finRow(doc, "Dividends declared", "0.00");
    finRow(doc, "Shareholder loan balance (year-end)", "40,000.00");
    doc.moveDown(1);

    // Footer
    doc.font("Helvetica").fontSize(7).fillColor("#999999");
    doc.text("This is a simplified representation of a T2 Corporation Income Tax Return for testing purposes.", 72, 680, { width: 468, align: "center" });
    doc.fillColor("#000000");
  });
}

// 2. T2 Corporate Tax Return 2024
function constructionT2_2024() {
  return writePdf("construction-ontario/tax/t2-corporate-2024.pdf", (doc) => {
    doc.font("Helvetica-Bold").fontSize(12).text("T2 Corporation Income Tax Return", 72, 72, { align: "center", width: 468 });
    doc.font("Helvetica").fontSize(10).text("2024 Taxation Year", { align: "center", width: 468 });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(8).text("Canada Revenue Agency / Agence du revenu du Canada", { align: "center", width: 468 });
    doc.moveDown(1);
    hrThick(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("CORPORATION INFORMATION");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Corporation Name:    Amlin Contracting Ltd.");
    doc.text("Business Number:     123456789RC0001");
    doc.text("Address:             45 Industrial Parkway, Unit 7");
    doc.text("                     Hamilton, Ontario  L8W 3N2");
    doc.text("Fiscal Year End:     December 31, 2024");
    doc.text("Tax Year:            January 1, 2024 to December 31, 2024");
    doc.text("Type of Corporation: Canadian-Controlled Private Corporation (CCPC)");
    doc.moveDown(1);
    hr(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("SCHEDULE 1 — NET INCOME (LOSS) FOR INCOME TAX PURPOSES");
    doc.moveDown(0.5);

    finRow(doc, "Net income per financial statements", "215,000.00", { bold: true });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(9).text("Add:", 72);
    finRow(doc, "Non-deductible expenses", "9,100.00", { indent: 20 });
    finRow(doc, "Meals & entertainment (50% non-deductible)", "5,200.00", { indent: 20 });
    finRow(doc, "Vehicle standby benefit (personal use)", "6,400.00", { indent: 20 });
    finRow(doc, "Total additions", "20,700.00", { indent: 20, bold: true });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(9).text("Deduct:", 72);
    finRow(doc, "Capital cost allowance (CCA) claimed", "(67,200.00)", { indent: 20 });
    finRow(doc, "Total deductions", "(67,200.00)", { indent: 20, bold: true });
    doc.moveDown(0.3);
    hr(doc);
    finRow(doc, "Taxable Income (Line 360)", "168,500.00", { bold: true });
    doc.moveDown(1);
    hr(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("SCHEDULE 5 — TAX CALCULATION");
    doc.moveDown(0.5);
    finRow(doc, "Taxable income", "168,500.00");
    finRow(doc, "Small business deduction rate (12.2% on first $500,000)", "12.2%");
    finRow(doc, "Federal tax — small business rate", "20,557.00", { bold: true });
    doc.moveDown(0.3);
    finRow(doc, "Ontario small business rate (3.2%)", "5,392.00");
    finRow(doc, "Total tax payable (federal + provincial)", "25,949.00", { bold: true });
    doc.moveDown(1);
    hr(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("SCHEDULE 50 — SHAREHOLDER INFORMATION");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Shareholder Name:      John Amlin");
    doc.text("SIN:                   XXX-XXX-XXX");
    doc.text("Ownership:             100% of issued shares");
    doc.text("Share Class:           Common");
    doc.moveDown(0.5);

    finRow(doc, "Management bonus paid", "60,000.00");
    finRow(doc, "Dividends declared", "40,000.00");
    finRow(doc, "Shareholder loan balance (year-end)", "30,000.00");
    finRow(doc, "Vehicle standby benefit included in income", "6,400.00");
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(7).fillColor("#999999");
    doc.text("This is a simplified representation of a T2 Corporation Income Tax Return for testing purposes.", 72, 680, { width: 468, align: "center" });
  });
}

// 3-5. Bank Statements
function constructionBankStatement(month: string, monthNum: string, year: string, opening: number, transactions: Transaction[], closing: number) {
  return writePdf(`construction-ontario/banking/bank-statement-${month.toLowerCase().slice(0, 3)}-${year}.pdf`, (doc) => {
    bankStatementPage(
      doc,
      "TD Canada Trust",
      "Amlin Contracting Ltd.",
      "12345",
      "6789012",
      `${month} 1 - ${month === "February" ? "28" : "31"}, ${year}`,
      opening,
      transactions,
      closing
    );
  });
}

function constructionBankJan2025() {
  const txns: Transaction[] = [
    { date: "Jan 02", description: "Opening Balance Carried Forward", credit: undefined, debit: undefined },
    { date: "Jan 03", description: "DEP - Hamilton Residential Build #4218", credit: 45000 },
    { date: "Jan 03", description: "EFT - Payroll Run #1", debit: 42500 },
    { date: "Jan 06", description: "DEP - Stoney Creek Renovation #4220", credit: 62000 },
    { date: "Jan 07", description: "CHQ #2891 - ABC Electrical (sub)", debit: 22000 },
    { date: "Jan 08", description: "CHQ #2892 - Hamilton Drywall (sub)", debit: 18000 },
    { date: "Jan 10", description: "POS - Torlone Building Supplies", debit: 35000 },
    { date: "Jan 13", description: "DEP - Progress Claim - Dundas Condo", credit: 38000 },
    { date: "Jan 14", description: "EFT - Commercial Insurance Premium", debit: 4583 },
    { date: "Jan 15", description: "PAD - 45 Industrial Pkwy Rent", debit: 4800 },
    { date: "Jan 17", description: "EFT - Payroll Run #2", debit: 42500 },
    { date: "Jan 20", description: "DEP - Burlington Kitchen Reno #4225", credit: 55000 },
    { date: "Jan 21", description: "POS - Castle Building Materials", debit: 28000 },
    { date: "Jan 22", description: "PAD - Bell Business Phone", debit: 750 },
    { date: "Jan 23", description: "POS - Petro-Canada Fleet Card", debit: 2800 },
    { date: "Jan 24", description: "POS - The Keg Steakhouse", debit: 1200 },
    { date: "Jan 25", description: "POS - Nordstrom", debit: 890 },
    { date: "Jan 27", description: "DEP - Ancaster Custom Home #4228", credit: 48000 },
    { date: "Jan 28", description: "POS - Fortinos Groceries", debit: 650 },
    { date: "Jan 30", description: "EFT - CRA HST Remittance Q4 2024", debit: 18500 },
  ];
  // Remove the placeholder first row (no debit/credit)
  txns.shift();
  return constructionBankStatement("January", "01", "2025", 142500, txns, 138200);
}

function constructionBankFeb2025() {
  const txns: Transaction[] = [
    { date: "Feb 03", description: "DEP - Hamilton Residential Build #4218 (progress)", credit: 52000 },
    { date: "Feb 04", description: "EFT - Payroll Run #1", debit: 43200 },
    { date: "Feb 06", description: "DEP - Waterdown Office Fit-Out #4230", credit: 41000 },
    { date: "Feb 07", description: "CHQ #2893 - Pro Plumbing Solutions (sub)", debit: 15800 },
    { date: "Feb 10", description: "POS - Torlone Building Supplies", debit: 22500 },
    { date: "Feb 11", description: "DEP - Stoney Creek Renovation #4220 (final)", credit: 28000 },
    { date: "Feb 12", description: "CHQ #2894 - J&K Concrete (sub)", debit: 19500 },
    { date: "Feb 14", description: "EFT - Commercial Insurance Premium", debit: 4583 },
    { date: "Feb 15", description: "PAD - 45 Industrial Pkwy Rent", debit: 4800 },
    { date: "Feb 18", description: "EFT - Payroll Run #2", debit: 43200 },
    { date: "Feb 19", description: "DEP - Dundas Condo Progress Claim #2", credit: 65000 },
    { date: "Feb 20", description: "POS - Home Hardware (materials)", debit: 8400 },
    { date: "Feb 21", description: "POS - Petro-Canada Fleet Card", debit: 2650 },
    { date: "Feb 22", description: "PAD - Bell Business Phone", debit: 750 },
    { date: "Feb 24", description: "POS - Swiss Chalet (team lunch)", debit: 380 },
    { date: "Feb 25", description: "DEP - Burlington Kitchen Reno #4225 (final)", credit: 32000 },
    { date: "Feb 26", description: "POS - Castle Building Materials", debit: 14200 },
    { date: "Feb 27", description: "EFT - WSIB Premium Q1 2025", debit: 12400 },
    { date: "Feb 28", description: "POS - Amazon.ca (office supplies)", debit: 480 },
  ];
  return constructionBankStatement("February", "02", "2025", 138200, txns, 145800);
}

function constructionBankMar2025() {
  const txns: Transaction[] = [
    { date: "Mar 03", description: "DEP - Ancaster Custom Home #4228 (progress)", credit: 72000 },
    { date: "Mar 04", description: "EFT - Payroll Run #1", debit: 44100 },
    { date: "Mar 05", description: "CHQ #2895 - Mountainview HVAC (sub)", debit: 24500 },
    { date: "Mar 07", description: "DEP - Waterdown Office Fit-Out #4230 (progress)", credit: 35000 },
    { date: "Mar 10", description: "POS - Torlone Building Supplies", debit: 31000 },
    { date: "Mar 11", description: "CHQ #2896 - ABC Electrical (sub)", debit: 16200 },
    { date: "Mar 12", description: "DEP - New contract - Grimsby Home #4235", credit: 40000 },
    { date: "Mar 14", description: "EFT - Commercial Insurance Premium", debit: 4583 },
    { date: "Mar 15", description: "PAD - 45 Industrial Pkwy Rent", debit: 4800 },
    { date: "Mar 17", description: "EFT - Payroll Run #2", debit: 44100 },
    { date: "Mar 18", description: "DEP - Dundas Condo Progress Claim #3", credit: 58000 },
    { date: "Mar 20", description: "POS - Castle Building Materials", debit: 19800 },
    { date: "Mar 21", description: "POS - Petro-Canada Fleet Card", debit: 3100 },
    { date: "Mar 22", description: "PAD - Bell Business Phone", debit: 750 },
    { date: "Mar 24", description: "POS - Best Buy (owner personal)", debit: 1350 },
    { date: "Mar 25", description: "POS - Costco", debit: 720 },
    { date: "Mar 27", description: "DEP - Hamilton Residential Build #4218 (final)", credit: 48000 },
    { date: "Mar 28", description: "CHQ #2897 - Hamilton Drywall (sub)", debit: 11200 },
    { date: "Mar 31", description: "EFT - Owner distribution", debit: 15000 },
  ];
  return constructionBankStatement("March", "03", "2025", 145800, txns, 151300);
}

// 6. Commercial Lease Agreement
function constructionLease() {
  return writePdf("construction-ontario/legal/commercial-lease-agreement.pdf", (doc) => {
    let page = 1;

    doc.font("Helvetica-Bold").fontSize(16).text("COMMERCIAL LEASE AGREEMENT", 72, 72, { align: "center", width: 468 });
    doc.moveDown(2);
    hrThick(doc);
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(9).text("THIS LEASE AGREEMENT (the \"Lease\") is made and entered into as of the 1st day of January, 2022.", 72, doc.y, { width: 468, align: "justify" });
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(9).text("BETWEEN:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("1247890 Ontario Inc. (hereinafter referred to as the \"Landlord\")", 90, doc.y, { width: 450 });
    doc.text("Address: 200 King Street East, Suite 400, Hamilton, Ontario L8N 1B5", 90, doc.y, { width: 450 });
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(9).text("AND:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Amlin Contracting Ltd. (hereinafter referred to as the \"Tenant\")", 90, doc.y, { width: 450 });
    doc.text("Address: 45 Industrial Parkway, Unit 7, Hamilton, Ontario L8W 3N2", 90, doc.y, { width: 450 });
    doc.moveDown(1);
    hr(doc);

    legalSection(doc, 1, "PREMISES");
    legalBody(doc, "The Landlord hereby leases to the Tenant, and the Tenant hereby leases from the Landlord, the premises known as Unit 7 at 45 Industrial Parkway, Hamilton, Ontario L8W 3N2, comprising approximately 5,200 square feet of warehouse and office space (the \"Premises\"), as outlined on the floor plan attached hereto as Schedule \"A\".", 20);

    legalSection(doc, 2, "TERM");
    legalBody(doc, "The term of this Lease shall be five (5) years, commencing on January 1, 2022 and expiring on December 31, 2026 (the \"Initial Term\"), unless sooner terminated in accordance with the provisions of this Lease.", 20);

    legalSection(doc, 3, "RENEWAL OPTIONS");
    legalBody(doc, "The Tenant shall have the option to renew this Lease for two (2) additional terms of five (5) years each (each a \"Renewal Term\"), upon the same terms and conditions as set forth herein, except that the Base Rent shall be adjusted in accordance with the Consumer Price Index (CPI) for Hamilton, Ontario. The Tenant must provide the Landlord with no less than six (6) months written notice prior to the expiration of the then-current term of its intention to renew.", 20);

    legalSection(doc, 4, "BASE RENT");
    legalBody(doc, "The Tenant shall pay to the Landlord base rent in the amount of Four Thousand Eight Hundred Dollars ($4,800.00) per month, plus applicable HST, payable on the first day of each calendar month during the term of this Lease. This Lease is structured as a triple net (NNN) lease.", 20);

    legalSection(doc, 5, "ADDITIONAL RENT");
    legalBody(doc, "In addition to the Base Rent, the Tenant shall pay as Additional Rent its proportionate share of the following operating costs, estimated at One Thousand Two Hundred Dollars ($1,200.00) per month:", 20);
    legalBody(doc, "(a) Property taxes and local improvement charges;\n(b) Building insurance premiums;\n(c) Common area maintenance and repairs;\n(d) Snow removal and landscaping.\n\nAdditional Rent shall be reconciled annually based on actual costs incurred.", 40);

    legalSection(doc, 6, "PERSONAL GUARANTEE");
    legalBody(doc, "John Amlin, the principal shareholder of the Tenant, hereby personally and unconditionally guarantees the full and faithful performance of all of the Tenant's obligations under this Lease, including but not limited to the payment of Base Rent, Additional Rent, and all other amounts owing hereunder. This guarantee shall remain in full force and effect for the entire term of this Lease and any renewal thereof.", 20);

    addPageNumber(doc, page);
    doc.addPage();
    page++;

    legalSection(doc, 7, "PERMITTED USE");
    legalBody(doc, "The Premises shall be used and occupied by the Tenant solely for the purpose of general contracting operations, including but not limited to office administration, storage of construction equipment, building materials, and related supplies. The Tenant shall not use the Premises for any purpose that is unlawful, hazardous, or that would invalidate any insurance policy carried by the Landlord.", 20);

    legalSection(doc, 8, "INSURANCE");
    legalBody(doc, "The Tenant shall, at its own expense, obtain and maintain throughout the term of this Lease:\n(a) Commercial general liability insurance with a minimum coverage of Two Million Dollars ($2,000,000.00) per occurrence;\n(b) Property insurance covering the Tenant's contents, equipment, and improvements in the amount of no less than One Million Dollars ($1,000,000.00);\n(c) The Landlord shall be named as an additional insured on all such policies.", 20);

    legalSection(doc, 9, "MAINTENANCE AND REPAIRS");
    legalBody(doc, "The Tenant shall be responsible for all maintenance and repairs to the interior of the Premises, including plumbing, electrical, and mechanical systems exclusively serving the Premises. The Landlord shall be responsible for structural repairs to the roof, exterior walls, and foundation, as well as maintenance of common areas.", 20);

    legalSection(doc, 10, "LEASEHOLD IMPROVEMENTS");
    legalBody(doc, "Any leasehold improvements made by the Tenant shall require the prior written consent of the Landlord, which consent shall not be unreasonably withheld. All leasehold improvements shall become the property of the Landlord at the expiration or earlier termination of this Lease, unless the Landlord requires the Tenant to remove the same, in which case the Tenant shall restore the Premises to their original condition at its own expense, reasonable wear and tear excepted.", 20);

    legalSection(doc, 11, "ASSIGNMENT AND SUBLETTING");
    legalBody(doc, "The Tenant shall not assign this Lease or sublet the Premises or any part thereof without the prior written consent of the Landlord, which consent shall not be unreasonably withheld, delayed, or conditioned. Any assignment or subletting shall not release the Tenant from its obligations hereunder.", 20);

    legalSection(doc, 12, "DEFAULT AND TERMINATION");
    legalBody(doc, "If the Tenant defaults in the payment of any rent or Additional Rent, or in the observance or performance of any of the terms, covenants, or conditions of this Lease, and such default continues for a period of sixty (60) days after written notice thereof from the Landlord, the Landlord may, at its option, terminate this Lease. There shall be no right of early termination without cause.", 20);

    legalSection(doc, 13, "INDEMNIFICATION");
    legalBody(doc, "The Tenant shall indemnify and hold harmless the Landlord from and against any and all claims, actions, damages, liabilities, and expenses, including reasonable legal fees, arising out of or in connection with the Tenant's use and occupation of the Premises, or any breach by the Tenant of any term of this Lease.", 20);

    legalSection(doc, 14, "ENVIRONMENTAL");
    legalBody(doc, "The Tenant shall not bring onto or store within the Premises any hazardous materials or substances in contravention of applicable environmental legislation. The Tenant shall comply with all federal, provincial, and municipal environmental laws and regulations. Upon the expiration or termination of this Lease, the Tenant shall deliver the Premises free of environmental contamination caused by the Tenant.", 20);

    legalSection(doc, 15, "NOTICES");
    legalBody(doc, "All notices required or permitted to be given under this Lease shall be in writing and shall be deemed to have been duly given if delivered personally, sent by prepaid registered mail, or sent by email to the addresses of the parties as set forth herein, or to such other addresses as may be designated by written notice.", 20);

    addPageNumber(doc, page);
    doc.addPage();
    page++;

    legalSection(doc, 16, "GOVERNING LAW");
    legalBody(doc, "This Lease shall be governed by and construed in accordance with the laws of the Province of Ontario and the federal laws of Canada applicable therein.", 20);

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).text("IN WITNESS WHEREOF, the parties have executed this Lease as of the date first above written.", 72, doc.y, { width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    doc.text("LANDLORD: 1247890 Ontario Inc.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Authorized Signing Officer", 90);
    doc.moveDown(1.5);

    doc.text("TENANT: Amlin Contracting Ltd.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      John Amlin, President", 90);
    doc.moveDown(1.5);

    doc.text("PERSONAL GUARANTOR:", 72);
    doc.moveDown(1.5);
    doc.text("________________________________", 72);
    doc.text("John Amlin", 90);
    doc.moveDown(0.5);
    doc.text("Date: January 1, 2022", 90);

    addPageNumber(doc, page);
  });
}

// 7. WSIB Clearance Certificate
function constructionWSIB() {
  return writePdf("construction-ontario/compliance/wsib-clearance-certificate.pdf", (doc) => {
    // Logo area
    doc.font("Helvetica-Bold").fontSize(14).text("Workplace Safety and Insurance Board", 72, 72, { width: 468, align: "center" });
    doc.font("Helvetica").fontSize(10).text("Commission de la securite professionnelle et de l'assurance contre les accidents du travail", { width: 468, align: "center" });
    doc.moveDown(1.5);
    hrThick(doc);
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(16).text("CLEARANCE CERTIFICATE", { align: "center", width: 468 });
    doc.moveDown(1.5);

    // Box outline
    const boxTop = doc.y;
    doc.rect(72, boxTop, 468, 250).strokeColor("#333333").lineWidth(1).stroke();

    doc.font("Helvetica").fontSize(10);
    const leftCol = 90;
    const rightCol = 300;
    let y = boxTop + 20;

    doc.font("Helvetica-Bold").text("Employer Name:", leftCol, y);
    doc.font("Helvetica").text("Amlin Contracting Ltd.", rightCol, y);
    y += 22;

    doc.font("Helvetica-Bold").text("WSIB Account Number:", leftCol, y);
    doc.font("Helvetica").text("1234567-001", rightCol, y);
    y += 22;

    doc.font("Helvetica-Bold").text("Firm Number:", leftCol, y);
    doc.font("Helvetica").text("1234567", rightCol, y);
    y += 22;

    doc.font("Helvetica-Bold").text("Classification:", leftCol, y);
    doc.font("Helvetica").text("764 — General Building Construction", rightCol, y);
    y += 22;

    doc.font("Helvetica-Bold").text("Account Status:", leftCol, y);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#006600").text("GOOD STANDING", rightCol, y);
    doc.fillColor("#000000").fontSize(10);
    y += 26;

    doc.font("Helvetica-Bold").text("Workers Covered:", leftCol, y);
    doc.font("Helvetica").text("32", rightCol, y);
    y += 22;

    doc.font("Helvetica-Bold").text("Premium Rate:", leftCol, y);
    doc.font("Helvetica").text("$3.42 per $100 of insurable earnings", rightCol, y);
    y += 22;

    doc.font("Helvetica-Bold").text("Valid From:", leftCol, y);
    doc.font("Helvetica").text("January 1, 2025", rightCol, y);
    y += 22;

    doc.font("Helvetica-Bold").text("Valid To:", leftCol, y);
    doc.font("Helvetica").text("March 31, 2025", rightCol, y);

    doc.y = boxTop + 270;
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(10).text(
      "This certificate confirms that the above-named employer is registered with the Workplace Safety and Insurance Board, is in good standing, and has paid all required premiums as of the date of issue. This certificate is valid for the period indicated above.",
      72, doc.y, { width: 468, align: "justify", lineGap: 3 }
    );

    doc.moveDown(1.5);
    doc.font("Helvetica-Bold").fontSize(10).text("IMPORTANT:", 72);
    doc.font("Helvetica").fontSize(9).text(
      "This clearance certificate does not constitute a waiver of any of the employer's obligations under the Workplace Safety and Insurance Act, 1997. To verify the current status of this certificate, visit www.wsib.ca or call 1-800-387-0750.",
      72, doc.y, { width: 468, lineGap: 2 }
    );

    doc.moveDown(2);
    doc.font("Helvetica").fontSize(9);
    doc.text("Issued: January 15, 2025", 72);
    doc.text("Certificate Reference: CLR-2025-0045821", 72);
    doc.moveDown(1);
    doc.text("________________________________", 72);
    doc.text("Authorized Representative, WSIB", 72);
  });
}

// 8. Subcontractor Agreement
function constructionSubcontractorAgreement() {
  return writePdf("construction-ontario/legal/subcontractor-agreement.pdf", (doc) => {
    let page = 1;

    doc.font("Helvetica-Bold").fontSize(16).text("SUBCONTRACTOR AGREEMENT", 72, 72, { align: "center", width: 468 });
    doc.moveDown(2);
    hrThick(doc);
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(9).text("THIS SUBCONTRACTOR AGREEMENT (the \"Agreement\") is made and entered into as of this _____ day of _____________, 20___.", 72, doc.y, { width: 468 });
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(9).text("BETWEEN:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Amlin Contracting Ltd. (hereinafter referred to as the \"General Contractor\")", 90, doc.y, { width: 450 });
    doc.text("45 Industrial Parkway, Unit 7, Hamilton, Ontario L8W 3N2", 90);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(9).text("AND:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("ABC Electrical Inc. (hereinafter referred to as the \"Subcontractor\")", 90, doc.y, { width: 450 });
    doc.text("88 Sparks Avenue, Stoney Creek, Ontario L8E 2T9", 90);
    doc.moveDown(1);
    hr(doc);

    legalSection(doc, 1, "SCOPE OF WORK");
    legalBody(doc, "The Subcontractor shall perform the work described in individual Work Orders issued by the General Contractor from time to time (each a \"Project\"). Each Work Order shall describe the scope of work, schedule, and compensation applicable to the Project. The project reference for ongoing work shall be designated as \"As Assigned\" unless a specific project number is provided.", 20);

    legalSection(doc, 2, "INSURANCE REQUIREMENTS");
    legalBody(doc, "The Subcontractor shall, at its own expense, obtain and maintain throughout the term of this Agreement and any Work Order issued hereunder:", 20);
    legalBody(doc, "(a) Commercial general liability insurance with a minimum coverage of Two Million Dollars ($2,000,000.00) per occurrence;\n(b) Automobile liability insurance with a minimum coverage of Two Million Dollars ($2,000,000.00);\n(c) Workers' compensation coverage in accordance with applicable provincial legislation;\n(d) Professional liability insurance, if applicable to the scope of work.\n\nThe General Contractor shall be named as an additional insured on all such policies. Certificates of insurance shall be provided prior to commencement of work.", 40);

    legalSection(doc, 3, "WSIB CLEARANCE");
    legalBody(doc, "The Subcontractor shall maintain a valid Workplace Safety and Insurance Board (WSIB) clearance certificate throughout the duration of this Agreement and any work performed hereunder. A current clearance certificate must be provided to the General Contractor prior to commencement of each Project and upon each renewal.", 20);

    legalSection(doc, 4, "STATUTORY HOLDBACK");
    legalBody(doc, "In accordance with the Ontario Construction Act, R.S.O. 1990, c. C.30, as amended, the General Contractor shall retain a statutory holdback of ten percent (10%) of the value of work completed on each progress payment. Holdback funds shall be released in accordance with the timelines and procedures set forth in the Construction Act, subject to no liens or claims being registered against the project.", 20);

    legalSection(doc, 5, "PAYMENT TERMS");
    legalBody(doc, "Payment for completed work shall be made net thirty (30) days from the date of certification of the work by the General Contractor or its authorized representative. Progress claims shall be submitted monthly or as otherwise agreed in the applicable Work Order. All invoices must include the Work Order number, a description of work completed, and supporting documentation.", 20);

    addPageNumber(doc, page);
    doc.addPage();
    page++;

    legalSection(doc, 6, "INDEMNIFICATION");
    legalBody(doc, "The Subcontractor shall indemnify and hold harmless the General Contractor, its officers, directors, employees, and agents from and against any and all claims, damages, losses, costs, and expenses (including reasonable legal fees) arising out of or resulting from the Subcontractor's performance of the work, including but not limited to personal injury, property damage, or any breach of this Agreement.", 20);

    legalSection(doc, 7, "SAFETY COMPLIANCE");
    legalBody(doc, "The Subcontractor shall comply with all applicable federal, provincial, and municipal health and safety legislation, including the Ontario Occupational Health and Safety Act, R.S.O. 1990, c. O.1, and all regulations thereunder. The Subcontractor shall ensure that all of its employees and agents are properly trained, equipped, and supervised in accordance with applicable safety standards. The Subcontractor shall participate in all site safety meetings and orientations as required by the General Contractor.", 20);

    legalSection(doc, 8, "WARRANTY");
    legalBody(doc, "The Subcontractor warrants that all work performed under this Agreement shall be free from defects in workmanship and materials for a period of two (2) years from the date of substantial completion of each Project. The Subcontractor shall, at its own expense, promptly correct any defective work upon receipt of written notice from the General Contractor during the warranty period.", 20);

    legalSection(doc, 9, "INDEPENDENT CONTRACTOR");
    legalBody(doc, "The Subcontractor is an independent contractor and is not an employee, partner, or agent of the General Contractor. The Subcontractor shall be solely responsible for the payment of all taxes, contributions, and deductions applicable to its business and employees, including income tax, HST/GST, CPP, and EI.", 20);

    legalSection(doc, 10, "TERMINATION");
    legalBody(doc, "Either party may terminate this Agreement or any Work Order issued hereunder upon thirty (30) days written notice to the other party. The General Contractor may terminate this Agreement immediately upon written notice if the Subcontractor fails to maintain required insurance or WSIB coverage, breaches any material term of this Agreement, or becomes insolvent or bankrupt.", 20);

    legalSection(doc, 11, "CONFIDENTIALITY");
    legalBody(doc, "The Subcontractor shall treat all information regarding the General Contractor's clients, projects, pricing, and business operations as confidential. The Subcontractor shall not disclose such information to any third party without the prior written consent of the General Contractor.", 20);

    legalSection(doc, 12, "GOVERNING LAW AND DISPUTE RESOLUTION");
    legalBody(doc, "This Agreement shall be governed by and construed in accordance with the laws of the Province of Ontario and the federal laws of Canada applicable therein. Any dispute arising out of or in connection with this Agreement shall first be submitted to mediation. If mediation is unsuccessful, the dispute shall be resolved by arbitration in Hamilton, Ontario in accordance with the Arbitration Act, 1991 (Ontario).", 20);

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).text("IN WITNESS WHEREOF, the parties have executed this Agreement as of the date first above written.", 72, doc.y, { width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    doc.text("GENERAL CONTRACTOR: Amlin Contracting Ltd.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      John Amlin, President", 90);
    doc.moveDown(1.5);

    doc.text("SUBCONTRACTOR: ABC Electrical Inc.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Authorized Signing Officer", 90);

    addPageNumber(doc, page);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESTAURANT TORONTO
// ═══════════════════════════════════════════════════════════════════════════════

// 9. Restaurant T2 2023
function restaurantT2_2023() {
  return writePdf("restaurant-toronto/tax/t2-corporate-2023.pdf", (doc) => {
    doc.font("Helvetica-Bold").fontSize(12).text("T2 Corporation Income Tax Return", 72, 72, { align: "center", width: 468 });
    doc.font("Helvetica").fontSize(10).text("2023 Taxation Year", { align: "center", width: 468 });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(8).text("Canada Revenue Agency / Agence du revenu du Canada", { align: "center", width: 468 });
    doc.moveDown(1);
    hrThick(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("CORPORATION INFORMATION");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Corporation Name:    2587341 Ontario Inc.");
    doc.text("Operating As:        Terrazza Kitchen & Bar");
    doc.text("Business Number:     987654321RC0001");
    doc.text("Address:             142 Queen Street West");
    doc.text("                     Toronto, Ontario  M5H 2N8");
    doc.text("Fiscal Year End:     December 31, 2023");
    doc.text("Tax Year:            January 1, 2023 to December 31, 2023");
    doc.text("Type of Corporation: Canadian-Controlled Private Corporation (CCPC)");
    doc.moveDown(1);
    hr(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("SCHEDULE 1 — NET INCOME (LOSS) FOR INCOME TAX PURPOSES");
    doc.moveDown(0.5);

    finRow(doc, "Net income per financial statements", "122,000.00", { bold: true });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(9).text("Add:", 72);
    finRow(doc, "Non-deductible expenses", "3,800.00", { indent: 20 });
    finRow(doc, "Meals & entertainment (50% non-deductible)", "15,000.00", { indent: 20 });
    finRow(doc, "Total additions", "18,800.00", { indent: 20, bold: true });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(9).text("Deduct:", 72);
    finRow(doc, "Capital cost allowance (CCA) claimed", "(28,000.00)", { indent: 20 });
    finRow(doc, "Total deductions", "(28,000.00)", { indent: 20, bold: true });
    doc.moveDown(0.3);
    hr(doc);
    finRow(doc, "Taxable Income (Line 360)", "112,800.00", { bold: true });
    doc.moveDown(1);
    hr(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("SCHEDULE 5 — TAX CALCULATION");
    doc.moveDown(0.5);
    finRow(doc, "Taxable income", "112,800.00");
    finRow(doc, "Small business deduction rate (12.2% on first $500,000)", "12.2%");
    finRow(doc, "Federal tax — small business rate", "13,761.60", { bold: true });
    finRow(doc, "Ontario small business rate (3.2%)", "3,609.60");
    finRow(doc, "Total tax payable (federal + provincial)", "17,371.20", { bold: true });
    doc.moveDown(1);
    hr(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("RELATED PARTY TRANSACTIONS");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    finRow(doc, "Management fees paid to holding company", "24,000.00");
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(10).text("HST INFORMATION");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("HST Registration Number: 987654321RT0001");
    doc.text("Filing Frequency: Quarterly");
    doc.text("HST collected on sales and remitted in accordance with Excise Tax Act.");
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(7).fillColor("#999999");
    doc.text("This is a simplified representation of a T2 Corporation Income Tax Return for testing purposes.", 72, 680, { width: 468, align: "center" });
  });
}

// 10. Restaurant T2 2024
function restaurantT2_2024() {
  return writePdf("restaurant-toronto/tax/t2-corporate-2024.pdf", (doc) => {
    doc.font("Helvetica-Bold").fontSize(12).text("T2 Corporation Income Tax Return", 72, 72, { align: "center", width: 468 });
    doc.font("Helvetica").fontSize(10).text("2024 Taxation Year", { align: "center", width: 468 });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(8).text("Canada Revenue Agency / Agence du revenu du Canada", { align: "center", width: 468 });
    doc.moveDown(1);
    hrThick(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("CORPORATION INFORMATION");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Corporation Name:    2587341 Ontario Inc.");
    doc.text("Operating As:        Terrazza Kitchen & Bar");
    doc.text("Business Number:     987654321RC0001");
    doc.text("Address:             142 Queen Street West");
    doc.text("                     Toronto, Ontario  M5H 2N8");
    doc.text("Fiscal Year End:     December 31, 2024");
    doc.text("Tax Year:            January 1, 2024 to December 31, 2024");
    doc.text("Type of Corporation: Canadian-Controlled Private Corporation (CCPC)");
    doc.moveDown(1);
    hr(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("SCHEDULE 1 — NET INCOME (LOSS) FOR INCOME TAX PURPOSES");
    doc.moveDown(0.5);

    finRow(doc, "Net income per financial statements", "166,000.00", { bold: true });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(9).text("Add:", 72);
    finRow(doc, "Non-deductible expenses", "4,200.00", { indent: 20 });
    finRow(doc, "Meals & entertainment (50% non-deductible)", "16,500.00", { indent: 20 });
    finRow(doc, "Total additions", "20,700.00", { indent: 20, bold: true });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(9).text("Deduct:", 72);
    finRow(doc, "Capital cost allowance (CCA) claimed", "(32,000.00)", { indent: 20 });
    finRow(doc, "Total deductions", "(32,000.00)", { indent: 20, bold: true });
    doc.moveDown(0.3);
    hr(doc);
    finRow(doc, "Taxable Income (Line 360)", "154,700.00", { bold: true });
    doc.moveDown(1);
    hr(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("SCHEDULE 5 — TAX CALCULATION");
    doc.moveDown(0.5);
    finRow(doc, "Taxable income", "154,700.00");
    finRow(doc, "Small business deduction rate (12.2% on first $500,000)", "12.2%");
    finRow(doc, "Federal tax — small business rate", "18,873.40", { bold: true });
    finRow(doc, "Ontario small business rate (3.2%)", "4,950.40");
    finRow(doc, "Total tax payable (federal + provincial)", "23,823.80", { bold: true });
    doc.moveDown(1);
    hr(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("RELATED PARTY TRANSACTIONS");
    doc.moveDown(0.5);
    finRow(doc, "Management fees paid to holding company", "24,000.00");
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(10).text("HST INFORMATION");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("HST Registration Number: 987654321RT0001");
    doc.text("Filing Frequency: Quarterly");

    doc.moveDown(1);
    doc.font("Helvetica").fontSize(7).fillColor("#999999");
    doc.text("This is a simplified representation of a T2 Corporation Income Tax Return for testing purposes.", 72, 680, { width: 468, align: "center" });
  });
}

// 11-13. Restaurant Bank Statements
function restaurantBankStatement(month: string, lastDay: string, year: string, opening: number, transactions: Transaction[], closing: number) {
  return writePdf(`restaurant-toronto/banking/bank-statement-${month.toLowerCase().slice(0, 3)}-${year}.pdf`, (doc) => {
    bankStatementPage(
      doc,
      "RBC Royal Bank",
      "2587341 Ontario Inc. o/a Terrazza Kitchen & Bar",
      "04521",
      "1098765",
      `${month} 1 - ${lastDay}, ${year}`,
      opening,
      transactions,
      closing
    );
  });
}

function restaurantBankJan2025() {
  const txns: Transaction[] = [
    { date: "Jan 02", description: "DEP - Daily Sales (POS)", credit: 5200 },
    { date: "Jan 03", description: "DEP - Daily Sales (POS)", credit: 6800 },
    { date: "Jan 04", description: "DEP - Daily Sales (POS) - Sat", credit: 11200 },
    { date: "Jan 05", description: "DEP - Daily Sales (POS) - Sun", credit: 9800 },
    { date: "Jan 06", description: "DEP - Cash Deposit", credit: 3500 },
    { date: "Jan 07", description: "EFT - Sysco Canada (food order)", debit: 18200 },
    { date: "Jan 08", description: "DEP - Daily Sales (POS)", credit: 5600 },
    { date: "Jan 09", description: "DEP - Daily Sales (POS)", credit: 6100 },
    { date: "Jan 10", description: "EFT - Biweekly Payroll", debit: 28000 },
    { date: "Jan 11", description: "DEP - Daily Sales (POS) - Sat", credit: 12000 },
    { date: "Jan 13", description: "DEP - Daily Sales (POS)", credit: 5400 },
    { date: "Jan 14", description: "PAD - 142 Queen St Rent", debit: 7200 },
    { date: "Jan 15", description: "DEP - Cash Deposit", credit: 4200 },
    { date: "Jan 16", description: "PAD - Enbridge Gas", debit: 1800 },
    { date: "Jan 17", description: "PAD - Toronto Hydro", debit: 1200 },
    { date: "Jan 18", description: "DEP - Daily Sales (POS) - Sat", credit: 10500 },
    { date: "Jan 20", description: "DEP - Daily Sales (POS)", credit: 5900 },
    { date: "Jan 21", description: "EFT - GFS (Gordon Food Service)", debit: 17800 },
    { date: "Jan 22", description: "DEP - Cash Deposit", credit: 2800 },
    { date: "Jan 24", description: "EFT - Biweekly Payroll", debit: 28000 },
    { date: "Jan 25", description: "DEP - Daily Sales (POS) - Sat", credit: 11400 },
    { date: "Jan 27", description: "DEP - Daily Sales (POS)", credit: 5100 },
    { date: "Jan 28", description: "POS - LCBO (liquor inventory)", debit: 8500 },
    { date: "Jan 30", description: "DEP - Cash Deposit", credit: 4800 },
    { date: "Jan 31", description: "PAD - Moneris POS fees", debit: 1850 },
  ];
  return restaurantBankStatement("January", "January 31", "2025", 45200, txns, 47850);
}

function restaurantBankFeb2025() {
  const txns: Transaction[] = [
    { date: "Feb 01", description: "DEP - Daily Sales (POS) - Sat", credit: 11800 },
    { date: "Feb 03", description: "DEP - Daily Sales (POS)", credit: 5500 },
    { date: "Feb 04", description: "EFT - Sysco Canada (food order)", debit: 16900 },
    { date: "Feb 05", description: "DEP - Daily Sales (POS)", credit: 6300 },
    { date: "Feb 06", description: "DEP - Cash Deposit", credit: 3200 },
    { date: "Feb 07", description: "EFT - Biweekly Payroll", debit: 28500 },
    { date: "Feb 08", description: "DEP - Daily Sales (POS) - Sat", credit: 12500 },
    { date: "Feb 10", description: "DEP - Daily Sales (POS)", credit: 5800 },
    { date: "Feb 11", description: "DEP - Daily Sales (POS)", credit: 6900 },
    { date: "Feb 14", description: "DEP - Daily Sales (POS) - Valentine's Day", credit: 14200 },
    { date: "Feb 15", description: "PAD - 142 Queen St Rent", debit: 7200 },
    { date: "Feb 17", description: "DEP - Cash Deposit", credit: 5000 },
    { date: "Feb 18", description: "EFT - GFS (Gordon Food Service)", debit: 15400 },
    { date: "Feb 19", description: "PAD - Enbridge Gas", debit: 2100 },
    { date: "Feb 20", description: "PAD - Toronto Hydro", debit: 1300 },
    { date: "Feb 21", description: "EFT - Biweekly Payroll", debit: 28500 },
    { date: "Feb 22", description: "DEP - Daily Sales (POS) - Sat", credit: 11000 },
    { date: "Feb 24", description: "DEP - Daily Sales (POS)", credit: 5200 },
    { date: "Feb 25", description: "POS - LCBO (liquor inventory)", debit: 9200 },
    { date: "Feb 26", description: "DEP - Cash Deposit", credit: 4500 },
    { date: "Feb 28", description: "PAD - Moneris POS fees", debit: 1920 },
  ];
  return restaurantBankStatement("February", "February 28", "2025", 47850, txns, 51830);
}

function restaurantBankMar2025() {
  const txns: Transaction[] = [
    { date: "Mar 01", description: "DEP - Daily Sales (POS) - Sat", credit: 10800 },
    { date: "Mar 03", description: "DEP - Daily Sales (POS)", credit: 6200 },
    { date: "Mar 04", description: "EFT - Sysco Canada (food order)", debit: 18400 },
    { date: "Mar 05", description: "DEP - Daily Sales (POS)", credit: 5900 },
    { date: "Mar 06", description: "DEP - Cash Deposit", credit: 3800 },
    { date: "Mar 07", description: "EFT - Biweekly Payroll", debit: 29000 },
    { date: "Mar 08", description: "DEP - Daily Sales (POS) - Sat", credit: 11500 },
    { date: "Mar 10", description: "DEP - Daily Sales (POS)", credit: 6400 },
    { date: "Mar 11", description: "DEP - Daily Sales (POS)", credit: 7100 },
    { date: "Mar 14", description: "PAD - 142 Queen St Rent", debit: 7200 },
    { date: "Mar 15", description: "DEP - Daily Sales (POS) - Sat", credit: 12200 },
    { date: "Mar 17", description: "DEP - Cash Deposit", credit: 4600 },
    { date: "Mar 18", description: "EFT - GFS (Gordon Food Service)", debit: 16800 },
    { date: "Mar 19", description: "PAD - Enbridge Gas", debit: 1600 },
    { date: "Mar 20", description: "PAD - Toronto Hydro", debit: 1150 },
    { date: "Mar 21", description: "EFT - Biweekly Payroll", debit: 29000 },
    { date: "Mar 22", description: "DEP - Daily Sales (POS) - Sat", credit: 11900 },
    { date: "Mar 24", description: "DEP - Daily Sales (POS)", credit: 5800 },
    { date: "Mar 25", description: "POS - LCBO (liquor inventory)", debit: 7800 },
    { date: "Mar 27", description: "DEP - Cash Deposit", credit: 3900 },
    { date: "Mar 28", description: "DEP - Daily Sales (POS)", credit: 6700 },
    { date: "Mar 31", description: "PAD - Moneris POS fees", debit: 1950 },
    { date: "Mar 31", description: "EFT - CRA HST Remittance Q4 2024", debit: 22200 },
  ];
  return restaurantBankStatement("March", "March 31", "2025", 51830, txns, 54530);
}

// 14. Restaurant Commercial Lease with Liquor License
function restaurantLease() {
  return writePdf("restaurant-toronto/legal/commercial-lease-with-liquor-license.pdf", (doc) => {
    let page = 1;

    doc.font("Helvetica-Bold").fontSize(16).text("COMMERCIAL LEASE AGREEMENT", 72, 72, { align: "center", width: 468 });
    doc.font("Helvetica").fontSize(10).text("(Restaurant / Licensed Establishment)", { align: "center", width: 468 });
    doc.moveDown(2);
    hrThick(doc);
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(9).text("THIS LEASE AGREEMENT (the \"Lease\") is made and entered into as of the 1st day of July, 2018.", 72, doc.y, { width: 468 });
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(9).text("BETWEEN:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Queen West Properties Inc. (hereinafter referred to as the \"Landlord\")", 90, doc.y, { width: 450 });
    doc.text("Address: 1200 Bay Street, Suite 1500, Toronto, Ontario M5R 2A5", 90);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(9).text("AND:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("2587341 Ontario Inc. o/a Terrazza Kitchen & Bar (hereinafter referred to as the \"Tenant\")", 90, doc.y, { width: 450 });
    doc.text("Address: 142 Queen Street West, Toronto, Ontario M5H 2N8", 90);
    doc.moveDown(1);
    hr(doc);

    legalSection(doc, 1, "PREMISES");
    legalBody(doc, "The Landlord hereby leases to the Tenant the premises known as 142 Queen Street West, Toronto, Ontario M5H 2N8, comprising approximately 3,800 square feet of ground-floor commercial space (the \"Premises\"), as outlined on the floor plan attached hereto as Schedule \"A\". The Premises include the main dining room, kitchen, bar area, washrooms, storage, and office.", 20);

    legalSection(doc, 2, "TERM");
    legalBody(doc, "The term of this Lease shall be ten (10) years, commencing on July 1, 2018 and expiring on June 30, 2028 (the \"Term\"). As of the date of this agreement, approximately three (3) years remain on the initial term.", 20);

    legalSection(doc, 3, "BASE RENT");
    legalBody(doc, "The Tenant shall pay to the Landlord base rent in the amount of Seven Thousand Two Hundred Dollars ($7,200.00) per month, inclusive of base rent and a portion of operating costs (gross lease structure), plus applicable HST, payable on the first day of each calendar month during the term of this Lease.", 20);

    legalSection(doc, 4, "LIQUOR LICENSE");
    legalBody(doc, "The Landlord acknowledges that the Tenant operates the Premises as a licensed establishment under the Alcohol and Gaming Commission of Ontario (AGCO). The Tenant's current liquor licence number is L-789456. The Landlord consents to the Tenant's continued operation as a licensed establishment and acknowledges that the liquor licence is transferable with Board approval, subject to the incoming operator meeting all AGCO requirements. Upon any assignment of this Lease, the Tenant shall cooperate with the assignee in the transfer of the liquor licence.", 20);

    legalSection(doc, 5, "PATIO");
    legalBody(doc, "The Tenant shall have the right to operate a seasonal outdoor patio on the sidewalk area immediately adjacent to the Premises, comprising approximately 800 square feet (the \"Patio Area\"), during the period from April 1 to October 31 of each year, subject to obtaining and maintaining all required municipal permits and approvals from the City of Toronto. The patio shall comply with all AGCO regulations regarding outdoor service areas. No additional rent shall be charged for the Patio Area.", 20);

    addPageNumber(doc, page);
    doc.addPage();
    page++;

    legalSection(doc, 6, "DEMOLITION CLAUSE");
    legalBody(doc, "Notwithstanding anything else contained in this Lease, the Landlord reserves the right to terminate this Lease upon twelve (12) months written notice to the Tenant for the purpose of demolition or substantial redevelopment of the building in which the Premises are located. In the event of such termination, the Tenant shall be entitled to a rent abatement equal to six (6) months of Base Rent as compensation. The Landlord shall make reasonable efforts to assist the Tenant in finding alternative premises, but shall have no obligation to do so. This clause shall survive any assignment or subletting of this Lease.", 20);

    legalSection(doc, 7, "PERMITTED USE");
    legalBody(doc, "The Premises shall be used and occupied by the Tenant solely for the purpose of operating a full-service restaurant and bar, including food preparation, dining service, beverage service (alcoholic and non-alcoholic), and related entertainment. The Tenant shall comply with all applicable laws, bylaws, and regulations governing the operation of a food establishment and licensed premises in the City of Toronto.", 20);

    legalSection(doc, 8, "INSURANCE");
    legalBody(doc, "The Tenant shall maintain, at its own expense: (a) commercial general liability insurance of not less than $5,000,000 per occurrence, including liquor liability coverage; (b) property insurance covering all contents, equipment, and leasehold improvements; (c) business interruption insurance for not less than 12 months of gross revenue; (d) the Landlord shall be named as additional insured on all policies.", 20);

    legalSection(doc, 9, "MAINTENANCE AND REPAIRS");
    legalBody(doc, "The Tenant shall be responsible for all interior maintenance and repairs, including kitchen equipment, HVAC serving the Premises, plumbing, electrical, flooring, and finishes. The Landlord shall be responsible for structural repairs, the roof, and exterior walls. The Tenant shall maintain the kitchen exhaust system in accordance with NFPA 96 standards and provide evidence of regular cleaning to the Landlord upon request.", 20);

    legalSection(doc, 10, "ASSIGNMENT AND SUBLETTING");
    legalBody(doc, "The Tenant shall not assign this Lease or sublet the Premises without the prior written consent of the Landlord, which consent shall not be unreasonably withheld. Any assignee must demonstrate financial capability to operate a restaurant and bar and must obtain all necessary licences, including an AGCO liquor licence transfer.", 20);

    legalSection(doc, 11, "LEASEHOLD IMPROVEMENTS");
    legalBody(doc, "Any leasehold improvements shall require prior written consent of the Landlord. All improvements shall become the property of the Landlord at the expiration of the Lease. The Tenant has invested approximately $285,000 in leasehold improvements to date, including kitchen build-out, bar construction, and dining room finishes.", 20);

    legalSection(doc, 12, "ENVIRONMENTAL AND HEALTH");
    legalBody(doc, "The Tenant shall comply with all Toronto Public Health regulations, maintain valid DineSafe inspection status, and ensure all food handling and storage complies with the Health Protection and Promotion Act, R.S.O. 1990, c. H.7. The Tenant shall maintain a grease trap in accordance with the City of Toronto Sewer Use Bylaw.", 20);

    legalSection(doc, 13, "GOVERNING LAW");
    legalBody(doc, "This Lease shall be governed by and construed in accordance with the laws of the Province of Ontario and the federal laws of Canada applicable therein.", 20);

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).text("IN WITNESS WHEREOF, the parties have executed this Lease.", 72, doc.y, { width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    doc.text("LANDLORD: Queen West Properties Inc.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Authorized Signing Officer", 90);
    doc.text("      Date: July 1, 2018", 90);
    doc.moveDown(1.5);
    doc.text("TENANT: 2587341 Ontario Inc. o/a Terrazza Kitchen & Bar", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Marco Terrazza, President", 90);
    doc.text("      Date: July 1, 2018", 90);

    addPageNumber(doc, page);
  });
}

// 15. Health Inspection 2023
function restaurantHealthInspection2023() {
  return writePdf("restaurant-toronto/compliance/health-inspection-2023.pdf", (doc) => {
    doc.font("Helvetica-Bold").fontSize(14).text("Toronto Public Health", 72, 72, { width: 468, align: "center" });
    doc.font("Helvetica").fontSize(10).text("DineSafe Inspection Report", { width: 468, align: "center" });
    doc.moveDown(1);
    hrThick(doc);
    doc.moveDown(0.5);

    // Establishment info
    doc.font("Helvetica-Bold").fontSize(10).text("ESTABLISHMENT INFORMATION");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Establishment Name:    Terrazza Kitchen & Bar");
    doc.text("Address:               142 Queen Street West, Toronto, ON M5H 2N8");
    doc.text("Operator:              2587341 Ontario Inc.");
    doc.text("Establishment Type:    Full-Service Restaurant (with liquor licence)");
    doc.text("Seating Capacity:      85 indoor / 32 patio");
    doc.moveDown(1);
    hr(doc);

    // Inspection details
    doc.font("Helvetica-Bold").fontSize(10).text("INSPECTION DETAILS");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Inspection Date:       March 15, 2023");
    doc.text("Inspection Type:       Routine");
    doc.text("Inspector:             M. Thompson, PHI");
    doc.text("Inspection #:          TPH-2023-041285");
    doc.moveDown(0.5);

    // Result box
    const boxY = doc.y;
    doc.rect(72, boxY, 468, 40).fillAndStroke("#FFF3CD", "#856404");
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#856404").text("CONDITIONAL PASS", 72, boxY + 12, { width: 468, align: "center" });
    doc.fillColor("#000000");
    doc.y = boxY + 55;

    doc.moveDown(1);
    hr(doc);

    // Infractions
    doc.font("Helvetica-Bold").fontSize(10).text("INFRACTIONS");
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(9).text("Infraction #1", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Item:          7(b) — Handwashing and Hygiene", 90);
    doc.text("Severity:      Minor (M)", 90);
    doc.text("Description:   Handwashing station in prep area obstructed by", 90);
    doc.text("               storage containers. Staff unable to access sink", 90);
    doc.text("               without moving containers.", 90);
    doc.text("Action:        Corrected during inspection. Storage containers", 90);
    doc.text("               relocated to designated storage area.", 90);
    doc.moveDown(1);

    // Other items
    doc.font("Helvetica-Bold").fontSize(10).text("ITEMS INSPECTED — ALL COMPLIANT");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(8);

    const compliantItems = [
      "1. Food Temperature Control — Hot holding, cold holding, cooling procedures",
      "2. Food Source — Approved food suppliers, no recalled products",
      "3. Food Protection — Proper storage, labeling, dating",
      "4. Food Preparation — Thawing, cooking temperatures, cross-contamination prevention",
      "5. Equipment & Utensils — Clean, sanitized, in good repair",
      "6. Pest Control — No evidence of pests, pest management program in place",
      "7(a). Personal Hygiene — Proper attire, hair restraints, illness policy",
      "8. Waste Management — Proper disposal, secure waste containers",
      "9. Premises Maintenance — Floors, walls, ceilings in good repair",
      "10. Water Supply & Sewage — Municipal supply, grease trap maintained",
      "11. Chemical Storage — Properly stored, labeled, separated from food",
      "12. Employee Health — Health records on file, illness reporting procedure",
    ];
    for (const item of compliantItems) {
      doc.text(`   ${item}`, 72, doc.y, { width: 468 });
    }

    doc.moveDown(1);
    hr(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("RE-INSPECTION");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Re-inspection Date:    April 5, 2023");
    doc.text("Re-inspection Result:  PASS");
    doc.text("All previously noted infractions corrected and verified.");
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(7).fillColor("#999999");
    doc.text("For more information about DineSafe, visit toronto.ca/dinesafe or call 311.", 72, doc.y, { width: 468, align: "center" });
  });
}

// 16. Health Inspection 2024
function restaurantHealthInspection2024() {
  return writePdf("restaurant-toronto/compliance/health-inspection-2024.pdf", (doc) => {
    doc.font("Helvetica-Bold").fontSize(14).text("Toronto Public Health", 72, 72, { width: 468, align: "center" });
    doc.font("Helvetica").fontSize(10).text("DineSafe Inspection Report", { width: 468, align: "center" });
    doc.moveDown(1);
    hrThick(doc);
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(10).text("ESTABLISHMENT INFORMATION");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Establishment Name:    Terrazza Kitchen & Bar");
    doc.text("Address:               142 Queen Street West, Toronto, ON M5H 2N8");
    doc.text("Operator:              2587341 Ontario Inc.");
    doc.text("Establishment Type:    Full-Service Restaurant (with liquor licence)");
    doc.text("Seating Capacity:      85 indoor / 32 patio");
    doc.moveDown(1);
    hr(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("INSPECTION DETAILS");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Inspection Date:       February 28, 2024");
    doc.text("Inspection Type:       Routine");
    doc.text("Inspector:             R. Nakamura, PHI");
    doc.text("Inspection #:          TPH-2024-009712");
    doc.moveDown(0.5);

    // Result box — PASS
    const boxY = doc.y;
    doc.rect(72, boxY, 468, 40).fillAndStroke("#D4EDDA", "#155724");
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#155724").text("PASS", 72, boxY + 12, { width: 468, align: "center" });
    doc.fillColor("#000000");
    doc.y = boxY + 55;

    doc.moveDown(1);
    hr(doc);

    doc.font("Helvetica-Bold").fontSize(10).text("INFRACTIONS");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("No infractions noted during this inspection.", 90);
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(10).text("INSPECTOR NOTES");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Facility well maintained. Food handling procedures exemplary. All temperature logs current and within acceptable ranges. Staff demonstrated strong knowledge of food safety protocols. Kitchen and storage areas clean and well organized. Grease trap service records up to date. Pest management documentation reviewed — no concerns.", 72, doc.y, { width: 468, lineGap: 2 });
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(10).text("ITEMS INSPECTED — ALL COMPLIANT");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(8);
    const items = [
      "1. Food Temperature Control",
      "2. Food Source",
      "3. Food Protection",
      "4. Food Preparation",
      "5. Equipment & Utensils",
      "6. Pest Control",
      "7. Handwashing & Personal Hygiene",
      "8. Waste Management",
      "9. Premises Maintenance",
      "10. Water Supply & Sewage",
      "11. Chemical Storage",
      "12. Employee Health",
    ];
    for (const item of items) {
      doc.text(`   ${item} — Compliant`, 72);
    }
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(7).fillColor("#999999");
    doc.text("For more information about DineSafe, visit toronto.ca/dinesafe or call 311.", 72, doc.y, { width: 468, align: "center" });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEDICAL CLINIC ONTARIO
// ═══════════════════════════════════════════════════════════════════════════════

// 17. Physician Services Agreement
function medicalPhysicianAgreement() {
  return writePdf("medical-clinic-ontario/legal/physician-agreement-fee-split.pdf", (doc) => {
    let page = 1;

    doc.font("Helvetica-Bold").fontSize(16).text("PHYSICIAN SERVICES AGREEMENT", 72, 72, { align: "center", width: 468 });
    doc.moveDown(2);
    hrThick(doc);
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(9).text("THIS PHYSICIAN SERVICES AGREEMENT (the \"Agreement\") is made effective as of the _____ day of _____________, 20___.", 72, doc.y, { width: 468 });
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(9).text("BETWEEN:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Bayview Family Health Centre (Professional Corporation)", 90, doc.y, { width: 450 });
    doc.text("Suite 200, 1850 Bayview Avenue, Toronto, Ontario M4G 3E8", 90);
    doc.text("(hereinafter referred to as the \"Clinic\")", 90);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(9).text("AND:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Dr. [Associate Physician Name]", 90, doc.y, { width: 450 });
    doc.text("(hereinafter referred to as the \"Physician\")", 90);
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(8).fillColor("#666666");
    doc.text("This Agreement applies to the following associate physicians:", 72);
    doc.text("  - Dr. Sarah Chen, MD, CCFP", 90);
    doc.text("  - Dr. Amir Patel, MD, CCFP", 90);
    doc.text("  - Dr. Lisa Wong, MD, CCFP", 90);
    doc.fillColor("#000000");
    doc.moveDown(1);
    hr(doc);

    legalSection(doc, 1, "FEE SPLIT ARRANGEMENT");
    legalBody(doc, "The Physician shall retain seventy percent (70%) of all professional fees billed and collected in connection with the Physician's clinical services. The Clinic shall retain thirty percent (30%) of all such fees (the \"Clinic Share\"). The Clinic Share is compensation for the Clinic's provision of administrative services, infrastructure, and support as described herein.", 20);

    legalSection(doc, 2, "CLINIC OBLIGATIONS");
    legalBody(doc, "In consideration of the Clinic Share, the Clinic shall provide the following to the Physician:", 20);
    legalBody(doc, "(a) Office space: fully equipped examination rooms, consultation room, and access to procedure room;\n(b) Administrative staff: reception, nursing, and administrative support;\n(c) Medical equipment and supplies: examination tables, diagnostic instruments, medical consumables;\n(d) Billing services: OHIP billing, reconciliation, and collections;\n(e) EMR system: full access to OSCAR EMR, including training and technical support;\n(f) Insurance: clinic-level malpractice top-up and general liability;\n(g) Utilities, internet, and telephone services.", 40);

    legalSection(doc, 3, "NON-COMPETITION COVENANT");
    legalBody(doc, "During the term of this Agreement and for a period of two (2) years following the termination of this Agreement, the Physician shall not, directly or indirectly, practice family medicine or operate or be associated with a family medical practice within a radius of ten (10) kilometres from the Clinic's premises at 1850 Bayview Avenue, Toronto, Ontario. The Physician acknowledges that this restriction is reasonable in scope, duration, and geographic extent, and is necessary to protect the Clinic's patient relationships and goodwill.", 20);

    legalSection(doc, 4, "PATIENT CHARTS AND RECORDS");
    legalBody(doc, "All patient charts and medical records shall be owned by the Clinic Professional Corporation. The Physician acknowledges that patient records created during the term of this Agreement are the property of the Clinic. Upon termination, the Physician may request copies of patient records for patients who elect to follow the Physician to a new practice, subject to applicable privacy legislation including the Personal Health Information Protection Act, 2004 (PHIPA). The Clinic shall facilitate the transfer of records within thirty (30) days of a written request.", 20);

    addPageNumber(doc, page);
    doc.addPage();
    page++;

    legalSection(doc, 5, "TERMINATION");
    legalBody(doc, "Either party may terminate this Agreement upon ninety (90) days written notice to the other party. The Clinic may terminate this Agreement immediately upon written notice if the Physician: (a) loses their licence to practice medicine in Ontario; (b) is found guilty of professional misconduct by the College of Physicians and Surgeons of Ontario; (c) engages in conduct that is materially detrimental to the reputation or operations of the Clinic; or (d) breaches any material term of this Agreement.", 20);

    legalSection(doc, 6, "CLINICAL INDEPENDENCE");
    legalBody(doc, "The Physician shall have independent clinical judgment in the treatment of patients. The Clinic shall not direct or control the Physician's clinical decision-making. The Physician shall practice in accordance with the standards of the College of Physicians and Surgeons of Ontario and applicable legislation. The Physician is an independent contractor and not an employee of the Clinic.", 20);

    legalSection(doc, 7, "SCHEDULING AND AVAILABILITY");
    legalBody(doc, "The Physician shall be available to see patients at the Clinic a minimum of four (4) days per week, with a target of thirty-five (35) patient encounters per day. Scheduling shall be coordinated with the Clinic's reception staff. The Physician shall provide reasonable notice of planned absences and shall arrange for coverage as needed. On-call responsibilities shall be shared equitably among all associate physicians.", 20);

    legalSection(doc, 8, "INSURANCE AND LICENSING");
    legalBody(doc, "The Physician shall at all times maintain: (a) a valid licence to practice medicine in Ontario issued by the College of Physicians and Surgeons of Ontario; (b) membership in the Canadian Medical Protective Association (CMPA) or equivalent malpractice insurance coverage; (c) current OHIP billing privileges. The Physician shall provide evidence of the foregoing to the Clinic upon request.", 20);

    legalSection(doc, 9, "CONFIDENTIALITY");
    legalBody(doc, "The Physician shall maintain the confidentiality of all patient information in accordance with PHIPA and applicable regulations. The Physician shall also maintain the confidentiality of the Clinic's business information, financial records, and operational procedures, both during and after the term of this Agreement.", 20);

    legalSection(doc, 10, "INDEMNIFICATION");
    legalBody(doc, "The Physician shall indemnify and hold harmless the Clinic from any and all claims, damages, losses, costs, and expenses arising out of the Physician's professional practice, including but not limited to malpractice claims, regulatory proceedings, and billing irregularities attributable to the Physician.", 20);

    legalSection(doc, 11, "GOVERNING LAW");
    legalBody(doc, "This Agreement shall be governed by and construed in accordance with the laws of the Province of Ontario and the federal laws of Canada applicable therein. Any disputes arising under this Agreement shall be submitted to binding arbitration in Toronto, Ontario.", 20);

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).text("IN WITNESS WHEREOF, the parties have executed this Agreement.", 72, doc.y, { width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    doc.text("CLINIC: Bayview Family Health Centre (Professional Corporation)", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Dr. Robert Kim, Managing Physician", 90);
    doc.moveDown(1.5);
    doc.text("PHYSICIAN:", 72);
    doc.moveDown(1.5);
    doc.text("________________________________", 72);
    doc.text("Dr. [Name], MD, CCFP", 90);

    addPageNumber(doc, page);
  });
}

// 18. EMR System Documentation
function medicalEMRDocumentation() {
  return writePdf("medical-clinic-ontario/operations/emr-system-documentation.pdf", (doc) => {
    let page = 1;

    doc.font("Helvetica-Bold").fontSize(14).text("EMR System Overview", 72, 72, { align: "center", width: 468 });
    doc.font("Helvetica").fontSize(11).text("Bayview Family Health Centre", { align: "center", width: 468 });
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(8).fillColor("#666666").text("Prepared: January 2025  |  Confidential — For Internal Use Only", { align: "center", width: 468 });
    doc.fillColor("#000000");
    doc.moveDown(1);
    hrThick(doc);
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(11).text("1. System Identification");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("EMR Platform:           OSCAR EMR (Open Source Clinical Application Resource)");
    doc.text("Version:                19.12.3");
    doc.text("Hosting:                Self-hosted on dedicated server (on-premises)");
    doc.text("Server OS:              Ubuntu 22.04 LTS");
    doc.text("Database:               MySQL 8.0");
    doc.text("Last Major Upgrade:     September 2023");
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(11).text("2. Patient Roster");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Active Patients:        4,200");
    doc.text("Inactive Patients:      ~800 (no encounter in >3 years)");
    doc.text("New Patients/Month:     ~35 average");
    doc.text("Rostered to:");
    doc.text("  - Dr. Robert Kim (Managing Physician):    1,200 patients");
    doc.text("  - Dr. Sarah Chen:                         1,100 patients");
    doc.text("  - Dr. Amir Patel:                         1,050 patients");
    doc.text("  - Dr. Lisa Wong:                            850 patients");
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(11).text("3. Data Contained in EMR");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    const dataTypes = [
      "Patient demographics (name, DOB, address, health card, contact)",
      "Encounter notes (SOAP format, >85,000 encounter records)",
      "Prescriptions (linked to ODB — Ontario Drug Benefit formulary)",
      "Laboratory results (connected to OLIS — Ontario Lab Information System)",
      "Referral letters (sent and received)",
      "Immunization records (childhood, seasonal influenza, COVID-19, travel)",
      "Preventive care tracking (screening reminders, chronic disease management)",
      "Diagnostic imaging requisitions and reports",
      "Consultation reports from specialists",
      "Billing records (OHIP claims, private billing)",
    ];
    for (const item of dataTypes) {
      doc.text(`  - ${item}`, 72, doc.y, { width: 468 });
    }
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(11).text("4. System Integrations");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("OLIS (Ontario Lab Information System):  Connected — real-time lab results feed");
    doc.text("ODB (Ontario Drug Benefit):             Connected — formulary and DUR checks");
    doc.text("eReferral (Ontario Health):             Active — electronic specialist referrals");
    doc.text("HRM (Hospital Report Manager):          Active — discharge summaries auto-imported");
    doc.text("OLIS eForms:                            Active — COVID-19 reporting, BORN integration");
    doc.moveDown(1);

    addPageNumber(doc, page);
    doc.addPage();
    page++;

    doc.font("Helvetica-Bold").fontSize(11).text("5. Data Retention and Privacy");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Data Retention Policy:  10 years minimum per PHIPA (Personal Health Information");
    doc.text("                        Protection Act, 2004, S.O. 2004, c. 3, Sched. A)");
    doc.text("Retention for Minors:   Records retained until patient turns 28 years of age");
    doc.text("                        (18th birthday + 10 years)");
    doc.text("Privacy Officer:        Dr. Robert Kim (designated under PHIPA s. 15)");
    doc.text("Breach Protocol:        Documented incident response plan in compliance with");
    doc.text("                        IPC (Information and Privacy Commissioner) guidelines");
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(11).text("6. Data Migration");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Export Format:          OSCAR supports HL7 v2.x export for demographics,");
    doc.text("                        encounters, and laboratory data");
    doc.text("CDA Export:             Clinical Document Architecture (CDA) export available");
    doc.text("                        for structured encounter notes");
    doc.text("Estimated Timeline:     4-6 weeks for full migration to another EMR platform");
    doc.text("Migration Cost Est.:    $15,000 - $25,000 (depending on target system)");
    doc.text("Data Validation:        Post-migration audit recommended — minimum 5% sample");
    doc.text("                        of patient records verified for completeness");
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(11).text("7. Backup and Disaster Recovery");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Backup Schedule:        Daily automated backup at 02:00 EST");
    doc.text("Backup Type:            Full database dump + file system snapshot");
    doc.text("Offsite Storage:        Encrypted AES-256, stored at Canadian data centre");
    doc.text("                        (AWS Canada — ca-central-1 region)");
    doc.text("Retention:              30 daily backups, 12 monthly backups, 3 annual backups");
    doc.text("Recovery Time (RTO):    4 hours");
    doc.text("Recovery Point (RPO):   24 hours (last daily backup)");
    doc.text("Last DR Test:           October 2024 — successful full restore verified");
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(11).text("8. User Access");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9);
    doc.text("Total Users:            8");
    doc.text("  Physicians:           4 (Dr. Kim, Dr. Chen, Dr. Patel, Dr. Wong)");
    doc.text("  Reception:            2 (full patient scheduling and registration access)");
    doc.text("  Nurse:                1 (clinical documentation, vitals, immunizations)");
    doc.text("  Admin/Billing:        1 (billing, reporting, system administration)");
    doc.text("IT Support:             1 external contractor (quarterly maintenance + on-call)");
    doc.moveDown(0.5);
    doc.text("Access Control:         Role-based, individual login credentials");
    doc.text("Audit Logging:          All access and modifications logged with timestamps");
    doc.text("2FA:                    Not currently enabled (recommended for compliance)");

    addPageNumber(doc, page);
  });
}

// 19. Medical Office Lease
function medicalOfficeLease() {
  return writePdf("medical-clinic-ontario/legal/medical-office-lease.pdf", (doc) => {
    let page = 1;

    doc.font("Helvetica-Bold").fontSize(16).text("COMMERCIAL LEASE AGREEMENT", 72, 72, { align: "center", width: 468 });
    doc.font("Helvetica").fontSize(10).text("(Medical / Professional Office)", { align: "center", width: 468 });
    doc.moveDown(2);
    hrThick(doc);
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(9).text("THIS LEASE AGREEMENT (the \"Lease\") is made and entered into as of the 1st day of March, 2020.", 72, doc.y, { width: 468 });
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(9).text("BETWEEN:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Bayview Medical Centre Inc. (hereinafter referred to as the \"Landlord\")", 90, doc.y, { width: 450 });
    doc.text("Address: 1850 Bayview Avenue, Suite 100, Toronto, Ontario M4G 3E8", 90);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(9).text("AND:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Bayview Family Health Centre (Professional Corporation) (hereinafter referred to as the \"Tenant\")", 90, doc.y, { width: 450 });
    doc.text("c/o Dr. Robert Kim, Managing Physician", 90);
    doc.moveDown(1);
    hr(doc);

    legalSection(doc, 1, "PREMISES");
    legalBody(doc, "The Landlord hereby leases to the Tenant the premises known as Suite 200, 1850 Bayview Avenue, Toronto, Ontario M4G 3E8, comprising approximately 4,500 square feet (the \"Premises\"). The Premises are situated in a building zoned Medical/Professional Office (M-1) and are suitable for the operation of a family medicine practice.", 20);

    legalSection(doc, 2, "TERM");
    legalBody(doc, "The term of this Lease shall be seven (7) years, commencing on March 1, 2020 and expiring on February 28, 2027 (the \"Term\"). As of March 2025, approximately four (4) years remain on the initial term.", 20);

    legalSection(doc, 3, "RENT");
    legalBody(doc, "The Tenant shall pay to the Landlord base rent in the amount of Six Thousand Five Hundred Dollars ($6,500.00) per month, inclusive of base rent, property taxes, and building insurance (gross lease structure), plus applicable HST, payable on the first day of each calendar month.", 20);

    legalSection(doc, 4, "HVAC AND VENTILATION");
    legalBody(doc, "The building HVAC system serving the Premises has been designed and installed to meet medical-grade ventilation requirements per the Ontario Building Code (O. Reg. 332/12), including minimum air exchange rates for examination rooms and procedure areas. The Landlord shall maintain the HVAC system in accordance with manufacturer specifications and applicable healthcare facility standards. The Tenant shall have the right to install additional HEPA filtration units in the Premises at the Tenant's expense.", 20);

    legalSection(doc, 5, "LEASEHOLD IMPROVEMENTS");
    legalBody(doc, "The Tenant has invested approximately One Hundred and Eighty Thousand Dollars ($180,000.00) in leasehold improvements to the Premises, including but not limited to: (a) construction of six (6) examination rooms with medical-grade finishes; (b) one (1) procedure room with enhanced ventilation and clinical lighting; (c) one (1) laboratory draw station with specimen handling area; (d) reception and waiting area with patient check-in stations; (e) medical records storage room; (f) staff lounge and physician offices. All improvements have been made with the Landlord's prior written consent.", 20);

    addPageNumber(doc, page);
    doc.addPage();
    page++;

    legalSection(doc, 6, "PARKING");
    legalBody(doc, "The Tenant shall have the exclusive use of twelve (12) dedicated parking spaces in the building parking lot, designated as spaces P-201 through P-212, at no additional charge. Additional patient parking is available in the shared building lot on a first-come, first-served basis.", 20);

    legalSection(doc, 7, "SIGNAGE");
    legalBody(doc, "The Tenant shall be permitted to install signage on the building directory at the main entrance and at the suite entrance on the second floor, subject to the Landlord's prior written approval of design, size, and placement. Signage costs shall be borne by the Tenant.", 20);

    legalSection(doc, 8, "BIOHAZARD WASTE");
    legalBody(doc, "The Landlord shall be responsible for the management and disposal of biohazard waste generated in the common areas of the building, including sharps containers and biological waste bins located in designated common area waste stations. The Tenant shall be responsible for the proper collection, storage, and labelling of biohazard waste generated within the Premises, and shall contract with a licensed biohazard waste disposal service for regular pickup. The Tenant shall comply with all applicable regulations under the Environmental Protection Act (Ontario) and the Ontario Regulation 347 (General — Waste Management).", 20);

    legalSection(doc, 9, "PERMITTED USE");
    legalBody(doc, "The Premises shall be used solely for the operation of a family medicine practice and related ancillary health services. The Tenant shall comply with all applicable federal, provincial, and municipal regulations governing the operation of a medical practice, including but not limited to the Regulated Health Professions Act, 1991, the Medicine Act, 1991, PHIPA, and all regulations of the College of Physicians and Surgeons of Ontario.", 20);

    legalSection(doc, 10, "INSURANCE");
    legalBody(doc, "The Tenant shall maintain: (a) commercial general liability insurance of not less than $5,000,000 per occurrence; (b) professional liability insurance (medical malpractice) through CMPA or equivalent; (c) property insurance covering all contents, equipment, and leasehold improvements; (d) the Landlord shall be named as additional insured on the CGL policy.", 20);

    legalSection(doc, 11, "ASSIGNMENT");
    legalBody(doc, "The Tenant shall not assign this Lease without the prior written consent of the Landlord, which consent shall not be unreasonably withheld. Any assignee must be a qualified medical professional or professional corporation authorized to practice medicine in Ontario.", 20);

    legalSection(doc, 12, "GOVERNING LAW");
    legalBody(doc, "This Lease shall be governed by and construed in accordance with the laws of the Province of Ontario.", 20);

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).text("IN WITNESS WHEREOF, the parties have executed this Lease.", 72, doc.y, { width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    doc.text("LANDLORD: Bayview Medical Centre Inc.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Authorized Signing Officer", 90);
    doc.text("      Date: March 1, 2020", 90);
    doc.moveDown(1.5);
    doc.text("TENANT: Bayview Family Health Centre (Professional Corporation)", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Dr. Robert Kim, Managing Physician", 90);
    doc.text("      Date: March 1, 2020", 90);

    addPageNumber(doc, page);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANUFACTURING ALBERTA
// ═══════════════════════════════════════════════════════════════════════════════

// 20. ISO 9001 Certification
function manufacturingISO() {
  return writePdf("manufacturing-alberta/compliance/iso-9001-certification.pdf", (doc) => {
    doc.moveDown(3);

    // Border
    doc.rect(52, 52, 508, 688).strokeColor("#1a3c5e").lineWidth(3).stroke();
    doc.rect(58, 58, 496, 676).strokeColor("#c9a84c").lineWidth(1).stroke();

    doc.font("Helvetica-Bold").fontSize(12).fillColor("#1a3c5e").text("SGS Canada Inc.", 72, 90, { align: "center", width: 468 });
    doc.font("Helvetica").fontSize(9).fillColor("#666666").text("Accredited Certification Body — Standards Council of Canada", { align: "center", width: 468 });
    doc.fillColor("#000000");
    doc.moveDown(2);

    doc.font("Helvetica-Bold").fontSize(20).fillColor("#1a3c5e").text("Certificate of Registration", { align: "center", width: 468 });
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#c9a84c").text("ISO 9001:2015", { align: "center", width: 468 });
    doc.font("Helvetica").fontSize(10).fillColor("#333333").text("Quality Management Systems — Requirements", { align: "center", width: 468 });
    doc.fillColor("#000000");
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(10).text("This is to certify that the Quality Management System of:", { align: "center", width: 468 });
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(14).text("Precision Metal Works Inc.", { align: "center", width: 468 });
    doc.font("Helvetica").fontSize(10).text("2847 Industrial Boulevard", { align: "center", width: 468 });
    doc.text("Edmonton, Alberta  T5S 1A3", { align: "center", width: 468 });
    doc.text("Canada", { align: "center", width: 468 });
    doc.moveDown(1.5);

    doc.font("Helvetica").fontSize(10).text("has been assessed and found to conform to the requirements of ISO 9001:2015 for the following scope:", { align: "center", width: 468 });
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(10).text(
      "\"Design, manufacture, and assembly of custom metal components, precision machined parts, and fabricated steel structures for industrial, energy, and commercial applications\"",
      90, doc.y, { width: 432, align: "center" }
    );
    doc.moveDown(2);

    // Certificate details
    doc.font("Helvetica").fontSize(9);
    const detailLeft = 160;
    const detailRight = 310;
    let y = doc.y;

    doc.font("Helvetica-Bold").text("Certificate Number:", detailLeft, y);
    doc.font("Helvetica").text("CA-QMS-2019-08847", detailRight, y);
    y += 18;
    doc.font("Helvetica-Bold").text("Original Certification:", detailLeft, y);
    doc.font("Helvetica").text("August 12, 2019", detailRight, y);
    y += 18;
    doc.font("Helvetica-Bold").text("Current Certification:", detailLeft, y);
    doc.font("Helvetica").text("August 12, 2022", detailRight, y);
    y += 18;
    doc.font("Helvetica-Bold").text("Expiry Date:", detailLeft, y);
    doc.font("Helvetica").text("August 11, 2025", detailRight, y);
    y += 18;
    doc.font("Helvetica-Bold").text("Certification Cycle:", detailLeft, y);
    doc.font("Helvetica").text("3-year cycle", detailRight, y);
    y += 18;
    doc.font("Helvetica-Bold").text("Last Surveillance Audit:", detailLeft, y);
    doc.font("Helvetica").text("February 15, 2025", detailRight, y);
    y += 18;
    doc.font("Helvetica-Bold").text("Audit Result:", detailLeft, y);
    doc.font("Helvetica").fillColor("#006600").text("No non-conformities", detailRight, y);
    doc.fillColor("#000000");

    doc.moveDown(4);
    doc.font("Helvetica").fontSize(9);
    doc.text("________________________________", 150, doc.y);
    doc.text("Authorized Signatory", 150);
    doc.text("SGS Canada Inc.", 150);
    doc.text("Toronto, Ontario", 150);

    doc.text("________________________________", 350, doc.y - 48);
    doc.text("Lead Auditor", 350, doc.y - 30);
  });
}

// 21. Customer Contract - Apex Industrial
function manufacturingContractApex() {
  return writePdf("manufacturing-alberta/legal/customer-contract-apex-industrial.pdf", (doc) => {
    let page = 1;

    doc.font("Helvetica-Bold").fontSize(16).text("SUPPLY AGREEMENT", 72, 72, { align: "center", width: 468 });
    doc.moveDown(2);
    hrThick(doc);
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(9).text("THIS SUPPLY AGREEMENT (the \"Agreement\") is made effective as of January 1, 2023.", 72, doc.y, { width: 468 });
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(9).text("BETWEEN:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Precision Metal Works Inc. (hereinafter referred to as the \"Supplier\")", 90, doc.y, { width: 450 });
    doc.text("2847 Industrial Boulevard, Edmonton, Alberta T5S 1A3", 90);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(9).text("AND:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Apex Industrial Solutions Ltd. (hereinafter referred to as the \"Buyer\")", 90, doc.y, { width: 450 });
    doc.text("4500 Gateway Boulevard NW, Edmonton, Alberta T6H 5C3", 90);
    doc.moveDown(1);
    hr(doc);

    legalSection(doc, 1, "TERM");
    legalBody(doc, "The initial term of this Agreement shall be three (3) years, commencing on January 1, 2023 and expiring on December 31, 2025, unless terminated earlier in accordance with the provisions hereof.", 20);

    legalSection(doc, 2, "MINIMUM ANNUAL COMMITMENT");
    legalBody(doc, "The Buyer agrees to purchase from the Supplier a minimum of One Million Five Hundred Thousand Dollars ($1,500,000.00) of products and services during each contract year (the \"Minimum Commitment\"). Failure to meet the Minimum Commitment shall result in a shortfall fee equal to ten percent (10%) of the difference between actual purchases and the Minimum Commitment.", 20);

    legalSection(doc, 3, "PRICING");
    legalBody(doc, "Pricing for all products shall be as set forth in the Price Schedule attached hereto as Schedule \"A\". Prices are subject to annual adjustment based on the Consumer Price Index (CPI) for Edmonton, Alberta, plus a fixed escalation of two percent (2%), applied on January 1 of each contract year. The Supplier shall provide the Buyer with thirty (30) days written notice of any price adjustment.", 20);

    legalSection(doc, 4, "PAYMENT TERMS");
    legalBody(doc, "Payment for all products and services shall be due net thirty (30) days from the date of delivery. Invoices shall be submitted upon shipment or completion of services. Late payments shall bear interest at the rate of 1.5% per month (18% per annum) on the outstanding balance.", 20);

    legalSection(doc, 5, "QUALITY STANDARDS");
    legalBody(doc, "All products supplied under this Agreement shall conform to the Supplier's ISO 9001:2015 quality management system and shall meet the engineering specifications provided by the Buyer (the \"Apex Engineering Specifications\"). The Supplier shall maintain its ISO 9001 certification throughout the term of this Agreement. The Buyer reserves the right to conduct quality audits of the Supplier's facilities upon reasonable notice.", 20);

    legalSection(doc, 6, "DELIVERY");
    legalBody(doc, "Delivery shall be FOB Supplier's facility in Edmonton, Alberta. The Supplier shall use commercially reasonable efforts to meet the delivery dates specified in each purchase order. In the event of delays exceeding five (5) business days, the Supplier shall notify the Buyer immediately and provide a revised delivery schedule.", 20);

    addPageNumber(doc, page);
    doc.addPage();
    page++;

    legalSection(doc, 7, "WARRANTY");
    legalBody(doc, "The Supplier warrants that all products delivered under this Agreement shall be free from defects in materials and workmanship for a period of twenty-four (24) months from the date of delivery. The Supplier shall, at its option, repair or replace any defective product at no cost to the Buyer.", 20);

    legalSection(doc, 8, "TERMINATION");
    legalBody(doc, "Either party may terminate this Agreement upon ninety (90) days written notice to the other party. Early termination by the Buyer prior to the expiration of the initial term shall result in a penalty equal to the shortfall between actual purchases to date and the prorated Minimum Commitment for the remaining term.", 20);

    legalSection(doc, 9, "AUTO-RENEWAL");
    legalBody(doc, "Following the initial term, this Agreement shall automatically renew for successive one (1) year terms unless either party provides the other with no less than six (6) months written notice of its intention not to renew prior to the expiration of the then-current term.", 20);

    legalSection(doc, 10, "LIABILITY CAP");
    legalBody(doc, "The total aggregate liability of the Supplier under this Agreement, whether in contract, tort, or otherwise, shall not exceed one hundred percent (100%) of the total annual contract value. In no event shall either party be liable for indirect, incidental, consequential, or punitive damages.", 20);

    legalSection(doc, 11, "INTELLECTUAL PROPERTY");
    legalBody(doc, "The Buyer retains full ownership of all designs, drawings, specifications, and intellectual property provided to the Supplier in connection with the manufacture of products under this Agreement. The Supplier shall not use such intellectual property for any purpose other than the performance of this Agreement, and shall not disclose such intellectual property to any third party without the prior written consent of the Buyer.", 20);

    legalSection(doc, 12, "GOVERNING LAW");
    legalBody(doc, "This Agreement shall be governed by and construed in accordance with the laws of the Province of Alberta and the federal laws of Canada applicable therein.", 20);

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).text("IN WITNESS WHEREOF, the parties have executed this Agreement.", 72, doc.y, { width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    doc.text("SUPPLIER: Precision Metal Works Inc.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Frank Kowalski, President", 90);
    doc.text("      Date: January 1, 2023", 90);
    doc.moveDown(1.5);
    doc.text("BUYER: Apex Industrial Solutions Ltd.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Authorized Signing Officer", 90);
    doc.text("      Date: January 1, 2023", 90);

    addPageNumber(doc, page);
  });
}

// 22. Customer Contract - Western Energy
function manufacturingContractWestern() {
  return writePdf("manufacturing-alberta/legal/customer-contract-western-energy.pdf", (doc) => {
    let page = 1;

    doc.font("Helvetica-Bold").fontSize(16).text("MASTER SERVICES AGREEMENT", 72, 72, { align: "center", width: 468 });
    doc.moveDown(2);
    hrThick(doc);
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(9).text("THIS MASTER SERVICES AGREEMENT (the \"Agreement\") is made effective as of March 1, 2022.", 72, doc.y, { width: 468 });
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(9).text("BETWEEN:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Precision Metal Works Inc. (hereinafter referred to as the \"Contractor\")", 90, doc.y, { width: 450 });
    doc.text("2847 Industrial Boulevard, Edmonton, Alberta T5S 1A3", 90);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(9).text("AND:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Western Energy Corp. (hereinafter referred to as the \"Company\")", 90, doc.y, { width: 450 });
    doc.text("700 - 2nd Street SW, Calgary, Alberta T2P 0S4", 90);
    doc.moveDown(1);
    hr(doc);

    legalSection(doc, 1, "SCOPE");
    legalBody(doc, "This Agreement establishes the terms and conditions under which the Contractor shall provide custom metal fabrication, machining, and assembly services to the Company on a project-by-project basis. Individual projects shall be governed by separate Purchase Orders (\"POs\") or Work Orders issued under this Agreement. There is no minimum commitment or exclusivity requirement under this Agreement.", 20);

    legalSection(doc, 2, "TERM AND RENEWAL");
    legalBody(doc, "The initial term of this Agreement is one (1) year from the effective date. This Agreement shall automatically renew for successive one (1) year terms unless either party provides sixty (60) days written notice of non-renewal prior to the expiration of the then-current term.", 20);

    legalSection(doc, 3, "PAYMENT TERMS");
    legalBody(doc, "Payment for all services and products shall be due net forty-five (45) days from the date of invoice. Invoices shall be submitted upon delivery of products or completion of services, along with all required documentation including material test reports, dimensional inspection reports, and certificates of conformance.", 20);

    legalSection(doc, 4, "INSURANCE");
    legalBody(doc, "The Contractor shall maintain, at its own expense, the following insurance coverage throughout the term of this Agreement: (a) Commercial general liability insurance of not less than Five Million Dollars ($5,000,000.00) per occurrence; (b) Environmental liability insurance of not less than Five Million Dollars ($5,000,000.00) per occurrence; (c) Automobile liability insurance of not less than Two Million Dollars ($2,000,000.00); (d) Workers' compensation coverage as required by Alberta legislation. The Company shall be named as additional insured on all policies.", 20);

    legalSection(doc, 5, "SAFETY REQUIREMENTS");
    legalBody(doc, "The Contractor shall comply with all applicable provisions of the Alberta Occupational Health and Safety Act, R.S.A. 2000, c. O-2, and all regulations thereunder. The Contractor shall maintain a Certificate of Recognition (COR) or equivalent safety certification. All personnel working on Company premises shall complete the Company's safety orientation program and shall comply with the Company's safety policies and procedures at all times.", 20);

    legalSection(doc, 6, "WORK ORDERS");
    legalBody(doc, "Each Work Order or Purchase Order issued under this Agreement shall reference this MSA and shall include: (a) a detailed scope of work; (b) specifications and drawings; (c) delivery schedule; (d) pricing; (e) any special requirements or conditions. Work shall not commence until a signed Work Order or PO is received by the Contractor.", 20);

    addPageNumber(doc, page);
    doc.addPage();
    page++;

    legalSection(doc, 7, "QUALITY");
    legalBody(doc, "All products and services shall conform to the specifications provided by the Company and shall be manufactured in accordance with the Contractor's ISO 9001:2015 quality management system. The Company reserves the right to inspect products at any stage of manufacturing and to reject products that do not meet specifications.", 20);

    legalSection(doc, 8, "CONFIDENTIALITY");
    legalBody(doc, "Each party agrees to maintain the confidentiality of all technical specifications, drawings, pricing, and business information disclosed by the other party in connection with this Agreement. This obligation shall survive the termination or expiration of this Agreement for a period of five (5) years. Both parties acknowledge that a mutual non-disclosure agreement is in effect and incorporated by reference.", 20);

    legalSection(doc, 9, "INDEMNIFICATION");
    legalBody(doc, "The Contractor shall indemnify and hold harmless the Company from any and all claims arising out of the Contractor's performance of work under this Agreement, including personal injury, property damage, and environmental contamination caused by the Contractor's acts or omissions.", 20);

    legalSection(doc, 10, "TERMINATION");
    legalBody(doc, "Either party may terminate this Agreement or any outstanding Work Order upon thirty (30) days written notice. The Company may terminate immediately in the event of a material breach by the Contractor, including failure to maintain required insurance or safety certifications.", 20);

    legalSection(doc, 11, "GOVERNING LAW");
    legalBody(doc, "This Agreement shall be governed by the laws of the Province of Alberta and the federal laws of Canada applicable therein.", 20);

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).text("IN WITNESS WHEREOF, the parties have executed this Agreement.", 72, doc.y, { width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    doc.text("CONTRACTOR: Precision Metal Works Inc.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Frank Kowalski, President", 90);
    doc.text("      Date: March 1, 2022", 90);
    doc.moveDown(1.5);
    doc.text("COMPANY: Western Energy Corp.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Authorized Signing Officer", 90);
    doc.text("      Date: March 1, 2022", 90);

    addPageNumber(doc, page);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// IT/MSP BC
// ═══════════════════════════════════════════════════════════════════════════════

// 23. MSA - Greenfield Holdings
function itMspMSAGreenfield() {
  return writePdf("it-msp-bc/legal/msa-client-greenfield-holdings.pdf", (doc) => {
    let page = 1;

    doc.font("Helvetica-Bold").fontSize(16).text("MANAGED SERVICES AGREEMENT", 72, 72, { align: "center", width: 468 });
    doc.moveDown(2);
    hrThick(doc);
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(9).text("THIS MANAGED SERVICES AGREEMENT (the \"Agreement\") is made effective as of April 1, 2023.", 72, doc.y, { width: 468 });
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(9).text("BETWEEN:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Cascadia Managed Services Inc. (hereinafter referred to as the \"Provider\")", 90, doc.y, { width: 450 });
    doc.text("1200 - 1055 West Georgia Street, Vancouver, BC V6E 3P3", 90);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(9).text("AND:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Greenfield Holdings Ltd. (hereinafter referred to as the \"Client\")", 90, doc.y, { width: 450 });
    doc.text("800 - 999 West Hastings Street, Vancouver, BC V6C 2W2", 90);
    doc.moveDown(1);
    hr(doc);

    legalSection(doc, 1, "TERM");
    legalBody(doc, "The initial term of this Agreement shall be three (3) years, commencing on April 1, 2023 and expiring on March 31, 2026.", 20);

    legalSection(doc, 2, "MONTHLY FEE");
    legalBody(doc, "The Client shall pay to the Provider a monthly managed services fee of Eight Thousand Five Hundred Dollars ($8,500.00), plus applicable GST, payable on the first day of each calendar month. This fee covers all services described in the Scope of Services below.", 20);

    legalSection(doc, 3, "SCOPE OF SERVICES");
    legalBody(doc, "The Provider shall deliver the following managed IT services to the Client:", 20);
    legalBody(doc, "(a) 24/7 Network Monitoring — Continuous monitoring of all Client network infrastructure, servers, and critical applications with automated alerting;\n(b) Unlimited Helpdesk Support — 8:00 AM to 6:00 PM PST, Monday through Friday (live technician). After-hours support for critical issues only;\n(c) Server Management — Full management of twelve (12) servers (physical and virtual), including patching, updates, performance monitoring, and capacity planning;\n(d) Backup & Disaster Recovery — Daily backup of all critical data and systems, with quarterly recovery testing. Recovery Point Objective (RPO): 4 hours. Recovery Time Objective (RTO): 8 hours;\n(e) Cybersecurity Stack — Endpoint Detection and Response (EDR), email security and anti-phishing, Security Information and Event Management (SIEM) monitoring, vulnerability scanning (monthly);\n(f) Quarterly Business Reviews — Strategic IT planning sessions with Client leadership, including budget forecasting, technology roadmap, and risk assessment.", 40);

    legalSection(doc, 4, "SERVICE LEVEL AGREEMENT (SLA)");
    legalBody(doc, "The Provider commits to the following response times:\n- Critical (business down): 4-hour response, 8-hour resolution target\n- High (major function impaired): 8-hour response, 24-hour resolution target\n- Medium (minor function impaired): 24-hour response, 72-hour resolution target\n- Low (request or enhancement): 48-hour response, best-effort resolution", 20);

    addPageNumber(doc, page);
    doc.addPage();
    page++;

    legalSection(doc, 5, "UPTIME GUARANTEE");
    legalBody(doc, "The Provider guarantees 99.9% uptime for all Provider-managed infrastructure, measured on a monthly basis. Planned maintenance windows are excluded from uptime calculations. In the event the Provider fails to meet the uptime guarantee, the Client shall receive a service credit equal to 5% of the monthly fee for each 0.1% below the guaranteed uptime, up to a maximum credit of 50% of the monthly fee.", 20);

    legalSection(doc, 6, "USERS COVERED");
    legalBody(doc, "This Agreement covers eighty-five (85) named users. Additional users may be added at a rate of $85 per user per month. Users who are removed from the Client's environment shall be removed from billing at the end of the calendar month in which notice is received.", 20);

    legalSection(doc, 7, "TERMINATION");
    legalBody(doc, "Either party may terminate this Agreement upon ninety (90) days written notice to the other party. In the event of termination, the Provider shall cooperate in good faith with the Client or a successor provider to ensure an orderly transition of all services and data.", 20);

    legalSection(doc, 8, "DATA OWNERSHIP AND TRANSITION");
    legalBody(doc, "All Client data processed, stored, or managed by the Provider remains the sole property of the Client at all times. Upon termination, the Provider shall: (a) provide the Client with a complete export of all data in standard, usable formats within thirty (30) days; (b) provide transition assistance for up to thirty (30) days at no additional charge; (c) securely delete all Client data from Provider systems within sixty (60) days of the transition completion, and provide written certification of deletion.", 20);

    legalSection(doc, 9, "CONFIDENTIALITY");
    legalBody(doc, "Each party agrees to maintain the confidentiality of all information disclosed by the other party, including business strategies, financial data, technical systems, and personal information of employees. The Provider shall comply with all applicable privacy legislation, including PIPEDA (Personal Information Protection and Electronic Documents Act) and PIPA (British Columbia).", 20);

    legalSection(doc, 10, "LIABILITY");
    legalBody(doc, "The Provider's total aggregate liability under this Agreement shall not exceed twelve (12) months of fees paid by the Client. Neither party shall be liable for indirect, consequential, or punitive damages.", 20);

    legalSection(doc, 11, "GOVERNING LAW");
    legalBody(doc, "This Agreement shall be governed by the laws of the Province of British Columbia and the federal laws of Canada applicable therein.", 20);

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).text("IN WITNESS WHEREOF, the parties have executed this Agreement.", 72, doc.y, { width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    doc.text("PROVIDER: Cascadia Managed Services Inc.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      David Ng, President", 90);
    doc.text("      Date: April 1, 2023", 90);
    doc.moveDown(1.5);
    doc.text("CLIENT: Greenfield Holdings Ltd.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Authorized Signing Officer", 90);
    doc.text("      Date: April 1, 2023", 90);

    addPageNumber(doc, page);
  });
}

// 24. MSA - Pacific Dental
function itMspMSAPacificDental() {
  return writePdf("it-msp-bc/legal/msa-client-pacific-dental.pdf", (doc) => {
    let page = 1;

    doc.font("Helvetica-Bold").fontSize(16).text("MANAGED SERVICES AGREEMENT", 72, 72, { align: "center", width: 468 });
    doc.font("Helvetica").fontSize(10).text("(Healthcare / Dental Practice)", { align: "center", width: 468 });
    doc.moveDown(2);
    hrThick(doc);
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(9).text("THIS MANAGED SERVICES AGREEMENT (the \"Agreement\") is made effective as of September 1, 2023.", 72, doc.y, { width: 468 });
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(9).text("BETWEEN:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Cascadia Managed Services Inc. (hereinafter referred to as the \"Provider\")", 90, doc.y, { width: 450 });
    doc.text("1200 - 1055 West Georgia Street, Vancouver, BC V6E 3P3", 90);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(9).text("AND:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Pacific Dental Group (hereinafter referred to as the \"Client\")", 90, doc.y, { width: 450 });
    doc.text("5 locations across Greater Vancouver", 90);
    doc.text("Head Office: 450 West Broadway, Vancouver, BC V5Y 1R3", 90);
    doc.moveDown(1);
    hr(doc);

    legalSection(doc, 1, "TERM");
    legalBody(doc, "The initial term of this Agreement shall be two (2) years, commencing on September 1, 2023 and expiring on August 31, 2025.", 20);

    legalSection(doc, 2, "MONTHLY FEE");
    legalBody(doc, "The Client shall pay to the Provider a monthly managed services fee of Four Thousand Two Hundred Dollars ($4,200.00), plus applicable GST, payable on the first day of each calendar month. This fee is subject to annual adjustment based on the Consumer Price Index (CPI) for Vancouver, BC.", 20);

    legalSection(doc, 3, "SCOPE OF SERVICES");
    legalBody(doc, "The Provider shall deliver the following managed IT services across all five (5) Client locations:", 20);
    legalBody(doc, "(a) PIPEDA/HIPAA-Compliant Hosting — All patient data stored in Canadian data centres with encryption at rest and in transit;\n(b) Dental Practice Management System Support — Full support for Dentrix/ABELDent or equivalent dental PMS, including updates, troubleshooting, and optimization;\n(c) Imaging System Management — Support for digital X-ray, panoramic, and intraoral camera systems, including DICOM integration;\n(d) Backup & Disaster Recovery — Daily encrypted backup of all patient records, images, and practice data;\n(e) Cybersecurity — EDR, email filtering, web content filtering, and monthly vulnerability assessments;\n(f) Multi-Location Networking — Site-to-site VPN connectivity, centralized management console.", 40);

    legalSection(doc, 4, "LOCATIONS AND USERS");
    legalBody(doc, "This Agreement covers five (5) dental practice locations and approximately forty-five (45) total users across all sites. Additional locations may be added at a negotiated per-location rate.", 20);

    legalSection(doc, 5, "TERMINATION");
    legalBody(doc, "Either party may terminate this Agreement upon sixty (60) days written notice.", 20);

    legalSection(doc, 6, "DATA AND PRIVACY");
    legalBody(doc, "The Provider acknowledges the sensitive nature of patient dental records and shall comply with all applicable privacy legislation, including PIPEDA and PIPA (BC). All data remains the exclusive property of the Client. The Provider shall not access patient records except as necessary for the provision of technical support.", 20);

    addPageNumber(doc, page);
    doc.addPage();
    page++;

    legalSection(doc, 7, "GOVERNING LAW");
    legalBody(doc, "This Agreement shall be governed by the laws of the Province of British Columbia.", 20);

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).text("IN WITNESS WHEREOF, the parties have executed this Agreement.", 72, doc.y, { width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    doc.text("PROVIDER: Cascadia Managed Services Inc.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      David Ng, President", 90);
    doc.text("      Date: September 1, 2023", 90);
    doc.moveDown(1.5);
    doc.text("CLIENT: Pacific Dental Group", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Authorized Signing Officer", 90);
    doc.text("      Date: September 1, 2023", 90);

    addPageNumber(doc, page);
  });
}

// 25. MSA - Summit Law
function itMspMSASummitLaw() {
  return writePdf("it-msp-bc/legal/msa-client-summit-law.pdf", (doc) => {
    let page = 1;

    doc.font("Helvetica-Bold").fontSize(16).text("MANAGED SERVICES AGREEMENT", 72, 72, { align: "center", width: 468 });
    doc.font("Helvetica").fontSize(10).text("(Legal Practice)", { align: "center", width: 468 });
    doc.moveDown(2);
    hrThick(doc);
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(9).text("THIS MANAGED SERVICES AGREEMENT (the \"Agreement\") is made effective as of January 1, 2024.", 72, doc.y, { width: 468 });
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(9).text("BETWEEN:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Cascadia Managed Services Inc. (hereinafter referred to as the \"Provider\")", 90, doc.y, { width: 450 });
    doc.text("1200 - 1055 West Georgia Street, Vancouver, BC V6E 3P3", 90);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(9).text("AND:", 72);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9);
    doc.text("Summit Law LLP (hereinafter referred to as the \"Firm\")", 90, doc.y, { width: 450 });
    doc.text("1500 - 700 West Pender Street, Vancouver, BC V6C 1G8", 90);
    doc.moveDown(1);
    hr(doc);

    legalSection(doc, 1, "TERM AND RENEWAL");
    legalBody(doc, "The initial term of this Agreement shall be one (1) year, commencing on January 1, 2024 and expiring on December 31, 2024. This Agreement shall automatically renew for successive one (1) year terms unless either party provides sixty (60) days written notice of non-renewal.", 20);

    legalSection(doc, 2, "MONTHLY FEE");
    legalBody(doc, "The Firm shall pay to the Provider a monthly managed services fee of Three Thousand Eight Hundred Dollars ($3,800.00), plus applicable GST, payable on the first day of each calendar month.", 20);

    legalSection(doc, 3, "SCOPE OF SERVICES");
    legalBody(doc, "The Provider shall deliver the following managed IT services to the Firm:", 20);
    legalBody(doc, "(a) Full IT Management — All hardware, software, networking, and infrastructure management for the Firm's office;\n(b) Document Management System (DMS) — Full support for iManage, including upgrades, user management, workspace configuration, and integration with Microsoft 365;\n(c) E-Discovery Support — Technical support for e-discovery processes, including data collection, processing, and export in standard review formats (EDRM, Relativity-compatible);\n(d) Cybersecurity Compliance — Implementation and maintenance of security controls in accordance with Law Society of British Columbia requirements, including multi-factor authentication, encrypted email, data loss prevention, and privilege-aware access controls;\n(e) Encrypted Email — S/MIME or TLS-enforced email encryption for all external communications containing privileged information;\n(f) Backup — Daily encrypted backup with 90-day retention; litigation hold capability for extended preservation.", 40);

    legalSection(doc, 4, "SLA — CRITICAL RESPONSE");
    legalBody(doc, "The Provider commits to a two (2) hour response time for critical issues affecting litigation deadlines, court filings, or client-facing deliverables. The Provider understands the time-sensitive nature of legal practice and shall prioritize the Firm's critical tickets accordingly.", 20);

    legalSection(doc, 5, "USERS");
    legalBody(doc, "This Agreement covers twenty-eight (28) named users, including partners, associates, law clerks, paralegals, and administrative staff.", 20);

    addPageNumber(doc, page);
    doc.addPage();
    page++;

    legalSection(doc, 6, "ENHANCED CONFIDENTIALITY");
    legalBody(doc, "The Provider acknowledges the unique and heightened confidentiality obligations of the Firm arising from solicitor-client privilege. The Provider agrees that: (a) all information accessed in the course of providing services is potentially subject to solicitor-client privilege; (b) the Provider shall not access, copy, review, or disclose any document content except as strictly necessary for the provision of technical support; (c) all Provider personnel with access to the Firm's systems shall execute individual confidentiality agreements; (d) the Provider shall immediately notify the Firm if it receives any legal process (subpoena, court order, or similar) seeking access to the Firm's data.", 20);

    legalSection(doc, 7, "DATA RESIDENCY");
    legalBody(doc, "All Firm data shall be stored exclusively in Canadian data centres. No Firm data shall be transferred to or processed in any jurisdiction outside of Canada without the prior written consent of the Firm.", 20);

    legalSection(doc, 8, "TERMINATION");
    legalBody(doc, "Either party may terminate this Agreement upon sixty (60) days written notice. Upon termination, the Provider shall provide full transition assistance and data export within thirty (30) days.", 20);

    legalSection(doc, 9, "GOVERNING LAW");
    legalBody(doc, "This Agreement shall be governed by the laws of the Province of British Columbia.", 20);

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).text("IN WITNESS WHEREOF, the parties have executed this Agreement.", 72, doc.y, { width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    doc.text("PROVIDER: Cascadia Managed Services Inc.", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      David Ng, President", 90);
    doc.text("      Date: January 1, 2024", 90);
    doc.moveDown(1.5);
    doc.text("FIRM: Summit Law LLP", 72);
    doc.moveDown(1.5);
    doc.text("Per: ________________________________", 72);
    doc.text("      Managing Partner", 90);
    doc.text("      Date: January 1, 2024", 90);

    addPageNumber(doc, page);
  });
}

// 26. Vendor Partnership Certificates (multi-page)
function itMspVendorCertificates() {
  return writePdf("it-msp-bc/compliance/vendor-partnership-certificates.pdf", (doc) => {
    // ─── Page 1: Microsoft ───
    doc.rect(52, 52, 508, 688).strokeColor("#0078D4").lineWidth(2).stroke();
    doc.moveDown(3);

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#0078D4").text("Microsoft", { align: "center", width: 468 });
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#333333").text("Solutions Partner Designation", { align: "center", width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(10).fillColor("#000000").text("This certifies that", { align: "center", width: 468 });
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(16).text("Cascadia Managed Services Inc.", { align: "center", width: 468 });
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(10).text("has achieved the following Microsoft Solutions Partner designations:", { align: "center", width: 468 });
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0078D4");
    doc.text("Modern Work", { align: "center", width: 468 });
    doc.text("Security", { align: "center", width: 468 });
    doc.fillColor("#000000");
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    const msLeft = 180;
    const msRight = 310;
    let y = doc.y;
    doc.text("Partner ID:", msLeft, y); doc.text("4567890", msRight, y); y += 16;
    doc.text("Partner Since:", msLeft, y); doc.text("2018", msRight, y); y += 16;
    doc.text("Valid Through:", msLeft, y); doc.text("December 31, 2025", msRight, y); y += 16;
    doc.text("Partner Level:", msLeft, y); doc.text("Solutions Partner", msRight, y);

    addPageNumber(doc, 1);

    // ─── Page 2: Datto ───
    doc.addPage();
    doc.rect(52, 52, 508, 688).strokeColor("#00B140").lineWidth(2).stroke();
    doc.moveDown(3);

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#00B140").text("Datto", { align: "center", width: 468 });
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#333333").text("Platinum Partner Certificate", { align: "center", width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(10).fillColor("#000000").text("This is to certify that", { align: "center", width: 468 });
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(16).text("Cascadia Managed Services Inc.", { align: "center", width: 468 });
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(10).text("has achieved Datto Platinum Partner status as an authorized reseller\nand managed service provider of the Datto platform.", { align: "center", width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    y = doc.y;
    doc.text("Partner Tier:", msLeft, y); doc.text("Platinum", msRight, y); y += 16;
    doc.text("Managed Endpoints:", msLeft, y); doc.text("50+", msRight, y); y += 16;
    doc.text("Products:", msLeft, y); doc.text("SIRIS, ALTO, Networking", msRight, y); y += 16;
    doc.text("Certified Engineers:", msLeft, y); doc.text("3", msRight, y);

    addPageNumber(doc, 2);

    // ─── Page 3: ConnectWise ───
    doc.addPage();
    doc.rect(52, 52, 508, 688).strokeColor("#FF6B00").lineWidth(2).stroke();
    doc.moveDown(3);

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#FF6B00").text("ConnectWise", { align: "center", width: 468 });
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#333333").text("Certified Partner", { align: "center", width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(10).fillColor("#000000").text("This certifies that", { align: "center", width: 468 });
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(16).text("Cascadia Managed Services Inc.", { align: "center", width: 468 });
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(10).text("is a ConnectWise Certified Partner with demonstrated proficiency in\nPSA (Professional Services Automation) and RMM (Remote Monitoring & Management)\nplatform implementation and utilization.", { align: "center", width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    y = doc.y;
    doc.text("Products:", msLeft, y); doc.text("Manage (PSA), Automate (RMM)", msRight, y); y += 16;
    doc.text("Certification:", msLeft, y); doc.text("Certified Implementation", msRight, y); y += 16;
    doc.text("Partner Since:", msLeft, y); doc.text("2019", msRight, y);

    addPageNumber(doc, 3);

    // ─── Page 4: Acronis ───
    doc.addPage();
    doc.rect(52, 52, 508, 688).strokeColor("#0054A6").lineWidth(2).stroke();
    doc.moveDown(3);

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#0054A6").text("Acronis", { align: "center", width: 468 });
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#333333").text("Gold Service Provider Certificate", { align: "center", width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(10).fillColor("#000000").text("This certifies that", { align: "center", width: 468 });
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(16).text("Cascadia Managed Services Inc.", { align: "center", width: 468 });
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(10).text("has been designated as an Acronis Gold Service Provider\nwith certified expertise in Acronis Cyber Protect Cloud.", { align: "center", width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    y = doc.y;
    doc.text("Partner Tier:", msLeft, y); doc.text("Gold", msRight, y); y += 16;
    doc.text("Certification:", msLeft, y); doc.text("Cloud Backup Certified", msRight, y); y += 16;
    doc.text("Protected Workloads:", msLeft, y); doc.text("200+", msRight, y); y += 16;
    doc.text("Data Centre:", msLeft, y); doc.text("Canadian (ca-west-1)", msRight, y);

    addPageNumber(doc, 4);

    // ─── Page 5: SentinelOne ───
    doc.addPage();
    doc.rect(52, 52, 508, 688).strokeColor("#6C2BD9").lineWidth(2).stroke();
    doc.moveDown(3);

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#6C2BD9").text("SentinelOne", { align: "center", width: 468 });
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#333333").text("Authorized Reseller Certificate", { align: "center", width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(10).fillColor("#000000").text("This certifies that", { align: "center", width: 468 });
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(16).text("Cascadia Managed Services Inc.", { align: "center", width: 468 });
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(10).text("is an authorized reseller and deployment partner for the\nSentinelOne Singularity platform, including Singularity Complete\nand Singularity Control modules.", { align: "center", width: 468 });
    doc.moveDown(2);

    doc.font("Helvetica").fontSize(9);
    y = doc.y;
    doc.text("Authorization:", msLeft, y); doc.text("Authorized Reseller", msRight, y); y += 16;
    doc.text("Platform:", msLeft, y); doc.text("Singularity (Complete + Control)", msRight, y); y += 16;
    doc.text("Certified Engineers:", msLeft, y); doc.text("2", msRight, y); y += 16;
    doc.text("Managed Endpoints:", msLeft, y); doc.text("350+", msRight, y);

    addPageNumber(doc, 5);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("Generating PDF test data...\n");

  console.log("--- Construction Ontario ---");
  await constructionT2_2023();
  await constructionT2_2024();
  await constructionBankJan2025();
  await constructionBankFeb2025();
  await constructionBankMar2025();
  await constructionLease();
  await constructionWSIB();
  await constructionSubcontractorAgreement();

  console.log("\n--- Restaurant Toronto ---");
  await restaurantT2_2023();
  await restaurantT2_2024();
  await restaurantBankJan2025();
  await restaurantBankFeb2025();
  await restaurantBankMar2025();
  await restaurantLease();
  await restaurantHealthInspection2023();
  await restaurantHealthInspection2024();

  console.log("\n--- Medical Clinic Ontario ---");
  await medicalPhysicianAgreement();
  await medicalEMRDocumentation();
  await medicalOfficeLease();

  console.log("\n--- Manufacturing Alberta ---");
  await manufacturingISO();
  await manufacturingContractApex();
  await manufacturingContractWestern();

  console.log("\n--- IT/MSP BC ---");
  await itMspMSAGreenfield();
  await itMspMSAPacificDental();
  await itMspMSASummitLaw();
  await itMspVendorCertificates();

  console.log("\nDone. All 26 PDF files generated.");
}

main().catch(console.error);
