import { motion } from "framer-motion";
import { useEffect, useState, useCallback } from "react";
import { AlertTriangle, ArrowDown, CheckCircle2, Sparkles } from "lucide-react";

interface Screen3Props {
  onReady: () => void;
}

const BAD_CHAIN = [
  "Seller gives one-word answers",
  "Thin, generic CIM",
  "Buyers don't understand the business",
  "More questions for you to answer",
  "Longer due diligence",
  "Weaker offers",
  "Deal takes months longer",
  "Higher chance the deal falls through",
];

const GOOD_CHAIN = [
  "Seller shares depth and detail",
  "Rich, compelling CIM",
  "Buyers already understand the business",
  "Better buyer vetting by your broker",
  "More qualified, serious buyers",
  "Less questions, shorter due diligence",
  "Stronger offers",
  "Faster close",
];

export function Screen3Comparison({ onReady }: Screen3Props) {
  const [badVisible, setBadVisible] = useState(0);
  const [goodVisible, setGoodVisible] = useState(0);
  const [showGlow, setShowGlow] = useState(false);

  // Animate bad chain first
  useEffect(() => {
    const interval = setInterval(() => {
      setBadVisible((prev) => {
        if (prev >= BAD_CHAIN.length) {
          clearInterval(interval);
          return prev;
        }
        return prev + 1;
      });
    }, 350);
    return () => clearInterval(interval);
  }, []);

  // Then good chain after bad finishes + pause
  useEffect(() => {
    if (badVisible >= BAD_CHAIN.length) {
      const t = setTimeout(() => {
        const interval = setInterval(() => {
          setGoodVisible((prev) => {
            if (prev >= GOOD_CHAIN.length) {
              clearInterval(interval);
              return prev;
            }
            return prev + 1;
          });
        }, 350);
        return () => clearInterval(interval);
      }, 300);
      return () => clearTimeout(t);
    }
  }, [badVisible]);

  // Glow + ready after good chain done
  useEffect(() => {
    if (goodVisible >= GOOD_CHAIN.length) {
      const t1 = setTimeout(() => setShowGlow(true), 200);
      const t2 = setTimeout(() => onReady(), 500);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
  }, [goodVisible, onReady]);

  return (
    <div className="flex flex-col h-full px-4 sm:px-6 max-w-4xl mx-auto justify-center">
      <motion.h2
        className="text-2xl sm:text-3xl font-bold tracking-tight text-center mb-6 sm:mb-8"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        The difference your answers make
      </motion.h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        {/* Bad side */}
        <motion.div
          className="rounded-xl border border-border bg-card/50 p-4 sm:p-5"
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3 }}
        >
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle className="h-4 w-4 text-destructive/70" />
            <h3 className="text-sm font-semibold text-destructive/80 uppercase tracking-wide">
              Vague Answers
            </h3>
          </div>
          <div className="space-y-0">
            {BAD_CHAIN.map((item, i) => (
              <div key={i}>
                <motion.div
                  className="flex items-start gap-2 py-1.5"
                  initial={{ opacity: 0, y: 8 }}
                  animate={i < badVisible ? { opacity: 1, y: 0 } : {}}
                  transition={{ duration: 0.25, ease: "easeOut" }}
                >
                  <div className="h-1.5 w-1.5 rounded-full bg-destructive/40 mt-1.5 shrink-0" />
                  <span className="text-sm text-muted-foreground/80">{item}</span>
                </motion.div>
                {i < BAD_CHAIN.length - 1 && i < badVisible - 1 && (
                  <motion.div
                    className="flex justify-center py-0.5"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 0.3 }}
                    transition={{ duration: 0.2 }}
                  >
                    <ArrowDown className="h-3 w-3 text-destructive/30" />
                  </motion.div>
                )}
              </div>
            ))}
          </div>
        </motion.div>

        {/* Good side */}
        <motion.div
          className={`rounded-xl border p-4 sm:p-5 transition-all duration-500 ${
            showGlow
              ? "border-teal/40 bg-teal/5 shadow-lg shadow-teal/5"
              : "border-border bg-card/50"
          }`}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3 }}
        >
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="h-4 w-4 text-teal" />
            <h3 className="text-sm font-semibold text-teal uppercase tracking-wide">
              Detailed Answers
            </h3>
          </div>
          <div className="space-y-0">
            {GOOD_CHAIN.map((item, i) => (
              <div key={i}>
                <motion.div
                  className="flex items-start gap-2 py-1.5"
                  initial={{ opacity: 0, y: -6, scale: 0.97 }}
                  animate={
                    i < goodVisible
                      ? { opacity: 1, y: 0, scale: 1 }
                      : {}
                  }
                  transition={{ duration: 0.25, ease: "easeOut" }}
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-teal/70 mt-0.5 shrink-0" />
                  <span className="text-sm text-foreground/90">{item}</span>
                </motion.div>
                {i < GOOD_CHAIN.length - 1 && i < goodVisible - 1 && (
                  <motion.div
                    className="flex justify-center py-0.5"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 0.4 }}
                    transition={{ duration: 0.2 }}
                  >
                    <ArrowDown className="h-3 w-3 text-teal/40" />
                  </motion.div>
                )}
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
