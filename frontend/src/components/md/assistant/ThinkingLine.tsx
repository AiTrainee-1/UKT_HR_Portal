import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ProgressLine } from "./api";

/** The step the assistant is on now: the running one, else the latest (owner 2026-11-13: one line, not the whole list). */
export function currentStep(lines: ProgressLine[]): string {
  const running = [...lines].reverse().find((l) => l.state === "running");
  const label = (running ?? lines[lines.length - 1])?.label?.trim();
  return label ? label.replace(/[.…\s]+$/, "") : "Reading your question";
}

/**
 * While an answer is being prepared: ONE quiet line beside the assistant's face, in place of the list of every step.
 * The label of the step it is on fades out and the next one fades in as the work moves on, and the words breathe
 * (fade down and up) while it waits; three small wine dots pulse after them. With "reduce motion" on it is the plain
 * label. The lookups it made are still listed under the answer ("How I got this").
 */
export default function ThinkingLine({ lines }: { lines: ProgressLine[] }) {
  const reduce = useReducedMotion();
  const label = currentStep(lines);
  return (
    <div
      className="flex min-h-8 min-w-0 items-center gap-2 px-1 py-1"
      data-testid="assistant-progress"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Working on the answer: {label}</span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={label}
          aria-hidden
          className="md-assistant-shimmer min-w-0 truncate text-[13px] font-semibold leading-snug"
          data-testid="assistant-progress-label"
          initial={reduce ? false : { opacity: 0, y: 3 }}
          animate={reduce ? { opacity: 1 } : { opacity: [1, 0.55, 1], y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
          transition={
            reduce
              ? { duration: 0 }
              : {
                  opacity: { duration: 1.8, repeat: Infinity, ease: "easeInOut" },
                  y: { duration: 0.25, ease: "easeOut" },
                }
          }
        >
          {label}
        </motion.span>
      </AnimatePresence>
      <span aria-hidden className="flex shrink-0 items-center gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-md-wine-500"
            animate={reduce ? { opacity: 0.6 } : { opacity: [0.25, 1, 0.25] }}
            transition={
              reduce ? { duration: 0 } : { duration: 1.2, repeat: Infinity, delay: i * 0.18, ease: "easeInOut" }
            }
          />
        ))}
      </span>
    </div>
  );
}
