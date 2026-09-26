/**
 * last-sitting — what the returning seller's LAST sitting covered, how it
 * ended, and what was agreed to start with next time.
 *
 * Clearwater's second session opened "last time we got through the team's
 * forward plans and some of the compliance history" — the forward plans
 * were from the session before that; the last sitting had covered record
 * ownership, T4 versus contractor status, the RMT agreements and turnover —
 * and it ignored what that sitting had ended on: "we'll pick up with the
 * zoning question next time" (zoning came up only at turn 3). The opening
 * saw every earlier session as one flat digest ("[session 1] Q → A …"), with
 * nothing marking the last sitting or its closing.
 *
 * lastSittingOf reads the most recent earlier sitting; renderLastSitting
 * puts it in the opening's instruction; openingContinuityIssues checks the
 * drafted opening against it (a welcome-back that names another sitting's
 * topic, a question that skips the agreed next item) so one corrective
 * rewrite can fix it. Pure.
 */
import type { ConversationMessage } from "@shared/schema";

type SessionLike = { id: string; messages: unknown; startedAt?: unknown; lastActivityAt?: unknown; completedAt?: unknown; status?: string | null };

export interface LastSitting {
  /** 1-based, in the order the sittings happened. */
  number: number;
  date: string | null;
  /** The questions the seller answered there, in order (short). */
  covered: string[];
  /** The interviewer's last message of that sitting. */
  closing: string;
  /** What was agreed to start with next time ("the zoning question — whether both premises are zoned for healthcare use"), if anything. */
  nextTopic: string | null;
  /** The whole sitting's text (questions + answers), to check a welcome-back against. */
  text: string;
}

const when = (s: SessionLike) => new Date(String(s.startedAt ?? s.lastActivityAt ?? 0)).getTime();
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const msgsOf = (s: SessionLike) => (Array.isArray(s.messages) ? (s.messages as ConversationMessage[]) : []).filter((m) => m && typeof m.content === "string");

/** The question sentence(s) of an interviewer message (else its last sentence). */
function questionOf(message: string): string {
  const qs = flat(message).match(/[^.!?]*\?/g);
  return qs && qs.length > 0 ? qs.map((q) => q.trim()).join(" ") : flat(message).split(/(?<=[.!?])\s+/).pop() ?? "";
}

/** "Before you go, the one thing I'd most like to confirm is whether X. A quick yes now, or shall we start there next time?" → "whether X". */
function itemOf(message: string): string {
  const sentences = flat(message).split(/(?<=[.!?])\s+/);
  // The sentence that names the item (the longest), not the "shall we start
  // there" offer or a "we've covered a lot of ground" aside.
  const named =
    sentences
      .filter((x) => !/\b(?:next time|shall we|start there|quick yes|for now|wrap|covered|a lot of ground|everything'?s saved)\b/i.test(x))
      .sort((a, b) => b.length - a.length)[0] ?? sentences[0] ?? "";
  return named
    .replace(/^(?:before you go|one (?:last|more) thing|last one|finally|and|ok(?:ay)?|of course|absolutely|understood)[,:—–\s]+/i, "")
    .replace(/^(?:the )?(?:one )?(?:thing|item|question) (?:I'?d|I would) (?:most )?(?:like|love|want) to (?:confirm|ask|cover|check)(?: is| about)?\s*/i, "")
    .replace(/^(?:I'?d (?:like|love) to|let'?s|we (?:can|could|should)) (?:confirm|ask about|cover|check|start with)\s*/i, "")
    .replace(/[.?!]+$/, "")
    .trim();
}

const NEXT_TIME_RE = /\b(?:pick (?:it |this |things )?(?:back )?up|start|begin|continue|resume|kick (?:things |it )?off|open)\s+(?:with|on|from|by)\s+(.{3,140}?)\s+(?:next time|when we (?:next )?(?:talk|speak|meet|pick up|resume|continue)|in our next (?:session|conversation|sitting)|tomorrow)\b/i;
const NEXT_TIME_LEAD_RE = /\bnext time,?\s+(?:we'?ll|I'?ll|let'?s)\s+(?:start|begin|pick up|open)\s+(?:with|on)\s+(.{3,140}?)(?:[.!?]|$)/i;
const THERE_RE = /\b(?:start|pick up|begin|resume)\s+(?:there|with that|with it|from there)\s+(?:next time|tomorrow|when we)/i;

/**
 * What the sitting's end agreed to start with next time: named by the
 * interviewer ("we'll pick up with the zoning question next time"), or
 * agreed to its offer ("shall we start there next time?" → "Let's start
 * there next time") — then the item that offer was about. A bare "the
 * zoning question" is completed with the item from the offer when there is
 * one. Null when nothing was agreed.
 */
export function agreedNextTopic(messages: ConversationMessage[]): string | null {
  const tail = messages.slice(-5);
  const ai = tail.filter((m) => m.role === "ai");
  let named: string | null = null;
  for (const m of [...ai].reverse()) {
    const t = flat(m.content);
    const hit = t.match(NEXT_TIME_RE)?.[1] ?? t.match(NEXT_TIME_LEAD_RE)?.[1];
    if (hit && !/^(?:there|that|it|this)$/i.test(hit.trim())) { named = hit.trim(); break; }
  }
  // The offer the seller agreed to ("shall we start there next time?").
  let offered: string | null = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    if (m.role !== "ai") continue;
    const agreed = tail.slice(i + 1).some((x) => x.role === "user" && (THERE_RE.test(x.content) || /\b(?:next time|tomorrow|later)\b/i.test(x.content)));
    if (/\bnext time\b|\btomorrow\b/i.test(m.content) && /\?/.test(m.content) && agreed) {
      offered = itemOf(m.content);
      break;
    }
    if (THERE_RE.test(m.content)) {
      // The interviewer's own "we'll start there next time" — "there" is its previous question.
      const prev = tail.slice(0, i).reverse().find((x) => x.role === "ai");
      if (prev) offered = itemOf(prev.content);
      break;
    }
  }
  if (named && offered && !named.toLowerCase().includes(offered.toLowerCase().slice(0, 20))) return `${named} (${offered})`;
  return named ?? offered;
}

/** The most recent earlier sitting the seller answered in (not the one in progress). Null when there is none. */
export function lastSittingOf(sessions: SessionLike[], currentSessionId: string | null | undefined): LastSitting | null {
  const ordered = sessions
    .filter((s) => s.id !== currentSessionId && msgsOf(s).some((m) => m.role === "user"))
    .sort((a, b) => when(a) - when(b));
  if (ordered.length === 0) return null;
  const last = ordered[ordered.length - 1];
  const msgs = msgsOf(last);
  const covered: string[] = [];
  for (let i = 0; i < msgs.length - 1; i++) {
    if (msgs[i].role === "ai" && msgs[i + 1].role === "user" && /\?/.test(msgs[i].content)) covered.push(questionOf(msgs[i].content).slice(0, 160));
  }
  const closing = flat([...msgs].reverse().find((m) => m.role === "ai")?.content ?? "");
  const d = new Date(String(last.lastActivityAt ?? last.completedAt ?? last.startedAt ?? ""));
  return {
    number: ordered.length,
    date: Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
    covered,
    closing,
    nextTopic: agreedNextTopic(msgs),
    text: msgs.map((m) => m.content).join("\n"),
  };
}

/** The opening instruction's block about the last sitting. */
export function renderLastSitting(ls: LastSitting): string {
  const lines = [
    `LAST SITTING (session ${ls.number}${ls.date ? `, ${ls.date}` : ""}) — the one to pick up from. Your welcome-back names something from THIS sitting only, never an older one.`,
    `It covered: ${ls.covered.slice(-8).map((q) => `"${q}"`).join("; ") || "(no answered questions)"}.`,
    `It ended with you saying: "${ls.closing.slice(0, 400)}"`,
  ];
  if (ls.nextTopic) {
    lines.push(`You and the seller agreed to start this sitting with: ${ls.nextTopic}. Your first question IS that item — unless it is now answered on file, in which case say so in a few words and go to the next most important open item.`);
  }
  return lines.join("\n");
}

const GENERIC = new Set(
  "into onto from broker brokers call calls email emails document documents notes file files been through about after again ahead also around asked back before being business covered cover last left little lot more next other over picked pick question questions quite really session sitting some start still that their them then there these thing things those through time today topic topics went where which while with would your yours good great pick where".split(" "),
);
/** A word's stem: its common ending dropped ("zoning", "zoned" → "zon"), five letters at most. */
const lemma = (w: string) => {
  const base = w.replace(/['’]s$/, "");
  const cut = base.replace(/(?:ing|ed|es|s)$/, "");
  return (cut.length >= 3 ? cut : base).slice(0, 5);
};
const stems = (text: string) =>
  new Set((text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).map((w) => w.replace(/['’]s$/, "")).filter((w) => !GENERIC.has(w)).map(lemma));
/** Adjacent topic-word pairs of a text ("forward plans" → "forwa plan"), within a sentence. */
const pairs = (text: string) => {
  const out = new Set<string>();
  for (const sentence of text.toLowerCase().split(/[.!?;:—–,()\n]+/)) {
    const words = (sentence.match(/[a-z][a-z'-]*/g) ?? []).map((w) => w.replace(/['’]s$/, ""));
    for (let i = 0; i + 1 < words.length; i++) {
      const [a, b] = [words[i], words[i + 1]];
      if (a.length < 4 || b.length < 4 || GENERIC.has(a) || GENERIC.has(b)) continue;
      out.add(`${lemma(a)} ${lemma(b)}`);
    }
  }
  return out;
};

/**
 * Checks a returning seller's drafted opening against the last sitting:
 *  - misstated: topic words of the welcome-back ("last time we got through
 *    the team's forward plans…") that the last sitting never touched but an
 *    older sitting did — it describes the wrong sitting;
 *  - missesNextTopic: the opening doesn't take up the agreed next item — no
 *    word of its name ("the zoning question") and under half of the words
 *    of what it was about ("whether both clinic premises are zoned…").
 */
export function openingContinuityIssues(opening: string, ls: LastSitting, olderText: string): { misstated: string[]; missesNextTopic: boolean } {
  const sentences = flat(opening).split(/(?<=[.!?])\s+/);
  const welcome = sentences.find((x) => !x.includes("?") && /\b(?:last time|left off|we (?:covered|got through|talked|went over|spoke|discussed)|picking up|pick up)\b/i.test(x)) ?? "";
  // (Only what it says the last sitting covered — "I've been through your calls with Morgan" claims nothing about it.)
  const said = welcome.match(/\b(?:last time|we (?:covered|got through|talked about|went over|discussed))\b([\s\S]*)$/i);
  const claimed = said ? said[1] : "";
  const lastS = stems(ls.text);
  const olderS = stems(olderText);
  // A word the last sitting never used, or a two-word topic ("forward plans")
  // only an older sitting had — the last one said "forward records".
  const lastP = pairs(ls.text);
  const olderP = pairs(olderText);
  const misstated = [
    ...Array.from(stems(claimed)).filter((w) => !lastS.has(w) && olderS.has(w)),
    ...Array.from(pairs(claimed)).filter((p) => !lastP.has(p) && olderP.has(p)),
  ];
  let missesNextTopic = false;
  if (ls.nextTopic) {
    // "the zoning question (whether both clinic premises are zoned …)": its name, and what it was about.
    const [name, about = ""] = ls.nextTopic.split(/\s*\(/);
    // (A long item with no short name is judged by its words, not by one of them — "clinic" is in every opening.)
    const long = !about && stems(name).size > 3;
    const named = long ? [] : Array.from(stems(name));
    const detail = Array.from(stems(long ? name : about));
    const asked = stems(opening);
    const takesUp = named.some((w) => asked.has(w)) || (detail.length > 0 && detail.filter((w) => asked.has(w)).length / detail.length >= 0.5);
    missesNextTopic = named.length + detail.length > 0 && !takesUp;
  }
  return { misstated, missesNextTopic };
}

/** The text of every sitting before the last one (for openingContinuityIssues). */
export function olderSittingsText(sessions: SessionLike[], currentSessionId: string | null | undefined, last: LastSitting | null): string {
  const ordered = sessions
    .filter((s) => s.id !== currentSessionId && msgsOf(s).some((m) => m.role === "user"))
    .sort((a, b) => when(a) - when(b));
  return ordered.slice(0, last ? ordered.length - 1 : ordered.length).map((s) => msgsOf(s).map((m) => m.content).join("\n")).join("\n");
}
