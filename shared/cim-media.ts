/**
 * cim-media — the rules for the CIM's media blocks (photo gallery, video,
 * location map). Pure: used by the server (write validation, the view room,
 * the Q&A chatbot, the blind redactor) and by the client (renderers, the
 * builder's editors and buyer previews).
 *
 * Blind safety is deterministic and never left to the AI redactor:
 *   - Photos: only uploaded photos the broker marked "safe to show in the
 *     blind CIM" (deal_media.blind_safe). Photos linked from a web address
 *     are never shown blind — the address itself can name the business.
 *   - Videos: uploaded videos marked safe, or YouTube/Vimeo links the broker
 *     marked safe on the item.
 *   - Maps: never an exact address. Each location is reduced to its
 *     province/state (or country) — or the whole map is hidden when the
 *     broker chose that, or no region can be worked out.
 *   - Captions, titles and labels come from the AI-redacted copy, matched by
 *     position; any that still contain a known identifier (business name,
 *     street, city) are dropped.
 */

export const MEDIA_LAYOUT_KEYS = ["image_gallery", "video", "location_map"] as const;
export type MediaLayoutKey = (typeof MEDIA_LAYOUT_KEYS)[number];

export function isMediaLayout(key: string | null | undefined): key is MediaLayoutKey {
  return !!key && (MEDIA_LAYOUT_KEYS as readonly string[]).includes(key);
}

/** A row of the deal's media library, as far as these rules need it. */
export interface MediaAssetRef {
  id: string;
  kind: "image" | "video";
  blindSafe: boolean;
}

export const MEDIA_LIMITS = {
  imageBytes: 15 * 1024 * 1024,
  videoBytes: 150 * 1024 * 1024,
  galleryImages: 40,
  videos: 12,
  locations: 10,
  captionChars: 300,
  titleChars: 160,
  addressChars: 300,
} as const;

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export const VIDEO_MIME_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;

// ── Small helpers ─────────────────────────────────────────────────────────

type AnyRecord = Record<string, unknown>;
const isObj = (v: unknown): v is AnyRecord => !!v && typeof v === "object" && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMediaId(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  if (t.length <= max) return t;
  // Cut at a word boundary rather than mid-word.
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** https:// URL (no credentials) or undefined. */
export function safeHttpsUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 2000) return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" || u.username || u.password) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Lowercase letters and digits only — for identifier matching. */
export const normText = (v: string) => v.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** The URL a page uses to show one of the deal's uploads. */
export function mediaSrc(id: string, auth?: { buyerToken?: string | null; sellerToken?: string | null }): string {
  const base = `/api/media/${encodeURIComponent(id)}`;
  if (auth?.buyerToken) return `${base}?t=${encodeURIComponent(auth.buyerToken)}`;
  if (auth?.sellerToken) return `${base}?token=${encodeURIComponent(auth.sellerToken)}`;
  return base;
}

// ── Video links ───────────────────────────────────────────────────────────

export interface ParsedVideo {
  source: "youtube" | "vimeo";
  id: string;
  /** Privacy-enhanced embed URL (youtube-nocookie / Vimeo dnt). */
  embedUrl: string;
  /** Canonical link to the video's own page. */
  watchUrl: string;
}

/**
 * YouTube (watch, youtu.be, shorts, embed, nocookie) or Vimeo (public,
 * unlisted with hash, player) link → its privacy-enhanced embed. Anything
 * else → null.
 */
export function parseVideoUrl(raw: unknown): ParsedVideo | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw.trim().startsWith("http") ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const YT_ID = /^[A-Za-z0-9_-]{11}$/;

  let yt: string | null = null;
  if (host === "youtu.be") yt = parts[0] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (parts[0] === "watch") yt = u.searchParams.get("v");
    else if (["embed", "shorts", "live", "v"].includes(parts[0] ?? "")) yt = parts[1] ?? null;
  }
  if (yt !== null) {
    if (!YT_ID.test(yt)) return null;
    const t = u.searchParams.get("t") || u.searchParams.get("start");
    const start = t ? parseStartSeconds(t) : 0;
    const q = `rel=0&modestbranding=1${start ? `&start=${start}` : ""}`;
    return {
      source: "youtube",
      id: yt,
      embedUrl: `https://www.youtube-nocookie.com/embed/${yt}?${q}`,
      watchUrl: `https://www.youtube.com/watch?v=${yt}${start ? `&t=${start}s` : ""}`,
    };
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const idx = parts.findIndex((p) => /^\d{5,12}$/.test(p));
    if (idx < 0) return null;
    const id = parts[idx];
    // Unlisted videos carry a hash: vimeo.com/123/abcdef or ?h=abcdef.
    const hashRaw = u.searchParams.get("h") || (host === "vimeo.com" ? parts[idx + 1] : undefined);
    const hash = hashRaw && /^[0-9a-f]{6,20}$/i.test(hashRaw) ? hashRaw : undefined;
    return {
      source: "vimeo",
      id,
      embedUrl: `https://player.vimeo.com/video/${id}?dnt=1${hash ? `&h=${hash}` : ""}`,
      watchUrl: `https://vimeo.com/${id}${hash ? `/${hash}` : ""}`,
    };
  }
  return null;
}

function parseStartSeconds(t: string): number {
  if (/^\d+$/.test(t)) return Math.min(parseInt(t, 10), 86_400);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return 0;
  return Math.min((+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)), 86_400);
}

// ── Maps ──────────────────────────────────────────────────────────────────

/** Google Maps embed (no API key) for a place or address. */
export function mapEmbedUrl(query: string, zoom?: number): string {
  const z = clampZoom(zoom);
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}&z=${z}&output=embed`;
}

/** Link that opens the place in Google Maps. */
export function mapLinkUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function clampZoom(zoom: unknown, fallback = 14): number {
  const n = typeof zoom === "number" ? zoom : typeof zoom === "string" ? parseInt(zoom, 10) : NaN;
  return Number.isFinite(n) ? Math.min(20, Math.max(3, Math.round(n))) : fallback;
}

/** Zoom used when a map only shows a province/state. */
export const REGION_ZOOM = 5;

const CA_PROVINCES: Record<string, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador",
  NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island",
  QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
};
const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
/** First letter of a Canadian postal code → province. */
const CA_POSTAL_PREFIX: Record<string, string> = {
  A: "NL", B: "NS", C: "PE", E: "NB", G: "QC", H: "QC", J: "QC", K: "ON", L: "ON", M: "ON", N: "ON", P: "ON",
  R: "MB", S: "SK", T: "AB", V: "BC", Y: "YT",
};
const COUNTRIES: Record<string, string> = {
  canada: "Canada", usa: "USA", unitedstates: "USA", unitedstatesofamerica: "USA", us: "USA",
  unitedkingdom: "United Kingdom", uk: "United Kingdom", england: "England, United Kingdom",
  scotland: "Scotland, United Kingdom", wales: "Wales, United Kingdom", ireland: "Ireland",
  australia: "Australia", newzealand: "New Zealand", mexico: "Mexico",
};

/**
 * The broad region of an address: "Ontario, Canada", "Texas, USA", or a
 * country. Null when it can't be told from the text — a blind map then
 * hides the location rather than guess.
 */
export function regionFromAddress(address: unknown): string | null {
  if (typeof address !== "string" || !address.trim()) return null;
  const text = address.trim();
  const segments = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  // Never read the region from the first segment when there are several —
  // it's the street line ("12 Ontario St").
  const tail = segments.length > 1 ? segments.slice(1) : segments;

  for (let i = tail.length - 1; i >= 0; i--) {
    const seg = tail[i];
    // Province/state code as its own upper-case word ("ON", "ON L6J 1A1", "TX 75001").
    const codes = seg.match(/\b[A-Z]{2}\b/g) || [];
    for (const code of codes.reverse()) {
      if (CA_PROVINCES[code]) return `${CA_PROVINCES[code]}, Canada`;
      if (US_STATES[code]) return `${US_STATES[code]}, USA`;
    }
    const n = normText(seg);
    // Full name, alone or followed by a postal/ZIP code ("Ontario L6J 1H9").
    // (normText folds accents: "Québec" → "quebec".)
    for (const name of Object.values(CA_PROVINCES)) if (isRegionName(n, name)) return `${name}, Canada`;
    for (const name of Object.values(US_STATES)) if (isRegionName(n, name)) return `${name}, USA`;
  }
  // Postal / ZIP code anywhere after the street line.
  const tailText = tail.join(" ");
  const ca = tailText.match(/\b([ABCEGHJ-NPRSTVXY])\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d\b/i);
  if (ca) {
    const code = CA_POSTAL_PREFIX[ca[1].toUpperCase()];
    return code ? `${CA_PROVINCES[code]}, Canada` : "Canada";
  }
  for (let i = tail.length - 1; i >= 0; i--) {
    const country = COUNTRIES[normText(tail[i])];
    if (country) return country;
  }
  return null;
}

/**
 * True when the text names only a broad region — a province/state (name or
 * code, optionally followed by a postal/ZIP code) or a country. Such words
 * are allowed in a Blind CIM, so identity checks must not treat them as
 * leaks (shared/blind-guard.ts).
 */
export function isRegionLabel(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const code = t
    .replace(/\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i, "")
    .replace(/\s+\d{5}(-\d{4})?$/, "")
    .trim();
  if (/^[A-Z]{2}$/.test(code) && (CA_PROVINCES[code] || US_STATES[code])) return true;
  const n = normText(t);
  if (COUNTRIES[n]) return true;
  for (const name of Object.values(CA_PROVINCES)) if (isRegionName(n, name)) return true;
  for (const name of Object.values(US_STATES)) if (isRegionName(n, name)) return true;
  return false;
}

function isRegionName(seg: string, name: string): boolean {
  const k = normText(name);
  if (!seg.startsWith(k)) return false;
  const rest = seg.slice(k.length);
  return rest === "" || /^\d{5}(\d{4})?$/.test(rest) || /^[a-z]\d[a-z]\d[a-z]\d$/.test(rest);
}

/**
 * Every province, state and country name as written ("British Columbia",
 * "New York", "Canada", "United States") — words a Blind CIM may keep, so
 * the identity check must never read them as a person, a street or a city.
 */
export const REGION_NAMES: readonly string[] = Array.from(new Set([
  ...Object.values(CA_PROVINCES),
  ...Object.values(US_STATES),
  "Québec", "Canada", "United States", "United States of America", "USA", "America", "United Kingdom",
  "England", "Scotland", "Wales", "Ireland", "Australia", "New Zealand", "Mexico",
]));

const REGION_WORDS = new Set(REGION_NAMES.flatMap((n) => n.split(/\s+/).map((w) => normText(w))).filter((w) => w.length >= 3 && w !== "of"));

/** True when a single word is part of a province, state or country name ("British", "Columbia", "Carolina"). */
export function isRegionWord(word: string): boolean {
  return REGION_WORDS.has(normText(word));
}

/**
 * The deal's broad region, worked out from where its premises are —
 * "British Columbia, Canada", "Ontario, Canada", "Ohio, USA" — or null.
 * Read only from premises and province/state facts (address, head office,
 * location, province…), never from markets served, so a BC trucking firm
 * with Washington State lanes is "British Columbia, Canada". The most
 * common answer wins; ties go to the first key in PREMISES_KEY_ORDER.
 * This is what a Blind CIM says instead of the city.
 */
export function dealBlindRegion(extractedInfo: unknown): string | null {
  if (!isObj(extractedInfo)) return null;
  const read = (v: unknown): string | null =>
    typeof v === "string" ? v : isObj(v) && typeof v.value === "string" ? v.value : null;
  const votes = new Map<string, { n: number; rank: number }>();
  const vote = (region: string | null, rank: number) => {
    if (!region) return;
    const cur = votes.get(region);
    votes.set(region, { n: (cur?.n ?? 0) + 1, rank: Math.min(cur?.rank ?? rank, rank) });
  };
  for (const [key, raw] of Object.entries(extractedInfo)) {
    if (key.startsWith("_")) continue;
    const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().split(" ");
    const has = (...w: string[]) => w.some((x) => words.includes(x));
    // Premises only: never "serviceArea", "markets", "customerLocations"…
    if (has("market", "markets", "served", "service", "customer", "customers", "supplier", "suppliers", "lanes", "area", "areas", "expansion", "target")) continue;
    const premises = has("address", "headoffice", "office", "premises", "facility", "location", "headquarters", "hq", "site", "city");
    const regional = has("province", "state", "jurisdiction");
    if (!premises && !regional) continue;
    if (has("statement", "statements", "estate", "status")) continue;
    const text = read(raw)?.split("\n")[0]?.trim();
    if (!text || text.length > 300) continue;
    const rank = regional ? 1 : 0;
    // "Surrey BC", "19220 Campbell Ridge Drive, Surrey, BC V3Z 1K4", or a
    // province on its own ("British Columbia", "British Columbia (100%)").
    const cleaned = text.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    vote(regionFromAddress(cleaned) ?? (isRegionLabel(cleaned) ? regionFromAddress(`x, ${cleaned}`) : null), rank);
  }
  let best: { region: string; n: number; rank: number } | null = null;
  for (const [region, v] of Array.from(votes.entries())) {
    // A country alone loses to any province/state.
    const specific = region.includes(",") ? 1 : 0;
    const bestSpecific = best?.region.includes(",") ? 1 : 0;
    if (!best || specific > bestSpecific || (specific === bestSpecific && (v.n > best.n || (v.n === best.n && v.rank < best.rank)))) {
      best = { region, ...v };
    }
  }
  return best?.region ?? null;
}

/** Pieces of an address that would identify it (street line, city). */
export function addressFragments(address: unknown): string[] {
  if (typeof address !== "string") return [];
  // A province/state or country segment ("BC", "Canada") identifies nothing —
  // and as a needle it would strip every caption that names the region.
  const raw = address.split(/[,\n]/).map((s) => s.trim()).filter((s) => s && !isRegionLabel(s));
  // Street line, unit, city, postal code: each one identifies the premises.
  const out = raw.map((s) => normText(s)).filter((s) => s.length >= 4);
  // Distinctive street-name words too ("Fairway" from "210 Fairway Road South").
  for (const seg of raw.slice(0, 2)) {
    if (!/\d/.test(seg)) continue;
    for (const w of seg.match(/[A-Za-zÀ-ſ]{5,}/g) || []) {
      const n = normText(w);
      if (n.length >= 5 && !GENERIC_STREET_WORDS.has(n)) out.push(n);
    }
  }
  return Array.from(new Set(out));
}

const GENERIC_STREET_WORDS = new Set([
  "street", "avenue", "drive", "boulevard", "court", "crescent", "place", "parkway", "highway",
  "south", "north", "suite", "floor", "plaza", "centre", "center", "route",
  "square", "terrace", "trail", "circle", "building", "level", "industrial",
]);

const ADDRESS_KEY = /(address|street|city|municipality|postal|zip)/i;

/** Identifying address pieces from a deal's facts (street lines, city). */
export function dealAddressFragments(extractedInfo: unknown): string[] {
  if (!isObj(extractedInfo)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(extractedInfo)) {
    if (k.startsWith("_") || !ADDRESS_KEY.test(k)) continue;
    const t = typeof v === "string" ? v : isObj(v) && typeof v.value === "string" ? v.value : null;
    if (!t) continue;
    if (/(city|municipality)/i.test(k)) {
      const n = normText(t);
      if (n.length >= 4) out.push(n);
    } else {
      out.push(...addressFragments(t));
    }
  }
  return Array.from(new Set(out));
}

/** The premises' street address from a deal's facts, if it has one. */
export function dealStreetAddress(extractedInfo: unknown): string | null {
  if (!isObj(extractedInfo)) return null;
  const read = (v: unknown) => (typeof v === "string" ? v : isObj(v) && typeof v.value === "string" ? v.value : null);
  for (const key of ["address", "businessAddress", "streetAddress", "premisesAddress", "leaseAddress", "locationAddress"]) {
    // First line only: merged facts are sometimes glued with newlines.
    const t = read(extractedInfo[key])?.split("\n")[0].trim();
    // A street address has a number and a word ("12 Lakeshore Rd E, …").
    if (t && /\d/.test(t) && /[a-z]{3,}/i.test(t) && t.length <= MEDIA_LIMITS.addressChars) return t;
  }
  return null;
}

// ── Shape normalisation (write path and read path) ────────────────────────

export interface GalleryImage {
  mediaId?: string;
  url?: string;
  caption?: string;
  alt?: string;
}
export interface GalleryData {
  title?: string;
  style: "grid" | "carousel";
  columns?: 2 | 3 | 4;
  images: GalleryImage[];
  relatedSections?: string[];
}

export interface VideoItem {
  source: "youtube" | "vimeo" | "upload";
  url?: string;
  mediaId?: string;
  title?: string;
  caption?: string;
  /** YouTube/Vimeo only — uploaded videos use the library's flag. */
  blindSafe?: boolean;
}
export interface VideoData {
  title?: string;
  items: VideoItem[];
  relatedSections?: string[];
}

export interface MapLocation {
  label?: string;
  address?: string;
  note?: string;
  /** Blind CIM only: the province/state shown instead of the address. */
  region?: string;
}
export interface LocationMapData {
  title?: string;
  caption?: string;
  zoom?: number;
  /** What a blind buyer sees: the region only (default) or no map. */
  blindMap?: "region" | "hide";
  locations: MapLocation[];
  /** Set on the blind copy: every location is a region, not an address. */
  regionOnly?: boolean;
  relatedSections?: string[];
}

function related(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length < 120).slice(0, 10);
  return out.length ? out : undefined;
}

function clean<T extends AnyRecord>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export function normalizeGallery(raw: unknown): GalleryData {
  const d = isObj(raw) ? raw : {};
  const images: GalleryImage[] = [];
  for (const it of Array.isArray(d.images) ? d.images : []) {
    if (!isObj(it)) continue;
    const mediaId = isMediaId(it.mediaId) ? it.mediaId : undefined;
    const url = mediaId ? undefined : safeHttpsUrl(it.url);
    if (!mediaId && !url) continue;
    images.push(clean({
      mediaId,
      url,
      caption: str(it.caption, MEDIA_LIMITS.captionChars),
      alt: str(it.alt, MEDIA_LIMITS.captionChars),
    }));
    if (images.length >= MEDIA_LIMITS.galleryImages) break;
  }
  const cols = d.columns === 2 || d.columns === 3 || d.columns === 4 ? d.columns : undefined;
  return clean({
    title: str(d.title, MEDIA_LIMITS.titleChars),
    style: (d.style === "carousel" ? "carousel" : "grid") as GalleryData["style"],
    columns: cols as GalleryData["columns"],
    images,
    relatedSections: related(d.relatedSections),
  });
}

export function normalizeVideo(raw: unknown): VideoData {
  const d = isObj(raw) ? raw : {};
  const items: VideoItem[] = [];
  for (const it of Array.isArray(d.items) ? d.items : []) {
    if (!isObj(it)) continue;
    const base = {
      title: str(it.title, MEDIA_LIMITS.titleChars),
      caption: str(it.caption, MEDIA_LIMITS.captionChars),
    };
    if (it.source === "upload" || (!it.url && isMediaId(it.mediaId))) {
      if (!isMediaId(it.mediaId)) continue;
      items.push(clean({ source: "upload" as const, mediaId: it.mediaId, ...base }));
    } else {
      const parsed = parseVideoUrl(it.url);
      if (!parsed) continue;
      items.push(clean({ source: parsed.source, url: parsed.watchUrl, ...base, blindSafe: it.blindSafe === true ? true : undefined }));
    }
    if (items.length >= MEDIA_LIMITS.videos) break;
  }
  return clean({ title: str(d.title, MEDIA_LIMITS.titleChars), items, relatedSections: related(d.relatedSections) });
}

export function normalizeLocationMap(raw: unknown): LocationMapData {
  const d = isObj(raw) ? raw : {};
  const locations: MapLocation[] = [];
  for (const it of Array.isArray(d.locations) ? d.locations : []) {
    if (!isObj(it)) continue;
    const address = str(it.address, MEDIA_LIMITS.addressChars);
    const label = str(it.label, MEDIA_LIMITS.titleChars);
    const note = str(it.note, MEDIA_LIMITS.captionChars);
    // Keep half-filled rows while the broker types (a label with no address
    // yet); buyers only ever get rows with an address.
    if (!address && !label && !note) continue;
    locations.push(clean({ label, address, note }));
    if (locations.length >= MEDIA_LIMITS.locations) break;
  }
  return clean({
    title: str(d.title, MEDIA_LIMITS.titleChars),
    caption: str(d.caption, MEDIA_LIMITS.captionChars),
    zoom: d.zoom !== undefined ? clampZoom(d.zoom) : undefined,
    blindMap: (d.blindMap === "hide" ? "hide" : "region") as LocationMapData["blindMap"],
    locations,
    relatedSections: related(d.relatedSections),
  });
}

/** Normalise a media layout's data (validation on every write). */
export function normalizeMediaLayoutData(layoutType: MediaLayoutKey, raw: unknown): AnyRecord {
  switch (layoutType) {
    case "image_gallery": return normalizeGallery(raw) as unknown as AnyRecord;
    case "video": return normalizeVideo(raw) as unknown as AnyRecord;
    case "location_map": return normalizeLocationMap(raw) as unknown as AnyRecord;
  }
}

/** Every uploaded file a media section's data points at. */
export function mediaIdsIn(layoutType: string, raw: unknown): string[] {
  if (!isMediaLayout(layoutType) || !isObj(raw)) return [];
  const list = layoutType === "image_gallery" ? raw.images : layoutType === "video" ? raw.items : null;
  if (!Array.isArray(list)) return [];
  return list.map((it) => (isObj(it) && isMediaId(it.mediaId) ? it.mediaId : null)).filter((x): x is string => !!x);
}

/** The data with every reference to one upload removed. */
export function withoutMedia(layoutType: string, raw: unknown, mediaId: string): AnyRecord | null {
  if (!isObj(raw)) return null;
  const key = layoutType === "image_gallery" ? "images" : layoutType === "video" ? "items" : null;
  if (!key || !Array.isArray(raw[key])) return null;
  const list = raw[key] as unknown[];
  const next = list.filter((it) => !(isObj(it) && it.mediaId === mediaId));
  return next.length === list.length ? null : { ...raw, [key]: next };
}

// ── The redactor's view: text only ───────────────────────────────────────

/**
 * What the AI redactor sees of a media section: its words only, in item
 * order — no upload ids, links, addresses or flags. The redacted copy keeps
 * this shape, and buyerMediaLayoutData() lays it back over the real items
 * by position, so the AI can never add, swap or reveal a photo or address.
 */
export function mediaTextSkeleton(layoutType: MediaLayoutKey, raw: unknown): AnyRecord {
  switch (layoutType) {
    case "image_gallery": {
      const g = normalizeGallery(raw);
      return clean({ title: g.title, images: g.images.map((i) => clean({ caption: i.caption, alt: i.alt })) });
    }
    case "video": {
      const v = normalizeVideo(raw);
      return clean({ title: v.title, items: v.items.map((i) => clean({ title: i.title, caption: i.caption })) });
    }
    case "location_map": {
      const m = normalizeLocationMap(raw);
      return clean({ title: m.title, caption: m.caption, locations: m.locations.map((l) => clean({ label: l.label, note: l.note })) });
    }
  }
}

// ── What a buyer receives ─────────────────────────────────────────────────

export interface BuyerMediaContext {
  /**
   * The deal's media library. Uploads not in it (deleted, or another
   * deal's) are dropped. Null = unknown: blind drops every upload; normal
   * keeps them (GET /api/media still checks each one).
   */
  assets: ReadonlyMap<string, MediaAssetRef> | null;
  /** Normalised identifiers that must never reach a blind buyer. */
  identifiers?: string[];
}

function redactedText(override: unknown, path: (o: AnyRecord) => unknown, needles: string[]): string | undefined {
  if (!isObj(override)) return undefined;
  let v: unknown;
  try {
    v = path(override);
  } catch {
    return undefined;
  }
  const t = str(v, MEDIA_LIMITS.captionChars);
  if (!t) return undefined;
  const n = normText(t);
  return needles.some((id) => id.length >= 4 && n.includes(id)) ? undefined : t;
}

const at = (o: AnyRecord, key: string, i: number): AnyRecord => {
  const list = o[key];
  return Array.isArray(list) && isObj(list[i]) ? (list[i] as AnyRecord) : {};
};

/**
 * A media section's data as a buyer may receive it, or null when nothing in
 * it may be shown (the section is then dropped).
 *
 * Normal / DD: the base data, normalised, uploads limited to this deal's
 * library. Blind: only blind-safe media, maps reduced to regions, and every
 * word from the redacted override (by position) — never the base text.
 */
export function buyerMediaLayoutData(
  layoutType: MediaLayoutKey,
  base: unknown,
  override: unknown,
  mode: "blind" | "normal" | "dd",
  ctx: BuyerMediaContext,
): AnyRecord | null {
  const assets = ctx.assets;
  const blind = mode === "blind";
  const known = (id: string | undefined, kind: "image" | "video") => {
    if (!id) return false;
    if (!assets) return !blind;
    const a = assets.get(id);
    return !!a && a.kind === kind && (!blind || a.blindSafe);
  };

  if (layoutType === "image_gallery") {
    const g = normalizeGallery(base);
    if (!blind) {
      const images = g.images.filter((i) => (i.mediaId ? known(i.mediaId, "image") : !!i.url));
      return images.length ? { ...g, images } : null;
    }
    const needles = blindNeedles(ctx, []);
    const images: GalleryImage[] = [];
    g.images.forEach((img, i) => {
      // Web-address photos are never blind: the link can name the business.
      if (!img.mediaId || !known(img.mediaId, "image")) return;
      const o = isObj(override) ? at(override, "images", i) : {};
      images.push(clean({
        mediaId: img.mediaId,
        caption: redactedText(o, (x) => x.caption, needles),
        alt: redactedText(o, (x) => x.alt, needles),
      }));
    });
    if (!images.length) return null;
    return clean({
      title: redactedText(override, (x) => x.title, needles),
      style: g.style,
      columns: g.columns,
      images,
      relatedSections: g.relatedSections,
    });
  }

  if (layoutType === "video") {
    const v = normalizeVideo(base);
    if (!blind) {
      const items = v.items
        .filter((it) => (it.source === "upload" ? known(it.mediaId, "video") : !!it.url))
        .map(({ blindSafe: _b, ...it }) => it);
      return items.length ? { ...v, items } : null;
    }
    const needles = blindNeedles(ctx, []);
    const items: VideoItem[] = [];
    v.items.forEach((it, i) => {
      const ok = it.source === "upload" ? known(it.mediaId, "video") : it.blindSafe === true && !!it.url;
      if (!ok) return;
      const o = isObj(override) ? at(override, "items", i) : {};
      items.push(clean({
        source: it.source,
        url: it.source === "upload" ? undefined : it.url,
        mediaId: it.source === "upload" ? it.mediaId : undefined,
        title: redactedText(o, (x) => x.title, needles),
        caption: redactedText(o, (x) => x.caption, needles),
      }));
    });
    if (!items.length) return null;
    return clean({ title: redactedText(override, (x) => x.title, needles), items, relatedSections: v.relatedSections });
  }

  // location_map
  const m = normalizeLocationMap(base);
  const withAddress = m.locations.filter((l) => !!l.address);
  if (!blind) {
    if (!withAddress.length) return null;
    const { blindMap: _bm, ...rest } = m;
    return { ...rest, locations: withAddress };
  }
  if (m.blindMap === "hide") return null;
  const needles = blindNeedles(ctx, m.locations.flatMap((l) => addressFragments(l.address)));
  const seen = new Set<string>();
  const locations: MapLocation[] = [];
  m.locations.forEach((loc, i) => {
    const region = regionFromAddress(loc.address);
    if (!region || seen.has(region)) return;
    seen.add(region);
    const o = isObj(override) ? at(override, "locations", i) : {};
    locations.push(clean({
      label: redactedText(o, (x) => x.label, needles),
      note: redactedText(o, (x) => x.note, needles),
      region,
    }));
  });
  if (!locations.length) return null;
  return clean({
    title: redactedText(override, (x) => x.title, needles),
    caption: redactedText(override, (x) => x.caption, needles),
    zoom: REGION_ZOOM,
    regionOnly: true,
    locations,
    relatedSections: m.relatedSections,
  });
}

function blindNeedles(ctx: BuyerMediaContext, extra: string[]): string[] {
  return [...(ctx.identifiers ?? []), ...extra].map(normText).filter((n) => n.length >= 4);
}
