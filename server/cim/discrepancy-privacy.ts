/**
 * Discrepancy text that could reach the seller never quotes or names the
 * broker's private material. Shared by the verification check and the
 * financial analysis.
 */
import {
  mentionsPrivateSource,
  PRIVATE_REFERENCE_RE,
  type DiscrepancySideSources,
} from "@shared/discrepancy-sides";
import type { SourceKind } from "@shared/schema";

export interface ScrubInput {
  field: string;
  interviewValue: string;
  documentValue: string;
  aiExplanation: string;
  suggestedResolution: string;
  sideSources: DiscrepancySideSources;
}

/**
 * Keep broker-private material out of anything that could reach the seller:
 * a private side's value stays in its own column (flagged brokerOnly), but
 * the explanation and suggestion never quote it or name its source.
 */
export function scrubPrivateText(
  item: ScrubInput,
): Omit<ScrubInput, "field"> {
  const sides: DiscrepancySideSources = { ...item.sideSources };
  let { interviewValue, documentValue } = item;
  // A value that cites a private source ("36 employees (per broker note)"):
  // the side is private, and the citation is dropped from the stored text.
  const stripCitation = (v: string) => {
    let out = v
      // "(per broker note)", "[CRM]"
      .replace(/\s*[([][^)\]]*[)\]]/g, (m) => (PRIVATE_REFERENCE_RE.test(m) ? "" : m))
      // "… per broker recast", "… from the CRM notes and site visit"
      .replace(/[\s,;]*\b(?:per|from|according to|in|via|based on)\s+(?:the\s+|a\s+|my\s+|our\s+)?\S*\s*(?:\S+\s+){0,2}?(?:broker(?:'s|’s)?\s+\w+|crm\b|pipedrive|hubspot|site[- ]visit|private notes?)[\s\S]*$/i, "")
      // "… — CRM note"
      .replace(/\s*[—–]\s*[^—–]*$/, (m) => (PRIVATE_REFERENCE_RE.test(m) ? "" : m));
    // Anything still naming it goes.
    out = out.replace(new RegExp(PRIVATE_REFERENCE_RE.source, "gi"), "").replace(/\s{2,}/g, " ").replace(/[\s,;:(—–-]+$/, "");
    return out.trim();
  };
  if (mentionsPrivateSource(interviewValue)) {
    interviewValue = stripCitation(interviewValue);
    sides.interview = { ...(sides.interview ?? { kind: "crm" as SourceKind }), brokerOnly: true };
  }
  if (mentionsPrivateSource(documentValue)) {
    documentValue = stripCitation(documentValue);
    sides.document = { ...(sides.document ?? { kind: "crm" as SourceKind }), brokerOnly: true };
  }
  const privateValues = [
    sides.interview?.brokerOnly ? interviewValue : "",
    sides.document?.brokerOnly ? documentValue : "",
  ].filter(Boolean);
  const quotes = (text: string) => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const t = norm(text);
    return privateValues.some((v) => {
      const nv = norm(v);
      if (nv.length >= 3 && t.includes(nv)) return true;
      // Any distinctive number from the private value (3+ digits, as a whole number).
      const digits = (s: string) => (s.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/[,.]/g, ""));
      const inText = new Set(digits(text));
      return digits(v).some((n) => n.length >= 3 && inText.has(n));
    });
  };
  let { aiExplanation, suggestedResolution } = item;
  const anyPrivate = !!sides.interview?.brokerOnly || !!sides.document?.brokerOnly;
  const visibleSide = sides.document?.brokerOnly ? "interview" : "document";
  const visibleValue = visibleSide === "document" ? documentValue : interviewValue;
  const visibleLabel = sides[visibleSide]?.label ? `the ${sides[visibleSide]!.label.replace(/^Document:\s*/, "")}` : visibleSide === "document" ? "the documents" : "the seller";
  const field = (item.field || "this").trim();
  const what = /^[A-Z][a-z]/.test(field) ? field.charAt(0).toLowerCase() + field.slice(1) : field;
  if (mentionsPrivateSource(aiExplanation) || (anyPrivate && quotes(aiExplanation))) {
    aiExplanation = visibleValue
      ? `${visibleLabel.charAt(0).toUpperCase()}${visibleLabel.slice(1)} ${visibleSide === "document" ? "shows" : "says"}: ${visibleValue}. Another figure on file for ${what} differs.`
      : `The figures on file for ${what} don't agree.`;
  }
  if (mentionsPrivateSource(suggestedResolution) || (anyPrivate && quotes(suggestedResolution))) {
    suggestedResolution = `Confirm the correct ${what} with the seller or from the source documents.`;
  }
  return { interviewValue, documentValue, aiExplanation, suggestedResolution, sideSources: sides };
}

