import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";

/** `pending` when the browser's Back (or the phone's back gesture) is what was held. */
export const BACK = "back";
/** Marks the extra history entry the guard keeps on top while there are unsaved changes. */
const MARK = "ukUnsavedGuard";

const isGuardEntry = (state: unknown) =>
  typeof state === "object" && state !== null && (state as Record<string, unknown>)[MARK] === true;

function pushGuardEntry() {
  const state = typeof window.history.state === "object" && window.history.state ? window.history.state : {};
  window.history.pushState({ ...state, [MARK]: true }, "", window.location.href);
}

/**
 * Keeps unsaved builder changes from being lost by accident. While `dirty`:
 * - closing or reloading the tab asks the browser's own "Leave site?" question;
 * - a click on any link of the portal (the sidebar, the breadcrumb, "Back to reports") is held, and `pending` names
 *   where it was going, so the page can ask in its own dialog: `leave()` goes there, `stay()` stays;
 * - the browser's Back / the phone's back gesture is held too (`pending` = BACK): the guard keeps one extra history
 *   entry of this same address on top, and a Back that takes it off puts it back and asks. `leave()` then goes back for
 *   real (past that entry); once the changes are saved the extra entry is taken off again.
 * Links that open elsewhere (new tab, download, another site, an in-page #anchor) are left alone.
 */
export function useUnsavedGuard(dirty: boolean, opts: { fallback?: string } = {}) {
  const fallback = opts.fallback ?? "/hr/reports";
  const [, navigate] = useLocation();
  const [pending, setPending] = useState<string | null>(null);
  /** A Back the user confirmed is on its way (go(-2)): its popstate is not held again. */
  const goingBack = useRef(false);
  /** The guard's own history.back() that takes the extra entry off, while it is on its way. */
  const dropping = useRef<Promise<void> | null>(null);

  /** Takes the extra entry off when it is the current one (after a save; before a new report moves address). */
  const release = useCallback((): Promise<void> => {
    if (dropping.current) return dropping.current;
    if (!isGuardEntry(window.history.state)) return Promise.resolve();
    dropping.current = new Promise<void>((resolve) => {
      const done = () => {
        window.removeEventListener("popstate", done);
        window.clearTimeout(timer);
        dropping.current = null;
        resolve();
      };
      const timer = window.setTimeout(done, 500);
      window.addEventListener("popstate", done);
      window.history.back();
    });
    return dropping.current;
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers need a value set to show their question.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    // Capture phase on the document: runs before the router's own click handler, which is then never reached.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href || href.startsWith("#")) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      e.preventDefault();
      e.stopPropagation();
      setPending(`${url.pathname}${url.search}${url.hash}`);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty]);

  // Back / forward / the phone's back gesture: wouter would simply follow the address, and the builder (and every
  // unsaved change) would be gone. An extra entry of this same address stays on top while there are changes.
  useEffect(() => {
    if (!dirty) return;
    let active = true;
    goingBack.current = false;
    const guardedHref = window.location.href;
    const ensure = () => {
      if (active && !isGuardEntry(window.history.state) && window.location.href === guardedHref) pushGuardEntry();
    };
    if (dropping.current) void dropping.current.then(ensure);
    else ensure();
    const onPop = (e: PopStateEvent) => {
      if (dropping.current || goingBack.current) return; // the guard's own move
      if (window.location.href !== guardedHref) return; // another address: not a Back off the extra entry
      if (isGuardEntry(e.state ?? window.history.state)) return; // forward onto it again
      pushGuardEntry();
      setPending(BACK);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      active = false;
      window.removeEventListener("popstate", onPop);
      // the changes are saved (or the page is going): the extra entry is not needed any more
      if (!goingBack.current) void release();
    };
  }, [dirty, release]);

  const stay = useCallback(() => setPending(null), []);
  const leave = useCallback(() => {
    const to = pending;
    setPending(null);
    if (to === BACK) {
      goingBack.current = true;
      window.history.go(-2); // past the extra entry, to where Back was going
      // opened straight on this address (nothing to go back to): the Report Center instead
      window.setTimeout(() => {
        if (goingBack.current && isGuardEntry(window.history.state)) navigate(fallback, { replace: true });
      }, 400);
      return;
    }
    // the extra entry is replaced, so Back from there does not land on this page twice
    if (to) navigate(to, { replace: isGuardEntry(window.history.state) });
  }, [pending, navigate, fallback]);
  /** Go somewhere from a button: asks first when there are unsaved changes. */
  const request = useCallback((to: string) => (dirty ? setPending(to) : navigate(to)), [dirty, navigate]);

  return { pending, stay, leave, request, release };
}
