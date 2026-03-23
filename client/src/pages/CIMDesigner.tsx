import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ArrowLeft, Save, Wand2, Eye, FileText, Palette, Layout,
  GripVertical, ChevronUp, ChevronDown, Loader2, Download, Share2,
  BarChart3, Bold, Italic, Heading3, List, CheckCircle2, Circle,
  RefreshCw, Monitor, Smartphone, ZoomIn, ZoomOut, ExternalLink,
  Type, AlignLeft, Minus, Hash
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Deal, CimSection, BrandingSettings } from "@shared/schema";
import DataVisualizationsPanel from "@/components/DataVisualizationsPanel";

export const CIM_SECTION_TEMPLATES = [
  { key: "executiveSummary", title: "Executive Summary", description: "Snapshot of key business metrics and investment highlights", category: "overview" },
  { key: "companyOverview", title: "Company Overview", description: "Company and owner descriptions, operational details", category: "company" },
  { key: "historyMilestones", title: "History & Milestones", description: "Business history and key achievements", category: "company" },
  { key: "uniqueSellingPropositions", title: "Unique Selling Propositions", description: "Competitive advantages and differentiators", category: "company" },
  { key: "sourcesOfRevenue", title: "Sources of Revenue", description: "Revenue streams and business model", category: "company" },
  { key: "growthStrategies", title: "Growth Strategies", description: "Growth opportunities and expansion plans", category: "company" },
  { key: "targetMarket", title: "Target Market", description: "Customer profile and market positioning", category: "company" },
  { key: "permitsLicenses", title: "Permits & Licenses", description: "Required licenses and regulatory compliance", category: "company" },
  { key: "seasonality", title: "Seasonality", description: "Seasonal patterns and business cycles", category: "company" },
  { key: "locationSite", title: "Location & Site", description: "Facility details and lease information", category: "company" },
  { key: "employeeOverview", title: "Employee Overview", description: "Team structure and key personnel", category: "company" },
  { key: "transactionOverview", title: "Transaction Overview", description: "Deal structure, training, reason for sale, assets", category: "transaction" },
  { key: "financialOverview", title: "Financial Overview", description: "Financial summary and due diligence information", category: "financial" },
];

const CATEGORY_LABELS: Record<string, string> = {
  overview: "Overview",
  company: "Company Information",
  transaction: "Transaction",
  financial: "Financials",
};

interface SectionData {
  id?: string;
  key: string;
  title: string;
  content: string;
  isIncluded: boolean;
  order: number;
}

// ─── Rich Text Editor ───────────────────────────────────────────────────────
function RichTextEditor({
  value,
  onChange,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const wrapSelection = useCallback((before: string, after = before) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end);
    const newValue = value.slice(0, start) + before + selected + after + value.slice(end);
    onChange(newValue);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + before.length, end + before.length);
    }, 0);
  }, [value, onChange]);

  const prependLine = useCallback((prefix: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = value.indexOf("\n", start);
    const line = value.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    let newValue: string;
    let newCursor: number;
    if (line.startsWith(prefix)) {
      newValue = value.slice(0, lineStart) + line.slice(prefix.length) + value.slice(lineEnd === -1 ? value.length : lineEnd);
      newCursor = start - prefix.length;
    } else {
      newValue = value.slice(0, lineStart) + prefix + line + value.slice(lineEnd === -1 ? value.length : lineEnd);
      newCursor = start + prefix.length;
    }
    onChange(newValue);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(newCursor, newCursor);
    }, 0);
  }, [value, onChange]);

  const insertHr = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const pos = el.selectionStart;
    const newValue = value.slice(0, pos) + "\n\n---\n\n" + value.slice(pos);
    onChange(newValue);
    setTimeout(() => { el.focus(); el.setSelectionRange(pos + 7, pos + 7); }, 0);
  }, [value, onChange]);

  const toolbarActions = [
    { icon: Bold, label: "Bold (⌘B)", action: () => wrapSelection("**") },
    { icon: Italic, label: "Italic (⌘I)", action: () => wrapSelection("_") },
    { icon: Hash, label: "Section heading", action: () => prependLine("### ") },
    { icon: Type, label: "Sub-heading", action: () => prependLine("#### ") },
    { icon: List, label: "Bullet list", action: () => prependLine("- ") },
    { icon: Minus, label: "Horizontal rule", action: insertHr },
  ];

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "b") { e.preventDefault(); wrapSelection("**"); }
    if ((e.metaKey || e.ctrlKey) && e.key === "i") { e.preventDefault(); wrapSelection("_"); }
    if (e.key === "Tab") {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const newValue = value.slice(0, start) + "  " + value.slice(el.selectionEnd);
      onChange(newValue);
      setTimeout(() => { el.setSelectionRange(start + 2, start + 2); }, 0);
    }
  };

  return (
    <div className="flex flex-col border rounded-md overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 bg-muted/40 border-b">
        {toolbarActions.map((action, i) => (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={action.action}
              >
                <action.icon className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{action.label}</TooltipContent>
          </Tooltip>
        ))}
        <Separator orientation="vertical" className="mx-1 h-4" />
        <span className="text-xs text-muted-foreground ml-1 hidden sm:block">Markdown formatting supported</span>
      </div>
      {/* Editor */}
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="min-h-[420px] resize-none rounded-none border-0 focus-visible:ring-0 font-mono text-sm leading-relaxed"
        data-testid={testId}
      />
      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/20 border-t text-xs text-muted-foreground">
        <span>{value.split(/\s+/).filter(Boolean).length} words · {value.length} characters</span>
        <span>**bold** · _italic_ · ### heading · - bullet</span>
      </div>
    </div>
  );
}

// ─── HTML generation (shared by Preview and Export) ─────────────────────────
export function generateCBOHtml(
  deal: Deal,
  sectionsData: SectionData[],
  branding: BrandingSettings | undefined,
  capturedVizs: string[] = []
): string {
  const cimContent: Record<string, string> = {};
  sectionsData.filter(s => s.isIncluded).forEach(s => { cimContent[s.key] = s.content; });

  const sectionTitles: Record<string, string> = {};
  CIM_SECTION_TEMPLATES.forEach(s => { sectionTitles[s.key] = s.title; });

  const pc = branding?.primaryColor || "220 70% 50%";
  const bodyFont = branding?.bodyFont || "Georgia";
  const headingFont = branding?.headingFont || "Inter";
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const brokerName = branding?.companyName || "";
  const disclaimerText = branding?.disclaimer || "";
  const footerTpl = branding?.footerTemplate || "";
  const logoUrl = branding?.logoUrl || "";

  const orderedKeys = CIM_SECTION_TEMPLATES.map(s => s.key);
  const presentSections = orderedKeys.filter(k => cimContent[k]);

  const info = (deal.extractedInfo as Record<string, any>) || {};
  const getVal = (k: string) => {
    const v = info[k];
    if (Array.isArray(v)) return v.join(", ");
    return v || "";
  };

  const footerLine = footerTpl
    ? footerTpl.replace(/\{businessName\}/g, deal.businessName)
    : `PRIVATE & CONFIDENTIAL | ${deal.businessName}${brokerName ? ` | ${brokerName}` : ""}`;

  const pageFooter = `<div class="page-footer">${footerLine}</div>`;

  const logoHtml = logoUrl
    ? `<img src="${logoUrl.startsWith("/") ? "" : ""}${logoUrl}" alt="Logo" style="max-height:80px;max-width:260px;object-fit:contain;margin-bottom:24px" />`
    : "";

  const coverPage = `
    <div class="cover-page">
      ${logoHtml}
      <div class="cover-label">CONFIDENTIAL BUSINESS OVERVIEW</div>
      <div class="cover-rule"></div>
      <h1 class="cover-title">${deal.businessName}</h1>
      <div class="cover-rule"></div>
      ${deal.industry ? `<p class="cover-industry">${deal.industry}</p>` : ""}
      ${getVal("locations") ? `<p class="cover-location">${getVal("locations")}</p>` : ""}
      <p class="cover-date">Prepared: ${today}</p>
      ${brokerName ? `<p class="cover-broker">${brokerName}</p>` : ""}
    </div>`;

  const disclaimerPage = disclaimerText ? `
    <div class="disclaimer-page">
      <h2 class="section-heading">Notice of Confidentiality &amp; Disclaimer</h2>
      <div class="disclaimer-text">${disclaimerText.replace(/\n/g, "<br/>")}</div>
      ${pageFooter}
    </div>` : "";

  const snapshotMetrics = [
    { label: "Industry", value: deal.industry || "N/A" },
    { label: "Location", value: getVal("locations") || "N/A" },
    { label: "Employees", value: getVal("employees") || "N/A" },
    { label: "Revenue Streams", value: getVal("revenueStreams") || getVal("keyProducts") || "N/A" },
    { label: "Reason for Sale", value: getVal("reasonForSale") || "N/A" },
    { label: "Capital Assets", value: getVal("assets") || "N/A" },
    { label: "Lease Details", value: getVal("leaseDetails") || "N/A" },
  ].filter(m => m.value && m.value !== "N/A");

  const snapshotGrid = snapshotMetrics.length > 0
    ? `<div class="snapshot-grid">${snapshotMetrics.map(m => `<div class="snapshot-cell"><div class="snapshot-label">${m.label}</div><div class="snapshot-value">${m.value}</div></div>`).join("")}</div>`
    : "";

  const execSummaryPage = `
    <div class="content-page">
      <h2 class="section-heading">Executive Summary</h2>
      ${snapshotGrid}
      ${cimContent.executiveSummary ? `<div class="section-body">${formatContent(cimContent.executiveSummary, pc)}</div>` : ""}
      ${pageFooter}
    </div>`;

  const companySections = presentSections.filter(k => k !== "executiveSummary" && k !== "transactionOverview" && k !== "financialOverview");

  let tocNum = 0;
  const tocEntries: { num: number; key: string; title: string }[] = [];
  tocEntries.push({ num: ++tocNum, key: "executiveSummary", title: "Executive Summary" });
  if (companySections.length > 0) {
    tocEntries.push({ num: ++tocNum, key: "companyOverviewGroup", title: "Company Overview" });
    companySections.forEach(k => {
      if (k !== "companyOverview") tocEntries.push({ num: 0, key: k, title: sectionTitles[k] || k });
    });
  }
  if (presentSections.includes("transactionOverview")) tocEntries.push({ num: ++tocNum, key: "transactionOverview", title: "Transaction Overview" });
  if (presentSections.includes("financialOverview")) tocEntries.push({ num: ++tocNum, key: "financialOverview", title: "Financial Overview" });
  if (capturedVizs.length > 0) tocEntries.push({ num: ++tocNum, key: "visualizations", title: "Data Visualizations &amp; Analysis" });

  const tocItems = tocEntries.map(e => {
    const isMain = e.num > 0;
    return `<a href="#section-${e.key}" class="toc-item ${isMain ? "" : "toc-sub"}">
      ${isMain ? `<span class="toc-num">${e.num}.</span>` : `<span class="toc-indent"></span>`}
      <span class="toc-label">${e.title}</span>
    </a>`;
  });

  const tocPage = `
    <div class="toc-page">
      <h2 class="section-heading">Table of Contents</h2>
      <div class="toc-list">${tocItems.join("")}</div>
      ${pageFooter}
    </div>`;

  const companySectionHtml = companySections.map(key => `
    <div id="section-${key}" class="content-section">
      <h3 class="subsection-title">${sectionTitles[key] || key}</h3>
      <div class="section-body">${formatContent(cimContent[key] || "", pc)}</div>
    </div>`).join("");

  const companyPage = companySections.length > 0 ? `
    <div id="section-companyOverviewGroup" class="content-page">
      <h2 class="section-heading">Company Overview</h2>
      ${companySectionHtml}
      ${pageFooter}
    </div>` : "";

  const transactionPage = presentSections.includes("transactionOverview") ? `
    <div id="section-transactionOverview" class="content-page">
      <h2 class="section-heading">Transaction Overview</h2>
      <div class="section-body">${formatContent(cimContent.transactionOverview || "", pc)}</div>
      ${pageFooter}
    </div>` : "";

  const financialPage = presentSections.includes("financialOverview") ? `
    <div id="section-financialOverview" class="content-page">
      <h2 class="section-heading">Financial Overview</h2>
      <div class="section-body">${formatContent(cimContent.financialOverview || "", pc)}</div>
      ${pageFooter}
    </div>` : "";

  let vizHtml = "";
  if (capturedVizs.length > 0) {
    vizHtml = `<div id="section-visualizations" class="content-page">
      <h2 class="section-heading">Data Visualizations &amp; Analysis</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">${capturedVizs.join("")}</div>
      ${pageFooter}
    </div>`;
  }

  const contactPage = brokerName ? `
    <div class="content-page">
      <h2 class="section-heading">Contact Us</h2>
      <div class="contact-block">
        ${logoHtml}
        <p class="contact-name">${brokerName}</p>
        <p class="contact-info">For inquiries regarding this opportunity, please contact your representing broker.</p>
        <div class="cover-rule" style="margin:24px auto"></div>
        <p class="contact-disclaimer">All inquiries are handled in strict confidence.</p>
      </div>
      ${pageFooter}
    </div>` : "";

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${deal.businessName} - Confidential Business Overview</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'${bodyFont}',Georgia,serif;max-width:850px;margin:0 auto;padding:0;color:#2d2d2d;line-height:1.7;font-size:13px}
      h1,h2,h3,h4{font-family:'${headingFont}',Inter,sans-serif}

      .cover-page{display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:95vh;text-align:center;page-break-after:always;padding:40px}
      .cover-label{font-size:11px;text-transform:uppercase;letter-spacing:6px;color:hsl(${pc});font-weight:600;margin-bottom:24px}
      .cover-title{font-size:34px;color:#1a1a1a;font-weight:700;line-height:1.2;margin:0}
      .cover-rule{width:80px;height:3px;background:hsl(${pc});margin:20px auto}
      .cover-industry{font-size:16px;color:#555;margin-top:12px}
      .cover-location{font-size:14px;color:#777;margin-top:6px}
      .cover-date{font-size:12px;color:#999;margin-top:28px}
      .cover-broker{font-size:13px;color:hsl(${pc});font-weight:600;margin-top:8px;text-transform:uppercase;letter-spacing:2px}

      .disclaimer-page{padding:40px 50px;page-break-after:always;min-height:90vh;display:flex;flex-direction:column}
      .disclaimer-text{flex:1;font-size:12px;line-height:1.8;color:#444;text-align:justify}

      .section-heading{font-size:20px;color:hsl(${pc});border-bottom:2px solid hsl(${pc});padding-bottom:10px;margin:0 0 24px 0;text-transform:uppercase;letter-spacing:2px;font-weight:600}
      .subsection-title{font-size:15px;color:hsl(${pc});font-weight:600;margin:28px 0 10px 0;padding-bottom:6px;border-bottom:1px solid #e5e5e5}
      .subsection-heading{font-size:14px;color:hsl(${pc});font-weight:600;margin:16px 0 8px 0}
      .section-body{text-align:justify;line-height:1.8;font-size:13px}
      .content-section{margin-bottom:20px}

      .content-page{padding:40px 50px;page-break-after:always;min-height:90vh;display:flex;flex-direction:column}
      .content-page .page-footer{margin-top:auto}

      .snapshot-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:#ddd;border:1px solid #ddd;margin-bottom:28px;border-radius:4px;overflow:hidden}
      .snapshot-cell{background:#fff;padding:14px 16px}
      .snapshot-label{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:hsl(${pc});font-weight:600;margin-bottom:4px}
      .snapshot-value{font-size:13px;color:#333;font-weight:500}

      .toc-page{padding:40px 50px;page-break-after:always}
      .toc-list{max-width:520px}
      .toc-item{display:flex;align-items:baseline;gap:8px;padding:9px 0;border-bottom:1px dotted #ccc;text-decoration:none;color:#333;font-size:14px}
      .toc-sub{padding-left:28px;font-size:13px;color:#666}
      .toc-num{font-weight:700;color:hsl(${pc});min-width:24px}
      .toc-indent{min-width:24px}
      .toc-label{flex:1}

      .page-footer{text-align:center;color:#999;font-size:9px;padding-top:16px;border-top:1px solid #e5e5e5;margin-top:40px;text-transform:uppercase;letter-spacing:2px}

      .contact-block{text-align:center;padding:60px 0}
      .contact-name{font-size:18px;font-weight:600;color:hsl(${pc});margin:12px 0}
      .contact-info{font-size:13px;color:#555}
      .contact-disclaimer{font-size:11px;color:#999}

      hr{border:none;border-top:1px solid #ddd;margin:16px 0}
      svg text{fill:#333}
      @media print{body{padding:0;max-width:100%}@page{margin:0.6in 0.75in;size:letter}.cover-page,.disclaimer-page,.content-page,.toc-page{min-height:auto;padding:20px 0}}
    </style></head><body>
    ${coverPage}
    ${disclaimerPage}
    ${execSummaryPage}
    ${tocPage}
    ${companyPage}
    ${transactionPage}
    ${financialPage}
    ${vizHtml}
    ${contactPage}
    </body></html>`;
}

function formatContent(content: string, pc: string): string {
  return content
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/^#### (.+)$/gm, `<h4 style="font-size:13px;font-weight:600;color:hsl(${pc});margin:12px 0 6px">$1</h4>`)
    .replace(/^### (.+)$/gm, `<h3 class="subsection-heading">$1</h3>`)
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, "<ul style='margin:8px 0 8px 20px;'>$1</ul>")
    .replace(/^---$/gm, "<hr/>")
    .replace(/\n{2,}/g, "</p><p style='margin:10px 0'>")
    .replace(/\n/g, "<br/>");
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function CIMDesigner() {
  const { dealId } = useParams<{ dealId: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [sections, setSections] = useState<SectionData[]>([]);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [generatingSection, setGeneratingSection] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [previewZoom, setPreviewZoom] = useState(75);

  const { data: deal, isLoading: dealLoading } = useQuery<Deal>({
    queryKey: ["/api/deals", dealId],
    enabled: !!dealId,
  });

  const { data: existingSections } = useQuery<CimSection[]>({
    queryKey: ["/api/deals", dealId, "sections"],
    enabled: !!dealId,
    queryFn: async () => {
      const res = await fetch(`/api/deals/${dealId}/sections`);
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: branding } = useQuery<BrandingSettings>({
    queryKey: ["/api/branding"],
  });

  useEffect(() => {
    if (existingSections && existingSections.length > 0) {
      setSections(existingSections.map(s => ({
        id: s.id,
        key: s.sectionKey,
        title: s.sectionTitle,
        content: s.finalContent || s.brokerEditedContent || s.aiDraftContent || "",
        isIncluded: true,
        order: s.order,
      })));
    } else if (deal) {
      const cimContentObj = deal.cimContent as Record<string, string> | null;
      const initialSections = CIM_SECTION_TEMPLATES.map((t, i) => ({
        key: t.key,
        title: t.title,
        content: cimContentObj?.[t.key] || "",
        isIncluded: true,
        order: i,
      }));
      setSections(initialSections);
    }
  }, [existingSections, deal]);

  useEffect(() => {
    if (sections.length > 0 && !activeSection) {
      const firstWithContent = sections.find(s => s.content);
      setActiveSection(firstWithContent?.key || sections[0].key);
    }
  }, [sections, activeSection]);

  const saveSectionsMutation = useMutation({
    mutationFn: async (sectionsToSave: SectionData[]) => {
      const cimContent: Record<string, string> = {};
      sectionsToSave.filter(s => s.isIncluded).forEach(s => { cimContent[s.key] = s.content; });
      return apiRequest("PATCH", `/api/deals/${dealId}`, { cimContent });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "Saved", description: "All content saved successfully." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save content.", variant: "destructive" });
    },
  });

  const generateSectionMutation = useMutation({
    mutationFn: async (sectionKey: string) => {
      const res = await apiRequest("POST", `/api/deals/${dealId}/generate-content`, { sectionKey });
      return res.json();
    },
    onSuccess: (data, sectionKey) => {
      if (data.content) {
        setSections(prev => prev.map(s => s.key === sectionKey ? { ...s, content: data.content } : s));
        toast({ title: "Generated", description: "Section content generated by AI." });
      }
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to generate content.", variant: "destructive" });
    },
  });

  const generateAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/deals/${dealId}/generate-content`, {});
      return res.json();
    },
    onSuccess: (data) => {
      if (data.cimContent) {
        setSections(prev => prev.map(s => ({ ...s, content: data.cimContent[s.key] || s.content })));
        toast({ title: "All sections generated", description: "Review and edit each section as needed." });
      }
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to generate content.", variant: "destructive" });
    },
  });

  const handleGenerateSection = async (sectionKey: string) => {
    setGeneratingSection(sectionKey);
    try { await generateSectionMutation.mutateAsync(sectionKey); }
    finally { setGeneratingSection(null); }
  };

  const updateSectionContent = (key: string, content: string) => {
    setSections(prev => prev.map(s => s.key === key ? { ...s, content } : s));
  };

  const toggleSectionIncluded = (key: string) => {
    setSections(prev => prev.map(s => s.key === key ? { ...s, isIncluded: !s.isIncluded } : s));
  };

  const moveSection = (key: string, direction: "up" | "down") => {
    setSections(prev => {
      const idx = prev.findIndex(s => s.key === key);
      if ((direction === "up" && idx === 0) || (direction === "down" && idx === prev.length - 1)) return prev;
      const newSections = [...prev];
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      [newSections[idx], newSections[swapIdx]] = [newSections[swapIdx], newSections[idx]];
      return newSections.map((s, i) => ({ ...s, order: i }));
    });
  };

  const generatePreview = () => {
    if (!deal) return;
    const vizTestIds = [
      { testId: "viz-revenue-chart", title: "Revenue & Financial Breakdown" },
      { testId: "viz-radar-chart", title: "Market Position Analysis" },
      { testId: "viz-strengths-infographic", title: "Business Strengths" },
      { testId: "viz-growth-flowchart", title: "Growth Opportunity Map" },
      { testId: "viz-operations-flow", title: "Operations Process Flow" },
    ];
    const capturedVizs: string[] = [];
    const exportContainer = document.querySelector(`[data-testid="viz-export-container"]`);
    const pc = branding?.primaryColor || "220 70% 50%";
    for (const viz of vizTestIds) {
      const svgEl = exportContainer?.querySelector(`[data-testid="${viz.testId}"]`) || document.querySelector(`[data-testid="${viz.testId}"]`);
      if (!svgEl) continue;
      const parentCard = svgEl.closest(`[data-testid^="card-viz-"]`);
      if (parentCard?.classList.contains("opacity-50")) continue;
      const clone = svgEl.cloneNode(true) as SVGElement;
      clone.setAttribute("width", "100%");
      clone.setAttribute("style", "max-width:420px;color:#333");
      clone.removeAttribute("class");
      capturedVizs.push(`<div style="margin-bottom:24px;page-break-inside:avoid;text-align:center"><h3 class="subsection-title" style="font-size:13px;color:hsl(${pc});margin-bottom:8px">${viz.title}</h3>${clone.outerHTML}</div>`);
    }
    const html = generateCBOHtml(deal, sections, branding, capturedVizs);
    setPreviewHtml(html);
  };

  const activeData = sections.find(s => s.key === activeSection);
  const filledCount = sections.filter(s => s.content.trim().length > 0).length;
  const totalCount = sections.length;

  const categorized = CIM_SECTION_TEMPLATES.reduce((acc, t) => {
    const cat = t.category;
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(t);
    return acc;
  }, {} as Record<string, typeof CIM_SECTION_TEMPLATES>);

  if (dealLoading) {
    return (
      <div className="p-6 max-w-7xl mx-auto space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }

  if (!deal) {
    return (
      <div className="p-8 max-w-7xl mx-auto text-center">
        <p className="text-muted-foreground mb-4">Deal not found</p>
        <Button variant="outline" onClick={() => setLocation("/deals")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Deals
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="px-6 pt-5 pb-4 border-b bg-background">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setLocation(`/deal/${dealId}`)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{deal.businessName}</h1>
              <p className="text-sm text-muted-foreground">CBO Designer · {filledCount}/{totalCount} sections completed</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-xs">
              {filledCount === totalCount ? "Ready to export" : `${totalCount - filledCount} sections empty`}
            </Badge>
            <Button
              variant="outline"
              onClick={() => generateAllMutation.mutate()}
              disabled={generateAllMutation.isPending}
              data-testid="button-generate-all"
            >
              {generateAllMutation.isPending
                ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                : <Wand2 className="h-4 w-4 mr-2" />}
              Generate All
            </Button>
            <Button
              onClick={() => saveSectionsMutation.mutate(sections)}
              disabled={saveSectionsMutation.isPending}
              data-testid="button-save-cim"
            >
              {saveSectionsMutation.isPending
                ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                : <Save className="h-4 w-4 mr-2" />}
              Save
            </Button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="content" className="flex-1 flex flex-col min-h-0">
        <div className="px-6 pt-4 border-b bg-background">
          <TabsList className="h-9">
            <TabsTrigger value="content" className="gap-1.5 text-xs">
              <FileText className="h-3.5 w-3.5" /> Edit Content
            </TabsTrigger>
            <TabsTrigger value="preview" className="gap-1.5 text-xs" data-testid="tab-preview" onClick={generatePreview}>
              <Eye className="h-3.5 w-3.5" /> Preview Document
            </TabsTrigger>
            <TabsTrigger value="design" className="gap-1.5 text-xs">
              <Palette className="h-3.5 w-3.5" /> Branding
            </TabsTrigger>
            <TabsTrigger value="visualizations" className="gap-1.5 text-xs" data-testid="tab-visualizations">
              <BarChart3 className="h-3.5 w-3.5" /> Visualizations
            </TabsTrigger>
            <TabsTrigger value="export" className="gap-1.5 text-xs">
              <Download className="h-3.5 w-3.5" /> Export
            </TabsTrigger>
          </TabsList>
        </div>

        {/* ── CONTENT TAB ── */}
        <TabsContent value="content" className="flex-1 overflow-hidden m-0 p-0">
          <div className="flex h-full">
            {/* Section list */}
            <div className="w-64 shrink-0 border-r flex flex-col">
              <div className="px-3 py-3 border-b">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Sections</p>
              </div>
              <ScrollArea className="flex-1">
                <div className="py-2">
                  {Object.entries(categorized).map(([cat, templates]) => (
                    <div key={cat} className="mb-1">
                      <p className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        {CATEGORY_LABELS[cat] || cat}
                      </p>
                      {templates.map(template => {
                        const section = sections.find(s => s.key === template.key);
                        const hasContent = (section?.content || "").trim().length > 0;
                        const isActive = activeSection === template.key;
                        return (
                          <button
                            key={template.key}
                            className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                              isActive
                                ? "bg-primary/10 text-foreground"
                                : "hover:bg-muted/50 text-foreground"
                            } ${!section?.isIncluded ? "opacity-40" : ""}`}
                            onClick={() => setActiveSection(template.key)}
                            data-testid={`section-item-${template.key}`}
                          >
                            {hasContent
                              ? <CheckCircle2 className={`h-3.5 w-3.5 shrink-0 ${isActive ? "text-primary" : "text-green-500 dark:text-green-400"}`} />
                              : <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                            }
                            <span className="text-sm leading-tight flex-1 min-w-0 truncate">
                              {template.title}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </ScrollArea>
              {/* Section actions */}
              {activeSection && (
                <div className="border-t p-2 flex flex-col gap-1">
                  <div className="flex items-center justify-between px-1">
                    <p className="text-xs text-muted-foreground">Include in CBO</p>
                    <Switch
                      checked={sections.find(s => s.key === activeSection)?.isIncluded ?? true}
                      onCheckedChange={() => toggleSectionIncluded(activeSection)}
                      data-testid={`switch-include-${activeSection}`}
                    />
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7 flex-1" onClick={() => moveSection(activeSection, "up")}>
                      <ChevronUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 flex-1" onClick={() => moveSection(activeSection, "down")}>
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Editor area */}
            <div className="flex-1 min-w-0 overflow-auto p-6">
              {activeData ? (
                <div className="max-w-3xl mx-auto space-y-4">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <h2 className="text-lg font-semibold">{activeData.title}</h2>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {CIM_SECTION_TEMPLATES.find(t => t.key === activeData.key)?.description}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleGenerateSection(activeData.key)}
                      disabled={generatingSection === activeData.key}
                      data-testid={`button-generate-${activeData.key}`}
                    >
                      {generatingSection === activeData.key
                        ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        : <Wand2 className="h-3.5 w-3.5 mr-1.5" />}
                      {activeData.content ? "Regenerate with AI" : "Generate with AI"}
                    </Button>
                  </div>

                  <RichTextEditor
                    value={activeData.content}
                    onChange={(v) => updateSectionContent(activeData.key, v)}
                    placeholder={`Write content for ${activeData.title}...\n\nTip: Use **bold**, _italic_, ### heading, and - bullet list formatting.`}
                    testId={`textarea-${activeData.key}`}
                  />
                </div>
              ) : (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <FileText className="h-12 w-12 mx-auto mb-3 text-muted-foreground/40" />
                    <p className="text-muted-foreground">Select a section from the left to start editing</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ── PREVIEW TAB ── */}
        <TabsContent value="preview" className="flex-1 overflow-hidden m-0 p-0 flex flex-col" data-testid="tab-content-preview">
          <div className="flex items-center gap-3 px-5 py-3 border-b bg-background">
            <p className="text-sm font-medium">Document Preview</p>
            <p className="text-xs text-muted-foreground flex-1">This is exactly how your exported CBO will look</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={() => setPreviewZoom(z => Math.max(40, z - 10))}>
                <ZoomOut className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs w-10 text-center">{previewZoom}%</span>
              <Button variant="outline" size="icon" onClick={() => setPreviewZoom(z => Math.min(120, z + 10))}>
                <ZoomIn className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="sm" onClick={generatePreview} data-testid="button-refresh-preview">
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
              </Button>
            </div>
          </div>
          <div className="flex-1 overflow-auto bg-muted/30 p-6">
            {previewHtml ? (
              <div
                className="mx-auto bg-white shadow-xl rounded-sm overflow-hidden"
                style={{
                  width: `${(850 * previewZoom) / 100}px`,
                  height: `${(1100 * previewZoom) / 100}px`,
                  minWidth: `${(850 * previewZoom) / 100}px`,
                }}
              >
                <iframe
                  srcDoc={previewHtml}
                  className="w-full h-full border-0"
                  title="CBO Preview"
                  data-testid="iframe-preview"
                  style={{ transform: `scale(${previewZoom / 100})`, transformOrigin: "top left", width: `${(850 * 100) / previewZoom}px`, height: `${(1100 * 100) / previewZoom}px` }}
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Monitor className="h-16 w-16 text-muted-foreground/30 mb-4" />
                <p className="text-muted-foreground font-medium">No preview yet</p>
                <p className="text-sm text-muted-foreground mt-1 mb-4">Click the Preview Document tab to render your CBO</p>
                <Button onClick={generatePreview} data-testid="button-generate-preview">
                  <Eye className="h-4 w-4 mr-2" /> Generate Preview
                </Button>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── BRANDING TAB ── */}
        <TabsContent value="design" className="p-6 overflow-auto">
          <div className="max-w-2xl mx-auto space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Document Branding</CardTitle>
                <CardDescription>Your CBO uses your saved brand settings from Settings</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {branding ? (
                  <div className="space-y-3">
                    {branding.companyName && (
                      <div className="flex items-center gap-3 p-3 rounded-md bg-muted/40">
                        <div className="h-8 w-8 rounded bg-primary/20 flex items-center justify-center">
                          <FileText className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Brokerage</p>
                          <p className="text-sm font-medium">{branding.companyName}</p>
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-3 p-3 rounded-md bg-muted/40">
                      <div className="h-8 w-8 rounded border" style={{ backgroundColor: `hsl(${branding.primaryColor})` }} />
                      <div>
                        <p className="text-xs text-muted-foreground">Primary Color</p>
                        <p className="text-sm font-medium">{branding.primaryColor}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-3 rounded-md bg-muted/40">
                      <div>
                        <p className="text-xs text-muted-foreground">Fonts</p>
                        <p className="text-sm font-medium">{branding.headingFont} / {branding.bodyFont}</p>
                      </div>
                    </div>
                    {branding.logoUrl && (
                      <div className="p-3 rounded-md bg-muted/40">
                        <p className="text-xs text-muted-foreground mb-2">Logo</p>
                        <img src={branding.logoUrl} alt="Logo" className="max-h-12 object-contain" />
                      </div>
                    )}
                    {branding.disclaimer && (
                      <div className="flex items-center gap-2 text-sm text-green-500">
                        <CheckCircle2 className="h-4 w-4" />
                        Confidentiality disclaimer configured
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No branding configured.</p>
                )}
                <Button variant="outline" className="w-full" onClick={() => setLocation("/settings")} data-testid="button-edit-branding">
                  <Palette className="h-4 w-4 mr-2" /> Edit Brand Settings
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── VISUALIZATIONS TAB ── */}
        <TabsContent value="visualizations" className="p-6 overflow-auto">
          <DataVisualizationsPanel deal={deal} branding={branding} />
        </TabsContent>

        {/* Off-screen viz container for export */}
        <div style={{ position: "absolute", left: "-9999px", width: "800px" }} aria-hidden="true" data-testid="viz-export-container">
          <DataVisualizationsPanel deal={deal} branding={branding} />
        </div>

        {/* ── EXPORT TAB ── */}
        <TabsContent value="export" className="p-6 overflow-auto">
          <div className="max-w-2xl mx-auto space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Export CBO Document</CardTitle>
                <CardDescription>Download your Confidential Business Overview as an HTML file — open it in any browser and print to PDF</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3 p-3 rounded-md bg-muted/40">
                  <CheckCircle2 className={`h-5 w-5 ${filledCount === totalCount ? "text-green-500" : "text-muted-foreground"}`} />
                  <div>
                    <p className="text-sm font-medium">{filledCount}/{totalCount} sections filled</p>
                    <p className="text-xs text-muted-foreground">
                      {filledCount < totalCount ? `${totalCount - filledCount} sections are still empty` : "All sections have content"}
                    </p>
                  </div>
                </div>

                <Button
                  className="w-full"
                  data-testid="button-export-pdf"
                  onClick={() => {
                    if (!deal) return;
                    const hasContent = sections.some(s => s.content.trim().length > 0);
                    if (!hasContent) { toast({ title: "No Content", description: "Generate or write content before exporting.", variant: "destructive" }); return; }

                    const vizTestIds = [
                      { testId: "viz-revenue-chart", title: "Revenue & Financial Breakdown" },
                      { testId: "viz-radar-chart", title: "Market Position Analysis" },
                      { testId: "viz-strengths-infographic", title: "Business Strengths" },
                      { testId: "viz-growth-flowchart", title: "Growth Opportunity Map" },
                      { testId: "viz-operations-flow", title: "Operations Process Flow" },
                    ];
                    const capturedVizs: string[] = [];
                    const exportContainer = document.querySelector(`[data-testid="viz-export-container"]`);
                    const pc = branding?.primaryColor || "220 70% 50%";
                    for (const viz of vizTestIds) {
                      const svgEl = exportContainer?.querySelector(`[data-testid="${viz.testId}"]`) || document.querySelector(`[data-testid="${viz.testId}"]`);
                      if (!svgEl) continue;
                      const parentCard = svgEl.closest(`[data-testid^="card-viz-"]`);
                      if (parentCard?.classList.contains("opacity-50")) continue;
                      const clone = svgEl.cloneNode(true) as SVGElement;
                      clone.setAttribute("width", "100%");
                      clone.setAttribute("style", "max-width:420px;color:#333");
                      clone.removeAttribute("class");
                      capturedVizs.push(`<div style="margin-bottom:24px;page-break-inside:avoid;text-align:center"><h3 style="font-size:13px;color:hsl(${pc});margin-bottom:8px">${viz.title}</h3>${clone.outerHTML}</div>`);
                    }

                    const html = generateCBOHtml(deal, sections, branding, capturedVizs);
                    const blob = new Blob([html], { type: "text/html" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${deal.businessName.replace(/[^a-zA-Z0-9]/g, "_")}_CBO.html`;
                    a.click();
                    URL.revokeObjectURL(url);
                    toast({ title: "CBO Exported", description: "Open the HTML file in a browser, then print/save as PDF." });
                  }}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download as HTML (Print to PDF)
                </Button>

                <Separator />

                <div className="space-y-2">
                  <p className="text-sm font-medium">How to create a PDF</p>
                  <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                    <li>Click the download button above</li>
                    <li>Open the downloaded .html file in Chrome or Safari</li>
                    <li>Press <kbd className="px-1 py-0.5 bg-muted rounded text-xs">Ctrl+P</kbd> (or <kbd className="px-1 py-0.5 bg-muted rounded text-xs">Cmd+P</kbd> on Mac)</li>
                    <li>Select "Save as PDF" as the printer</li>
                    <li>Click Save</li>
                  </ol>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Share with Buyers</CardTitle>
                <CardDescription>Generate a secure, watermarked viewing link</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" className="w-full" data-testid="button-export-web" onClick={() => {
                  setLocation(`/deal/${dealId}`);
                  toast({ title: "Go to Buyers Tab", description: "Use the Buyers tab to generate secure viewing links." });
                }}>
                  <Share2 className="h-4 w-4 mr-2" /> Manage Buyer Access
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
