import { describe, expect, it } from "vitest";
import { monthlyFixture, personFixture } from "./fixtures";
import {
  DEFAULT_STATE,
  applyPatch,
  axisMoney,
  changeBetween,
  clRows,
  compareLines,
  dashSearch,
  daysText,
  deductionRows,
  defaultDir,
  deltaOf,
  departmentBars,
  departmentName,
  departmentValue,
  figuresSummary,
  flowRows,
  kpiChange,
  kpiValue,
  monthOptions,
  monthTick,
  nextSort,
  otherDeductions,
  pageInfo,
  parseDashState,
  paymentChip,
  peopleBars,
  personChartRows,
  previousMonth,
  saysAlready,
  scopeOf,
  shortName,
  signedRupees,
  sortRows,
  statusTone,
  sumFigures,
  typeLabel,
  withChange,
  words,
} from "./logic";
import type { PayDepartmentRow, PayFigures, PayPersonRow } from "./types";

const figures = (over: Partial<PayFigures> = {}): PayFigures => ({
  employees: 2,
  actualSalary: 40000,
  earnedSalary: 38000,
  lossOfPay: 2000,
  lateDeduction: 250,
  attendanceDeduction: 2250,
  overtime: 1000,
  bonus: 0,
  deductions: { pf: 1800, esi: 100, tds: 0, advance: 500, late: 250, other: 50, total: 2700 },
  netPaid: 36300,
  employerPfEsi: 2000,
  companyCost: 41000,
  clDays: 1.5,
  clAmount: 2300,
  workingDays: 52,
  paidDays: 50,
  lopDays: 2,
  ...over,
});

describe("the page state in the address", () => {
  it("reads an empty address as the defaults", () => {
    expect(parseDashState("")).toEqual(DEFAULT_STATE);
    expect(dashSearch(DEFAULT_STATE)).toBe("");
  });

  it("reads every key, with or without the leading ?", () => {
    const s = parseDashState(
      "?view=employees&month=2026-09&branch=2&department=Cutting&type=production&q=%20bala%20&sort=netPaid&dir=asc&page=3",
    );
    expect(s).toEqual({
      view: "employees",
      month: "2026-09",
      branch: "2",
      department: "Cutting",
      type: "production",
      q: "bala",
      employee: null,
      sort: "netPaid",
      dir: "asc",
      page: 3,
    });
    expect(parseDashState("view=departments").view).toBe("departments");
  });

  it("falls back to a default for anything malformed", () => {
    const s = parseDashState("?view=charts&month=2026-13&type=contract&sort=salary&dir=up&page=0&employee=abc");
    expect(s).toEqual(DEFAULT_STATE);
    expect(parseDashState("?page=-2").page).toBe(1);
    expect(parseDashState("?employee=0").employee).toBeNull();
  });

  it("opens an employee on the Employees tab whatever the view says", () => {
    const s = parseDashState("?view=monthly&employee=101");
    expect(s.view).toBe("employees");
    expect(s.employee).toBe(101);
  });

  it("gives each sort its natural direction when none is written", () => {
    expect(parseDashState("?sort=netPaid").dir).toBe("desc");
    expect(parseDashState("?sort=code").dir).toBe("asc");
    expect(defaultDir("companyCost")).toBe("desc");
    expect(defaultDir("department")).toBe("asc");
  });

  it("writes only what differs from the defaults, in a fixed order, and reads back the same", () => {
    const state = {
      ...DEFAULT_STATE,
      view: "employees" as const,
      q: "anitha",
      department: "Stitching",
      month: "2026-08",
      sort: "netPaid" as const,
      dir: "desc" as const,
      page: 2,
    };
    const search = dashSearch(state);
    expect(search).toBe("?view=employees&month=2026-08&department=Stitching&q=anitha&sort=netPaid&page=2");
    expect(parseDashState(search)).toEqual(state);
    // an open employee speaks for the view
    expect(dashSearch({ ...state, employee: 101 })).toBe(
      "?employee=101&month=2026-08&department=Stitching&q=anitha&sort=netPaid&page=2",
    );
    expect(dashSearch({ ...DEFAULT_STATE, sort: "name", dir: "desc" })).toBe("?dir=desc");
  });

  it("starts the list again at page 1 when a filter, the search or the sort changes", () => {
    const on3 = { ...DEFAULT_STATE, view: "employees" as const, page: 3 };
    expect(applyPatch(on3, { q: "bala" }).page).toBe(1);
    expect(applyPatch(on3, { department: "Cutting" }).page).toBe(1);
    expect(applyPatch(on3, { sort: "netPaid", dir: "desc" }).page).toBe(1);
    expect(applyPatch(on3, { page: 4 }).page).toBe(4);
    // the same value again is not a change
    expect(applyPatch(on3, { q: "" }).page).toBe(3);
    expect(applyPatch(on3, { employee: 101 }).page).toBe(3);
  });

  it("closes the open employee when leaving the Employees tab, and an employee means that tab", () => {
    const open = { ...DEFAULT_STATE, view: "employees" as const, employee: 101 };
    expect(applyPatch(open, { view: "monthly" })).toMatchObject({ view: "monthly", employee: null });
    expect(applyPatch(DEFAULT_STATE, { employee: 7 })).toMatchObject({ view: "employees", employee: 7 });
  });

  it("turns a column's direction around, and starts a new column in its natural direction", () => {
    expect(nextSort({ sort: "name", dir: "asc" }, "name")).toEqual({ sort: "name", dir: "desc" });
    expect(nextSort({ sort: "name", dir: "asc" }, "netPaid")).toEqual({ sort: "netPaid", dir: "desc" });
    expect(nextSort({ sort: "netPaid", dir: "desc" }, "netPaid")).toEqual({ sort: "netPaid", dir: "asc" });
    expect(nextSort({ sort: "netPaid", dir: "desc" }, "code")).toEqual({ sort: "code", dir: "asc" });
  });

  it("hands the scope to the filter bar", () => {
    expect(scopeOf({ branch: "2", department: "Accounts", type: "staff" })).toEqual({
      branch: "2",
      department: "Accounts",
      type: "staff",
    });
  });
});

describe("figures", () => {
  it("leaves the late penalty out of the other deductions (it is an attendance deduction)", () => {
    expect(otherDeductions(figures())).toBe(2450);
    expect(otherDeductions(figures({ deductions: { ...figures().deductions, total: 100, late: 250 } }))).toBe(0);
  });

  it("works out a change, with no percent against nothing", () => {
    expect(changeBetween(110, 100)).toEqual({ abs: 10, pct: 10 });
    expect(changeBetween(90, 100)).toEqual({ abs: -10, pct: -10 });
    expect(changeBetween(5, 0)).toEqual({ abs: 5, pct: null });
    expect(changeBetween(null, 100)).toBeNull();
    expect(changeBetween(100, undefined)).toBeNull();
  });

  it("reads a headline figure, the other deductions worked out", () => {
    const f = figures();
    expect(kpiValue(f, "companyCost")).toBe(41000);
    expect(kpiValue(f, "otherDeductions")).toBe(2450);
    expect(kpiValue(null, "netPaid")).toBeNull();
  });

  it("takes the server's change when it sends one, and works out the rest", () => {
    const data = monthlyFixture(new URLSearchParams());
    expect(kpiChange(data, "companyCost")).toEqual({ abs: -17112.71, pct: -2.94 });
    // not in the server's change map: worked out from the month and the one before
    const other = kpiChange(data, "otherDeductions");
    const expected = changeBetween(otherDeductions(data.current!), otherDeductions(data.previous!));
    expect(other).toEqual(expected);
    expect(kpiChange(undefined, "netPaid")).toBeNull();
    expect(kpiChange({ ...data, previous: null, change: null }, "actualSalary")).toBeNull();
  });

  it("words a change chip: the percent, else the amount, coloured only when it is news", () => {
    expect(deltaOf({ abs: -1200, pct: -2.94 }, "money", "down")).toEqual({
      text: "-2.9%",
      tone: "good",
      direction: "down",
    });
    expect(deltaOf({ abs: 1200, pct: 5 }, "money", "down")?.tone).toBe("bad");
    expect(deltaOf({ abs: 15000, pct: null }, "money")).toEqual({ text: "+₹15,000", tone: "neutral", direction: "up" });
    expect(deltaOf({ abs: -2, pct: null }, "count")?.text).toBe("-2");
    expect(deltaOf({ abs: 1.5, pct: null }, "days")?.text).toBe("+1.5");
    expect(deltaOf({ abs: 0, pct: 0 }, "money", "up")).toEqual({ text: "0%", tone: "neutral", direction: "flat" });
    expect(deltaOf(null, "money")).toBeNull();
  });

  it("says days with the half day kept, and rupees with their sign", () => {
    expect(daysText(12)).toBe("12");
    expect(daysText(12.5)).toBe("12.5");
    expect(daysText(4.75)).toBe("4.75");
    expect(daysText(1234.25)).toBe("1,234.25");
    expect(daysText(null)).toBe("—");
    expect(signedRupees(500)).toBe("+₹500");
    expect(signedRupees(-1250)).toBe("-₹1,250");
    expect(signedRupees(0)).toBe("₹0");
    expect(signedRupees(null)).toBe("—");
  });

  it("adds figures up, keeping 'no actual salary' when nobody had one", () => {
    const sum = sumFigures([figures(), figures({ actualSalary: null, lossOfPay: null, employees: 1 })]);
    expect(sum.employees).toBe(3);
    expect(sum.actualSalary).toBe(40000);
    expect(sum.lossOfPay).toBe(2000);
    expect(sum.deductions.total).toBe(5400);
    expect(sumFigures([figures({ actualSalary: null, lossOfPay: null })]).actualSalary).toBeNull();
  });

  it("lists the month-on-month lines, each with its change", () => {
    const lines = compareLines(figures({ companyCost: 44000 }), figures());
    expect(lines.map((l) => l.id)).toEqual([
      "employees",
      "actualSalary",
      "earnedSalary",
      "lossOfPay",
      "lateDeduction",
      "overtime",
      "bonus",
      "otherDeductions",
      "netPaid",
      "companyCost",
      "clDays",
      "clAmount",
    ]);
    expect(lines.find((l) => l.id === "companyCost")?.change).toEqual({ abs: 3000, pct: 7.32 });
    expect(compareLines(figures(), null).every((l) => l.change === null)).toBe(true);
    expect(compareLines(null, figures())).toEqual([]);
  });

  it("words the figures for the assistant", () => {
    expect(figuresSummary(figures())).toMatchObject({
      "Company cost": "₹41,000",
      "Other deductions": "₹2,450",
      "CL days": "1.5",
    });
    expect(withChange(565178.49, { abs: -17112.71, pct: -2.94 })).toBe("₹5.7 L (-2.9% on the month before)");
    expect(withChange(1000, { abs: 1000, pct: null })).toBe("₹1,000 (+₹1,000 on the month before)");
    expect(withChange(1000, undefined)).toBe("₹1,000");
  });
});

describe("months and words", () => {
  it("steps back a month across a year", () => {
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(previousMonth("2026-10")).toBe("2026-09");
  });

  it("marks the year on a January tick", () => {
    expect(monthTick("2026-01")).toBe("Jan '26");
    expect(monthTick("2026-10")).toBe("Oct");
  });

  it("offers the months newest first, keeping a chosen month the server did not list", () => {
    expect(monthOptions(["2026-09", "2026-10"], "")).toEqual([
      { value: "2026-10", label: "Oct 2026" },
      { value: "2026-09", label: "Sep 2026" },
    ]);
    expect(monthOptions(["2026-10"], "2025-01").map((o) => o.value)).toEqual(["2026-10", "2025-01"]);
    expect(monthOptions(undefined, "")).toEqual([]);
  });

  it("shortens money for an axis", () => {
    expect(axisMoney(950)).toBe("950");
    expect(axisMoney(12500)).toBe("12.5k");
    expect(axisMoney(565178)).toBe("5.7L");
    expect(axisMoney(12500000)).toBe("1.3Cr");
    expect(axisMoney(-40000)).toBe("-40k");
  });

  it("gives a month state its tone", () => {
    expect(statusTone("paid")).toBe("success");
    expect(statusTone("finalized")).toBe("warning");
    expect(statusTone("part_paid")).toBe("warning");
    expect(statusTone("on_hold")).toBe("warning");
    expect(statusTone("in_progress")).toBe("neutral");
    expect(statusTone("generated")).toBe("info");
    expect(statusTone("not_generated")).toBe("danger");
    expect(statusTone("something_new")).toBe("neutral");
  });

  it("words a payment, a hold coming first", () => {
    expect(paymentChip("paid", false)).toEqual({ text: "Paid", tone: "success" });
    expect(paymentChip("not_paid", false)).toEqual({ text: "Not paid", tone: "warning" });
    expect(paymentChip("pending", false)).toEqual({ text: "Pending", tone: "warning" });
    expect(paymentChip("paid", true)).toEqual({ text: "On hold", tone: "warning" });
    expect(paymentChip("partly_cleared", false)).toEqual({ text: "Partly cleared", tone: "neutral" });
    expect(paymentChip(null, false)).toBeNull();
    expect(saysAlready("Paid", "Paid")).toBe(true);
    expect(saysAlready("Generated, not paid", "Not paid")).toBe(true);
    expect(saysAlready("Generated, not paid", "Paid")).toBe(false);
    expect(saysAlready("Generated, still open", "Not paid")).toBe(false);
    expect(words("payment_pending")).toBe("Payment pending");
    expect(words("")).toBe("—");
    expect(typeLabel("production")).toBe("Production");
    expect(typeLabel("")).toBe("Staff + production");
    expect(shortName("Maintenance and Utilities", 12)).toBe("Maintenance…");
    expect(shortName("Cutting", 12)).toBe("Cutting");
  });
});

describe("chart rows", () => {
  const data = monthlyFixture(new URLSearchParams());

  it("builds the trend's stack from the months, the chosen one marked", () => {
    const rows = flowRows(data.months, "2026-10");
    expect(rows).toHaveLength(12);
    const last = rows.at(-1)!;
    expect(last).toMatchObject({ key: "2026-10", tick: "Oct", selected: true, netPaid: 487341 });
    // the three parts add up to the pay bill before anything was taken: net + deductions + loss of pay
    const c = data.current!;
    expect(last.netPaid + last.otherDeductions + last.attendanceDeduction).toBeCloseTo(
      c.netPaid + c.deductions.total + (c.lossOfPay ?? 0),
      0,
    );
    expect(rows.filter((r) => r.selected)).toHaveLength(1);
  });

  it("splits the deductions by type and keeps the CL figures", () => {
    const d = deductionRows(data.months, "2026-10").at(-1)!;
    expect(d).toMatchObject({ lossOfPay: 4682.68, late: 1293.28, pf: 29402.25, tds: 1500, other: 400 });
    expect(clRows(data.months, null).at(-1)).toMatchObject({ clDays: 5, clAmount: 3557.7, selected: false });
  });

  it("orders departments by cost and names a department that is in two units by its unit", () => {
    const row = (department: string, unit: string, companyCost: number) =>
      ({ ...figures({ companyCost }), department, unit }) as unknown as PayDepartmentRow;
    const rows = [row("Stitching", "Unit 1", 10), row("Stitching", "Unit 2", 30), row("Cutting", "Unit 1", 20)];
    expect(departmentBars(rows).map((b) => b.name)).toEqual(["Stitching (Unit 2)", "Cutting", "Stitching (Unit 1)"]);
    expect(departmentName(rows[2], rows)).toBe("Cutting");
    expect(departmentValue({ ...rows[0], change: { abs: 4, pct: 1 } } as PayDepartmentRow, "change")).toBe(4);
    expect(departmentValue(rows[0], "deductions")).toBe(2700);
  });

  it("takes the people of a page in the list's order, up to the limit", () => {
    const person = (id: number) => ({ ...figures(), employeeId: id, name: `P${id}`, code: `C${id}` }) as PayPersonRow;
    const bars = peopleBars([person(3), person(1), person(2)], 2);
    expect(bars.map((b) => b.id)).toEqual([3, 1]);
    expect(bars[0].otherDeductions).toBe(2450);
  });

  it("puts an employee's months oldest first for the chart", () => {
    const rows = personChartRows(personFixture(107).months);
    expect(rows.map((r) => r.key)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(rows[0].actualSalary).toBe(24000);
  });
});

describe("sorting and paging", () => {
  it("sorts with empty values last, whichever the direction, and keeps ties in order", () => {
    const rows = [
      { id: "a", v: 2 },
      { id: "b", v: null },
      { id: "c", v: 5 },
      { id: "d", v: 2 },
    ];
    expect(sortRows(rows, (r) => r.v, "asc").map((r) => r.id)).toEqual(["a", "d", "c", "b"]);
    expect(sortRows(rows, (r) => r.v, "desc").map((r) => r.id)).toEqual(["c", "a", "d", "b"]);
    expect(sortRows([{ n: "b" }, { n: "a" }], (r) => r.n, "asc").map((r) => r.n)).toEqual(["a", "b"]);
  });

  it("says where a page sits", () => {
    expect(pageInfo(29, 1, 25)).toEqual({ page: 1, pages: 2, from: 1, to: 25, hasPrev: false, hasNext: true });
    expect(pageInfo(29, 2, 25)).toEqual({ page: 2, pages: 2, from: 26, to: 29, hasPrev: true, hasNext: false });
    expect(pageInfo(29, 9, 25).page).toBe(2);
    expect(pageInfo(0, 1, 25)).toEqual({ page: 1, pages: 1, from: 0, to: 0, hasPrev: false, hasNext: false });
  });
});
