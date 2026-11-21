// Test fixtures for the Production side of the MD Payroll page, following the Prod* contract in ../types.ts. Every answer
// is computed from one set of workers (WORKERS) and their payslips per pay period (payslipFor), so the four endpoints agree
// with each other and the filters (cycle, period, unit, department, search, sort, paging) behave like the server's.
// No runtime imports.

import type {
  PayChange,
  PayDepartmentOption,
  PayYearMonth,
  ProdCycle,
  ProdCycleInfo,
  ProdDepartmentRow,
  ProdDepartmentsResponse,
  ProdFigures,
  ProdOverviewResponse,
  ProdPeopleResponse,
  ProdPeriodBrief,
  ProdPeriodRow,
  ProdPeriodState,
  ProdPersonResponse,
  ProdWorkerPeriod,
  ProdWorkerRow,
  ScopeEcho,
} from "../types";

const r2 = (n: number) => Math.round(n * 100) / 100;

export type WorkerSeed = {
  id: number;
  code: string;
  name: string;
  department: string;
  unit: string;
  branchId: number;
  cycle: ProdCycle;
  rate: number;
  status: string;
};

export const WORKERS: WorkerSeed[] = [
  {
    id: 501,
    code: "PRD501",
    name: "Kavi Arasu",
    department: "Stitching",
    unit: "Unit 1",
    branchId: 1,
    cycle: "biweekly",
    rate: 500,
    status: "active",
  },
  {
    id: 502,
    code: "PRD502",
    name: "Mani Vel",
    department: "Cutting",
    unit: "Unit 2",
    branchId: 2,
    cycle: "biweekly",
    rate: 420,
    status: "active",
  },
  {
    id: 503,
    code: "PRD503",
    name: "Ravi Shankar",
    department: "Stitching",
    unit: "Unit 1",
    branchId: 1,
    cycle: "biweekly",
    rate: 460,
    status: "inactive",
  },
  {
    id: 504,
    code: "PRD504",
    name: "Selvi K",
    department: "Stitching",
    unit: "Unit 1",
    branchId: 1,
    cycle: "biweekly",
    rate: 480,
    status: "active",
  },
  {
    id: 505,
    code: "PRD505",
    name: "Tamil Selvan",
    department: "Cutting",
    unit: "Unit 2",
    branchId: 2,
    cycle: "biweekly",
    rate: 440,
    status: "active",
  },
  {
    id: 506,
    code: "PRD506",
    name: "Uma Devi",
    department: "Packing",
    unit: "Unit 1",
    branchId: 1,
    cycle: "biweekly",
    rate: 400,
    status: "active",
  },
  {
    id: 507,
    code: "PRD507",
    name: "Vani Sri",
    department: "Stitching",
    unit: "Unit 1",
    branchId: 1,
    cycle: "weekly",
    rate: 600,
    status: "active",
  },
  {
    id: 508,
    code: "PRD508",
    name: "Yamuna R",
    department: "Packing",
    unit: "Unit 1",
    branchId: 1,
    cycle: "weekly",
    rate: 550,
    status: "active",
  },
];

type PeriodSeed = { cycle: ProdCycle; start: string; end: string; state: ProdPeriodState; ended: boolean };

/** The periods with payroll, newest first within each cycle. */
export const PERIODS: PeriodSeed[] = [
  { cycle: "biweekly", start: "2026-10-22", end: "2026-11-04", state: "finalized", ended: true },
  { cycle: "biweekly", start: "2026-10-08", end: "2026-10-21", state: "paid", ended: true },
  { cycle: "biweekly", start: "2026-09-24", end: "2026-10-07", state: "paid", ended: true },
  { cycle: "biweekly", start: "2026-09-10", end: "2026-09-23", state: "paid", ended: true },
  { cycle: "weekly", start: "2026-11-02", end: "2026-11-08", state: "generated", ended: true },
  { cycle: "weekly", start: "2026-10-26", end: "2026-11-01", state: "paid", ended: true },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CYCLE_LABEL: Record<ProdCycle, string> = {
  weekly: "Weekly",
  biweekly: "BiWeekly",
  monthly: "Monthly",
  none: "No pay cycle",
};
const STATE_LABEL: Record<ProdPeriodState, string> = {
  generated: "Generated",
  part_paid: "Part paid",
  finalized: "Payroll Done",
  paid: "Paid",
};

const fmt = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
export const periodLabel = (p: { start: string; end: string }) =>
  `${fmt(p.start)} - ${fmt(p.end)} ${p.end.slice(0, 4)}`;
const keyOf = (p: { start: string; end: string }) => `${p.start}_${p.end}`;
const daysIn = (p: { start: string; end: string }) =>
  Math.round((Date.parse(p.end) - Date.parse(p.start)) / 86_400_000) + 1;

export const briefOf = (p: PeriodSeed, slips = 0): ProdPeriodBrief => ({
  start: p.start,
  end: p.end,
  key: keyOf(p),
  label: periodLabel(p),
  state: p.state,
  stateLabel: STATE_LABEL[p.state],
  ended: p.ended,
  slips,
});

type Payslip = Omit<
  ProdWorkerPeriod,
  "cycle" | "cycleLabel" | "start" | "end" | "key" | "label" | "state" | "stateLabel" | "days"
> & {
  seed: WorkerSeed;
  period: PeriodSeed;
};

/** One worker's payslip of a period (null when the period is not on the worker's cycle). */
export function payslipFor(seed: WorkerSeed, period: PeriodSeed): Payslip | null {
  if (seed.cycle !== period.cycle) return null;
  const index = PERIODS.indexOf(period);
  const span = daysIn(period);
  const absent = (seed.id + index) % 3;
  const worked = span - absent - (period.cycle === "biweekly" ? 2 : 1);
  const shifts = worked - ((seed.id + index) % 2) * 0.5;
  const gross = r2(shifts * seed.rate);
  const excess = seed.id === 501 && index === 0 ? 600 : 0;
  const detection = seed.id === 501 && index === 0 ? 100 : 0;
  const bonus = excess - detection;
  const esi = gross <= 10500 ? Math.ceil(gross * 0.0075) : 0;
  const advance = seed.id === 502 && index === 1 ? 500 : 0;
  const late = (seed.id + index) % 4 === 0 ? r2(seed.rate / 2) : 0;
  const total = r2(esi + advance + late);
  const net = Math.ceil(gross + bonus - total);
  const employer = r2(esi ? gross * 0.0325 : 0);
  const paid = period.state === "paid";
  return {
    seed,
    period,
    ratePerShift: seed.rate,
    shifts,
    daysWorked: worked,
    daysAbsent: absent,
    daysPaid: span,
    periodDays: span,
    lateDays: late ? 1 : 0,
    grossPay: gross,
    excess,
    detection,
    bonus,
    deductions: { pf: 0, esi, tds: 0, advance, late, other: 0, total },
    netPaid: net,
    employerPfEsi: employer,
    companyCost: r2(gross + bonus + employer),
    paymentStatus: paid ? "paid" : "not_paid",
    paymentPaidAt: paid ? `${period.end}T18:00:00` : null,
    cleared: paid || period.state === "finalized",
  };
}

export function sumFigures(slips: Payslip[]): ProdFigures {
  const sum = (get: (s: Payslip) => number) => r2(slips.reduce((a, s) => a + get(s), 0));
  const people = new Set(slips.map((s) => s.seed.id)).size;
  const shifts = sum((s) => s.shifts);
  const gross = sum((s) => s.grossPay);
  const net = sum((s) => s.netPaid);
  const worked = sum((s) => s.daysWorked);
  const absent = sum((s) => s.daysAbsent);
  return {
    employees: people,
    slips: slips.length,
    shifts,
    daysWorked: worked,
    daysAbsent: absent,
    daysPaid: sum((s) => s.daysPaid),
    grossPay: gross,
    excess: sum((s) => s.excess),
    detection: sum((s) => s.detection),
    bonus: sum((s) => s.bonus),
    deductions: {
      pf: 0,
      esi: sum((s) => s.deductions.esi),
      tds: 0,
      advance: sum((s) => s.deductions.advance),
      late: sum((s) => s.deductions.late),
      other: 0,
      total: sum((s) => s.deductions.total),
    },
    netPaid: net,
    employerPfEsi: sum((s) => s.employerPfEsi),
    companyCost: sum((s) => s.companyCost),
    averageRatePerShift: shifts ? r2(gross / shifts) : null,
    averageNetPerWorker: people ? r2(net / people) : 0,
    shiftsPerWorker: people ? r2(shifts / people) : 0,
    attendancePct: worked + absent ? Math.round((worked / (worked + absent)) * 1000) / 10 : null,
  };
}

type Scope = { branch: string | null; department: string | null };

const scopeFrom = (params: URLSearchParams): Scope => ({
  branch: params.get("branch"),
  department: params.get("department"),
});
const inScope = (w: WorkerSeed, s: Scope) =>
  (!s.branch || String(w.branchId) === s.branch) && (!s.department || w.department === s.department);
const echo = (s: Scope): ScopeEcho => ({
  branch: s.branch === "1" ? "Unit 1" : s.branch === "2" ? "Unit 2" : null,
  department: s.department || null,
  type: "production",
});

const slipsOf = (period: PeriodSeed, scope: Scope) =>
  WORKERS.filter((w) => inScope(w, scope))
    .map((w) => payslipFor(w, period))
    .filter((s): s is Payslip => !!s);

function choose(params: URLSearchParams): { cycle: ProdCycle; period: PeriodSeed | null; periods: PeriodSeed[] } {
  const cycle = (params.get("cycle") as ProdCycle) || "biweekly";
  const periods = PERIODS.filter((p) => p.cycle === cycle);
  const start = params.get("periodStart");
  const end = params.get("periodEnd");
  const period =
    start && end ? (periods.find((p) => p.start === start && p.end === end) ?? null) : (periods[0] ?? null);
  return { cycle, period, periods };
}

export function changeOf(current: number | null, previous: number | null): PayChange {
  if (current == null || previous == null) return null;
  const abs = r2(current - previous);
  return { abs, pct: previous === 0 ? null : Math.round((abs / Math.abs(previous)) * 1000) / 10 };
}

const changes = (cur: ProdFigures, prev: ProdFigures | null) =>
  prev
    ? {
        companyCost: changeOf(cur.companyCost, prev.companyCost),
        grossPay: changeOf(cur.grossPay, prev.grossPay),
        netPaid: changeOf(cur.netPaid, prev.netPaid),
        deductions: changeOf(cur.deductions.total, prev.deductions.total),
        bonus: changeOf(cur.bonus, prev.bonus),
        shifts: changeOf(cur.shifts, prev.shifts),
        employees: changeOf(cur.employees, prev.employees),
      }
    : null;

export function departmentOptions(): PayDepartmentOption[] {
  // the ids of the shell's org fixture (renderMdPage SHELL_FIXTURES), so the department filter has options
  return [
    { id: 11, name: "Cutting", branchId: 1 },
    { id: 702, name: "Packing", branchId: 1 },
    { id: 10, name: "Stitching", branchId: 1 },
  ];
}

/** GET /api/md/payroll/production/overview */
export function overviewFixture(params: URLSearchParams = new URLSearchParams()): ProdOverviewResponse {
  const scope = scopeFrom(params);
  const { cycle, period, periods } = choose(params);
  const cycles: ProdCycleInfo[] = (["weekly", "biweekly"] as ProdCycle[]).map((c) => {
    const list = PERIODS.filter((p) => p.cycle === c);
    return {
      cycle: c,
      label: CYCLE_LABEL[c],
      periods: list.length,
      latestStart: list[0].start,
      latestEnd: list[0].end,
      assigned: WORKERS.filter((w) => w.cycle === c && w.status === "active" && inScope(w, scope)).length,
    };
  });
  const briefs = periods.map((p) => briefOf(p, slipsOf(p, scope).length));
  const base = {
    cycles,
    cycle,
    cycleLabel: CYCLE_LABEL[cycle],
    periods: briefs,
    departments: departmentOptions(),
    scope: echo(scope),
  };
  if (!period) {
    return {
      ...base,
      period: null,
      current: null,
      status: null,
      previous: null,
      change: null,
      trend: [],
      months: [],
      yearly: null,
      notes: ["There is no payroll for this period in this selection."],
    };
  }
  const at = periods.indexOf(period);
  const before = periods[at + 1] ?? null;
  const rows = slipsOf(period, scope);
  const current = sumFigures(rows);
  const previous = before ? sumFigures(slipsOf(before, scope)) : null;
  const trend: ProdPeriodRow[] = periods
    .slice(at, at + 12)
    .reverse()
    .map((p) => ({ ...briefOf(p, slipsOf(p, scope).length), ...sumFigures(slipsOf(p, scope)) }));
  const byMonth = new Map<string, Payslip[]>();
  for (const p of PERIODS)
    for (const s of slipsOf(p, scope)) byMonth.set(p.end.slice(0, 7), [...(byMonth.get(p.end.slice(0, 7)) ?? []), s]);
  const monthKeys = [...byMonth.keys()].sort();
  const months = monthKeys.map((m) => {
    const slips = byMonth.get(m)!;
    const cyclesIn = (["weekly", "biweekly"] as ProdCycle[]).filter((c) => slips.some((s) => s.period.cycle === c));
    return {
      month: m,
      label: `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`,
      periods: new Set(slips.map((s) => keyOf(s.period) + s.period.cycle)).size,
      ...sumFigures(slips),
      cycles: cyclesIn.map((c) => {
        const part = slips.filter((s) => s.period.cycle === c);
        const f = sumFigures(part);
        return {
          cycle: c,
          label: CYCLE_LABEL[c],
          employees: f.employees,
          netPaid: f.netPaid,
          companyCost: f.companyCost,
        };
      }),
    };
  });
  const all = [...byMonth.values()].flat();
  const yearMonths: PayYearMonth[] = MONTHS.map((name, i) => {
    const m = `2026-${String(i + 1).padStart(2, "0")}`;
    const slips = byMonth.get(m);
    const f = slips ? sumFigures(slips) : null;
    return {
      month: i + 1,
      label: name,
      current: f ? { companyCost: f.companyCost, netPaid: f.netPaid, employees: f.employees } : null,
      previous: null,
    };
  });
  const paid = rows.filter((s) => s.paymentStatus === "paid");
  const left = rows.filter((s) => s.seed.status !== "active");
  return {
    ...base,
    period: briefOf(period, rows.length),
    current,
    status: {
      state: period.state,
      label: STATE_LABEL[period.state],
      detail:
        period.state === "finalized"
          ? "Payroll Done on 6 Nov 2026: payment pending for 6 days."
          : period.state === "paid"
            ? "Paid on 25 Oct 2026, 2 days after Payroll Done."
            : "Open: HR can still generate it again.",
      ended: period.ended,
      locked: period.state === "finalized" || period.state === "paid",
      finalizedAt: period.state === "generated" ? null : `${period.end}T10:00:00`,
      finalizedBy: period.state === "generated" ? null : "Priya",
      paidAt: period.state === "paid" ? `${period.end}T18:00:00` : null,
      paidBy: period.state === "paid" ? "Priya" : null,
      paidOn: period.state === "paid" ? period.end : null,
      daysToPay: period.state === "paid" ? 2 : null,
      paymentPendingDays: period.state === "finalized" ? 6 : null,
      slips: rows.length,
      paidSlips: paid.length,
      unpaidSlips: rows.length - paid.length,
      unpaidNet: r2(rows.filter((s) => s.paymentStatus !== "paid").reduce((a, s) => a + s.netPaid, 0)),
      clearedSlips: rows.filter((s) => s.cleared).length,
      parked:
        period.state === "finalized"
          ? { count: 1, newJoiners: 1, movedIn: 0, net: 2000 }
          : { count: 0, newJoiners: 0, movedIn: 0, net: 0 },
      leftSince: left.length,
      leftSinceNet: r2(left.reduce((a, s) => a + s.netPaid, 0)),
    },
    previous: before && previous ? { ...briefOf(before, slipsOf(before, scope).length), ...previous } : null,
    change: changes(current, previous),
    trend,
    months,
    yearly: {
      current: {
        ...sumFigures(all),
        year: 2026,
        label: "2026 (Jan-Nov)",
        from: "2026-01",
        to: "2026-11",
        months: months.length,
      },
      previous: null,
      previousFull: null,
      change: null,
      months: yearMonths,
    },
    notes: [],
  };
}

/** GET /api/md/payroll/production/departments */
export function departmentsFixture(params: URLSearchParams = new URLSearchParams()): ProdDepartmentsResponse {
  const scope: Scope = { branch: params.get("branch"), department: null };
  const { cycle, period, periods } = choose(params);
  const head = { cycle, cycleLabel: CYCLE_LABEL[cycle], scope: echo(scope) };
  if (!period)
    return { ...head, period: null, rows: [], totals: sumFigures([]), previousPeriod: null, notes: ["No period."] };
  const before = periods[periods.indexOf(period) + 1] ?? null;
  const rows = slipsOf(period, scope);
  const was = before ? slipsOf(before, scope) : [];
  const total = sumFigures(rows);
  const names = [...new Set(rows.map((s) => `${s.seed.department}|${s.seed.unit}`))];
  const out: ProdDepartmentRow[] = names
    .map((key) => {
      const [department, unit] = key.split("|");
      const mine = rows.filter((s) => s.seed.department === department && s.seed.unit === unit);
      const old = was.filter((s) => s.seed.department === department && s.seed.unit === unit);
      const f = sumFigures(mine);
      const p = old.length ? sumFigures(old) : null;
      return {
        ...f,
        department,
        unit,
        sharePct: total.companyCost ? Math.round((f.companyCost / total.companyCost) * 1000) / 10 : 0,
        previousCompanyCost: p ? p.companyCost : null,
        previousNetPaid: p ? p.netPaid : null,
        change: changeOf(f.companyCost, p ? p.companyCost : null),
      };
    })
    .sort((a, b) => b.companyCost - a.companyCost);
  return {
    ...head,
    period: briefOf(period, rows.length),
    rows: out,
    totals: total,
    previousPeriod: before ? briefOf(before) : null,
    notes: [],
  };
}

const workerRow = (s: Payslip): ProdWorkerRow => ({
  employeeId: s.seed.id,
  code: s.seed.code,
  name: s.seed.name,
  department: s.seed.department,
  unit: s.seed.unit,
  designation: "Operator",
  status: s.seed.status,
  ratePerShift: s.ratePerShift,
  shifts: s.shifts,
  daysWorked: s.daysWorked,
  daysAbsent: s.daysAbsent,
  daysPaid: s.daysPaid,
  periodDays: s.periodDays,
  lateDays: s.lateDays,
  grossPay: s.grossPay,
  excess: s.excess,
  detection: s.detection,
  bonus: s.bonus,
  deductions: s.deductions,
  netPaid: s.netPaid,
  employerPfEsi: s.employerPfEsi,
  companyCost: s.companyCost,
  paymentStatus: s.paymentStatus,
  cleared: s.cleared,
});

/** GET /api/md/payroll/production/people */
export function peopleFixture(params: URLSearchParams = new URLSearchParams()): ProdPeopleResponse {
  const scope = scopeFrom(params);
  const { cycle, period } = choose(params);
  const page = Math.max(1, Number(params.get("page") || 1));
  const pageSize = Number(params.get("pageSize") || 25);
  const head = { cycle, cycleLabel: CYCLE_LABEL[cycle], page, pageSize, scope: echo(scope) };
  if (!period) return { ...head, period: null, total: 0, rows: [], totals: sumFigures([]), notes: ["No period."] };
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const sort = params.get("sort") ?? "name";
  const sign = params.get("dir") === "desc" ? -1 : 1;
  const slips = slipsOf(period, scope).filter(
    (s) => !q || s.seed.name.toLowerCase().includes(q) || s.seed.code.toLowerCase().includes(q),
  );
  const value = (r: ProdWorkerRow): string | number =>
    sort === "deductions" ? r.deductions.total : ((r as unknown as Record<string, string | number | null>)[sort] ?? 0);
  const rows = slips.map(workerRow).sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return c * sign || a.name.localeCompare(b.name);
  });
  return {
    ...head,
    period: briefOf(period, slips.length),
    total: rows.length,
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    totals: sumFigures(slips),
    notes: q && !rows.length ? [`Nobody matches '${q}' in this period.`] : [],
  };
}

/** GET /api/md/payroll/production/people/<id> */
export function personFixture(id: number): ProdPersonResponse {
  const seed = WORKERS.find((w) => w.id === id);
  if (!seed) throw new Error(`no fixture worker ${id}`);
  const slips = PERIODS.map((p) => payslipFor(seed, p)).filter((s): s is Payslip => !!s);
  const periods: ProdWorkerPeriod[] = slips.map((s) => {
    const { seed: _seed, period: p, ...figures } = s;
    void _seed;
    return {
      ...figures,
      cycle: p.cycle,
      cycleLabel: CYCLE_LABEL[p.cycle],
      start: p.start,
      end: p.end,
      key: keyOf(p),
      label: periodLabel(p),
      state: p.state,
      stateLabel: STATE_LABEL[p.state],
      days: Array.from({ length: Math.min(3, daysIn(p)) }, (_, i) => ({
        date: `${p.start.slice(0, 8)}${String(Number(p.start.slice(8, 10)) + i).padStart(2, "0")}`,
        day: "Thursday",
        status: i === 2 ? "absent" : "present",
        shifts: i === 2 ? 0 : 1,
        late: i === 1,
        firstPunch: i === 2 ? null : "08:02",
        lastPunch: i === 2 ? null : "17:31",
        lastPunchNextDay: false,
      })),
    };
  });
  return {
    employee: {
      id: seed.id,
      code: seed.code,
      name: seed.name,
      department: seed.department,
      unit: seed.unit,
      designation: "Operator",
      type: "production",
      status: seed.status,
      joinDate: "2022-03-01",
      cycle: seed.cycle,
      cycleLabel: CYCLE_LABEL[seed.cycle],
      ratePerShift: seed.rate,
    },
    periods,
    totals: sumFigures(slips),
    notes: [],
  };
}

/** The fixture table for renderMdPage: the four production endpoints, every worker included. */
export function productionFixtures(): Record<string, (params: URLSearchParams) => unknown> {
  return {
    "/api/md/payroll/production/overview": overviewFixture,
    "/api/md/payroll/production/departments": departmentsFixture,
    "/api/md/payroll/production/people": peopleFixture,
    ...Object.fromEntries(WORKERS.map((w) => [`/api/md/payroll/production/people/${w.id}`, () => personFixture(w.id)])),
  };
}

/** No production payroll at all. */
export const EMPTY_OVERVIEW: ProdOverviewResponse = {
  cycles: [],
  cycle: null,
  cycleLabel: null,
  periods: [],
  period: null,
  current: null,
  status: null,
  previous: null,
  change: null,
  trend: [],
  months: [],
  yearly: null,
  departments: [],
  scope: { branch: null, department: null, type: "production" },
  notes: ["No production payroll has been generated yet."],
};
