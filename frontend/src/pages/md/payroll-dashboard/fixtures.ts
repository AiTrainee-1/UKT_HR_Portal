// Test fixtures for the MD Payroll page, following the contract in types.ts. Every answer is computed from one set of
// employees (PEOPLE) and their salary slips per month (slipFor), so the four endpoints agree with each other and the
// filters (unit, department, type, search, sort, paging) behave like the server's. No runtime imports: a headless
// screenshot script loads this file as it is.

import type {
  PayChange,
  PayDepartmentRow,
  PayDepartmentsResponse,
  PayFigures,
  PayMonthRow,
  PayMonthState,
  PayMonthlyResponse,
  PayPeopleResponse,
  PayPersonMonth,
  PayPersonResponse,
  PayPersonRow,
  ScopeEcho,
} from "./types";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The months with slips, oldest first: Sep 2025 to Oct 2026. */
export const MONTHS = [
  "2025-09",
  "2025-10",
  "2025-11",
  "2025-12",
  "2026-01",
  "2026-02",
  "2026-03",
  "2026-04",
  "2026-05",
  "2026-06",
  "2026-07",
  "2026-08",
  "2026-09",
  "2026-10",
];
export const LATEST = "2026-10";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const label = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

export type Seed = {
  id: number;
  code: string;
  name: string;
  department: string;
  unit: string;
  branchId: number;
  designation: string;
  type: "staff" | "production";
  status: string;
  /** staff: monthly salary; production: rate per shift */
  pay: number;
  joinMonth?: string;
  leftAfter?: string;
  holdIn?: string;
};

const HANDMADE: Seed[] = [
  {
    id: 101,
    code: "STF001",
    name: "Anitha Raman",
    department: "Stitching",
    unit: "Unit 1",
    branchId: 1,
    designation: "Supervisor",
    type: "staff",
    status: "active",
    pay: 32000,
  },
  {
    id: 102,
    code: "STF002",
    name: "Bala Murugan",
    department: "Cutting",
    unit: "Unit 1",
    branchId: 1,
    designation: "Cutting Master",
    type: "staff",
    status: "active",
    pay: 28000,
  },
  {
    id: 103,
    code: "PRD010",
    name: "Chitra Devi",
    department: "Stitching",
    unit: "Unit 1",
    branchId: 1,
    designation: "Tailor",
    type: "production",
    status: "active",
    pay: 520,
  },
  {
    id: 104,
    code: "STF003",
    name: "Deepak Kumar",
    department: "Accounts",
    unit: "Head Office",
    branchId: 2,
    designation: "Accountant",
    type: "staff",
    status: "active",
    pay: 45000,
  },
  {
    id: 105,
    code: "PRD011",
    name: "Elango S",
    department: "Cutting",
    unit: "Unit 1",
    branchId: 1,
    designation: "Cutter",
    type: "production",
    status: "active",
    pay: 480,
  },
  {
    id: 106,
    code: "STF004",
    name: "Fathima Begum",
    department: "Stitching",
    unit: "Unit 1",
    branchId: 1,
    designation: "Line Checker",
    type: "staff",
    status: "active",
    pay: 18500,
    holdIn: LATEST,
  },
  {
    id: 107,
    code: "STF005",
    name: "Gopal Krishnan",
    department: "Accounts",
    unit: "Head Office",
    branchId: 2,
    designation: "Cashier",
    type: "staff",
    status: "active",
    pay: 24000,
    joinMonth: "2026-08",
  },
  {
    id: 108,
    code: "STF006",
    name: "Hema Latha",
    department: "Packing",
    unit: "Unit 1",
    branchId: 1,
    designation: "Packing In-charge",
    type: "staff",
    status: "inactive",
    pay: 21000,
    leftAfter: "2026-09",
  },
];

const MORE_NAMES = [
  "Indira Selvam",
  "Jayakumar P",
  "Kavitha Mohan",
  "Lakshmi Priya",
  "Mani Vel",
  "Nandhini K",
  "Prakash Raj",
  "Revathi S",
  "Saravanan M",
  "Thenmozhi R",
  "Uma Shankar",
  "Vasanth Kumar",
  "Yamuna Devi",
  "Arul Doss",
  "Bharathi N",
  "Dinesh Babu",
  "Ezhil Arasi",
  "Ganesh Moorthy",
  "Ilakkiya V",
  "Karthik Raja",
  "Malar Kodi",
  "Naveen Kumar",
];
const MORE_DEPARTMENTS = ["Stitching", "Cutting", "Packing", "Maintenance"];

/** The 30 employees: 8 written by hand, 22 more in a pattern (every other one production). */
export const PEOPLE: Seed[] = [
  ...HANDMADE,
  ...MORE_NAMES.map((name, i): Seed => {
    const production = i % 2 === 0;
    return {
      id: 109 + i,
      code: production ? `PRD${String(12 + i).padStart(3, "0")}` : `STF${String(7 + i).padStart(3, "0")}`,
      name,
      department: MORE_DEPARTMENTS[i % MORE_DEPARTMENTS.length],
      unit: "Unit 1",
      branchId: 1,
      designation: production ? "Operator" : "Helper",
      type: production ? "production" : "staff",
      status: "active",
      pay: production ? 450 + (i % 5) * 25 : 14000 + (i % 6) * 1500,
    };
  }),
];

const WORKING_DAYS = 26;

type Slip = PayFigures & {
  dailyRate: number | null;
  presentDays: number;
  holidayDays: number;
  lateDays: number;
  adjustment: number | null;
  onHold: boolean;
  paymentStatus: string | null;
  paymentPaidAt: string | null;
  periods: PayPersonMonth["periods"];
};

const monthIndex = (ym: string) => MONTHS.indexOf(ym);

const lastDay = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
};

/** One employee's slip for a month (null when they had none: not joined yet, or left). */
export function slipFor(seed: Seed, ym: string): Slip | null {
  const i = monthIndex(ym);
  if (i < 0) return null;
  if (seed.joinMonth && ym < seed.joinMonth) return null;
  if (seed.leftAfter && ym > seed.leftAfter) return null;
  const k = PEOPLE.indexOf(seed);
  const absent = (k * 3 + i * 5) % 7 === 0 ? 2 : (k + i) % 5 === 0 ? 1 : (k + i) % 11 === 0 ? 0.5 : 0;
  const lateDays = (k + i) % 4 === 0 ? 3 : (k + i) % 3 === 0 ? 1 : 0;
  const latest = ym === LATEST;
  const paymentStatus = latest ? "not_paid" : "paid";
  const paymentPaidAt = latest ? null : `${MONTHS[i + 1] ?? "2026-11"}-06T11:00:00`;
  const onHold = seed.holdIn === ym;
  const bonusMonth = ym === "2025-10";

  if (seed.type === "staff") {
    const salary = seed.pay;
    const dailyRate = r2(salary / WORKING_DAYS);
    const earned = absent === 0 ? salary : r2(salary - dailyRate * absent);
    const lossOfPay = r2(salary - earned);
    const late = lateDays >= 3 ? r2(dailyRate / 4) : 0;
    const overtime = k % 3 === 0 ? 1200 + (i % 3) * 400 : 0;
    const bonus = bonusMonth ? r2(salary * 0.0833) : 0;
    const pf = Math.min(1800, r2(earned * 0.5 * 0.12));
    const esi = earned <= 21000 ? r2(earned * 0.0075) : 0;
    const tds = salary >= 40000 ? 1500 : 0;
    const advance = k % 5 === 1 && i % 3 === 0 ? 2000 : 0;
    const other = k % 7 === 2 ? 200 : 0;
    const total = r2(pf + esi + tds + advance + late + other);
    const netPaid = Math.ceil(earned + overtime + bonus - total);
    const employerPfEsi = r2(pf * (13 / 12) + (esi > 0 ? earned * 0.0325 : 0));
    const clDays = (k + i) % 6 === 0 ? 1 : (k + i) % 9 === 0 ? 0.5 : 0;
    return {
      employees: 1,
      actualSalary: salary,
      earnedSalary: earned,
      lossOfPay,
      lateDeduction: late,
      attendanceDeduction: r2(lossOfPay + late),
      overtime,
      bonus,
      deductions: { pf, esi, tds, advance, late, other, total },
      netPaid,
      employerPfEsi,
      companyCost: r2(earned + overtime + bonus + employerPfEsi),
      clDays,
      clAmount: r2(clDays * dailyRate),
      workingDays: WORKING_DAYS,
      paidDays: WORKING_DAYS - absent,
      lopDays: absent,
      dailyRate,
      presentDays: WORKING_DAYS - absent - clDays - 1,
      holidayDays: 1,
      lateDays,
      adjustment: k === 0 && ym === "2026-09" ? 500 : null,
      onHold,
      paymentStatus,
      paymentPaidAt,
      periods: [],
    };
  }

  // production: paid per shift, four weekly periods; the month is the one the period ends in
  const rate = seed.pay;
  const absentDays = Math.ceil(absent);
  const shifts = WORKING_DAYS - absentDays;
  const earned = r2(shifts * rate);
  const late = lateDays >= 3 ? r2(rate / 4) : 0;
  const overtime = k % 4 === 0 ? 600 : 0;
  const bonus = bonusMonth ? 2000 : 0;
  const pf = Math.min(1800, r2(earned * 0.5 * 0.12));
  const esi = earned <= 21000 ? r2(earned * 0.0075) : 0;
  const advance = k % 5 === 1 && i % 3 === 0 ? 1000 : 0;
  const other = 0;
  const total = r2(pf + esi + advance + late + other);
  const netPaid = Math.ceil(earned + overtime + bonus - total);
  const employerPfEsi = r2(pf * (13 / 12) + (esi > 0 ? earned * 0.0325 : 0));
  const end = lastDay(ym);
  const bounds = [
    [1, 7],
    [8, 14],
    [15, 21],
    [22, end],
  ];
  const perPeriod = Math.floor(netPaid / 4);
  const shiftSplit = [Math.floor(shifts / 4), Math.floor(shifts / 4), Math.floor(shifts / 4)];
  const periods = bounds.map(([a, b], j) => ({
    start: `${ym}-${String(a).padStart(2, "0")}`,
    end: `${ym}-${String(b).padStart(2, "0")}`,
    cycle: "weekly",
    netPaid: j < 3 ? perPeriod : netPaid - perPeriod * 3,
    shifts: j < 3 ? shiftSplit[j] : shifts - shiftSplit[0] * 3,
    ratePerShift: rate,
  }));
  return {
    employees: 1,
    actualSalary: null,
    earnedSalary: earned,
    lossOfPay: null,
    lateDeduction: late,
    attendanceDeduction: late,
    overtime,
    bonus,
    deductions: { pf, esi, tds: 0, advance, late, other, total },
    netPaid,
    employerPfEsi,
    companyCost: r2(earned + overtime + bonus + employerPfEsi),
    clDays: 0,
    clAmount: 0,
    workingDays: WORKING_DAYS,
    paidDays: shifts,
    lopDays: absentDays,
    dailyRate: null,
    presentDays: shifts,
    holidayDays: 0,
    lateDays,
    adjustment: null,
    onHold,
    paymentStatus,
    paymentPaidAt,
    periods,
  };
}

/** Figures added up (a month, a department, the totals). */
export function addUp(blocks: PayFigures[]): PayFigures {
  const sum = (get: (f: PayFigures) => number) => r2(blocks.reduce((a, f) => a + get(f), 0));
  const staff = blocks.filter((f) => f.actualSalary != null);
  return {
    employees: sum((f) => f.employees),
    actualSalary: staff.length ? r2(staff.reduce((a, f) => a + (f.actualSalary ?? 0), 0)) : null,
    earnedSalary: sum((f) => f.earnedSalary),
    lossOfPay: staff.length ? r2(staff.reduce((a, f) => a + (f.lossOfPay ?? 0), 0)) : null,
    lateDeduction: sum((f) => f.lateDeduction),
    attendanceDeduction: sum((f) => f.attendanceDeduction),
    overtime: sum((f) => f.overtime),
    bonus: sum((f) => f.bonus),
    deductions: {
      pf: sum((f) => f.deductions.pf),
      esi: sum((f) => f.deductions.esi),
      tds: sum((f) => f.deductions.tds),
      advance: sum((f) => f.deductions.advance),
      late: sum((f) => f.deductions.late),
      other: sum((f) => f.deductions.other),
      total: sum((f) => f.deductions.total),
    },
    netPaid: sum((f) => f.netPaid),
    employerPfEsi: sum((f) => f.employerPfEsi),
    companyCost: sum((f) => f.companyCost),
    clDays: sum((f) => f.clDays),
    clAmount: sum((f) => f.clAmount),
    workingDays: sum((f) => f.workingDays),
    paidDays: sum((f) => f.paidDays),
    lopDays: sum((f) => f.lopDays),
  };
}

const figuresOf = (slip: Slip): PayFigures => ({
  employees: slip.employees,
  actualSalary: slip.actualSalary,
  earnedSalary: slip.earnedSalary,
  lossOfPay: slip.lossOfPay,
  lateDeduction: slip.lateDeduction,
  attendanceDeduction: slip.attendanceDeduction,
  overtime: slip.overtime,
  bonus: slip.bonus,
  deductions: slip.deductions,
  netPaid: slip.netPaid,
  employerPfEsi: slip.employerPfEsi,
  companyCost: slip.companyCost,
  clDays: slip.clDays,
  clAmount: slip.clAmount,
  workingDays: slip.workingDays,
  paidDays: slip.paidDays,
  lopDays: slip.lopDays,
});

export function statusOf(ym: string): PayMonthState {
  if (ym === LATEST)
    return {
      state: "finalized",
      label: "Payment pending",
      detail: "Payroll Done on 03 Nov 2026; payment pending 11 days.",
    };
  const next = MONTHS[monthIndex(ym) + 1] ?? "2026-11";
  return { state: "paid", label: "Paid", detail: `Paid on 06 ${label(next).slice(0, 3)} ${next.slice(0, 4)}.` };
}

type Scope = { branch?: string | null; department?: string | null; type?: string | null };

const inScope = (seed: Seed, scope: Scope) =>
  (!scope.branch || String(seed.branchId) === scope.branch) &&
  (!scope.department || seed.department === scope.department) &&
  (!scope.type || seed.type === scope.type);

const echo = (scope: Scope): ScopeEcho => ({
  branch: scope.branch || null,
  department: scope.department || null,
  type: scope.type === "staff" || scope.type === "production" ? scope.type : null,
});

const scopeFrom = (params: URLSearchParams): Scope => ({
  branch: params.get("branch"),
  department: params.get("department"),
  type: params.get("type"),
});

function monthRow(ym: string, scope: Scope): PayMonthRow | null {
  const slips = PEOPLE.filter((p) => inScope(p, scope))
    .map((p) => slipFor(p, ym))
    .filter((s): s is Slip => !!s);
  if (slips.length === 0) return null;
  return { ...addUp(slips.map(figuresOf)), month: ym, label: label(ym), status: statusOf(ym) };
}

export function changeOf(current: number | null, previous: number | null): PayChange {
  if (current == null || previous == null) return null;
  const abs = r2(current - previous);
  return { abs, pct: previous === 0 ? null : r2((abs / previous) * 100) };
}

/** GET /api/md/payroll/monthly */
export function monthlyFixture(params: URLSearchParams = new URLSearchParams()): PayMonthlyResponse {
  const scope = scopeFrom(params);
  const available = MONTHS.filter((m) => monthRow(m, scope)).reverse();
  const month = params.get("month") || available[0] || null;
  const count = Number(params.get("months") || 12);
  if (!month) {
    return {
      month: null,
      label: null,
      months: [],
      current: null,
      previous: null,
      change: null,
      available: [],
      scope: echo(scope),
      notes: [],
    };
  }
  const upTo = MONTHS.filter((m) => m <= month).slice(-count);
  const months = upTo.map((m) => monthRow(m, scope)).filter((r): r is PayMonthRow => !!r);
  const current = months.find((m) => m.month === month) ?? null;
  const previous = current ? (months[months.indexOf(current) - 1] ?? null) : null;
  const change =
    current && previous
      ? {
          companyCost: changeOf(current.companyCost, previous.companyCost),
          earnedSalary: changeOf(current.earnedSalary, previous.earnedSalary),
          netPaid: changeOf(current.netPaid, previous.netPaid),
          attendanceDeduction: changeOf(current.attendanceDeduction, previous.attendanceDeduction),
          clAmount: changeOf(current.clAmount, previous.clAmount),
          employees: changeOf(current.employees, previous.employees),
        }
      : null;
  return {
    month,
    label: label(month),
    months,
    current,
    previous,
    change,
    available,
    scope: echo(scope),
    notes: [],
  };
}

/** GET /api/md/payroll/department-breakdown (no department filter: every department of the month) */
export function departmentsFixture(params: URLSearchParams = new URLSearchParams()): PayDepartmentsResponse {
  const scope: Scope = { branch: params.get("branch"), type: params.get("type") };
  const month = params.get("month") || LATEST;
  const groups = new Map<string, { department: string; unit: string; slips: Slip[]; previous: Slip[] }>();
  const before = MONTHS[monthIndex(month) - 1];
  for (const p of PEOPLE.filter((x) => inScope(x, scope))) {
    const key = `${p.department}|${p.unit}`;
    const group = groups.get(key) ?? { department: p.department, unit: p.unit, slips: [], previous: [] };
    const slip = slipFor(p, month);
    if (slip) group.slips.push(slip);
    const old = before ? slipFor(p, before) : null;
    if (old) group.previous.push(old);
    groups.set(key, group);
  }
  const live = [...groups.values()].filter((g) => g.slips.length > 0);
  const totals = addUp(live.flatMap((g) => g.slips.map(figuresOf)));
  const rows: PayDepartmentRow[] = live.map((g) => {
    const f = addUp(g.slips.map(figuresOf));
    const previousCompanyCost = g.previous.length ? addUp(g.previous.map(figuresOf)).companyCost : null;
    return {
      ...f,
      department: g.department,
      unit: g.unit,
      averageEarned: r2(f.earnedSalary / f.employees),
      averageNetPaid: r2(f.netPaid / f.employees),
      attendancePct: f.workingDays ? r2((f.paidDays / f.workingDays) * 100) : null,
      sharePct: totals.companyCost ? r2((f.companyCost / totals.companyCost) * 100) : 0,
      previousCompanyCost,
      change: changeOf(f.companyCost, previousCompanyCost),
    };
  });
  return {
    month,
    label: label(month),
    rows,
    totals: {
      ...totals,
      averageEarned: totals.employees ? r2(totals.earnedSalary / totals.employees) : 0,
      averageNetPaid: totals.employees ? r2(totals.netPaid / totals.employees) : 0,
      attendancePct: totals.workingDays ? r2((totals.paidDays / totals.workingDays) * 100) : null,
    },
    scope: echo(scope),
    notes: [],
  };
}

function personRow(seed: Seed, slip: Slip): PayPersonRow {
  return {
    ...figuresOf(slip),
    employeeId: seed.id,
    code: seed.code,
    name: seed.name,
    department: seed.department,
    unit: seed.unit,
    designation: seed.designation,
    type: seed.type,
    status: seed.status,
    onHold: slip.onHold,
    paymentStatus: slip.paymentStatus,
    periods: slip.periods.length,
  };
}

const SORT_VALUE: Record<string, (r: PayPersonRow) => string | number | null> = {
  name: (r) => r.name,
  code: (r) => r.code,
  department: (r) => r.department,
  actualSalary: (r) => r.actualSalary,
  earnedSalary: (r) => r.earnedSalary,
  attendanceDeduction: (r) => r.attendanceDeduction,
  deductions: (r) => r.deductions.total,
  netPaid: (r) => r.netPaid,
  companyCost: (r) => r.companyCost,
  clDays: (r) => r.clDays,
  clAmount: (r) => r.clAmount,
};

/** GET /api/md/payroll/people */
export function peopleFixture(params: URLSearchParams = new URLSearchParams()): PayPeopleResponse {
  const scope = scopeFrom(params);
  const month = params.get("month") || LATEST;
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const get = SORT_VALUE[params.get("sort") ?? "name"] ?? SORT_VALUE.name;
  const sign = params.get("dir") === "desc" ? -1 : 1;
  const page = Math.max(1, Number(params.get("page") || 1));
  const pageSize = Number(params.get("pageSize") || 25);
  const all = PEOPLE.filter((p) => inScope(p, scope))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q))
    .map((p) => {
      const slip = slipFor(p, month);
      return slip ? personRow(p, slip) : null;
    })
    .filter((r): r is PayPersonRow => !!r)
    .sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return c * sign || a.name.localeCompare(b.name);
    });
  return {
    month,
    label: label(month),
    total: all.length,
    page,
    pageSize,
    rows: all.slice((page - 1) * pageSize, page * pageSize),
    totals: addUp(all),
    scope: echo(scope),
    notes: [],
  };
}

/** GET /api/md/payroll/people/<id> */
export function personFixture(id: number, months = 24): PayPersonResponse {
  const seed = PEOPLE.find((p) => p.id === id);
  if (!seed) throw new Error(`no fixture person ${id}`);
  const history: PayPersonMonth[] = [...MONTHS]
    .reverse()
    .map((m) => {
      const slip = slipFor(seed, m);
      if (!slip) return null;
      const status: PayMonthState = slip.onHold
        ? { state: "on_hold", label: "On hold", detail: "The salary is held: it is not paid with the month." }
        : statusOf(m);
      return { ...slip, month: m, label: label(m), status };
    })
    .filter((m): m is PayPersonMonth => !!m)
    .slice(0, months);
  return {
    employee: {
      id: seed.id,
      code: seed.code,
      name: seed.name,
      department: seed.department,
      unit: seed.unit,
      designation: seed.designation,
      type: seed.type,
      status: seed.status,
      joinDate: seed.joinMonth ? `${seed.joinMonth}-04` : "2021-06-14",
      monthlySalary: seed.type === "staff" ? seed.pay : null,
    },
    months: history,
    totals: addUp(history),
    notes: [],
  };
}

/** A fixture table for renderMdPage: the four endpoints, every person's history included. */
export function dashboardFixtures(): Record<string, (params: URLSearchParams) => unknown> {
  const people = Object.fromEntries(
    PEOPLE.map((p) => [
      `/api/md/payroll/people/${p.id}`,
      (params: URLSearchParams) => personFixture(p.id, Number(params.get("months") || 24)),
    ]),
  );
  return {
    "/api/md/payroll/monthly": monthlyFixture,
    "/api/md/payroll/department-breakdown": departmentsFixture,
    "/api/md/payroll/people": peopleFixture,
    ...people,
  };
}

/** No payroll at all (a fresh install, or a scope with nobody on it). */
export const EMPTY_MONTHLY: PayMonthlyResponse = {
  month: null,
  label: null,
  months: [],
  current: null,
  previous: null,
  change: null,
  available: [],
  scope: { branch: null, department: null, type: null },
  notes: [],
};
