import { useSyncExternalStore } from "react";

/** Narrower than Tailwind's `sm` (640 px): a phone. Tablets and desktops keep the layout they had. */
const PHONE_QUERY = "(max-width: 639.98px)";

const media = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(PHONE_QUERY) : null);

function subscribe(onChange: () => void) {
  const mql = media();
  if (!mql) return () => {};
  mql.addEventListener?.("change", onChange);
  return () => mql.removeEventListener?.("change", onChange);
}

/** Is the screen a phone's? For what CSS cannot change, such as a chart's tick size and how many ticks it draws. False
 *  where there is no matchMedia (tests, the server). */
export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => media()?.matches ?? false,
    () => false,
  );
}
