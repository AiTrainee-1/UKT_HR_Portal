// "When the browser has nothing better to do": for fetching what the MD will probably want next (the assistant's panel,
// the next page's code) without competing with what is on screen. Skipped when the browser asks to save data.

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/** Whether the connection asks for as little traffic as possible (Data Saver). */
export function savesData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !!connection?.saveData;
}

/** Run `task` once the page has been quiet for a while: after `delayMs`, at the browser's next idle moment (or within
 *  two seconds of it at the latest). Returns the function that cancels it. */
export function whenIdle(task: () => void, delayMs = 2500): () => void {
  if (typeof window === "undefined" || savesData()) return () => {};
  const w = window as IdleWindow;
  let idle: number | null = null;
  const timer = window.setTimeout(() => {
    if (typeof w.requestIdleCallback === "function") idle = w.requestIdleCallback(task, { timeout: 2000 });
    else task();
  }, delayMs);
  return () => {
    window.clearTimeout(timer);
    if (idle !== null) w.cancelIdleCallback?.(idle);
  };
}
