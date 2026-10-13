/**
 * Scroll a setting into view and flash it, so "go to this setting" (from the page's search, or a link such as
 * /hr/settings?tab=attendance#late-window) lands somewhere visible. The tab may still be loading, so this waits a moment
 * for the block to appear. Returns a function that stops waiting.
 */
export function focusSetting(id: string, root: ParentNode = document, timeoutMs = 4000): () => void {
  let stopped = false;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attempt = () => {
    if (stopped) return;
    const el = root.querySelector<HTMLElement>(`[data-setting-id="${CSS.escape(id)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("setting-flash");
      timer = setTimeout(() => el.classList.remove("setting-flash"), 2200);
      return;
    }
    if (Date.now() - started < timeoutMs) timer = setTimeout(attempt, 120);
  };
  attempt();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** The tab and setting a settings address asks for: `?tab=attendance#late-window`. */
export function parseSettingsAddress(search: string, hash: string): { tab: string | null; setting: string | null } {
  const tab = new URLSearchParams(search).get("tab");
  const setting = hash.replace(/^#/, "");
  return { tab: tab || null, setting: setting || null };
}

export function settingsAddress(tab: string, setting?: string | null): string {
  return `/hr/settings?tab=${encodeURIComponent(tab)}${setting ? `#${encodeURIComponent(setting)}` : ""}`;
}
