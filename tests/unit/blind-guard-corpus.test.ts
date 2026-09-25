/**
 * Blind-CIM identity guard — regression corpus (shared/blind-guard.ts).
 *   npx tsx tests/unit/blind-guard-corpus.test.ts
 *   BLIND_CORPUS_DB=1 DATABASE_URL=… npx tsx tests/unit/blind-guard-corpus.test.ts
 *     (also reads every deal of the qa_cimgen and qa_interview accounts,
 *      read-only, and checks the same invariants on their real facts)
 *
 * From the 2026-09-25 round-4 review of the guard:
 *   1. FAIL-CLOSED — people named in people facts are identifiers whatever
 *      follows the name: "Carlos Reyes (12)", "Hygienists: Priya (7),
 *      Thomas (3)", "Office Manager: Amy Evans (12)", "Chris Jones: 6 yrs;
 *      Ana Torres: 4", "Maria Teller (bookkeeper)". Business names, city
 *      (any case — "KITCHENER"), street, postal code, email, phone, website
 *      are always caught.
 *   2. CONSERVATIVE — job titles and staffing phrases never become
 *      identifiers ("Patient Care Coordinator", "Lawn Care Technician",
 *      "Accounts Payable Specialist", "Night Shift Supervisor"…), and a
 *      blind text may say "patient care", "quality control", "winter".
 *   3. A single everyday word is an identifier only as the whole fact (a
 *      town called Normal — capitalised only) or with its full name or a
 *      title ("Emma Winter", "Ms. Winter"), never as "winter" or "frost".
 */
import assert from "node:assert/strict";
import { blindLeakTerms, findBlindLeaks, foldForMatch, type BlindTerm } from "../../shared/blind-guard";
import { blindIdentifiers } from "../../shared/blind-identifiers";
import { CLEAN_BLIND_COPY, corpus, staffDeal, type Deal } from "./blind-guard-corpus.data";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const termsOf = (d: Deal) => blindLeakTerms(d, { codename: d.blindCodename ?? "Project Keystone" });
const caught = (text: string, terms: BlindTerm[]) => findBlindLeaks(text, terms).length > 0;

// ── The review's concrete examples ───────────────────────────────────────
console.log("review examples");

const staffTerms = termsOf(staffDeal);
const staffText = staffTerms.map((t) => t.text);

test("a name followed by a head count, colon or bracket is still a person", () => {
  for (const s of [
    "Carlos Reyes leads installs", "Ana Torres", "Sam Kim", "Priya", "Thomas has 3 years", "Marcus", "Amy Evans",
    "Chris Jones", "Maria Teller", "MARIA TELLER keeps the books", "Carlos (12)", "carlos runs the crew", "Mr. Evans",
  ]) {
    assert.ok(caught(s, staffTerms), `not caught: ${s} — ${staffText.join(" | ")}`);
  }
});

test("KITCHENER in any case", () => {
  for (const s of ["KITCHENER", "Kitchener", "kitchener", "KITCHENER'S busiest plaza", "Kitchener-Waterloo"]) {
    assert.ok(caught(s, staffTerms), s);
  }
});

test("job titles never become identifiers", () => {
  const titleWords = [
    "Patient Care", "Care", "Lawn Care", "Body Shop", "Shop", "Social Media", "Media", "Fleet Maintenance", "Maintenance",
    "Accounts Payable", "Payable", "Business Development", "Development", "Quality Control", "Control", "Human Resources",
    "Resources", "Customer Success", "Success", "Night Shift", "Shift", "Specialist", "Coordinator",
  ];
  for (const w of titleWords) assert.ok(!staffText.includes(w), `title word became a term: ${w} — ${staffText.join(" | ")}`);
  const blindCopy =
    "Our Patient Care Coordinator and Night Shift Supervisor keep patient care consistent; quality control, accounts payable, " +
    "business development and human resources are handled in-house. The Lawn Care Technician, Body Shop Manager, " +
    "Social Media Manager, Fleet Maintenance Supervisor, Customer Success Lead and Quality Control Manager round out the team.";
  assert.deepEqual(findBlindLeaks(blindCopy, staffTerms), []);
});

test("everyday-word surnames: the full name or a title, never the word", () => {
  assert.ok(caught("Emma Winter runs dispatch", staffTerms));
  assert.ok(caught("Ms. Winter runs dispatch", staffTerms));
  assert.ok(caught("DR. FROST", staffTerms));
  assert.ok(caught("the Barber family", staffTerms));
  assert.ok(caught("Jack Frost installs", staffTerms));
  for (const s of [
    "Revenue dips in winter; frost dates drive the spring rush.",
    "Winter is the slow season.",
    "A barber shop and a painter share the plaza.",
    "Tellers, barbers and painters",
  ]) {
    assert.deepEqual(findBlindLeaks(s, staffTerms), [], s);
  }
  for (const w of ["Winter", "Frost", "Barber", "Painter", "Teller"]) assert.ok(!staffText.includes(w), `bare everyday surname: ${w}`);
});

test("a town that is an everyday word counts capitalised, not as the word", () => {
  for (const town of ["Normal", "Mobile", "Reading", "Olds", "Hope"]) {
    const t = termsOf({ businessName: "X Corp", extractedInfo: { city: town } });
    assert.ok(caught(`Located in ${town}, near the highway`, t), `${town} capitalised`);
    assert.ok(caught(`LOCATED IN ${town.toUpperCase()}`, t), `${town} in capitals`);
  }
  const t = termsOf({ businessName: "X Corp", extractedInfo: { city: "Normal" } });
  assert.deepEqual(findBlindLeaks("a normal schedule with 5-year-olds and mobile reading programs", t), []);
});

test("occupation surnames are surnames after a given name", () => {
  const t = termsOf({ businessName: "X Corp", extractedInfo: { keyEmployees: "Ana Broker, Bob Buyer (sales), Jim Agent, Liz Server" } });
  for (const s of ["Ana Broker", "Bob Buyer", "Jim Agent", "Liz Server", "Mr. Agent"]) assert.ok(caught(s, t), s);
  assert.deepEqual(findBlindLeaks("The broker, the buyer's agent and the server room.", t), []);
});

test("unfamiliar names count only as a whole list entry", () => {
  const t = termsOf({
    businessName: "X Corp",
    extractedInfo: { staff: "Xiaoling Wu (12), Oluwaseun Adeyemi: 4 yrs, Ownership (100%), Scheduling (2), Bathers (2), RDH (2)" },
  });
  const tt = t.map((x) => x.text);
  assert.ok(caught("Xiaoling Wu", t) && caught("ADEYEMI", t));
  for (const w of ["Ownership", "Scheduling", "Bathers", "RDH"]) assert.ok(!tt.includes(w), `${w} became a term`);
});

// ── A corpus of realistic deals ──────────────────────────────────────────
console.log("corpus");

test("every known identifier in the corpus is caught", () => {
  for (const d of corpus) {
    const t = termsOf(d);
    for (const s of d.mustCatch) assert.ok(caught(s, t), `${d.businessName}: not caught "${s}" — ${t.map((x) => x.text).join(" | ")}`);
  }
});

test("no role or everyday phrase in the corpus becomes a term", () => {
  for (const d of corpus) {
    const tt = termsOf(d).map((x) => x.text);
    for (const w of d.neverTerms ?? []) assert.ok(!tt.includes(w), `${d.businessName}: "${w}" became a term — ${tt.join(" | ")}`);
  }
});

test("a clean blind text passes against every corpus deal", () => {
  for (const d of [...corpus, staffDeal]) {
    const t = termsOf(d);
    for (const s of CLEAN_BLIND_COPY) assert.deepEqual(findBlindLeaks(s, t), [], `${d.businessName}: "${s}"`);
  }
});

// ── Invariants, run on the synthetic corpus and (opt-in) the QA accounts' real deals ──

/** The structured values a deal's facts hold for certain: business names, owner, name fields, city. */
function certainValues(d: Deal): string[] {
  const info = d.extractedInfo || {};
  const out: string[] = [...blindIdentifiers({ businessName: d.businessName, extractedInfo: info as any })];
  const text = (v: unknown): string | null =>
    typeof v === "string" ? v : v && typeof v === "object" && "value" in (v as any) ? text((v as any).value) : null;
  for (const k of ["city", "town"]) {
    const v = text(info[k]);
    if (v && v.trim().length >= 3) out.push(v);
  }
  const walk = (v: unknown, depth = 0) => {
    if (depth > 4 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "string" && /^(?:name|fullName|contactName|personName)$/.test(k) && x.trim().length >= 3) out.push(x);
      else walk(x, depth + 1);
    }
  };
  walk(info);
  // A placeholder or a job in a name slot ("TBD", "Office Manager") isn't a person.
  return out.filter(
    (v) =>
      !/^\s*(?:n\/a|none|unknown|tbd|tba|vacant|not provided)\s*$/i.test(v) &&
      !/^(?:[A-Za-z]+\s+)?(?:manager|owner|director|supervisor|coordinator|assistant|technician|lead|staff|team)s?$/i.test(v.trim()),
  );
}

function checkInvariants(d: Deal, label: string, problems: string[]) {
  const terms = termsOf(d);
  const code = ` ${foldForMatch(d.blindCodename ?? "Project Keystone")} `;
  for (const v of certainValues(d)) {
    if (code.includes(` ${foldForMatch(v)} `)) continue;
    if (!caught(v, terms)) problems.push(`${label}: certain value not caught: "${v}"`);
  }
  for (const t of terms) {
    if (t.kind !== "person" || t.common || t.titled) continue;
    const words = foldForMatch(t.text).split(" ");
    // A person term made only of everyday words must be a one-word fact (flagged common) — never "Patient Care".
    if (words.length > 1 && words.every((w) => EVERYDAY.has(w))) problems.push(`${label}: everyday phrase became a person: "${t.text}"`);
  }
  for (const s of CLEAN_BLIND_COPY) {
    const hits = findBlindLeaks(s, terms);
    if (hits.length) problems.push(`${label}: clean copy flagged ${JSON.stringify(hits)} in "${s.slice(0, 60)}…"`);
  }
}
const EVERYDAY = new Set(
  "patient care coordinator lawn technician body shop manager social media fleet maintenance supervisor accounts payable specialist business development quality control human resources customer success lead night shift front desk office service sales team crew staff".split(" "),
);

test("invariants hold on the synthetic corpus", () => {
  const problems: string[] = [];
  for (const d of [...corpus, staffDeal]) checkInvariants(d, d.businessName, problems);
  assert.deepEqual(problems, []);
});

async function dbCorpus() {
  if (process.env.BLIND_CORPUS_DB !== "1") return;
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Read-only: the two QA accounts' deals.
    const { rows } = await pool.query(
      `select d.business_name, d.blind_codename, d.extracted_info
         from deals d join users u on u.id = d.broker_id
        where u.username in ('qa_cimgen', 'qa_interview')`,
    );
    const problems: string[] = [];
    for (const r of rows) {
      checkInvariants({ businessName: r.business_name, blindCodename: r.blind_codename ?? undefined, extractedInfo: r.extracted_info ?? {} }, r.business_name, problems);
    }
    console.log(`  QA accounts: ${rows.length} deals checked`);
    for (const p of problems) console.log(`    ✗ ${p}`);
    assert.deepEqual(problems, []);
    passed++;
    console.log("  ✓ invariants hold on every QA-account deal");
  } finally {
    await pool.end();
  }
}

dbCorpus().then(() => console.log(`\n${passed} checks passed`));
