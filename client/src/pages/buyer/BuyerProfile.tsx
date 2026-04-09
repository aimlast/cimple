/**
 * BuyerProfile — progressive profile editor for buyer accounts.
 *
 * Buyers fill out this page to power CIM matching on their dashboard. The
 * page is organized by section and shows a completion percentage bar at the
 * top to nudge users toward a full profile.
 *
 * Sections:
 *   1. Basic info (name, phone, company, title, LinkedIn)
 *   2. Buyer type + background
 *   3. Financial capability (liquid funds, proof of funds)
 *   4. Target industries + locations (tag inputs)
 *   5. Deep investment criteria (BUYER_CRITERIA_SECTIONS) — optional power-user
 *      panel surfaced via tabs
 *
 * All edits PATCH /api/buyer-auth/me. The server re-computes
 * profileCompletionPct on every write, so we always show fresh progress.
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, CheckCircle2, AlertCircle, X, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { BUYER_CRITERIA_SECTIONS } from "@shared/schema";
import { BuyerNav } from "./shared";

interface BuyerMe {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  buyerType: string | null;
  background: string | null;
  liquidFunds: string | null;
  hasProofOfFunds: boolean;
  targetIndustries: string[];
  targetLocations: string[];
  buyerCriteria: Record<string, any>;
  profileCompletionPct: number;
}

const BUYER_TYPE_OPTIONS = [
  { value: "individual", label: "Individual buyer" },
  { value: "strategic", label: "Strategic acquirer" },
  { value: "financial", label: "Financial buyer" },
  { value: "search_fund", label: "Search fund" },
  { value: "family_office", label: "Family office" },
  { value: "private_equity", label: "Private equity" },
];

export default function BuyerProfile() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // Local draft state — we mirror the server record so edits feel snappy
  const [form, setForm] = useState<Partial<BuyerMe>>({});
  const [industryInput, setIndustryInput] = useState("");
  const [locationInput, setLocationInput] = useState("");

  const { data, isLoading, error } = useQuery<{ user: BuyerMe }>({
    queryKey: ["/api/buyer-auth/me"],
    queryFn: async () => {
      const res = await fetch("/api/buyer-auth/me", { credentials: "include" });
      if (res.status === 401) {
        window.location.href = "/buyer/login";
        throw new Error("Not authenticated");
      }
      if (!res.ok) throw new Error("Failed to load profile");
      return res.json();
    },
  });

  // Hydrate local form from server on first load
  useEffect(() => {
    if (data?.user && Object.keys(form).length === 0) {
      setForm({
        ...data.user,
        targetIndustries: data.user.targetIndustries ?? [],
        targetLocations: data.user.targetLocations ?? [],
        buyerCriteria: data.user.buyerCriteria ?? {},
      });
    }
  }, [data]);

  const save = useMutation({
    mutationFn: async (updates: Partial<BuyerMe>) => {
      const res = await fetch("/api/buyer-auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed to save");
      }
      return res.json();
    },
    onSuccess: (result) => {
      qc.setQueryData(["/api/buyer-auth/me"], result);
      setForm((prev) => ({ ...prev, profileCompletionPct: result.user.profileCompletionPct }));
      setSaveMsg("Saved");
      setTimeout(() => setSaveMsg(null), 1500);
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">{(error as Error).message}</div>
      </div>
    );
  }

  const completion = form.profileCompletionPct ?? 0;
  const isWelcome = typeof window !== "undefined" && window.location.search.includes("welcome=1");

  const update = (patch: Partial<BuyerMe>) => setForm((prev) => ({ ...prev, ...patch }));

  const handleSave = () => {
    const { id, email, profileCompletionPct, ...updates } = form;
    save.mutate(updates);
  };

  const addIndustry = () => {
    const v = industryInput.trim();
    if (!v) return;
    const next = Array.from(new Set([...(form.targetIndustries ?? []), v]));
    update({ targetIndustries: next });
    setIndustryInput("");
  };

  const removeIndustry = (v: string) => {
    update({ targetIndustries: (form.targetIndustries ?? []).filter((i) => i !== v) });
  };

  const addLocation = () => {
    const v = locationInput.trim();
    if (!v) return;
    const next = Array.from(new Set([...(form.targetLocations ?? []), v]));
    update({ targetLocations: next });
    setLocationInput("");
  };

  const removeLocation = (v: string) => {
    update({ targetLocations: (form.targetLocations ?? []).filter((l) => l !== v) });
  };

  const updateCriterion = (key: string, value: any) => {
    const nextCriteria = { ...(form.buyerCriteria ?? {}) };
    if (value === "" || value === null || value === undefined) {
      delete nextCriteria[key];
    } else {
      nextCriteria[key] = value;
    }
    update({ buyerCriteria: nextCriteria });
  };

  return (
    <div className="min-h-screen bg-background">
      <BuyerNav />

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* Header + completion bar */}
        <div>
          <h1 className="text-2xl font-semibold">Your buyer profile</h1>
          <p className="text-sm text-muted-foreground mt-1">
            The more we know about what you're looking for, the more relevant your matches will be.
          </p>
        </div>

        {isWelcome && (
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="p-4 flex items-start gap-3">
              <Sparkles className="h-4 w-4 text-primary mt-0.5" />
              <div className="text-sm">
                <div className="font-medium">Welcome to Cimple.</div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Fill out your profile to start getting matched with confidential business-for-sale opportunities.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="font-medium">Profile completion</span>
              <span className="text-muted-foreground">{completion}%</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${completion}%` }}
              />
            </div>
          </CardContent>
        </Card>

        {/* Tabbed sections */}
        <Tabs defaultValue="basic" className="w-full">
          <TabsList className="grid grid-cols-4 w-full max-w-2xl">
            <TabsTrigger value="basic">Basic info</TabsTrigger>
            <TabsTrigger value="targets">Targets</TabsTrigger>
            <TabsTrigger value="financial">Financial</TabsTrigger>
            <TabsTrigger value="criteria">Criteria</TabsTrigger>
          </TabsList>

          {/* --- BASIC INFO --- */}
          <TabsContent value="basic" className="mt-4">
            <Card>
              <CardContent className="p-6 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label="Full name">
                    <Input value={form.name ?? ""} onChange={(e) => update({ name: e.target.value })} />
                  </Field>
                  <Field label="Email (read-only)">
                    <Input value={form.email ?? ""} disabled />
                  </Field>
                  <Field label="Phone">
                    <Input value={form.phone ?? ""} onChange={(e) => update({ phone: e.target.value })} />
                  </Field>
                  <Field label="Company">
                    <Input value={form.company ?? ""} onChange={(e) => update({ company: e.target.value })} />
                  </Field>
                  <Field label="Title">
                    <Input value={form.title ?? ""} onChange={(e) => update({ title: e.target.value })} />
                  </Field>
                  <Field label="LinkedIn URL">
                    <Input value={form.linkedinUrl ?? ""} onChange={(e) => update({ linkedinUrl: e.target.value })} />
                  </Field>
                </div>

                <Field label="Buyer type">
                  <Select
                    value={form.buyerType ?? ""}
                    onValueChange={(v) => update({ buyerType: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select buyer type" />
                    </SelectTrigger>
                    <SelectContent>
                      {BUYER_TYPE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Background / investment thesis">
                  <Textarea
                    rows={4}
                    placeholder="Tell brokers about your acquisition experience, industry expertise, and what you're hoping to build..."
                    value={form.background ?? ""}
                    onChange={(e) => update({ background: e.target.value })}
                  />
                </Field>
              </CardContent>
            </Card>
          </TabsContent>

          {/* --- TARGETS --- */}
          <TabsContent value="targets" className="mt-4">
            <Card>
              <CardContent className="p-6 space-y-6">
                <div>
                  <Label className="text-xs">Target industries</Label>
                  <p className="text-[11px] text-muted-foreground mb-2">
                    Industries you're actively looking in. Deals outside these will still show up — they just won't rank as high.
                  </p>
                  <div className="flex gap-2 mb-2">
                    <Input
                      placeholder="e.g. HVAC, SaaS, logistics"
                      value={industryInput}
                      onChange={(e) => setIndustryInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addIndustry(); } }}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={addIndustry}>
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(form.targetIndustries ?? []).map((i) => (
                      <Badge key={i} variant="secondary" className="gap-1">
                        {i}
                        <button type="button" onClick={() => removeIndustry(i)}>
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                    {(form.targetIndustries ?? []).length === 0 && (
                      <span className="text-xs text-muted-foreground">No industries added yet.</span>
                    )}
                  </div>
                </div>

                <div>
                  <Label className="text-xs">Target locations</Label>
                  <p className="text-[11px] text-muted-foreground mb-2">
                    States, provinces, cities, or regions where you'd consider buying.
                  </p>
                  <div className="flex gap-2 mb-2">
                    <Input
                      placeholder="e.g. Ontario, Texas, Pacific Northwest"
                      value={locationInput}
                      onChange={(e) => setLocationInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLocation(); } }}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={addLocation}>
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(form.targetLocations ?? []).map((l) => (
                      <Badge key={l} variant="secondary" className="gap-1">
                        {l}
                        <button type="button" onClick={() => removeLocation(l)}>
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                    {(form.targetLocations ?? []).length === 0 && (
                      <span className="text-xs text-muted-foreground">No locations added yet.</span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* --- FINANCIAL --- */}
          <TabsContent value="financial" className="mt-4">
            <Card>
              <CardContent className="p-6 space-y-4">
                <Field label="Liquid funds available">
                  <Input
                    placeholder="e.g. $500K, $2M"
                    value={form.liquidFunds ?? ""}
                    onChange={(e) => update({ liquidFunds: e.target.value })}
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    This is kept private. Brokers only see a range, never the exact amount.
                  </p>
                </Field>

                <div className="flex items-start gap-2">
                  <Checkbox
                    id="pof"
                    checked={!!form.hasProofOfFunds}
                    onCheckedChange={(v) => update({ hasProofOfFunds: !!v })}
                  />
                  <div>
                    <Label htmlFor="pof" className="text-xs">I can provide proof of funds on request</Label>
                    <p className="text-[11px] text-muted-foreground">
                      Brokers strongly prefer buyers who can verify capital.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* --- DEEP CRITERIA --- */}
          <TabsContent value="criteria" className="mt-4">
            <Card>
              <CardContent className="p-6 space-y-6">
                <div className="text-xs text-muted-foreground">
                  Optional detailed criteria. The more you fill in here, the sharper the match count on your dashboard.
                </div>
                {Object.entries(BUYER_CRITERIA_SECTIONS).map(([sectionKey, section]) => (
                  <div key={sectionKey}>
                    <div className="text-sm font-medium mb-3">{section.label}</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {Object.entries(section.fields).map(([fieldKey, fieldDef]: [string, any]) => {
                        // Skip fields that are already covered by top-level form state
                        if (fieldKey === "targetIndustries" || fieldKey === "targetLocations") return null;
                        const value = (form.buyerCriteria ?? {})[fieldKey];
                        return (
                          <CriterionInput
                            key={fieldKey}
                            fieldKey={fieldKey}
                            def={fieldDef}
                            value={value}
                            onChange={(v) => updateCriterion(fieldKey, v)}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Save bar */}
        <div className="sticky bottom-4 flex items-center justify-end gap-3">
          {save.error && (
            <div className="flex items-center gap-1.5 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5" />
              {(save.error as Error).message}
            </div>
          )}
          {saveMsg && (
            <div className="flex items-center gap-1.5 text-xs text-primary">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {saveMsg}
            </div>
          )}
          <Button variant="outline" onClick={() => setLocation("/buyer/dashboard")}>
            Back to dashboard
          </Button>
          <Button onClick={handleSave} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
            Save profile
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function CriterionInput({
  fieldKey, def, value, onChange,
}: {
  fieldKey: string;
  def: { label: string; type: string; options?: readonly string[] };
  value: any;
  onChange: (v: any) => void;
}) {
  const type = def.type;

  if (type === "boolean") {
    return (
      <div className="flex items-start gap-2 py-2">
        <Checkbox
          id={fieldKey}
          checked={!!value}
          onCheckedChange={(v) => onChange(!!v)}
        />
        <Label htmlFor={fieldKey} className="text-xs">{def.label}</Label>
      </div>
    );
  }

  if (type === "select" && def.options) {
    return (
      <Field label={def.label}>
        <Select value={value ?? ""} onValueChange={(v) => onChange(v || null)}>
          <SelectTrigger>
            <SelectValue placeholder="Any" />
          </SelectTrigger>
          <SelectContent>
            {def.options.map((o) => (
              <SelectItem key={o} value={o}>{o.replace(/_/g, " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  }

  if (type === "multiselect" && def.options) {
    const arr: string[] = Array.isArray(value) ? value : [];
    return (
      <Field label={def.label}>
        <div className="flex flex-wrap gap-1.5">
          {def.options.map((o) => {
            const active = arr.includes(o);
            return (
              <Badge
                key={o}
                variant={active ? "default" : "outline"}
                className="cursor-pointer text-xs"
                onClick={() => {
                  const next = active ? arr.filter((x) => x !== o) : [...arr, o];
                  onChange(next.length ? next : null);
                }}
              >
                {o.replace(/_/g, " ")}
              </Badge>
            );
          })}
        </div>
      </Field>
    );
  }

  if (type === "tags") {
    const arr: string[] = Array.isArray(value) ? value : [];
    return (
      <Field label={def.label}>
        <Input
          placeholder="Comma-separated"
          value={arr.join(", ")}
          onChange={(e) => {
            const parts = e.target.value.split(",").map((p) => p.trim()).filter(Boolean);
            onChange(parts.length ? parts : null);
          }}
        />
      </Field>
    );
  }

  // number / currency / percent — all simple text inputs
  return (
    <Field label={def.label}>
      <Input
        type={type === "number" || type === "currency" || type === "percent" ? "text" : "text"}
        placeholder={type === "currency" ? "$" : type === "percent" ? "%" : ""}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      />
    </Field>
  );
}
