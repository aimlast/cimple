/**
 * AddSourceDialog — add any source of information to a deal: a file or
 * pasted text, saying what it is (document, email, call transcript,
 * video-call transcript, CRM note, website / social post), when it's from and
 * who may see it. Cimple reads it with a prompt that knows the kind of source
 * (who said what) and records every fact with that source.
 *
 * Used by the Information tab ("Add source") and the Overview tab's
 * "Ongoing inputs" card.
 */
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { Loader2, Lock, Upload, ClipboardPaste } from "lucide-react";
import { ADDABLE_KINDS, KIND_META } from "./source-kinds";

const DOC_CATEGORIES = [
  { value: "financials", label: "Financials" },
  { value: "legal", label: "Legal" },
  { value: "marketing", label: "Marketing" },
  { value: "operations", label: "Operations" },
  { value: "transcripts", label: "Call transcripts" },
  { value: "other", label: "Other" },
];

type Kind = "document" | "email" | "call" | "video_call" | "crm" | "website" | "social";

export interface AddSourcePreset {
  kind?: Kind;
  tab?: "file" | "paste";
  category?: string;
  nonce?: number;
}

function defaultCategory(kind: Kind, chosen: string): string {
  if (kind === "document") return chosen;
  if (kind === "call" || kind === "video_call") return "transcripts";
  if (kind === "website" || kind === "social") return "marketing";
  return "other";
}

interface Props {
  dealId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: AddSourcePreset | null;
  onAdded?: () => void;
}

export function AddSourceDialog({ dealId, open, onOpenChange, preset, onAdded }: Props) {
  const { toast } = useToast();
  const [kind, setKind] = useState<Kind>("document");
  const [tab, setTab] = useState<"file" | "paste">("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("financials");
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [brokerOnly, setBrokerOnly] = useState(false);

  // Reset to the preset each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const k = preset?.kind ?? "document";
    setKind(k);
    setTab(preset?.tab ?? (k === "document" ? "file" : "paste"));
    setCategory(preset?.category ?? "financials");
    setBrokerOnly(k === "crm");
    setFile(null);
    setText("");
    setTitle("");
    setMeta({});
  }, [open, preset?.nonce, preset?.kind, preset?.tab, preset?.category]);

  const pickKind = (k: Kind) => {
    setKind(k);
    setBrokerOnly(k === "crm");
    if (k !== "document" && tab === "file" && !file) setTab("paste");
  };
  const setMetaField = (key: string, value: string) => setMeta((m) => ({ ...m, [key]: value }));

  const cleanMeta = () => {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(meta)) if (v && v.trim()) out[k] = k === "durationMin" ? Number(v) : v.trim();
    return out;
  };

  const add = useMutation({
    mutationFn: async () => {
      const visibility = brokerOnly ? "broker_only" : "shared";
      if (tab === "file") {
        if (!file) throw new Error("Choose a file first");
        const form = new FormData();
        form.append("file", file);
        form.append("category", defaultCategory(kind, category));
        if (title.trim()) form.append("title", title.trim());
        form.append("sourceKind", kind);
        form.append("sourceMeta", JSON.stringify(cleanMeta()));
        form.append("visibility", visibility);
        const r = await fetch(`/api/deals/${dealId}/documents/upload`, { method: "POST", body: form, credentials: "include" });
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error((body && body.error) || (r.status === 401 ? "Your session has expired — please sign in again." : `Upload failed (${r.status})`));
        return body;
      }
      if (text.trim().length < 20) throw new Error("Paste the text of the source (at least a sentence)");
      const r = await fetch(`/api/deals/${dealId}/information/sources`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          title: title.trim(),
          text,
          meta: cleanMeta(),
          visibility,
          category: kind === "document" ? category : undefined,
        }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error((body && body.error) || `Couldn't add the source (${r.status})`);
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "information"] });
      toast({ title: "Source added", description: "Cimple is reading it now — its facts appear in a moment." });
      onOpenChange(false);
      onAdded?.();
    },
    onError: (err: Error) => toast({ title: "Couldn't add the source", description: err.message, variant: "destructive" }),
  });

  const isWebKind = kind === "website" || kind === "social";
  const ready = tab === "file" ? !!file : text.trim().length >= 20;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[92vh] overflow-y-auto focus:outline-none" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Add a source</DialogTitle>
          <DialogDescription>
            Cimple reads it, pulls out the facts about the business, and records where each one came from.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* What is it */}
          <div className="space-y-1.5">
            <Label className="text-xs">What is it?</Label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5" role="radiogroup" aria-label="Source kind">
              {ADDABLE_KINDS.map((k) => {
                const active = k.kind === kind || (k.kind === "website" && kind === "social");
                const Icon = KIND_META[k.kind].icon;
                return (
                  <button
                    key={k.kind}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => pickKind(k.kind)}
                    className={`text-left rounded-md border px-2.5 py-2 transition-colors ${
                      active ? "border-teal/60 bg-teal/10" : "border-border hover:border-teal/30 hover:bg-muted/40"
                    }`}
                    data-testid={`source-kind-${k.kind}`}
                  >
                    <span className="flex items-center gap-1.5 text-xs font-medium">
                      <Icon className={`h-3.5 w-3.5 ${active ? "text-teal" : "text-muted-foreground"}`} />
                      {k.label}
                    </span>
                    <span className="block text-[10px] text-muted-foreground mt-0.5 leading-tight">{k.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* File or paste */}
          <div className="flex gap-1 rounded-md bg-muted p-0.5 w-fit">
            {(["file", "paste"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  tab === t ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "file" ? <Upload className="h-3 w-3" /> : <ClipboardPaste className="h-3 w-3" />}
                {t === "file" ? "Upload file" : "Paste text"}
              </button>
            ))}
          </div>

          {tab === "file" ? (
            <div className="space-y-1.5">
              <Label className="text-xs">File</Label>
              <Input
                type="file"
                accept=".pdf,.xlsx,.xls,.docx,.doc,.pptx,.ppt,.txt,.csv,.md"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="h-9"
              />
              <p className="text-[10px] text-muted-foreground">PDF, Excel, Word, PowerPoint or text · up to 20 MB</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-xs">Text</Label>
              <Textarea
                placeholder={
                  kind === "email" ? "Paste the email or the whole thread, including who it's from."
                  : kind === "call" || kind === "video_call" ? "Paste the transcript — speaker names help Cimple tell the seller's answers from your questions."
                  : kind === "crm" ? "Paste the CRM note or activity."
                  : isWebKind ? "Paste the page or post text."
                  : "Paste any text about the business."
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="min-h-[9rem] text-sm"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Title <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              placeholder={
                kind === "email" ? "e.g. Re: 2024 numbers" : kind === "call" ? "e.g. Discovery call" : kind === "video_call" ? "e.g. Zoom walkthrough" : kind === "crm" ? "e.g. Pipedrive notes" : "e.g. 2024 Compilation"
              }
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-9"
            />
          </div>

          {/* Details per kind */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {kind === "document" && (
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DOC_CATEGORIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {kind === "email" && (
              <>
                <MetaInput label="From" value={meta.from} onChange={(v) => setMetaField("from", v)} placeholder="Seller's name or address" />
                <MetaInput label="To" value={meta.to} onChange={(v) => setMetaField("to", v)} placeholder="You" />
                <MetaInput label="Subject" value={meta.subject} onChange={(v) => setMetaField("subject", v)} className="sm:col-span-2" />
              </>
            )}
            {(kind === "call" || kind === "video_call") && (
              <>
                <MetaInput label="Participants" value={meta.participants} onChange={(v) => setMetaField("participants", v)} placeholder="You, the seller" className="sm:col-span-2" />
                {kind === "video_call" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Platform</Label>
                    <Select value={meta.platform ?? ""} onValueChange={(v) => setMetaField("platform", v)}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Choose" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="zoom">Zoom</SelectItem>
                        <SelectItem value="meet">Google Meet</SelectItem>
                        <SelectItem value="teams">Microsoft Teams</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <MetaInput label="Length (minutes)" type="number" value={meta.durationMin} onChange={(v) => setMetaField("durationMin", v)} />
              </>
            )}
            {kind === "crm" && (
              <div className="space-y-1.5">
                <Label className="text-xs">CRM</Label>
                <Select value={meta.provider ?? ""} onValueChange={(v) => setMetaField("provider", v)}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Choose" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pipedrive">Pipedrive</SelectItem>
                    <SelectItem value="hubspot">HubSpot</SelectItem>
                    <SelectItem value="salesforce">Salesforce</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {isWebKind && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Where from</Label>
                  <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="website">Website</SelectItem>
                      <SelectItem value="social">Social media</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <MetaInput label="Link" value={meta.url} onChange={(v) => setMetaField("url", v)} placeholder="https://" />
              </>
            )}
            <MetaInput label="Date" type="date" value={meta.date} onChange={(v) => setMetaField("date", v)} />
          </div>

          <label className="flex items-start gap-3 rounded-md border border-border px-3 py-2.5 cursor-pointer">
            <Switch checked={brokerOnly} onCheckedChange={setBrokerOnly} className="mt-0.5" data-testid="switch-broker-only" />
            <span className="text-xs">
              <span className="flex items-center gap-1 font-medium"><Lock className="h-3 w-3" /> Broker only</span>
              <span className="block text-muted-foreground mt-0.5">
                Never shown to the seller. The interview may confirm its facts, but never mentions or quotes it.
              </span>
            </span>
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            size="sm"
            className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
            onClick={() => add.mutate()}
            disabled={!ready || add.isPending}
            data-testid="button-add-source"
          >
            {add.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {add.isPending ? "Adding…" : "Add source"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MetaInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  className = "",
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label className="text-xs">{label}</Label>
      <Input type={type} value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-9" />
    </div>
  );
}
