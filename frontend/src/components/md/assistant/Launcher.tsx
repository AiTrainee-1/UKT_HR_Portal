import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { openAssistant } from "@/lib/md/assistant-store";
import { RadioMascot } from "./mascot";

const SIZE = 148;
/** The poke's reaction (a blink, then a heart or sparkles) takes about this long to show before the panel covers it. */
const OPEN_AFTER_MS = 280;

/**
 * The floating AI launcher at the bottom-right of every MD page while the panel is closed: the radio character. Its head
 * follows the pointer and a poke makes it react (page-mascot); the poke also opens the assistant, a moment later so the
 * reaction is seen (at once for someone who prefers reduced motion, and Ctrl+J never waits).
 */
export default function Launcher() {
  const reduce = useReducedMotion();
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const open = () => {
    if (timer.current !== null) return; // a poke is already on its way to opening it
    if (reduce) return openAssistant();
    timer.current = window.setTimeout(() => openAssistant(), OPEN_AFTER_MS);
  };
  return (
    <motion.div
      // the click comes up from the character's own button (which is also what the keyboard activates)
      onClick={open}
      initial={reduce ? false : { scale: 0.6, opacity: 0, y: 12 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={reduce ? undefined : { scale: 0.75, opacity: 0, transition: { duration: 0.34 } }}
      whileHover={reduce ? undefined : { scale: 1.04 }}
      transition={{ type: "spring", stiffness: 380, damping: 26 }}
      title="Ask AI (Ctrl J)"
      data-testid="assistant-launcher"
      className="fixed bottom-1 right-3 z-[53] print:hidden"
      style={{ width: SIZE, height: SIZE }}
    >
      <RadioMascot size={SIZE} buttonLabel="Open the AI assistant" />
      <span
        aria-hidden
        className="pointer-events-none absolute right-[72%] top-[30%] whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] font-extrabold text-[#5b3d00] shadow-[0_6px_18px_rgba(224,168,58,0.45)]"
        style={{ background: "linear-gradient(135deg, #f6d27a 0%, #e0a83a 100%)" }}
      >
        Ask AI
        <span
          className="absolute -right-1 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rotate-45"
          style={{ background: "#e6b043" }}
        />
      </span>
    </motion.div>
  );
}
