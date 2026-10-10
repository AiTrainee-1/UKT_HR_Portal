// Mounted once at the app root. The assistant exists ONLY for the Managing Director and ONLY on the MD pages: for anyone
// else, and on every other page, this renders nothing at all (no panel, no button, no request).

import { useEffect } from "react";
import { AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { closeAssistant, useAssistantState } from "@/lib/md/assistant-store";
import AssistantPanel from "./AssistantPanel";
import Launcher from "./Launcher";

const STYLES = `
  .assistant-shimmer { background: linear-gradient(90deg, #7a5410 0%, #e0a83a 45%, #7a5410 90%); background-size: 200% 100%;
    -webkit-background-clip: text; background-clip: text; color: transparent; animation: assistant-shimmer 1.6s linear infinite; }
  @keyframes assistant-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  .assistant-orb-glow { background: radial-gradient(circle, rgba(246,210,122,.55) 0%, rgba(246,210,122,0) 68%); animation: assistant-orb 3.2s ease-in-out infinite; }
  .assistant-orb-ring { animation: assistant-ring 3.2s ease-in-out infinite; }
  @keyframes assistant-orb { 0%,100% { transform: scale(.92); opacity: .75; } 50% { transform: scale(1.12); opacity: 1; } }
  @keyframes assistant-ring { 0%,100% { transform: scale(.96); opacity: .5; } 50% { transform: scale(1.06); opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    .assistant-shimmer, .assistant-orb-glow, .assistant-orb-ring { animation: none; }
    .assistant-shimmer { color: #7a5410; background: none; }
  }
`;

export default function AssistantHost() {
  const { user } = useAuth();
  const [location] = useLocation();
  const { open } = useAssistantState();
  const inPortal = !!user?.isMd && (location === "/md" || location.startsWith("/md/"));

  // Leaving the portal closes the panel, so it is closed when the MD comes back.
  useEffect(() => {
    if (!inPortal && open) closeAssistant();
  }, [inPortal, open]);

  if (!inPortal) return null;
  return (
    <>
      <style>{STYLES}</style>
      <AssistantPanel />
      <AnimatePresence>{!open && <Launcher key="launcher" />}</AnimatePresence>
    </>
  );
}
