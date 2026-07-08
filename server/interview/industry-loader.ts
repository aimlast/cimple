import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * industry-loader
 *
 * The industry-intelligence.md corpus is ~4,500 lines / ~62K tokens covering
 * 14 industries. Injecting the whole thing on every interview turn buries the
 * ~2K tokens that matter for THIS seller under 60K tokens of irrelevance,
 * which dilutes the model's attention and makes every turn slow and expensive.
 *
 * This module parses the corpus once into a shared preamble (the "how to use"
 * guide + cross-industry universal fields, always relevant) plus one block per
 * industry, and hands back only the block that matches the deal's industry.
 * The relevant intelligence is now front-and-centre instead of drowned out.
 */

const __dir =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

const MD_PATH = join(__dir, "prompts", "industry-intelligence.md");

interface IndustrySection {
  num: number;
  name: string;
  text: string;
}

// ── Parse the corpus once at module load ────────────────────────────────────

function parseCorpus(): { preamble: string; sections: Map<number, IndustrySection> } {
  const raw = readFileSync(MD_PATH, "utf-8");
  const lines = raw.split("\n");

  // Industry sections start with a top-level heading like "# 3. RESTAURANTS ...".
  const headingRe = /^#\s+(\d+)\.\s+(.+)$/;
  const starts: Array<{ line: number; num: number; name: string }> = [];
  lines.forEach((ln, i) => {
    const m = ln.match(headingRe);
    if (m) starts.push({ line: i, num: parseInt(m[1], 10), name: m[2].trim() });
  });

  const firstStart = starts.length > 0 ? starts[0].line : lines.length;
  const preamble = lines.slice(0, firstStart).join("\n").trim();

  const sections = new Map<number, IndustrySection>();
  starts.forEach((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].line : lines.length;
    sections.set(s.num, {
      num: s.num,
      name: s.name,
      text: lines.slice(s.line, end).join("\n").trim(),
    });
  });

  return { preamble, sections };
}

const { preamble: PREAMBLE, sections: SECTIONS } = parseCorpus();

// ── Industry matching ───────────────────────────────────────────────────────

// Ordered keyword → section number. First match wins, so more specific/compound
// terms (e.g. "managed services") must come before generic ones (e.g. "tech").
const KEYWORD_MAP: Array<[RegExp, number]> = [
  // 1 — Construction / property
  [/construction|contract(or|ing)|general contract|specialty trade|electric|plumb|hvac|roofing|landscap|snow|restoration|remediation|civil|infrastructure|property manage|concrete|masonry|excavat/, 1],
  // 2 — Healthcare
  [/health\s?care|medical clinic|\bclinic\b|dental|dentist|\bmedical\b|physician|therapy|mental health|counsel|physio|chiro|optometr|audiolog|med\s?spa|aesthetic|pharmac|home care|diagnostic|imaging|\bmedic\b/, 2],
  // 3 — Restaurants / food service
  [/restaurant|food service|\bfood\b|dining|\bcafe\b|coffee shop|\bbar\b|pub\b|nightclub|catering|bakery|quick service|fast casual|ghost kitchen|cpg|beverage/, 3],
  // 4 — Manufacturing
  [/manufactur|fabricat|\bmetal\b|woodwork|millwork|printing|packaging|\bfactory\b|machin(e|ing) shop|assembly|industrial product/, 4],
  // 5 — Professional services (IT/MSP lives here, not under generic "technology")
  [/managed service|\bmsp\b|\bit\s*\/|\bit\s+service|information technology|accounting|bookkeep|\blegal\b|\blaw\b|attorney|engineer(ing)? firm|architect|advertis(ing)? agenc|marketing agenc|staffing|recruit|\bhr\b|human resource|financial advis|wealth manage|consult|professional service/, 5],
  // 6 — Automotive
  [/automotiv|\bauto\b|\bcar\b|vehicle|collision|body shop|car wash|dealership|detailing|mechanic|tire\b/, 6],
  // 7 — Retail
  [/retail|\bstore\b|\bshop\b|grocery|convenience|liquor|\bvape\b|cannabis|dispensary|boutique|merchandis/, 7],
  // 8 — Wholesale / distribution
  [/wholesale|distribut|\bdistributor\b|supply chain|import\/export/, 8],
  // 9 — Transportation / logistics
  [/transport|logistic|trucking|\bfreight\b|courier|last[-\s]?mile|\bdelivery\b|moving compan|\bmovers\b|warehous|\b3pl\b|fleet/, 9],
  // 10 — Wellness / fitness / lifestyle
  [/wellness|fitness|\bgym\b|\byoga\b|pilates|\bspa\b|salon|barber|\bnails?\b|tattoo|tanning|massage|aesthetician/, 10],
  // 11 — Education
  [/education|\bschool\b|tutor|training center|academy|\bcollege\b|daycare curricul|e-?learning|montessori/, 11],
  // 12 — Childcare / entertainment
  [/child\s?care|daycare|day care|preschool|entertainment|amusement|arcade|trampoline|play\s?(centre|center)|birthday part/, 12],
  // 13 — Advertising / media / events
  [/\bmedia\b|event (planning|manage|production)|public relations|\bpr\b agency|video production|film|photography studio|broadcast|publish/, 13],
  // 14 — Technology / online
  [/technolog|\bsaas\b|software|\bapp\b|online business|e-?commerce|\btech\b|digital product|platform|\bstartup\b|web (app|service)|\bai\b (company|startup)|marketplace/, 14],
];

/**
 * Resolve a free-text industry (and optional sub-industry) to a corpus section
 * number, or null if nothing matches confidently.
 */
export function matchIndustrySection(
  industry?: string | null,
  subIndustry?: string | null,
): number | null {
  const hay = `${industry ?? ""} ${subIndustry ?? ""}`.toLowerCase().trim();
  if (!hay) return null;
  for (const [re, num] of KEYWORD_MAP) {
    if (re.test(hay)) return num;
  }
  return null;
}

/**
 * Build the industry-intelligence portion of the system prompt.
 *
 * When the industry is known, returns the always-relevant preamble plus only
 * that industry's section. When it isn't (early turns, or an unrecognised
 * type), returns the preamble plus a compact taxonomy and an instruction to
 * identify the industry first — the detailed block loads once it's known.
 */
export function buildIndustryKnowledge(
  industry?: string | null,
  subIndustry?: string | null,
): string {
  const num = matchIndustrySection(industry, subIndustry);
  if (num != null && SECTIONS.has(num)) {
    const section = SECTIONS.get(num)!;
    return `${PREAMBLE}\n\n---\n\n# INDUSTRY-SPECIFIC INTELLIGENCE FOR THIS BUSINESS\n\nThe business is in: **${industry}**${subIndustry ? ` (${subIndustry})` : ""}. The full industry-specific playbook for this business type is below. Cover every [CRITICAL] field, and use the buyer-rationale and retrieval instructions when the seller needs them.\n\n${section.text}`;
  }

  // Unknown industry — keep it lean, name the taxonomy, ask the agent to identify.
  const taxonomy = Array.from(SECTIONS.values())
    .sort((a, b) => a.num - b.num)
    .map((s) => `${s.num}. ${s.name}`)
    .join("\n");
  return `${PREAMBLE}\n\n---\n\n# IDENTIFY THE INDUSTRY FIRST\n\nThe business type is not yet confirmed. Your early questions should establish what the business does and where it operates. Once you know, the detailed industry-specific playbook loads automatically on the next turn. The industries covered are:\n\n${taxonomy}`;
}

/** Exposed for tests / diagnostics. */
export function industryCorpusStats() {
  return { sectionCount: SECTIONS.size, preambleChars: PREAMBLE.length };
}
