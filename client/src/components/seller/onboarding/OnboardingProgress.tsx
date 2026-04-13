import { motion } from "framer-motion";

interface OnboardingProgressProps {
  current: number;
  total: number;
}

export function OnboardingProgress({ current, total }: OnboardingProgressProps) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <motion.div
          key={i}
          className={`h-1.5 rounded-full transition-colors duration-300 ${
            i === current ? "bg-teal w-6" : i < current ? "bg-teal/40 w-1.5" : "bg-border w-1.5"
          }`}
          layout
        />
      ))}
    </div>
  );
}
