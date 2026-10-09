/**
 * Teaser — the client's view of the broker API (server/routes/teaser.ts) and
 * the buyer API (/api/view/:token/…). Types come from shared/teaser.ts; the
 * full state mirrors server/teaser/summary.ts TeaserStateView.
 */
import type {
  KeyCell,
  TeaserAutoGrant,
  TeaserBlock,
  TeaserBlockCheck,
  TeaserDoc,
  TeaserEngagement,
  TeaserEngagementBuyer,
  TeaserGeneration,
  TeaserLinkLifetime,
  TeaserPageSize,
  TeaserSummary,
} from "@shared/teaser";
import type { NumberStyle } from "@shared/deal-bands";
import type { BuyerSection } from "@shared/cim-buyer-view";
import type { CimDesignPayload } from "@/components/cim/CimDesignContext";

export type {
  KeyCell,
  TeaserAutoGrant,
  TeaserBlock,
  TeaserBlockCheck,
  TeaserDoc,
  TeaserEngagement,
  TeaserEngagementBuyer,
  TeaserGeneration,
  TeaserLinkLifetime,
  TeaserPageSize,
  TeaserSummary,
};

export interface TeaserFillView {
  price: string | null;
  contact: string | null;
  firm: string;
}

export interface TeaserStateTeaser {
  id: string;
  templateKey: string;
  templateName: string;
  designTemplateId: string | null;
  pageSize: TeaserPageSize;
  numbers: NumberStyle;
  showAskingPrice: boolean;
  linkLifetime: TeaserLinkLifetime;
  autoGrant: TeaserAutoGrant;
  draft: TeaserDoc;
  draftRev: number;
  checks: TeaserBlockCheck[];
  headerProblem: string | null;
  codename: string;
  codenameProblem: string | null;
  generation: TeaserGeneration | null;
  reviewConfirmed: { by: string | null; at: string } | null;
  sellerCheck: { status: string; sentAt: string; sentRev: number; at: string | null; byName: string | null; note: string | null } | null;
  publishedRev: number;
  publishedAt: string | null;
  unpublishedAt: string | null;
  canUndo: boolean;
  hasPublished: boolean;
}

/** GET /api/deals/:id/teaser when a teaser exists (and every mutation's answer). */
export interface TeaserState {
  teaser: TeaserStateTeaser;
  summary: TeaserSummary;
  staleness: Array<{ label: string; published: string; now: string }>;
  engagementCounts: TeaserSummary["counts"];
  notes: string[];
  fill: TeaserFillView | null;
  design: CimDesignPayload | null;
  /** The seller-team owner who can check the teaser (null = nobody to send it to yet). */
  sellerOwner: string | null;
}

export interface SavedTemplateItem {
  id: string;
  key: string;
  name: string;
  basedOn: string | null;
  blocks: number;
  settings: { pageSize?: TeaserPageSize; numbers?: NumberStyle; showAskingPrice?: boolean };
  createdAt: string;
}

/** GET /api/deals/:id/teaser before one is written. */
export interface TeaserEmpty {
  teaser: null;
  canWrite: { ok: boolean; reasons: string[]; notes: string[] };
  basis: "blind_cim" | "redacted_facts";
  templates: SavedTemplateItem[];
  defaultTemplate: string | null;
  summary: TeaserSummary;
  sellerOwner: string | null;
}

export type TeaserRead = TeaserState | TeaserEmpty;

export function hasTeaser(r: TeaserRead | undefined | null): r is TeaserState {
  return !!r && r.teaser !== null;
}

/** The broker's preview (GET …/teaser/preview) and the buyer's teaser payload share this shape. */
export interface TeaserPayload {
  document: "teaser";
  deal: { id: string; businessName: string; industry: string | null };
  teaser: { header: { label: string; codename: string; tagline: string; chips: string[] }; blocks: BuyerSection[]; pageSize: TeaserPageSize };
  design: CimDesignPayload | null;
  branding: { companyName: string | null; logoUrl: string | null; disclaimer: string | null } | null;
  contact: { firm: string | null; name: string | null; email: string | null; phone: string | null };
  ndaRequired: boolean;
}

export interface TeaserPreviewPayload extends TeaserPayload {
  preview: true;
  draft: boolean;
  heldBack: Array<{ blockId: string; reason: string }>;
}

export const teaserKey = (dealId: string) => ["/api/deals", dealId, "teaser"] as const;
export const teaserSummaryKey = (dealId: string) => ["/api/deals", dealId, "teaser", "summary"] as const;
export const teaserEngagementKey = (dealId: string) => ["/api/deals", dealId, "teaser", "engagement"] as const;
export const teaserPreviewKey = (dealId: string, draft: boolean) => ["/api/deals", dealId, "teaser", "preview", draft ? "draft" : "published"] as const;
export const teaserTemplatesKey = ["/api/broker/teaser-templates"] as const;
export const teaserBrokerSettingsKey = ["/api/broker/teaser-settings"] as const;

/** An error the server sent, with its code ("stale", "has_draft", "cant_publish"…) and body. */
export class TeaserApiError extends Error {
  constructor(message: string, public status: number, public code: string | null, public body: any) {
    super(message);
    this.name = "TeaserApiError";
  }
}

/** JSON request that throws the server's own sentence (and keeps its code). */
export async function teaserRequest<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* a proxy page during a deploy */
  }
  if (!res.ok) {
    const msg = (data && typeof data.error === "string" && data.error)
      || (res.status === 401 ? "Your session has ended — sign in again." : res.status === 429 ? "Too many tries — wait a little and try again." : "Something went wrong. Please try again.");
    throw new TeaserApiError(msg, res.status, data && typeof data.code === "string" ? data.code : null, data);
  }
  return data as T;
}

export function teaserErrorText(err: unknown, fallback = "Something went wrong. Please try again."): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function isApiCode(err: unknown, code: string): err is TeaserApiError {
  return err instanceof TeaserApiError && err.code === code;
}

/** "Oct 9" — the short date used across the teaser screens. */
export function shortDay(v: string | Date | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
