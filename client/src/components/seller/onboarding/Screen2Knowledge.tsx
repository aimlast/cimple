import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { User, FileText } from "lucide-react";

interface Screen2Props {
  onReady: () => void;
}

const FRAGMENTS = [
  "Founded in 2008",
  "15 employees",
  "$2M revenue",
  "3 key clients",
  "Unique process",
  "5-year lease",
  "Loyal team",
  "Growing market",
];

// Gentle curve paths for each fragment
const PATHS = FRAGMENTS.map((_, i) => ({
  yOffset: (i - FRAGMENTS.length / 2) * 28,
  delay: i * 0.35,
  curve: i % 2 === 0 ? -20 : 20,
}));

export function Screen2Knowledge({ onReady }: Screen2Props) {
  const [step, setStep] = useState(0);
  const [landed, setLanded] = useState(0);

  useEffect(() => {
    // Step 0: person + document appear (0.6s)
    const t1 = setTimeout(() => setStep(1), 600);
    return () => clearTimeout(t1);
  }, []);

  useEffect(() => {
    if (step === 1) {
      // Fragments start flying — track landing
      const timers = FRAGMENTS.map((_, i) =>
        setTimeout(() => {
          setLanded((prev) => prev + 1);
        }, PATHS[i].delay * 1000 + 1200), // flight time ~1.2s each
      );
      return () => timers.forEach(clearTimeout);
    }
  }, [step]);

  useEffect(() => {
    if (landed >= FRAGMENTS.length && step === 1) {
      // All landed → show supporting text
      const t = setTimeout(() => setStep(2), 400);
      return () => clearTimeout(t);
    }
    if (step === 2) {
      const t = setTimeout(() => onReady(), 500);
      return () => clearTimeout(t);
    }
  }, [landed, step, onReady]);

  const docFill = Math.min(landed / FRAGMENTS.length, 1);

  return (
    <div className="flex flex-col items-center justify-center h-full px-6 max-w-3xl mx-auto">
      <motion.h2
        className="text-2xl sm:text-3xl font-bold tracking-tight text-center mb-8 sm:mb-12"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        Your knowledge builds it
      </motion.h2>

      <div className="relative w-full flex items-center justify-center h-[280px] sm:h-[320px]">
        {/* Person silhouette */}
        <motion.div
          className="absolute left-4 sm:left-12 flex flex-col items-center"
          initial={{ opacity: 0, x: -20 }}
          animate={step >= 0 ? { opacity: 1, x: 0 } : {}}
          transition={{ duration: 0.3 }}
        >
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-teal/10 flex items-center justify-center">
            <User className="h-8 w-8 sm:h-10 sm:w-10 text-teal/60" />
          </div>
          <span className="text-xs text-muted-foreground mt-2">You</span>
        </motion.div>

        {/* Document target */}
        <motion.div
          className="absolute right-4 sm:right-12 flex flex-col items-center"
          initial={{ opacity: 0, x: 20 }}
          animate={step >= 0 ? { opacity: 1, x: 0 } : {}}
          transition={{ duration: 0.3, delay: 0.15 }}
        >
          <div className="relative w-20 h-28 sm:w-24 sm:h-32 rounded-lg border-2 border-teal/30 bg-card overflow-hidden">
            {/* Fill bar that grows as fragments land */}
            <motion.div
              className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-teal/15 to-teal/5"
              animate={{ height: `${docFill * 100}%` }}
              transition={{ duration: 0.3 }}
            />
            <div className="relative z-10 h-full flex flex-col items-center justify-center gap-2">
              <FileText className="h-6 w-6 sm:h-8 sm:w-8 text-teal/40" />
              <div className="space-y-1 w-12 sm:w-14">
                {[0.2, 0.15, 0.1, 0.08, 0.12].map((opacity, i) => (
                  <motion.div
                    key={i}
                    className="h-0.5 bg-teal rounded-full"
                    style={{ width: `${70 + Math.random() * 30}%` }}
                    animate={{ opacity: docFill > i / 5 ? 0.4 : opacity }}
                    transition={{ duration: 0.3 }}
                  />
                ))}
              </div>
            </div>
          </div>
          <span className="text-xs text-muted-foreground mt-2">CIM</span>
        </motion.div>

        {/* Flying fragments */}
        {step >= 1 &&
          FRAGMENTS.map((text, i) => (
            <motion.div
              key={i}
              className="absolute left-20 sm:left-32 pointer-events-none"
              style={{ top: `calc(50% + ${PATHS[i].yOffset}px)` }}
              initial={{ opacity: 0, x: 0 }}
              animate={{
                opacity: [0, 1, 1, 0],
                x: [0, 80, 140, 180],
                y: [0, PATHS[i].curve, PATHS[i].curve * 0.5, 0],
              }}
              transition={{
                duration: 1.2,
                delay: PATHS[i].delay,
                ease: "easeInOut",
                times: [0, 0.2, 0.7, 1],
              }}
            >
              <span className="text-[10px] sm:text-xs font-medium px-2 py-0.5 rounded-full bg-teal/10 text-teal whitespace-nowrap border border-teal/20">
                {text}
              </span>
            </motion.div>
          ))}
      </div>

      {/* Supporting text */}
      <motion.p
        className="text-center text-muted-foreground mt-6 max-w-md leading-relaxed"
        initial={{ opacity: 0, y: 12 }}
        animate={step >= 2 ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.5 }}
      >
        Everything you share becomes the professional package that represents
        your business to buyers.
      </motion.p>
    </div>
  );
}
