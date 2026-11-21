import { useSyncExternalStore } from "react";

// "Reduce motion" (the operating system's setting), without a motion library: the MD portal's light animations are CSS,
// and the few that need to know in script (a count-up, the launcher's exit) ask here. Follows the setting live.

const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const list = media();
  if (!list) return () => {};
  if (typeof list.addEventListener === "function") {
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }
  list.addListener?.(onChange);
  return () => list.removeListener?.(onChange);
}

/** Whether "reduce motion" is on right now (false where the browser cannot say). */
export function prefersReducedMotion(): boolean {
  return media()?.matches ?? false;
}

/** The same, as a hook that re-renders when the setting changes. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
