/**
 * Blind CIM project codenames.
 *
 * A deal's codename is what pre-NDA buyers know it by — in the Blind CIM, in
 * outreach emails, in the view room header. It must therefore be STABLE (the
 * old generate-blind picked a new random one on every run, so a buyer's
 * "Project Summit" email pointed at a CIM now called "Project Atlas") and
 * UNIQUE within a brokerage (8 options meant two of a broker's deals often
 * shared a name). Codenames are neutral words — nothing that hints at an
 * industry, a place or a person.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { cimSectionOverrides, cimSections, dealOutreach, deals } from "@shared/schema";
import { storage } from "../storage";
import { blindLeakTerms, findBlindLeaks, mapStrings } from "@shared/blind-guard";
import { blindIdentifiers } from "@shared/blind-identifiers";

const WORDS = [
  "Acacia", "Admiral", "Aegis", "Alder", "Alpine", "Amber", "Anchor", "Apex", "Aquila", "Arbor",
  "Arcadia", "Archer", "Argent", "Aria", "Ascent", "Aspen", "Astra", "Atlas", "Aurora", "Avalon",
  "Azure", "Banner", "Basalt", "Beacon", "Birch", "Bluebird", "Bolt", "Boreal", "Bramble", "Bridge",
  "Bristle", "Cadence", "Caldera", "Calypso", "Camber", "Canopy", "Capstone", "Cardinal", "Cascade", "Cedar",
  "Celeste", "Centaur", "Chinook", "Cinder", "Citadel", "Clarion", "Cobalt", "Comet", "Compass", "Condor",
  "Copper", "Coral", "Corona", "Crest", "Crimson", "Crystal", "Cypress", "Dawn", "Delta", "Denali",
  "Drift", "Dune", "Eagle", "Echo", "Eclipse", "Ember", "Emerald", "Equinox", "Everest", "Evergreen",
  "Falcon", "Fathom", "Fern", "Firefly", "Fjord", "Flint", "Forge", "Fortress", "Foxglove", "Frontier",
  "Galaxy", "Garnet", "Gemini", "Glacier", "Granite", "Graphite", "Gryphon", "Halcyon", "Harbor", "Harrier",
  "Hawthorn", "Heron", "Highland", "Horizon", "Hudson", "Indigo", "Iris", "Ironwood", "Ivory", "Jade",
  "Jasper", "Juniper", "Keystone", "Kestrel", "Kingfisher", "Lagoon", "Lantern", "Larch", "Laurel", "Legacy",
  "Linden", "Lodestar", "Lumen", "Lynx", "Magnolia", "Mariner", "Marlin", "Meadow", "Meridian", "Mesa",
  "Meteor", "Monarch", "Mosaic", "Nautilus", "Nebula", "Nimbus", "Nova", "Oak", "Obsidian", "Octave",
  "Onyx", "Opal", "Orbit", "Orchid", "Orion", "Osprey", "Palisade", "Paragon", "Pegasus", "Pelican",
  "Peregrine", "Phoenix", "Pinnacle", "Pioneer", "Polaris", "Prairie", "Prism", "Quarry", "Quartz", "Quill",
  "Radiant", "Rampart", "Raven", "Redwood", "Regent", "Ridgeline", "Riverstone", "Rowan", "Sable", "Saffron",
  "Sage", "Sapphire", "Sentinel", "Sequoia", "Sextant", "Sierra", "Silverleaf", "Solstice", "Sparrow", "Spruce",
  "Starling", "Sterling", "Stonebridge", "Summit", "Sunstone", "Tamarack", "Tempest", "Terra", "Thistle", "Timber",
  "Topaz", "Tundra", "Twilight", "Valiant", "Vanguard", "Vega", "Velvet", "Verdant", "Vertex", "Vista",
  "Wayfarer", "Whitewater", "Wildflower", "Willow", "Windward", "Wren", "Zenith", "Zephyr",
];

export const CODENAMES: readonly string[] = WORDS.map((w) => `Project ${w}`);

/**
 * A random codename not in `taken` (falls back to a numbered one when all
 * are used). With the deal, never one that names something of it — a
 * customer called Kestrel rules out "Project Kestrel".
 */
export function pickCodename(taken: Set<string>, deal?: CodenameDeal): string {
  const terms = deal ? blindLeakTerms(deal as any) : [];
  const stems = deal ? identifyingWords(deal) : new Map<string, string>();
  const free = CODENAMES.filter(
    (c) => !taken.has(c.toLowerCase()) && (terms.length === 0 || findBlindLeaks(c, terms).length === 0) && !stemClash(c, stems),
  );
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
  for (let n = 2; ; n++) {
    const c = `${CODENAMES[Math.floor(Math.random() * CODENAMES.length)]} ${n}`;
    if (!taken.has(c.toLowerCase())) return c;
  }
}

/** Codenames already used by this broker's other deals (lower-cased). */
async function brokerCodenames(brokerId: string, exceptDealId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: deals.id, codename: deals.blindCodename })
    .from(deals)
    .where(and(eq(deals.brokerId, brokerId), isNotNull(deals.blindCodename)));
  return new Set(
    rows.filter((r) => r.id !== exceptDealId && r.codename).map((r) => String(r.codename).toLowerCase()),
  );
}

type CodenameDeal = { businessName?: string | null; extractedInfo?: unknown; employeeChart?: unknown; location?: string | null };

/** Words too generic to point at a business ("Harbor Group" is about "Harbor"). */
const GENERIC_WORDS = new Set([
  "group", "holdings", "services", "service", "company", "limited", "corporation", "partners", "enterprises",
  "solutions", "systems", "industries", "international", "associates", "consulting", "management", "canada",
  "north", "south", "east", "west", "street", "road", "avenue", "drive", "suite", "unit",
  // Dates in the facts (a lease ending "December 31") name nothing.
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/** A word as compared: letters only, one spelling ("harbour" → "harbor", "centre" → "center"). */
function spelling(word: string): string {
  return word
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    // Inside compounds too ("Harbourline", "Centreville").
    .replace(/our/g, "or")
    .replace(/tre(?=s?$|[^aeiouy])/g, "ter");
}

const WORD_BREAK = new RegExp("[^\\p{L}'’]+", "u");

/** Every word of the deal's identifying terms (names, people, places, the street), by spelling. */
function identifyingWords(deal: CodenameDeal): Map<string, string> {
  const texts = [
    ...blindIdentifiers(deal as any),
    ...blindLeakTerms(deal as any).filter((t) => t.kind !== "registry").map((t) => t.text),
    ...(deal.location ? [deal.location] : []),
  ];
  const out = new Map<string, string>();
  for (const text of texts) {
    for (const raw of text.split(WORD_BREAK)) {
      const n = spelling(raw);
      if (n.length >= 4 && !GENERIC_WORDS.has(n)) out.set(n, raw);
    }
  }
  return out;
}

/**
 * The identifying word a codename's word is a prefix, suffix or stem of —
 * "Project Harbor" for Harborview MSP, "Cedar" for Cedarbrook Dental,
 * "Summit" for Summitview Physiotherapy, "Oak" for a business in
 * Oakville, "Harbor" for Harbourline. The exact-word check (findBlindLeaks)
 * let all of these through; the codename is the buyer's name for the deal
 * before the NDA, so "Project Harbor — managed IT services, Ontario"
 * pointed straight at Harborview. Null when nothing clashes.
 *
 * A compound name starts with its root: the codename word is the start of
 * the identifying word (Harbor → Harborview, Oak → Oakville) or the
 * identifying word the start of the codename (Coast → Coastline for Pacific
 * Coast Logistics). A shared ENDING is not a shared root — "Ember" is not
 * "December", "Aria" not "Maria", "Chinook" not "Nook", "Basalt" not
 * "Salt", "Stonebridge" not "…ridge" — and refusing those only confused the
 * broker ("contains “December”").
 */
function stemClash(codename: string, words: Map<string, string>): { word: string; codeWord: string } | null {
  if (words.size === 0) return null;
  for (const part of codename.split(/\s+/)) {
    const w = spelling(part);
    if (w.length < 3 || w === "project") continue;
    for (const [v, raw] of Array.from(words)) {
      if (v === w || v.startsWith(w) || (v.length >= 4 && w.startsWith(v))) return { word: raw, codeWord: part };
    }
  }
  return null;
}

/** For a broker-typed or picked codename: the identifying word it stems from, or null. */
export function codenameStemClash(codename: string, deal: CodenameDeal): string | null {
  return stemClash(codename, identifyingWords(deal))?.word ?? null;
}

/**
 * Why a codename would point at the business, in the broker's words — or
 * null when it is neutral. Also used on the stored codename (a deal named
 * before a stricter check, or before a fact changed, keeps its name — its
 * buyers know it by it — so the CIM tab says so and the broker renames it).
 */
export function codenameProblem(deal: CodenameDeal, codename: string): string | null {
  const leaks = findBlindLeaks(codename, blindLeakTerms(deal as any));
  const ids = blindIdentifiers(deal as any).filter((id) => id.length >= 4 && codename.toLowerCase().includes(id.toLowerCase()));
  const direct = leaks[0] ?? ids[0];
  if (direct) return `It contains “${direct}”, which identifies the business.`;
  const stem = stemClash(codename, identifyingWords(deal));
  if (stem) {
    return spelling(stem.codeWord) === spelling(stem.word)
      ? `“${stem.codeWord}” is a word from the business's own details.`
      : `“${stem.codeWord}” shares its root with “${stem.word}” from the business's own details.`;
  }
  return null;
}

/** A codename looks like a name: starts with a letter or digit; letters, digits, spaces, & ' . - after. */
const CODENAME_SHAPE = new RegExp("^[\\p{L}\\p{N}][\\p{L}\\p{N} &'’.-]*$", "u");

/**
 * A broker-chosen codename, cleaned — or why it can't be used. It must be
 * blind-safe (nothing the identity guard would catch: the business name,
 * an owner, the city, the street…), look like a name (letters, digits,
 * spaces, & ' . -; 3–60 characters, no brackets) and be unique among this
 * broker's deals. Pure apart from `taken` (the broker's other codenames,
 * lower-cased).
 */
export function validateCodename(
  deal: CodenameDeal,
  raw: unknown,
  taken: Set<string>,
): { ok: true; codename: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Enter a codename." };
  const codename = raw.replace(/\s+/g, " ").trim();
  if (codename.length < 3) return { ok: false, error: "A codename needs at least 3 characters." };
  if (codename.length > 60) return { ok: false, error: "Keep the codename to 60 characters or fewer." };
  if (!CODENAME_SHAPE.test(codename)) {
    return { ok: false, error: "Use letters, numbers and spaces only (e.g. “Project Coastline”)." };
  }
  // The guard's terms without a codename exemption: the candidate itself
  // must not contain anything identifying — the business, its people (the
  // staff list too), its customers, landlord and suppliers, its places —
  // nor share a root with one ("Harbor" for Harborview).
  const problem = codenameProblem(deal, codename);
  if (problem) return { ok: false, error: `That codename would point at the business. ${problem} Pick a neutral word.` };
  if (taken.has(codename.toLowerCase())) return { ok: false, error: "Another of your deals already uses that codename." };
  return { ok: true, codename };
}

/** The same codename written anywhere in a text, any case ("PROJECT MOSAIC" too). */
function codenamePattern(codename: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${codename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
}

// ── Per-deal codename lock ───────────────────────────────────────────────
/**
 * A rename and every commit of a blind redaction for the deal run one at a
 * time. Both are short (database writes only — the AI call happens before
 * the commit, outside the lock), so a broker renaming during a long blind
 * run is never kept waiting for it, yet a redaction written under the old
 * codename can't land after the rename has already swapped the rest
 * (2026-09-26: a rename mid-run left "Project Ember" in the blind CIM
 * beside "Project Kestrel").
 */
const codenameLocks = new Map<string, Promise<unknown>>();
export function withCodenameLock<T>(dealId: string, fn: () => Promise<T>): Promise<T> {
  const prev = codenameLocks.get(dealId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  codenameLocks.set(dealId, tail);
  tail.then(() => { if (codenameLocks.get(dealId) === tail) codenameLocks.delete(dealId); });
  return next;
}

/**
 * A redaction made under `used` whose deal is now called `current`: the
 * same result with the old codename replaced everywhere (title, text,
 * data — the cover included). Unchanged when the names agree. Pure.
 */
export function carryCodename<R extends { sectionTitle?: string | null; layoutData?: unknown; contentOverride?: string | null }>(
  result: R,
  used: string | null | undefined,
  current: string | null | undefined,
): R {
  if (!used || !current || used === current) return result;
  const re = codenamePattern(used);
  const swap = (t: string) => t.replace(re, current);
  return {
    ...result,
    sectionTitle: result.sectionTitle == null ? result.sectionTitle : swap(result.sectionTitle),
    layoutData: result.layoutData == null ? result.layoutData : mapStrings(result.layoutData, swap),
    contentOverride: result.contentOverride == null ? result.contentOverride : swap(result.contentOverride),
  };
}

/**
 * Rename the deal's codename and carry it through everything already
 * written under the old one: every blind override (text and data), the
 * redacted section titles, and outreach drafts not sent yet. Sent emails
 * keep what they said. A blind run still going commits its sections under
 * the new name (see carryCodename in blind-sync). Returns how many rows
 * changed.
 */
export function renameDealCodename(
  deal: { id: string; brokerId: string; blindCodename?: string | null } & CodenameDeal,
  raw: unknown,
): Promise<{ ok: true; codename: string; updated: number } | { ok: false; error: string; status: number }> {
  return withCodenameLock(deal.id, () => renameUnlocked(deal, raw));
}

async function renameUnlocked(
  deal: { id: string; brokerId: string; blindCodename?: string | null } & CodenameDeal,
  raw: unknown,
): Promise<{ ok: true; codename: string; updated: number } | { ok: false; error: string; status: number }> {
  const taken = await brokerCodenames(deal.brokerId, deal.id);
  const v = validateCodename(deal, raw, taken);
  if (!v.ok) return { ok: false, error: v.error, status: 400 };
  // The name as it is now (a blind run may have given the deal its first one).
  const previous = (await storage.getDeal(deal.id))?.blindCodename || deal.blindCodename || null;
  await storage.updateDeal(deal.id, { blindCodename: v.codename } as any);
  if (!previous || previous === v.codename) return { ok: true, codename: v.codename, updated: 0 };

  const re = codenamePattern(previous);
  const swap = (t: string) => t.replace(re, v.codename);
  let updated = 0;
  const overrides = await db.select().from(cimSectionOverrides).where(eq(cimSectionOverrides.dealId, deal.id));
  for (const o of overrides) {
    const data = o.layoutData == null ? null : mapStrings(o.layoutData, swap);
    const text = o.contentOverride == null ? null : swap(o.contentOverride);
    if (JSON.stringify(data) === JSON.stringify(o.layoutData) && text === o.contentOverride) continue;
    await db.update(cimSectionOverrides).set({ layoutData: data, contentOverride: text }).where(eq(cimSectionOverrides.id, o.id));
    updated++;
  }
  const sections = await db
    .select({ id: cimSections.id, blindTitle: cimSections.blindTitle })
    .from(cimSections)
    .where(and(eq(cimSections.dealId, deal.id), isNotNull(cimSections.blindTitle)));
  for (const s of sections) {
    const t = swap(s.blindTitle || "");
    if (t === s.blindTitle) continue;
    await db.update(cimSections).set({ blindTitle: t }).where(eq(cimSections.id, s.id));
    updated++;
  }
  const drafts = await db
    .select({ id: dealOutreach.id, subject: dealOutreach.subject, body: dealOutreach.body })
    .from(dealOutreach)
    .where(and(eq(dealOutreach.dealId, deal.id), eq(dealOutreach.status, "draft")));
  for (const d of drafts) {
    const subject = swap(d.subject);
    const body = swap(d.body);
    if (subject === d.subject && body === d.body) continue;
    await db.update(dealOutreach).set({ subject, body, updatedAt: new Date() }).where(eq(dealOutreach.id, d.id));
    updated++;
  }
  // The teaser: its draft, published copy and the seller-check copy (server/teaser/store.ts).
  const { renameTeaserCodename } = await import("../teaser/store");
  updated += await renameTeaserCodename(deal.id, swap, v.codename).catch((err) => {
    console.warn(`[codename] teaser rename skipped for deal ${deal.id}:`, (err as Error)?.message);
    return 0;
  });
  return { ok: true, codename: v.codename, updated };
}

/**
 * The deal's codename — the persisted one if it has one, else a new one that
 * no other deal of this brokerage uses, saved on the deal before returning.
 */
export async function ensureDealCodename(deal: { id: string; brokerId: string; blindCodename?: string | null }): Promise<string> {
  if (deal.blindCodename) return deal.blindCodename;
  // Under the lock, so a name the broker is choosing right now is never overwritten.
  return withCodenameLock(deal.id, async () => {
    const fresh = await storage.getDeal(deal.id);
    if (fresh?.blindCodename) return fresh.blindCodename;
    const codename = pickCodename(await brokerCodenames(deal.brokerId, deal.id), fresh ?? undefined);
    await storage.updateDeal(deal.id, { blindCodename: codename } as any);
    return codename;
  });
}

/** The deal's codename as saved right now (null if it has none). */
export async function currentCodename(dealId: string): Promise<string | null> {
  return (await storage.getDeal(dealId))?.blindCodename || null;
}
