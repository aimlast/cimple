/**
 * The Analytics page's empty states (shown instead of the numbers and tabs),
 * each saying what to do next with one button:
 *   no_deals          "No deals yet"                          → Start a deal
 *   no_buyers         "Nothing to show yet"                   → Go to your deals
 *   only_examples     "Only your example deals have buyers"   → Include example deals
 * Visual: the paper-with-brass-bands illustration, centred, dashed border.
 */
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export type AnalyticsEmptyKind = "no_deals" | "no_buyers" | "only_examples";

export const ANALYTICS_EMPTY_COPY: Record<AnalyticsEmptyKind, { title: string; body: string; button: string; href?: string }> = {
  no_deals: {
    title: "No deals yet",
    body: "Start a deal and share its CIM. This page fills in as buyers read.",
    button: "Start a deal",
    href: "/broker/new-deal",
  },
  no_buyers: {
    title: "Nothing to show yet",
    body: "Analytics fills in once buyers have your CIMs. Give a buyer access from a deal's Buyers tab, and you'll see who reads what, who to call first and what holds their attention.",
    button: "Go to your deals",
    href: "/broker/deals",
  },
  only_examples: {
    title: "Only your example deals have buyers",
    body: "Your example deals are the made-up showcase deals. Include them to see how this page works, or give buyers access to one of your own deals.",
    button: "Include example deals",
  },
};

/** Which empty state applies, if any (from the overview's counts). */
export function analyticsEmptyKind(o: { counts: { deals: number; dealsWithBuyers: number }; examples: { included: boolean; count: number } }): AnalyticsEmptyKind | null {
  if (o.counts.deals === 0) return "no_deals";
  if (o.counts.dealsWithBuyers > 0) return null;
  if (!o.examples.included && o.examples.count > 0) return "only_examples";
  return "no_buyers";
}

export function PaperIllustration() {
  return (
    <svg width="88" height="72" viewBox="0 0 88 72" aria-hidden="true" className="mb-4">
      <rect x="18" y="4" width="52" height="64" rx="4" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
      <rect x="26" y="14" width="30" height="4" rx="2" fill="hsl(var(--muted-foreground) / 0.35)" />
      <rect x="26" y="24" width="36" height="10" rx="2" fill="hsl(var(--teal) / 0.55)" />
      <rect x="26" y="38" width="36" height="3" rx="1.5" fill="hsl(var(--muted-foreground) / 0.25)" />
      <rect x="26" y="45" width="28" height="3" rx="1.5" fill="hsl(var(--muted-foreground) / 0.25)" />
      <rect x="26" y="52" width="36" height="8" rx="2" fill="hsl(var(--teal) / 0.25)" />
    </svg>
  );
}

export function AnalyticsEmpty({ kind, onIncludeExamples }: { kind: AnalyticsEmptyKind; onIncludeExamples?(): void }) {
  const c = ANALYTICS_EMPTY_COPY[kind];
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-14 text-center" data-testid={`analytics-empty-${kind}`}>
      <PaperIllustration />
      <p className="text-base font-medium text-foreground">{c.title}</p>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{c.body}</p>
      {c.href ? (
        <Button asChild size="sm" className="mt-5">
          <Link href={c.href}>{c.button}</Link>
        </Button>
      ) : (
        <Button size="sm" className="mt-5" onClick={onIncludeExamples}>{c.button}</Button>
      )}
    </div>
  );
}

/** A tab's own empty state: a title, a line, and at most one action. */
export function TabEmpty({ title, body, action, testId }: { title: string; body?: React.ReactNode; action?: React.ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-10 text-center" data-testid={testId}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {body && <div className="mt-1 max-w-md text-sm text-muted-foreground">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
