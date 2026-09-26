/**
 * source-wording — the sources named the way the seller knows them.
 *
 * The resume opener on Clearwater's second session told the seller "One
 * thing that came up in your broker notes: the call notes show a preference
 * not to sell to Bowmont…" — the statement was the seller's own, on the
 * Zoom call both of them were on. "Broker notes" (or "CRM notes", "internal
 * notes") tells a seller there are files about them they can't see, and it
 * is never how they know the material the interview may quote: every source
 * the interview reads is one the seller shared or took part in (broker-only
 * rows never reach it — seller-view.ts). This pass renames such references
 * to what the seller recognises: their calls with their broker, or simply
 * what is on file. Pure.
 */

const PLURAL: Record<string, string> = { shows: "show", says: "say", mentions: "mention", notes: "note", indicates: "indicate", suggests: "suggest", has: "have", lists: "list" };

const RULES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  // "in your broker notes", "from the broker's notes", "on the broker's call notes"
  [/\b(in|from|on) (?:your|the|my) broker(?:['’]s|s['’])? (?:call )?notes\b/gi, (m) => `${m[1].toLowerCase() === "from" ? "from" : "on"} your calls with your broker`],
  // "the broker's notes show" → "your calls with your broker show"
  [/\b(?:your|the) broker(?:['’]s|s['’])? (?:call )?notes (shows?|says?|mentions?|notes?|indicates?|suggests?|has|have|lists?)\b/gi, (m) => `your calls with your broker ${PLURAL[m[1].toLowerCase()] ?? m[1]}`],
  // "your broker notes" anywhere else
  [/\b(?:your|the|my) broker(?:['’]s|s['’])? (?:call )?notes\b/gi, () => "your calls with your broker"],
  // "in the CRM notes", "from my internal notes" → "in what's on file"
  [/\b(in|from) (?:the|your|my|our) (?:crm|internal|private) (?:notes?|records?|file)\b/gi, (m) => `${m[1].toLowerCase()} what's on file`],
  // "the CRM notes show" → "what's on file shows"
  [/\b(?:the|your|my|our) (?:crm|internal|private) (?:notes?|records?) (show|say|mention|note|indicate|suggest|list)s?\b/gi, (m) => `what's on file ${m[1].toLowerCase()}s`],
];

/** Renames "broker notes" / "CRM notes" references (see the module comment). */
export function fixSourceReferences(message: string): { message: string; fixes: string[] } {
  const fixes: string[] = [];
  let text = message;
  for (const [re, to] of RULES) {
    text = text.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const offset = args[args.length - 2] as number;
      let rep = to(m);
      if (/(?:^|[.!?]\s+)$/.test(text.slice(0, offset))) rep = rep.charAt(0).toUpperCase() + rep.slice(1);
      fixes.push(`${m[0]} → ${rep}`);
      return rep;
    });
  }
  return { message: text, fixes };
}
