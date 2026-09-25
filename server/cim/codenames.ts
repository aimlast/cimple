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
import { blindLeakTerms, findBlindLeaks } from "@shared/blind-guard";
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

/** A random codename not in `taken` (falls back to a numbered one when all are used). */
export function pickCodename(taken: Set<string>): string {
  const free = CODENAMES.filter((c) => !taken.has(c.toLowerCase()));
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
  deal: { businessName?: string | null; extractedInfo?: unknown },
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
  // must not contain anything identifying.
  const leaks = findBlindLeaks(codename, blindLeakTerms(deal as any));
  const ids = blindIdentifiers(deal as any).filter((id) => id.length >= 4 && codename.toLowerCase().includes(id.toLowerCase()));
  if (leaks.length > 0 || ids.length > 0) {
    const what = leaks[0] ?? ids[0];
    return { ok: false, error: `The codename would identify the business — it contains “${what}”. Pick a neutral word.` };
  }
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
    layoutData: result.layoutData == null ? result.layoutData : JSON.parse(swap(JSON.stringify(result.layoutData))),
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
  deal: { id: string; brokerId: string; blindCodename?: string | null; businessName?: string | null; extractedInfo?: unknown },
  raw: unknown,
): Promise<{ ok: true; codename: string; updated: number } | { ok: false; error: string; status: number }> {
  return withCodenameLock(deal.id, () => renameUnlocked(deal, raw));
}

async function renameUnlocked(
  deal: { id: string; brokerId: string; blindCodename?: string | null; businessName?: string | null; extractedInfo?: unknown },
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
    const data = o.layoutData == null ? null : JSON.parse(swap(JSON.stringify(o.layoutData)));
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
    const codename = pickCodename(await brokerCodenames(deal.brokerId, deal.id));
    await storage.updateDeal(deal.id, { blindCodename: codename } as any);
    return codename;
  });
}

/** The deal's codename as saved right now (null if it has none). */
export async function currentCodename(dealId: string): Promise<string | null> {
  return (await storage.getDeal(dealId))?.blindCodename || null;
}
