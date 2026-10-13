import { useCallback, useState } from "react";

/**
 * A settings form over a saved value: `draft` is what is on screen, `saved` what the server has. While nothing has
 * been changed the form follows the server (a reload, another tab's save, the refetch after this form's own save); once
 * HR changes something the draft is kept until it is saved or discarded, so a background refresh never wipes what is
 * being typed. `saved` must keep its identity while the server data does not change (build it with useMemo).
 */
export function useDraft<T>(saved: T | null, same: (a: T, b: T) => boolean) {
  const [draft, setDraft] = useState<T | null>(saved);
  const [seen, setSeen] = useState<T | null>(saved);

  if (saved !== seen) {
    // Adjusting state while rendering (instead of in an effect) avoids one frame of stale values on screen.
    setSeen(saved);
    if (draft === null || seen === null || same(draft, seen)) setDraft(saved);
  }

  const dirty = draft !== null && saved !== null && !same(draft, saved);
  const discard = useCallback(() => setDraft(saved), [saved]);
  const update = useCallback((patch: Partial<T>) => setDraft((d) => (d === null ? d : { ...d, ...patch })), []);

  return { draft, setDraft, update, dirty, discard };
}
