import { motion, useReducedMotion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { openAssistant } from "@/lib/md/assistant-store";

/** The floating "Ask AI" button at the bottom-right of every MD page while the panel is closed. */
export default function Launcher() {
  const reduce = useReducedMotion();
  return (
    <motion.button
      type="button"
      onClick={() => openAssistant()}
      initial={reduce ? false : { scale: 0.6, opacity: 0, y: 12 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={reduce ? undefined : { scale: 0.6, opacity: 0 }}
      whileHover={reduce ? undefined : { scale: 1.05 }}
      whileTap={reduce ? undefined : { scale: 0.96 }}
      transition={{ type: "spring", stiffness: 380, damping: 26 }}
      aria-label="Open the AI assistant"
      data-testid="assistant-launcher"
      className="group fixed bottom-5 right-5 z-[53] flex items-center gap-2 rounded-full py-3 pl-3.5 pr-4 text-[13px] font-extrabold text-[#5b3d00] shadow-[0_10px_30px_rgba(224,168,58,0.45)] print:hidden"
      style={{ background: "linear-gradient(135deg, #f6d27a 0%, #e0a83a 100%)" }}
    >
      <span className="assistant-launcher-ring pointer-events-none absolute inset-0 rounded-full" aria-hidden />
      <Sparkles size={18} strokeWidth={2.4} className="relative transition-transform group-hover:rotate-12" />
      <span className="relative">Ask AI</span>
    </motion.button>
  );
}
