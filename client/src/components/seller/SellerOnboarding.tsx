/**
 * SellerOnboarding — 5-screen animated intro that educates sellers
 * on what a CIM is and how the Business Overview conversation works.
 *
 * Shown on first visit; the seller can replay it from the progress page.
 * The seller is never gated by the animations: "Next" is always available
 * (it brightens once a screen's animation settles), "Skip" / Escape close
 * the intro from any screen, and →/Enter advance.
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
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
  /** True when replayed from the progress page — closing is just closing */
  replay?: boolean;
}

export function SellerOnboarding({ token, onComplete, replay = false }: SellerOnboardingProps) {
  const [screen, setScreen] = useState(0);
  const [ready, setReady] = useState(false);
  const finishingRef = useRef(false);

  const handleReady = useCallback(() => setReady(true), []);

  const isLast = screen >= TOTAL_SCREENS - 1;

  // Content and progress dots change in the same state update, so they
  // can never drift apart.
  const advance = useCallback(() => {
    setReady(false);
    setScreen((s) => Math.min(s + 1, TOTAL_SCREENS - 1));
  }, []);

  // Start / Skip / Close / Escape all end here. A skipped first-run intro
  // still counts as seen — re-showing it on every visit would be worse.
  const finish = useCallback(async () => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    if (!replay) {
      try {
        await fetch(`/api/seller/${token}/onboarding-complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        // Non-blocking — proceed even if the flag fails to save
      }
    }
    onComplete();
  }, [replay, token, onComplete]);

  // Keyboard: Escape closes, → / Enter advance (Enter is left alone on the
  // last screen so its own Start button keeps native behaviour).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void finish();
      } else if ((e.key === "ArrowRight" || e.key === "Enter") && !isLast) {
        e.preventDefault();
        advance();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish, advance, isLast]);

  return (
    <div
      className="fixed inset-0 z-50 bg-background flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Introduction"
      data-testid="seller-onboarding"
    >
      {/* Logo */}
      <div className="absolute top-4 left-5 z-10">
        <div
          role="img"
          aria-label="Cimple"
          className="h-4 w-16"
          style={{
            backgroundColor: "hsl(42, 26%, 92%)",
            WebkitMaskImage: "url('/cimple-text.png')",
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            maskImage: "url('/cimple-text.png')",
            maskSize: "contain",
            maskRepeat: "no-repeat",
          }}
        />
      </div>

      {/* Skip / Close — available on every screen */}
      <button
        type="button"
        onClick={() => void finish()}
        className="absolute top-3 right-4 z-10 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        aria-label={replay ? "Close introduction" : "Skip introduction"}
        data-testid="button-skip-onboarding"
      >
        {replay ? "Close" : "Skip intro"}
        <X className="h-3.5 w-3.5" />
      </button>

      {/* Screen content */}
      <div className="flex-1 overflow-hidden relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={screen}
            className="absolute inset-0"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
          >
            {screen === 0 && <Screen1Heart onReady={handleReady} />}
            {screen === 1 && <Screen2Knowledge onReady={handleReady} />}
            {screen === 2 && <Screen3Comparison onReady={handleReady} />}
            {screen === 3 && <Screen4Tutorial onReady={handleReady} />}
            {screen === 4 && (
              <Screen5Ready onStart={() => void finish()} onReady={handleReady} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Bottom bar: progress dots + Next button */}
      <div className="px-6 py-5 flex items-center justify-between shrink-0">
        <OnboardingProgress current={screen} total={TOTAL_SCREENS} />

        {/* Next — always clickable on screens 1-4; brightens once the
            screen's animation has settled. Screen 5 has its own CTA. */}
        {!isLast ? (
          <motion.button
            type="button"
            className="px-5 py-2 rounded-lg bg-teal text-teal-foreground text-sm font-medium hover:bg-teal/90 transition-colors"
            onClick={advance}
            initial={{ opacity: 0.55 }}
            animate={{ opacity: ready ? 1 : 0.55 }}
            transition={{ duration: 0.25 }}
            data-testid="button-onboarding-next"
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
