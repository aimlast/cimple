import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";

interface Screen5Props {
  onStart: () => void;
  onReady: () => void;
}

export function Screen5Ready({ onStart, onReady }: Screen5Props) {
  useEffect(() => {
    const t = setTimeout(() => onReady(), 800);
    return () => clearTimeout(t);
  }, [onReady]);

  return (
    <div className="flex flex-col items-center justify-center h-full px-6 max-w-xl mx-auto text-center">
      <motion.h2
        className="text-3xl sm:text-4xl font-bold tracking-tight"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        Ready to tell your business's story?
      </motion.h2>

      <motion.p
        className="mt-4 text-lg text-muted-foreground leading-relaxed"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.2 }}
      >
        The more you share, the better your CIM — and the better your outcome.
      </motion.p>

      <motion.button
        className="mt-10 px-8 py-3.5 rounded-xl bg-teal text-teal-foreground font-semibold text-base flex items-center gap-2 hover:bg-teal/90 transition-colors"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        onClick={onStart}
      >
        Start Your Business Overview
        <ArrowRight className="h-5 w-5" />
      </motion.button>
    </div>
  );
}
