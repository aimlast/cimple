/**
 * seller-voice — the interviewer talks TO the seller, not about them.
 *
 * Facts on file are written in the third person ("Diane and Rob have
 * personally guaranteed the First Maumee debt", "Tony's G1 certificate"),
 * and the agent sometimes carried that voice straight into the question it
 * put to that very person (acceptance test, Great Lakes, speaking to Diane:
 * "When Diane and Rob's non-compete period ends…", "Diane and Rob have
 * personally guaranteed the bank debt…"). The prompt tells the agent who it
 * is talking to and to re-voice facts; this pass is the mechanical backstop
 * for the forms that can be re-voiced without guessing at grammar:
 *
 *   "Diane and Rob's X"          → "your and Rob's X"
 *   "Diane's X"                  → "your X"
 *   "Diane and Rob" (any role)   → "you and Rob"
 *   "Diane has / is / was / does" → "you have / are / were / do"
 *   "Diane will / would / can …" → "you will / would / can …"
 *   "for / to / with / by … Diane" → "for / to / with / by … you"
 *
 * The name as a greeting ("Diane, …", "…, Diane?") is kept. A first name
 * that someone else on file also goes by is left alone (only the full name
 * is re-voiced then), and so is one that is also a month, a place or a word
 * ("May", "Victoria", "Grant"). A name that runs on into another proper
 * name ("Diane Smith", "Tony Moretti Holdings Ltd."), a business named for
 * the seller ("Tony's Pizza"), a date ("May 31") and a quotation are never
 * touched. Pure.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const BE_HAVE: Record<string, string> = { has: "have", is: "are", was: "were", does: "do", "hasn't": "haven't", "isn't": "aren't", "wasn't": "weren't", "doesn't": "don't" };
const MODALS = "will|would|can|could|should|might|may|must|did|had|didn't|won't|wouldn't|can't|couldn't|shouldn't";
const PREPS = "for|to|with|by|from|about|than|like|on|and|between";

/** Given names that are also months, places or common words — never re-voiced on their own. */
const AMBIGUOUS_GIVEN = new Set(
  (
    "April May June July August January March " +
    "Victoria Regina Georgia Austin Florence Sydney Paris Chelsea Jordan Virginia Carolina Madison Lincoln Dallas Houston Aurora Charlotte Denver Phoenix Orlando Surrey Windsor Kingston Brandon Chester " +
    "Will Mark Bill Grant Chase Hope Faith Joy Dawn Rose Summer Autumn Winter Sterling Rich Frank Page Hunter Cash Price Royal Crystal Penny Destiny Harmony Lane Sky River Stone Drew Art Sandy Miles Norm King Major"
  ).split(" "),
);

/**
 * The names the seller goes by: the full name and the first name (a
 * courtesy title dropped: "Dr. Amrit Sandhu" → "Amrit Sandhu", "Amrit"),
 * plus a nickname in quotes or parentheses ("Anthony (Tony) Moretti" →
 * "Tony"). A first name another person on file shares ("Luis Herrera" and
 * "Luis Fernandes" in `otherText`) is not used on its own.
 */
export function sellerNamesFrom(fullName: string | null | undefined, otherText = ""): string[] {
  const raw = String(fullName ?? "").replace(/\b(?:Dr|Mr|Mrs|Ms|Mx|Prof)\.?\s+/g, "").replace(/\s+/g, " ").trim();
  if (!raw || !/^[A-Z]/.test(raw)) return [];
  const nick = raw.match(/[("“']([A-Z][a-z]+)[)"”']/)?.[1];
  const plain = raw.replace(/\s*[("“'][A-Z][a-z]+[)"”']\s*/g, " ").replace(/\s+/g, " ").trim();
  const parts = plain.split(" ");
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const out: string[] = [];
  if (parts.length > 1) out.push(plain);
  if (nick && last) out.push(`${nick} ${last}`);
  const sharedBy = (given: string) =>
    last !== "" && new RegExp(`\\b${esc(given)}\\s+(?!${esc(last)}\\b|and\\b|or\\b)[A-Z][a-z]+`).test(otherText);
  for (const given of [first, nick]) {
    if (!given || given.length < 3 || !/^[A-Z][a-z]+$/.test(given)) continue;
    // A given name that is also a month, a place or a word ("by May 31",
    // "Victoria has the higher rent", "Grant has been approved") is
    // re-voiced only as the full name.
    if (AMBIGUOUS_GIVEN.has(given)) continue;
    if (!sharedBy(given)) out.push(given);
  }
  // Longest first: "Diane Kline-Morrow" before "Diane".
  return Array.from(new Set(out)).sort((a, b) => b.length - a.length);
}

/** True when the match at `index` starts a sentence. */
const startsSentence = (text: string, index: number) => /(?:^|[.!?]\s+|\n\s*)$/.test(text.slice(0, index));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The seller's name used as a greeting: "Diane, …" at the start, or "…, Diane?" / "…, Diane." */
function isVocative(text: string, index: number, length: number): boolean {
  const before = text.slice(0, index);
  const after = text.slice(index + length);
  if (/(?:^|[.!?]\s+)$/.test(before) && /^\s*[,—–]/.test(after)) return true;
  if (/,\s*$/.test(before) && /^\s*(?:[,.?!—–]|$)/.test(after)) return true;
  return /\b(?:thanks|thank you|hi|hello|welcome back|good to (?:see|talk to) you),?\s*$/i.test(before);
}

/** Spans of quoted text ("…", “…”, «…») — a quotation keeps its words. */
function quotedSpans(text: string): Array<[number, number]> {
  return Array.from(text.matchAll(/“[^”]*”|«[^»]*»|"[^"]*"/g)).map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

/**
 * The name at `nameAt` is not the seller spoken of, or not only them: part
 * of a longer proper name — a surname or a company after it ("Diane Smith",
 * the controller, when the seller is Diane Kline-Morrow; "Tony Moretti
 * Holdings Ltd."), a business named for them ("Tony's Pizza", "Tony's
 * Heating & Cooling"); a date ("May 31"); or inside a quotation.
 */
function notTheSeller(text: string, nameAt: number, name: string, matchEnd: number, quoted: Array<[number, number]>): boolean {
  if (quoted.some(([a, b]) => nameAt > a && nameAt < b)) return true;
  const afterName = text.slice(nameAt + name.length);
  if (/^\s+[A-Z][a-z]/.test(afterName) || /^\s*\d/.test(afterName)) return true;
  // A possessive followed by a capitalised word names a business, not the seller's own thing.
  if (/^['’]s\s+[A-Z][a-z]/.test(afterName)) return true;
  // (…and the second name of "Diane and Rob's …" likewise.)
  return /['’]s$/.test(text.slice(nameAt, matchEnd)) && /^\s+[A-Z][a-z]/.test(text.slice(matchEnd));
}

/** Re-voices third-person mentions of the seller to "you" (see the module comment). */
export function revoiceSeller(message: string, names: string[]): { message: string; fixes: string[] } {
  const fixes: string[] = [];
  let text = message;
  for (const name of names) {
    const n = esc(name);
    const rules: Array<[RegExp, (m: RegExpExecArray) => string]> = [
      // "Diane and Rob's non-compete" → "your and Rob's non-compete"
      [new RegExp(`\\b${n} and ([A-Z][a-z]+)(['’]s)\\b`, "g"), (m) => `your and ${m[1]}${m[2]}`],
      // "Diane's plans" → "your plans"
      [new RegExp(`\\b${n}['’]s\\b`, "g"), () => "your"],
      // "Diane and Rob have …" / "… by Diane and Rob"
      [new RegExp(`\\b${n} and ([A-Z][a-z]+)\\b`, "g"), (m) => `you and ${m[1]}`],
      // "Diane has" → "you have"
      [new RegExp(`\\b${n} (has|is|was|does|hasn't|isn't|wasn't|doesn't)\\b`, "g"), (m) => `you ${BE_HAVE[m[1]]}`],
      // "Diane will" → "you will"
      [new RegExp(`\\b${n} (${MODALS})\\b`, "g"), (m) => `you ${m[1]}`],
      // "for Diane" → "for you"
      [new RegExp(`\\b(${PREPS}) ${n}\\b(?!['’]s)`, "g"), (m) => `${m[1]} you`],
    ];
    for (const [re, to] of rules) {
      let out = "";
      let last = 0;
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      const quoted = quotedSpans(text);
      while ((m = re.exec(text)) !== null) {
        // (The name itself starts after a leading preposition.)
        const nameAt = m[0].startsWith(name) ? m.index : m.index + m[0].indexOf(name);
        if (isVocative(text, nameAt, name.length)) continue;
        if (notTheSeller(text, nameAt, name, m.index + m[0].length, quoted)) continue;
        let rep = to(m);
        if (m.index === nameAt && startsSentence(text, m.index)) rep = cap(rep);
        out += text.slice(last, m.index) + rep;
        last = m.index + m[0].length;
        fixes.push(`${m[0]} → ${rep}`);
      }
      if (last > 0) text = out + text.slice(last);
    }
  }
  return { message: text, fixes };
}
