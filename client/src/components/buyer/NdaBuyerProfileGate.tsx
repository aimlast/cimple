/**
 * NdaBuyerProfileGate — the NDA step of the buyer view room, which is also
 * where the buyer's profile is built (shared/nda-buyer-profile.ts).
 *
 * Step 1 "About you": buyer type, then a short set of questions for that
 * type. Step 2: the confidentiality agreement and "I agree". A returning
 * buyer whose profile is already on file just confirms it (or updates it).
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Lock, AlertCircle, Loader2, ArrowLeft, User, Building2, Landmark, Check } from "lucide-react";
import {
  NDA_BUYER_TYPES, FINANCIAL_KINDS, FUNDING_OPTIONS, PROOF_OF_FUNDS_OPTIONS, TIMELINE_OPTIONS,
  OPERATE_OPTIONS, DEAL_ROLE_OPTIONS, PRICE_STEPS, formatPrice, ndaTypeFromStored,
  type NdaBuyerType,
} from "@shared/nda-buyer-profile";

interface OnFile {
  name?: string; phone?: string; company?: string; title?: string; buyerType?: string | null;
  background?: string; lookingFor?: string; targetIndustries?: string[]; targetLocations?: string[];
  priceMin?: number | null; priceMax?: number | null; hasProofOfFunds?: boolean;
}
interface ProfileResponse { email: string; complete: boolean; onFile: OnFile }

type Form = {
  buyerType: NdaBuyerType | null; financialKind: string; name: string; phone: string; company: string;
  companyWebsite: string; title: string; background: string; lookingFor: string; priceMin: string; priceMax: string;
  funding: string; proofOfFunds: string; timeline: string; operateSelf: string; fitReason: string; dealRole: string;
  checkSize: string; appealedTo: string; bestTimeToContact: string;
};

const TYPE_ICONS: Record<NdaBuyerType, typeof User> = { individual: User, strategic: Building2, financial: Landmark };

function Chips({ options, value, onChange, testId }: {
  options: readonly { value: string; label: string }[]; value: string; onChange: (v: string) => void; testId: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-full border px-3 py-1 text-xs transition-colors ${
            value === o.value ? "border-teal bg-teal/15 text-foreground" : "border-border text-muted-foreground hover:border-teal/50 hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children, required }: { label: string; hint?: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">
        {label}{required && <span className="text-teal"> *</span>}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const priceSelect = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

export function NdaBuyerProfileGate({ dealName, token, onAccepted }: { dealName: string; token: string; onAccepted: () => void }) {
  const { data, isLoading } = useQuery<ProfileResponse>({
    queryKey: ["/api/view", token, "buyer-profile"],
    queryFn: async () => {
      const r = await fetch(`/api/view/${token}/buyer-profile`);
      if (!r.ok) throw new Error("Couldn't load your profile");
      return r.json();
    },
  });

  const [step, setStep] = useState<"about" | "agree" | "confirm">("about");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>({
    buyerType: null, financialKind: "", name: "", phone: "", company: "", companyWebsite: "", title: "",
    background: "", lookingFor: "", priceMin: "", priceMax: "", funding: "", proofOfFunds: "", timeline: "",
    operateSelf: "", fitReason: "", dealRole: "", checkSize: "", appealedTo: "", bestTimeToContact: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  // Signed: the parent is re-fetching the CIM — hold a calm "opening" state
  // rather than falling back into the form while that request is in flight.
  const [signed, setSigned] = useState(false);

  // Prefill from what the buyer already told us.
  useEffect(() => {
    if (!data) return;
    const f = data.onFile || {};
    const fallbackWants = [
      (f.targetIndustries || []).join(", "),
      (f.targetLocations || []).length ? `in ${(f.targetLocations || []).join(", ")}` : "",
    ].filter(Boolean).join(" ");
    setForm((prev) => ({
      ...prev,
      buyerType: ndaTypeFromStored(f.buyerType) ?? prev.buyerType,
      financialKind: f.buyerType && ["private_equity", "family_office", "search_fund"].includes(f.buyerType) ? f.buyerType : prev.financialKind,
      name: f.name || prev.name, phone: f.phone || prev.phone, company: f.company || prev.company, title: f.title || prev.title,
      background: f.background || prev.background, lookingFor: f.lookingFor || fallbackWants || prev.lookingFor,
      priceMin: f.priceMin ? String(f.priceMin) : prev.priceMin, priceMax: f.priceMax ? String(f.priceMax) : prev.priceMax,
      proofOfFunds: f.hasProofOfFunds ? "yes" : prev.proofOfFunds,
    }));
    if (data.complete) setStep((cur) => (cur === "about" && !editing ? "confirm" : cur));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((p) => ({ ...p, [k]: v }));
  const t = form.buyerType;

  const missing = useMemo(() => {
    const m: string[] = [];
    if (!t) m.push("buyer type");
    if (!form.name.trim()) m.push("name");
    if (form.phone.trim().length < 5) m.push("phone");
    if ((t === "strategic" || t === "financial") && !form.company.trim()) m.push(t === "strategic" ? "company" : "firm");
    if (form.background.trim().length < 10) m.push("background");
    if (form.lookingFor.trim().length < 10) m.push("what you're looking for");
    if (!form.priceMin && !form.priceMax) m.push("price range");
    if (form.priceMin && form.priceMax && Number(form.priceMin) > Number(form.priceMax)) m.push("a price range where the maximum is above the minimum");
    if (!form.funding) m.push("funding");
    if (!form.proofOfFunds) m.push("proof of funds");
    if (!form.timeline) m.push("timeline");
    return m;
  }, [form, t]);

  const payload = () => ({
    buyerType: t,
    financialKind: t === "financial" ? form.financialKind || "other" : null,
    name: form.name.trim(), phone: form.phone.trim(), company: form.company.trim() || null,
    companyWebsite: form.companyWebsite.trim() || null, title: form.title.trim() || null,
    background: form.background.trim(), lookingFor: form.lookingFor.trim(),
    priceMin: form.priceMin ? Number(form.priceMin) : null, priceMax: form.priceMax ? Number(form.priceMax) : null,
    funding: form.funding, proofOfFunds: form.proofOfFunds, timeline: form.timeline,
    operateSelf: t === "individual" ? form.operateSelf || null : null,
    fitReason: t === "strategic" ? form.fitReason.trim() || null : null,
    dealRole: t === "financial" ? form.dealRole || null : null,
    checkSize: t === "financial" ? form.checkSize.trim() || null : null,
    appealedTo: form.appealedTo.trim() || null, bestTimeToContact: form.bestTimeToContact.trim() || null,
  });

  const sign = async (confirmOnly: boolean) => {
    setSigning(true);
    setError(null);
    try {
      const res = await fetch(`/api/view/${token}/sign-nda`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirmOnly ? { confirmProfile: true } : { profile: payload() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body?.code === "profile_required") { setStep("about"); setEditing(true); }
        throw new Error(body.error || "Could not record your signature — please try again.");
      }
      setSigned(true);
      onAccepted();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not record your signature — please try again.");
    } finally {
      setSigning(false);
    }
  };

  const header = (
    <div className="flex items-center gap-3">
      <div className="h-10 w-10 shrink-0 rounded-lg bg-teal/10 flex items-center justify-center">
        <Lock className="h-5 w-5 text-teal" />
      </div>
      <div className="min-w-0">
        <h2 className="font-semibold text-base">
          {step === "agree" || step === "confirm" ? "Non-Disclosure Agreement" : "Before you view the CIM"}
        </h2>
        <p className="text-xs text-muted-foreground truncate">{dealName} — Confidential Information Memorandum</p>
      </div>
    </div>
  );

  const agreement = (
    <p className="text-sm text-muted-foreground leading-relaxed">
      By proceeding, you agree to keep all information contained in this Confidential Information Memorandum strictly
      confidential. You agree not to disclose, reproduce, or use this information except for the purpose of evaluating
      this business opportunity. This agreement is legally binding.
    </p>
  );

  const errorBox = error && (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert" data-testid="text-nda-error">
      <AlertCircle className="h-3.5 w-3.5 mt-px shrink-0" />
      <span>{error}</span>
    </div>
  );

  const summaryType = NDA_BUYER_TYPES.find((x) => x.value === t)?.label;
  const priceText = form.priceMin || form.priceMax
    ? `${form.priceMin ? formatPrice(Number(form.priceMin)) : "Up to"}${form.priceMin && form.priceMax ? " – " : " "}${form.priceMax ? formatPrice(Number(form.priceMax)) : "and up"}`
    : null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background" data-testid="nda-gate">
      <div className="flex min-h-full items-start justify-center p-4 sm:items-center sm:p-6">
        <div className="w-full max-w-xl space-y-5 rounded-xl border border-border bg-card p-5 shadow-lg sm:p-8">
          {header}
          <Separator />

          {signed ? (
            <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground" data-testid="nda-signed-opening">
              <Loader2 className="h-5 w-5 animate-spin" />
              Signed — opening the CIM…
            </div>
          ) : isLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : step === "confirm" && !editing ? (
            <>
              <div className="rounded-lg border border-border bg-background/50 p-4 space-y-1.5 text-sm" data-testid="nda-profile-summary">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Your buyer profile</p>
                <p className="font-medium">{form.name}{form.company ? ` · ${form.company}` : ""}</p>
                <p className="text-muted-foreground">{[summaryType, priceText].filter(Boolean).join(" · ")}</p>
                {form.lookingFor && <p className="text-muted-foreground line-clamp-2">{form.lookingFor}</p>}
                <button type="button" className="text-xs text-teal underline underline-offset-2" onClick={() => { setEditing(true); setStep("about"); }} data-testid="button-nda-update-profile">
                  Update my profile
                </button>
              </div>
              {agreement}
              <Button className="w-full bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => sign(true)} disabled={signing} data-testid="button-sign-nda">
                {signing ? "Signing…" : "I agree — View the CIM"}
              </Button>
              {errorBox}
            </>
          ) : step === "about" ? (
            <>
              <p className="text-sm text-muted-foreground">
                A few questions so the broker knows who's looking — and can send you other businesses that fit what you want. Takes about a minute.
              </p>

              <Field label="I'm buying as" required>
                <div className="grid gap-2 sm:grid-cols-3" data-testid="nda-buyer-type">
                  {NDA_BUYER_TYPES.map((o) => {
                    const Icon = TYPE_ICONS[o.value];
                    const on = t === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => set("buyerType", o.value)}
                        className={`rounded-lg border p-3 text-left transition-colors ${on ? "border-teal bg-teal/10" : "border-border hover:border-teal/50"}`}
                        data-testid={`nda-type-${o.value}`}
                      >
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Icon className="h-4 w-4 text-teal" /> {o.label}
                          {on && <Check className="ml-auto h-3.5 w-3.5 text-teal" />}
                        </div>
                        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{o.hint}</p>
                      </button>
                    );
                  })}
                </div>
              </Field>

              {t && (
                <div className="space-y-4">
                  {t === "financial" && (
                    <Field label="Type of investor">
                      <Chips options={FINANCIAL_KINDS} value={form.financialKind} onChange={(v) => set("financialKind", v)} testId="nda-financial-kind" />
                    </Field>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Full name" required>
                      <Input value={form.name} onChange={(e) => set("name", e.target.value)} data-testid="input-nda-name" />
                    </Field>
                    <Field label="Phone" required>
                      <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} type="tel" data-testid="input-nda-phone" />
                    </Field>
                    <Field label={t === "financial" ? "Firm" : t === "strategic" ? "Company" : "Company (if any)"} required={t !== "individual"}>
                      <Input value={form.company} onChange={(e) => set("company", e.target.value)} data-testid="input-nda-company" />
                    </Field>
                    <Field label={t === "individual" ? "Current role" : "Your role"}>
                      <Input value={form.title} onChange={(e) => set("title", e.target.value)} data-testid="input-nda-title" />
                    </Field>
                  </div>
                  {t !== "individual" && (
                    <Field label={t === "financial" ? "Firm website" : "Company website"}>
                      <Input value={form.companyWebsite} onChange={(e) => set("companyWebsite", e.target.value)} placeholder="https://" data-testid="input-nda-website" />
                    </Field>
                  )}

                  <Field
                    label={t === "individual" ? "Your background" : t === "strategic" ? "About your company" : "About your firm"}
                    hint={t === "individual" ? "Industries you've worked in, businesses you've run or owned." : t === "strategic" ? "What you do, roughly how big (revenue or staff), where you operate." : "Typical deals, sectors, and portfolio."}
                    required
                  >
                    <Textarea rows={3} value={form.background} onChange={(e) => set("background", e.target.value)} data-testid="input-nda-background" />
                  </Field>

                  <Field label="What are you looking to acquire?" hint="Industries, size (revenue or cash flow), and locations you'd consider." required>
                    <Textarea rows={3} value={form.lookingFor} onChange={(e) => set("lookingFor", e.target.value)} data-testid="input-nda-looking-for" />
                  </Field>

                  <Field label="Purchase price you're considering" required>
                    <div className="grid grid-cols-2 gap-2">
                      <select className={priceSelect} value={form.priceMin} onChange={(e) => set("priceMin", e.target.value)} data-testid="select-nda-price-min">
                        <option value="">No minimum</option>
                        {PRICE_STEPS.map((p) => <option key={p} value={p}>From {formatPrice(p)}</option>)}
                      </select>
                      <select className={priceSelect} value={form.priceMax} onChange={(e) => set("priceMax", e.target.value)} data-testid="select-nda-price-max">
                        <option value="">No maximum</option>
                        {PRICE_STEPS.map((p) => <option key={p} value={p}>Up to {formatPrice(p)}</option>)}
                      </select>
                    </div>
                  </Field>

                  {t === "financial" && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Typical equity cheque">
                        <Input value={form.checkSize} onChange={(e) => set("checkSize", e.target.value)} placeholder="e.g. $2M–$10M" data-testid="input-nda-check-size" />
                      </Field>
                      <Field label="Platform or add-on?">
                        <Chips options={DEAL_ROLE_OPTIONS} value={form.dealRole} onChange={(v) => set("dealRole", v)} testId="nda-deal-role" />
                      </Field>
                    </div>
                  )}

                  <Field label="How would you fund the purchase?" required>
                    <Chips options={FUNDING_OPTIONS} value={form.funding} onChange={(v) => set("funding", v)} testId="nda-funding" />
                  </Field>
                  <Field label="Proof of funds" required>
                    <Chips options={PROOF_OF_FUNDS_OPTIONS} value={form.proofOfFunds} onChange={(v) => set("proofOfFunds", v)} testId="nda-proof" />
                  </Field>
                  <Field label="When are you looking to close?" required>
                    <Chips options={TIMELINE_OPTIONS} value={form.timeline} onChange={(v) => set("timeline", v)} testId="nda-timeline" />
                  </Field>

                  {t === "individual" && (
                    <Field label="Would you run the business yourself?">
                      <Chips options={OPERATE_OPTIONS} value={form.operateSelf} onChange={(v) => set("operateSelf", v)} testId="nda-operate" />
                    </Field>
                  )}
                  {t === "strategic" && (
                    <Field label="How would this business fit yours?">
                      <Textarea rows={2} value={form.fitReason} onChange={(e) => set("fitReason", e.target.value)} data-testid="input-nda-fit" />
                    </Field>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="What caught your eye about this listing?">
                      <Input value={form.appealedTo} onChange={(e) => set("appealedTo", e.target.value)} data-testid="input-nda-appealed" />
                    </Field>
                    <Field label="Best time to reach you">
                      <Input value={form.bestTimeToContact} onChange={(e) => set("bestTimeToContact", e.target.value)} placeholder="e.g. weekdays after 3pm" data-testid="input-nda-best-time" />
                    </Field>
                  </div>
                </div>
              )}

              {missing.length > 0 && t && (
                <p className="text-[11px] text-muted-foreground">Still needed: {missing.join(", ")}.</p>
              )}
              <Button
                className="w-full bg-teal text-teal-foreground hover:bg-teal/90"
                disabled={missing.length > 0}
                onClick={() => { setError(null); setStep("agree"); }}
                data-testid="button-nda-continue"
              >
                Continue to the NDA
              </Button>
            </>
          ) : (
            <>
              {agreement}
              <Button className="w-full bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => sign(false)} disabled={signing} data-testid="button-sign-nda">
                {signing ? "Signing…" : "I agree — View the CIM"}
              </Button>
              <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setStep("about")}>
                <ArrowLeft className="h-3 w-3" /> Back to your details
              </button>
              {errorBox}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
