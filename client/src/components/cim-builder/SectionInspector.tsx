/**
 * SectionInspector — the builder's right-hand editor for one section:
 * title, layout, content, the AI writer, who can see it, and actions
 * (approve, regenerate, undo, delete).
 */
import { useEffect, useState } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronDown, Eye, EyeOff, Lightbulb, Loader2, Lock, RefreshCw,
  Sparkles, Trash2, Undo2, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StructuredDataEditor } from "@/components/cim/StructuredDataEditor";
import { getEditableText, isStructuredLayout, isTextEditableLayout } from "@/components/cim/editableText";
import { getCimLayout, layoutLabel } from "@shared/cim-layouts";
import { cn } from "@/lib/utils";
import { AiWriterPanel } from "./AiWriterPanel";
import { LayoutIcon } from "./LayoutGallery";
import { TASK_LABEL, taskRunning, type BuilderSection } from "./api";
import type { CimBuilderApi } from "./useCimBuilder";

interface Props {
  section: BuilderSection;
  api: CimBuilderApi;
  aiBlockedReason: string | null;
  onChangeLayout: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
}

export function SectionInspector({ section, api, aiBlockedReason, onChangeLayout, onRegenerate, onDelete }: Props) {
  const running = taskRunning(section);
  const task = section.aiTask;
  const failedWrite = task?.kind === "write" && task.status === "failed";
  const failedOther = task && task.kind !== "rewrite" && task.kind !== "write" && task.status === "failed";
  const layout = getCimLayout(section.layoutType);
  const textEditable = isTextEditableLayout(section.layoutType);
  const dataEditable = isStructuredLayout(section.layoutType);

  // ── Title ──
  const [title, setTitle] = useState(section.sectionTitle);
  useEffect(() => setTitle(section.sectionTitle), [section.id, section.sectionTitle]);
  const saveTitle = () => {
    const t = title.replace(/\s+/g, " ").trim();
    if (!t) return setTitle(section.sectionTitle);
    if (t !== section.sectionTitle) api.patch.mutate({ id: section.id, sectionTitle: t });
  };

  // ── Content drafts (seeded from the section until the broker types) ──
  const [text, setText] = useState(() => getEditableText(section as any));
  const [data, setData] = useState<Record<string, any>>(() => (section.layoutData as any) ?? {});
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setText(getEditableText(section as any));
    setData(((section.layoutData as any) ?? {}) as Record<string, any>);
    setDirty(false);
    // Re-seed when the section changes underneath (switch, AI finished, undo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.id, section.updatedAt, section.layoutType]);

  const saveContent = () => {
    api.patch.mutate(
      textEditable ? { id: section.id, brokerEditedContent: text } : { id: section.id, layoutData: data },
      { onSuccess: () => setDirty(false) },
    );
  };

  return (
    <div className="p-4 space-y-5">
      {/* Title */}
      <div className="space-y-1.5">
        <label htmlFor="inspector-title" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Title</label>
        <Input
          id="inspector-title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setTitle(section.sectionTitle); }}
          className="h-9 text-sm font-medium"
          data-testid="input-section-title"
        />
      </div>

      {/* Background work banners */}
      {running && task && (
        <div className="flex items-start gap-2 rounded-lg border border-teal/30 bg-teal/5 p-3 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-teal mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">{TASK_LABEL[task.kind]}…</p>
            <p className="text-muted-foreground mt-0.5">This takes about 30 seconds and keeps going if you leave this page.</p>
          </div>
        </div>
      )}
      {failedWrite && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs space-y-2">
          <p className="flex items-start gap-1.5 font-medium text-red-400"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> The AI couldn't write this section</p>
          <p className="text-muted-foreground">{task?.error} Buyers don't see it until you decide.</p>
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs flex-1" onClick={onRegenerate} disabled={!!aiBlockedReason}>Try again</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs flex-1" onClick={() => api.discardTask.mutate(section.id)}>Keep it blank</Button>
          </div>
        </div>
      )}
      {failedOther && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-red-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium text-red-400">{TASK_LABEL[task!.kind]} didn't finish</p>
            <p className="text-muted-foreground mt-0.5">{task!.error} Nothing was changed.</p>
          </div>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => api.discardTask.mutate(section.id)}>Dismiss</button>
        </div>
      )}

      {/* Layout */}
      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Layout</p>
        <div className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2">
          <LayoutIcon layoutType={section.layoutType} className="h-4 w-4 text-teal shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{layoutLabel(section.layoutType)}</p>
            {layout && <p className="text-[11px] text-muted-foreground leading-snug line-clamp-2">{layout.description}</p>}
          </div>
          <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={onChangeLayout} disabled={running} data-testid="button-change-layout">
            Change
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Content</p>
          {dirty && <span className="text-[10px] text-amber-500">Unsaved changes</span>}
        </div>
        {textEditable ? (
          <Textarea
            value={text}
            disabled={running}
            onChange={(e) => { setText(e.target.value); setDirty(true); }}
            className="text-xs min-h-[200px] resize-y leading-relaxed"
            placeholder="Write this section. Leave a blank line between paragraphs."
            data-testid="input-section-text"
          />
        ) : dataEditable ? (
          <div className={cn("rounded-lg border border-border p-2.5 max-h-[420px] overflow-y-auto", running && "pointer-events-none opacity-60")}>
            <StructuredDataEditor value={data} onChange={(v) => { setData(v); setDirty(true); }} compact />
          </div>
        ) : null}
        {dirty && (
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs flex-1 bg-teal text-teal-foreground hover:bg-teal/90" onClick={saveContent} disabled={api.patch.isPending} data-testid="button-save-content">
              {api.patch.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null} Save
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => { setText(getEditableText(section as any)); setData(((section.layoutData as any) ?? {})); setDirty(false); }}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>

      {/* AI writer */}
      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-teal" />
          <p className="text-xs font-semibold">AI writer</p>
        </div>
        <AiWriterPanel
          section={section}
          aiBlockedReason={aiBlockedReason}
          starting={api.rewrite.isPending}
          applying={api.applyRewrite.isPending}
          onRewrite={(req) => api.rewrite.mutate({ id: section.id, ...req })}
          onApply={() => api.applyRewrite.mutate(section.id)}
          onDiscard={() => api.discardTask.mutate(section.id)}
        />
      </div>

      {/* Who can see it */}
      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Who can see it</p>
        <div className="grid grid-cols-2 gap-1.5 rounded-md border border-border p-0.5 bg-muted/30">
          {(["teaser", "full"] as const).map((tier) => (
            <button
              key={tier}
              type="button"
              aria-pressed={section.accessTier === tier}
              onClick={() => section.accessTier !== tier && api.patch.mutate({ id: section.id, accessTier: tier })}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[11px] transition-colors",
                section.accessTier === tier ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
              data-testid={`tier-${tier}`}
            >
              {tier === "teaser" ? <Users className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              {tier === "teaser" ? "Every buyer" : "Full access only"}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug">
          {section.accessTier === "full"
            ? "Teaser buyers see this section's title with a lock. Buyers with Full access or higher see it all."
            : "Every buyer with access sees this section (blind buyers see the redacted version)."}
        </p>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 cursor-pointer">
          <span className="flex items-center gap-2 text-xs">
            {section.isVisible === false ? <EyeOff className="h-3.5 w-3.5 text-muted-foreground" /> : <Eye className="h-3.5 w-3.5 text-teal" />}
            {section.isVisible === false ? "Hidden from buyers" : "Shown to buyers"}
          </span>
          <Switch
            checked={section.isVisible !== false}
            onCheckedChange={(v) => api.patch.mutate({ id: section.id, isVisible: v })}
            aria-label="Show to buyers"
          />
        </label>
      </div>

      {/* Actions */}
      <div className="space-y-2">
        <Button
          size="sm"
          variant={section.brokerApproved ? "outline" : "default"}
          className={cn("w-full h-8 text-xs gap-1.5", !section.brokerApproved && "bg-teal text-teal-foreground hover:bg-teal/90")}
          onClick={() => api.patch.mutate({ id: section.id, brokerApproved: !section.brokerApproved })}
          data-testid="button-approve-section"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {section.brokerApproved ? "Approved — undo approval" : "Approve section"}
        </Button>
        {section.layoutType !== "divider" && (
          <Button
            size="sm"
            variant="outline"
            className="w-full h-8 text-xs gap-1.5"
            onClick={onRegenerate}
            disabled={running || !!aiBlockedReason}
            title={aiBlockedReason ?? "Rebuild this section from the deal's information. The current version is kept for undo."}
            data-testid="button-regenerate-section"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Regenerate from the deal's information
          </Button>
        )}
        {section.historyCount > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="w-full h-8 text-xs gap-1.5"
            onClick={() => api.undo.mutate(section.id)}
            disabled={running || api.undo.isPending}
            data-testid="button-undo-section"
          >
            <Undo2 className="h-3.5 w-3.5" />
            Undo {section.lastChange ? `“${section.lastChange.reason.toLowerCase()}”` : "last change"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="w-full h-8 text-xs gap-1.5 text-red-500 hover:text-red-500 hover:bg-red-500/10"
          onClick={onDelete}
          disabled={running}
          data-testid="button-delete-section"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete section
        </Button>
      </div>

      {section.aiLayoutReasoning && (
        <Collapsible>
          <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
            <Lightbulb className="h-3 w-3 text-amber-400" /> Why the AI chose this layout
            <ChevronDown className="h-3 w-3 ml-auto transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed bg-muted/40 rounded p-2">
              {section.aiLayoutReasoning}
              <span className="block mt-1 text-muted-foreground/70">Broker-only note — never shown to buyers.</span>
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
