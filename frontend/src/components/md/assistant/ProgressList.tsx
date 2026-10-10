import { motion, useReducedMotion } from "framer-motion";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProgressLine } from "./api";

const BADGE: Record<ProgressLine["state"], string> = {
  running: "border-md-wine/20 bg-md-wine/10 text-md-wine-700",
  error: "border-md-warning-400/40 bg-md-warning-100 text-md-warning-700",
  done: "border-md-success-400/40 bg-md-success-100 text-md-success-700",
};

/** What the assistant is doing right now, one line per step: it looked at X, it is working out Y. Shown while an answer is
 *  being prepared, so the MD sees real progress instead of a spinner. A step that is running is a wine spinner and a
 *  shimmering label; a finished one a sage tick; one that failed an ochre alert (the label says so as well). */
export default function ProgressList({ lines }: { lines: ProgressLine[] }) {
  const reduce = useReducedMotion();
  const shown = lines.length > 0 ? lines : [{ label: "Reading your question", state: "running" as const }];
  return (
    <ul className="space-y-2" data-testid="assistant-progress" aria-live="polite">
      {shown.map((line, i) => (
        <motion.li
          key={`${i}-${line.label}`}
          initial={reduce ? false : { opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.22 }}
          className="flex items-center gap-2.5 text-[13px] leading-snug"
        >
          <span
            className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border", BADGE[line.state])}
          >
            {line.state === "running" ? (
              <Loader2 size={12} className="motion-safe:animate-spin" />
            ) : line.state === "error" ? (
              <AlertCircle size={12} />
            ) : (
              <Check size={12} strokeWidth={3} />
            )}
          </span>
          <span className={cn(line.state === "running" ? "md-assistant-shimmer font-semibold" : "text-md-ink-soft")}>
            {line.label}
          </span>
        </motion.li>
      ))}
    </ul>
  );
}
