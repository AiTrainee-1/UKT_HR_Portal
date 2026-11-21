// Mounted once at the app root. The assistant exists ONLY for the Managing Director and ONLY on the MD pages: for anyone
// else, and on every other page, this renders nothing at all (no panel, no button, no request).
//
// Kept light on purpose (it loads with every MD session): the launcher is CSS-animated, and the panel, with its
// conversation, voice and framer-motion, is a chunk of its own (panel-loader.ts), fetched when the page is idle or the
// pointer nears the launcher, mounted the first time the MD opens it, and kept mounted after that (so a conversation
// survives moving between pages).

import { Suspense, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { closeAssistant, useAssistantState } from "@/lib/md/assistant-store";
import { usePrefersReducedMotion } from "../kit/reduced-motion";
import { whenIdle } from "../shell/idle";
import { loadedMdShell, preloadMdShell } from "../shell/loader";
import { getStatus } from "./api";
import Launcher from "./Launcher";
import { LazyAssistantPanel, prefetchAssistantPanel } from "./panel-loader";

// Only the keyframes live here (md-theme.test.ts does not accept percentage selectors in an area file); the classes that use
// them are in md-theme/areas/assistant.css, and every colour is a palette variable.
const STYLES = `
  @keyframes md-assistant-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @keyframes md-assistant-orb { 0%,100% { transform: scale(.92); opacity: .75; } 50% { transform: scale(1.1); opacity: 1; } }
  @keyframes md-assistant-ring { 0%,100% { transform: scale(.97); opacity: .45; } 50% { transform: scale(1.05); opacity: 1; } }
  @keyframes md-assistant-bob { 0%,100% { translate: 0 0; } 50% { translate: 0 -3px; } }
  @keyframes md-assistant-face-pulse {
    0%,100% { box-shadow: 0 0 0 2px rgba(255,255,255,.96), 0 0 0 3px color-mix(in srgb, var(--md-wine) 16%, transparent), 0 8px 18px -6px color-mix(in srgb, var(--md-wine) 45%, transparent); }
    50% { box-shadow: 0 0 0 2px rgba(255,255,255,.96), 0 0 0 6px color-mix(in srgb, var(--md-wine) 26%, transparent), 0 10px 22px -4px color-mix(in srgb, var(--md-wine) 55%, transparent); }
  }
  @keyframes md-assistant-launcher-in { from { scale: .6; opacity: 0; translate: 0 12px; } }
  @keyframes md-assistant-launcher-out { to { scale: .75; opacity: 0; } }
  @keyframes md-assistant-bubble-in { from { opacity: 0; scale: .8; transform: translateX(8px); } }
`;

/** How long the launcher's exit plays (md-theme/areas/assistant.css) before it is removed. */
const LAUNCHER_EXIT_MS = 340;

/** The assistant's look is part of the MD skin, which arrives with the MD shell: nothing is drawn before it is in (it would
 *  flash unstyled). Asking for it here also starts the shell's download early, with the session. */
function useSkinReady(active: boolean): boolean {
  const [ready, setReady] = useState(() => loadedMdShell() !== null);
  useEffect(() => {
    if (!active || ready) return;
    let live = true;
    preloadMdShell().then(
      () => live && setReady(true),
      () => {
        // offline: the page's own shell load reports it; the assistant just stays away
      },
    );
    return () => {
      live = false;
    };
  }, [active, ready]);
  return ready;
}

export default function AssistantHost() {
  const { user } = useAuth();
  const [location] = useLocation();
  const { open } = useAssistantState();
  const queryClient = useQueryClient();
  const reduce = usePrefersReducedMotion();
  const inPortal = !!user?.isMd && (location === "/md" || location.startsWith("/md/"));
  const skinReady = useSkinReady(inPortal);

  // the panel mounts the first time it is opened and stays (derived during render, so it mounts with the opening itself)
  const [panelMounted, setPanelMounted] = useState(open);
  if (open && !panelMounted) setPanelMounted(true);

  // the launcher shrinks away when the panel opens (at once with reduced motion) and springs back when it closes
  const [launcher, setLauncher] = useState<"shown" | "leaving" | "gone">(open ? "gone" : "shown");
  useEffect(() => {
    if (!open) {
      setLauncher("shown");
      return;
    }
    if (reduce) {
      setLauncher("gone");
      return;
    }
    setLauncher((now) => (now === "gone" ? "gone" : "leaving"));
    const timer = window.setTimeout(() => setLauncher("gone"), LAUNCHER_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, reduce]);

  // Leaving the portal closes the panel, so it is closed when the MD comes back.
  useEffect(() => {
    if (!inPortal && open) closeAssistant();
  }, [inPortal, open]);

  // Once the page has settled: the panel's code and the assistant's status, so the first opening is instant.
  useEffect(() => {
    if (!inPortal || !skinReady || panelMounted) return;
    return whenIdle(() => {
      prefetchAssistantPanel();
      void queryClient.prefetchQuery({
        queryKey: ["/api/md", "assistant", "status"],
        queryFn: getStatus,
        staleTime: 30_000,
      });
    }, 4000);
  }, [inPortal, skinReady, panelMounted, queryClient]);

  if (!inPortal || !skinReady) return null;
  return (
    <>
      <style>{STYLES}</style>
      {panelMounted && (
        <Suspense fallback={null}>
          <LazyAssistantPanel />
        </Suspense>
      )}
      {launcher !== "gone" && <Launcher key="launcher" leaving={launcher === "leaving"} />}
    </>
  );
}
