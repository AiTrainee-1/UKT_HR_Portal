import { motion, useReducedMotion } from "framer-motion";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProgressLine } from "./api";

/** What the assistant is doing right now, one line per step: it looked at X, it is working out Y. Shown while an answer is
 *  being prepared, so the MD sees real progress instead of a spinner. */
export default function ProgressList({ lines }: { lines: ProgressLine[] }) {
  const reduce = useReducedMotion();
  const shown = lines.length > 0 ? lines : [{ label: "Reading your question", state: "running" as const }];
  return (
    <ul className="space-y-1.5" data-testid="assistant-progress" aria-live="polite">
      {shown.map((line, i) => (
        <motion.li
          key={`${i}-${line.label}`}
          initial={reduce ? false : { opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.22 }}
          className="flex items-center gap-2 text-[12.5px]"
        >
          {line.state === "running" ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-[#c18a1f]" />
          ) : line.state === "error" ? (
            <AlertCircle size={13} className="shrink-0 text-amber-600" />
          ) : (
            <Check size={13} className="shrink-0 text-green-600" />
          )}
          <span className={cn(line.state === "running" ? "assistant-shimmer font-semibold" : "text-[#1a3a4a]/70")}>
            {line.label}
          </span>
        </motion.li>
      ))}
    </ul>
  );
}
