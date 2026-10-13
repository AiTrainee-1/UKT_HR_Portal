import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/** The value as it was `ms` ago at the latest: the search box sends one request per pause, not one per letter. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

const canMatch = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

/** Whether a media query matches now; `fallback` where there is no layout engine (the server, jsdom). */
export function useMediaQuery(query: string, fallback = true): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!canMatch()) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (canMatch() ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}
