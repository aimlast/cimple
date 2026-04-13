import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { MessageSquare, SkipForward, RefreshCw } from "lucide-react";

interface Screen4Props {
  onReady: () => void;
}

const TIPS = [
  {
    icon: MessageSquare,
    title: "Just talk about your business",
    description:
      "Answer like you're explaining your business to someone interested in buying it. There are no wrong answers — the more detail you share, the better.",
  },
  {
    icon: SkipForward,
    title: "Not sure about something? Skip it.",
    description:
      "You can skip any question and come back to it later. Your broker can also help fill in details.",
  },
  {
    icon: RefreshCw,
    title: "Come back anytime",
    description:
      "This isn't a one-time thing. You can return anytime to add details, correct something, or share new information. Your Business Overview grows with you.",
  },
];

export function Screen4Tutorial({ onReady }: Screen4Props) {
  const [visible, setVisible] = useState(0);

  useEffect(() => {
    // Stagger tips in — start after headline lands (0.5s)
    const timers = TIPS.map((_, i) =>
      setTimeout(() => setVisible((prev) => prev + 1), 500 + i * 500),
    );
    // Fire ready after all tips are visible
    const readyTimer = setTimeout(() => onReady(), 500 + TIPS.length * 500 + 300);
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(readyTimer);
    };
  }, [onReady]);

  return (
    <div className="flex flex-col items-center justify-center h-full px-6 max-w-2xl mx-auto">
      <motion.h2
        className="text-2xl sm:text-3xl font-bold tracking-tight text-center mb-10"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        How your Business Overview works
      </motion.h2>

      <div className="space-y-6 w-full">
        {TIPS.map((tip, i) => (
          <motion.div
            key={i}
            className="flex items-start gap-4"
            initial={{ opacity: 0, x: -24 }}
            animate={i < visible ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="h-10 w-10 rounded-xl bg-teal/10 flex items-center justify-center shrink-0">
              <tip.icon className="h-5 w-5 text-teal" />
            </div>
            <div>
              <h3 className="font-semibold text-sm mb-1">{tip.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {tip.description}
              </p>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
