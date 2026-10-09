/**
 * The board's rail: the views (To ask, Everything, Filed this session, To
 * verify, Open questions, Documents still needed) and the CIM sections, each
 * with a status ring, a brass dot when the section is critical, and "on file
 * / items". On a phone it is the "Sections" tab (full width).
 */
import { orderedSections, sectionOnFile, viewCounts, VIEW_TITLE, type CoverageBoard, type CoverageView } from "@shared/coverage-board";
import { SectionRing } from "./StatusIcon";

export function CoverageRail({
  board,
  view,
  sectionKey,
  onSelect,
  live,
  sittingId,
  flashSections,
  fullWidth,
}: {
  board: CoverageBoard;
  view: CoverageView;
  sectionKey?: string;
  onSelect: (view: CoverageView, sectionKey?: string) => void;
  /** Live session: shows "Filed this session". */
  live?: boolean;
  sittingId?: string;
  flashSections?: ReadonlySet<string>;
  fullWidth?: boolean;
}) {
  const counts = viewCounts(board, sittingId);
  const views: Array<Exclude<CoverageView, "section">> = ["ask", "all", ...(live ? (["filed"] as const) : []), "verify", ...(counts.questions > 0 ? (["questions"] as const) : []), "docs"];
  const item = (active: boolean) =>
    `w-full flex items-center gap-2 rounded-md px-2.5 ${fullWidth ? "py-2.5 text-sm" : "py-1.5 text-[13px]"} text-left transition-colors ${active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50"}`;
  return (
    <nav aria-label="Checklist views" className="space-y-4" data-testid="coverage-rail">
      <ul className="space-y-0.5">
        {views.map((v) => (
          <li key={v}>
            <button type="button" className={item(view === v)} onClick={() => onSelect(v)} data-testid={`rail-view-${v}`} aria-current={view === v ? "page" : undefined}>
              <span className="flex-1 truncate">{v === "filed" ? "Filed this session" : VIEW_TITLE[v]}</span>
              <span className="tabular-nums text-xs">{counts[v]}</span>
            </button>
          </li>
        ))}
      </ul>
      <div>
        <p className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">CIM sections</p>
        <ul className="space-y-0.5">
          {orderedSections(board).map((s) => {
            const { onFile, items } = sectionOnFile(s);
            const active = view === "section" && sectionKey === s.key;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  className={`${item(active)} ${flashSections?.has(s.key) ? "cov-row-flash" : ""}`}
                  onClick={() => onSelect("section", s.key)}
                  data-testid={`rail-section-${s.key}`}
                  aria-current={active ? "page" : undefined}
                  title={s.importanceReason ? `${s.title} — ${s.importanceReason}` : s.title}
                >
                  <SectionRing counts={s.counts} />
                  {s.importance === "critical" ? <span className="h-1.5 w-1.5 rounded-full bg-teal shrink-0" aria-label="Critical section" /> : <span className="w-1.5 shrink-0" aria-hidden />}
                  <span className="flex-1 min-w-0 line-clamp-2 break-words leading-snug text-left">{s.title}</span>
                  <span className="tabular-nums text-xs">{onFile}/{items}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
