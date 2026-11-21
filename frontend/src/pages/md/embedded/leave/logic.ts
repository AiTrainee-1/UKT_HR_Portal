import type { StatTone } from "@/components/md/kit/StatCard";
import { changeTone, dayLong, num, pct, type Tone } from "@/lib/md/format";
import type { InsightsDefaults } from "../shared/filters";
import type { Drill, GroupBy, LvGroupRow, LvListItem, LvPermissions, LvSummary, LvTrend, Metric } from "./types";

export const PAGE = "leave";
export const TITLE = "Leave & Holiday";

/** The tab's defaults (a module constant: the filter hook decides what to leave out of the address by it). */
export const DEFAULTS: InsightsDefaults = {};

/** "3 days", "1 day", "0.5 day". */
export function daysText(value: number | null | undefined): string {
  if (value == null) return "—";
  const whole = Number.isInteger(value);
  return `${num(value, whole ? 0 : 1)} ${value === 1 ? "day" : "days"}`;
}

type Delta = { text: string; tone: Tone; direction?: "up" | "down" | "flat" } | null;

/** A change chip: "+3 (+50%)" for a count, "+2.1 pts" for a rate; coloured by whether the move is good news. */
export function deltaOf(
  m: Metric<number | null> | undefined,
  opts: { higherIsBetter: boolean | null; points?: boolean },
): Delta {
  const c = m?.change;
  if (!c) return null;
  const direction = c.abs > 0 ? "up" : c.abs < 0 ? "down" : "flat";
  const tone = opts.higherIsBetter === null ? "neutral" : changeTone(c.abs, opts.higherIsBetter);
  const sign = c.abs > 0 ? "+" : "";
  if (opts.points) return { text: `${sign}${Number(c.abs.toFixed(1))} pts`, tone, direction };
  const share = c.pct != null ? ` (${c.pct > 0 ? "+" : ""}${Number(c.pct.toFixed(0))}%)` : "";
  return { text: `${sign}${num(c.abs, Number.isInteger(c.abs) ? 0 : 1)}${share}`, tone, direction };
}

export type Tile = {
  id: string;
  label: string;
  value: string;
  sub?: string;
  tone: StatTone;
  delta?: Delta;
  provenanceIds: string[];
  drill?: Drill;
};

/** The eight headline figures, each opening the requests, days or people behind it. */
export function kpiTiles(s: LvSummary, permissions?: LvPermissions): Tile[] {
  const m = s.metrics;
  const period = s.period?.label ?? "this period";
  const tiles: Tile[] = [
    {
      id: "days",
      label: "Leave days taken",
      value: num(m.leaveDays.value, Number.isInteger(m.leaveDays.value) ? 0 : 1),
      sub: `${num(m.employeesOnLeave.value)} ${m.employeesOnLeave.value === 1 ? "employee" : "employees"}`,
      tone: "purple",
      delta: deltaOf(m.leaveDays, { higherIsBetter: false }),
      provenanceIds: ["leave-days", "leave-people"],
      drill: {
        title: "Leave taken",
        subtitle: `Approved leave and Casual Leave with days in ${period}`,
        params: { what: "days" },
      },
    },
    {
      id: "rate",
      label: "Leave rate",
      value: pct(m.leaveRatePct.value),
      sub: `of ${num(s.workingDays)} working days · ${num(s.eligibleHeadcount)} staff`,
      tone: "indigo",
      delta: deltaOf(m.leaveRatePct, { higherIsBetter: false, points: true }),
      provenanceIds: ["leave-rate"],
    },
    {
      id: "per-head",
      label: "Days per employee",
      value: m.daysPerEmployee.value == null ? "—" : num(m.daysPerEmployee.value, 2),
      sub: "approved leave a head",
      tone: "slate",
      delta: deltaOf(m.daysPerEmployee, { higherIsBetter: false }),
      provenanceIds: ["leave-per-employee"],
    },
    {
      id: "applied",
      label: "Requests applied",
      value: num(m.applied.value),
      sub: `${num(s.requests.approved)} approved · ${num(s.requests.rejected)} rejected`,
      tone: "blue",
      delta: deltaOf(m.applied, { higherIsBetter: null }),
      provenanceIds: ["leave-applications"],
      drill: {
        title: "Leave requests applied for",
        subtitle: `Made in ${period}, newest first`,
        params: { what: "requests" },
      },
    },
    {
      id: "rejected",
      label: "Rejected",
      value: pct(m.rejectionPct.value),
      sub: `${num(s.requests.rejected)} of ${num(s.requests.decided)} decided`,
      tone: "red",
      delta: deltaOf(m.rejectionPct, { higherIsBetter: null, points: true }),
      provenanceIds: ["leave-rejection"],
      drill: {
        title: "Rejected leave requests",
        subtitle: "With the reason the approver gave",
        params: { what: "requests", status: "rejected" },
      },
    },
    {
      id: "short",
      label: "Short notice",
      value: pct(m.shortNoticePct.value),
      sub: "applied on or after the first day",
      tone: "amber",
      delta: deltaOf(m.shortNoticePct, { higherIsBetter: false, points: true }),
      provenanceIds: ["leave-notice"],
      drill: { title: "Applied at short notice", params: { what: "requests", notice: "short" } },
    },
    {
      id: "waiting",
      label: "Waiting now",
      value: num(s.pending.count),
      sub: s.pending.count ? `oldest ${daysText(s.pending.oldestDays)}` : "nothing waiting",
      tone: s.pending.waitingTooLong ? "red" : "green",
      provenanceIds: ["leave-pending"],
      drill: {
        title: "Leave requests waiting",
        subtitle: "Oldest first, whatever date they are for",
        params: { what: "requests", status: "pending" },
      },
    },
  ];
  if (permissions) {
    const t = permissions.totals;
    tiles.push({
      id: "permissions",
      label: "Permissions over the cap",
      value: num(t.excess),
      sub: `${num(t.requested)} asked · cap ${num(permissions.cap)} a month`,
      tone: t.excess ? "amber" : "teal",
      delta: deltaOf(permissions.metrics.excess, { higherIsBetter: false }),
      provenanceIds: ["leave-permissions"],
      drill: {
        title: "Permissions beyond the monthly cap",
        subtitle: "Approved, but they shift nothing",
        params: { what: "permissions", filter: "excess" },
      },
    });
  }
  return tiles;
}

/** The list filters that narrow the "leave taken" drill-down to one group of the comparison card. */
export function groupParams(by: GroupBy, row: Pick<LvGroupRow, "key" | "label">): Record<string, string> {
  if (by === "type") return { leaveType: row.label };
  if (by === "department") return { dept: row.key === "__none__" ? "__none__" : row.label };
  if (by === "unit") return { unitName: row.key === "__none__" ? "__none__" : row.label };
  return { reason: row.label };
}

export const GROUP_TABS: { value: GroupBy; label: string }[] = [
  { value: "type", label: "Leave type" },
  { value: "reason", label: "Reason" },
  { value: "department", label: "Departments" },
  { value: "unit", label: "Units" },
];

export type TrendRow = Record<string, string | number> & { date: string };

/** The trend's rows: each leave type's days, and the previous period's days lined up by position. */
export function trendRows(t: LvTrend): TrendRow[] {
  return t.points.map((p, i) => ({
    date: p.date,
    ...p.byType,
    previous: t.previousPoints[i]?.leaveDays ?? 0,
  }));
}

export const hasTrend = (t: LvTrend) => t.totalDays > 0 || t.previousPoints.some((p) => p.leaveDays > 0);

/** One drill-down row's second line: what, for when, and where it stands. */
export function rowDetail(item: LvListItem): string {
  const parts: string[] = [];
  if (item.type) parts.push(item.type);
  if (item.date) parts.push(`${dayLong(item.date)}${item.time ? ` at ${item.time}` : ""}`);
  else if (item.from)
    parts.push(item.to && item.to !== item.from ? `${dayLong(item.from)} to ${dayLong(item.to)}` : dayLong(item.from));
  if (item.halfDay) parts.push("half day");
  if (item.daysInPeriod != null) parts.push(daysText(item.daysInPeriod));
  else if (item.days != null) parts.push(daysText(item.days));
  if (item.remaining != null) parts.push(`${daysText(item.remaining)} left`);
  return parts.join(" · ");
}

/** The figure at the right of a drill-down row. */
export function rowValue(item: LvListItem): { text: string; tone?: string } | null {
  if (item.status === "rejected") return { text: "Rejected", tone: "md-analytics-tone-bad" };
  if (item.status === "pending")
    return {
      text: item.waitingDays != null ? `Waiting ${daysText(item.waitingDays)}` : "Waiting",
      tone: "md-analytics-tone-watch",
    };
  if (item.overCap) return { text: "Over the cap", tone: "md-analytics-tone-watch" };
  if (item.carryForward || (item.carryForwardDays ?? 0) > 0)
    return { text: "Carry forward", tone: "md-analytics-tone-info" };
  if (item.status === "approved") return { text: "Approved", tone: "md-analytics-tone-good" };
  return null;
}

/** The questions the Ask AI buttons open with, about what the MD is looking at. */
export function askQuestions(period: string, selection: string | null) {
  const where = selection ? ` for ${selection}` : "";
  return {
    briefing: `Give me a briefing on leave and holidays (${period})${where}: how much leave was taken and where, who is out, what is waiting and anything unusual.`,
    attention: `What needs my attention about leave (${period})${where}, and why?`,
    trend: `How did leave change over ${period}${where}, and which types drove it?`,
    groups: `Which leave types, reasons, departments and units take the most leave (${period})${where}?`,
    out: `Who is on leave today and this week${where}?`,
    casual: `How much Casual Leave is used and left this year${where}, and who has used it up? What did HR carry forward?`,
    permissions: `How are permissions used (${period})${where}? Who goes beyond the monthly cap?`,
    approvals: `Why are leave requests rejected (${period})${where}, and what is still waiting?`,
  };
}

/** What the assistant is told the MD is looking at. */
export function assistantSummary(s: LvSummary | undefined, p?: LvPermissions): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = {
    "Leave days": daysText(s.metrics.leaveDays.value),
    "Employees on leave": num(s.metrics.employeesOnLeave.value),
    "Leave rate": pct(s.metrics.leaveRatePct.value),
    "Requests applied": num(s.metrics.applied.value),
    "Rejection rate": pct(s.metrics.rejectionPct.value),
    "Waiting now": num(s.pending.count),
  };
  if (p) out["Permissions over the cap"] = num(p.totals.excess);
  return out;
}

/** The HR Leave & Holiday page, on one of its tabs. */
export const leaveAddress = (tab?: "leaves" | "halfDay" | "permissions" | "calendar" | "holidays" | "balances") =>
  tab ? `/md/leave?tab=${tab}` : "/md/leave";

/** The Casual Leave page is not copied: the MD portal sends it to Leave & Holiday. */
export const LEAVE_TAB_FOR: Record<string, Parameters<typeof leaveAddress>[0]> = {
  requests: "leaves",
  days: "leaves",
  out: "calendar",
  cl: "balances",
  permissions: "permissions",
};
