/**
 * The title line of an Overview checklist step: the label (struck through
 * once done), who the step is waiting on, and "optional".
 *
 * Rule: a finished step isn't waiting on anyone — the "who" badge ("You",
 * "Waiting on seller", "Automatic") only shows while the step is open. A
 * struck-through "Seller onboarding" that still said "Waiting on seller"
 * was the bug this component's test pins down (tests/unit/overview-onboarding-badge.test.ts).
 */
export type StepActor = "broker" | "seller" | "auto";

/** "Who does this" badge shown next to each open checklist item. */
export function ActorBadge({ who }: { who: StepActor }) {
  const map = {
    broker: { label: "You", cls: "bg-teal/10 text-teal" },
    seller: { label: "Waiting on seller", cls: "bg-amber-500/10 text-amber-600" },
    auto: { label: "Automatic", cls: "bg-muted text-muted-foreground" },
  } as const;
  const m = map[who];
  return (
    <span className={`text-2xs font-medium px-1.5 py-0.5 rounded ${m.cls} shrink-0`} data-testid={`actor-badge-${who}`}>
      {m.label}
    </span>
  );
}

export function ChecklistStepTitle({
  label,
  done,
  who,
  optional,
}: {
  label: string;
  done: boolean;
  who: StepActor;
  optional?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <p className={`text-sm font-medium ${done ? "line-through text-muted-foreground" : ""}`}>{label}</p>
      {!done && <ActorBadge who={who} />}
      {optional && !done && <span className="text-2xs text-muted-foreground/60">optional</span>}
    </div>
  );
}
