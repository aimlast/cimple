/**
 * TeaserBrandCard — Settings → Brand & templates → "Teaser": the brokerage's
 * own teaser wording (the confidentiality line and the next-step lines that
 * every new teaser's fixed blocks use), the default template for new
 * teasers, and the broker's saved teaser templates (rename, make default,
 * delete). GET|PATCH /api/broker/teaser-settings, /api/broker/teaser-templates.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Megaphone, Pencil, Star, Trash2, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { DEFAULT_TEASER_WORDING } from "@shared/teaser-templates";
import { teaserBrokerSettingsKey, teaserRequest, teaserTemplatesKey, type SavedTemplateItem } from "./api";
import { TEASER_TEMPLATES, TEASER_TEMPLATE_KEYS_ORDER } from "./template-order";

interface BrokerTeaserSettings { defaultTemplate: string | null; confidentiality: string | null; nextStep: string | null }

const DEFAULT_NEXT_STEP = DEFAULT_TEASER_WORDING.nextStep.join("\n");

export function TeaserBrandCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const settings = useQuery<BrokerTeaserSettings>({ queryKey: teaserBrokerSettingsKey, queryFn: () => teaserRequest("GET", "/api/broker/teaser-settings") });
  const templates = useQuery<{ templates: SavedTemplateItem[]; defaultTemplate: string | null }>({ queryKey: teaserTemplatesKey, queryFn: () => teaserRequest("GET", "/api/broker/teaser-templates") });
  const [conf, setConf] = useState("");
  const [next, setNext] = useState("");
  useEffect(() => {
    if (!settings.data) return;
    setConf(settings.data.confidentiality ?? "");
    setNext(settings.data.nextStep ?? "");
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (patch: Partial<BrokerTeaserSettings>) => teaserRequest<BrokerTeaserSettings>("PATCH", "/api/broker/teaser-settings", patch),
    onSuccess: (r) => {
      qc.setQueryData(teaserBrokerSettingsKey, r);
      qc.invalidateQueries({ queryKey: teaserTemplatesKey });
      toast({ title: "Teaser settings saved", description: "New teasers use them. A teaser you've already written keeps its wording until you reset those blocks." });
    },
    onError: (e) => toast({ title: "Couldn't save", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  const dirty = !!settings.data && (conf !== (settings.data.confidentiality ?? "") || next !== (settings.data.nextStep ?? ""));
  const defaultKey = templates.data?.defaultTemplate ?? settings.data?.defaultTemplate ?? "one_page";

  return (
    <Card data-testid="teaser-brand-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Megaphone className="h-5 w-5" /> Teaser</CardTitle>
        <CardDescription>The wording and starting template for the short anonymous summary you send before the NDA.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {settings.isLoading ? (
          <Skeleton className="h-40" />
        ) : settings.error ? (
          <p className="text-sm text-destructive">Couldn't load the teaser settings. <button className="underline" onClick={() => settings.refetch()}>Try again</button></p>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label className="text-sm">Default template for new teasers</Label>
              <Select value={defaultKey} onValueChange={(v) => save.mutate({ defaultTemplate: v })} disabled={save.isPending}>
                <SelectTrigger className="max-w-sm" data-testid="select-default-teaser-template"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(templates.data?.templates ?? []).map((t) => <SelectItem key={t.key} value={t.key}>{t.name}</SelectItem>)}
                  {TEASER_TEMPLATE_KEYS_ORDER.map((k) => <SelectItem key={k} value={k}>{TEASER_TEMPLATES[k].name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Confidentiality line</Label>
              <Textarea value={conf} onChange={(e) => setConf(e.target.value.slice(0, 400))} rows={3} placeholder={DEFAULT_TEASER_WORDING.confidentiality} data-testid="input-teaser-confidentiality" />
              <p className="text-xs text-muted-foreground">Leave it empty for Cimple's wording. “{"{firm}"}” becomes your firm's name.</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Next steps (one per line)</Label>
              <Textarea value={next} onChange={(e) => setNext(e.target.value.slice(0, 400))} rows={3} placeholder={DEFAULT_NEXT_STEP} data-testid="input-teaser-next-step" />
              <p className="text-xs text-muted-foreground">What a buyer does to ask for the CIM. Leave it empty for Cimple's wording.</p>
            </div>
            <div className="flex gap-2">
              <Button disabled={!dirty || save.isPending} onClick={() => save.mutate({ confidentiality: conf.trim() || null, nextStep: next.trim() || null })} data-testid="button-save-teaser-wording">
                {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Save wording
              </Button>
              {dirty && <Button variant="ghost" onClick={() => { setConf(settings.data?.confidentiality ?? ""); setNext(settings.data?.nextStep ?? ""); }}>Cancel</Button>}
            </div>
          </>
        )}

        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-sm font-medium">Your teaser templates</p>
          {templates.isLoading ? (
            <Skeleton className="h-16" />
          ) : (templates.data?.templates.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">None yet. In a teaser's editor, “Save as my teaser template” keeps your blocks, their order and your wording — never the deal's information.</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {templates.data!.templates.map((t) => <SavedRow key={t.id} t={t} isDefault={defaultKey === t.key} />)}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SavedRow({ t, isDefault }: { t: SavedTemplateItem; isDefault: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(t.name);
  const [confirm, setConfirm] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: teaserTemplatesKey });
    qc.invalidateQueries({ queryKey: teaserBrokerSettingsKey });
  };
  const patch = useMutation({
    mutationFn: (body: { name?: string; makeDefault?: boolean }) => teaserRequest("PATCH", `/api/broker/teaser-templates/${t.id}`, body),
    onSuccess: () => { setEditing(false); refresh(); },
    onError: (e) => toast({ title: "Couldn't save the template", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: () => teaserRequest("DELETE", `/api/broker/teaser-templates/${t.id}`),
    onSuccess: () => { setConfirm(false); refresh(); toast({ title: `Deleted “${t.name}”` }); },
    onError: (e) => toast({ title: "Couldn't delete the template", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
      {editing ? (
        <>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="h-8 max-w-xs" autoFocus />
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => name.trim() && patch.mutate({ name: name.trim() })} aria-label="Save the name"><Check className="h-4 w-4" /></Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => { setName(t.name); setEditing(false); }} aria-label="Cancel"><X className="h-4 w-4" /></Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
          {isDefault ? (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"><Star className="h-3 w-3" /> Default</span>
          ) : (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => patch.mutate({ makeDefault: true })} disabled={patch.isPending}>Set as my default</Button>
          )}
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditing(true)} aria-label={`Rename ${t.name}`}><Pencil className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-8 w-8 text-red-500 hover:text-red-500" onClick={() => setConfirm(true)} aria-label={`Delete ${t.name}`}><Trash2 className="h-3.5 w-3.5" /></Button>
        </>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{t.name}”?</AlertDialogTitle>
            <AlertDialogDescription>Teasers already written with it aren't changed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => del.mutate()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
