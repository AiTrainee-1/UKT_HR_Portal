// The pure part of the Outpass & Visitors page: shaping what the server sends into what the cards show (labels, bars,
// slices, heatmap window, KPI texts). No React here, so every rule has a plain unit test (logic.test.ts).

import type { BarItem } from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import type { DonutSlice } from "@/components/md/kit/DonutChart";
import { kpiDelta, type KpiDelta } from "@/components/md/kit/dto";
import type { StatTone } from "@/components/md/kit/StatCard";
import type { AssistantPageContext } from "@/lib/md/assistant-store";
import { clockText, dayShort, minutesText, num, pct } from "@/lib/md/format";
import type { MdKpiFormat } from "@/lib/md/types";
import type {
  AgingBucket,
  DepartmentRow,
  DurationBucket,
  ExceptionsResponse,
  Funnel,
  GateScans,
  HostDepartment,
  Heatmap,
  Metric,
  PurposeCategory,
  ReasonRow,
  SummaryResponse,
  TrendPoint,
  TrendResponse,
} from "./types";

// ─── small texts ───────────────────────────────────────────────────────────────────────────────────────────────

export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** How long something has waited, in a sentence: "35 minutes", "5 hours", "3 days 4 hours". */
export function waitText(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  if (minutes < 60) return `${minutes} ${plural(minutes, "minute")}`;
  if (minutes < 48 * 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours} ${plural(hours, "hour")}`;
  }
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  return `${days} days${hours ? ` ${hours} ${plural(hours, "hour")}` : ""}`;
}

const PERIOD_PHRASE: Record<string, string> = {
  today: "today",
  yesterday: "yesterday",
  last_7_days: "in the last 7 days",
  last_30_days: "in the last 30 days",
  last_90_days: "in the last 90 days",
  this_week: "this week",
  last_week: "last week",
  this_month: "this month",
  last_month: "last month",
  last_12_months: "in the last 12 months",
  this_year: "this year",
  this_fy: "this financial year",
};

/** The period as it reads inside a question for the assistant: "in the last 30 days", "between 01 Sep – 15 Sep 2026". */
export function periodPhrase(period: { preset: string | null; label: string; days: number } | undefined): string {
  if (!period) return "in this period";
  if (period.preset && PERIOD_PHRASE[period.preset]) return PERIOD_PHRASE[period.preset];
  if (period.preset === "month") return `in ${period.label}`;
  return period.days === 1 ? `on ${period.label}` : `between ${period.label}`;
}

/** "2026-09-22T10:15:00" -> "22 Sep · 10:15 am". */
export function stampText(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${dayShort(iso)} · ${clockText(iso)}`;
}

/** 0 -> "today", 1 -> "yesterday", 6 -> "6 days ago". */
export function daysAgoText(days: number): string {
  if (days <= 0) return "today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** "Showing 26-50 of 312". */
export function rangeText(page: number, pageSize: number, total: number, shown: number): string {
  if (total === 0 || shown === 0) return "Nothing to show";
  const from = (page - 1) * pageSize + 1;
  return `Showing ${num(from)}–${num(from + shown - 1)} of ${num(total)}`;
}

/** The server's notes the banner should show. The standing limits are written next to the figures they limit (no
 *  check-out under Visitors), and "today is in progress" only matters for a short period that ends today. */
export const NO_CHECKOUT_PREFIX = "Visitors are recorded at check-in only";
export const NO_COMPANY_PREFIX = "The gate form does not ask for a company";
const IN_PROGRESS_PREFIX = "Today is still in progress";

export function bannerNotes(notes: string[] | undefined, periodDays: number | undefined): string[] {
  return (notes ?? []).filter((n) => {
    if (n.startsWith(NO_CHECKOUT_PREFIX) || n.startsWith(NO_COMPANY_PREFIX)) return false;
    if (n.startsWith(IN_PROGRESS_PREFIX)) return (periodDays ?? 99) <= 7;
    return true;
  });
}

// ─── KPI strip ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The change chip of a metric: coloured by whether the direction is good news (null = neither). */
export function metricDelta(
  metric: Metric | undefined,
  format: MdKpiFormat,
  good: "up" | "down" | null,
): KpiDelta | null {
  if (!metric?.change) return null;
  return kpiDelta({ format, delta: { abs: metric.change.abs, pct: metric.change.pct, good } });
}

export type KpiKey =
  "visits" | "peak" | "outpasses" | "hoursOut" | "returnRate" | "waiting" | "approvalTime" | "rejection";

export type KpiSpec = {
  key: KpiKey;
  label: string;
  value: string;
  sub: string | null;
  tone: StatTone;
  delta: KpiDelta | null;
  /** Provenance entries that explain the figure. */
  provenanceIds: string[];
};

export const KPI_KEYS: KpiKey[] = [
  "visits",
  "peak",
  "outpasses",
  "hoursOut",
  "returnRate",
  "waiting",
  "approvalTime",
  "rejection",
];

export const KPI_LABELS: Record<KpiKey, string> = {
  visits: "Visits",
  peak: "Busiest hour",
  outpasses: "Outpass requests",
  hoursOut: "Time out on outpasses",
  returnRate: "Return rate",
  waiting: "Waiting for approval",
  approvalTime: "Time to decide",
  rejection: "Rejection rate",
};

function returnTone(rate: number | null): StatTone {
  if (rate == null) return "slate";
  if (rate >= 90) return "green";
  if (rate >= 70) return "amber";
  return "red";
}

export function buildKpis(s: SummaryResponse): KpiSpec[] {
  const v = s.visitors;
  const o = s.outpass;
  const decided = (o.approved.value ?? 0) + (o.rejected.value ?? 0);
  const peakDay = v.peakDay;
  const waiting = o.waitingNow;
  return [
    {
      key: "visits",
      label: KPI_LABELS.visits,
      value: num(v.visits.value),
      sub: `${num(v.uniqueVisitors.value)} unique ${plural(v.uniqueVisitors.value ?? 0, "visitor")}`,
      tone: "blue",
      delta: metricDelta(v.visits, "number", null),
      provenanceIds: ["visits"],
    },
    {
      key: "peak",
      label: KPI_LABELS.peak,
      value: v.peakHour ? hourText(v.peakHour.hour) : "—",
      sub: peakDay
        ? `${num(v.peakHour?.visits)} ${plural(v.peakHour?.visits ?? 0, "visit")} · busiest day ${peakDay.weekday} ${dayShort(peakDay.date)} (${num(peakDay.visits)})`
        : "No visits in this period",
      tone: "teal",
      delta: null,
      provenanceIds: ["peak"],
    },
    {
      key: "outpasses",
      label: KPI_LABELS.outpasses,
      value: num(o.requests.value),
      sub: `${num(o.approved.value)} approved · ${num(o.rejected.value)} rejected · ${num(o.pending.value)} waiting`,
      tone: "indigo",
      delta: metricDelta(o.requests, "number", "down"),
      provenanceIds: ["passes"],
    },
    {
      key: "hoursOut",
      label: KPI_LABELS.hoursOut,
      value: o.minutesOut.value == null ? "—" : minutesText(o.minutesOut.value),
      sub:
        o.avgMinutesOut.value == null
          ? "No pass scanned back in yet"
          : `${minutesText(o.avgMinutesOut.value)} on average per pass`,
      tone: "amber",
      delta: metricDelta(o.minutesOut, "minutes", "down"),
      provenanceIds: ["hours-out"],
    },
    {
      key: "returnRate",
      label: KPI_LABELS.returnRate,
      value: pct(o.returnRatePct.value),
      sub: `${num(o.notReturned.value)} never returned` + (o.outsideNow > 0 ? ` · ${num(o.outsideNow)} out now` : ""),
      tone: returnTone(o.returnRatePct.value),
      delta: metricDelta(o.returnRatePct, "pct", "up"),
      provenanceIds: ["return-rate"],
    },
    {
      key: "waiting",
      label: KPI_LABELS.waiting,
      value: num(waiting.waiting),
      sub:
        waiting.waiting === 0
          ? "No request is undecided"
          : waiting.overOneDay > 0
            ? `${num(waiting.overOneDay)} over 24 hours · oldest ${waitText(waiting.oldestMinutes)}`
            : `Oldest ${waitText(waiting.oldestMinutes)}`,
      tone: waiting.overOneDay > 0 ? "red" : waiting.waiting > 0 ? "amber" : "green",
      delta: null,
      provenanceIds: ["waiting"],
    },
    {
      key: "approvalTime",
      label: KPI_LABELS.approvalTime,
      value: o.turnaroundAvgMinutes.value == null ? "—" : minutesText(o.turnaroundAvgMinutes.value),
      sub:
        o.turnaroundMedianMinutes.value == null
          ? "No request approved in this period"
          : `Half were decided within ${minutesText(o.turnaroundMedianMinutes.value)}`,
      tone: "purple",
      delta: metricDelta(o.turnaroundAvgMinutes, "minutes", "down"),
      provenanceIds: ["turnaround"],
    },
    {
      key: "rejection",
      label: KPI_LABELS.rejection,
      value: pct(o.rejectionRatePct.value),
      sub: decided > 0 ? `${num(o.rejected.value)} of ${num(decided)} decided` : "Nothing decided yet",
      tone: "slate",
      delta: metricDelta(o.rejectionRatePct, "pct", null),
      provenanceIds: ["approvals"],
    },
  ];
}

// ─── trend ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type TrendView = "counts" | "time";

export function trendRows(points: TrendPoint[]): Record<string, string | number>[] {
  return points.map((p) => ({
    key: p.key,
    visits: p.visits,
    passes: p.passes,
    gateFormExits: p.gateFormExits,
    minutesOut: p.minutesOut,
  }));
}

/** The x-axis label: a day ("22 Sep") or, once the trend is weekly, the Monday the week starts on ("Wk 21 Sep"). */
export function trendLabel(granularity: TrendResponse["granularity"]): (key: string) => string {
  return (key) => (granularity === "week" ? `Wk ${dayShort(key)}` : dayShort(key));
}

export const hasTrendData = (points: TrendPoint[] | undefined) =>
  !!points && points.some((p) => p.visits > 0 || p.passes > 0 || p.gateFormExits > 0);

// ─── visitors section ──────────────────────────────────────────────────────────────────────────────────────────

const OTHER = "other";

export function purposeSlices(categories: PurposeCategory[]): DonutSlice[] {
  let n = 0;
  return categories.map((c) => ({
    name: c.label,
    value: c.visits,
    color: c.key === OTHER ? CHART.slate : CHART.series[n++ % (CHART.series.length - 1)],
  }));
}

export function hostDepartmentItems(
  rows: HostDepartment[],
  notLinked: { visits: number; sharePct: number | null },
): BarItem[] {
  const items: BarItem[] = rows.map((r) => ({
    key: r.department,
    label: r.department,
    value: r.visits,
    display: num(r.visits),
    sub: `${num(r.uniqueVisitors)} ${plural(r.uniqueVisitors, "visitor")} · ${pct(r.sharePct, 0)} of visits`,
  }));
  if (notLinked.visits > 0) {
    items.push({
      key: "__not-linked",
      label: "Not matched to an employee",
      value: notLinked.visits,
      display: num(notLinked.visits),
      sub: `The visitor typed a name the gate form could not match · ${pct(notLinked.sharePct, 0)} of visits`,
      color: CHART.slate,
    });
  }
  return items;
}

/** 11 -> "11 am", 14 -> "2 pm", 0 -> "12 am": an hour of the day as people say it. */
export function hourText(hour: number): string {
  return `${hour % 12 || 12} ${hour < 12 ? "am" : "pm"}`;
}

/** "12a", "9a", "12p", "3p": the hour headings of the grid. */
export function hourHeading(hour: number): string {
  if (hour === 0) return "12a";
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return "12p";
  return `${hour - 12}p`;
}

export type HeatmapView = { rows: string[]; cols: string[]; values: (number | null)[][]; hours: number[] };

/** The weekday x hour grid trimmed to the hours that matter: the working day (8 to 6) plus any hour that had a visit.
 *  A cell with no visits is null (shown as a faint dot) rather than a dark 0. */
export function heatmapWindow(grid: Heatmap, startHour = 8, endHour = 17): HeatmapView {
  let lo = startHour;
  let hi = endHour;
  grid.values.forEach((row) =>
    row.forEach((count, hour) => {
      if (count > 0) {
        lo = Math.min(lo, hour);
        hi = Math.max(hi, hour);
      }
    }),
  );
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return {
    rows: grid.weekdays,
    cols: hours.map(hourHeading),
    values: grid.values.map((row) => hours.map((h) => (row[h] > 0 ? row[h] : null))),
    hours,
  };
}

// ─── outpass section ───────────────────────────────────────────────────────────────────────────────────────────

export function funnelItems(f: Funnel): BarItem[] {
  const share = (n: number) => (f.requested > 0 ? `${Math.round((n / f.requested) * 100)}% of requests` : undefined);
  return [
    { key: "requested", label: "Asked to leave", value: f.requested, display: num(f.requested), color: CHART.light },
    {
      key: "approved",
      label: "Approved",
      value: f.approved,
      display: num(f.approved),
      sub: share(f.approved),
      color: CHART.sky,
    },
    {
      key: "left",
      label: "Left through the gate",
      value: f.left,
      display: num(f.left),
      sub: share(f.left),
      color: CHART.brand,
    },
    {
      key: "returned",
      label: "Scanned back in",
      value: f.returned,
      display: num(f.returned),
      sub: share(f.returned),
      color: CHART.deep,
    },
  ];
}

export type DropOff = { key: string; label: string; count: number; tone: "bad" | "warn" | "neutral" };

/** Where the requests that did not make it to the next step went. Only what happened at least once is listed. */
export function dropOffs(f: Funnel): DropOff[] {
  const d = f.dropOffs;
  const all: DropOff[] = [
    { key: "rejected", label: "Rejected", count: d.rejected, tone: "neutral" },
    { key: "waiting", label: "Still waiting for a decision", count: d.waiting, tone: "warn" },
    { key: "approvedNotUsed", label: "Approved but never used", count: d.approvedNotUsed, tone: "warn" },
    { key: "notReturned", label: "Never returned", count: d.notReturned, tone: "bad" },
    { key: "outsideNow", label: "Outside right now", count: d.outsideNow, tone: "neutral" },
    { key: "earlyDismissal", label: "Left early (not expected back)", count: d.earlyDismissal, tone: "neutral" },
  ];
  return all.filter((x) => x.count > 0);
}

const joinSub = (parts: (string | null | false | undefined)[]) => parts.filter(Boolean).join(" · ");

export function departmentItems(rows: DepartmentRow[], count: number): BarItem[] {
  return rows.slice(0, count).map((r) => ({
    key: r.department,
    label: r.department,
    value: r.minutesOut ?? 0,
    display: r.minutesOut == null ? "—" : minutesText(r.minutesOut),
    sub: joinSub([
      `${num(r.requests)} ${plural(r.requests, "request")}`,
      r.avgMinutes != null && `avg ${minutesText(r.avgMinutes)}`,
      r.requestsPer100 != null && `${num(r.requestsPer100, Number.isInteger(r.requestsPer100) ? 0 : 1)} per 100 staff`,
      r.notReturned > 0 && `${num(r.notReturned)} never returned`,
    ]),
  }));
}

export function reasonItems(rows: ReasonRow[]): BarItem[] {
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    value: r.requests,
    display: num(r.requests),
    sub:
      r.minutesOut == null
        ? "No pass scanned back in yet"
        : `${minutesText(r.minutesOut)} out · avg ${minutesText(r.avgMinutes)}`,
  }));
}

export function durationItems(buckets: DurationBucket[]): BarItem[] {
  return buckets.map((b) => ({
    key: b.key,
    label: b.label,
    value: b.passes,
    display: num(b.passes),
    sub: b.sharePct == null ? undefined : `${pct(b.sharePct, 0)} of returned passes`,
  }));
}

const AGING_COLORS: Record<string, string> = {
  under_1h: CHART.good,
  "1_4h": CHART.teal,
  "4_24h": CHART.warn,
  over_24h: CHART.bad,
};

export function agingItems(buckets: AgingBucket[]): BarItem[] {
  return buckets.map((b) => ({
    key: b.key,
    label: b.label,
    value: b.count,
    display: num(b.count),
    color: AGING_COLORS[b.key] ?? CHART.slate,
  }));
}

export function refusalItems(scans: GateScans): BarItem[] {
  return scans.byReason.map((r) => ({
    key: r.key,
    label: r.label,
    value: r.count,
    display: num(r.count),
    color: CHART.bad,
  }));
}

// ─── exceptions ────────────────────────────────────────────────────────────────────────────────────────────────

export type ExceptionTab = "repeat" | "notReturned" | "long" | "waiting" | "afterHours";

export const EXCEPTION_LABELS: Record<ExceptionTab, string> = {
  repeat: "Repeat outpass users",
  notReturned: "Not returned",
  long: "Long outpasses",
  waiting: "Approvals waiting",
  afterHours: "After-hours visits",
};

export function exceptionTabs(
  e: ExceptionsResponse | undefined,
): { value: ExceptionTab; label: string; count?: number }[] {
  const counts: Record<ExceptionTab, number | undefined> = {
    repeat: e?.repeatOutpass.total,
    notReturned: e?.notReturned.total,
    long: e?.longOutpasses.total,
    waiting: e?.approvalsWaiting.total,
    afterHours: e?.afterHoursVisits.total,
  };
  return (Object.keys(EXCEPTION_LABELS) as ExceptionTab[]).map((value) => ({
    value,
    label: EXCEPTION_LABELS[value],
    count: counts[value],
  }));
}

/** The rule behind a tab, in a sentence, so the MD can see what "repeat" or "long" means for this period. */
export function exceptionRule(tab: ExceptionTab, e: ExceptionsResponse): string {
  const t = e.thresholds;
  switch (tab) {
    case "repeat":
      return `Employees with ${t.repeatOutpass.forThisPeriod} or more approved outpasses in this period (${t.repeatOutpass.per30Days} in 30 days, scaled to the length of the period).`;
    case "notReturned":
      return "Passes scanned out on an earlier day with no return scan, and people who left today and are not back yet. Early-dismissal passes are not expected back and are left out.";
    case "long":
      return `Passes that lasted ${minutesText(t.longOutpass.forThisPeriod)} or more: the longer of ${minutesText(t.longOutpass.minMinutes)} and ${t.longOutpass.factorOfTypical}× the typical pass${
        t.longOutpass.typicalMinutes != null ? ` (${minutesText(t.longOutpass.typicalMinutes)})` : ""
      }.`;
    case "waiting":
      return `Requests still undecided after ${t.approvalWaitHours} hours, across all dates (not limited to the period), oldest first.`;
    case "afterHours":
      return `Check-ins ${t.afterHours.label}. Visitors who came ${e.frequentVisitors.minimum} or more times are in the repeat-visitors table above.`;
  }
}

export const EMPTY_TEXT: Record<ExceptionTab, string> = {
  repeat: "Nobody took that many outpasses in this period.",
  notReturned: "Every pass that left was scanned back in.",
  long: "No outpass was far longer than usual.",
  waiting: "No request has waited more than a day.",
  afterHours: "Every visit was inside opening hours.",
};

// ─── the assistant ─────────────────────────────────────────────────────────────────────────────────────────────

export function assistantContext(args: {
  periodLabel: string;
  scopeText: string;
  summary?: SummaryResponse;
}): AssistantPageContext {
  const { periodLabel, scopeText, summary } = args;
  const v = summary?.visitors;
  const o = summary?.outpass;
  return {
    page: "visitors",
    title: "Outpass & Visitors",
    filters: { Period: periodLabel, Scope: scopeText },
    summary: summary
      ? {
          Visits: v?.visits.value ?? null,
          "Unique visitors": v?.uniqueVisitors.value ?? null,
          "Outpass requests": o?.requests.value ?? null,
          "Time out on outpasses": o?.minutesOut.value == null ? null : minutesText(o.minutesOut.value),
          "Return rate": o?.returnRatePct.value == null ? null : pct(o.returnRatePct.value),
          "Never returned": o?.notReturned.value ?? null,
          "Waiting for approval": o?.waitingNow.waiting ?? null,
        }
      : undefined,
  };
}
