import { describe, expect, it } from "vitest";
import { FILTER_URL_DEFAULTS } from "@/components/payroll/panels/filters";
import { STATEMENT_URL_DEFAULTS } from "@/components/payroll/kit/statement-url";
import type {
  CyclePeriodRow,
  PayrollRunItem,
  PeriodEmployee,
  ProductionPayrollItem,
} from "@/lib/api-client/custom-hooks";
import {
  ISSUE_URL_DEFAULTS,
  PRODUCTION_REGISTER_COLUMNS,
  PRODUCTION_TABS,
  PRODUCTION_URL_DEFAULTS,
  PRODUCTION_VIEWS,
  ROSTER_URL_DEFAULTS,
  cycleBlurb,
  cycleTitle,
  defaultPeriod,
  filterRoster,
  formatPeriod,
  isProductionTab,
  isProductionView,
  issueFiltersFromUrl,
  issueFiltersToUrl,
  parseDay,
  periodFromUrl,
  periodFromValue,
  periodOptionLabel,
  periodValue,
  productionScope,
  readyCount,
  resolveSlipMonth,
  rosterState,
  rosterStateCounts,
  rosterStateFromUrl,
  samePeriod,
  skippedFromRoster,
  unassignedNotice,
} from "./logic";

const row = (over: Partial<CyclePeriodRow> = {}): CyclePeriodRow => ({
  periodStart: "2026-02-02",
  periodEnd: "2026-02-08",
  periodEnded: true,
  isNext: false,
  generated: 0,
  paid: 0,
  ...over,
});

const payroll = (over: Partial<ProductionPayrollItem> = {}): ProductionPayrollItem =>
  ({
    id: 1,
    employeeId: 1,
    employeeName: "Asha Kumar",
    employeeCode: "P001",
    departmentId: 4,
    salaryMode: "shift",
    month: 2,
    year: 2026,
    totalWorkingDays: 7,
    presentDays: 7,
    absentDays: 0,
    otHours: 0,
    otAmount: 0,
    baseSalary: 3500,
    grossSalary: 3500,
    deductions: 500,
    bonus: 0,
    finalSalary: 3000,
    status: "pending",
    bankAccount: "",
    bankIfsc: "",
    bankName: "",
    email: "",
    departmentName: "Weaving",
    ...over,
  }) as ProductionPayrollItem;

const person = (over: Partial<PeriodEmployee> = {}): PeriodEmployee => ({
  employeeId: 1,
  employeeCode: "P001",
  name: "Asha Kumar",
  departmentName: "Weaving",
  salaryPerShift: 500,
  payroll: null,
  blockedReason: null,
  ...over,
});

describe("writing a period", () => {
  it("shows the year once when both ends share it", () => {
    expect(formatPeriod({ periodStart: "2026-02-02", periodEnd: "2026-02-08" })).toBe("2 Feb - 8 Feb 2026");
    expect(formatPeriod({ periodStart: "2026-02-16", periodEnd: "2026-03-01" })).toBe("16 Feb - 1 Mar 2026");
  });

  it("shows both years across a year end", () => {
    expect(formatPeriod({ periodStart: "2025-12-29", periodEnd: "2026-01-04" })).toBe("29 Dec 2025 - 4 Jan 2026");
  });

  it("falls back to the raw text for something that is not a date", () => {
    expect(formatPeriod({ periodStart: "soon", periodEnd: "later" })).toBe("soon - later");
  });

  it("only accepts real calendar days", () => {
    expect(parseDay("2026-02-28")).toEqual({ year: 2026, month: 2, day: 28 });
    expect(parseDay("2026-02-30")).toBeNull();
    expect(parseDay("02/02/2026")).toBeNull();
    expect(parseDay(null)).toBeNull();
  });

  it("round-trips through the picker's value", () => {
    const period = { periodStart: "2026-02-02", periodEnd: "2026-02-15" };
    expect(periodValue(period)).toBe("2026-02-02|2026-02-15");
    expect(periodFromValue(periodValue(period))).toEqual(period);
    expect(periodFromValue("nonsense")).toBeNull();
    expect(periodFromValue("2026-02-02|")).toBeNull();
  });

  it("compares two periods by both ends", () => {
    const a = { periodStart: "2026-02-02", periodEnd: "2026-02-08" };
    expect(samePeriod(a, { ...a })).toBe(true);
    expect(samePeriod(a, { periodStart: "2026-02-02", periodEnd: "2026-02-15" })).toBe(false);
    expect(samePeriod(a, null)).toBe(false);
  });
});

describe("choosing a period", () => {
  it("opens on the period that is next due", () => {
    const periods = [
      row({ periodStart: "2026-03-09", periodEnd: "2026-03-15" }),
      row({ periodStart: "2026-03-02", periodEnd: "2026-03-08", isNext: true }),
    ];
    expect(defaultPeriod(periods)).toEqual({ periodStart: "2026-03-02", periodEnd: "2026-03-08" });
  });

  it("falls back to the newest period and to nothing", () => {
    expect(defaultPeriod([row({ periodStart: "2026-03-09", periodEnd: "2026-03-15" })])).toEqual({
      periodStart: "2026-03-09",
      periodEnd: "2026-03-15",
    });
    expect(defaultPeriod([])).toBeNull();
  });

  it("describes each entry of the picker", () => {
    expect(periodOptionLabel(row({ generated: 12, isNext: true }), 14)).toBe(
      "2 Feb - 8 Feb 2026 · 12 of 14 generated · next due",
    );
    expect(periodOptionLabel(row(), 14)).toBe("2 Feb - 8 Feb 2026 · not generated");
    expect(periodOptionLabel(row({ periodEnded: false, generated: 3 }), 0)).toBe(
      "2 Feb - 8 Feb 2026 · 3 generated · not ended yet",
    );
  });
});

describe("the roster", () => {
  it("reads each employee's state for the period", () => {
    expect(rosterState(person())).toBe("ready");
    expect(rosterState(person({ blockedReason: "No Salary Per Shift set on this employee's profile" }))).toBe(
      "blocked",
    );
    expect(rosterState(person({ payroll: payroll() }))).toBe("pending");
    expect(rosterState(person({ payroll: payroll({ status: "paid" }) }))).toBe("paid");
  });

  it("filters by state and by text", () => {
    const people = [
      person({ employeeId: 1, employeeCode: "P001", name: "Asha Kumar" }),
      person({ employeeId: 2, employeeCode: "P002", name: "Ravi Nair", payroll: payroll({ status: "paid" }) }),
      person({ employeeId: 3, employeeCode: "P003", name: "Meena Das", blockedReason: "No rate" }),
    ];
    expect(filterRoster(people, "", "all")).toHaveLength(3);
    expect(filterRoster(people, "", "paid").map((p) => p.employeeId)).toEqual([2]);
    expect(filterRoster(people, "", "blocked").map((p) => p.employeeId)).toEqual([3]);
    expect(filterRoster(people, "meena", "all").map((p) => p.employeeId)).toEqual([3]);
    expect(filterRoster(people, "p002", "ready")).toEqual([]);
  });

  it("counts what a Generate click would compute", () => {
    expect(
      readyCount([
        person(),
        person({ employeeId: 2, blockedReason: "x" }),
        person({ employeeId: 3, payroll: payroll() }),
      ]),
    ).toBe(1);
  });

  it("counts the people in each state, for the filter chips", () => {
    const people = [
      person({ employeeId: 1 }),
      person({ employeeId: 2 }),
      person({ employeeId: 3, payroll: payroll() }),
      person({ employeeId: 4, payroll: payroll({ status: "paid" }) }),
      person({ employeeId: 5, blockedReason: "No rate" }),
    ];
    expect(rosterStateCounts(people)).toEqual({ all: 5, ready: 2, pending: 1, paid: 1, blocked: 1 });
    expect(rosterStateCounts(undefined)).toEqual({ all: 0, ready: 0, pending: 0, paid: 0, blocked: 0 });
  });
});

describe("who Payroll skipped, from the roster", () => {
  it("lists the blocked people with the reason the roster gives, and nobody else", () => {
    const people = [
      person({ employeeId: 1, employeeCode: "P001", name: "Asha Kumar" }),
      person({
        employeeId: 2,
        employeeCode: "P002",
        name: "Meena Das",
        departmentName: "Stitching",
        salaryPerShift: null,
        blockedReason: "No Salary Per Shift set on this employee's profile",
      }),
      person({
        employeeId: 3,
        employeeCode: "P003",
        name: "Ravi Nair",
        blockedReason: "Overlaps the payroll already generated for 2026-02-01 to 2026-02-14.",
      }),
      person({ employeeId: 4, payroll: payroll() }),
    ];
    expect(skippedFromRoster(people)).toEqual([
      {
        employeeId: 2,
        employeeCode: "P002",
        name: "Meena Das",
        reason: "No Salary Per Shift set on this employee's profile",
        department: "Stitching",
      },
      {
        employeeId: 3,
        employeeCode: "P003",
        name: "Ravi Nair",
        reason: "Overlaps the payroll already generated for 2026-02-01 to 2026-02-14.",
        department: "Weaving",
      },
    ]);
  });

  it("never lists somebody who already has a payslip, whatever their row says", () => {
    expect(skippedFromRoster([person({ payroll: payroll(), blockedReason: "stale" })])).toEqual([]);
  });

  it("is empty for nobody", () => {
    expect(skippedFromRoster([])).toEqual([]);
    expect(skippedFromRoster(undefined)).toEqual([]);
  });
});

describe("wording", () => {
  it("names each cycle's page", () => {
    expect(cycleTitle("weekly")).toBe("Production Payroll - Weekly");
    expect(cycleBlurb("biweekly")).toContain("Two-week calculation");
    expect(cycleBlurb("biweekly")).toContain("14-day");
    expect(cycleBlurb("monthly")).toContain("28-day");
  });

  it("warns about people on no cycle", () => {
    expect(unassignedNotice(0)).toBeNull();
    expect(unassignedNotice(1)).toBe(
      "1 production employee is not assigned to a pay cycle yet, so no payroll includes them.",
    );
    expect(unassignedNotice(5)).toContain("5 production employees are");
  });
});

describe("the page's state in its address", () => {
  it("has a default for every key, and no two parts of the page share one", () => {
    const parts = [FILTER_URL_DEFAULTS, ISSUE_URL_DEFAULTS, STATEMENT_URL_DEFAULTS, ROSTER_URL_DEFAULTS];
    const keys = parts.flatMap((p) => Object.keys(p));
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of [...keys, "tab", "view", "period", "month", "year", "layout"]) {
      expect(PRODUCTION_URL_DEFAULTS).toHaveProperty(key);
    }
    expect(Object.keys(PRODUCTION_URL_DEFAULTS)).toHaveLength(keys.length + 6);
  });

  it("opens on the Payroll tab, the Records view and the period the cycle is due to pay", () => {
    expect(PRODUCTION_URL_DEFAULTS).toMatchObject({ tab: "payroll", view: "records", period: "", layout: "cards" });
  });

  it("keeps the Issues view's keys the same as the Staff Payroll page's", () => {
    expect(ISSUE_URL_DEFAULTS).toEqual({
      iq: "",
      icode: "",
      isev: "",
      idept: "",
      ifrom: "",
      ito: "",
      igroup: "date",
    });
  });

  it("knows its tabs and its views", () => {
    expect(PRODUCTION_TABS).toEqual(["payroll", "employees", "salary", "payslip"]);
    expect(PRODUCTION_VIEWS).toEqual(["records", "issues", "skipped", "rules"]);
    expect(isProductionTab("salary")).toBe(true);
    expect(isProductionTab("settings")).toBe(false);
    expect(isProductionTab("")).toBe(false);
    expect(isProductionView("rules")).toBe(true);
    expect(isProductionView("table")).toBe(false);
  });

  it("reads the pay period from the address, and ignores what is not one", () => {
    expect(periodFromUrl("2026-02-02_2026-02-08")).toEqual({ periodStart: "2026-02-02", periodEnd: "2026-02-08" });
    expect(periodFromUrl("2026-02-02_2026-02-02")).toEqual({ periodStart: "2026-02-02", periodEnd: "2026-02-02" });
    expect(periodFromUrl("")).toBeNull();
    expect(periodFromUrl(null)).toBeNull();
    expect(periodFromUrl("2026-02-02")).toBeNull();
    expect(periodFromUrl("2026-02-02|2026-02-08")).toBeNull();
    // not real days, or the wrong way round
    expect(periodFromUrl("2026-02-30_2026-03-05")).toBeNull();
    expect(periodFromUrl("2026-13-01_2026-13-07")).toBeNull();
    expect(periodFromUrl("2026-02-08_2026-02-02")).toBeNull();
  });

  it("reads the Payslip tab's month, falling back to this month for anything that is not one", () => {
    const today = new Date(2026, 9, 13);
    expect(resolveSlipMonth({ month: "2", year: "2026" }, today)).toEqual({ month: 2, year: 2026 });
    expect(resolveSlipMonth({}, today)).toEqual({ month: 10, year: 2026 });
    expect(resolveSlipMonth({ month: "13", year: "1999" }, today)).toEqual({ month: 10, year: 2026 });
    expect(resolveSlipMonth({ month: "x", year: "2026.5" }, today)).toEqual({ month: 10, year: 2026 });
  });

  it("reads the roster's state filter, and shows everyone for anything else", () => {
    expect(rosterStateFromUrl("blocked")).toBe("blocked");
    expect(rosterStateFromUrl("paid")).toBe("paid");
    expect(rosterStateFromUrl("all")).toBe("all");
    expect(rosterStateFromUrl("bogus")).toBe("all");
    expect(rosterStateFromUrl(undefined)).toBe("all");
  });

  it("asks the insight panels about this cycle and period", () => {
    expect(productionScope("weekly", { periodStart: "2026-02-02", periodEnd: "2026-02-08" })).toEqual({
      kind: "production",
      cycle: "weekly",
      periodStart: "2026-02-02",
      periodEnd: "2026-02-08",
    });
  });

  it("round-trips the Issues view's filters through the address", () => {
    const state = issueFiltersFromUrl({
      iq: "asha",
      icode: "absent",
      isev: "warning",
      idept: "Weaving",
      ifrom: "2026-02-03",
      ito: "2026-02-05",
      igroup: "employee",
    });
    expect(state).toEqual({
      q: "asha",
      code: "absent",
      severity: "warning",
      dept: "Weaving",
      from: "2026-02-03",
      to: "2026-02-05",
      groupBy: "employee",
    });
    expect(issueFiltersToUrl(state)).toEqual({
      iq: "asha",
      icode: "absent",
      isev: "warning",
      idept: "Weaving",
      ifrom: "2026-02-03",
      ito: "2026-02-05",
      igroup: "employee",
    });
    // a change carries only what changed
    expect(issueFiltersToUrl({ q: "bala" })).toEqual({ iq: "bala" });
  });

  it("is not thrown by an Issues filter someone typed by hand", () => {
    const state = issueFiltersFromUrl({ isev: "bogus", igroup: "zzz", ifrom: "yesterday", ito: "tomorrow" });
    expect(state.severity).toBe("");
    expect(state.groupBy).toBe("date");
    expect(state.from).toBe("");
    expect(state.to).toBe("");
  });
});

describe("the Payroll register", () => {
  const run = {
    ...payroll({ id: 5, employeeName: "Bala Worker", employeeCode: "PC-W2" }),
    payCycle: "weekly",
    periodStart: "2026-02-02",
    periodEnd: "2026-02-08",
    notes: "Production period (2026-02-02 to 2026-02-08): 7 shifts",
  } as PayrollRunItem;
  const cell = (key: string) => {
    const col = PRODUCTION_REGISTER_COLUMNS.find((c) => c.key === key)!;
    return col.value ? col.value(run) : (run as unknown as Record<string, unknown>)[key];
  };

  it("lists shifts and the pay cycle, not the days of a month", () => {
    const labels = PRODUCTION_REGISTER_COLUMNS.map((c) => c.label);
    expect(labels).toContain("Shifts earned");
    expect(labels).toContain("Pay cycle");
    expect(labels).toContain("Period start");
    expect(labels).toContain("Net payable");
    expect(labels).not.toContain("Monthly salary");
    expect(labels).not.toContain("Overtime");
  });

  it("has a unique key per column", () => {
    const keys = PRODUCTION_REGISTER_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reads each cell from the payroll row", () => {
    expect(cell("employeeCode")).toBe("PC-W2");
    expect(cell("payCycle")).toBe("Weekly");
    expect(cell("periodStart")).toBe("2026-02-02");
    expect(cell("presentDays")).toBe(7);
    expect(cell("finalSalary")).toBe(3000);
  });

  it("writes the period as real dates and the money with paise", () => {
    const type = (key: string) => PRODUCTION_REGISTER_COLUMNS.find((c) => c.key === key)!.type;
    expect(type("periodStart")).toBe("date");
    expect(type("periodEnd")).toBe("date");
    expect(type("grossSalary")).toBe("money");
    expect(type("presentDays")).toBe("money");
  });

  it("leaves the cycle blank for a row from before the cycles", () => {
    const old = { ...run, payCycle: null } as PayrollRunItem;
    const col = PRODUCTION_REGISTER_COLUMNS.find((c) => c.key === "payCycle")!;
    expect(col.value!(old)).toBe("");
  });
});
