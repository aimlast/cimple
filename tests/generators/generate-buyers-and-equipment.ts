/**
 * generate-buyers-and-equipment.ts
 *
 * Generates buyer CSV files (5 industries) and equipment XLSX files (2 industries).
 * Run: npx tsx tests/generators/generate-buyers-and-equipment.ts
 */

import XLSX from "xlsx";
import fs from "fs";
import path from "path";

const BASE = path.resolve(import.meta.dirname, "../test-data");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CSV_HEADER =
  "buyer_name,email,company,buyer_type,phone,target_industries,target_locations,budget_min,budget_max,proof_of_funds,linkedin_url,notes";

interface BuyerRow {
  name: string;
  email: string;
  company: string;
  type: "strategic" | "financial" | "individual";
  phone: string;
  industries: string;
  locations: string;
  budgetMin: number;
  budgetMax: number;
  proofOfFunds: boolean;
  linkedin: string;
  notes: string;
}

function buyerToCsvLine(b: BuyerRow): string {
  // Wrap fields that may contain commas or semicolons in double-quotes
  const q = (s: string) => (s.includes(",") || s.includes(";") ? `"${s}"` : s);
  return [
    q(b.name),
    b.email,
    q(b.company),
    b.type,
    b.phone,
    q(b.industries),
    q(b.locations),
    b.budgetMin,
    b.budgetMax,
    b.proofOfFunds,
    b.linkedin,
    q(b.notes),
  ].join(",");
}

function writeCsv(buyers: BuyerRow[], relPath: string) {
  const lines = [CSV_HEADER, ...buyers.map(buyerToCsvLine)];
  const full = path.join(BASE, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.join("\n") + "\n", "utf-8");
  console.log(`  -> ${relPath}`);
}

type Row = (string | number | null)[];

interface SheetDef {
  name: string;
  data: Row[];
  colWidths: number[];
}

function buildWorkbook(sheets: SheetDef[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const { name, data, colWidths } of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = colWidths.map((w) => ({ wch: w }));
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

// ─── 1. Construction Ontario — 15 Buyers ────────────────────────────────────

function constructionBuyers(): BuyerRow[] {
  return [
    {
      name: "Marcus Chen",
      email: "marcus.chen@apexbuilders.ca",
      company: "Apex Builders Group",
      type: "strategic",
      phone: "416-555-0101",
      industries: "Construction;General Contracting",
      locations: "Ontario;GTA",
      budgetMin: 2000000,
      budgetMax: 5000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/marcuschen",
      notes:
        "Looking to expand into Hamilton market. Has bonding capacity to $10M.",
    },
    {
      name: "Patricia Wolfe",
      email: "pwolfe@wolfegroup.com",
      company: "Wolfe Capital Partners",
      type: "financial",
      phone: "647-555-0202",
      industries: "Construction;Trades",
      locations: "Ontario;Alberta",
      budgetMin: 3000000,
      budgetMax: 8000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/patriciawolfe",
      notes:
        "PE fund focused on construction roll-ups. Closed 3 deals in 2024.",
    },
    {
      name: "David Morrison",
      email: "david@morrisoncontracting.ca",
      company: "Morrison Contracting",
      type: "individual",
      phone: "905-555-0303",
      industries: "General Contracting",
      locations: "Ontario",
      budgetMin: 1500000,
      budgetMax: 3500000,
      proofOfFunds: false,
      linkedin: "linkedin.com/in/davidmorrison",
      notes:
        "Licensed GC with 12 years experience. Looking to acquire vs. grow organically.",
    },
    {
      name: "Sarah Blackwood",
      email: "sblackwood@empireconstruction.com",
      company: "Empire Construction Holdings",
      type: "strategic",
      phone: "416-555-0404",
      industries: "Construction;Infrastructure",
      locations: "Ontario;Quebec",
      budgetMin: 4000000,
      budgetMax: 12000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/sarahblackwood",
      notes: "National GC seeking Ontario tuck-in acquisitions.",
    },
    {
      name: "James Liu",
      email: "james.liu@horizonpe.com",
      company: "Horizon Private Equity",
      type: "financial",
      phone: "416-555-0505",
      industries: "Construction;Manufacturing",
      locations: "Canada",
      budgetMin: 5000000,
      budgetMax: 15000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/jamesliu",
      notes: "Mid-market PE. Construction platform company strategy.",
    },
    {
      name: "Mike Tremblay",
      email: "mike.t@tremblaybuilders.ca",
      company: "Tremblay & Sons Construction",
      type: "individual",
      phone: "905-555-0606",
      industries: "Residential;Commercial Construction",
      locations: "Hamilton;Niagara",
      budgetMin: 1500000,
      budgetMax: 4000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/miketremblay",
      notes:
        "3rd generation contractor. Family succession plan to acquire.",
    },
    {
      name: "Angela Russo",
      email: "arusso@bridgepointadvisors.com",
      company: "Bridgepoint Advisors",
      type: "financial",
      phone: "647-555-0707",
      industries: "Construction;Services",
      locations: "Ontario",
      budgetMin: 2000000,
      budgetMax: 6000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/angelarusso",
      notes: "Search fund backed. First acquisition target.",
    },
    {
      name: "Robert Kim",
      email: "rkim@kimgroup.ca",
      company: "Kim Development Group",
      type: "strategic",
      phone: "416-555-0808",
      industries: "Construction;Real Estate",
      locations: "GTA;Southern Ontario",
      budgetMin: 3000000,
      budgetMax: 7000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/robertkim",
      notes:
        "Developer looking to vertically integrate with a GC.",
    },
    {
      name: "Thomas Walker",
      email: "twalker@walkercontractors.com",
      company: "Walker Contractors Inc.",
      type: "individual",
      phone: "519-555-0909",
      industries: "General Contracting;Civil",
      locations: "Ontario",
      budgetMin: 2000000,
      budgetMax: 4500000,
      proofOfFunds: false,
      linkedin: "linkedin.com/in/thomaswalker",
      notes:
        "Experienced PM looking to buy an established operation.",
    },
    {
      name: "Diana Santos",
      email: "dsantos@ontariobuilds.ca",
      company: "Ontario Builds Capital",
      type: "financial",
      phone: "416-555-1010",
      industries: "Construction",
      locations: "Ontario",
      budgetMin: 2500000,
      budgetMax: 8000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/dianasantos",
      notes: "Family office. Construction-focused investments.",
    },
    {
      name: "Kevin O'Brien",
      email: "kobrien@celticbuilders.ca",
      company: "Celtic Builders Ltd.",
      type: "individual",
      phone: "905-555-1111",
      industries: "Commercial Construction",
      locations: "Hamilton;Burlington",
      budgetMin: 1800000,
      budgetMax: 3000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/kevinobrien",
      notes:
        "Currently runs small reno company. Wants to scale up.",
    },
    {
      name: "Jennifer Park",
      email: "jpark@summitinfra.com",
      company: "Summit Infrastructure Partners",
      type: "strategic",
      phone: "416-555-1212",
      industries: "Construction;Infrastructure",
      locations: "Ontario;Western Canada",
      budgetMin: 5000000,
      budgetMax: 15000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/jenniferpark",
      notes:
        "Infrastructure-focused strategic buyer. Multiple acquisitions per year.",
    },
    {
      name: "Andrew Fleming",
      email: "afleming@flemingcapital.ca",
      company: "Fleming Capital",
      type: "financial",
      phone: "647-555-1313",
      industries: "Construction;Services;Manufacturing",
      locations: "Ontario",
      budgetMin: 3000000,
      budgetMax: 10000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/andrewfleming",
      notes:
        "Independent sponsor. Has capital committed for construction deal.",
    },
    {
      name: "Rachel Patel",
      email: "rpatel@patelconstruction.ca",
      company: "Patel Construction Ltd.",
      type: "individual",
      phone: "905-555-1414",
      industries: "General Contracting",
      locations: "GTA",
      budgetMin: 1500000,
      budgetMax: 2500000,
      proofOfFunds: false,
      linkedin: "linkedin.com/in/rachelpatel",
      notes:
        "Civil engineer transitioning to business ownership.",
    },
    {
      name: "Christopher Dunn",
      email: "cdunn@dunnholdings.com",
      company: "Dunn Holdings Inc.",
      type: "strategic",
      phone: "416-555-1515",
      industries: "Construction;Environmental",
      locations: "Eastern Canada",
      budgetMin: 4000000,
      budgetMax: 9000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/christopherdunn",
      notes:
        "Operates 3 construction companies. Adding GC capability.",
    },
  ];
}

// ─── 2. Restaurant Toronto — 10 Buyers ──────────────────────────────────────

function restaurantBuyers(): BuyerRow[] {
  return [
    {
      name: "Michelle Laurent",
      email: "mlaurent@laurentgroup.ca",
      company: "Laurent Hospitality Group",
      type: "strategic",
      phone: "416-555-2001",
      industries: "Restaurant;Hospitality",
      locations: "Toronto;GTA",
      budgetMin: 800000,
      budgetMax: 2500000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/michellelaurent",
      notes:
        "Owns 4 restaurants in Toronto. Looking to add Italian concept.",
    },
    {
      name: "Ryan Cooper",
      email: "rcooper@cooperfoodgroup.com",
      company: "Cooper Food Group",
      type: "strategic",
      phone: "416-555-2002",
      industries: "Restaurant;QSR",
      locations: "Ontario",
      budgetMin: 500000,
      budgetMax: 1500000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/ryancooper",
      notes:
        "Multi-unit operator. Converting independents to managed operations.",
    },
    {
      name: "Samantha Winters",
      email: "swinters@gmail.com",
      company: "(Individual)",
      type: "individual",
      phone: "647-555-2003",
      industries: "Restaurant;Bar",
      locations: "Toronto",
      budgetMin: 300000,
      budgetMax: 800000,
      proofOfFunds: false,
      linkedin: "linkedin.com/in/samanthawinters",
      notes:
        "Hospitality management grad. First restaurant purchase.",
    },
    {
      name: "Daniel Ortiz",
      email: "dortiz@ortizventures.ca",
      company: "Ortiz Ventures",
      type: "financial",
      phone: "416-555-2004",
      industries: "Restaurant;Food Service",
      locations: "GTA;Hamilton",
      budgetMin: 1000000,
      budgetMax: 3000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/danielortiz",
      notes:
        "Restaurant-focused investor. Silent partner model.",
    },
    {
      name: "Karen Singh",
      email: "ksingh@spiceroadgroup.com",
      company: "Spice Road Restaurant Group",
      type: "strategic",
      phone: "416-555-2005",
      industries: "Restaurant;Ethnic Cuisine",
      locations: "Toronto;Mississauga",
      budgetMin: 600000,
      budgetMax: 1800000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/karensingh",
      notes:
        "Operates Indian and fusion restaurants. Expanding portfolio.",
    },
    {
      name: "Tom Bradley",
      email: "tbradley@bradleycapital.ca",
      company: "Bradley Capital",
      type: "financial",
      phone: "647-555-2006",
      industries: "Restaurant;Retail Food",
      locations: "Ontario",
      budgetMin: 1500000,
      budgetMax: 4000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/tombradley",
      notes: "Family office. Passive restaurant investments.",
    },
    {
      name: "Lisa Nakamura",
      email: "lnakamura@nakamuragroup.com",
      company: "Nakamura Group",
      type: "individual",
      phone: "416-555-2007",
      industries: "Restaurant",
      locations: "Toronto;Yorkville",
      budgetMin: 500000,
      budgetMax: 1200000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/lisanakamura",
      notes: "Former head chef at Canoe. Wants ownership.",
    },
    {
      name: "Marco DeLuca",
      email: "mdeluca@delucahospitality.ca",
      company: "DeLuca Hospitality Inc.",
      type: "strategic",
      phone: "416-555-2008",
      industries: "Italian Restaurant;Bar",
      locations: "Toronto;GTA",
      budgetMin: 700000,
      budgetMax: 2000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/marcodeluca",
      notes:
        "Italian-focused restaurateur. Perfect concept match.",
    },
    {
      name: "Chris Thompson",
      email: "cthompson@foodventurescapital.com",
      company: "Food Ventures Capital",
      type: "financial",
      phone: "416-555-2009",
      industries: "Restaurant;Food Manufacturing",
      locations: "Ontario;BC",
      budgetMin: 2000000,
      budgetMax: 5000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/christhompson",
      notes:
        "Hospitality PE fund. Series of recent acquisitions.",
    },
    {
      name: "Amanda Green",
      email: "agreen@gmail.com",
      company: "(Individual)",
      type: "individual",
      phone: "647-555-2010",
      industries: "Restaurant;Cafe",
      locations: "Toronto;East End",
      budgetMin: 400000,
      budgetMax: 900000,
      proofOfFunds: false,
      linkedin: "linkedin.com/in/amandagreen",
      notes:
        "Currently manages a restaurant. Wants to buy and operate.",
    },
  ];
}

// ─── 3. Medical Clinic Ontario — 8 Buyers ───────────────────────────────────

function medicalBuyers(): BuyerRow[] {
  return [
    {
      name: "Dr. Raj Mehta",
      email: "rmehta@mehtamedical.ca",
      company: "Mehta Medical Professional Corp.",
      type: "individual",
      phone: "416-555-3001",
      industries: "Medical Clinic;Family Practice",
      locations: "Toronto;GTA",
      budgetMin: 1500000,
      budgetMax: 3500000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/rajmehta",
      notes:
        "Family physician 8 years. Wants established practice vs. starting fresh.",
    },
    {
      name: "Dr. Emily Foster",
      email: "efoster@fosterhealth.ca",
      company: "Foster Health Group",
      type: "strategic",
      phone: "905-555-3002",
      industries: "Medical Clinic;Walk-in;Allied Health",
      locations: "Ontario",
      budgetMin: 2000000,
      budgetMax: 5000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/emilyfoster",
      notes:
        "Operates 3 clinics. Expanding patient roster aggressively.",
    },
    {
      name: "MedVentures Health Corp.",
      email: "acquisitions@medventures.ca",
      company: "MedVentures Health Corp.",
      type: "strategic",
      phone: "416-555-3003",
      industries: "Healthcare;Medical Clinic",
      locations: "Ontario;BC",
      budgetMin: 3000000,
      budgetMax: 8000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/medventures",
      notes:
        "Healthcare management company. Acquires and operates physician practices.",
    },
    {
      name: "Dr. Wei Zhang",
      email: "wzhang@torontofamilymed.ca",
      company: "Toronto Family Medicine PC",
      type: "individual",
      phone: "416-555-3004",
      industries: "Family Practice",
      locations: "Toronto;North York",
      budgetMin: 800000,
      budgetMax: 2000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/weizhang",
      notes:
        "3 years post-residency. Has CMPA coverage. Wants to buy into established practice.",
    },
    {
      name: "Dr. Anika Sharma",
      email: "asharma@sharmahealth.ca",
      company: "Sharma Health Partners",
      type: "strategic",
      phone: "647-555-3005",
      industries: "Medical Clinic;Specialist Clinic",
      locations: "GTA",
      budgetMin: 1200000,
      budgetMax: 3000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/anikasharma",
      notes:
        "Physician couple wanting multi-physician practice.",
    },
    {
      name: "PhysCan Healthcare Inc.",
      email: "deals@physcan.ca",
      company: "PhysCan Healthcare Inc.",
      type: "strategic",
      phone: "416-555-3006",
      industries: "Medical Clinic;Diagnostics",
      locations: "Ontario;Alberta",
      budgetMin: 4000000,
      budgetMax: 10000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/physcan",
      notes:
        "PE-backed healthcare platform. National roll-up strategy.",
    },
    {
      name: "Dr. James Okafor",
      email: "jokafor@gmail.com",
      company: "(Individual)",
      type: "individual",
      phone: "905-555-3007",
      industries: "Family Practice;Walk-in",
      locations: "Toronto;Scarborough",
      budgetMin: 1000000,
      budgetMax: 2500000,
      proofOfFunds: false,
      linkedin: "linkedin.com/in/jamesokafor",
      notes:
        "Experienced FP looking to transition from hospital to community practice.",
    },
    {
      name: "Dr. Lisa Beaumont",
      email: "lbeaumont@baymedgroup.ca",
      company: "Bay Medical Group",
      type: "strategic",
      phone: "416-555-3008",
      industries: "Medical Clinic;Executive Health",
      locations: "Toronto",
      budgetMin: 1500000,
      budgetMax: 4000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/lisabeaumont",
      notes:
        "Runs executive health clinic. Wants to add family practice feeder.",
    },
  ];
}

// ─── 4. Manufacturing Alberta — 12 Buyers ───────────────────────────────────

function manufacturingBuyers(): BuyerRow[] {
  return [
    // PE-backed platforms (4)
    {
      name: "Greg Lawson",
      email: "glawson@prairieequity.ca",
      company: "Prairie Equity Partners",
      type: "financial",
      phone: "403-555-4001",
      industries: "Manufacturing;Metal Fabrication",
      locations: "Alberta;Western Canada",
      budgetMin: 5000000,
      budgetMax: 12000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/greglawson",
      notes:
        "PE platform building a Western Canadian fab/machine shop roll-up. Wants ISO-certified operations with oil & gas exposure.",
    },
    {
      name: "Sandra Whitfield",
      email: "swhitfield@ironcladcapital.com",
      company: "Ironclad Capital Corp.",
      type: "financial",
      phone: "403-555-4002",
      industries: "Manufacturing;Industrial Services",
      locations: "Alberta;Saskatchewan",
      budgetMin: 4000000,
      budgetMax: 10000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/sandrawhitfield",
      notes:
        "Industrial-focused PE. Specifically targeting CNC capability and 5-axis machining capacity. Closed 2 fab acquisitions in 2024.",
    },
    {
      name: "Nathan Berg",
      email: "nberg@westernforge.com",
      company: "Western Forge Capital",
      type: "financial",
      phone: "780-555-4003",
      industries: "Manufacturing;Oil & Gas Services",
      locations: "Alberta",
      budgetMin: 3000000,
      budgetMax: 8000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/nathanberg",
      notes:
        "Search fund. First acquisition. Wants ASME-certified shop with established oil sands customer base.",
    },
    {
      name: "Claire Dubois",
      email: "cdubois@atlascapitalpartners.ca",
      company: "Atlas Capital Partners",
      type: "financial",
      phone: "403-555-4004",
      industries: "Manufacturing;Fabrication;Industrial",
      locations: "Canada",
      budgetMin: 6000000,
      budgetMax: 12000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/clairedubois",
      notes:
        "Mid-market PE. Platform strategy in precision manufacturing. Wants shops with recurring MRO contracts.",
    },
    // Competing fab shops (4)
    {
      name: "Bill Makarchuk",
      email: "bmak@precisionsteelab.ca",
      company: "Precision Steel Alberta Ltd.",
      type: "strategic",
      phone: "403-555-4005",
      industries: "Metal Fabrication;Structural Steel",
      locations: "Alberta",
      budgetMin: 2000000,
      budgetMax: 5000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/billmakarchuk",
      notes:
        "Runs structural steel shop in Red Deer. Looking to add CNC machining capability. Has WCB and COR certification.",
    },
    {
      name: "Heather Olsen",
      email: "holsen@northernfab.ca",
      company: "Northern Fabricators Inc.",
      type: "strategic",
      phone: "780-555-4006",
      industries: "Metal Fabrication;Pipe Fabrication",
      locations: "Alberta;Northern BC",
      budgetMin: 3000000,
      budgetMax: 7000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/heatherolsen",
      notes:
        "Edmonton-based pipe fab shop. Wants to acquire southern Alberta capacity and ISO 9001 cert transfer.",
    },
    {
      name: "Derek Fung",
      email: "dfung@alpinemetalworks.ca",
      company: "Alpine Metalworks Ltd.",
      type: "strategic",
      phone: "403-555-4007",
      industries: "Metal Fabrication;Manufacturing",
      locations: "Alberta",
      budgetMin: 2500000,
      budgetMax: 6000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/derekfung",
      notes:
        "Calgary custom fab shop. Capacity-constrained — needs second facility plus experienced welders on payroll.",
    },
    {
      name: "Tamara Riedel",
      email: "triedel@westernweld.ca",
      company: "Western Weld & Fabrication",
      type: "strategic",
      phone: "403-555-4008",
      industries: "Welding;Metal Fabrication",
      locations: "Southern Alberta",
      budgetMin: 2000000,
      budgetMax: 4500000,
      proofOfFunds: false,
      linkedin: "linkedin.com/in/tamarariedel",
      notes:
        "Owner-operator. Wants to consolidate competitor to gain market share and equipment fleet.",
    },
    // Strategic adjacent (4)
    {
      name: "Martin Falk",
      email: "mfalk@falkoilfield.com",
      company: "Falk Oilfield Services Ltd.",
      type: "strategic",
      phone: "403-555-4009",
      industries: "Oil & Gas Services;Manufacturing",
      locations: "Alberta",
      budgetMin: 3000000,
      budgetMax: 8000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/martinfalk",
      notes:
        "Oilfield services company. Vertical integration — currently outsources all fabrication. Wants in-house capability.",
    },
    {
      name: "Joanne Pickering",
      email: "jpickering@canastructures.ca",
      company: "CanaStructures Engineering",
      type: "strategic",
      phone: "780-555-4010",
      industries: "Construction;Steel Erection;Fabrication",
      locations: "Alberta;BC",
      budgetMin: 4000000,
      budgetMax: 9000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/joannepickering",
      notes:
        "Steel erection and engineering firm. Wants to own fabrication to control supply chain and margins.",
    },
    {
      name: "Rick Sawchuk",
      email: "rsawchuk@prairieindustrial.ca",
      company: "Prairie Industrial Group",
      type: "individual",
      phone: "403-555-4011",
      industries: "Manufacturing;Machining",
      locations: "Alberta",
      budgetMin: 2000000,
      budgetMax: 5000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/ricksawchuk",
      notes:
        "Former plant manager at CNRL. 20 years manufacturing operations. Wants to own and operate.",
    },
    {
      name: "Vanessa Tran",
      email: "vtran@horizonindustrial.ca",
      company: "Horizon Industrial Holdings",
      type: "strategic",
      phone: "403-555-4012",
      industries: "Industrial Equipment;Manufacturing;Distribution",
      locations: "Alberta;Saskatchewan",
      budgetMin: 3500000,
      budgetMax: 8000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/vanessatran",
      notes:
        "Industrial distributor looking to add manufacturing arm. Interested in equipment condition and paint booth capability.",
    },
  ];
}

// ─── 5. IT/MSP BC — 10 Buyers ──────────────────────────────────────────────

function itMspBuyers(): BuyerRow[] {
  return [
    // Larger MSPs wanting BC presence (3)
    {
      name: "Jason Whitmore",
      email: "jwhitmore@summititsolutions.ca",
      company: "Summit IT Solutions",
      type: "strategic",
      phone: "604-555-5001",
      industries: "IT Services;MSP;Cybersecurity",
      locations: "BC;Western Canada",
      budgetMin: 2000000,
      budgetMax: 6000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/jasonwhitmore",
      notes:
        "Calgary MSP expanding to BC. Wants MRR base and Microsoft Gold partnership transfer. 800+ managed endpoints currently.",
    },
    {
      name: "Natasha Ivanova",
      email: "nivanova@pacificnetworks.ca",
      company: "Pacific Networks Inc.",
      type: "strategic",
      phone: "604-555-5002",
      industries: "MSP;Cloud Services",
      locations: "BC;Alberta",
      budgetMin: 1500000,
      budgetMax: 4000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/natashaivanova",
      notes:
        "Vancouver MSP. Looking to add Fraser Valley and interior client base. Values Datto and ConnectWise stack alignment.",
    },
    {
      name: "Alex Drummond",
      email: "adrummond@cascadeit.com",
      company: "Cascade IT Services",
      type: "strategic",
      phone: "250-555-5003",
      industries: "IT Services;MSP;VoIP",
      locations: "BC",
      budgetMin: 2500000,
      budgetMax: 5000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/alexdrummond",
      notes:
        "Victoria-based MSP. Wants Vancouver presence. Interested in healthcare and legal vertical clients specifically.",
    },
    // PE-backed IT platforms (4)
    {
      name: "Brendan Hayes",
      email: "bhayes@nortechpartners.com",
      company: "NorTech Partners",
      type: "financial",
      phone: "416-555-5004",
      industries: "IT Services;MSP",
      locations: "Canada",
      budgetMin: 3000000,
      budgetMax: 8000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/brendanhayes",
      notes:
        "PE-backed MSP platform. 14 acquisitions completed. Targets 3-5x MRR. Wants BC as next market entry.",
    },
    {
      name: "Katherine Wu",
      email: "kwu@techrollup.ca",
      company: "TechRollup Capital",
      type: "financial",
      phone: "604-555-5005",
      industries: "IT Services;Cybersecurity;Cloud",
      locations: "BC;Ontario",
      budgetMin: 4000000,
      budgetMax: 8000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/katherinewu",
      notes:
        "Growth equity fund. Focused on IT services with >60% recurring revenue. Wants Microsoft CSP tier and SOC 2 compliance.",
    },
    {
      name: "Patrick Grenville",
      email: "pgrenville@connectcapital.com",
      company: "Connect Capital Group",
      type: "financial",
      phone: "647-555-5006",
      industries: "MSP;IT Services;Telecommunications",
      locations: "Canada",
      budgetMin: 2500000,
      budgetMax: 7000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/patrickgrenville",
      notes:
        "Independent sponsor backed by family offices. First MSP acquisition. Wants stable MRR and low client churn (<5%).",
    },
    {
      name: "Angela Chow",
      email: "achow@pacificventurespe.com",
      company: "Pacific Ventures PE",
      type: "financial",
      phone: "604-555-5007",
      industries: "IT Services;SaaS;MSP",
      locations: "BC;Western Canada",
      budgetMin: 3000000,
      budgetMax: 6000000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/angelachow",
      notes:
        "Regional PE. Wants MSP with Datto relationship and strong NOC/helpdesk team. Values client NPS and retention metrics.",
    },
    // MBO candidates / individual operators (3)
    {
      name: "Steve Baxter",
      email: "sbaxter@gmail.com",
      company: "(Individual)",
      type: "individual",
      phone: "604-555-5008",
      industries: "IT Services;MSP",
      locations: "BC;Vancouver",
      budgetMin: 1500000,
      budgetMax: 3000000,
      proofOfFunds: false,
      linkedin: "linkedin.com/in/stevebaxter",
      notes:
        "Current IT director at mid-size firm. 15 years MSP experience. SBA-backed acquisition. Wants owner-operator role.",
    },
    {
      name: "Maria Santos",
      email: "msantos@techforwardconsulting.ca",
      company: "TechForward Consulting",
      type: "individual",
      phone: "604-555-5009",
      industries: "IT Services;Cloud Migration",
      locations: "Vancouver;Lower Mainland",
      budgetMin: 1500000,
      budgetMax: 2500000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/mariasantos",
      notes:
        "Runs small IT consulting firm. Wants to acquire MRR base to stabilize revenue. Cloud migration and Azure specialty.",
    },
    {
      name: "Tyler Andersen",
      email: "tandersen@andersentech.ca",
      company: "Andersen Technology Services",
      type: "individual",
      phone: "778-555-5010",
      industries: "MSP;IT Support",
      locations: "BC",
      budgetMin: 2000000,
      budgetMax: 3500000,
      proofOfFunds: true,
      linkedin: "linkedin.com/in/tylerandersen",
      notes:
        "Former MSP co-founder (sold 2022). Looking to acquire and grow another. Knows the playbook. Interested in industry vertical clients.",
    },
  ];
}

// ─── 6. Construction Equipment List (XLSX) ──────────────────────────────────

function constructionEquipmentSheet(): SheetDef {
  const header: Row = [
    "Item #",
    "Description",
    "Make/Model",
    "Year",
    "Condition",
    "Ownership",
    "Original Cost",
    "Current Book Value",
    "Est. Market Value",
    "Monthly Payment",
    "Lien Holder",
    "Notes",
  ];

  const items: Row[] = [
    [1, "Hydraulic Excavator", "CAT 320", 2021, "Good", "Owned", 285000, 180000, 195000, null, null, "Primary excavator. 3,200 hours. Annual service up to date."],
    [2, "Mini Excavator", "CAT 308", 2019, "Good", "Owned", 125000, 68000, 75000, null, null, "Used for residential and tight-access sites. 2,800 hours."],
    [3, "Mini Excavator", "Kubota KX040", 2017, "Fair", "Owned", 65000, 22000, 28000, null, null, "Backup unit. Hydraulic leak repaired Q3 2025. 4,100 hours."],
    [4, "Dump Truck", "Kenworth T880", 2022, "Good", "Financed", 175000, 120000, 130000, 2850, "RBC Equipment Finance", "Tri-axle. 85,000 km. Lease matures June 2027."],
    [5, "Dump Truck", "Mack Granite", 2020, "Good", "Financed", 155000, 85000, 95000, 2200, "TD Equipment Finance", "Tandem axle. 110,000 km. Lease matures March 2026."],
    [6, "Service Truck", "Ford F-550", 2021, "Good", "Owned", 78000, 48000, 52000, null, null, "Crane-equipped service body. Mobile welding/tool storage."],
    [7, "Crew Cab Trucks (x3)", "Ford F-150", "2019-2023", "Various", "Owned", 155000, 85000, 92000, null, null, "3 units: 2019 XLT, 2021 Lariat, 2023 XLT. Supervisor vehicles."],
    [8, "Boom Lift", "JLG 450AJ", 2018, "Good", "Owned", 95000, 42000, 48000, null, null, "45ft articulating. Annual inspection current. 1,900 hours."],
    [9, "Scaffolding System (complete)", "Layher Allround", "Various", "Good", "Owned", 45000, 20000, 25000, null, null, "Full system: frames, planks, braces, casters. Covers 4-storey."],
    [10, "Power Tool Fleet", "Hilti Fleet Management", "Various", "Good", "Owned", 35000, 15000, 18000, null, null, "Rotary hammers, core drills, powder-actuated. Hilti service contract."],
    [11, "Survey/Layout Equipment", "Trimble SPS986 + TSC7", 2020, "Excellent", "Owned", 28000, 18000, 20000, null, null, "GNSS receiver + data collector. Calibrated Q1 2026."],
    [12, "Job Site Trailers (x2)", "Atco/Williams Scotsman", 2018, "Fair", "Owned", 24000, 8000, 10000, null, null, "8x32 office trailer + 8x20 storage trailer. Functional, cosmetically worn."],
    [13, "Compressor & Air Tools", "Atlas Copco XAS 185", "Various", "Good", "Owned", 18000, 8000, 10000, null, null, "Tow-behind compressor + pneumatic nailers, breakers, drills."],
    [14, "Concrete Forms & Accessories", "Doka/Peri", "Various", "Good", "Owned", 22000, 10000, 12000, null, null, "Wall forms, column forms, snap ties, walers. Covers typical foundation pour."],
    [15, "Safety Equipment", "Various (3M, MSA, Miller)", "Various", "Good", "Owned", 15000, 8000, 8000, null, null, "Harnesses, lanyards, PPE kits, signage, barricades. OHSA-compliant."],
    [16, "Storage Containers (x3)", "Seacan 20ft", 2019, "Good", "Owned", 12000, 9000, 9000, null, null, "3 painted steel containers. 2 on current job site, 1 at yard."],
    [17, "Small Tools & Hand Tools", "Various (Milwaukee, DeWalt)", "Various", "Various", "Owned", 25000, 12000, 12000, null, null, "Complete inventory: saws, drills, levels, hand tools. Replaced on wear schedule."],
    [18, "Office Equipment & IT", "Various", "Various", "Good", "Owned", 18000, 8000, 6000, null, null, "Desktops, laptops, printers, Procore licenses, network equipment."],
  ];

  const summaryRows: Row[] = [
    [],
    ["", "SUMMARY", null, null, null, null, null, null, null, null, null, null],
    ["", "Total Owned Assets", null, null, null, "Owned", null, 648000, 710000, null, null, null],
    ["", "Total Financed Assets", null, null, null, "Financed", null, 205000, 225000, 5050, null, null],
    ["", "GRAND TOTAL", null, null, null, null, 1378000, 853000, 935000, 5050, null, null],
  ];

  return {
    name: "Equipment List",
    data: [header, ...items, ...summaryRows],
    colWidths: [8, 30, 28, 12, 12, 12, 14, 16, 16, 16, 22, 55],
  };
}

// ─── 7. Manufacturing Equipment List with Ages (XLSX) ───────────────────────

function manufacturingEquipmentSheet(): SheetDef {
  const header: Row = [
    "Item #",
    "Description",
    "Make/Model",
    "Year",
    "Condition",
    "Ownership",
    "Original Cost",
    "Current Book Value",
    "Est. Market Value",
    "Monthly Payment",
    "Lien Holder",
    "Last Maintenance",
    "Notes",
  ];

  const items: Row[] = [
    [1, "CNC Vertical Machining Center", "Haas VF-4", 2022, "Excellent", "Financed", 165000, 120000, 130000, 3200, "CWB Equipment Finance", "2026-01-15", "40x20x25 travels. 10K spindle. 4th axis ready. 2,400 hours. Annual PM completed."],
    [2, "CNC Vertical Machining Center", "Haas VF-4", 2018, "Good", "Owned", 145000, 52000, 68000, null, null, "2025-11-20", "Same model as #1. 6,800 hours. Spindle rebuild 2024. Workhorse machine."],
    [3, "CNC Turning Center", "Mazak QT-250", 2020, "Good", "Owned", 185000, 95000, 110000, null, null, "2026-02-10", "10-inch chuck. Bar feeder equipped. 3,100 hours. Runs lights-out production."],
    [4, "CNC Lathe", "Okuma LB3000 EX II", 2014, "Fair", "Owned", 210000, 42000, 55000, null, null, "2025-09-05", "12-inch chuck. Live tooling. 9,200 hours. Turret motor replaced 2025. Functional but aging."],
    [5, "CNC Press Brake", "Amada HFE 1003", 2019, "Good", "Financed", 135000, 68000, 78000, 2400, "RBC Equipment Finance", "2025-12-01", "100-ton x 10ft. CNC back gauge. Crowning system. Lease matures Sept 2026."],
    [6, "Hydraulic Press Brake", "Cincinnati 90-8", 2012, "Fair", "Owned", 85000, 15000, 22000, null, null, "2025-06-15", "90-ton x 8ft. Manual back gauge. Used for short runs and prototypes."],
    [7, "MIG Welding Stations (x4)", "Miller Deltaweld 500", "2018-2022", "Good", "Owned", 48000, 22000, 26000, null, null, "2026-03-01", "4 complete stations with feeders, torches, fume extractors. Annual wire liner replacement done."],
    [8, "TIG Welding Stations (x2)", "Lincoln Precision TIG 375", "2020-2021", "Good", "Owned", 18000, 10000, 12000, null, null, "2025-10-10", "2 stations for stainless and aluminum work. CWB-qualified processes."],
    [9, "Stick Welding Units (x2)", "Lincoln Idealarc DC-600", "2015-2016", "Fair", "Owned", 8000, 2000, 3000, null, null, "2025-08-20", "Shop and field stick welding. Heavy-duty. Consumables stocked."],
    [10, "Paint Booth (full enclosure)", "Global Finishing Solutions", 2019, "Good", "Owned", 125000, 62000, 70000, null, null, "2026-01-30", "24x14x10 downdraft. Heated cure cycle. Meets VOC regulations. Filters replaced quarterly."],
    [11, "Overhead Bridge Crane", "Demag 10-ton", 2016, "Good", "Owned", 85000, 38000, 42000, null, null, "2025-12-15", "10-ton capacity. 50ft span. Electric hoist. Annual inspection & load test current."],
    [12, "Overhead Bridge Crane", "Demag 5-ton", 2014, "Good", "Owned", 48000, 18000, 22000, null, null, "2025-12-15", "5-ton capacity. 30ft span. Welding bay crane. Inspected same schedule as #11."],
    [13, "Forklift", "Toyota 8FGU25", 2021, "Good", "Owned", 35000, 22000, 24000, null, null, "2026-02-15", "5,000 lb capacity. Propane. Indoor/outdoor. 2,100 hours."],
    [14, "Forklift", "Toyota 8FGU30", 2018, "Good", "Owned", 38000, 15000, 18000, null, null, "2025-11-01", "6,000 lb capacity. Propane. Primarily yard use. 3,800 hours."],
    [15, "Forklift", "CAT GP25N", 2016, "Fair", "Owned", 32000, 8000, 10000, null, null, "2025-07-20", "5,000 lb capacity. Propane. Backup unit. 5,200 hours. Needs mast chain."],
    [16, "Horizontal Band Saw", "DoAll C-916S", 2017, "Good", "Owned", 22000, 8000, 10000, null, null, "2025-10-25", "Semi-automatic. 16-inch round capacity. Blade replaced Q4 2025."],
    [17, "Vertical Band Saw", "Jet VBS-18MW", 2015, "Fair", "Owned", 8000, 2000, 3000, null, null, "2025-05-10", "Metal cutting. Used for custom plate cutting and templates."],
    [18, "Surface Grinder", "Okamoto ACC-1224ST", 2013, "Good", "Owned", 45000, 10000, 14000, null, null, "2025-09-30", "12x24 table. Precision work. Magnetic chuck in good condition."],
    [19, "CMM (Coordinate Measuring Machine)", "Mitutoyo Crysta-Apex S776", 2020, "Excellent", "Owned", 95000, 58000, 65000, null, null, "2026-03-10", "Motorized probe head. ISO-calibrated annually. Core QC equipment."],
    [20, "Precision Measuring & QC Equipment", "Various (Mitutoyo, Starrett)", "Various", "Good", "Owned", 25000, 15000, 16000, null, null, "2026-01-05", "Calipers, micrometers, height gauges, surface plates, bore gauges. Calibration current."],
    [21, "Material Handling & Racking", "Various (Interlake, Ridg-U-Rak)", "Various", "Good", "Owned", 28000, 14000, 15000, null, null, "2025-08-01", "Pallet racking, cantilever racks for bar stock, material carts, roller tables."],
    [22, "Office Equipment & IT", "Various", "Various", "Good", "Owned", 22000, 8000, 6000, null, null, "2026-02-01", "CAD workstations (SolidWorks), ERP system (JobBOSS), network, printers, office furniture."],
  ];

  const summaryRows: Row[] = [
    [],
    ["", "SUMMARY", null, null, null, null, null, null, null, null, null, null, null],
    ["", "Total Owned Assets", null, null, null, "Owned", null, 536000, 611000, null, null, null, null],
    ["", "Total Financed Assets", null, null, null, "Financed", null, 188000, 208000, 5600, null, null, null],
    ["", "GRAND TOTAL", null, null, null, null, 1797000, 724000, 819000, 5600, null, null, null],
    [],
    ["", "NOTES:", null, null, null, null, null, null, null, null, null, null, null],
    ["", "1. All CNC machines on preventive maintenance program (quarterly lube, annual spindle check).", null, null, null, null, null, null, null, null, null, null, null],
    ["", "2. Welding equipment CWB-certified. Re-certification due December 2026.", null, null, null, null, null, null, null, null, null, null, null],
    ["", "3. CMM calibration performed annually by Mitutoyo Canada (certificate on file).", null, null, null, null, null, null, null, null, null, null, null],
    ["", "4. Replacement cost estimate based on current new equipment pricing as of Q1 2026.", null, null, null, null, null, null, null, null, null, null, null],
    ["", "5. ISO 9001:2015 certified facility. Equipment maintenance records available for audit.", null, null, null, null, null, null, null, null, null, null, null],
  ];

  return {
    name: "Equipment List",
    data: [header, ...items, ...summaryRows],
    colWidths: [8, 32, 30, 12, 12, 12, 14, 16, 16, 16, 22, 16, 60],
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log("Generating buyer CSVs and equipment XLSX files...\n");

  // --- Buyer CSVs ---
  console.log("Buyer lists:");
  writeCsv(constructionBuyers(), "construction-ontario/buyers/buyer-list-15.csv");
  writeCsv(restaurantBuyers(), "restaurant-toronto/buyers/buyer-list-10.csv");
  writeCsv(medicalBuyers(), "medical-clinic-ontario/buyers/buyer-list-8.csv");
  writeCsv(manufacturingBuyers(), "manufacturing-alberta/buyers/buyer-list-12.csv");
  writeCsv(itMspBuyers(), "it-msp-bc/buyers/buyer-list-10.csv");

  // --- Equipment XLSX ---
  console.log("\nEquipment lists:");

  const constructionWb = buildWorkbook([constructionEquipmentSheet()]);
  writeWorkbook(constructionWb, "construction-ontario/operations/equipment-list.xlsx");

  const manufacturingWb = buildWorkbook([manufacturingEquipmentSheet()]);
  writeWorkbook(manufacturingWb, "manufacturing-alberta/operations/equipment-list-with-ages.xlsx");

  console.log("\nDone. Generated 5 CSV files and 2 XLSX files.");
}

main();
