/**
 * SellerOnboarding — 5-screen animated intro that educates sellers
 * on what a CIM is and how the Business Overview conversation works.
 *
 * Mandatory on first visit. Seller can replay from progress page.
 * "Next" button only appears after each screen's animations complete.
 */
import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Screen1Heart } from "./onboarding/Screen1Heart";
import { Screen2Knowledge } from "./onboarding/Screen2Knowledge";
import { Screen3Comparison } from "./onboarding/Screen3Comparison";
import { Screen4Tutorial } from "./onboarding/Screen4Tutorial";
import { Screen5Ready } from "./onboarding/Screen5Ready";
import { OnboardingProgress } from "./onboarding/OnboardingProgress";

const TOTAL_SCREENS = 5;

interface SellerOnboardingProps {
  token: string;
  onComplete: () => void;
}

export function SellerOnboarding({ token, onComplete }: SellerOnboardingProps) {
  const [screen, setScreen] = useState(0);
  const [ready, setReady] = useState(false);

  const handleReady = useCallback(() => setReady(true), []);

  const advance = () => {
    if (screen < TOTAL_SCREENS - 1) {
      setReady(false);
      setScreen((s) => s + 1);
    }
  };

  const handleStart = async () => {
    // Mark onboarding complete in the database
    try {
      await fetch(`/api/seller/${token}/onboarding-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      // Non-blocking — proceed even if the flag fails to save
    }
    onComplete();
  };

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Logo */}
      <div className="absolute top-4 left-5 z-10">
        <div
          role="img"
          aria-label="Cimple"
          className="h-4 w-16"
          style={{
            backgroundColor: "hsl(162, 65%, 38%)",
            WebkitMaskImage: "url('/cimple-text.png')",
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            maskImage: "url('/cimple-text.png')",
            maskSize: "contain",
            maskRepeat: "no-repeat",
          }}
        />
      </div>

      {/* Screen content */}
      <div className="flex-1 overflow-hidden relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={screen}
            className="absolute inset-0"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
          >
            {screen === 0 && <Screen1Heart onReady={handleReady} />}
            {screen === 1 && <Screen2Knowledge onReady={handleReady} />}
            {screen === 2 && <Screen3Comparison onReady={handleReady} />}
            {screen === 3 && <Screen4Tutorial onReady={handleReady} />}
            {screen === 4 && (
              <Screen5Ready onStart={handleStart} onReady={handleReady} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Bottom bar: progress dots + Next button */}
      <div className="px-6 py-5 flex items-center justify-between shrink-0">
        <OnboardingProgress current={screen} total={TOTAL_SCREENS} />

        {/* Next button — only on screens 1-4, hidden on screen 5 (has its own CTA) */}
        {screen < TOTAL_SCREENS - 1 ? (
          <motion.button
            className="px-5 py-2 rounded-lg bg-teal text-teal-foreground text-sm font-medium hover:bg-teal/90 transition-colors disabled:opacity-0 disabled:pointer-events-none"
            disabled={!ready}
            onClick={advance}
            initial={{ opacity: 0 }}
            animate={{ opacity: ready ? 1 : 0 }}
            transition={{ duration: 0.3 }}
          >
            Next
          </motion.button>
        ) : (
          <div />
        )}
      </div>
    </div>
  );
}
