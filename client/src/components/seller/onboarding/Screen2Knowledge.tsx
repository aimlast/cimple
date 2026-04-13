import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { User, FileText, Check } from "lucide-react";

interface Screen2Props {
  onReady: () => void;
}

const PULSE_COUNT = 3;
const PULSE_DURATION = 1.6;
const PULSE_INTERVAL = 0.9; // seconds between each pulse start

// Pipe path in a 200x80 viewBox — straight line
const PIPE_PATH = "M 0,40 L 200,40";

export function Screen2Knowledge({ onReady }: Screen2Props) {
  const [step, setStep] = useState(0);
  const [pulsesLanded, setPulsesLanded] = useState(0);
  const [cimVisualsCount, setCimVisualsCount] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setStep(1), 600);
    return () => clearTimeout(t);
  }, []);

  // Track when each pulse reaches the CIM (for fill bar sync)
  useEffect(() => {
    if (step === 1) {
      const timers = Array.from({ length: PULSE_COUNT }, (_, i) =>
        setTimeout(
          () => setPulsesLanded((p) => p + 1),
          (i * PULSE_INTERVAL + PULSE_DURATION) * 1000,
        ),
      );
      // All done → advance
      const done = setTimeout(
        () => setStep(2),
        ((PULSE_COUNT - 1) * PULSE_INTERVAL + PULSE_DURATION) * 1000 + 400,
      );
      return () => {
        timers.forEach(clearTimeout);
        clearTimeout(done);
      };
    }
  }, [step]);

  const CIM_VISUAL_COUNT = 5;
  useEffect(() => {
    if (step === 2) {
      const timers = Array.from({ length: CIM_VISUAL_COUNT }, (_, i) =>
        setTimeout(() => setCimVisualsCount((p) => p + 1), i * 300 + 200),
      );
      return () => timers.forEach(clearTimeout);
    }
  }, [step]);

  // All visuals shown → pause, then collapse into CIM + sparkles
  useEffect(() => {
    if (cimVisualsCount >= CIM_VISUAL_COUNT && step === 2) {
      const t = setTimeout(() => setStep(3), 800);
      return () => clearTimeout(t);
    }
  }, [cimVisualsCount, step]);

  // Step 3: visuals collapse in, sparkles appear → then ready
  useEffect(() => {
    if (step === 3) {
      const t = setTimeout(() => setStep(4), 1200);
      return () => clearTimeout(t);
    }
    if (step === 4) {
      const t = setTimeout(() => onReady(), 500);
      return () => clearTimeout(t);
    }
  }, [step, onReady]);

  const docFill = Math.min(pulsesLanded / PULSE_COUNT, 1);

  // Force remount of SVG on step 1 to reset SMIL animation timelines
  const [svgKey, setSvgKey] = useState(0);
  useEffect(() => {
    if (step === 1) setSvgKey((k) => k + 1);
  }, [step]);

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

      {/* Main row: You → pipe → CIM */}
      <div className="flex items-center w-full max-w-lg gap-0">
        {/* Person */}
        <motion.div
          className="flex flex-col items-center shrink-0 z-10"
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3 }}
        >
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-teal/10 flex items-center justify-center">
            <User className="h-8 w-8 sm:h-10 sm:w-10 text-teal/60" />
          </div>
          <span className="text-xs text-muted-foreground mt-2">You</span>
        </motion.div>

        {/* Pipe — flush between You and CIM */}
        <div className="flex-1 h-20 relative">
          {step >= 1 && (
            <motion.div
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
            >
              <svg
                key={svgKey}
                viewBox="0 0 200 80"
                className="w-full h-full"
                preserveAspectRatio="none"
                fill="none"
              >
                {/* Pipe outer */}
                <path
                  d={PIPE_PATH}
                  stroke="hsl(162,65%,38%)"
                  strokeWidth="6"
                  strokeLinecap="round"
                  opacity="0.15"
                />
                {/* Pipe inner */}
                <path
                  d={PIPE_PATH}
                  stroke="hsl(162,65%,38%)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  opacity="0.25"
                />
                {/* 4 pulses, all rendered at mount, staggered begin */}
                {Array.from({ length: PULSE_COUNT }, (_, i) => (
                  <circle key={i} r="3" fill="hsl(162,65%,38%)" opacity="0">
                    <animateMotion
                      dur={`${PULSE_DURATION}s`}
                      begin={`${i * PULSE_INTERVAL}s`}
                      fill="freeze"
                      path={PIPE_PATH}
                      keyPoints="0;1"
                      keyTimes="0;1"
                      calcMode="spline"
                      keySplines="0.4 0 0.2 1"
                    />
                    <animate
                      attributeName="r"
                      values="3;7;5;8;4;6;3"
                      dur={`${PULSE_DURATION}s`}
                      begin={`${i * PULSE_INTERVAL}s`}
                      fill="freeze"
                    />
                    <animate
                      attributeName="opacity"
                      values="0;0.6;0.5;0.55;0.5;0.4;0"
                      dur={`${PULSE_DURATION}s`}
                      begin={`${i * PULSE_INTERVAL}s`}
                      fill="freeze"
                    />
                  </circle>
                ))}
              </svg>
            </motion.div>
          )}
        </div>

        {/* CIM document */}
        <motion.div
          className="flex flex-col items-center shrink-0 z-10"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3, delay: 0.15 }}
        >
          <div className="relative">
            <div className="relative w-20 h-28 sm:w-24 sm:h-32 rounded-lg border-2 border-teal/30 bg-gradient-to-b from-card to-card/80 shadow-xl shadow-teal/5 overflow-hidden">
              <motion.div
                className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-teal/30 to-teal/10"
                initial={{ height: "0%" }}
                animate={{ height: `${docFill * 100}%` }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              />
              <div className="relative z-10 h-full flex flex-col items-center justify-center gap-2">
                {step >= 4 ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ type: "spring", stiffness: 300, damping: 20 }}
                    className="h-10 w-10 sm:h-12 sm:w-12 rounded-full bg-teal/15 flex items-center justify-center"
                  >
                    <Check className="h-6 w-6 sm:h-7 sm:w-7 text-teal" />
                  </motion.div>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            </div>

            {/* Pop-out visuals — fly back into CIM center at step 3 */}
            {step >= 2 && step < 4 && (
              <>
                {/* Bar chart — top right → collapses LEFT and DOWN into CIM */}
                <motion.div
                  className="absolute -top-6 -right-8 sm:-right-10"
                  animate={step >= 3
                    ? { opacity: 0, scale: 0.2, x: -15, y: 25 }
                    : cimVisualsCount >= 1
                      ? { opacity: 1, scale: 1, x: 0, y: 0 }
                      : { opacity: 0, scale: 0, y: 10 }}
                  transition={step >= 3
                    ? { duration: 0.4, delay: 0 }
                    : { type: "spring", stiffness: 400, damping: 20 }}
                >
                  <div className="bg-card border border-teal/25 rounded p-1.5 shadow-sm flex items-end gap-0.5 h-7 w-10">
                    <div className="w-1.5 bg-teal/40 rounded-sm" style={{ height: "40%" }} />
                    <div className="w-1.5 bg-teal/60 rounded-sm" style={{ height: "70%" }} />
                    <div className="w-1.5 bg-teal rounded-sm" style={{ height: "100%" }} />
                    <div className="w-1.5 bg-teal/50 rounded-sm" style={{ height: "55%" }} />
                  </div>
                </motion.div>

                {/* Text lines — right → collapses LEFT into CIM */}
                <motion.div
                  className="absolute top-3 -right-12 sm:-right-14"
                  animate={step >= 3
                    ? { opacity: 0, scale: 0.2, x: -30, y: 10 }
                    : cimVisualsCount >= 2
                      ? { opacity: 1, scale: 1, x: 0 }
                      : { opacity: 0, scale: 0, x: -5 }}
                  transition={step >= 3
                    ? { duration: 0.4, delay: 0.08 }
                    : { type: "spring", stiffness: 400, damping: 20 }}
                >
                  <div className="bg-card border border-teal/25 rounded p-1.5 shadow-sm space-y-1 w-10">
                    <div className="h-[2px] bg-teal/50 rounded-full w-full" />
                    <div className="h-[2px] bg-teal/30 rounded-full w-3/4" />
                    <div className="h-[2px] bg-teal/40 rounded-full w-5/6" />
                  </div>
                </motion.div>

                {/* Pie chart — bottom right → collapses LEFT and UP */}
                <motion.div
                  className="absolute -bottom-4 -right-8 sm:-right-10"
                  animate={step >= 3
                    ? { opacity: 0, scale: 0.2, x: -15, y: -20 }
                    : cimVisualsCount >= 3
                      ? { opacity: 1, scale: 1, y: 0 }
                      : { opacity: 0, scale: 0, y: -5 }}
                  transition={step >= 3
                    ? { duration: 0.4, delay: 0.04 }
                    : { type: "spring", stiffness: 400, damping: 20 }}
                >
                  <div className="bg-card border border-teal/25 rounded-full p-1 shadow-sm">
                    <svg width="22" height="22" viewBox="0 0 22 22">
                      <circle cx="11" cy="11" r="9" fill="none" stroke="hsl(162,65%,38%)" strokeWidth="3" strokeDasharray="20 37" opacity="0.3" />
                      <circle cx="11" cy="11" r="9" fill="none" stroke="hsl(162,65%,38%)" strokeWidth="3" strokeDasharray="14 43" strokeDashoffset="-20" opacity="0.6" />
                      <circle cx="11" cy="11" r="9" fill="none" stroke="hsl(162,65%,38%)" strokeWidth="3" strokeDasharray="23 34" strokeDashoffset="-34" opacity="1" />
                    </svg>
                  </div>
                </motion.div>

                {/* Image — top left → collapses RIGHT and DOWN */}
                <motion.div
                  className="absolute -top-5 -left-7 sm:-left-9"
                  animate={step >= 3
                    ? { opacity: 0, scale: 0.2, x: 25, y: 22 }
                    : cimVisualsCount >= 4
                      ? { opacity: 1, scale: 1, y: 0 }
                      : { opacity: 0, scale: 0, y: 8 }}
                  transition={step >= 3
                    ? { duration: 0.4, delay: 0.06 }
                    : { type: "spring", stiffness: 400, damping: 20 }}
                >
                  <div className="bg-card border border-teal/25 rounded p-1 shadow-sm w-8 h-7 flex items-end">
                    <svg width="22" height="16" viewBox="0 0 22 16">
                      <rect width="22" height="16" rx="1" fill="hsl(162,65%,38%)" opacity="0.1" />
                      <polygon points="0,16 7,8 12,12 16,6 22,14 22,16" fill="hsl(162,65%,38%)" opacity="0.3" />
                      <circle cx="16" cy="5" r="2.5" fill="hsl(162,65%,38%)" opacity="0.4" />
                    </svg>
                  </div>
                </motion.div>

                {/* Line chart — bottom left → collapses RIGHT and UP */}
                <motion.div
                  className="absolute -bottom-3 -left-6 sm:-left-8"
                  animate={step >= 3
                    ? { opacity: 0, scale: 0.2, x: 20, y: -15 }
                    : cimVisualsCount >= 5
                      ? { opacity: 1, scale: 1, y: 0 }
                      : { opacity: 0, scale: 0, y: -5 }}
                  transition={step >= 3
                    ? { duration: 0.4, delay: 0.02 }
                    : { type: "spring", stiffness: 400, damping: 20 }}
                >
                  <div className="bg-card border border-teal/25 rounded p-1.5 shadow-sm">
                    <svg width="24" height="14" viewBox="0 0 24 14">
                      <polyline
                        points="1,12 6,8 10,10 14,4 19,6 23,2"
                        fill="none"
                        stroke="hsl(162,65%,38%)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity="0.7"
                      />
                    </svg>
                  </div>
                </motion.div>
              </>
            )}

            {/* Sparkles — well outside the CIM border, scattered randomly */}
            {step >= 3 && (
              <>
                {[
                  { x: -52, y: -58, delay: 0.06, size: "text-base" },
                  { x: 44, y: -35, delay: 0.2, size: "text-xs" },
                  { x: -38, y: 48, delay: 0.28, size: "text-sm" },
                  { x: 60, y: 22, delay: 0.1, size: "text-xs" },
                  { x: 18, y: -68, delay: 0.16, size: "text-sm" },
                  { x: -58, y: 8, delay: 0.24, size: "text-base" },
                  { x: 34, y: 62, delay: 0.12, size: "text-xs" },
                ].map((s, i) => (
                  <motion.div
                    key={`sparkle-${i}`}
                    className={`absolute pointer-events-none ${s.size}`}
                    style={{
                      left: `calc(50% + ${s.x}px)`,
                      top: `calc(50% + ${s.y}px)`,
                      color: "hsl(162,65%,38%)",
                    }}
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{
                      opacity: [0, 1, 0.8, 0],
                      scale: [0, 1.3, 1, 0.3],
                    }}
                    transition={{
                      duration: 0.8,
                      delay: s.delay + 0.3,
                      ease: "easeOut",
                    }}
                  >
                    ✦
                  </motion.div>
                ))}
              </>
            )}
          </div>
          <span className="text-xs text-muted-foreground mt-2">CIM</span>
        </motion.div>
      </div>

      {/* Supporting text */}
      <motion.p
        className="text-center text-muted-foreground mt-8 max-w-md leading-relaxed"
        initial={{ opacity: 0, y: 12 }}
        animate={step >= 4 ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.5 }}
      >
        Everything you share becomes the professional package that represents
        your business to buyers.
      </motion.p>
    </div>
  );
}
