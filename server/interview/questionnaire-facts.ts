/**
 * Intake answers as facts — pure, shared by the interview (seeding
 * extractedInfo from the questionnaire) and the broker's Information view
 * (tracing facts collected before sources were recorded back to the intake).
 */
import { KNOWN_EXTRACTED_FIELDS } from "./knowledge-base";
import { canonicalFieldName } from "./info-merger";

/**
 * Intake answers as coverage facts: the questionnaire's business basics
 * (canonicalised keys, coverage-known fields only), plus the intake's systems
 * list (→ operationalSystems) and staff list (→ employeeStructure, and the
 * people flagged as key → keyEmployees).
 */
export function questionnaireFacts(deal: {
  questionnaireData?: unknown;
  operationalSystems?: unknown;
  employeeChart?: unknown;
}): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const questionnaire = deal.questionnaireData as Record<string, unknown> | null;
  for (const [rawKey, rawValue] of Object.entries(questionnaire || {})) {
    if (typeof rawValue !== "string" || rawValue.trim() === "") continue;
    const key = canonicalFieldName(rawKey);
    if (!KNOWN_EXTRACTED_FIELDS.has(key)) continue;
    out.push([key, rawValue.trim()]);
  }
  const systems = deal.operationalSystems as Record<string, unknown> | null;
  if (systems && typeof systems === "object") {
    const labels: Record<string, string> = { accounting: "Accounting", crm: "CRM", pos: "POS", erp: "ERP", payroll: "Payroll" };
    const parts: string[] = [];
    for (const [k, label] of Object.entries(labels)) {
      const v = systems[k];
      if (typeof v === "string" && v.trim()) parts.push(`${label}: ${v.trim()}`);
    }
    const other = Array.isArray(systems.other) ? systems.other.map(String).map((x) => x.trim()).filter(Boolean) : [];
    if (other.length > 0) parts.push(`Other: ${other.join(", ")}`);
    if (parts.length > 0) out.push(["operationalSystems", parts.join("; ")]);
  }
  if (Array.isArray(deal.employeeChart)) {
    const people = (deal.employeeChart as Array<Record<string, unknown>>)
      .filter((e) => e && typeof e === "object" && typeof e.name === "string" && e.name.trim())
      .map((e) => {
        const role = typeof e.role === "string" && e.role.trim() ? ` — ${e.role.trim()}` : "";
        const yrs = typeof e.yearsWithCompany === "string" && e.yearsWithCompany.trim() ? ` (${e.yearsWithCompany.trim()} yrs)` : "";
        return { line: `${String(e.name).trim()}${role}${yrs}`, key: !!e.keyPerson };
      });
    if (people.length > 0) out.push(["employeeStructure", `Staff listed at intake: ${people.map((p) => p.line).join("; ")}`]);
    const keyPeople = people.filter((p) => p.key);
    if (keyPeople.length > 0) out.push(["keyEmployees", keyPeople.map((p) => p.line).join("; ")]);
  }
  return out;
}

