import type { DashboardHome, DayCounts, PayrollFigures, PayrollMonth } from "./home-types";

// A /api/md/dashboard/home answer for the tests (the shape of the dev database on 13 Nov 2026, with some leave and CL).

const counts = (expected: number, present: number, cl: number, onLeave: number): DayCounts => {
  const absent = expected - present - cl;
  const share = (n: number) => (expected ? Math.round((1000 * n) / expected) / 10 : null);
  return {
    expected,
    present,
    absent,
    onLeave,
    cl,
    presentPct: share(present),
    absentPct: share(absent),
    clPct: share(cl),
  };
};

const pay = (gross: number, net: number, heads: number): PayrollFigures => ({
  grossPay: gross,
  salaryEarned: gross,
  overtimePay: 0,
  totalDeductions: Math.round((gross - net) * 100) / 100,
  netPay: net,
  headcount: heads,
  slips: heads,
  costPerHead: heads ? Math.round((100 * gross) / heads) / 100 : null,
});

const month = (
  key: string,
  label: string,
  state: PayrollMonth["state"],
  staff: PayrollFigures | null,
  production: PayrollFigures | null,
  current = false,
): PayrollMonth => {
  const parts = [staff, production].filter((p): p is PayrollFigures => p !== null);
  const figures = parts.length
    ? pay(
        parts.reduce((s, p) => s + p.grossPay, 0),
        parts.reduce((s, p) => s + p.netPay, 0),
        parts.reduce((s, p) => s + p.headcount, 0),
      )
    : null;
  return {
    month: key,
    label,
    state,
    stateLabel: {
      paid: "Paid",
      part_paid: "Part paid",
      finalized: "Payroll Done, payment pending",
      generated: "Generated, still open",
      in_progress: "In progress (provisional)",
      not_generated: "Not generated",
      not_started: "Not started",
      no_data: "No payroll",
    }[state],
    monthEnded: !current,
    slips: figures?.slips ?? 0,
    headcount: figures?.headcount ?? 0,
    paidSlips: 0,
    unpaidSlips: figures?.slips ?? 0,
    current,
    figures,
    staff,
    production,
  };
};

const staffToday = counts(142, 82, 4, 6);
const productionToday = counts(114, 0, 0, 0);
const both = (s: DayCounts, p: DayCounts): DayCounts =>
  counts(s.expected + p.expected, s.present + p.present, s.cl + p.cl, s.onLeave + p.onLeave);

const trendDay = (date: string, s: DayCounts, p: DayCounts, today = false) => ({
  date,
  today,
  ...both(s, p),
  staff: s,
  production: p,
});

export const HOME: DashboardHome = {
  generatedAt: "2026-11-13T17:26:21",
  today: "2026-11-13",
  employees: {
    total: 256,
    staff: 142,
    production: 114,
    staffPct: 55.5,
    productionPct: 44.5,
    gender: {
      staff: { male: 123, female: 19, other: 0, notRecorded: 0, total: 142 },
      production: { male: 46, female: 68, other: 0, notRecorded: 0, total: 114 },
      all: { male: 169, female: 87, other: 0, notRecorded: 0, total: 256 },
    },
    units: [
      { id: 4, name: "Unit1", staff: 11, production: 114, total: 125 },
      { id: 1, name: "Head Office", staff: 119, production: 0, total: 119 },
      { id: null, name: "No unit", staff: 12, production: 0, total: 12 },
    ],
  },
  attendance: {
    date: "2026-11-13",
    asOf: "2026-11-13T17:26",
    provisional: true,
    isWorkingDay: true,
    workedDayOff: 0,
    ...both(staffToday, productionToday),
    staff: staffToday,
    production: productionToday,
    units: [
      {
        id: 4,
        name: "Unit1",
        ...both(counts(11, 0, 0, 0), productionToday),
        staff: counts(11, 0, 0, 0),
        production: productionToday,
      },
      {
        id: 1,
        name: "Head Office",
        ...counts(119, 78, 4, 6),
        staff: counts(119, 78, 4, 6),
        production: counts(0, 0, 0, 0),
      },
      { id: null, name: "No unit", ...counts(12, 4, 0, 0), staff: counts(12, 4, 0, 0), production: counts(0, 0, 0, 0) },
    ],
    trend: [
      trendDay("2026-11-11", counts(142, 65, 0, 2), counts(114, 0, 0, 0)),
      trendDay("2026-11-12", counts(142, 82, 1, 3), counts(114, 0, 0, 0)),
      trendDay("2026-11-13", staffToday, productionToday, true),
    ],
  },
  payroll: {
    months: [
      month("2026-09", "September 2026", "part_paid", pay(3275880.22, 3251699.68, 153), null),
      month("2026-10", "October 2026", "part_paid", pay(3764679.34, 3747000, 142), pay(764030.75, 762593.37, 114)),
      month("2026-11", "November 2026", "in_progress", pay(951730.61, 945102, 142), null, true),
    ],
  },
  provenance: [],
  notes: [],
};
