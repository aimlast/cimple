/**
 * TemplateGallery — the brokerage's CIM templates: the five built-ins and
 * their own, each previewed with the real renderers (and their brand),
 * with set-default, copy & edit, delete and "Match my existing CIM".
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, FileSearch, ListOrdered, Loader2, MoreHorizontal, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { CimBrokerageBrand } from "@shared/cim-theme";
import { buildCimDesign } from "@/components/cim/CimDesignContext";
import { builderRequest, errorText } from "@/components/cim-builder/api";
import { templatesKey, useTemplates, type TemplateView } from "./api";
import { TemplateThumbnail } from "./CimPreview";
import { TemplateEditor } from "./TemplateEditor";
import { MatchCimDialog } from "./MatchCimDialog";

export function TemplateGallery() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const templates = useTemplates();
  // Templates are previewed wearing the saved brokerage brand.
  const brokerage: Partial<CimBrokerageBrand> | null = templates.data?.brokerage ?? null;
  const [editing, setEditing] = useState<TemplateView | null>(null);
  const [toDelete, setToDelete] = useState<TemplateView | null>(null);
  const [matchOpen, setMatchOpen] = useState(false);

  const list = templates.data?.templates ?? [];
  const defaultId = templates.data?.defaultTemplateId ?? "classic-paper";
  const refresh = () => qc.invalidateQueries({ queryKey: templatesKey });

  const setDefault = useMutation({
    mutationFn: (id: string) => builderRequest("POST", `/api/cim-templates/${id}/default`),
    onSuccess: (_r, id) => {
      refresh();
      qc.invalidateQueries({ queryKey: ["/api/deals"] });
      toast({ title: "Default template set", description: `New CIMs — and deals that follow your default — use ${list.find((t) => t.id === id)?.name ?? "it"}.` });
    },
    onError: (e) => toast({ title: "Couldn't set the default", description: errorText(e), variant: "destructive" }),
  });
  const clone = useMutation({
    mutationFn: (t: TemplateView) => builderRequest<TemplateView>("POST", `/api/cim-templates/${t.id}/clone`, { name: `${t.name} — my version` }),
    onSuccess: (t) => {
      refresh();
      setEditing(t);
    },
    onError: (e) => toast({ title: "Couldn't copy the template", description: errorText(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => builderRequest("DELETE", `/api/cim-templates/${id}`),
    onSuccess: () => {
      refresh();
      qc.invalidateQueries({ queryKey: ["/api/deals"] });
      toast({ title: "Template deleted", description: "Deals that used it now use your default." });
    },
    onError: (e) => toast({ title: "Couldn't delete the template", description: errorText(e), variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between space-y-0">
        <div>
          <CardTitle className="text-base">CIM templates</CardTitle>
          <CardDescription className="mt-1">
            Pick a default for every new CIM, or make your own. Each deal can use a different one (CIM builder → Design).
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setMatchOpen(true)} data-testid="button-open-match-cim">
            <FileSearch className="h-3.5 w-3.5" /> Match my existing CIM
          </Button>
          <Button
            size="sm"
            className="gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90"
            onClick={() => { const base = list.find((t) => t.id === defaultId) ?? list[0]; if (base) clone.mutate(base); }}
            disabled={clone.isPending || list.length === 0}
            data-testid="button-new-template"
          >
            {clone.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} New template
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {templates.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-72 rounded-xl" />)}</div>
        ) : templates.isError ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm">
            Couldn't load your templates. <button className="underline" onClick={() => templates.refetch()}>Try again</button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="template-gallery">
            {list.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                brokerage={brokerage}
                isDefault={t.id === defaultId}
                busy={setDefault.isPending && setDefault.variables === t.id}
                onSetDefault={() => setDefault.mutate(t.id)}
                onEdit={() => (t.builtIn ? clone.mutate(t) : setEditing(t))}
                onCopy={() => clone.mutate(t)}
                onDelete={() => setToDelete(t)}
              />
            ))}
          </div>
        )}
      </CardContent>

      <TemplateEditor template={editing} brokerage={brokerage} open={!!editing} onOpenChange={(o) => !o && setEditing(null)} />
      <MatchCimDialog
        open={matchOpen}
        onOpenChange={setMatchOpen}
        templates={list}
        defaultTemplateId={defaultId}
        onCreated={(t, action) => {
          if (action === "edit") setEditing(t);
          if (action === "default") setDefault.mutate(t.id);
        }}
      />
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{toDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Deals using it switch to your default template{toDelete?.id === defaultId ? " (Classic Paper, since this is your default)" : ""}. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (toDelete) remove.mutate(toDelete.id); setToDelete(null); }}
            >
              Delete template
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function TemplateCard({
  template, brokerage, isDefault, busy, onSetDefault, onEdit, onCopy, onDelete,
}: {
  template: TemplateView;
  brokerage: Partial<CimBrokerageBrand> | null;
  isDefault: boolean;
  busy: boolean;
  onSetDefault: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const design = useMemo(
    () => buildCimDesign({ template: { id: template.id, name: template.name, tokens: template.tokens }, brokerage }, "normal"),
    [template, brokerage],
  );
  return (
    <div
      className={cn("group rounded-xl border bg-card overflow-hidden flex flex-col", isDefault ? "border-teal/60 ring-1 ring-teal/30" : "border-border")}
      data-testid={`template-card-${template.id}`}
    >
      <div className="bg-muted/40 p-3">
        <TemplateThumbnail design={design} />
      </div>
      <div className="flex-1 flex flex-col p-3.5 gap-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate">{template.name}</p>
            <div className="flex flex-wrap gap-1 mt-1">
              {isDefault && <Badge className="text-[10px] h-4 px-1.5 bg-teal/15 text-teal border-teal/30 hover:bg-teal/15"><Star className="h-2.5 w-2.5 mr-0.5" /> Default</Badge>}
              {!template.builtIn && <Badge variant="outline" className="text-[10px] h-4 px-1.5">Yours</Badge>}
              {template.sectionOutline && (
                <Badge variant="outline" className="text-[10px] h-4 px-1.5"><ListOrdered className="h-2.5 w-2.5 mr-0.5" /> {template.sectionOutline.sections.length} sections</Badge>
              )}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={`More for ${template.name}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!template.builtIn && <DropdownMenuItem onClick={onEdit}><Pencil className="h-3.5 w-3.5 mr-2" /> Edit</DropdownMenuItem>}
              <DropdownMenuItem onClick={onCopy}><Copy className="h-3.5 w-3.5 mr-2" /> Make a copy</DropdownMenuItem>
              {!template.builtIn && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive"><Trash2 className="h-3.5 w-3.5 mr-2" /> Delete</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {template.description && <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{template.description}</p>}
        <div className="mt-auto flex gap-2 pt-1">
          {isDefault ? (
            <span className="flex-1 inline-flex items-center justify-center gap-1 text-xs text-teal h-8"><Check className="h-3.5 w-3.5" /> Your default</span>
          ) : (
            <Button size="sm" variant="outline" className="flex-1 h-8 text-xs" onClick={onSetDefault} disabled={busy} data-testid={`button-default-${template.id}`}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Use as default"}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-8 text-xs gap-1" onClick={onEdit} data-testid={`button-edit-${template.id}`}>
            <Pencil className="h-3.5 w-3.5" /> {template.builtIn ? "Customise" : "Edit"}
          </Button>
        </div>
      </div>
    </div>
  );
}
