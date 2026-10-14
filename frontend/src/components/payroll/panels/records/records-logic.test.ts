import { describe, expect, it } from "vitest";
import type { PayrollRunItem } from "@/lib/api-client/custom-hooks";
import {
  cycleLabelOf,
  displayName,
  formatCount,
  isProductionRun,
  issueBadges,
  issuesOf,
  listSignature,
  markPaidTitle,
  metricLabel,
  metricText,
  NO_ISSUES,
  pageSlice,
  periodText,
} from "./records-logic";
import { isMutatingControl } from "@/lib/view-only-lock";

const run = (over: Partial<PayrollRunItem> = {}): PayrollRunItem => ({
  id: 1,
  employeeId: 10,
  employeeName: "Asha Kumar",
  employeeCode: "E2E001",
  salaryMode: "monthly",
  month: 10,
  year: 2026,
  totalWorkingDays: 26,
  presentDays: 22,
  absentDays: 4,
  otHours: 0,
  otAmount: 0,
  baseSalary: 29500,
  grossSalary: 27230,
  deductions: 1000,
  bonus: 0,
  finalSalary: 26230,
  status: "pending",
  ...over,
});

describe("formatCount", () => {
  it("writes whole numbers plainly and halves without dust", () => {
    expect(formatCount(22)).toBe("22");
    expect(formatCount(22.5)).toBe("22.5");
    expect(formatCount(22.0)).toBe("22");
    expect(formatCount(6.25)).toBe("6.25");
    expect(formatCount(22.499999999)).toBe("22.5");
    expect(formatCount(0)).toBe("0");
  });

  it("reads an unusable value as 0", () => {
    expect(formatCount(null)).toBe("0");
    expect(formatCount(undefined)).toBe("0");
    expect(formatCount(Number.NaN)).toBe("0");
  });
});

describe("names and kinds", () => {
  it("lists a row under its name, else its code, else its id", () => {
    expect(displayName(run())).toBe("Asha Kumar");
    expect(displayName(run({ employeeName: null }))).toBe("E2E001");
    expect(displayName(run({ employeeName: "", employeeCode: null }))).toBe("#10");
  });

  it("tells production rows from staff rows by their salary mode", () => {
    expect(isProductionRun(run())).toBe(false);
    expect(isProductionRun(run({ salaryMode: "shift" }))).toBe(true);
    expect(isProductionRun(run({ salaryMode: "session" }))).toBe(true);
  });
});

describe("the attendance line", () => {
  it("staff: days present of the working days", () => {
    expect(metricText(run())).toBe("22 / 26 days");
    expect(metricText(run({ presentDays: 24, totalWorkingDays: 24 }))).toBe("24 / 24 days");
    expect(metricText(run({ presentDays: 22.5 }))).toBe("22.5 / 26 days");
    expect(metricLabel(run())).toBe("Attendance");
  });

  it("production: shifts", () => {
    expect(metricText(run({ salaryMode: "shift", presentDays: 6.5 }))).toBe("6.5 shifts");
    expect(metricText(run({ salaryMode: "shift", presentDays: 1 }))).toBe("1 shift");
    expect(metricText(run({ salaryMode: "shift", presentDays: 0 }))).toBe("0 shifts");
    expect(metricLabel(run({ salaryMode: "shift" }))).toBe("Shifts");
  });

  it("an old session-based row: sessions", () => {
    expect(metricText(run({ salaryMode: "session", completedSessions: 12 }))).toBe("12 sessions");
    expect(metricText(run({ salaryMode: "session", completedSessions: null }))).toBe("0 sessions");
    expect(metricLabel(run({ salaryMode: "session" }))).toBe("Sessions");
  });
});

describe("the period and the pay cycle", () => {
  it("staff: the month", () => {
    expect(periodText(run())).toBe("October 2026");
  });

  it("production: the dates of the period", () => {
    expect(periodText(run({ salaryMode: "shift", periodStart: "2026-02-02", periodEnd: "2026-02-08", month: 2 }))).toBe(
      "2 Feb - 8 Feb 2026",
    );
    expect(
      periodText(
        run({ salaryMode: "shift", periodStart: "2026-12-29", periodEnd: "2027-01-04", month: 1, year: 2027 }),
      ),
    ).toBe("29 Dec 2026 - 4 Jan 2027");
  });

  it("an old week-numbered row: the week and its month", () => {
    expect(periodText(run({ salaryMode: "shift", weekNumber: 3, month: 2, year: 2026 }))).toBe(
      "Week 3 · February 2026",
    );
  });

  it("names the pay cycle, or none", () => {
    expect(cycleLabelOf(run({ payCycle: "weekly" }))).toBe("Weekly");
    expect(cycleLabelOf(run({ payCycle: "biweekly" }))).toBe("BiWeekly");
    expect(cycleLabelOf(run({ payCycle: "monthly" }))).toBe("Monthly");
    expect(cycleLabelOf(run({ payCycle: null }))).toBeNull();
    expect(cycleLabelOf(run({ payCycle: undefined }))).toBeNull();
    expect(cycleLabelOf(run({ payCycle: "fortnightly" }))).toBeNull();
  });
});

describe("the Mark Paid tooltip", () => {
  it("names the employee, and puts the button under the view-only lock", () => {
    expect(markPaidTitle(run())).toBe("Update the status of Asha Kumar's payroll to Paid");
    const button = document.createElement("button");
    button.textContent = "Mark Paid";
    // without the title the words "Mark Paid" are not on the lock's list, so a View Only role would see it enabled
    expect(isMutatingControl(button)).toBe(false);
    button.title = markPaidTitle(run());
    expect(isMutatingControl(button)).toBe(true);
  });
});

describe("issueBadges", () => {
  it("is empty without a summary", () => {
    expect(issueBadges(undefined)).toEqual({ severities: [], types: [], more: 0 });
    expect(issueBadges(null)).toEqual({ severities: [], types: [], more: 0 });
  });

  it("lists the severities that are not zero, worst first", () => {
    const b = issueBadges({ total: 6, bySeverity: { critical: 0, warning: 4, info: 2 }, codes: [] });
    expect(b.severities).toEqual([
      { severity: "warning", count: 4 },
      { severity: "info", count: 2 },
    ]);
  });

  it("keeps the two most frequent types, and says how many are left out", () => {
    const b = issueBadges({
      total: 9,
      bySeverity: { critical: 1, warning: 6, info: 2 },
      codes: [
        { code: "ot_pay", count: 2, severity: "info", label: "Overtime pay" },
        { code: "late_in", count: 5, severity: "warning", label: "Late arrival" },
        { code: "absent", count: 1, severity: "critical", label: "Absent" },
        { code: "half_day", count: 1, severity: "warning", label: "Half day" },
      ],
    });
    expect(b.types.map((t) => [t.code, t.count])).toEqual([
      ["late_in", 5],
      ["ot_pay", 2],
    ]);
    expect(b.more).toBe(2);
  });

  it("breaks a tie by severity, then by name", () => {
    const b = issueBadges(
      {
        total: 3,
        bySeverity: { critical: 1, warning: 1, info: 1 },
        codes: [
          { code: "ot_pay", count: 1, severity: "info", label: "Overtime pay" },
          { code: "absent", count: 1, severity: "critical", label: "Absent" },
          { code: "late_in", count: 1, severity: "warning", label: "Late arrival" },
        ],
      },
      3,
    );
    expect(b.types.map((t) => t.code)).toEqual(["absent", "late_in", "ot_pay"]);
    expect(b.more).toBe(0);
  });

  it("works from counts alone: the severity and name come from the kit", () => {
    const b = issueBadges({
      total: 3,
      bySeverity: { critical: 0, warning: 2, info: 1 },
      codes: [
        { code: "late_in", count: 2 },
        { code: "mystery_code", count: 1 },
      ],
    });
    expect(b.types).toEqual([
      { code: "late_in", count: 2, severity: "warning", label: "Late arrival" },
      { code: "mystery_code", count: 1, severity: "info", label: "mystery code" },
    ]);
  });

  it("ignores a type with no count", () => {
    const b = issueBadges({
      total: 0,
      bySeverity: { critical: 0, warning: 0, info: 0 },
      codes: [{ code: "absent", count: 0 }],
    });
    expect(b.types).toEqual([]);
    expect(b.more).toBe(0);
  });
});

describe("issuesOf", () => {
  const summary = {
    total: 2,
    bySeverity: { critical: 0, warning: 2, info: 0 },
    codes: [{ code: "late_in", count: 2 }],
  };
  const map = new Map([[7, summary]]);

  it("gives the payroll's own summary", () => {
    expect(issuesOf(map, 7)).toBe(summary);
    expect(issuesOf(map, 7, true)).toBe(summary); // data that is already there is not hidden by a refresh
  });

  it("once the issues are loaded, a payroll the map does not list has none", () => {
    expect(issuesOf(map, 8)).toBe(NO_ISSUES);
    expect(issuesOf(new Map(), 8)).toBe(NO_ISSUES);
    expect(NO_ISSUES).toEqual({ total: 0, bySeverity: { critical: 0, warning: 0, info: 0 }, codes: [] });
  });

  it("while they load, or when there is no map, the issues are unknown", () => {
    expect(issuesOf(map, 8, true)).toBeUndefined();
    expect(issuesOf(new Map(), 8, true)).toBeUndefined();
    expect(issuesOf(undefined, 8)).toBeUndefined();
    expect(issuesOf(null, 8)).toBeUndefined();
  });
});

describe("pageSlice", () => {
  const items = Array.from({ length: 45 }, (_, i) => i + 1);

  it("cuts the page asked for", () => {
    const p = pageSlice(items, 2, 20);
    expect(p.items[0]).toBe(21);
    expect(p.items).toHaveLength(20);
    expect(p).toMatchObject({ page: 2, totalPages: 3, total: 45, from: 21, to: 40 });
  });

  it("the last page is the short one", () => {
    const p = pageSlice(items, 3, 20);
    expect(p.items).toEqual([41, 42, 43, 44, 45]);
    expect(p).toMatchObject({ from: 41, to: 45 });
  });

  it("keeps a page that no longer exists inside the list", () => {
    expect(pageSlice(items, 9, 20).page).toBe(3);
    expect(pageSlice(items, 0, 20).page).toBe(1);
    expect(pageSlice(items, -4, 20).page).toBe(1);
    expect(pageSlice(items, Number.NaN, 20).page).toBe(1);
  });

  it("an empty list is page 1 of 1 with nothing shown", () => {
    expect(pageSlice([], 1, 20)).toEqual({ items: [], page: 1, totalPages: 1, total: 0, from: 0, to: 0 });
  });

  it("never divides by a zero page size", () => {
    expect(pageSlice(items, 1, 0).items).toHaveLength(1);
  });
});

describe("listSignature", () => {
  it("changes with the rows listed and their order, not with their content", () => {
    const a = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(listSignature(a)).toBe("1,2,3");
    expect(listSignature([...a].reverse())).toBe("3,2,1");
    expect(listSignature(a.slice(0, 2))).toBe("1,2");
    expect(listSignature([])).toBe("");
    expect(listSignature(a.map((r) => ({ ...r, status: "paid" })))).toBe("1,2,3");
  });
});
