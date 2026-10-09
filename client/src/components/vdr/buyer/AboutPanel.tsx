/**
 * "About this document" beside the viewer (vdr spec §6.3): the description
 * the broker accepted (or the basic line), up to 4 points. Key figures,
 * checks against other documents, "Used in the memorandum" and the reader's
 * questions arrive with Cimple's notes (later in this release).
 */
import type { BuyerItemAbout } from "@shared/vdr-api";

export function AboutPanel({ about }: { about: BuyerItemAbout }) {
  return (
    <div className="space-y-4 text-sm" data-testid="vdr-about">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">About this document</h3>
        <p className="mt-1.5 font-medium text-foreground">{about.title}</p>
        <p className="text-xs text-muted-foreground">{about.sizeLabel}</p>
      </div>
      <div>
        <p className="leading-relaxed text-foreground/90">{about.description.text}</p>
        {about.description.points.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-foreground/90">
            {about.description.points.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
