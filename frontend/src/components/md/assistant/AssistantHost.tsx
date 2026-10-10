// Mounted once at the app root. The assistant exists ONLY for the Managing Director and ONLY on the MD pages: for anyone
// else, and on every other page, this renders nothing at all (no panel, no button, no request).

import { useEffect } from "react";
import { AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { closeAssistant, useAssistantState } from "@/lib/md/assistant-store";
import AssistantPanel from "./AssistantPanel";
import Launcher from "./Launcher";

// Only the keyframes live here (md-theme.test.ts does not accept percentage selectors in an area file); the classes that use
// them are in md-theme/areas/assistant.css, and every colour is a palette variable.
const STYLES = `
  @keyframes md-assistant-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @keyframes md-assistant-orb { 0%,100% { transform: scale(.92); opacity: .75; } 50% { transform: scale(1.1); opacity: 1; } }
  @keyframes md-assistant-ring { 0%,100% { transform: scale(.97); opacity: .45; } 50% { transform: scale(1.05); opacity: 1; } }
  @keyframes md-assistant-slide { 0% { background-position: -60% 0; } 100% { background-position: 160% 0; } }
  @keyframes md-assistant-bob { 0%,100% { translate: 0 0; } 50% { translate: 0 -3px; } }
  @keyframes md-assistant-face-pulse {
    0%,100% { box-shadow: 0 0 0 2px rgba(255,255,255,.96), 0 0 0 3px color-mix(in srgb, var(--md-wine) 16%, transparent), 0 8px 18px -6px color-mix(in srgb, var(--md-wine) 45%, transparent); }
    50% { box-shadow: 0 0 0 2px rgba(255,255,255,.96), 0 0 0 6px color-mix(in srgb, var(--md-wine) 26%, transparent), 0 10px 22px -4px color-mix(in srgb, var(--md-wine) 55%, transparent); }
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
