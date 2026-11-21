import { monthLabel, thisMonthKey, type MonthKey } from "@/components/md/kit/MonthPicker";
import {
  EVERYONE,
  PRESET_LABEL,
  isValidCustom,
  periodParams,
  scopeParams,
  type PeriodChoice,
  type PeriodPreset,
  type ScopeChoice,
} from "@/lib/md/period";

// The filters of an MD Insights tab (2026-11-21): WHEN (a month + year, or a preset / custom range) and WHO (unit,
// department, staff / production), plus a page's own extras (a kind of request, a gate). Every Insights tab uses these, so a
// month means the same thing everywhere, and the choice lives in the address (prefixed "i.", so it never clashes with the HR
// page's own ?tab= / ?kind=) so a refresh or a shared link keeps it.

export type InsightsWhen = { mode: "month"; month: MonthKey } | { mode: "period"; period: PeriodChoice };

export type InsightsFilters = {
  when: InsightsWhen;
  scope: ScopeChoice;
  /** A page's own filters, by name ("kind" -> "leave"). Empty strings are "not chosen". */
  extra: Record<string, string>;
};

export type InsightsDefaults = {
  when?: InsightsWhen;
  scope?: ScopeChoice;
  extra?: Record<string, string>;
};

const PREFIX = "i.";
const PRESETS = Object.keys(PRESET_LABEL) as PeriodPreset[];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const thisMonth = (now = new Date()): InsightsWhen => ({ mode: "month", month: thisMonthKey(now) });
export const lastDays = (preset: PeriodPreset = "last_30_days"): InsightsWhen => ({
  mode: "period",
  period: { preset },
});

/** What the server is asked for. The month that is running is sent as "this_month" (the 1st to today) so no figure counts
 *  days that have not happened; an earlier month goes as the whole month. */
export function whenParams(when: InsightsWhen, now = new Date()): Record<string, string> {
  if (when.mode === "month") {
    return when.month === thisMonthKey(now) ? { period: "this_month" } : { month: when.month };
  }
  return periodParams(when.period);
}

/** Everything the server is asked for: when, who and the page's extras (an empty extra is left out). */
export function filterParams(filters: InsightsFilters, now = new Date()): Record<string, string> {
  const out: Record<string, string> = { ...whenParams(filters.when, now), ...scopeParams(filters.scope) };
  for (const [key, value] of Object.entries(filters.extra)) if (value) out[key] = value;
  return out;
}

/** "Nov 2026 (so far)", "Oct 2026", "Last 30 days", "01 Nov 2026 to 15 Nov 2026". */
export function whenLabel(when: InsightsWhen, now = new Date()): string {
  if (when.mode === "month") {
    return when.month === thisMonthKey(now) ? `${monthLabel(when.month)} (so far)` : monthLabel(when.month);
  }
  const p = when.period;
  return p.preset === "custom" ? `${p.from} to ${p.to}` : PRESET_LABEL[p.preset];
}

/** The month a choice falls in (a period's own month is not known here, so a period gives this month). */
export const whenMonth = (when: InsightsWhen, now = new Date()): MonthKey =>
  when.mode === "month" ? when.month : thisMonthKey(now);

function readWhen(p: URLSearchParams, fallback: InsightsWhen, now: Date): InsightsWhen {
  const month = p.get(`${PREFIX}month`);
  if (month && MONTH_RE.test(month) && month <= thisMonthKey(now)) return { mode: "month", month };
  const from = p.get(`${PREFIX}from`);
  const to = p.get(`${PREFIX}to`);
  if (from && to && isValidCustom(from, to)) return { mode: "period", period: { preset: "custom", from, to } };
  const preset = p.get(`${PREFIX}period`);
  if (preset && (PRESETS as string[]).includes(preset)) {
    return { mode: "period", period: { preset: preset as PeriodPreset } };
  }
  return fallback;
}

/** The filters an address asks for, falling back to the page's defaults for anything missing or unusable. */
export function readFilters(search: string, defaults: InsightsDefaults = {}, now = new Date()): InsightsFilters {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const scopeDefault = defaults.scope ?? EVERYONE;
  const type = p.get(`${PREFIX}type`);
  const extra: Record<string, string> = { ...(defaults.extra ?? {}) };
  for (const key of Object.keys(extra)) {
    const value = p.get(`${PREFIX}${key}`);
    if (value !== null) extra[key] = value;
  }
  return {
    when: readWhen(p, defaults.when ?? thisMonth(now), now),
    scope: {
      branch: p.get(`${PREFIX}unit`) ?? scopeDefault.branch,
      department: p.get(`${PREFIX}dept`) ?? scopeDefault.department,
      type: type === "staff" || type === "production" ? type : type === "" ? "" : scopeDefault.type,
    },
    extra,
  };
}

/** The address with the filters written in (only what differs from the defaults; the HR page's own parameters kept). */
export function writeFilters(
  search: string,
  filters: InsightsFilters,
  defaults: InsightsDefaults = {},
  now = new Date(),
) {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const key of Array.from(p.keys())) if (key.startsWith(PREFIX)) p.delete(key);
  const base = readFilters("", defaults, now);
  const { when, scope, extra } = filters;
  if (JSON.stringify(when) !== JSON.stringify(base.when)) {
    if (when.mode === "month") p.set(`${PREFIX}month`, when.month);
    else if (when.period.preset === "custom") {
      p.set(`${PREFIX}from`, when.period.from);
      p.set(`${PREFIX}to`, when.period.to);
    } else p.set(`${PREFIX}period`, when.period.preset);
  }
  if (scope.branch !== base.scope.branch) p.set(`${PREFIX}unit`, scope.branch);
  if (scope.department !== base.scope.department) p.set(`${PREFIX}dept`, scope.department);
  if (scope.type !== base.scope.type) p.set(`${PREFIX}type`, scope.type);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== (base.extra[key] ?? "")) p.set(`${PREFIX}${key}`, value);
  }
  const text = p.toString();
  return text ? `?${text}` : "";
}
