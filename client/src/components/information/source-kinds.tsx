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
  HelpCircle,
  Cpu,
  type LucideIcon,
} from "lucide-react";
import type { FactSourceInfo, FactSourceKind } from "@shared/information";

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
  unknown: { label: "Source not recorded", plural: "Source not recorded", icon: HelpCircle },
};

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

export function formatShortDate(iso: string | null | undefined, withYear = false): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "yesterday";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear || d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, "");
}

/** The short text on a fact's source chip. */
export function sourceChipText(src: FactSourceInfo): string {
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
      return "CRM note";
    case "website":
      return "Website";
    case "social":
      return "Social media";
    case "questionnaire":
      return "Questionnaire";
    case "broker": {
      const when = formatShortDate(src.at);
      if (src.note === "Resolved discrepancy") return `You · resolved ${when ?? ""}`.trim();
      if (src.note?.startsWith("Chose")) return `You · chose ${when ?? ""}`.trim();
      return `You · edited ${when ?? ""}`.trim();
    }
    default:
      return "Source not recorded";
  }
}
