import { describe, expect, it } from "vitest";
import type { AssignProductionCycleResult, ProductionEmployeeRow } from "@/lib/api-client/custom-hooks";
import {
  ALL_DEPARTMENTS,
  NO_FILTERS,
  NO_SELECTION,
  TABS,
  assignmentToast,
  chooseDefaultTab,
  confirmWording,
  deselectRows,
  emptyInfo,
  errorText,
  filtersActive,
  formatPeriod,
  formatRupees,
  hiddenSelected,
  isStatusFilter,
  isTab,
  listSelection,
  matchesTab,
  nameMap,
  needsConfirmation,
  paginate,
  payrollStatus,
  planAssignment,
  requestFilters,
  selectRows,
  selectedRows,
  selectionText,
  showingText,
  tabCount,
  tabLabel,
  toggleRow,
} from "./logic";

const row = (id: number, over: Partial<ProductionEmployeeRow> = {}): ProductionEmployeeRow => ({
  id,
  employeeCode: `P${id}`,
  name: `Worker ${id}`,
  status: "active",
  departmentId: 1,
  departmentName: "Stitching",
  designationTitle: "Tailor",
  branchId: 1,
  branchName: "Unit 1",
  joinDate: "2025-01-01",
  salaryPerShift: 650,
  payCycle: null,
  lastPayroll: null,
  ...over,
});

const counts = { weekly: 3, biweekly: 2, monthly: 1, unassigned: 4, total: 10 };

describe("tabs", () => {
  it("are All, Unassigned and the three cycles, with their labels and counts", () => {
    expect(TABS).toEqual(["all", "unassigned", "weekly", "biweekly", "monthly"]);
    expect(TABS.map(tabLabel)).toEqual(["All", "Unassigned", "Weekly", "BiWeekly", "Monthly"]);
    expect(TABS.map((t) => tabCount(counts, t))).toEqual([10, 4, 3, 2, 1]);
    expect(isTab("weekly")).toBe(true);
    expect(isTab("daily")).toBe(false);
  });

  it("opens on Unassigned while anyone is unassigned, else on All", () => {
    expect(chooseDefaultTab(counts)).toBe("unassigned");
    expect(chooseDefaultTab({ ...counts, unassigned: 0 })).toBe("all");
  });

  it("knows which rows belong on a tab", () => {
    const weekly = row(1, { payCycle: "weekly" });
    const none = row(2);
    expect(matchesTab(weekly, "all")).toBe(true);
    expect(matchesTab(weekly, "weekly")).toBe(true);
    expect(matchesTab(weekly, "monthly")).toBe(false);
    expect(matchesTab(weekly, "unassigned")).toBe(false);
    expect(matchesTab(none, "unassigned")).toBe(true);
  });
});

describe("filters", () => {
  it("are active once anything differs from the defaults", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, search: "  " })).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, search: "ravi" })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, department: "3" })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, status: "all" })).toBe(true);
    expect(isStatusFilter("inactive")).toBe(true);
    expect(isStatusFilter("fired")).toBe(false);
  });

  it("build the request: the tab is the cycle, a blank search and all departments are left out", () => {
    expect(requestFilters("unassigned", NO_FILTERS)).toEqual({
      cycle: "unassigned",
      status: "active",
      search: undefined,
      departmentId: undefined,
    });
    expect(requestFilters("weekly", { search: " ravi ", department: "7", status: "all" })).toEqual({
      cycle: "weekly",
      status: "all",
      search: "ravi",
      departmentId: 7,
    });
    // the debounced search wins over what is in the box right now
    expect(requestFilters("all", { ...NO_FILTERS, search: "rav" }, "ra").search).toBe("ra");
    expect(requestFilters("all", { ...NO_FILTERS, department: ALL_DEPARTMENTS }).departmentId).toBeUndefined();
    expect(requestFilters("all", { ...NO_FILTERS, department: "x" }).departmentId).toBeUndefined();
  });
});

describe("pages", () => {
  const rows = Array.from({ length: 60 }, (_, i) => row(i + 1));

  it("slice 25 a page and clamp the page number", () => {
    const first = paginate(rows, 1);
    expect(first.rows.map((r) => r.id)).toEqual(rows.slice(0, 25).map((r) => r.id));
    expect([first.page, first.totalPages, first.from, first.to, first.total]).toEqual([1, 3, 1, 25, 60]);
    const last = paginate(rows, 3);
    expect([last.from, last.to, last.rows.length]).toEqual([51, 60, 10]);
    expect(paginate(rows, 9).page).toBe(3);
    expect(paginate(rows, 0).page).toBe(1);
    expect(paginate([], 4)).toEqual({ rows: [], page: 1, totalPages: 1, from: 0, to: 0, total: 0 });
  });

  it("say what is shown", () => {
    expect(showingText(paginate(rows, 2))).toBe("Showing 26-50 of 60");
    expect(showingText(paginate(rows.slice(0, 3), 1))).toBe("Showing 1-3 of 3");
    expect(showingText(paginate([], 1))).toBe("Showing 0 of 0");
  });
});

describe("selection", () => {
  const a = row(1);
  const b = row(2, { payCycle: "weekly" });
  const c = row(3, { payCycle: "monthly" });

  it("toggles one, selects and deselects many, and survives the rows leaving the list", () => {
    let s = toggleRow(NO_SELECTION, a);
    expect([...s.keys()]).toEqual([1]);
    s = toggleRow(s, a);
    expect(s.size).toBe(0);
    s = selectRows(s, [a, b, c]);
    expect(s.size).toBe(3);
    s = deselectRows(s, [b]);
    expect([...s.keys()]).toEqual([1, 3]);
    expect(NO_SELECTION.size).toBe(0); // never mutated
  });

  it("reports how much of the list is ticked and how many ticked people the filters hide", () => {
    const s = selectRows(NO_SELECTION, [a, b]);
    expect(listSelection(s, [a, b, c])).toBe("some");
    expect(listSelection(s, [a, b])).toBe("all");
    expect(listSelection(s, [c])).toBe("none");
    expect(listSelection(s, [])).toBe("none");
    expect(hiddenSelected(s, [a, c])).toBe(1);
    expect(selectionText(2, "all", 0)).toBe("All 2 selected");
    expect(selectionText(2, "all", 1)).toBe("2 selected");
    expect(selectionText(1, "some", 0)).toBe("1 selected");
  });

  it("hands back the selected rows as the current list knows them", () => {
    const s = selectRows(NO_SELECTION, [b, c]);
    const moved = { ...b, payCycle: "biweekly" as const };
    expect(selectedRows(s, [a, moved]).map((r) => [r.id, r.payCycle])).toEqual([
      [2, "biweekly"],
      [3, "monthly"],
    ]);
  });
});

describe("planning an assignment", () => {
  const none1 = row(1);
  const none2 = row(2);
  const weekly3 = row(3, { payCycle: "weekly" });
  const biweekly4 = row(4, { payCycle: "biweekly" });
  const biweekly5 = row(5, { payCycle: "biweekly" });
  const monthly6 = row(6, { payCycle: "monthly" });

  it("adds unassigned people without a question", () => {
    const plan = planAssignment([none1, none2], "weekly");
    expect(plan.ids).toEqual([1, 2]);
    expect(plan.fromNone).toBe(2);
    expect(plan.moving).toEqual([]);
    expect(needsConfirmation(plan)).toBe(false);
  });

  it("asks before moving anyone between cycles, grouped by the cycle they leave", () => {
    const plan = planAssignment([none1, weekly3, biweekly4, biweekly5, monthly6], "weekly");
    expect(plan.moving).toEqual([
      { from: "biweekly", count: 2 },
      { from: "monthly", count: 1 },
    ]);
    expect(plan.movingCount).toBe(3);
    expect(plan.alreadyThere).toBe(1);
    expect(plan.fromNone).toBe(1);
    expect(needsConfirmation(plan)).toBe(true);
    const words = confirmWording(plan);
    expect(words.title).toBe("Move 3 employees to Weekly?");
    expect(words.lines[0]).toBe("2 from BiWeekly and 1 from Monthly.");
    expect(words.lines).toContainEqual("1 employee with no cycle yet will simply join Weekly.");
    expect(words.lines).toContainEqual("1 employee already on Weekly stay as they are.");
  });

  it("names the one cycle people leave when there is only one", () => {
    const plan = planAssignment([biweekly4, biweekly5, biweekly5, biweekly4], "weekly");
    expect(confirmWording(plan).title).toBe("Move 4 employees from BiWeekly to Weekly?");
    expect(confirmWording(planAssignment([monthly6], "weekly")).title).toBe("Move 1 employee from Monthly to Weekly?");
  });

  it("asks before removing people from their cycle, and not when nobody is on one", () => {
    const plan = planAssignment([weekly3, monthly6, none1], null);
    expect(plan.movingCount).toBe(2);
    expect(plan.alreadyThere).toBe(1);
    expect(needsConfirmation(plan)).toBe(true);
    const words = confirmWording(plan);
    expect(words.title).toBe("Remove 2 employees from their pay cycle?");
    expect(words.lines[0]).toBe("They will not be included in any payroll until they are assigned again.");
    expect(words.lines).toContainEqual("1 employee in the selection was not on a cycle.");
    expect(needsConfirmation(planAssignment([none1, none2], null))).toBe(false);
  });
});

describe("the toast after an assignment", () => {
  const ok: AssignProductionCycleResult = { updated: 12, unchanged: 0, skipped: [], pendingOnOtherCycle: 0, counts };

  it("says who was assigned, and who already was", () => {
    expect(assignmentToast(ok, "weekly")).toEqual({
      title: "12 employees assigned to Weekly",
      lines: [],
      variant: undefined,
    });
    expect(assignmentToast({ ...ok, updated: 1, unchanged: 3 }, "monthly")).toEqual({
      title: "1 employee assigned to Monthly",
      lines: ["3 were already on it."],
      variant: undefined,
    });
    expect(assignmentToast({ ...ok, updated: 0, unchanged: 1 }, "weekly")).toEqual({
      title: "Nobody was assigned to Weekly",
      lines: ["1 was already on it."],
      variant: undefined,
    });
  });

  it("words a removal", () => {
    expect(assignmentToast({ ...ok, updated: 2, unchanged: 1 }, null)).toEqual({
      title: "2 employees removed from their pay cycle",
      lines: ["1 was not on a cycle."],
      variant: undefined,
    });
    expect(assignmentToast({ ...ok, updated: 0 }, null).title).toBe("Nobody was removed from a pay cycle");
  });

  it("adds the unpaid-payroll notice and the first skipped reasons by name, and turns red when anyone was skipped", () => {
    const names = nameMap([row(7, { name: "Ravi", employeeCode: "P7" }), row(8, { name: "Mani", employeeCode: "P8" })]);
    const t = assignmentToast(
      {
        ...ok,
        updated: 4,
        pendingOnOtherCycle: 2,
        skipped: [
          { employeeId: 7, reason: "no salary per shift" },
          { employeeId: 8, reason: "inactive" },
          { employeeId: 9, reason: "not production" },
          { employeeId: 10, reason: "not production" },
          { employeeId: 11, reason: "not production" },
        ],
      },
      "biweekly",
      names,
    );
    expect(t.title).toBe("4 employees assigned to BiWeekly");
    expect(t.variant).toBe("destructive");
    expect(t.lines).toEqual([
      "2 of them still have unpaid payroll on their previous cycle; it stays on that cycle's page until it is paid.",
      "Skipped 5 employees. Ravi (P7): no salary per shift; Mani (P8): inactive; #9: not production; and 2 more.",
    ]);
    expect(assignmentToast({ ...ok, pendingOnOtherCycle: 1 }, "weekly").lines[0]).toMatch(/^1 of them still has /);
  });

  it("keeps the server's words out of an error, without the HTTP prefix", () => {
    expect(errorText(new Error("HTTP 400 Bad Request: Employee 9 is not a production employee"))).toBe(
      "Employee 9 is not a production employee",
    );
    expect(errorText(new Error("Failed to fetch"))).toBe("Failed to fetch");
    expect(errorText(undefined)).toBe("Could not reach the server. Check the connection and try again.");
  });
});

describe("a row's cells", () => {
  it("formats rupees in Indian grouping and leaves a missing rate to the chip", () => {
    expect(formatRupees(650)).toBe("₹650");
    expect(formatRupees(650.5)).toBe("₹650.5");
    expect(formatRupees(123456)).toBe("₹1,23,456");
    expect(formatRupees(null)).toBeNull();
    expect(formatRupees(Number.NaN)).toBeNull();
  });

  it("formats a pay period on one line, the year once unless it changes", () => {
    expect(formatPeriod("2026-02-02", "2026-02-08")).toBe("2 Feb - 8 Feb 2026");
    expect(formatPeriod("2025-12-29", "2026-01-04")).toBe("29 Dec 2025 - 4 Jan 2026");
    expect(formatPeriod("soon", "2026-01-04")).toBe("soon - 2026-01-04");
  });

  it("colours a payslip's status", () => {
    expect(payrollStatus("paid")).toEqual({ label: "Cleared", tone: "success" });
    expect(payrollStatus("pending")).toEqual({ label: "Pending", tone: "warning" });
    expect(payrollStatus("on_hold")).toEqual({ label: "On_hold", tone: "neutral" });
    expect(payrollStatus("")).toEqual({ label: "Unknown", tone: "neutral" });
  });
});

describe("empty states", () => {
  it("tell the reader why and what to do", () => {
    expect(emptyInfo("weekly", true, 10)).toMatchObject({
      kind: "filtered",
      title: "Nothing matches",
      action: "clear",
    });
    expect(emptyInfo("all", false, 0)).toMatchObject({
      kind: "none",
      title: "No production employees yet",
      action: null,
    });
    expect(emptyInfo("all", false, 0).hint).toContain("created on Employees");
    expect(emptyInfo("unassigned", false, 10)).toMatchObject({
      kind: "tab",
      title: "Everyone is assigned",
      action: null,
    });
    expect(emptyInfo("biweekly", false, 10)).toEqual({
      kind: "tab",
      title: "Nobody is on the BiWeekly cycle yet",
      hint: "Open Unassigned, select employees and assign them to BiWeekly.",
      action: "open-unassigned",
    });
  });
});
