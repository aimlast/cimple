/**
 * Shapes and labels shared by the buyer profile page components
 * (GET /api/broker/buyers/:id/profile — server/buyers/profile-view.ts).
 */
import { BUYER_CRITERIA_FIELDS, BUYER_CRITERIA_SECTIONS, type MergedFieldSource } from "@shared/schema";

export type SourceKind = MergedFieldSource["source"];

export interface ProfileFields {
  name: string;
  phone: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  buyerType: string | null;
  background: string | null;
  liquidFunds: string | null;
  liquidFundsIsRange?: boolean;
  hasProofOfFunds: boolean | null;
  targetIndustries: string[];
  targetLocations: string[];
  buyerCriteria: Record<string, any>;
}

export interface DealRow {
  dealId: string;
  businessName: string;
  accessId: string;
  accessLevel: string;
  status: "active" | "expired" | "revoked";
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  firstViewedAt: string | null;
  lastAccessedAt: string | null;
  views: number;
  seconds: number;
  sectionsViewed: number;
  topSections: Array<{ key: string; title: string; seconds: number }>;
  questions: number;
  ndaSignedAt: string | null;
  decision: string | null;
  decisionAt: string | null;
  decisionNextStep: string | null;
  decisionReason: string | null;
  linkedToAccount: boolean;
  deepCheck: { verdict: "strong" | "good" | "possible" | "unlikely"; fitScore: number; whyFit: string; watchOuts: string[]; checkedAt: string } | null;
}

export interface NdaAnswerRow {
  dealId: string;
  businessName: string;
  signedAt: string | null;
  summary: string;
  answers: Record<string, any>;
}

export interface CrmLayer {
  provider: string;
  recordId: string | null;
  syncedAt: string | null;
  profile: {
    buyerType?: string | null;
    background?: string | null;
    liquidFunds?: string | null;
    hasProofOfFunds?: boolean | null;
    targetIndustries?: string[];
    targetLocations?: string[];
    buyerCriteria?: Record<string, any>;
    inquiries?: Array<{ title: string; stage?: string | null; status?: string | null }>;
    inferred?: string[];
    evidence?: Record<string, string>;
    extractedAt?: string;
  };
}

export interface BuyerProfileResponse {
  buyer: {
    id: string;
    email: string;
    hasAccount: boolean;
    emailVerified: boolean;
    accountSource: string | null;
    createdAt: string;
    lastLoginAt: string | null;
    profileCompletionPct: number;
  };
  profile: ProfileFields;
  sources: Record<string, MergedFieldSource>;
  layers: {
    own: ProfileFields & { liquidFundsIsRange?: boolean };
    /** Scoped to this broker: another brokerage's writes come back as source "other", no deal id. */
    ownSources: Record<string, { source: string; at: string | null; dealId?: string | null; legacy?: boolean }>;
    crm: CrmLayer | null;
    overlay: Record<string, any>;
    overlayMeta: Record<string, { at: string }>;
  };
  contact: {
    id: string | null;
    source: string | null;
    tags: string[];
    notes: string | null;
    interestStatus: InterestStatus | null;
    addedAt: string;
    aiSummary: { text: string; at: string; stale: boolean } | null;
  };
  deals: DealRow[];
  ndaAnswers: NdaAnswerRow[];
  approvals: Array<{
    id: string; dealId: string; businessName: string; status: string; category: string; background: string | null;
    isCompetitor: boolean | null; createdAt: string; grantedAt: string | null; rejectionReason: string | null;
  }>;
  emails: Array<{ id: string; dealId: string | null; subject: string; status: string; sentAt: string | null; createdAt: string }>;
}

export interface TimelineEvent {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail?: string | null;
  dealId?: string | null;
  dealName?: string | null;
  tone?: "positive" | "negative" | "neutral";
}

export type InterestStatus = "hot" | "warm" | "cold" | "not_interested";

export const INTEREST_OPTIONS: Array<{ value: InterestStatus; label: string; dot: string; chip: string }> = [
  { value: "hot", label: "Hot", dot: "bg-red-400", chip: "border-red-500/30 bg-red-500/10 text-red-400" },
  { value: "warm", label: "Warm", dot: "bg-amber-400", chip: "border-amber-500/30 bg-amber-500/10 text-amber-400" },
  { value: "cold", label: "Cold", dot: "bg-sky-400", chip: "border-sky-500/30 bg-sky-500/10 text-sky-400" },
  { value: "not_interested", label: "Not interested", dot: "bg-muted-foreground/60", chip: "border-border bg-muted/40 text-muted-foreground" },
];

export const BUYER_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "individual", label: "Individual buyer" },
  { value: "strategic", label: "Strategic acquirer" },
  { value: "private_equity", label: "Private equity" },
  { value: "family_office", label: "Family office" },
  { value: "search_fund", label: "Search fund" },
  { value: "financial", label: "Financial buyer" },
];
export const buyerTypeLabel = (v: string | null | undefined) =>
  (v && BUYER_TYPE_OPTIONS.find((o) => o.value === v)?.label) || (v ? humanize(v) : null);

export const SOURCE_META: Record<string, { label: string; chip: string; describe: string }> = {
  broker: { label: "Your edit", chip: "border-teal/40 bg-teal/10 text-teal", describe: "You changed this — private to you" },
  buyer: { label: "Buyer", chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400", describe: "Entered by the buyer on their Cimple profile" },
  nda: { label: "NDA", chip: "border-sky-500/30 bg-sky-500/10 text-sky-400", describe: "From what they answered when signing an NDA" },
  crm: { label: "Pipedrive", chip: "border-orange-500/30 bg-orange-500/10 text-orange-400", describe: "Read from your CRM record — private to you" },
  csv: { label: "CSV", chip: "border-purple-500/30 bg-purple-500/10 text-purple-400", describe: "From a CSV you imported" },
  broker_import: { label: "Added by you", chip: "border-border bg-muted/50 text-muted-foreground", describe: "Entered when you added this buyer" },
  approval: { label: "Approval", chip: "border-indigo-500/30 bg-indigo-500/10 text-indigo-400", describe: "From a buyer approval request" },
  other: { label: "On their profile", chip: "border-border bg-muted/40 text-muted-foreground", describe: "Already on this buyer's Cimple profile" },
};

export const humanize = (s: string) =>
  s.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

/** Criteria grouped by section, in BUYER_CRITERIA_SECTIONS order (targets live elsewhere). */
export const CRITERIA_GROUPS = Object.entries(BUYER_CRITERIA_SECTIONS).map(([section, def]) => ({
  section,
  label: def.label,
  keys: Object.keys(def.fields).filter((k) => BUYER_CRITERIA_FIELDS[k]),
}));
export { BUYER_CRITERIA_FIELDS };

export function parseMoney(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.toLowerCase().replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kmb])?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === "k") n *= 1e3; else if (m[2] === "m") n *= 1e6; else if (m[2] === "b") n *= 1e9;
  return n;
}

export function formatMoney(v: unknown): string {
  const n = parseMoney(v);
  if (n == null) return typeof v === "string" ? v : "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

/** Display text for one criterion value. */
export function formatCriterion(key: string, v: unknown): string {
  const def = BUYER_CRITERIA_FIELDS[key];
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) return "—";
  if (!def) return Array.isArray(v) ? v.join(", ") : String(v);
  switch (def.type) {
    case "currency": return formatMoney(v);
    case "percent": return `${String(v).replace(/%$/, "")}%`;
    case "boolean": return v === true || v === "true" ? "Yes" : "No";
    case "select": return humanize(String(v));
    case "multiselect":
    case "tags": return (Array.isArray(v) ? v : [v]).map((x) => (def.type === "multiselect" ? humanize(String(x)) : String(x))).join(", ");
    default: return String(v);
  }
}

export const isSet = (v: unknown) =>
  !(v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

export const shortDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) : "—";

export function fmtDuration(s: number): string {
  if (!s) return "0 min";
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.round(s / 60)} min`;
  return `${s}s`;
}

/** JSON request that surfaces the server's own error message. */
export async function requestJson<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = String(data.error);
    } catch { /* keep status */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}
