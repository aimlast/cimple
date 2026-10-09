/**
 * Coverage status icons — the shape carries the status, not only the colour:
 * a filled check (on file), a half-filled circle (partial), a dashed ring
 * with "?" (to verify), an empty ring (missing). Each has an aria-label.
 */
import type { CoverageItemStatus } from "@shared/coverage-board";
import { STATUS_LABEL } from "@shared/coverage-board";

export function StatusIcon({ status, size = 16, className = "" }: { status: CoverageItemStatus; size?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", role: "img", "aria-label": STATUS_LABEL[status], className: `shrink-0 ${className}` } as const;
  switch (status) {
    case "on_file":
      return (
        <svg {...common} data-status="on_file">
          <circle cx="8" cy="8" r="7.25" fill="hsl(var(--coverage-on))" />
          <path d="M4.8 8.3 7 10.4l4.3-4.6" fill="none" stroke="hsl(var(--background))" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "partial":
      return (
        <svg {...common} data-status="partial">
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="hsl(var(--coverage-partial))" strokeWidth="1.4" />
          <path d="M8 1.4a6.6 6.6 0 0 0 0 13.2Z" fill="hsl(var(--coverage-partial))" />
        </svg>
      );
    case "verify":
      return (
        <svg {...common} data-status="verify">
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="hsl(var(--coverage-verify))" strokeWidth="1.4" strokeDasharray="2.2 1.8" />
          <text x="8" y="11.2" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="hsl(var(--coverage-verify))" fontFamily="var(--font-sans)">?</text>
        </svg>
      );
    default:
      return (
        <svg {...common} data-status="missing">
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="hsl(var(--coverage-missing))" strokeWidth="1.4" />
        </svg>
      );
  }
}

/** A section's status ring: a conic gradient of its counts. */
export function SectionRing({ counts, size = 14 }: { counts: Record<CoverageItemStatus, number>; size?: number }) {
  const total = counts.on_file + counts.partial + counts.verify + counts.missing;
  if (total === 0) {
    return <span aria-hidden className="inline-block rounded-full border border-border shrink-0" style={{ width: size, height: size }} />;
  }
  const pct = (n: number) => (n / total) * 100;
  const a = pct(counts.on_file);
  const b = a + pct(counts.partial);
  const c = b + pct(counts.verify);
  const bg = `conic-gradient(hsl(var(--coverage-on)) 0 ${a}%, hsl(var(--coverage-partial)) ${a}% ${b}%, hsl(var(--coverage-verify)) ${b}% ${c}%, hsl(var(--coverage-missing)) ${c}% 100%)`;
  return (
    <span
      aria-label={`${counts.on_file} of ${total} on file`}
      role="img"
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, background: bg, WebkitMask: `radial-gradient(circle, transparent ${size * 0.22}px, #000 ${size * 0.24}px)`, mask: `radial-gradient(circle, transparent ${size * 0.22}px, #000 ${size * 0.24}px)` }}
    />
  );
}
