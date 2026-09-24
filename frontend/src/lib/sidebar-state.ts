import { useSyncExternalStore } from "react";

// Every HR page renders its own <HrLayout>, so the sidebar remounts on each
// route change. The collapsed preference therefore lives in a module-level
// store (read synchronously on first render so the rail never flashes at the
// wrong width) and is persisted to localStorage across reloads/tabs.

const KEY = "hr_sidebar_collapsed";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let collapsed = read();

function emit() {
  listeners.forEach((l) => l());
}

export function setSidebarCollapsed(next: boolean) {
  if (next === collapsed) return;
  collapsed = next;
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // Storage blocked -the preference just won't survive a reload.
  }
  emit();
}

export function toggleSidebarCollapsed() {
  setSidebarCollapsed(!collapsed);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) {
      collapsed = e.newValue === "1";
      emit();
    }
  });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => collapsed,
    () => false,
  );
}

const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribeDesktop(cb: () => void) {
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** Matches Tailwind's `lg` breakpoint -below it the sidebar is a slide-in
 *  drawer, which always shows the full labelled layout, never the rail. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}
