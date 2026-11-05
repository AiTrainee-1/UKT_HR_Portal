import { useEffect, useRef, useState } from "react";

/** How long typing has to pause before a search box is acted on (a request sent, the address written). */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * The value as it was `ms` ago at the latest: a search box that feeds a request sends one per pause, not one per letter.
 * Show the live value in the box and hand this one to the query.
 */
export function useDebounced<T>(value: T, ms = SEARCH_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * A search box's own text over a value someone else keeps (the page's filters, the address). Typing changes only the
 * box; `commit` is called once typing pauses, so the owner (and everything it re-renders or fetches) changes once per
 * pause. Emptying the box is committed at once. When the owner changes the value itself (a Reset button, the address),
 * the box follows. Returns the text to show and the setter for the box's onChange.
 */
export function useDraft(
  value: string,
  commit: (next: string) => void,
  ms = SEARCH_DEBOUNCE_MS,
): [string, (next: string) => void] {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => {
    // the owner changed the value: the box shows it
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = draft;
      commitRef.current(draft);
    }, ms);
    return () => clearTimeout(timer);
  }, [draft, ms]);
  const change = (next: string) => {
    setDraft(next);
    if (next === "" && committed.current !== "") {
      committed.current = "";
      commitRef.current("");
    }
  };
  return [draft, change];
}
