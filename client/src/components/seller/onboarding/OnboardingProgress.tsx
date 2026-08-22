interface OnboardingProgressProps {
  current: number;
  total: number;
}

/**
 * Progress dots. Plain CSS transitions (no layout animation) so the
 * indicator changes in the same frame as the screen it describes.
 */
export function OnboardingProgress({ current, total }: OnboardingProgressProps) {
  return (
    <div className="flex items-center gap-2" aria-label={`Step ${current + 1} of ${total}`}>
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all duration-200 ${
            i === current ? "bg-teal w-6" : i < current ? "bg-teal/40 w-1.5" : "bg-border w-1.5"
          }`}
        />
      ))}
    </div>
  );
}
