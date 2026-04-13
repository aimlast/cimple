import { motion, useAnimation } from "framer-motion";
import { useEffect, useState } from "react";
import { FileText } from "lucide-react";

interface Screen1Props {
  onReady: () => void;
}

export function Screen1Heart({ onReady }: Screen1Props) {
  const [wordsVisible, setWordsVisible] = useState(0);
  const headline = "The CIM is the heart of the transaction";
  const words = headline.split(" ");

  useEffect(() => {
    // Type in headline word by word over ~0.8s
    const interval = setInterval(() => {
      setWordsVisible((prev) => {
        if (prev >= words.length) {
          clearInterval(interval);
          return prev;
        }
        return prev + 1;
      });
    }, 100);
    return () => clearInterval(interval);
  }, [words.length]);

  // Track animation completion
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (wordsVisible >= words.length && step === 0) {
      // Headline done → pause, then show supporting text
      const t = setTimeout(() => setStep(1), 400);
      return () => clearTimeout(t);
    }
    if (step === 1) {
      const t = setTimeout(() => setStep(2), 600);
      return () => clearTimeout(t);
    }
    if (step === 2) {
      const t = setTimeout(() => setStep(3), 500);
      return () => clearTimeout(t);
    }
    if (step === 3) {
      const t = setTimeout(() => onReady(), 300);
      return () => clearTimeout(t);
    }
  }, [wordsVisible, step, words.length, onReady]);

  return (
    <div className="flex flex-col items-center justify-center h-full px-6 max-w-2xl mx-auto text-center">
      {/* Headline — word by word */}
      <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight leading-tight">
        {words.map((word, i) => (
          <motion.span
            key={i}
            className="inline-block mr-[0.3em]"
            initial={{ opacity: 0, y: 8 }}
            animate={i < wordsVisible ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {word}
          </motion.span>
        ))}
      </h1>

      {/* Supporting text */}
      <motion.p
        className="mt-6 text-lg text-muted-foreground leading-relaxed max-w-lg"
        initial={{ opacity: 0, y: 16 }}
        animate={step >= 1 ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6, ease: "easeOut" }}
      >
        It's the document that powers the sale of your business. It's what buyers
        read to decide whether your company is worth pursuing.
      </motion.p>

      {/* Document visual */}
      <motion.div
        className="mt-10"
        initial={{ opacity: 0, scale: 0.85 }}
        animate={step >= 2 ? { opacity: 1, scale: 1 } : {}}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="relative w-28 h-36 sm:w-32 sm:h-40 rounded-lg border-2 border-teal/30 bg-gradient-to-b from-card to-card/80 shadow-xl shadow-teal/5 flex flex-col items-center justify-center gap-3">
          <FileText className="h-10 w-10 text-teal/60" />
          <div className="space-y-1.5 w-16">
            <div className="h-1 bg-teal/20 rounded-full" />
            <div className="h-1 bg-teal/15 rounded-full w-3/4" />
            <div className="h-1 bg-teal/10 rounded-full w-1/2" />
          </div>
          <div className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-teal flex items-center justify-center">
            <span className="text-[10px] font-bold text-teal-foreground">CIM</span>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
