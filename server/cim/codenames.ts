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
import { deals } from "@shared/schema";
import { storage } from "../storage";

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

/**
 * The deal's codename — the persisted one if it has one, else a new one that
 * no other deal of this brokerage uses, saved on the deal before returning.
 */
export async function ensureDealCodename(deal: { id: string; brokerId: string; blindCodename?: string | null }): Promise<string> {
  if (deal.blindCodename) return deal.blindCodename;
  const fresh = await storage.getDeal(deal.id);
  if (fresh?.blindCodename) return fresh.blindCodename;
  const codename = pickCodename(await brokerCodenames(deal.brokerId, deal.id));
  await storage.updateDeal(deal.id, { blindCodename: codename } as any);
  return codename;
}
