/**
 * Left column of the buyer profile page: Contact · Buyer type & capacity ·
 * Background · Target industries & locations · Acquisition criteria.
 *
 * View mode shows each value with its source chip. Edit mode swaps in the
 * right input per field; every change is a pending draft entry until the
 * broker saves, and a field the broker has overridden offers "Revert to …"
 * (back to what the buyer / NDA / CRM says).
 */
import { useState, type ReactNode } from "react";
import { Lock, Undo2, ChevronDown, Linkedin, Mail, Phone } from "lucide-react";
import type { MergedFieldSource } from "@shared/schema";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SourceChip } from "./SourceChip";
import { CriterionEditor, MoneyInput, OptionSelect, ProofOfFundsSelect, TagEditor } from "./FieldEditors";
import {
  BUYER_CRITERIA_FIELDS, BUYER_TYPE_OPTIONS, CRITERIA_GROUPS, SOURCE_META, buyerTypeLabel, formatCriterion, formatMoney,
  humanize, isSet, type BuyerProfileResponse,
} from "./types";

export type DraftEntry = { action: "set"; value: any } | { action: "revert" };
export type Draft = Record<string, DraftEntry>;

interface Ctx {
  data: BuyerProfileResponse;
  editing: boolean;
  draft: Draft;
  setEntry: (key: string, entry: DraftEntry | undefined) => void;
  dealNames: Record<string, string>;
}

// ── value plumbing ───────────────────────────────────────────────────────

function mergedValue(data: BuyerProfileResponse, key: string): any {
  if (key.startsWith("criteria.")) return data.profile.buyerCriteria?.[key.slice(9)];
  return (data.profile as any)[key];
}

/** What the field falls back to without the broker's edit (buyer's own row, else CRM). */
export function lowerLayer(data: BuyerProfileResponse, key: string): { value: any; source: MergedFieldSource } | null {
  const own: any = data.layers.own;
  const crm: any = data.layers.crm?.profile ?? {};
  const crit = key.startsWith("criteria.") ? key.slice(9) : null;
  const ownV = crit ? own.buyerCriteria?.[crit] : own[key];
  const crmV = crit ? crm.buyerCriteria?.[crit] : crm[key];
  const stamp = data.layers.ownSources?.[key];
  const LEGACY: Record<string, string> = { crm_imported: "crm", nda_signed: "nda", broker_invited: "broker_import" };
  const ownSource = { source: (stamp?.source ?? LEGACY[data.buyer.accountSource ?? ""] ?? "buyer") as any, layer: "own" as const, at: stamp?.at ?? null, dealId: stamp?.dealId ?? null, legacy: !stamp };
  const ownCounts = key === "hasProofOfFunds" ? ownV === true || (ownV === false && !!stamp) : isSet(ownV);
  if (ownCounts) return { value: ownV, source: ownSource };
  const crmCounts = key === "hasProofOfFunds" ? typeof crmV === "boolean" : isSet(crmV);
  if (crmCounts) {
    const ev = data.layers.crm?.profile?.evidence ?? {};
    return { value: crmV, source: { source: "crm", layer: "crm", at: data.layers.crm?.profile?.extractedAt ?? null, evidence: ev[key] ?? (crit ? ev[crit] : null) ?? null } };
  }
  return null;
}

function effective(ctx: Ctx, key: string): any {
  const d = ctx.draft[key];
  if (d?.action === "set") return d.value;
  if (d?.action === "revert") return lowerLayer(ctx.data, key)?.value ?? null;
  return mergedValue(ctx.data, key);
}

function displayText(key: string, v: any, data: BuyerProfileResponse): string {
  if (key.startsWith("criteria.")) return formatCriterion(key.slice(9), v);
  if (!isSet(v) && v !== false) return "—";
  switch (key) {
    case "buyerType": return buyerTypeLabel(v) ?? "—";
    case "hasProofOfFunds": return v === true ? "Yes — verified" : v === false ? "No" : "Unknown";
    case "liquidFunds": return data.profile.liquidFundsIsRange && v === data.profile.liquidFunds ? v : /^\$?\s*[\d,.]+\s*[kmb]?$/i.test(String(v).trim()) ? formatMoney(v) : String(v);
    default: return Array.isArray(v) ? v.join(", ") : String(v);
  }
}

// ── building blocks ──────────────────────────────────────────────────────

export function Eyebrow({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="font-mono text-2xs font-medium uppercase tracking-[0.18em] text-teal">{children}</span>
      <div className="h-px flex-1 bg-border/70" />
      {right}
    </div>
  );
}

function FieldCell({ ctx, fieldKey, label, wide, editor, view }: {
  ctx: Ctx; fieldKey: string; label: string; wide?: boolean;
  editor?: (value: any, set: (v: any) => void) => ReactNode;
  view?: (value: any) => ReactNode;
}) {
  const { data, editing, draft, setEntry, dealNames } = ctx;
  const entry = draft[fieldKey];
  const value = effective(ctx, fieldKey);
  const src = data.sources[fieldKey];
  const lower = lowerLayer(data, fieldKey);
  const isOverridden = src?.source === "broker";
  const pending = !!entry;
  const setValue = (v: any) => setEntry(fieldKey, { action: "set", value: v });

  return (
    <div className={`bg-card p-3 sm:p-3.5 min-w-0 ${wide ? "col-span-full" : ""} ${pending ? "bg-teal/[0.04]" : ""}`} data-testid={`field-${fieldKey}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground leading-4">{label}</span>
        {pending ? (
          <span className="rounded-full border border-teal/40 px-1.5 py-px text-2xs text-teal leading-4 whitespace-nowrap">
            {entry.action === "revert" ? "Will revert" : "Unsaved"}
          </span>
        ) : (
          <SourceChip source={src} dealNames={dealNames} crmProvider={data.layers.crm?.provider} />
        )}
      </div>
      {editing && editor ? (
        <div className="space-y-1.5">
          {editor(value, setValue)}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
            {isOverridden && entry?.action !== "revert" && (
              <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setEntry(fieldKey, { action: "revert" })} data-testid={`revert-${fieldKey}`}>
                <Undo2 className="h-3 w-3" />
                {lower ? <>Revert to {SOURCE_META[lower.source.source]?.label ?? "source"}: <span className="text-foreground/80">{displayText(fieldKey, lower.value, data)}</span></> : "Revert (clear your edit)"}
              </button>
            )}
            {pending && (
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setEntry(fieldKey, undefined)}>
                Undo change
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="text-sm text-foreground break-words">
          {view ? view(value) : <span className={isSet(value) || value === false ? "" : "text-muted-foreground/60"}>{displayText(fieldKey, value, data)}</span>}
        </div>
      )}
    </div>
  );
}

const Grid = ({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) => (
  <div className={`grid grid-cols-1 ${cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"} gap-px bg-border/60 rounded-xl overflow-hidden border border-border/60`}>
    {children}
  </div>
);

const Chips = ({ items }: { items: string[] }) =>
  items.length ? (
    <div className="flex flex-wrap gap-1">{items.map((i) => <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">{i}</span>)}</div>
  ) : <span className="text-muted-foreground/60">—</span>;

// ── sections ─────────────────────────────────────────────────────────────

export function ContactSection({ ctx }: { ctx: Ctx }) {
  const text = (ph: string, testId: string) => (v: any, set: (v: any) => void) =>
    <Input value={v ?? ""} onChange={(e) => set(e.target.value)} placeholder={ph} className="h-9" data-testid={testId} />;
  const d = ctx.data;
  return (
    <section>
      <Eyebrow>Contact</Eyebrow>
      <Grid>
        <FieldCell ctx={ctx} fieldKey="name" label="Name" editor={text("Full name", "edit-name")} />
        <div className="bg-card p-3 sm:p-3.5 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-1">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground leading-4">Email</span>
            <span className="text-2xs text-muted-foreground/70 leading-4">{d.buyer.hasAccount ? "Cimple account" : "No account yet"}</span>
          </div>
          <a href={`mailto:${d.buyer.email}`} className="text-sm text-foreground hover:text-teal inline-flex items-center gap-1.5 break-all"><Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />{d.buyer.email}</a>
        </div>
        <FieldCell ctx={ctx} fieldKey="phone" label="Phone" editor={text("Phone", "edit-phone")}
          view={(v) => isSet(v) ? <a href={`tel:${v}`} className="inline-flex items-center gap-1.5 hover:text-teal"><Phone className="h-3.5 w-3.5 text-muted-foreground" />{v}</a> : <span className="text-muted-foreground/60">—</span>} />
        <FieldCell ctx={ctx} fieldKey="company" label="Company / firm" editor={text("Company", "edit-company")} />
        <FieldCell ctx={ctx} fieldKey="title" label="Title" editor={text("Title", "edit-title")} />
        <FieldCell ctx={ctx} fieldKey="linkedinUrl" label="LinkedIn" editor={text("https://linkedin.com/in/…", "edit-linkedin")}
          view={(v) => isSet(v) ? <a href={/^https?:/.test(v) ? v : `https://${v}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-teal break-all"><Linkedin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />{String(v).replace(/^https?:\/\/(www\.)?/, "")}</a> : <span className="text-muted-foreground/60">—</span>} />
      </Grid>
    </section>
  );
}

export function CapacitySection({ ctx }: { ctx: Ctx }) {
  const d = ctx.data;
  const latestNda = d.ndaAnswers[0]?.answers ?? null;
  const priceMin = effective(ctx, "criteria.askingPriceMin");
  const priceMax = effective(ctx, "criteria.askingPriceMax");
  const fundsMasked = !!d.profile.liquidFundsIsRange && !ctx.draft.liquidFunds;
  return (
    <section>
      <Eyebrow>Buyer type &amp; capacity</Eyebrow>
      <Grid>
        <FieldCell ctx={ctx} fieldKey="buyerType" label="Buyer type"
          editor={(v, set) => <OptionSelect value={v ?? null} onChange={set} options={BUYER_TYPE_OPTIONS} testId="edit-buyerType" />} />
        <div className="bg-card p-3 sm:p-3.5 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-1">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground leading-4">Price range</span>
            <SourceChip source={d.sources["criteria.askingPriceMax"] ?? d.sources["criteria.askingPriceMin"]} dealNames={ctx.dealNames} crmProvider={d.layers.crm?.provider} />
          </div>
          {ctx.editing ? (
            <div className="flex items-center gap-2">
              <MoneyInput value={priceMin} onChange={(v) => ctx.setEntry("criteria.askingPriceMin", { action: "set", value: v })} placeholder="Min" testId="edit-price-min" />
              <span className="text-muted-foreground text-xs">to</span>
              <MoneyInput value={priceMax} onChange={(v) => ctx.setEntry("criteria.askingPriceMax", { action: "set", value: v })} placeholder="Max" testId="edit-price-max" />
            </div>
          ) : (
            <div className="text-sm">
              {isSet(priceMin) || isSet(priceMax)
                ? `${isSet(priceMin) ? formatMoney(priceMin) : "Up"} to ${isSet(priceMax) ? formatMoney(priceMax) : "open"}`
                : <span className="text-muted-foreground/60">—</span>}
            </div>
          )}
        </div>
        <FieldCell ctx={ctx} fieldKey="liquidFunds" label="Liquid funds"
          editor={(v, set) => (
            <div className="space-y-1">
              <Input value={fundsMasked ? "" : v ?? ""} onChange={(e) => set(e.target.value)} placeholder={fundsMasked ? `Buyer said ${d.profile.liquidFunds} — type your own figure` : "e.g. $750K"} className="h-9" data-testid="edit-liquidFunds" />
            </div>
          )}
          view={(v) => (
            <span className="inline-flex items-center gap-1.5">
              {isSet(v) ? displayText("liquidFunds", v, d) : <span className="text-muted-foreground/60">—</span>}
              {fundsMasked && isSet(v) && (
                <span title="The buyer entered an exact figure on their profile; they were promised brokers see a range only." className="text-muted-foreground"><Lock className="h-3 w-3" /></span>
              )}
            </span>
          )} />
        <FieldCell ctx={ctx} fieldKey="hasProofOfFunds" label="Proof of funds"
          editor={(v, set) => <ProofOfFundsSelect value={v ?? null} onChange={set} />}
          view={(v) => <span className={v === true ? "text-emerald-400" : v === false ? "" : "text-muted-foreground/60"}>{v === true ? "Yes — verified" : v === false ? "No" : "Unknown"}</span>} />
        {latestNda && (latestNda.funding || latestNda.timeline) && (
          <div className="bg-card p-3 sm:p-3.5 min-w-0 col-span-full">
            <div className="flex items-start justify-between gap-2 mb-1">
              <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground leading-4">Funding &amp; timeline</span>
              <SourceChip source={{ source: "nda", layer: "own", at: d.ndaAnswers[0].signedAt, dealId: d.ndaAnswers[0].dealId }} dealNames={ctx.dealNames} />
            </div>
            <div className="text-sm text-foreground">{[fundingLabel(latestNda.funding), timelineLabel(latestNda.timeline)].filter(Boolean).join(" · ")}</div>
          </div>
        )}
      </Grid>
    </section>
  );
}

const fundingLabel = (v?: string) => ({ cash: "Cash / own equity", bank_loan: "Bank or SBA / BDC loan", investors: "Investors or partners", fund: "Committed fund", combination: "A combination" } as Record<string, string>)[v ?? ""] ?? (v ? humanize(v) : null);
const timelineLabel = (v?: string) => ({ "0_3": "Buying within 3 months", "3_6": "Buying in 3–6 months", "6_12": "Buying in 6–12 months", "12_plus": "More than a year out" } as Record<string, string>)[v ?? ""] ?? null;

export function BackgroundSection({ ctx }: { ctx: Ctx }) {
  return (
    <section>
      <Eyebrow>Background</Eyebrow>
      <Grid>
        <FieldCell ctx={ctx} fieldKey="background" label="Who they are" wide
          editor={(v, set) => <Textarea value={v ?? ""} onChange={(e) => set(e.target.value)} rows={4} placeholder="Operating background, what they've bought before, why they're buying…" data-testid="edit-background" />}
          view={(v) => isSet(v) ? <p className="leading-relaxed text-foreground/90 whitespace-pre-line">{v}</p> : <span className="text-muted-foreground/60">Nothing on file yet.</span>} />
        {isSet(ctx.data.profile.buyerCriteria?.lookingFor) && (
          <div className="bg-card p-3 sm:p-3.5 col-span-full">
            <div className="flex items-start justify-between gap-2 mb-1">
              <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground leading-4">What they're looking for (their words)</span>
              <SourceChip source={ctx.data.sources["criteria.lookingFor"]} dealNames={ctx.dealNames} crmProvider={ctx.data.layers.crm?.provider} />
            </div>
            <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-line">{ctx.data.profile.buyerCriteria.lookingFor}</p>
          </div>
        )}
      </Grid>
    </section>
  );
}

export function TargetsSection({ ctx }: { ctx: Ctx }) {
  return (
    <section>
      <Eyebrow>Target industries &amp; locations</Eyebrow>
      <Grid>
        <FieldCell ctx={ctx} fieldKey="targetIndustries" label="Industries"
          editor={(v, set) => <TagEditor values={v ?? []} onChange={set} placeholder="e.g. HVAC, Dental practices" testId="edit-targetIndustries" />}
          view={(v) => <Chips items={v ?? []} />} />
        <FieldCell ctx={ctx} fieldKey="targetLocations" label="Locations"
          editor={(v, set) => <TagEditor values={v ?? []} onChange={set} placeholder="e.g. Ontario, GTA" testId="edit-targetLocations" />}
          view={(v) => <Chips items={v ?? []} />} />
      </Grid>
    </section>
  );
}

export function CriteriaSection({ ctx }: { ctx: Ctx }) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const all = ctx.editing || showAll;
  const total = Object.keys(BUYER_CRITERIA_FIELDS).length;
  const filled = Object.keys(BUYER_CRITERIA_FIELDS).filter((k) => isSet(effective(ctx, `criteria.${k}`))).length;
  return (
    <section>
      <Eyebrow right={
        <label className="flex items-center gap-2 text-2xs text-muted-foreground cursor-pointer select-none">
          <span className="tabular-nums">{filled} of {total} on file</span>
          {!ctx.editing && <><span className="hidden sm:inline">· Show all fields</span><span className="sm:hidden">· All</span><Switch checked={showAll} onCheckedChange={setShowAll} className="scale-75" data-testid="toggle-show-all-criteria" /></>}
        </label>
      }>Acquisition criteria</Eyebrow>
      <div className="space-y-4">
        {CRITERIA_GROUPS.map((g) => {
          const keys = all ? g.keys : g.keys.filter((k) => isSet(effective(ctx, `criteria.${k}`)));
          const groupFilled = g.keys.filter((k) => isSet(effective(ctx, `criteria.${k}`))).length;
          const collapsed = ctx.editing && open[g.section] === false;
          if (!keys.length && !all) return null;
          return (
            <div key={g.section}>
              <button type="button" className="flex w-full items-center justify-between py-1 text-left" onClick={() => ctx.editing && setOpen((o) => ({ ...o, [g.section]: o[g.section] === false }))}>
                <span className="text-xs font-medium text-foreground">{g.label} <span className="ml-1 text-muted-foreground font-normal tabular-nums">{groupFilled}/{g.keys.length}</span></span>
                {ctx.editing && <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${collapsed ? "-rotate-90" : ""}`} />}
              </button>
              {!collapsed && (
                <div className="mt-1.5">
                  <Grid cols={ctx.editing ? 2 : 3}>
                    {keys.map((k) => (
                      <FieldCell key={k} ctx={ctx} fieldKey={`criteria.${k}`} label={BUYER_CRITERIA_FIELDS[k].label}
                        editor={(v, set) => <CriterionEditor fieldKey={k} value={v} onChange={set} />} />
                    ))}
                    {keys.length % (ctx.editing ? 2 : 3) !== 0 && Array.from({ length: (ctx.editing ? 2 : 3) - (keys.length % (ctx.editing ? 2 : 3)) }).map((_, i) => <div key={`pad-${i}`} className="hidden sm:block bg-card" />)}
                  </Grid>
                </div>
              )}
            </div>
          );
        })}
        {!all && filled === 0 && (
          <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No acquisition criteria on file yet. <span className="text-foreground">Edit profile</span> to add what you know, or they'll fill in as the buyer signs NDAs.
          </div>
        )}
      </div>
    </section>
  );
}

export type ProfileCtx = Ctx;
