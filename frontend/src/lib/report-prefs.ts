// Per-viewer conveniences for the Report Center: starred reports, recently opened reports and the last
// filters used per report. Purely local (localStorage); every access is guarded because storage can be
// blocked or full, and the page must work without it.

import { useSyncExternalStore } from "react";
import type { RememberedFilters } from "./report-center";

const FAVORITES_KEY = "hr_reports_favorites";
const RECENT_KEY = "hr_reports_recent";
const LAST_PREFIX = "hr_reports_last:";
export const MAX_RECENT = 6;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable - the preference just isn't remembered */
  }
}

function idList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

export type ReportPrefs = { favorites: string[]; recents: string[] };

let snapshot: ReportPrefs = { favorites: [], recents: [] };
let loaded = false;
const listeners = new Set<() => void>();

function load(): void {
  snapshot = {
    favorites: idList(readJson<unknown>(FAVORITES_KEY, [])),
    recents: idList(readJson<unknown>(RECENT_KEY, [])),
  };
  loaded = true;
}

function commit(next: ReportPrefs): void {
  snapshot = next;
  writeRaw(FAVORITES_KEY, JSON.stringify(next.favorites));
  writeRaw(RECENT_KEY, JSON.stringify(next.recents));
  listeners.forEach((l) => l());
}

export function getPrefs(): ReportPrefs {
  if (!loaded) load();
  return snapshot;
}

/** Stars / un-stars a report. */
export function toggleFavorite(id: string): void {
  const { favorites, recents } = getPrefs();
  commit({ favorites: favorites.includes(id) ? favorites.filter((f) => f !== id) : [id, ...favorites], recents });
}

/** Marks a report as just opened (most recent first, no duplicates, capped). */
export function pushRecent(id: string): void {
  const { favorites, recents } = getPrefs();
  if (recents[0] === id) return;
  commit({ favorites, recents: [id, ...recents.filter((r) => r !== id)].slice(0, MAX_RECENT) });
}

/**
 * What was remembered of a report's last run (lib/report-center.ts rememberFilters), or null. Before 2026-11-19 the
 * whole query string was stored, fixed dates included; such an entry still restores its scope filters (restoreFilters
 * ignores everything else in it), but never its months or dates.
 */
export function getLastFilters(reportId: string): RememberedFilters | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LAST_PREFIX + reportId);
  } catch {
    return null;
  }
  if (!raw) return null;
  if (!raw.startsWith("{")) return { query: raw, relative: {} };
  try {
    const parsed = JSON.parse(raw) as { query?: unknown; relative?: unknown };
    const relative: Record<string, string> = {};
    if (parsed.relative && typeof parsed.relative === "object") {
      for (const [k, v] of Object.entries(parsed.relative)) if (typeof v === "string") relative[k] = v;
    }
    return { query: typeof parsed.query === "string" ? parsed.query : "", relative };
  } catch {
    return null;
  }
}

/** Remembers a report's last run; null forgets it (the run matched the defaults, or the user pressed Reset). */
export function setLastFilters(reportId: string, remembered: RememberedFilters | null): void {
  if (remembered) {
    writeRaw(LAST_PREFIX + reportId, JSON.stringify(remembered));
    return;
  }
  try {
    localStorage.removeItem(LAST_PREFIX + reportId);
  } catch {
    /* storage unavailable - nothing was remembered either */
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === FAVORITES_KEY || e.key === RECENT_KEY || e.key === null) {
      load();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useReportPrefs(): ReportPrefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}

/** Test hook: forget the in-memory copy so the next read goes back to storage. */
export function _resetPrefsCache(): void {
  loaded = false;
  snapshot = { favorites: [], recents: [] };
}
