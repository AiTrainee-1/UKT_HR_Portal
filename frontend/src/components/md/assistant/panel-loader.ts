import { lazy } from "react";

// The assistant's panel (the conversation, the composer, voice, markdown, and framer-motion for its slide) is a chunk of
// its own: nothing of it is needed until the MD opens the assistant. AssistantHost fetches it ahead when the page is idle,
// and the launcher when the pointer comes near, so opening it is usually instant all the same.

let pending: Promise<typeof import("./AssistantPanel")> | null = null;

export function preloadAssistantPanel(): Promise<typeof import("./AssistantPanel")> {
  pending ??= import("./AssistantPanel").catch((error: unknown) => {
    pending = null; // a failed fetch (offline, a new deploy) may be tried again
    throw error;
  });
  return pending;
}

/** Fetch it ahead, quietly (a failure only means it is fetched again when opened). */
export function prefetchAssistantPanel(): void {
  preloadAssistantPanel().catch(() => {});
}

export const LazyAssistantPanel = lazy(preloadAssistantPanel);
