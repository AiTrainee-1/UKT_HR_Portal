// Pure helpers of the Activity Logs page: shaping what the server sends for the kit components, the wording of every
// small label, and the questions the "Ask AI" buttons carry. No React in here, so each rule has a plain unit test.

import type { BarItem } from "@/components/md/kit/BarList";
import { kpiDelta, type KpiDelta } from "@/components/md/kit/dto";
import type { StatTone } from "@/components/md/kit/StatCard";
import { clockText, dayShort, num, pct, signed, weekdayShort } from "@/lib/md/format";
import { PRESET_LABEL, periodParams, type PeriodChoice } from "@/lib/md/period";
import type {
  ActivityHeatmap,
  ActivitySummary,
  ActivityTrend,
  AfterKind,
  AreaRow,
  CategoryId,
  Change,
  Severity,
  TrendPoint,
} from "./types";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium"];
export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium" };

/** The order the filter chips and the rule table list the categories in (the server's order). */
export const CATEGORY_ORDER: CategoryId[] = ["access", "deletion", "payroll", "bulk", "export", "settings", "backup"];

/** The most rows the server returns for one request. */
export const MAX_PAGE_SIZE = 100;
export const PAGE_STEP = 10;

export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** The letters of an avatar: the first letter of the first two words of a name ("S. Ramanathan" is "SR", "admin" is "A"). */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").replace(/\([^)]*\)/g, " ").match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

// ─── changes against the previous period ──────────────────────────────────────────────────────────────────────

/** The chip beside a headline figure. `good` is the direction that is good news ("down" for failed sign-ins), or null
 *  when neither direction is: more actions is not good or bad in itself, so the chip stays neutral. */
export function deltaOf(change: Change, good: "up" | "down" | null): KpiDelta | null {
  if (!change) return null;
  return kpiDelta({ format: "number", delta: { abs: change.abs, pct: change.pct, good } });
}

/** "+4 (+80%)", "no change", "+1 (new)" when there was nothing before to take a percentage of. */
export function changeText(change: Change): string {
  if (!change) return "—";
  if (change.abs === 0) return "no change";
  if (change.pct == null) return `${signed(change.abs, 0)} (new)`;
  return `${signed(change.abs, 0)} (${signed(change.pct, 0)}%)`;
}

/** "Previous 7 days: 5". */
export const previousText = (label: string, previous: number) => `${label}: ${num(previous)}`;

// ─── the headline tiles ───────────────────────────────────────────────────────────────────────────────────────

export const peopleSub = (enabled: number) => `of ${num(enabled)} enabled ${plural(enabled, "account")}`;

/** "1 critical · 4 high · 3 medium", leaving out what is zero. */
export function severitySub(s: Pick<ActivitySummary["sensitive"], Severity>): string {
  const parts = SEVERITY_ORDER.filter((k) => s[k] > 0).map((k) => `${num(s[k])} ${SEVERITY_LABEL[k].toLowerCase()}`);
  return parts.length > 0 ? parts.join(" · ") : "None in this period";
}

export function afterHoursSub(a: Pick<ActivitySummary["afterHours"], "value" | "sharePct" | "weekend">): string {
  if (a.value === 0) return "None outside working hours";
  const parts = [
    a.sharePct != null ? `${pct(a.sharePct)} of actions` : null,
    a.weekend > 0 ? `${num(a.weekend)} on Sunday` : null,
  ];
  return parts.filter(Boolean).join(" · ") || "Outside working hours";
}

export const signInsSub = (people: number) => `${num(people)} ${plural(people, "person", "people")}`;

export function failedSub(f: Pick<ActivitySummary["failedSignIns"], "lockouts" | "blockedAttempts">): string {
  const parts = [
    f.lockouts > 0 ? `${num(f.lockouts)} ${plural(f.lockouts, "lock-out")}` : null,
    f.blockedAttempts > 0 ? `${num(f.blockedAttempts)} blocked ${plural(f.blockedAttempts, "try", "tries")}` : null,
  ];
  return parts.filter(Boolean).join(" · ") || "No lock-outs";
}

/** Crimson for a critical change or a lock-out, ochre for anything else sensitive, sage when there is none. */
export function alertTone(serious: number, any: number): StatTone {
  return serious > 0 ? "red" : any > 0 ? "amber" : "green";
}

// ─── trend ────────────────────────────────────────────────────────────────────────────────────────────────────

export type TrendRow = { date: string; actions: number; sensitive: number; afterHours: number };

export const trendRows = (t: ActivityTrend): TrendRow[] =>
  t.points.map((p) => ({ date: p.date, actions: p.actions, sensitive: p.sensitive, afterHours: p.afterHours }));

/** One column of the trend as a sparkline series (the tiles borrow the chart's data). */
export const sparkOf = (
  t: ActivityTrend | undefined,
  key: keyof Omit<TrendPoint, "date" | "end">,
): number[] | undefined => t?.points.map((p) => p[key]);

/** "Busiest day: Fri 02 Oct (4 actions) · 1.9 a day". Weekly points say so, since the labels are the week's first day. */
export function trendCaption(t: ActivityTrend): string {
  const parts: string[] = [];
  if (t.busiest) {
    const unit = t.granularity === "week" ? "week" : "day";
    const when =
      t.granularity === "week"
        ? dayShort(t.busiest.date)
        : `${weekdayShort(t.busiest.date)} ${dayShort(t.busiest.date)}`;
    parts.push(`Busiest ${unit}: ${when} (${num(t.busiest.actions)} ${plural(t.busiest.actions, "action")})`);
  }
  if (t.averagePerDay != null) parts.push(`${num(t.averagePerDay, 1)} a day on average`);
  if (t.granularity === "week") parts.push("each point is a week (Monday to Sunday), named by its first day");
  return parts.join(" · ");
}

// ─── heatmap ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Column heading: "12a", "7a", "12p", "9p". */
export const hourLabel = (hour: number) => `${hour % 12 || 12}${hour < 12 ? "a" : "p"}`;

/** In a sentence: "4 pm". */
export const hourText = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? "am" : "pm"}`;

/** Weekday rows by hour columns for the Heatmap kit. An hour with no actions is left blank rather than printed as 0. */
export function heatmapShape(h: Pick<ActivityHeatmap, "rows" | "hours" | "values">) {
  return {
    rows: h.rows,
    cols: h.hours.map(hourLabel),
    values: h.values.map((row) => row.map((v) => (v === 0 ? null : v))),
  };
}

/** "Fri 4 pm (3 actions)" or null when nothing happened. */
export function peakText(h: Pick<ActivityHeatmap, "peak">): string | null {
  if (!h.peak) return null;
  return `${h.peak.weekday} ${hourText(h.peak.hour)} (${num(h.peak.count)} ${plural(h.peak.count, "action")})`;
}

/** "4 of 13 actions (30.8%) were outside working hours: 3 at night, 1 on Sunday". */
export function afterHoursText(
  events: number,
  total: number,
  sharePct: number | null,
  weekend: number,
  night: number,
): string {
  if (events === 0) return "Nothing was done outside working hours.";
  const split = [night > 0 ? `${num(night)} at night` : null, weekend > 0 ? `${num(weekend)} on Sunday` : null].filter(
    Boolean,
  );
  const share = sharePct != null ? ` (${pct(sharePct)})` : "";
  return `${num(events)} of ${num(total)} ${plural(total, "action")}${share} ${events === 1 ? "was" : "were"} outside working hours: ${split.join(", ")}.`;
}

export function afterKindText(kind: AfterKind): string | null {
  return kind === "weekend" ? "Sunday" : kind === "night" ? "After hours" : null;
}

// ─── areas ────────────────────────────────────────────────────────────────────────────────────────────────────

export const AREAS_SHOWN = 8;

function areaSub(a: AreaRow): string {
  const parts = [`${pct(a.sharePct)} of actions`];
  if (a.sensitive > 0) parts.push(`${num(a.sensitive)} sensitive`);
  parts.push(`${changeText(a.change)} vs before`);
  return parts.join(" · ");
}

export function areaBars(rows: AreaRow[], showAll: boolean, limit = AREAS_SHOWN): BarItem[] {
  return (showAll ? rows : rows.slice(0, limit)).map((a) => ({
    key: a.area,
    label: a.label,
    value: a.actions,
    display: num(a.actions),
    sub: areaSub(a),
  }));
}

// ─── people and time ──────────────────────────────────────────────────────────────────────────────────────────

/** "Sat 03 Oct, 8:59 pm" from the server's wall-clock timestamp. */
export function whenText(iso: string | null | undefined): string {
  if (!iso) return "—";
  const day = iso.slice(0, 10);
  return `${weekdayShort(day)} ${dayShort(day)}, ${clockText(iso)}`;
}

/** "Never", "today", "yesterday", "12 days ago". */
export function daysSinceText(days: number | null): string {
  if (days == null) return "Never";
  if (days <= 0) return "today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** "× 120" for a line that stands for many audit rows (a bulk upload). */
export const countText = (count: number): string | null => (count > 1 ? `× ${num(count)}` : null);

// ─── the sensitive feed ───────────────────────────────────────────────────────────────────────────────────────

/** "Show more" asks for ten more at a time, up to what the server will return in one go. */
export const nextPageSize = (current: number) => Math.min(MAX_PAGE_SIZE, current + PAGE_STEP);

export const canShowMore = (total: number, shown: number, pageSize: number) =>
  shown < total && pageSize < MAX_PAGE_SIZE;

/** The query of the feed: the period, the page, and only the filters that are set. */
export function feedParams(
  period: PeriodChoice,
  opts: { pageSize: number; q?: string; category?: CategoryId | null; user?: string | null },
): Record<string, string | number> {
  const out: Record<string, string | number> = { ...periodParams(period), page: 1, pageSize: opts.pageSize };
  if (opts.q?.trim()) out.q = opts.q.trim();
  if (opts.category) out.category = opts.category;
  if (opts.user) out.user = opts.user;
  return out;
}

// ─── the assistant ────────────────────────────────────────────────────────────────────────────────────────────

export function periodLabel(period: PeriodChoice): string {
  return period.preset === "custom" ? `${period.from} to ${period.to}` : PRESET_LABEL[period.preset];
}

/** The headline numbers the assistant is told are on screen. */
export function assistantSummary(s: ActivitySummary | undefined): Record<string, string | number> | undefined {
  if (!s) return undefined;
  return {
    Actions: s.actions.value,
    "Active people": s.activeUsers.value,
    "Sensitive actions": s.sensitive.value,
    "Critical or high": s.sensitive.critical + s.sensitive.high,
    "After-hours actions": s.afterHours.value,
    "Sign-ins": s.signIns.value,
    "Failed sign-ins": s.failedSignIns.value,
    "Lock-outs": s.failedSignIns.lockouts,
  };
}

const words = (label: string) => label.toLowerCase();

export const ask = {
  page: (label: string) =>
    `Summarise system activity for ${words(label)}: who did what, anything sensitive or unusual, and how it compares with the period before.`,
  attention: () => "What stands out in the system over the last 7 days, and what should I look at first?",
  trend: (label: string) =>
    `How did system activity change over ${words(label)}? What explains the busiest days and the sensitive actions?`,
  areas: (label: string) =>
    `Which areas of the system saw the most activity over ${words(label)}, and what changed against the period before?`,
  users: (label: string) =>
    `Who was most active in the system over ${words(label)}, and does anything about their activity look unusual?`,
  heatmap: (label: string) =>
    `Is anyone working outside normal hours over ${words(label)}? When is the system busiest?`,
  sensitive: (label: string, category?: string | null) =>
    category
      ? `What ${category.toLowerCase()} actions happened over ${words(label)}, who did them and when?`
      : `What sensitive actions happened over ${words(label)}: access changes, deletions, payroll runs, bulk uploads, exports? Who did them?`,
  signIns: (label: string) =>
    `Are there any security concerns in the sign-ins over ${words(label)}: failed attempts, lock-outs, new devices, shared sessions?`,
};
