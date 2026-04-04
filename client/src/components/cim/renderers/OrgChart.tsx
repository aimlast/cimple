/**
 * OrgChart renderer
 * CSS flexbox tree. Groups nodes by level. No external library.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface OrgNode {
  id: string;
  name: string;
  role: string;
  reportsTo?: string;
  isKeyPerson?: boolean;
  isOwner?: boolean;
  yearsAtCompany?: number;
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

function buildTree(nodes: OrgNode[]): TreeNode[] {
  const map: Record<string, TreeNode> = {};
  nodes.forEach((n) => {
    map[n.id] = { ...n, children: [] };
  });
  const roots: TreeNode[] = [];
  nodes.forEach((n) => {
    if (n.reportsTo && map[n.reportsTo]) {
      map[n.reportsTo].children.push(map[n.id]);
    } else {
      roots.push(map[n.id]);
    }
  });
  return roots;
}

function NodeCard({ node }: { node: TreeNode }) {
  return (
    <div className={cn(
      "relative bg-card border rounded-lg px-4 py-3 min-w-[140px] max-w-[180px] text-center shadow-sm",
      node.isOwner ? "border-teal/40" : node.isKeyPerson ? "border-blue/30" : "border-card-border"
    )}>
      {/* Name */}
      <p className="text-sm font-semibold text-foreground leading-tight">{node.name}</p>
      {/* Role */}
      <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{node.role}</p>
      {/* Badges */}
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
        {node.yearsAtCompany != null && (
          <span className="text-2xs text-muted-foreground/60">{node.yearsAtCompany}y</span>
        )}
      </div>
      {/* Notes */}
      {node.notes && (
        <p className="text-2xs text-muted-foreground/60 mt-1 leading-snug">{node.notes}</p>
      )}
    </div>
  );
}

function TreeLevel({ nodes }: { nodes: TreeNode[] }) {
  if (nodes.length === 0) return null;

  return (
    <div className="flex flex-col items-center gap-0">
      {/* Current level cards */}
      <div className="flex items-start justify-center gap-4 flex-wrap">
        {nodes.map((node) => (
          <div key={node.id} className="flex flex-col items-center">
            <NodeCard node={node} />
            {/* Connector + children */}
            {node.children.length > 0 && (
              <div className="flex flex-col items-center">
                {/* Vertical connector */}
                <div className="w-px h-5 bg-border" />
                {/* Horizontal bar (if multiple children) */}
                {node.children.length > 1 && (
                  <div
                    className="h-px bg-border"
                    style={{ width: `${(node.children.length - 1) * 188 + 1}px` }}
                  />
                )}
                {/* Children */}
                <div className="flex items-start gap-4 pt-0">
                  {node.children.map((child) => (
                    <div key={child.id} className="flex flex-col items-center">
                      <div className="w-px h-4 bg-border" />
                      <TreeLevel nodes={[child]} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function OrgChartRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: OrgChartLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const nodes = data.nodes || [];

  if (nodes.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  const tree = buildTree(nodes);

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-5">
          {data.title}
        </h3>
      )}

      {/* Tree */}
      <div className="overflow-x-auto pb-2">
        <div className="min-w-fit mx-auto">
          <TreeLevel nodes={tree} />
        </div>
      </div>

      {/* Footer stats */}
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
