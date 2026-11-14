import type { DayCounts, HomeAttendance, PayrollFigures, PayrollMonth, TrendDay } from "./home-types";

// The pure parts of the Dashboard's three overviews (tested in home-logic.test.ts): which counts a view shows, the rows
// each chart draws, and the current-against-previous month of payroll.

export type PeopleView = "all" | "staff" | "production";
export type PayMeasure = "gross" | "net";

export const PEOPLE_VIEWS: { value: PeopleView; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "staff", label: "Staff" },
  { value: "production", label: "Production" },
];

/** The counts a view shows: the whole company, or staff / production alone. */
export function countsFor<T extends DayCounts & { staff: DayCounts; production: DayCounts }>(
  block: T,
  view: PeopleView,
): DayCounts {
  return view === "all" ? block : block[view];
}

/** "13 Nov" from "2026-11-13" (no time zone involved: the date is the factory's own). */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${d} ${month}`;
}

/** "Fri" from "2026-11-13". */
export function weekday(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export type TrendRow = {
  date: string;
  label: string;
  day: string;
  today: boolean;
  present: number;
  cl: number;
  absent: number;
  expected: number;
  presentPct: number | null;
};

/** The 14-day chart's bars for a view. A day nobody was due (a Sunday) stays in, empty, so the days keep their places. */
export function trendRows(trend: TrendDay[], view: PeopleView): TrendRow[] {
  return trend.map((day) => {
    const c = countsFor(day, view);
    return {
      date: day.date,
      label: shortDate(day.date),
      day: weekday(day.date),
      today: day.today,
      present: c.present,
      cl: c.cl,
      absent: c.absent,
      expected: c.expected,
      presentPct: c.presentPct,
    };
  });
}

export type UnitRow = {
  name: string;
  present: number;
  cl: number;
  absent: number;
  onLeave: number;
  expected: number;
  presentPct: number | null;
};

/** Today by unit for a view, units nobody was due at left out, the largest first. */
export function unitRows(attendance: HomeAttendance, view: PeopleView): UnitRow[] {
  return attendance.units
    .map((u) => {
      const c = countsFor(u, view);
      return {
        name: u.name,
        present: c.present,
        cl: c.cl,
        absent: c.absent,
        onLeave: c.onLeave,
        expected: c.expected,
        presentPct: c.presentPct,
      };
    })
    .filter((u) => u.expected > 0)
    .sort((a, b) => b.expected - a.expected || a.name.localeCompare(b.name));
}

/** The average share present over the complete days of the trend (today, still running, left out); null without any. */
export function averagePresentPct(trend: TrendDay[], view: PeopleView): number | null {
  let present = 0;
  let expected = 0;
  for (const day of trend) {
    if (day.today) continue;
    const c = countsFor(day, view);
    present += c.present;
    expected += c.expected;
  }
  return expected > 0 ? Math.round((1000 * present) / expected) / 10 : null;
}

const amount = (f: PayrollFigures | null, measure: PayMeasure): number =>
  f ? (measure === "gross" ? f.grossPay : f.netPay) : 0;

/** The percentage change from `before` to `after`; null when there is nothing to compare with. */
export function changePct(after: number | null | undefined, before: number | null | undefined): number | null {
  if (after == null || before == null || before === 0) return null;
  return Math.round((1000 * (after - before)) / Math.abs(before)) / 10;
}

export type MonthPair = {
  current: PayrollMonth | null;
  previous: PayrollMonth | null;
  grossChange: number | null;
  netChange: number | null;
  peopleChange: number | null;
};

/** The running month and the one before it (the last two of the list), and how they differ. */
export function currentAndPrevious(months: PayrollMonth[]): MonthPair {
  const current = months.find((m) => m.current) ?? months[months.length - 1] ?? null;
  const index = current ? months.indexOf(current) : -1;
  const previous = index > 0 ? months[index - 1] : null;
  const cur = current?.figures ?? null;
  const prev = previous?.figures ?? null;
  return {
    current,
    previous,
    grossChange: cur && prev ? changePct(cur.grossPay, prev.grossPay) : null,
    netChange: cur && prev ? changePct(cur.netPay, prev.netPay) : null,
    peopleChange: cur && prev ? cur.headcount - prev.headcount : null,
  };
}

export type PayRow = {
  month: string;
  label: string;
  staff: number;
  production: number;
  total: number;
  people: number;
  current: boolean;
  previous: boolean;
  state: string;
};

/** The month-wise chart: staff and production stacked, for gross or net pay, oldest first. */
export function payrollRows(months: PayrollMonth[], measure: PayMeasure): PayRow[] {
  const pair = currentAndPrevious(months);
  return months.map((m) => {
    const short = m.label.split(" ");
    return {
      month: m.month,
      label: `${short[0]?.slice(0, 3) ?? m.month} ${short[1]?.slice(2) ?? ""}`.trim(),
      staff: amount(m.staff, measure),
      production: amount(m.production, measure),
      total: amount(m.figures, measure),
      people: m.figures?.headcount ?? 0,
      current: m === pair.current,
      previous: m === pair.previous,
      state: m.stateLabel,
    };
  });
}

/** The share of a month's pay that went to staff (0-100), null without pay. */
export function staffShare(month: PayrollMonth | null, measure: PayMeasure): number | null {
  if (!month?.figures) return null;
  const total = amount(month.figures, measure);
  return total > 0 ? Math.round((1000 * amount(month.staff, measure)) / total) / 10 : null;
}
