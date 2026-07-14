/**
 * fundsToRange — buckets a free-text money amount into a coarse range.
 *
 * A buyer's self-entered liquid funds carry a privacy promise ("brokers see a
 * range, never the exact amount"). Anywhere that value is shown to a broker or
 * seller, run it through this so the exact figure never leaks. Unparseable but
 * non-empty input returns "Amount on file" rather than echoing the raw text.
 */
const BUCKETS: Array<{ max: number; label: string }> = [
  { max: 250_000, label: "Under $250K" },
  { max: 1_000_000, label: "$250K–$1M" },
  { max: 5_000_000, label: "$1M–$5M" },
  { max: 25_000_000, label: "$5M–$25M" },
  { max: Infinity, label: "$25M+" },
];

export function fundsToRange(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;

  const amount = parseAmount(text);
  if (amount === null) return "Amount on file";

  return BUCKETS.find((b) => amount < b.max)!.label;
}

/** Parses the first monetary figure in a string, honoring k/m/b + word suffixes. */
function parseAmount(text: string): number | null {
  const lower = text.toLowerCase();
  // First number, optional decimal, optional immediate k/m/b suffix.
  const m = lower.match(/(\d[\d,]*\.?\d*)\s*([kmb])?/);
  if (!m) return null;

  let value = parseFloat(m[1].replace(/,/g, ""));
  if (isNaN(value)) return null;

  const suffix = m[2];
  if (suffix === "k") value *= 1_000;
  else if (suffix === "m") value *= 1_000_000;
  else if (suffix === "b") value *= 1_000_000_000;
  else if (/\b(thousand)\b/.test(lower)) value *= 1_000;
  else if (/\b(million|mil|mm)\b/.test(lower)) value *= 1_000_000;
  else if (/\b(billion|bn)\b/.test(lower)) value *= 1_000_000_000;

  return value;
}
