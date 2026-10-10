import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { openAssistant } from "@/lib/md/assistant-store";
import { RadioMascot } from "./mascot";

const SIZE = 148;
/** The poke's reaction (a blink, then a heart or sparkles) takes about this long to show before the panel covers it. */
const OPEN_AFTER_MS = 280;

/**
 * The floating AI launcher at the bottom-right of every MD page while the panel is closed: the radio character, with a
 * glass "Ask AI" bubble (indigo into wine, with a tail pointing at it) and a soft wine glow under it. Its head
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
      className="md-assistant-launcher fixed bottom-1 right-3 z-[53] print:hidden"
      style={{ width: SIZE, height: SIZE }}
    >
      {/* a soft wine glow under the character, then the character itself (never restyled), then the glass bubble */}
      <span aria-hidden className="md-assistant-launcher-halo pointer-events-none absolute inset-3 -z-10" />
      <RadioMascot size={SIZE} buttonLabel="Open the AI assistant" />
      <motion.span
        aria-hidden
        initial={reduce ? false : { opacity: 0, scale: 0.8, x: 8 }}
        animate={{ opacity: 1, scale: 1, x: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 24, delay: reduce ? 0 : 0.35 }}
        className="md-assistant-bubble pointer-events-none absolute right-[72%] top-[30%]"
        style={{ transformOrigin: "100% 50%" }}
      >
        <Sparkles size={13} className="md-assistant-bubble-icon" />
        Ask AI
      </motion.span>
    </motion.div>
  );
}
