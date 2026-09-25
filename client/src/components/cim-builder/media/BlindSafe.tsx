/**
 * "Safe to show in the blind CIM" — the per-photo/video switch and the one
 * explanation brokers need to use it well. Off by default: nothing visual
 * reaches a blind buyer unless the broker says it can't identify the business.
 */
import { EyeOff, Info, ShieldCheck } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export const BLIND_SAFE_HELP =
  "Blind-CIM buyers don't know which business this is. Photos and videos stay out of the blind CIM unless you mark them safe — only do that if nothing in them (signs, logos, vehicles, uniforms, staff, the street or skyline) could identify the business.";

export function BlindSafeExplainer({ className, video }: { className?: string; video?: boolean }) {
  return (
    <p className={cn("flex items-start gap-1.5 rounded-md bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground leading-snug", className)}>
      <Info className="h-3.5 w-3.5 mt-px shrink-0 text-teal" />
      <span>
        {BLIND_SAFE_HELP}
        {video && " For YouTube and Vimeo, the player also shows the channel's name."}
      </span>
    </p>
  );
}

interface Props {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  /** Why it can't be switched on (e.g. a photo from a web address). */
  disabledReason?: string;
  id: string;
}

export function BlindSafeSwitch({ checked, onChange, disabled, disabledReason, id }: Props) {
  return (
    <div className="flex items-center justify-between gap-2" title={disabledReason}>
      <label htmlFor={id} className={cn("flex items-center gap-1.5 text-[11px] cursor-pointer", disabled && "cursor-not-allowed opacity-60")}>
        {checked ? <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
        <span className={checked ? "text-foreground" : "text-muted-foreground"}>
          {disabledReason ? "Never in the blind CIM" : "Safe to show in the blind CIM"}
        </span>
      </label>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled || !onChange}
        onCheckedChange={(v) => onChange?.(v)}
        className="scale-75 origin-right"
        aria-label="Safe to show in the blind CIM"
      />
    </div>
  );
}
