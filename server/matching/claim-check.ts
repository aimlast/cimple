/**
 * Checking what the outside-buyer research says about each organisation
 * against the pages it cites.
 *
 * A source URL being real (urlMatches) does not make the sentence citing it
 * true: the research once said "Manitoulin Group (a TFI company) acquired…"
 * from an article that says nothing about TFI (Manitoulin is independent).
 * So every claim — the "why they'd be interested" line and each evidence
 * point — is checked by the supporting model against the cited text: the
 * excerpts the search returned, and, when those don't settle it, the source
 * page itself (web fetch, limited to the entry's own source sites).
 *
 *   - an unsupported evidence point is removed;
 *   - an unsupported "why" is replaced by one built only from supported
 *     claims, or — when nothing is supported — the organisation is dropped;
 *   - an organisation whose claims couldn't be checked (the check failed)
 *     is kept but marked, so the broker checks it before reaching out;
 *   - a "way to reach the buyers" keeps only organisation names the
 *     research text actually mentions.
 *
 * Broker-facing only; nothing here is sent to anyone.
 */
import type { ExternalAcquirer } from "@shared/schema";

export interface Claim {
  id: string;           // "why" | "e1" | "e2" | "e3"
  text: string;
}

export interface ClaimVerdict {
  id: string;
  supported: boolean;
  reason?: string | null;
}

export interface AcquirerCheck {
  claims: ClaimVerdict[];
  /** A "why they'd be interested" written only from supported claims (null = nothing supported). */
  supportedWhy?: string | null;
}

export interface ChannelCheck {
  keep: boolean;
  /** The "how" with unsupported organisation names / facts taken out. */
  how?: string | null;
}

export type Channel = { name: string; how: string; url?: string | null };

/** The claims an entry makes, with stable ids. */
export function claimsFor(a: Pick<ExternalAcquirer, "whyInterested" | "evidence">): Claim[] {
  const out: Claim[] = [{ id: "why", text: a.whyInterested }];
  (a.evidence ?? []).forEach((e, i) => out.push({ id: `e${i + 1}`, text: e }));
  return out;
}

/** Drop tracking parameters (utm_*, fbclid…) from a source URL. */
export function stripTracking(u: string): string {
  try {
    const url = new URL(u);
    for (const k of Array.from(url.searchParams.keys())) {
      if (/^(?:utm_|fbclid$|gclid$|mc_[ce]id$|ref$|ref_src$|igshid$|_hs|mkt_tok$|cmpid$|src$|sr_share$)/i.test(k)) url.searchParams.delete(k);
    }
    const s = url.toString();
    return s.endsWith("?") ? s.slice(0, -1) : s;
  } catch {
    return u;
  }
}

export interface AppliedChecks {
  results: ExternalAcquirer[];
  channels: Channel[];
  /** Claims removed because the cited pages didn't back them. */
  removedClaims: number;
  /** Organisations dropped because none of their claims was backed. */
  droppedUnsupported: number;
  /** Organisations whose claims couldn't be checked (marked, kept). */
  unchecked: number;
}

/**
 * Apply the checker's verdicts. Pure — the research job and the tests share
 * it. `checks[i]` belongs to `results[i]`; a missing entry means the check
 * didn't run for it. `researchText` is what the searches returned (excerpts
 * and titles) — a channel may only name organisations that appear in it.
 */
export function applyClaimChecks(
  results: ExternalAcquirer[],
  checks: Array<AcquirerCheck | null | undefined>,
  channels: Channel[],
  channelChecks: Array<ChannelCheck | null | undefined> | null,
  researchText: string,
): AppliedChecks {
  let removedClaims = 0, droppedUnsupported = 0, unchecked = 0;
  const kept: ExternalAcquirer[] = [];
  results.forEach((a, i) => {
    const check = checks[i];
    if (!check || !Array.isArray(check.claims)) {
      unchecked++;
      kept.push({ ...a, claimsUnchecked: true });
      return;
    }
    const verdict = new Map(check.claims.map((c) => [String(c.id), !!c.supported]));
    // A claim the checker didn't answer is not backed.
    const supported = (id: string) => verdict.get(id) === true;
    const evidence = (a.evidence ?? []).filter((_, j) => supported(`e${j + 1}`));
    removedClaims += (a.evidence ?? []).length - evidence.length;
    let why: string | null = a.whyInterested;
    if (!supported("why")) {
      removedClaims++;
      const rewritten = (check.supportedWhy || "").trim();
      why = rewritten || evidence[0] || null;
    }
    if (!why) {
      droppedUnsupported++;
      return;
    }
    const { claimsUnchecked: _drop, ...rest } = a as ExternalAcquirer & { claimsUnchecked?: boolean };
    kept.push({ ...rest, whyInterested: why.slice(0, 500), evidence, claimsChecked: true });
  });

  const corpus = researchText.toLowerCase();
  const outChannels: Channel[] = [];
  channels.forEach((c, i) => {
    const check = channelChecks?.[i];
    if (check && check.keep === false) return;
    let how = (check?.how || "").trim() || c.how;
    // Named examples must appear in what the searches returned; without a
    // check, examples in brackets are dropped rather than trusted.
    how = how.replace(/\s*\((?:e\.g\.?,?|for example,?|such as|like)\s+([^)]*)\)/gi, (m, list: string) => {
      if (!check) return "";
      const names = list.split(/,|\bor\b|\band\b/).map((s) => s.trim()).filter(Boolean);
      const known = names.filter((n) => n.length >= 3 && corpus.includes(n.toLowerCase()));
      return known.length ? ` (e.g. ${known.join(", ")})` : "";
    });
    how = how.replace(/\s{2,}/g, " ").trim();
    if (how) outChannels.push({ ...c, how });
  });

  return { results: kept, channels: outChannels, removedClaims, droppedUnsupported, unchecked };
}

export const CHECK_TOOL = {
  name: "report_claim_checks",
  description: "Whether each claim is backed by its sources.",
  input_schema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref: { type: "string" },
            claims: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  supported: { type: "boolean", description: "True only when the source text states this claim — including WHO did it (the acquirer named, or a subsidiary the source itself says it owns)." },
                  reason: { type: "string", description: "Short: which source says it, or what is missing / wrong." },
                },
                required: ["id", "supported", "reason"],
              },
            },
            supportedWhy: { type: ["string", "null"], description: "When the 'why' claim is not fully supported: 1-2 sentences saying why this organisation might be interested, using ONLY supported facts. Null when nothing is supported." },
          },
          required: ["ref", "claims", "supportedWhy"],
        },
      },
    },
    required: ["entries"],
  },
};

export const CHANNEL_TOOL = {
  name: "report_channel_checks",
  description: "Which suggested outreach channels are backed by the research.",
  input_schema: {
    type: "object",
    properties: {
      channels: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref: { type: "string" },
            keep: { type: "boolean", description: "False when the channel rests on a factual claim the research text doesn't back." },
            how: { type: ["string", "null"], description: "The 'how' text with any organisation named as an example removed unless the research text names it in that role (a lender must be a lender, an association an association). General advice may stay." },
          },
          required: ["ref", "keep", "how"],
        },
      },
    },
    required: ["channels"],
  },
};

export const CHECK_SYSTEM = [
  "You are a strict fact-checker for an M&A buyer list. For each organisation you get its claims and its source URLs with the excerpts the web search returned.",
  "A claim is SUPPORTED only when a source states it. Attribution matters: a deal done by another company is not this organisation's deal unless the source says that company belongs to it; a figure or date must match the source.",
  "Use the excerpts first. When they don't settle a claim, fetch that source page with web_fetch (only the listed URLs) and read it. A tag, search or listing page that doesn't state the claim does not support it.",
  "When the 'why' claim is not fully supported, write supportedWhy from the supported facts only (or null if nothing is supported). Never add facts.",
  "When done, call report_claim_checks once with every ref and every claim id.",
].join(" ");
