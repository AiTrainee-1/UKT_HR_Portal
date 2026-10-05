// The MD assistant's shared state: whether the panel is open, a question waiting to be asked, and what the current page
// is showing. A module-level store (like lib/sidebar-state.ts) rather than React context, because every MD page mounts
// its own layout while the assistant must survive navigation: the sidebar, the "Ask AI" buttons on the pages and the
// panel (mounted once at the app root) all meet here.

import { useEffect, useSyncExternalStore } from "react";

export type AssistantPageContext = {
  /** The page id from md-nav ("dashboard", "attendance", "payroll"...). */
  page: string;
  title: string;
  /** What the page is filtered to, in plain words ({"Period": "Last 30 days", "Unit": "All units"}). */
  filters?: Record<string, string | number | null | undefined>;
  /** The headline numbers on screen, so "why is this high?" has something to point at. */
  summary?: Record<string, string | number | null | undefined>;
};

export type PendingPrompt = { text: string; nonce: number };

type State = { open: boolean; prompt: PendingPrompt | null; context: AssistantPageContext | null };

let state: State = { open: false, prompt: null, context: null };
const listeners = new Set<() => void>();
let nonce = 0;

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

/** Open the panel, optionally with a question to ask straight away. */
export function openAssistant(prompt?: string) {
  set({ open: true, prompt: prompt ? { text: prompt, nonce: ++nonce } : state.prompt });
}

export function closeAssistant() {
  set({ open: false });
}

export function toggleAssistant() {
  set({ open: !state.open });
}

/** The panel calls this once it has taken the question, so it is asked only once. */
export function clearPendingPrompt(forNonce: number) {
  if (state.prompt?.nonce === forNonce) set({ prompt: null });
}

export function setAssistantContext(context: AssistantPageContext | null) {
  set({ context });
}

export function getAssistantState(): State {
  return state;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useAssistantState(): State {
  return useSyncExternalStore(subscribe, getAssistantState, getAssistantState);
}

/** A page calls this with what it shows; it is cleared when the page goes away. Re-publishes only when the content changes. */
export function usePublishAssistantContext(context: AssistantPageContext | null) {
  const key = JSON.stringify(context);
  useEffect(() => {
    setAssistantContext(context);
    return () => setAssistantContext(null);
    // `key` is the content of `context`: depending on the object itself would republish on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
