/**
 * Source kinds as the broker sees them — labels, icons and chip text for the
 * Information tab, the Sources panel and the Add source dialog.
 */
import {
  MessageSquare,
  Phone,
  Video,
  FileText,
  Mail,
  Database,
  Globe,
  AtSign,
  ClipboardList,
  PencilLine,
  History,
  Cpu,
  type LucideIcon,
} from "lucide-react";
import type { FactSourceInfo, FactSourceKind } from "@shared/information";
import { formatShortDate } from "./source-dates";

export const KIND_META: Record<FactSourceKind, { label: string; plural: string; icon: LucideIcon }> = {
  interview: { label: "Seller interview", plural: "Seller interview", icon: MessageSquare },
  call: { label: "Call", plural: "Calls", icon: Phone },
  video_call: { label: "Video call", plural: "Video calls", icon: Video },
  document: { label: "Document", plural: "Documents", icon: FileText },
  email: { label: "Email", plural: "Emails", icon: Mail },
  crm: { label: "CRM note", plural: "CRM", icon: Database },
  website: { label: "Website", plural: "Website", icon: Globe },
  social: { label: "Social media", plural: "Social", icon: AtSign },
  questionnaire: { label: "Questionnaire", plural: "Questionnaire", icon: ClipboardList },
  broker: { label: "You", plural: "Your edits", icon: PencilLine },
  system: { label: "System", plural: "System", icon: Cpu },
  // Collected before Cimple recorded provenance and not traceable to a source.
  unknown: { label: "Earlier record", plural: "Earlier records", icon: History },
};

/** Plain-words explanations for facts from before source tracking. */
export const UNTRACKED_HINT =
  "Collected before Cimple started recording where each fact came from, and it doesn't match any source on file. Check it against the sources, or edit it to confirm it yourself.";
export const INFERRED_HINT =
  "Collected before Cimple recorded sources. Traced to this source because the value matches what it says.";

/** Filter-chip order (the founder's list). */
export const FILTER_KINDS: FactSourceKind[] = [
  "interview", "call", "video_call", "document", "email", "crm", "website", "social", "questionnaire", "broker",
];

/** The kinds a broker can add as a source. */
export const ADDABLE_KINDS = [
  { kind: "document", label: "Document", hint: "P&L, lease, tax return, any file" },
  { kind: "email", label: "Email", hint: "A message or thread with the seller" },
  { kind: "call", label: "Call transcript", hint: "Phone or in-person conversation" },
  { kind: "video_call", label: "Video-call transcript", hint: "Zoom, Meet, Teams" },
  { kind: "crm", label: "CRM note", hint: "Your own notes — kept broker-only" },
  { kind: "website", label: "Website / social post", hint: "Public page or post — unverified" },
] as const;
export type AddableKind = (typeof ADDABLE_KINDS)[number]["kind"] | "social";

// Date-only source dates ("2026-09-09") are calendar days, not UTC midnight — see source-dates.ts.
export { formatShortDate, parseSourceDate, sourceDateValue } from "./source-dates";

/** Notes on broker facts that came from the deal row (server/information/deal-mirror.ts MIRROR_NOTES / RECONCILED_NOTES). */
const DEAL_DETAIL_NOTES = /^(Entered when the deal was created|Changed in the deal's details|.+ on the deal)$/;

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, "");
}

/** The short text on a fact's source chip. */
export function sourceChipText(src: FactSourceInfo): string {
  const text = baseChipText(src);
  // The broker vouched for a website / CRM / social value ("Accept into facts").
  return src.acceptedByBroker && (src.kind === "website" || src.kind === "crm" || src.kind === "social") ? `${text} · accepted` : text;
}

function baseChipText(src: FactSourceInfo): string {
  const kind = src.kind;
  switch (kind) {
    case "interview":
      return typeof src.turn === "number" ? `Interview · turn ${src.turn}` : "Interview";
    case "call":
      if (src.documentName) return `Call · ${stripExt(src.documentName)}`;
      return typeof src.turn === "number" ? `Call · turn ${src.turn}` : "Call";
    case "video_call":
      if (src.documentName) return `Video call · ${stripExt(src.documentName)}`;
      return typeof src.turn === "number" ? `Video call · turn ${src.turn}` : "Video call";
    case "document":
      return src.documentName ? `Document · ${src.documentName}` : "Document";
    case "email": {
      const when = formatShortDate(src.at);
      return src.documentName ? `Email · ${stripExt(src.documentName)}` : when ? `Email · ${when}` : "Email";
    }
    case "crm":
      // "CRM note — Site visit…" → "CRM · Site visit…"; "CRM call — Intro call" → "CRM · call — Intro call"
      return src.documentName ? `CRM · ${src.documentName.replace(/^CRM (note|record) — /, "").replace(/^CRM /, "")}` : "CRM note";
    case "website":
      return "Website";
    case "social":
      return "Social media";
    case "questionnaire":
      return "Questionnaire";
    case "broker": {
      const when = formatShortDate(src.at);
      if (src.note === "Resolved discrepancy") return `You · resolved ${when ?? ""}`.trim();
      // The deal's own details (name, industry, price) entered at creation or in the deal form.
      if (src.note === "Set in Valuation") return "You · valuation";
      if (src.note && DEAL_DETAIL_NOTES.test(src.note)) return "You · deal details";
      if (src.note?.startsWith("Chose")) return `You · chose ${when ?? ""}`.trim();
      return `You · edited ${when ?? ""}`.trim();
    }
    default:
      return "Earlier record";
  }
}
