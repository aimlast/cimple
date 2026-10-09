/**
 * Who is who in the conversation: one chip per voice ("Speaker 1 · You",
 * "Speaker 2 · Seller"). Clicking one: "This is me / This is the seller /
 * Someone else" — the broker's choice always wins. Until both roles are
 * known, answers are only ever possible answers (nothing is filed from an
 * unknown voice), and the panel asks "Which speaker is you? Tap it."
 */
import { useState } from "react";
import { Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import type { SpeakerMap, SpeakerRole, TogetherLineView } from "@shared/together";
import { rolesKnown, speakerDisplay, speakerKind } from "@shared/together-speakers";

const ROLE_WORD: Record<SpeakerRole, string> = { broker: "You", seller: "Seller", other: "Someone else", unknown: "Who?" };

export function presentSpeakers(lines: TogetherLineView[]): string[] {
  const out: string[] = [];
  for (const l of lines) if (!out.includes(l.speaker) && speakerKind(l.speaker) !== "typed") out.push(l.speaker);
  return out;
}

export function SpeakerChips({
  speakers,
  lines,
  onSet,
  compact,
}: {
  speakers: SpeakerMap;
  lines: TogetherLineView[];
  onSet: (speaker: string, role: Exclude<SpeakerRole, "unknown">) => Promise<void>;
  compact?: boolean;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const present = presentSpeakers(lines);
  if (present.length === 0) return null;
  const known = rolesKnown(speakers, present);
  const basicOnly = present.every((id) => speakerKind(id) === "room");
  const set = async (id: string, role: Exclude<SpeakerRole, "unknown">) => {
    setBusy(id);
    try {
      await onSet(id, role);
    } catch (e) {
      toast({ title: "Couldn't save that", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-1.5" data-testid="speaker-chips">
      <div className="flex flex-wrap gap-1.5">
        {present.map((id) => {
          const info = speakers[id];
          const role: SpeakerRole = info?.role ?? "unknown";
          const name = speakerDisplay(id, info, present);
          const tone = role === "seller" ? "border-teal/50 text-foreground" : role === "broker" ? "border-border text-muted-foreground" : "border-dashed tg-warn-border text-foreground";
          return (
            <DropdownMenu key={id}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={busy === id || speakerKind(id) === "room"}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 ${compact ? "py-0.5 text-[11px]" : "py-1 text-xs"} ${tone} hover:bg-accent disabled:opacity-70`}
                  data-testid={`speaker-chip-${id}`}
                >
                  <span className="truncate max-w-[9rem]">{name}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className={role === "unknown" ? "tg-warn-text" : ""}>{ROLE_WORD[role]}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">{name}</DropdownMenuLabel>
                {(["broker", "seller", "other"] as const).map((r) => (
                  <DropdownMenuItem key={r} onSelect={() => void set(id, r)}>
                    {role === r ? <Check className="h-3.5 w-3.5 mr-2" /> : <span className="w-3.5 mr-2" />}
                    {r === "broker" ? "This is me" : r === "seller" ? "This is the seller" : "Someone else"}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })}
      </div>
      {!known && !basicOnly && <p className="text-[11px] tg-warn-text" data-testid="speaker-prompt">Which speaker is you? Tap it.</p>}
    </div>
  );
}
