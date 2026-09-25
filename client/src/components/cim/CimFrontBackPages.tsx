/**
 * The CIM's brokerage pages — generated from the brokerage's brand
 * settings, not stored as sections:
 *
 *   Confidentiality & disclaimer — right after the cover (when the brokerage
 *     keeps "Disclaimer page" on). Their disclaimer text, or a standard one.
 *   Contact — the last page (when "Contact page" is on): who to call.
 *
 * Both carry only brokerage information, so they are identical in the
 * Blind, Normal and DD CIMs. `withBrokeragePages()` places them in a
 * section list; hosts render the items it returns.
 */
import { useState } from "react";
import { Globe, Mail, MapPin, Phone, ShieldCheck, UserRound } from "lucide-react";
import { DEFAULT_DISCLAIMER } from "@shared/cim-theme";
import { useCimDesign, useThemeStyle } from "./CimDesignContext";
import { CimSectionHeading } from "./CimSectionHeading";

export type CimPageItem<S> =
  | { kind: "section"; key: string; section: S }
  | { kind: "disclaimer"; key: "cim-disclaimer" }
  | { kind: "contact"; key: "cim-contact" };

/**
 * The section list with the brokerage pages in place: the disclaimer after
 * the cover (or first, when there is no cover), the contact page last.
 */
export function withBrokeragePages<S extends { id: string; layoutType: string }>(
  sections: readonly S[],
  opts: { disclaimer: boolean; contact: boolean },
): CimPageItem<S>[] {
  const items: CimPageItem<S>[] = sections.map((s) => ({ kind: "section", key: s.id, section: s }));
  if (items.length === 0) return items;
  if (opts.disclaimer) {
    const at = sections[0]?.layoutType === "cover_page" ? 1 : 0;
    items.splice(at, 0, { kind: "disclaimer", key: "cim-disclaimer" });
  }
  if (opts.contact) items.push({ kind: "contact", key: "cim-contact" });
  return items;
}

/** The brokerage-page switches from the current design. */
export function useBrokeragePageFlags(): { disclaimer: boolean; contact: boolean } {
  const { brokerage } = useCimDesign();
  return { disclaimer: brokerage.showDisclaimerPage !== false, contact: brokerage.showContactPage !== false };
}

export function CimDisclaimerPage() {
  const design = useCimDesign();
  const style = useThemeStyle();
  const t = design.theme;
  const text = design.brokerage.disclaimer?.trim() || DEFAULT_DISCLAIMER;
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className="cim-doc cim-section relative" style={style} data-section-key="cim-disclaimer" data-layout-type="disclaimer_page">
      <div className="rounded-lg border px-6 py-7 sm:px-10 sm:py-10" style={{ borderColor: t.line, backgroundColor: t.card }}>
        <div className="flex items-center gap-2 mb-5">
          <ShieldCheck className="h-4 w-4 shrink-0" style={{ color: t.accent }} />
          <span className="text-2xs font-semibold uppercase tracking-[0.2em]" style={{ color: t.accentText }}>Confidential</span>
        </div>
        <CimSectionHeading title="Confidentiality & Disclaimer" />
        <div className="space-y-3.5 max-w-prose">
          {paragraphs.map((p, i) => (
            <p key={i} className="text-sm leading-[1.75]" style={{ color: t.inkSoft }}>{p}</p>
          ))}
        </div>
        {design.brokerage.firmName && (
          <p className="mt-6 text-xs" style={{ color: t.inkMuted }}>
            Prepared by {design.brokerage.firmName}
          </p>
        )}
      </div>
    </div>
  );
}

function ContactLine({ icon, children, href }: { icon: React.ReactNode; children: React.ReactNode; href?: string }) {
  const t = useCimDesign().theme;
  const inner = (
    <span className="flex items-start gap-3 min-w-0">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: t.accentSoft, color: t.accentSoftText }}>
        {icon}
      </span>
      <span className="text-sm leading-relaxed break-words min-w-0 pt-1" style={{ color: t.ink }}>{children}</span>
    </span>
  );
  return href ? <a href={href} className="block hover:underline" target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer noopener">{inner}</a> : inner;
}

export function CimContactPage() {
  const design = useCimDesign();
  const style = useThemeStyle();
  const t = design.theme;
  const b = design.brokerage;
  const [logoFailed, setLogoFailed] = useState(false);
  const website = b.website ? (b.website.startsWith("http") ? b.website : `https://${b.website}`) : null;
  const hasDetails = !!(b.contactName || b.phone || b.email || b.website || b.address);
  return (
    <div className="cim-doc cim-section relative" style={style} data-section-key="cim-contact" data-layout-type="contact_page">
      <CimSectionHeading title="Contact" />
      <div className="rounded-lg border overflow-hidden" style={{ borderColor: t.line, backgroundColor: t.card }}>
        <div className="h-1.5" style={{ backgroundColor: t.accent }} />
        <div className="grid gap-8 px-6 py-7 sm:px-10 sm:py-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="min-w-0">
            {b.logoUrl && !logoFailed ? (
              <img src={b.logoUrl} alt={b.firmName ? `${b.firmName} logo` : "Brokerage logo"} onError={() => setLogoFailed(true)} className="max-h-14 max-w-[220px] w-auto object-contain mb-4" />
            ) : null}
            {b.firmName && <p className="cim-heading text-xl tracking-tight">{b.firmName}</p>}
            <p className="text-sm mt-2 leading-relaxed" style={{ color: t.inkSoft }}>
              All enquiries about this opportunity, requests for more information and site visits go through us. Please don't contact the business directly.
            </p>
          </div>
          <div className="space-y-3.5 min-w-0">
            {b.contactName && <ContactLine icon={<UserRound className="h-3.5 w-3.5" />}>{b.contactName}</ContactLine>}
            {b.phone && <ContactLine icon={<Phone className="h-3.5 w-3.5" />} href={`tel:${b.phone.replace(/[^\d+]/g, "")}`}>{b.phone}</ContactLine>}
            {b.email && <ContactLine icon={<Mail className="h-3.5 w-3.5" />} href={`mailto:${b.email}`}>{b.email}</ContactLine>}
            {website && <ContactLine icon={<Globe className="h-3.5 w-3.5" />} href={website}>{b.website!.replace(/^https?:\/\//, "").replace(/\/$/, "")}</ContactLine>}
            {b.address && <ContactLine icon={<MapPin className="h-3.5 w-3.5" />}>{b.address}</ContactLine>}
            {!hasDetails && (
              <p className="text-sm" style={{ color: t.inkMuted }}>Contact your broker for more information.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
