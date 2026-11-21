// The filters of an MD page, kept in the address (2026-11-21), so a refresh, Back or a shared link shows the same view.
// One small hook reads and writes the query string; the helpers turn the shared choices (period, month, scope) into
// query parameters and back. A filter change REPLACES the history entry (Back leaves the page, it does not undo every
// click); opening a record's detail may push one, so Back closes it.

import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { thisMonthKey, type MonthKey } from "@/components/md/kit/MonthPicker";
import { EVERYONE, isValidCustom, PRESET_LABEL, type PeriodChoice, type ScopeChoice } from "./period";

/** A change to the query string: a value sets the parameter, `null` / `undefined` / "" removes it. */
export type UrlPatch = Record<string, string | number | null | undefined>;
export type UrlUpdate = (patch: UrlPatch, options?: { push?: boolean }) => void;

/** `search` with `patch` applied, as "?a=1&b=2" (or "" when nothing is left). */
export function applyUrlPatch(search: string, patch: UrlPatch): string {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") next.delete(key);
    else next.set(key, String(value));
  }
  const text = next.toString();
  return text ? `?${text}` : "";
}

/** The page's query string as URLSearchParams, and a function that changes it. */
export function useUrlParams(): [URLSearchParams, UrlUpdate] {
  const search = useSearch();
  const [path, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const update = useCallback<UrlUpdate>(
    (patch, options = {}) => navigate(`${path}${applyUrlPatch(search, patch)}`, { replace: !options.push }),
    [search, path, navigate],
  );
  return [params, update];
}

// ── month ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `month=YYYY-MM` when it is a real month not after this one; null otherwise. */
export function monthFromParams(params: URLSearchParams, now = new Date()): MonthKey | null {
  const raw = params.get("month") ?? "";
  return MONTH_RE.test(raw) && raw <= thisMonthKey(now) ? raw : null;
}

// ── period (presets, a custom range, or a whole month) ──────────────────────────────────────────────────────────────

/** The period the address asks for: a whole month, a custom range, a known preset, else `fallback`. */
export function periodFromParams(params: URLSearchParams, fallback: PeriodChoice): PeriodChoice {
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (from && to && isValidCustom(from, to)) return { preset: "custom", from, to };
  const preset = params.get("period");
  if (preset && preset in PRESET_LABEL) return { preset: preset as keyof typeof PRESET_LABEL };
  return fallback;
}

/** The query parameters of a period choice (and the month cleared: a period and a month never travel together). */
export function periodPatch(choice: PeriodChoice): UrlPatch {
  return choice.preset === "custom"
    ? { period: null, from: choice.from, to: choice.to, month: null }
    : { period: choice.preset, from: null, to: null, month: null };
}

/** Choosing a month replaces the period. */
export function monthPatch(month: MonthKey): UrlPatch {
  return { month, period: null, from: null, to: null };
}

/** What the server is asked for: `month=YYYY-MM` when a month is chosen, else the period's own parameters. */
export function periodQuery(choice: PeriodChoice, month: MonthKey | null): Record<string, string> {
  if (month) return { month };
  return choice.preset === "custom" ? { from: choice.from, to: choice.to } : { period: choice.preset };
}

/** A key that changes whenever the period does: PeriodBar keeps its custom dates in its own state, so it is re-mounted
 *  with this key when the address changes the period from outside (a month picked, Back, a shared link). */
export function periodKey(choice: PeriodChoice, month: MonthKey | null): string {
  if (month) return `m:${month}`;
  return choice.preset === "custom" ? `c:${choice.from}:${choice.to}` : `p:${choice.preset}`;
}

// ── scope (unit / department / staff-production) ───────────────────────────────────────────────────────────────────

export function scopeFromParams(params: URLSearchParams): ScopeChoice {
  const type = params.get("type");
  return {
    branch: params.get("branch") ?? EVERYONE.branch,
    department: params.get("department") ?? EVERYONE.department,
    type: type === "staff" || type === "production" ? type : "",
  };
}

export function scopePatch(scope: ScopeChoice): UrlPatch {
  return { branch: scope.branch || null, department: scope.department || null, type: scope.type || null };
}

// ── small values ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A parameter that must be one of `allowed`, else `fallback`. */
export function oneOf<T extends string>(params: URLSearchParams, name: string, allowed: readonly T[], fallback: T): T {
  const raw = params.get(name);
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** A whole number of at least 1 (a page number), else 1. */
export function pageFromParams(params: URLSearchParams, name = "page"): number {
  const n = Number(params.get(name));
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
