/**
 * A tab with work that is not saved yet can ask the Settings page to check before another tab is opened. The page keeps one
 * guard at a time (only the open tab is mounted): `setUnsavedGuard(() => dirty)` while mounted, `null` on leaving.
 */
let guard: (() => boolean) | null = null;

export function setUnsavedGuard(next: (() => boolean) | null): void {
  guard = next;
}

export const UNSAVED_QUESTION = "You have changes that are not saved. Leave this tab and lose them?";

/** True when it is fine to leave the open tab: nothing unsaved, or the person agreed to lose it. */
export function confirmLeaveTab(ask: (question: string) => boolean = (q) => window.confirm(q)): boolean {
  if (!guard || !guard()) return true;
  return ask(UNSAVED_QUESTION);
}
