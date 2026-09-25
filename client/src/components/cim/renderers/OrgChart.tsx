/**
 * OrgChart renderer
 * CSS tree, no external library. Fits the page it is on: a level whose
 * cards don't fit side by side (5+ direct reports on paper, 2+ on a phone)
 * wraps into a grid under one connector instead of running off the right
 * edge — the old fixed-width row put Lakeshore's 5th manager at x=1034 on a
 * ~620px page and clipped Beacon's owner in print.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { ProseFallback, renderInline } from "../richText";
import { useElementWidth } from "./chartFormat";

interface OrgNode {
  id: string;
  name: string;
  role: string;
  reportsTo?: string;
  isKeyPerson?: boolean;
  isOwner?: boolean;
  yearsAtCompany?: number | string | null;
  notes?: string;
}

interface OrgChartLayoutData {
  nodes?: OrgNode[];
  title?: string;
  totalHeadcount?: number;
  ownerDependency?: string;
}

interface RendererProps {
  layoutData: OrgChartLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

interface TreeNode extends OrgNode {
  children: TreeNode[];
}

/** Card width (160px) + the padding beside it, in px. */
const SLOT = 176;
/** Paper is ~720px wide in print: never lay out wider than that, so print matches the screen. */
const PAPER_MAX = 720;

export function buildOrgTree(nodes: OrgNode[]): TreeNode[] {
  const map: Record<string, TreeNode> = {};
  nodes.forEach((n, i) => {
    const id = n.id != null && String(n.id) ? String(n.id) : `__${i}`;
    if (!map[id]) map[id] = { ...n, id, children: [] };
  });
  const roots: TreeNode[] = [];
  const seen = new Set<string>();
  nodes.forEach((n, i) => {
    const id = n.id != null && String(n.id) ? String(n.id) : `__${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    const parent = n.reportsTo != null ? map[String(n.reportsTo)] : undefined;
    // A node that reports to itself (or to nobody we know) is a root.
    if (parent && parent.id !== id) parent.children.push(map[id]);
    else roots.push(map[id]);
  });
  return roots;
}

/** How many cards fit side by side in `width` px (at least 1). */
export function cardsPerRow(width: number): number {
  return Math.max(1, Math.floor(Math.min(width, PAPER_MAX) / SLOT));
}

/** Cards a subtree needs side by side if laid out as a plain tree. */
function treeSpan(node: TreeNode): number {
  if (node.children.length === 0) return 1;
  return Math.max(1, node.children.reduce((sum, c) => sum + treeSpan(c), 0));
}

function NodeCard({ node, stretch }: { node: TreeNode; stretch?: boolean }) {
  const years = node.yearsAtCompany != null && String(node.yearsAtCompany).trim() !== "" ? String(node.yearsAtCompany) : null;
  return (
    <div className={cn(
      "relative bg-card border rounded-lg px-4 py-3 text-center shadow-sm",
      stretch ? "w-full max-w-[180px]" : "w-[150px] sm:w-[160px]",
      node.isOwner ? "border-teal/40" : node.isKeyPerson ? "border-blue/30" : "border-card-border"
    )}>
      <p className="text-sm font-semibold text-foreground leading-tight break-words">{node.name}</p>
      <p className="text-xs text-muted-foreground mt-0.5 leading-snug break-words">{node.role}</p>
      <div className="flex items-center justify-center gap-1 mt-2 flex-wrap">
        {node.isOwner && (
          <span className="text-2xs px-1.5 py-0.5 rounded-full bg-teal-muted text-teal-muted-foreground font-semibold">
            Owner
          </span>
        )}
        {node.isKeyPerson && !node.isOwner && (
          <span className="text-2xs px-1.5 py-0.5 rounded-full bg-blue-muted text-blue-muted-foreground font-semibold">
            Key Person
          </span>
        )}
        {years && (
          <span className="text-2xs text-muted-foreground/60">{/^\d+(\.\d+)?$/.test(years) ? `${years}y` : years}</span>
        )}
      </div>
      {node.notes && (
        <p className="text-2xs text-muted-foreground/60 mt-1 leading-snug break-words">{renderInline(node.notes, "notes")}</p>
      )}
    </div>
  );
}

const Stem = ({ className }: { className?: string }) => <div className={cn("w-px bg-border mx-auto", className)} aria-hidden />;

/**
 * How wide each child's column is in a row of `kids` within `width` px:
 * every child gets one card slot, and what is left over goes to the
 * children with teams of their own, in proportion to how wide those teams are.
 */
export function childShares(kids: TreeNode[], width: number): number[] {
  const perRow = cardsPerRow(width);
  const weights = kids.map((c) => Math.min(treeSpan(c), perRow) - 1);
  const extra = Math.max(0, Math.min(width, PAPER_MAX) - kids.length * SLOT);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => SLOT + (total > 0 ? (extra * w) / total : 0));
}

/**
 * One node and everything under it, laid out in exactly `width` px (every
 * column gets an explicit width, so nothing can overlap or run off the
 * page). Direct reports that fit side by side hang from a joined bar;
 * more than fit wrap into a grid under one connector (one per row on a
 * phone), each keeping its own team beneath it.
 */
function Subtree({ node, width }: { node: TreeNode; width: number }) {
  const kids = node.children;
  const perRow = cardsPerRow(width);
  const asRow = kids.length > 0 && kids.length <= perRow;
  const cols = Math.min(perRow, kids.length);
  const leafy = kids.every((c) => c.children.length === 0);
  const cellWidth = leafy ? SLOT : Math.min(width, PAPER_MAX) / Math.max(1, cols);
  const shares = asRow ? childShares(kids, width) : [];
  return (
    <div className="flex flex-col items-center min-w-0" data-org-node={node.id}>
      <NodeCard node={node} />
      {kids.length > 0 && <Stem className="h-5" />}
      {asRow && (
        <div className="flex justify-center" data-org-level="row">
          {kids.map((child, i) => (
            <div key={child.id} className="relative flex flex-col items-center pt-4 shrink-0" style={{ width: shares[i] }}>
              {/* the bar joining siblings: each child draws its half */}
              {kids.length > 1 && (
                <span
                  aria-hidden
                  className="absolute top-0 h-px bg-border"
                  style={{ left: i === 0 ? "50%" : 0, right: i === kids.length - 1 ? "50%" : 0 }}
                />
              )}
              <span aria-hidden className="absolute top-0 left-1/2 w-px h-4 bg-border" />
              <Subtree node={child} width={shares[i]} />
            </div>
          ))}
        </div>
      )}
      {kids.length > 0 && !asRow && (
        <div
          className="border-t border-border pt-4 grid gap-y-5 justify-items-center"
          style={{ gridTemplateColumns: `repeat(${cols}, ${Math.floor(cellWidth)}px)`, width: Math.floor(cellWidth) * cols }}
          data-org-level="grid"
        >
          {kids.map((child) => (
            <div key={child.id} className="flex flex-col items-center min-w-0">
              <Subtree node={child} width={cellWidth} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function OrgChartRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: OrgChartLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const nodes = (data.nodes || []).filter((n) => n && typeof n === "object");
  const { ref, width } = useElementWidth<HTMLDivElement>();

  if (nodes.length === 0) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  const tree = buildOrgTree(nodes);
  // Before the first measurement (and in server rendering) assume paper width.
  const available = width > 0 ? width : PAPER_MAX;

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-5">
          {data.title}
        </h3>
      )}

      <div ref={ref} className="w-full cim-org-chart break-inside-avoid">
        <div className="flex flex-col items-center gap-6">
          {tree.map((root) => (
            <Subtree key={root.id} node={root} width={available} />
          ))}
        </div>
      </div>

      {(data.totalHeadcount != null || data.ownerDependency) && (
        <div className="mt-5 pt-4 border-t border-border flex items-center gap-6 flex-wrap">
          {data.totalHeadcount != null && (
            <div>
              <p className="text-2xs text-muted-foreground uppercase tracking-wide">Total Headcount</p>
              <p className="text-sm font-semibold text-foreground">{data.totalHeadcount}</p>
            </div>
          )}
          {data.ownerDependency && (
            <div>
              <p className="text-2xs text-muted-foreground uppercase tracking-wide">Owner Dependency</p>
              <p className="text-sm font-medium text-foreground">{data.ownerDependency}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
