import { useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import { openAssistant } from "@/lib/md/assistant-store";
import { prefersReducedMotion } from "../kit/reduced-motion";
import { RadioMascot } from "./mascot";
import { prefetchAssistantPanel } from "./panel-loader";

const SIZE = 148;
/** The poke's reaction (a blink, then a heart or sparkles) takes about this long to show before the panel covers it. */
const OPEN_AFTER_MS = 280;

/**
 * The floating AI launcher at the bottom-right of every MD page while the panel is closed: the radio character, with a
 * glass "Ask AI" bubble (indigo into wine, with a tail pointing at it) and a soft wine glow under it. Its head
 * follows the pointer and a poke makes it react (page-mascot); the poke also opens the assistant, a moment later so the
 * reaction is seen (at once for someone who prefers reduced motion, and Ctrl+J never waits).
 *
 * It springs in, grows a little under the pointer and shrinks away when the panel opens: CSS animations
 * (md-theme/areas/assistant.css, the springs as linear() curves; keyframes in AssistantHost.tsx), so the launcher needs no
 * animation library and appears with the page. `leaving` plays the exit; AssistantHost removes it afterwards.
 */
export default function Launcher({ leaving = false }: { leaving?: boolean }) {
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const open = () => {
    if (timer.current !== null) return; // a poke is already on its way to opening it
    if (prefersReducedMotion()) return openAssistant();
    timer.current = window.setTimeout(() => openAssistant(), OPEN_AFTER_MS);
  };
  return (
    <div
      // the click comes up from the character's own button (which is also what the keyboard activates)
      onClick={open}
      // the pointer coming near, or the keyboard reaching it: fetch the panel now, so it opens without a wait
      onPointerEnter={prefetchAssistantPanel}
      onFocus={prefetchAssistantPanel}
      title="Ask AI (Ctrl J)"
      data-testid="assistant-launcher"
      data-state={leaving ? "leaving" : "shown"}
      className="md-assistant-launcher fixed bottom-1 right-3 z-[53] print:hidden"
      style={{ width: SIZE, height: SIZE }}
    >
      {/* a soft wine glow under the character, then the character itself (never restyled), then the glass bubble */}
      <span aria-hidden className="md-assistant-launcher-halo pointer-events-none absolute inset-3 -z-10" />
      <RadioMascot size={SIZE} buttonLabel="Open the AI assistant" />
      <span
        aria-hidden
        className="md-assistant-bubble pointer-events-none absolute right-[72%] top-[30%]"
        style={{ transformOrigin: "100% 50%" }}
      >
        <Sparkles size={13} className="md-assistant-bubble-icon" />
        Ask AI
      </span>
    </div>
  );
}
