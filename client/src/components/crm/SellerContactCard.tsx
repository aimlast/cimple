/**
 * The Seller block on the Information tab — who the seller is (from the CRM,
 * the broker, or the seller invite), with the source shown and an inline edit.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Database, Loader2, Mail, PencilLine, Phone, Send, UserRound } from "lucide-react";
import type { SellerContactView } from "@shared/crm-seller";
import { useCrmAction, useCrmStatus } from "./useCrm";

const SOURCE_TEXT: Record<NonNullable<SellerContactView["source"]>, { label: string; icon: typeof Database }> = {
  crm: { label: "From Pipedrive", icon: Database },
  broker: { label: "Edited by you", icon: PencilLine },
  invite: { label: "From the seller invite", icon: Send },
};
const INVITE_TEXT = { created: "Invite created", emailed: "Invite emailed", opened: "Seller has opened their link" } as const;

export function SellerContactCard({ dealId }: { dealId: string }) {
  const { data, isLoading, error, refetch } = useCrmStatus(dealId);
  const action = useCrmAction(dealId);
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", title: "", email: "", phone: "" });

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (error || !data) {
    return (
      <section className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
        Couldn't load the seller's details.{" "}
        <button type="button" className="text-teal hover:underline" onClick={() => refetch()}>Try again</button>
      </section>
    );
  }
  const s = data.seller;
  const hasAny = !!(s.name || s.email || s.phone || s.title);
  const src = s.source ? SOURCE_TEXT[s.source] : null;

  const startEdit = () => {
    setForm({ name: s.name ?? "", title: s.title ?? "", email: s.email ?? "", phone: s.phone ?? "" });
    setEditing(true);
  };
  const save = () =>
    action.mutate(
      { method: "PUT", path: "/seller-contact", body: form },
      {
        onSuccess: () => { setEditing(false); toast({ title: "Seller details saved" }); },
        onError: (e) => toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" }),
      },
    );

  return (
    <section className="rounded-lg border border-border bg-card p-4 min-w-0 flex flex-col" data-testid="seller-contact-card">
      <div className="flex items-center gap-2">
        <UserRound className="h-4 w-4 text-teal" />
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground flex-1">Seller</h3>
        {!editing && (
          <button type="button" onClick={startEdit} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-teal" data-testid="button-edit-seller">
            <PencilLine className="h-3 w-3" /> {hasAny ? "Edit" : "Add"}
          </button>
        )}
      </div>

      {editing ? (
        <form
          className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5"
          onSubmit={(e) => { e.preventDefault(); save(); }}
        >
          <Field id="seller-name" label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} autoFocus />
          <Field id="seller-title" label="Role" value={form.title} placeholder="Owner" onChange={(v) => setForm({ ...form, title: v })} />
          <Field id="seller-email" label="Email" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
          <Field id="seller-phone" label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
          <div className="sm:col-span-2 flex items-center gap-2 pt-1">
            <Button type="submit" size="sm" className="h-8 text-xs bg-teal text-teal-foreground hover:bg-teal/90" disabled={action.isPending}>
              {action.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1" />} Save
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : hasAny ? (
        <div className="mt-2 flex-1 flex flex-col">
          <p className="text-sm font-medium break-words">
            {s.name || "Name not on file"}
            {s.title && <span className="text-muted-foreground font-normal"> · {s.title}</span>}
          </p>
          <div className="mt-1 mb-3 space-y-0.5">
            {s.email && (
              <a href={`mailto:${s.email}`} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground break-all">
                <Mail className="h-3 w-3 shrink-0" /> {s.email}
              </a>
            )}
            {s.phone && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Phone className="h-3 w-3 shrink-0" /> {s.phone}
              </p>
            )}
          </div>
          <div className="mt-auto pt-3 border-t border-border/50 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/80">
            {src && (
              <span className="inline-flex items-center gap-1">
                <src.icon className="h-3 w-3" /> {src.label}
              </span>
            )}
            {s.invite && <span>{INVITE_TEXT[s.invite.status]}{s.invite.email && s.invite.email !== s.email ? ` (${s.invite.email})` : ""}</span>}
          </div>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
          No seller details yet. Add them here, link the seller's Pipedrive record, or invite the seller from the Overview.
        </p>
      )}
    </section>
  );
}

function Field({
  id, label, value, onChange, type = "text", placeholder, autoFocus,
}: {
  id: string; label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; autoFocus?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px] text-muted-foreground">{label}</Label>
      <Input id={id} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="h-8 text-sm" autoFocus={autoFocus} />
    </div>
  );
}
