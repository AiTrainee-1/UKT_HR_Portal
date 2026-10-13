import { useCallback, useMemo, useState } from "react";

/** Is `next` a real change of `saved`? (Text compared trimmed, so a stray space is not "unsaved".) */
export function changed(saved: unknown, next: unknown): boolean {
  if (typeof saved === "string" && typeof next === "string") return saved.trim() !== next.trim();
  if (saved == null && next == null) return false;
  return saved !== next;
}

/** The keys of `draft` whose value differs from `saved`. */
export function changedKeys<T extends object>(saved: T, draft: Partial<T>): (keyof T)[] {
  return (Object.keys(draft) as (keyof T)[]).filter((k) => changed(saved[k], draft[k]));
}

/**
 * A tab's form as "what is saved, with the edits on top". Only the fields someone typed in are held here, so when the
 * saved settings are fetched again (another tab saved, the window regained focus) the untouched fields follow the
 * server while the ones being edited keep what was typed. `discard` drops the edits; call it after a successful save.
 */
export function useDraft<T extends object>(saved: T) {
  const [draft, setDraft] = useState<Partial<T>>({});

  const form = useMemo(() => ({ ...saved, ...draft }) as T, [saved, draft]);
  const dirtyKeys = useMemo(() => changedKeys(saved, draft), [saved, draft]);

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);
  const discard = useCallback(() => setDraft({}), []);

  return { form, set, discard, dirty: dirtyKeys.length > 0, dirtyKeys };
}
