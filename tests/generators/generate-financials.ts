/**
 * generate-financials.ts
 *
 * Generates realistic XLSX financial documents for 5 fake businesses.
 * Run: npx tsx tests/generators/generate-financials.ts
 */

import XLSX from "xlsx";
import fs from "fs";
import path from "path";

const BASE = path.resolve(import.meta.dirname, "../test-data");

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Row = (string | number | null)[];

function fmt(n: number): number {
  return Math.round(n);
}

interface SheetDef {
  name: string;
  data: Row[];
  colWidths: number[];
}

function buildWorkbook(sheets: SheetDef[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  for (const { name, data, colWidths } of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(data);

    // Column widths
    ws["!cols"] = colWidths.map((w) => ({ wch: w }));

    // Bold rows: scan for markers in first column
    // We can't truly bold in xlsx-ce without styles, but we use UPPER CASE
    // and "---" separators to visually group things. The data itself carries
    // the formatting cues via naming conventions (ALL-CAPS headers, indented
    // line items).

    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return wb;
}

function writeWorkbook(wb: XLSX.WorkBook, relPath: string) {
  const full = path.join(BASE, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  XLSX.writeFile(wb, full);
  console.log(`  -> ${relPath}`);
}

// ─── 1. Construction — Amlin Contracting Ltd. ────────────────────────────────

function constructionIncomeStatement(): SheetDef {
  const years = [2022, 2023, 2024];
  const revenue = [2_800_000, 3_000_000, 3_200_000];
  const materials = [980_000, 1_020_000, 1_090_000];
  const subcontractors = [520_000, 560_000, 590_000];
  const directLabour = [400_000, 420_000, 450_000];

  const ownerSalary = [180_000, 180_000, 180_000];
  const officeSalaries = [165_000, 175_000, 185_000];
  const vehicle = [38_000, 40_000, 42_000];
  const insurance = [48_000, 52_000, 55_000];
  const rent = [57_600, 57_600, 57_600];
  const utilities = [18_000, 18_000, 18_000];
  const officeSupplies = [12_000, 12_000, 12_000];
  const professionalFees = [15_000, 18_000, 20_000];
  const marketing = [8_000, 10_000, 12_000];
  const depreciation = [45_000, 48_000, 52_000];
  const phoneInternet = [9_000, 9_000, 9_000];
  const legalFee = [0, 35_000, 0];
  const bonding = [14_000, 18_000, 22_000];
  const workersComp = [24_000, 35_000, 42_000];
  const smallTools = [10_000, 14_000, 18_000];
  const fuelEquipment = [12_000, 20_000, 26_000];
  const wasteDisposal = [5_400, 9_400, 12_000];
  const safetyTraining = [5_000, 9_000, 11_000];
  const permits = [3_000, 6_000, 8_200];
  const warranty = [0, 36_000, 55_200];
  const misc = [11_000, 13_000, 18_000];

  const data: Row[] = [
    ["AMLIN CONTRACTING LTD.", null, null, null],
    ["Income Statement", null, null, null],
    ["For the Years Ended December 31", null, null, null],
    [],
    [null, ...years],
    [],
    ["REVENUE", null, null, null],
    ["  Contract Revenue", ...revenue],
    ["TOTAL REVENUE", ...revenue],
    [],
    ["COST OF GOODS SOLD", null, null, null],
    ["  Materials", ...materials],
    ["  Subcontractors", ...subcontractors],
    ["  Direct Labour", ...directLabour],
  ];

  const totalCOGS = years.map(
    (_, i) => materials[i] + subcontractors[i] + directLabour[i]
  );
  const grossProfit = years.map((_, i) => revenue[i] - totalCOGS[i]);

  data.push(["TOTAL COST OF GOODS SOLD", ...totalCOGS]);
  data.push([]);
  data.push(["GROSS PROFIT", ...grossProfit]);
  data.push([
    "  Gross Margin %",
    ...years.map((_, i) =>
      `${((grossProfit[i] / revenue[i]) * 100).toFixed(1)}%`
    ),
  ]);
  data.push([]);
  data.push(["OPERATING EXPENSES", null, null, null]);
  data.push(["  Owner's Salary", ...ownerSalary]);
  data.push(["  Office Salaries & Wages", ...officeSalaries]);
  data.push(["  Vehicle Expenses", ...vehicle]);
  data.push(["  Insurance", ...insurance]);
  data.push(["  Rent", ...rent]);
  data.push(["  Utilities", ...utilities]);
  data.push(["  Office Supplies", ...officeSupplies]);
  data.push(["  Professional Fees", ...professionalFees]);
  data.push(["  Marketing & Advertising", ...marketing]);
  data.push(["  Depreciation", ...depreciation]);
  data.push(["  Phone & Internet", ...phoneInternet]);
  data.push(["  Legal Fees (One-Time)", ...legalFee]);
  data.push(["  Bonding & Surety", ...bonding]);
  data.push(["  Workers' Compensation", ...workersComp]);
  data.push(["  Small Tools & Consumables", ...smallTools]);
  data.push(["  Fuel & Equipment Operating", ...fuelEquipment]);
  data.push(["  Waste Disposal", ...wasteDisposal]);
  data.push(["  Safety Training & Compliance", ...safetyTraining]);
  data.push(["  Permits & Licensing", ...permits]);
  data.push(["  Warranty Reserve / Callbacks", ...warranty]);
  data.push(["  Miscellaneous", ...misc]);

  const totalOpEx = years.map(
    (_, i) =>
      ownerSalary[i] +
      officeSalaries[i] +
      vehicle[i] +
      insurance[i] +
      rent[i] +
      utilities[i] +
      officeSupplies[i] +
      professionalFees[i] +
      marketing[i] +
      depreciation[i] +
      phoneInternet[i] +
      legalFee[i] +
      bonding[i] +
      workersComp[i] +
      smallTools[i] +
      fuelEquipment[i] +
      wasteDisposal[i] +
      safetyTraining[i] +
      permits[i] +
      warranty[i] +
      misc[i]
  );
  const netIncome = years.map((_, i) => grossProfit[i] - totalOpEx[i]);

  data.push([]);
  data.push(["TOTAL OPERATING EXPENSES", ...totalOpEx]);
  data.push([]);
  data.push(["NET INCOME BEFORE TAX", ...netIncome]);

  return { name: "Income Statement", data, colWidths: [36, 16, 16, 16] };
}

function constructionBalanceSheet(): SheetDef {
  const years = [2022, 2023, 2024];

  // Assets
  const cash = [85_000, 110_000, 140_000];
  const ar = [320_000, 350_000, 380_000];
  const wip = [180_000, 200_000, 220_000];
  const prepaid = [15_000, 15_000, 15_000];

  const equipGross = [520_000, 560_000, 620_000];
  const equipAccumDep = [180_000, 228_000, 280_000];
  const vehicleGross = [210_000, 210_000, 250_000];
  const vehicleAccumDep = [90_000, 120_000, 140_000];

  const equipNet = years.map((_, i) => equipGross[i] - equipAccumDep[i]);
  const vehicleNet = years.map((_, i) => vehicleGross[i] - vehicleAccumDep[i]);
  const totalCurrentAssets = years.map(
    (_, i) => cash[i] + ar[i] + wip[i] + prepaid[i]
  );
  const totalFixedAssets = years.map((_, i) => equipNet[i] + vehicleNet[i]);
  const totalAssets = years.map(
    (_, i) => totalCurrentAssets[i] + totalFixedAssets[i]
  );

  // Liabilities
  const ap = [190_000, 210_000, 230_000];
  const accrued = [45_000, 45_000, 45_000];
  const loc = [120_000, 100_000, 150_000];
  const equipLoans = [85_000, 60_000, 95_000];
  const shareholderLoan = [50_000, 40_000, 30_000];

  const totalCurrentLiab = years.map((_, i) => ap[i] + accrued[i]);
  const totalLongTermLiab = years.map(
    (_, i) => loc[i] + equipLoans[i] + shareholderLoan[i]
  );
  const totalLiabilities = years.map(
    (_, i) => totalCurrentLiab[i] + totalLongTermLiab[i]
  );

  // Equity
  const shareCapital = 100;
  const retainedEarnings = years.map(
    (_, i) => totalAssets[i] - totalLiabilities[i] - shareCapital
  );
  const totalEquity = years.map((_, i) => shareCapital + retainedEarnings[i]);
  const totalLiabAndEquity = years.map(
    (_, i) => totalLiabilities[i] + totalEquity[i]
  );

  const data: Row[] = [
    ["AMLIN CONTRACTING LTD.", null, null, null],
    ["Balance Sheet", null, null, null],
    ["As at December 31", null, null, null],
    [],
    [null, ...years],
    [],
    ["ASSETS", null, null, null],
    [],
    ["Current Assets", null, null, null],
    ["  Cash & Equivalents", ...cash],
    ["  Accounts Receivable", ...ar],
    ["  Work in Progress", ...wip],
    ["  Prepaid Expenses", ...prepaid],
    ["TOTAL CURRENT ASSETS", ...totalCurrentAssets],
    [],
    ["Fixed Assets", null, null, null],
    ["  Equipment (Gross)", ...equipGross],
    ["  Less: Accumulated Depreciation", ...equipAccumDep.map((v) => -v)],
    ["  Equipment (Net)", ...equipNet],
    [],
    ["  Vehicles (Gross)", ...vehicleGross],
    ["  Less: Accumulated Depreciation", ...vehicleAccumDep.map((v) => -v)],
    ["  Vehicles (Net)", ...vehicleNet],
    [],
    ["TOTAL FIXED ASSETS", ...totalFixedAssets],
    [],
    ["TOTAL ASSETS", ...totalAssets],
    [],
    [],
    ["LIABILITIES", null, null, null],
    [],
    ["Current Liabilities", null, null, null],
    ["  Accounts Payable", ...ap],
    ["  Accrued Liabilities", ...accrued],
    ["TOTAL CURRENT LIABILITIES", ...totalCurrentLiab],
    [],
    ["Long-Term Liabilities", null, null, null],
    ["  Line of Credit", ...loc],
    ["  Equipment Loans", ...equipLoans],
    ["  Shareholder Loan", ...shareholderLoan],
    ["TOTAL LONG-TERM LIABILITIES", ...totalLongTermLiab],
    [],
    ["TOTAL LIABILITIES", ...totalLiabilities],
    [],
    [],
    ["SHAREHOLDERS' EQUITY", null, null, null],
    ["  Share Capital", shareCapital, shareCapital, shareCapital],
    ["  Retained Earnings", ...retainedEarnings],
    ["TOTAL SHAREHOLDERS' EQUITY", ...totalEquity],
    [],
    ["TOTAL LIABILITIES & EQUITY", ...totalLiabAndEquity],
  ];

  return { name: "Balance Sheet", data, colWidths: [36, 16, 16, 16] };
}

function generateConstruction() {
  console.log("\n1. Amlin Contracting Ltd. (Construction - Ontario)");

  const isSheet = constructionIncomeStatement();
  const bsSheet = constructionBalanceSheet();

  const isWb = buildWorkbook([isSheet]);
  writeWorkbook(
    isWb,
    "construction-ontario/financials/income-statements-2022-2024.xlsx"
  );

  const bsWb = buildWorkbook([bsSheet]);
  writeWorkbook(
    bsWb,
    "construction-ontario/financials/balance-sheets-2022-2024.xlsx"
  );
}

// ─── 2. Restaurant — Terrazza Kitchen & Bar ──────────────────────────────────

function restaurantIncomeStatement(): SheetDef {
  const years = [2022, 2023, 2024];
  const totalRevenue = [1_600_000, 1_750_000, 1_850_000];

  // Food vs beverage split: beverage ~30% of total
  const beverageRevenue = totalRevenue.map((r) => fmt(r * 0.3));
  const foodRevenue = totalRevenue.map((r, i) => r - beverageRevenue[i]);

  // COGS
  const foodCostPct = [0.31, 0.29, 0.30];
  const bevCostPct = [0.22, 0.21, 0.22];
  const foodCost = foodRevenue.map((r, i) => fmt(r * foodCostPct[i]));
  const bevCost = beverageRevenue.map((r, i) => fmt(r * bevCostPct[i]));
  const totalCOGS = years.map((_, i) => foodCost[i] + bevCost[i]);
  const grossProfit = years.map((_, i) => totalRevenue[i] - totalCOGS[i]);

  // Labour
  const labourPct = [0.33, 0.34, 0.32];
  const labour = totalRevenue.map((r, i) => fmt(r * labourPct[i]));

  // Occupancy
  const rent = [86_400, 86_400, 86_400]; // $7,200/mo
  const cam = [18_000, 18_600, 19_200];

  // Other operating
  const supplies = [28_000, 28_000, 28_000];
  const marketing = [18_000, 22_000, 25_000];
  const insurance = [15_000, 15_000, 15_000];
  const utilities = [36_000, 36_000, 36_000];
  const professionalFees = [8_000, 8_000, 8_000];
  const repairs = [12_000, 15_000, 10_000];
  const entertainment = [25_000, 30_000, 30_000];
  const posTech = [6_000, 6_000, 6_000];
  const musicLicensing = [4_000, 4_000, 4_000];
  const depreciation = [22_000, 22_000, 22_000];
  const ownerDraws = [85_000, 90_000, 95_000];
  const linen = [9_600, 10_200, 10_800];
  const creditCardFees = [44_800, 50_750, 55_250];
  const deliveryApps = [24_000, 30_000, 38_000];
  const cleaning = [14_400, 15_600, 16_800];
  const liquorLicensing = [3_200, 3_200, 3_200];
  const staffMeals = [14_000, 15_500, 16_500];
  const pestControl = [2_400, 2_400, 2_400];
  const wasteMgmt = [4_800, 5_400, 5_400];
  const smallwares = [7_000, 8_000, 8_000];
  const healthInspection = [0, 8_450, 0];
  const renoCapex = [4_000, 36_000, 42_050];

  const totalOpEx = years.map(
    (_, i) =>
      labour[i] +
      rent[i] +
      cam[i] +
      supplies[i] +
      marketing[i] +
      insurance[i] +
      utilities[i] +
      professionalFees[i] +
      repairs[i] +
      entertainment[i] +
      posTech[i] +
      musicLicensing[i] +
      depreciation[i] +
      ownerDraws[i] +
      linen[i] +
      creditCardFees[i] +
      deliveryApps[i] +
      cleaning[i] +
      liquorLicensing[i] +
      staffMeals[i] +
      pestControl[i] +
      wasteMgmt[i] +
      smallwares[i] +
      healthInspection[i] +
      renoCapex[i]
  );
  const netIncome = years.map((_, i) => grossProfit[i] - totalOpEx[i]);

  const data: Row[] = [
    ["TERRAZZA KITCHEN & BAR", null, null, null],
    ["Income Statement", null, null, null],
    ["For the Years Ended December 31", null, null, null],
    [],
    [null, ...years],
    [],
    ["REVENUE", null, null, null],
    ["  Food Revenue", ...foodRevenue],
    ["  Beverage Revenue", ...beverageRevenue],
    ["TOTAL REVENUE", ...totalRevenue],
    [],
    ["COST OF GOODS SOLD", null, null, null],
    ["  Food Costs", ...foodCost],
    [
      "    Food Cost %",
      ...years.map((_, i) => `${(foodCostPct[i] * 100).toFixed(1)}%`),
    ],
    ["  Beverage Costs", ...bevCost],
    [
      "    Beverage Cost %",
      ...years.map((_, i) => `${(bevCostPct[i] * 100).toFixed(1)}%`),
    ],
    ["TOTAL COST OF GOODS SOLD", ...totalCOGS],
    [],
    ["GROSS PROFIT", ...grossProfit],
    [
      "  Gross Margin %",
      ...years.map((_, i) =>
        `${((grossProfit[i] / totalRevenue[i]) * 100).toFixed(1)}%`
      ),
    ],
    [],
    ["OPERATING EXPENSES", null, null, null],
    ["  Labour (All Staff)", ...labour],
    [
      "    Labour %",
      ...years.map((_, i) => `${(labourPct[i] * 100).toFixed(1)}%`),
    ],
    ["  Owner Draws / Salary", ...ownerDraws],
    ["  Rent", ...rent],
    ["  Common Area Maintenance (CAM)", ...cam],
    ["  Credit Card Processing Fees", ...creditCardFees],
    ["  Delivery App Commissions", ...deliveryApps],
    ["  Supplies", ...supplies],
    ["  Marketing & Advertising", ...marketing],
    ["  Insurance", ...insurance],
    ["  Utilities", ...utilities],
    ["  Professional Fees", ...professionalFees],
    ["  Repairs & Maintenance", ...repairs],
    ["  Entertainment & Meals (Owner)", ...entertainment],
    ["  Linen & Laundry Service", ...linen],
    ["  Cleaning & Janitorial", ...cleaning],
    ["  Staff Meals", ...staffMeals],
    ["  Smallwares Replacement", ...smallwares],
    ["  POS / Technology", ...posTech],
    ["  Music & Licensing", ...musicLicensing],
    ["  Liquor Licensing & Fees", ...liquorLicensing],
    ["  Pest Control", ...pestControl],
    ["  Waste Management", ...wasteMgmt],
    ["  Health Inspection Remediation", ...healthInspection],
    ["  Renovation / Leasehold Improvements", ...renoCapex],
    ["  Depreciation", ...depreciation],
    [],
    ["TOTAL OPERATING EXPENSES", ...totalOpEx],
    [],
    ["NET INCOME BEFORE TAX", ...netIncome],
  ];

  return { name: "Income Statement", data, colWidths: [36, 16, 16, 16] };
}

function generateRestaurant() {
  console.log("\n2. Terrazza Kitchen & Bar (Restaurant - Toronto)");
  const wb = buildWorkbook([restaurantIncomeStatement()]);
  writeWorkbook(
    wb,
    "restaurant-toronto/financials/income-statements-2022-2024.xlsx"
  );
}

// ─── 3. Medical Clinic — Bayview Family Health Centre ─────────────────────────

function medicalIncomeStatement(): SheetDef {
  const years = [2022, 2023, 2024];
  const totalRevenue = [2_100_000, 2_300_000, 2_500_000];

  // Revenue breakdown: OHIP 72%, Private 28%
  const ohipRevenue = [1_512_000, 1_656_000, 1_800_000];
  const privateRevenue = years.map((_, i) => totalRevenue[i] - ohipRevenue[i]);

  // Physician compensation (fee-split model: 70% to physicians, 30% to clinic)
  const physicianComp = [945_000, 1_035_000, 1_125_000];

  // Owner physician retained (from 30% clinic share + management fee)
  const ownerRetained = [320_000, 345_000, 380_000];

  // Staff
  const staffSalaries = [231_000, 253_000, 275_000];

  // Operating
  const rent = [78_000, 78_000, 78_000]; // $6,500/mo
  const medicalSupplies = [105_000, 115_000, 125_000];
  const emrTech = [18_000, 20_000, 22_000];
  const insurance = [35_000, 38_000, 40_000];
  const professionalFees = [12_000, 14_000, 15_000];
  const otherOperating = [45_000, 48_000, 52_000];

  const totalExpenses = years.map(
    (_, i) =>
      physicianComp[i] +
      ownerRetained[i] +
      staffSalaries[i] +
      rent[i] +
      medicalSupplies[i] +
      emrTech[i] +
      insurance[i] +
      professionalFees[i] +
      otherOperating[i]
  );
  const netIncome = years.map((_, i) => totalRevenue[i] - totalExpenses[i]);

  const data: Row[] = [
    ["BAYVIEW FAMILY HEALTH CENTRE", null, null, null],
    ["Income Statement", null, null, null],
    ["For the Years Ended December 31", null, null, null],
    [],
    [null, ...years],
    [],
    ["REVENUE", null, null, null],
    ["  OHIP Billing", ...ohipRevenue],
    ["  Private Billing", ...privateRevenue],
    ["TOTAL REVENUE", ...totalRevenue],
    [
      "  OHIP %",
      ...years.map((_, i) =>
        `${((ohipRevenue[i] / totalRevenue[i]) * 100).toFixed(1)}%`
      ),
    ],
    [],
    ["PHYSICIAN COMPENSATION", null, null, null],
    [
      "  Associate Physicians (70/30 fee-split)",
      ...physicianComp,
    ],
    ["  Owner Physician Retained", ...ownerRetained],
    [
      "    (Clinic's 30% share + management fee)",
      null,
      null,
      null,
    ],
    [],
    ["STAFF EXPENSES", null, null, null],
    [
      "  Salaries & Benefits",
      ...staffSalaries,
    ],
    [
      "    (Receptionist, nurse, admin, PT bookkeeper)",
      null,
      null,
      null,
    ],
    [],
    ["OPERATING EXPENSES", null, null, null],
    ["  Rent", ...rent],
    ["  Medical Supplies", ...medicalSupplies],
    ["  EMR / Technology", ...emrTech],
    ["  Insurance (Malpractice + General)", ...insurance],
    ["  Professional Fees", ...professionalFees],
    ["  Other Operating Expenses", ...otherOperating],
    [],
    ["TOTAL EXPENSES", ...totalExpenses],
    [],
    ["NET INCOME BEFORE TAX", ...netIncome],
    [],
    ["OWNER NET BENEFIT", null, null, null],
    ["  Owner Physician Retained", ...ownerRetained],
    ["  Plus: Net Income", ...netIncome],
    [
      "  Total Owner Benefit",
      ...years.map((_, i) => ownerRetained[i] + netIncome[i]),
    ],
  ];

  return { name: "Income Statement", data, colWidths: [40, 16, 16, 16] };
}

function generateMedical() {
  console.log("\n3. Bayview Family Health Centre (Medical Clinic - Ontario)");
  const wb = buildWorkbook([medicalIncomeStatement()]);
  writeWorkbook(
    wb,
    "medical-clinic-ontario/financials/income-statements-2022-2024.xlsx"
  );
}

// ─── 4. Manufacturing — Precision Metal Works Inc. ───────────────────────────

function manufacturingIncomeStatement(): SheetDef {
  const years = [2022, 2023, 2024];
  const totalRevenue = [4_800_000, 5_100_000, 5_400_000];

  // Customer concentration breakdown
  const apexIndustrial = [1_680_000, 1_785_000, 1_890_000]; // 35%
  const westernEnergy = [864_000, 918_000, 972_000]; // 18%
  const northernPipeline = [480_000, 510_000, 540_000]; // 10%
  const rocketManufacturing = [336_000, 357_000, 378_000]; // 7%
  const otherCustomers = years.map(
    (_, i) =>
      totalRevenue[i] -
      apexIndustrial[i] -
      westernEnergy[i] -
      northernPipeline[i] -
      rocketManufacturing[i]
  ); // 30%

  // COGS: raw materials 32%, direct labour 22%, mfg overhead 8%
  const rawMaterials = [1_536_000, 1_632_000, 1_728_000];
  const directLabour = [1_056_000, 1_122_000, 1_188_000];
  const mfgOverhead = [384_000, 408_000, 432_000];
  const totalCOGS = years.map(
    (_, i) => rawMaterials[i] + directLabour[i] + mfgOverhead[i]
  );
  const grossProfit = years.map((_, i) => totalRevenue[i] - totalCOGS[i]);

  // OpEx
  const ownerSalary = [210_000, 210_000, 210_000];
  const ownerVehicle = [44_000, 46_000, 48_000];
  const ownerInsurance = [16_000, 17_000, 18_000];
  const officeStaff = [165_000, 175_000, 185_000];
  const facilityRent = [96_000, 96_000, 96_000];
  const utilities = [72_000, 72_000, 72_000];
  const equipMaint = [48_000, 52_000, 56_000];
  const insurance = [55_000, 58_000, 62_000];
  const professionalFees = [22_000, 22_000, 22_000];
  const marketing = [15_000, 18_000, 20_000];
  const depreciation = [85_000, 90_000, 95_000];
  const qualityISO = [12_000, 12_000, 12_000];
  const shippingFreight = [214_000, 228_000, 238_000];
  const qualityStaff = [132_000, 142_000, 148_000];
  const propertyTax = [50_000, 52_000, 54_000];
  const toolingDies = [54_000, 60_000, 64_000];
  const wasteHazmat = [30_000, 34_000, 36_000];
  const itSystems = [22_000, 24_000, 26_000];
  const phoneInternet = [14_000, 15_000, 15_000];
  const safetyCompliance = [26_000, 30_000, 32_000];
  const rAndD = [36_000, 42_000, 46_000];
  const travelEntertainment = [20_000, 24_000, 26_000];
  const bankCharges = [10_000, 12_000, 12_000];
  const badDebt = [0, 0, 12_000];
  const misc = [36_000, 37_000, 37_000];

  const totalOpEx = years.map(
    (_, i) =>
      ownerSalary[i] +
      ownerVehicle[i] +
      ownerInsurance[i] +
      officeStaff[i] +
      facilityRent[i] +
      utilities[i] +
      equipMaint[i] +
      insurance[i] +
      professionalFees[i] +
      marketing[i] +
      depreciation[i] +
      qualityISO[i] +
      shippingFreight[i] +
      qualityStaff[i] +
      propertyTax[i] +
      toolingDies[i] +
      wasteHazmat[i] +
      itSystems[i] +
      phoneInternet[i] +
      safetyCompliance[i] +
      rAndD[i] +
      travelEntertainment[i] +
      bankCharges[i] +
      badDebt[i] +
      misc[i]
  );
  const netIncome = years.map((_, i) => grossProfit[i] - totalOpEx[i]);

  const data: Row[] = [
    ["PRECISION METAL WORKS INC.", null, null, null],
    ["Income Statement", null, null, null],
    ["For the Years Ended December 31", null, null, null],
    [],
    [null, ...years],
    [],
    ["REVENUE BY CUSTOMER", null, null, null],
    ["  Apex Industrial Supply", ...apexIndustrial],
    [
      "    % of Revenue",
      ...years.map((_, i) =>
        `${((apexIndustrial[i] / totalRevenue[i]) * 100).toFixed(1)}%`
      ),
    ],
    ["  Western Energy Corp.", ...westernEnergy],
    [
      "    % of Revenue",
      ...years.map((_, i) =>
        `${((westernEnergy[i] / totalRevenue[i]) * 100).toFixed(1)}%`
      ),
    ],
    ["  Northern Pipeline Services", ...northernPipeline],
    ["  Rocket Manufacturing Ltd.", ...rocketManufacturing],
    ["  Other Customers (misc.)", ...otherCustomers],
    [],
    ["TOTAL REVENUE", ...totalRevenue],
    [],
    ["COST OF GOODS SOLD", null, null, null],
    ["  Raw Materials", ...rawMaterials],
    ["  Direct Labour", ...directLabour],
    ["  Manufacturing Overhead", ...mfgOverhead],
    ["TOTAL COST OF GOODS SOLD", ...totalCOGS],
    [],
    ["GROSS PROFIT", ...grossProfit],
    [
      "  Gross Margin %",
      ...years.map((_, i) =>
        `${((grossProfit[i] / totalRevenue[i]) * 100).toFixed(1)}%`
      ),
    ],
    [],
    ["OPERATING EXPENSES", null, null, null],
    ["  Owner's Salary", ...ownerSalary],
    ["  Owner Vehicle", ...ownerVehicle],
    ["  Owner Insurance (Life/Disability)", ...ownerInsurance],
    ["  Office Staff", ...officeStaff],
    ["  Facility Rent", ...facilityRent],
    ["  Utilities", ...utilities],
    ["  Equipment Maintenance", ...equipMaint],
    ["  Insurance (General/Liability)", ...insurance],
    ["  Professional Fees", ...professionalFees],
    ["  Marketing & Advertising", ...marketing],
    ["  Depreciation", ...depreciation],
    ["  Quality / ISO Compliance", ...qualityISO],
    ["  Shipping & Freight", ...shippingFreight],
    ["  Quality Control Staff", ...qualityStaff],
    ["  Property Tax", ...propertyTax],
    ["  Tooling & Dies", ...toolingDies],
    ["  Waste & Hazmat Disposal", ...wasteHazmat],
    ["  IT Systems & Software", ...itSystems],
    ["  Phone & Internet", ...phoneInternet],
    ["  Safety & Compliance", ...safetyCompliance],
    ["  Research & Development", ...rAndD],
    ["  Travel & Entertainment", ...travelEntertainment],
    ["  Bank Charges & Interest", ...bankCharges],
    ["  Bad Debt Expense", ...badDebt],
    ["  Miscellaneous", ...misc],
    [],
    ["TOTAL OPERATING EXPENSES", ...totalOpEx],
    [],
    ["NET INCOME BEFORE TAX", ...netIncome],
  ];

  return { name: "Income Statement", data, colWidths: [36, 16, 16, 16] };
}

function generateManufacturing() {
  console.log("\n4. Precision Metal Works Inc. (Manufacturing - Alberta)");
  const wb = buildWorkbook([manufacturingIncomeStatement()]);
  writeWorkbook(
    wb,
    "manufacturing-alberta/financials/income-statements-2022-2024.xlsx"
  );
}

// ─── 5. IT/MSP — Cascadia Managed Services ──────────────────────────────────

function itMspIncomeStatement(): SheetDef {
  const years = [2022, 2023, 2024];
  const totalRevenue = [1_800_000, 2_200_000, 2_600_000];

  // Revenue breakdown
  const managedMRR = [1_116_000, 1_364_000, 1_612_000]; // 62%
  const projectBreakfix = [396_000, 484_000, 572_000]; // 22%
  const cloudResale = [288_000, 352_000, 416_000]; // 16%

  // COGS
  const vendorLicensing = [378_000, 462_000, 546_000]; // 21%
  const projectSubs = [108_000, 132_000, 156_000]; // 6%
  const cloudInfra = [162_000, 198_000, 234_000]; // 9%
  const totalCOGS = years.map(
    (_, i) => vendorLicensing[i] + projectSubs[i] + cloudInfra[i]
  );
  const grossProfit = years.map((_, i) => totalRevenue[i] - totalCOGS[i]);

  // OpEx
  const ownerComp = [160_000, 170_000, 175_000];
  const seniorTechs = [240_000, 270_000, 315_000]; // 3 techs
  const juniorTechs = [110_000, 120_000, 130_000]; // 2 techs
  const salesAdmin = [85_000, 95_000, 105_000];
  const dispatchNOC = [38_000, 102_000, 155_000]; // after-hours NOC scaling up
  const officeRent = [48_000, 48_000, 54_000];
  const insurance = [18_000, 20_000, 22_000];
  const eAndO = [12_000, 15_000, 18_000]; // E&O / cyber liability
  const profDev = [12_000, 15_000, 18_000];
  const certifications = [8_000, 12_000, 15_000]; // MS, Cisco, CompTIA
  const toolsSoftware = [24_000, 30_000, 36_000];
  const rmmPsa = [52_000, 73_000, 89_000]; // RMM + PSA platform costs (scales with endpoints)
  const marketing = [15_000, 22_000, 28_000];
  const vehicle = [12_000, 12_000, 14_000];
  const professionalFees = [10_000, 10_000, 12_000];
  const depreciation = [15_000, 18_000, 22_000];
  const hardwareSpares = [22_000, 28_000, 36_000];
  const datacenterColo = [33_000, 45_000, 54_000];
  const phoneVoip = [9_000, 11_000, 14_000];
  const travelOnsite = [18_000, 26_000, 32_000];
  const bankCharges = [4_000, 5_000, 6_000];
  const recruitingOnboard = [10_000, 18_000, 26_000];
  const misc = [17_000, 23_000, 28_000];

  const totalOpEx = years.map(
    (_, i) =>
      ownerComp[i] +
      seniorTechs[i] +
      juniorTechs[i] +
      salesAdmin[i] +
      dispatchNOC[i] +
      officeRent[i] +
      insurance[i] +
      eAndO[i] +
      profDev[i] +
      certifications[i] +
      toolsSoftware[i] +
      rmmPsa[i] +
      marketing[i] +
      vehicle[i] +
      professionalFees[i] +
      depreciation[i] +
      hardwareSpares[i] +
      datacenterColo[i] +
      phoneVoip[i] +
      travelOnsite[i] +
      bankCharges[i] +
      recruitingOnboard[i] +
      misc[i]
  );
  const netIncome = years.map((_, i) => grossProfit[i] - totalOpEx[i]);

  const data: Row[] = [
    ["CASCADIA MANAGED SERVICES", null, null, null],
    ["Income Statement", null, null, null],
    ["For the Years Ended December 31", null, null, null],
    [],
    [null, ...years],
    [],
    ["REVENUE BREAKDOWN", null, null, null],
    ["  Managed Services (MRR)", ...managedMRR],
    [
      "    % of Revenue",
      ...years.map((_, i) =>
        `${((managedMRR[i] / totalRevenue[i]) * 100).toFixed(1)}%`
      ),
    ],
    ["  Project / Break-Fix", ...projectBreakfix],
    [
      "    % of Revenue",
      ...years.map((_, i) =>
        `${((projectBreakfix[i] / totalRevenue[i]) * 100).toFixed(1)}%`
      ),
    ],
    ["  Cloud / Licensing Resale", ...cloudResale],
    [
      "    % of Revenue",
      ...years.map((_, i) =>
        `${((cloudResale[i] / totalRevenue[i]) * 100).toFixed(1)}%`
      ),
    ],
    [],
    ["TOTAL REVENUE", ...totalRevenue],
    [
      "  YoY Growth",
      "---",
      `${(((totalRevenue[1] - totalRevenue[0]) / totalRevenue[0]) * 100).toFixed(1)}%`,
      `${(((totalRevenue[2] - totalRevenue[1]) / totalRevenue[1]) * 100).toFixed(1)}%`,
    ],
    [],
    ["COST OF GOODS SOLD", null, null, null],
    ["  Vendor Licensing", ...vendorLicensing],
    ["  Project Subcontractors", ...projectSubs],
    ["  Cloud Infrastructure Costs", ...cloudInfra],
    ["TOTAL COST OF GOODS SOLD", ...totalCOGS],
    [],
    ["GROSS PROFIT", ...grossProfit],
    [
      "  Gross Margin %",
      ...years.map((_, i) =>
        `${((grossProfit[i] / totalRevenue[i]) * 100).toFixed(1)}%`
      ),
    ],
    [],
    ["OPERATING EXPENSES", null, null, null],
    ["  Owner Compensation", ...ownerComp],
    ["  Senior Technicians (3)", ...seniorTechs],
    ["  Junior Technicians (2)", ...juniorTechs],
    ["  Sales & Admin Staff", ...salesAdmin],
    ["  Dispatch / After-Hours NOC", ...dispatchNOC],
    ["  Office Rent", ...officeRent],
    ["  Insurance (General/Liability)", ...insurance],
    ["  E&O / Cyber Liability Insurance", ...eAndO],
    ["  Professional Development", ...profDev],
    ["  Certifications (MS, Cisco, CompTIA)", ...certifications],
    ["  Tools & Software Subscriptions", ...toolsSoftware],
    ["  RMM & PSA Platform Costs", ...rmmPsa],
    ["  Marketing & Advertising", ...marketing],
    ["  Vehicle Expenses", ...vehicle],
    ["  Professional Fees", ...professionalFees],
    ["  Hardware Spares & Inventory", ...hardwareSpares],
    ["  Datacenter / Colocation", ...datacenterColo],
    ["  Phone & VoIP", ...phoneVoip],
    ["  Travel & On-site Client Visits", ...travelOnsite],
    ["  Bank Charges", ...bankCharges],
    ["  Recruiting & Onboarding", ...recruitingOnboard],
    ["  Depreciation", ...depreciation],
    ["  Miscellaneous", ...misc],
    [],
    ["TOTAL OPERATING EXPENSES", ...totalOpEx],
    [],
    ["NET INCOME BEFORE TAX", ...netIncome],
  ];

  return { name: "Income Statement", data, colWidths: [36, 16, 16, 16] };
}

function generateItMsp() {
  console.log("\n5. Cascadia Managed Services (IT/MSP - BC)");
  const wb = buildWorkbook([itMspIncomeStatement()]);
  writeWorkbook(
    wb,
    "it-msp-bc/financials/income-statements-2022-2024.xlsx"
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("Generating financial test data...");

generateConstruction();
generateRestaurant();
generateMedical();
generateManufacturing();
generateItMsp();

console.log("\nDone. All XLSX files generated.");
