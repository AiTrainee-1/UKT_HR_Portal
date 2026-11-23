import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  MissedPayrollDownloadError,
  type MissedEntry,
  type MissedRow,
  type MissedStatus,
} from "@/lib/api-client/custom-hooks/missed-payroll";
import {
  NO_FILTERS,
  URL_DEFAULTS,
  WHOLE_COMPANY_ONLY,
  actionBlock,
  actionSplit,
  categoryCounts,
  categoryLabels,
  departmentOptions,
  eligible,
  emptyInfo,
  errorText,
  fallbackFileName,
  filtersActive,
  filtersFromUrl,
  filtersToUrl,
  generateWording,
  inView,
  leftOutByReason,
  mergeGenerate,
  monthWeeks,
  paidOnProblem,
  payrollLink,
  profileEditPath,
  regenerateNote,
  rightsBlock,
  selectable,
  selectionBlock,
  stateFromUrl,
  statusCounts,
  statusWording,
  todayIso,
  viewCounts,
  visibleRows,
  withEntries,
  type Rights,
} from "./logic";

const entry = (status: MissedStatus, over: Partial<MissedEntry> = {}): MissedEntry => ({
  id: 900,
  status,
  category: "not_generated",
  gross: 24000,
  deductions: 900,
  net: 23100,
  payRanges: [],
  payDays: 0,
  replacesPayrollId: null,
  payrollId: status === "done" || status === "paid" ? 77 : null,
  generatedAt: "2026-11-23T10:00:00+05:30",
  generatedBy: "Admin",
  clearedAt: null,
  clearedBy: null,
  doneAt: null,
  doneBy: null,
  paidAt: null,
  paidBy: null,
  paidOn: null,
  ...over,
});

const row = (id: number, over: Partial<MissedRow> = {}): MissedRow => ({
  id,
  code: String(30000 + id),
  name: `EMPLOYEE ${id}`,
  status: "active",
  departmentId: 3,
  department: "ACCOUNTS",
  designationId: 5,
  designation: "ACCOUNTANT",
  branchId: 1,
  unit: "Head Office",
  joinDate: "2024-01-10",
  salary: 25000,
  payCycle: null,
  bankIssue: null,
  category: "not_generated",
  categoryLabel: "Not generated",
  reason: "No payroll for November 2026.",
  detail: null,
  payroll: null,
  entry: null,
  canGenerate: true,
  cannotGenerate: null,
  payDays: null,
  ...over,
});

const ROWS: MissedRow[] = [
  row(1),
  row(2, { category: "no_salary", salary: null, canGenerate: false, cannotGenerate: "Set the salary first." }),
  row(3, { category: "on_hold", entry: entry("generated", { category: "on_hold" }) }),
  row(4, { category: "new_joiner", entry: entry("cleared", { category: "new_joiner" }), canGenerate: false }),
  row(5, { category: "inactive", status: "inactive", department: "STITCHING", branchId: 2 }),
  row(6, { category: "not_cleared", canGenerate: false, payroll: { id: 41 } as MissedRow["payroll"] }),
  row(7, { entry: entry("done"), canGenerate: false }),
  row(8, { entry: entry("paid"), canGenerate: false }),
  // generated while active, inactive since: in Processed, not in Missed
  row(9, { status: "inactive", entry: entry("generated") }),
];

const ALL_RIGHTS: Rights = { canEdit: true, wholeCompany: true, mayClear: true, mayDone: true, mayPay: true };

describe("the address", () => {
  it("reads the tab, view and pills, falling back to the defaults on anything unknown", () => {
    expect(stateFromUrl(URL_DEFAULTS)).toEqual({ kind: "staff", view: "missed", category: "all", status: "all" });
    expect(stateFromUrl({ tab: "production", view: "processed", cat: "on_hold", st: "done" })).toEqual({
      kind: "production",
      view: "processed",
      category: "on_hold",
      status: "done",
    });
    expect(stateFromUrl({ tab: "weekly", view: "x", cat: "inactive", st: "sent" })).toEqual({
      kind: "staff",
      view: "missed",
      category: "all",
      status: "all",
    });
  });

  it("keeps the filters in the address and goes back to page 1 when they change", () => {
    expect(filtersFromUrl({ q: "surya", dept: "ACCOUNTS", unit: "2" })).toEqual({
      search: "surya",
      department: "ACCOUNTS",
      unit: "2",
    });
    expect(filtersFromUrl({})).toEqual(NO_FILTERS);
    expect(filtersToUrl({ department: "ACCOUNTS" })).toEqual({ page: "1", dept: "ACCOUNTS" });
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, search: "  " })).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, unit: "2" })).toBe(true);
  });
});

describe("the views", () => {
  it("lists active employees of the four reasons in Missed, inactive ones only in Inactive", () => {
    const missed = ROWS.filter((r) => inView(r, "missed")).map((r) => r.id);
    expect(missed).toEqual([1, 2, 3, 4, 7, 8]);
    expect(ROWS.filter((r) => inView(r, "inactive")).map((r) => r.id)).toEqual([5]);
    expect(ROWS.filter((r) => inView(r, "not_cleared")).map((r) => r.id)).toEqual([6]);
    expect(ROWS.filter((r) => inView(r, "processed")).map((r) => r.id)).toEqual([3, 4, 7, 8, 9]);
  });

  it("narrows a view by its pill and the filters", () => {
    expect(visibleRows(ROWS, "missed", "on_hold", "all", NO_FILTERS).map((r) => r.id)).toEqual([3]);
    expect(visibleRows(ROWS, "processed", "all", "done", NO_FILTERS).map((r) => r.id)).toEqual([7]);
    // the other view's pill does not narrow this one
    expect(visibleRows(ROWS, "inactive", "on_hold", "paid", NO_FILTERS).map((r) => r.id)).toEqual([5]);
    expect(visibleRows(ROWS, "missed", "all", "all", { ...NO_FILTERS, search: "30002" }).map((r) => r.id)).toEqual([2]);
    expect(
      visibleRows(ROWS, "inactive", "all", "all", { ...NO_FILTERS, department: "stitching" }).map((r) => r.id),
    ).toEqual([5]);
    expect(visibleRows(ROWS, "missed", "all", "all", { ...NO_FILTERS, unit: "2" })).toEqual([]);
  });

  it("counts every view, reason and status under the filters", () => {
    expect(viewCounts(ROWS, NO_FILTERS)).toEqual({ missed: 6, inactive: 1, not_cleared: 1, processed: 5 });
    expect(categoryCounts(ROWS, NO_FILTERS)).toEqual({
      all: 6,
      not_generated: 3,
      no_salary: 1,
      on_hold: 1,
      new_joiner: 1,
    });
    expect(statusCounts(ROWS, NO_FILTERS)).toEqual({ all: 5, generated: 2, cleared: 1, done: 1, paid: 1 });
    expect(viewCounts(ROWS, { ...NO_FILTERS, search: "employee 5" })).toEqual({
      missed: 0,
      inactive: 1,
      not_cleared: 0,
      processed: 0,
    });
  });

  it("never ticks in Not cleared", () => {
    expect(selectable("not_cleared")).toBe(false);
    expect(selectable("missed")).toBe(true);
    expect(selectable("inactive")).toBe(true);
    expect(selectable("processed")).toBe(true);
  });

  it("offers each department name once, sorted", () => {
    expect(
      departmentOptions([{ name: "STITCHING" }, { name: "ACCOUNTS" }, { name: "accounts" }, { name: " " }]).map(
        (o) => o.value,
      ),
    ).toEqual(["ACCOUNTS", "STITCHING"]);
  });

  it("takes the server's category labels over its own", () => {
    const labels = categoryLabels([{ value: "no_salary", label: "No salary" }]);
    expect(labels.no_salary).toBe("No salary");
    expect(labels.on_hold).toBe("On hold");
  });
});

describe("the actions", () => {
  it("takes only the rows each action may take", () => {
    const split = actionSplit(ROWS);
    expect(split.generate.map((r) => r.id)).toEqual([1, 3, 5, 9]);
    expect(split.clear.map((r) => r.id)).toEqual([3, 9]);
    expect(split.discard.map((r) => r.id)).toEqual([3, 9]);
    expect(split.unclear.map((r) => r.id)).toEqual([4]);
    expect(split.done.map((r) => r.id)).toEqual([4]);
    expect(split.paid.map((r) => r.id)).toEqual([7]);
    expect(eligible([row(2, { canGenerate: false })], "generate")).toEqual([]);
    expect(withEntries(ROWS).map((r) => r.id)).toEqual([3, 4, 7, 8, 9]);
  });

  it("says why this login may not run an action", () => {
    expect(rightsBlock("generate", ALL_RIGHTS)).toBeNull();
    expect(rightsBlock("clear", { ...ALL_RIGHTS, canEdit: false })).toMatch(/edit rights/);
    expect(rightsBlock("done", { ...ALL_RIGHTS, wholeCompany: false })).toBe(WHOLE_COMPANY_ONLY);
    expect(rightsBlock("paid", { ...ALL_RIGHTS, wholeCompany: false })).toBe(WHOLE_COMPANY_ONLY);
    // a unit login may still generate and clear
    expect(rightsBlock("clear", { ...ALL_RIGHTS, wholeCompany: false })).toBeNull();
    expect(rightsBlock("clear", { ...ALL_RIGHTS, mayClear: false })).toMatch(/Cleared/);
    expect(rightsBlock("done", { ...ALL_RIGHTS, mayDone: false })).toMatch(/finalize/);
    expect(rightsBlock("paid", { ...ALL_RIGHTS, mayPay: false })).toMatch(/paid/);
  });

  it("says why none of the ticked rows can take an action", () => {
    expect(selectionBlock("done", [row(1)])).toMatch(/Only cleared entries can take Done/);
    expect(selectionBlock("paid", [row(4, { entry: entry("cleared") })])).toMatch(/none of the selected is Done/);
    expect(selectionBlock("generate", [ROWS[1]])).toBe("None of the selected can be generated. Set the salary first.");
    expect(selectionBlock("clear", [ROWS[2]])).toBeNull();
    // rights first
    expect(actionBlock("done", [ROWS[3]], { ...ALL_RIGHTS, wholeCompany: false })).toBe(WHOLE_COMPANY_ONLY);
    expect(actionBlock("done", [ROWS[3]], ALL_RIGHTS)).toBeNull();
  });
});

describe("the wording", () => {
  it("tells how a Generate went", () => {
    const one = {
      generated: [{ employeeId: 1, employeeCode: "30001", name: "A", entryId: 1, net: 1, gross: 1 }],
      skipped: [],
    };
    const skipped = {
      generated: [],
      skipped: [{ employeeId: 2, employeeCode: "30002", name: "B", reason: "No salary" }],
    };
    const both = mergeGenerate(one, skipped);
    expect(both.generated).toHaveLength(1);
    expect(both.skipped).toHaveLength(1);
    expect(generateWording(one, 1, "November 2026", null).title).toBe("1 employee generated for November 2026");
    expect(generateWording(both, 3, "November 2026", "A payroll run is in progress.")).toEqual({
      title: "1 employee generated for November 2026",
      description: "1 could not be worked out (see the list on the page). 1 not done: A payroll run is in progress.",
      variant: "destructive",
    });
    expect(generateWording(skipped, 1, "November 2026", null).variant).toBe("destructive");
  });

  it("tells how a status change went", () => {
    expect(statusWording("done", 2, 0, "November 2026", null).title).toBe(
      "2 employees added to the November 2026 payroll (Done)",
    );
    expect(statusWording("paid", 3, 1, "November 2026", null, 3)).toEqual({
      title: "3 employees marked paid",
      description: "1 not changed (see the list on the page). 3 salary-paid notifications on the way",
      variant: "default",
    });
    expect(statusWording("clear", 0, 2, "November 2026", null)).toEqual({
      title: "Nothing cleared",
      description: "2 not changed (see the list on the page)",
      variant: "destructive",
    });
  });

  it("explains an empty list by its cause", () => {
    expect(emptyInfo("missed", true, 9, "November 2026", "staff").action).toBe("clear");
    expect(emptyInfo("missed", false, 0, "November 2026", "production")).toEqual({
      title: "Nobody was missed in November 2026",
      hint: "The Production Payroll paid everyone it should for November 2026, as far as this list can see.",
      action: "previous",
    });
    expect(emptyInfo("not_cleared", false, 3, "November 2026", "staff").hint).toMatch(/marked Cleared/);
  });

  it("says what Generate again needs after an attendance change, by status", () => {
    expect(regenerateNote("generated")).toMatch(/press Generate again/);
    expect(regenerateNote("cleared")).toMatch(/Undo clear first/);
    expect(regenerateNote("done")).toMatch(/no longer changes them/);
    expect(regenerateNote(null)).toMatch(/send any change first/);
  });
});

describe("files, days and links", () => {
  it("names the files like the server does", () => {
    expect(fallbackFileName({ kind: "report" }, "staff", 11, 2026)).toBe("Missed-Payroll-Staff-November-2026.xlsx");
    expect(fallbackFileName({ kind: "statement", fmt: "pdf" }, "production", 11, 2026)).toBe(
      "Missed-Payroll-Production-November-2026-Salary-Statement.pdf",
    );
    expect(fallbackFileName({ kind: "bank-file" }, "staff", 1, 2027)).toBe(
      "Missed-Payroll-Staff-January-2027-Bank-File.xlsx",
    );
  });

  it("groups the bank check's left-out rows by reason", () => {
    expect(
      leftOutByReason({
        included: [],
        total: 0,
        leftOut: [
          { employeeId: 1, code: "1", name: "A", reason: "No IFSC code" },
          { employeeId: 2, code: "2", name: "B", reason: "Already marked paid" },
          { employeeId: 3, code: "3", name: "C", reason: "No IFSC code" },
        ],
      }),
    ).toEqual([
      { reason: "No IFSC code", count: 2 },
      { reason: "Already marked paid", count: 1 },
    ]);
  });

  it("takes a paid-on day that is real and not after today", () => {
    expect(todayIso(new Date(2026, 10, 3))).toBe("2026-11-03");
    expect(paidOnProblem("2026-11-23", "2026-11-23")).toBeNull();
    expect(paidOnProblem("2026-11-01", "2026-11-23")).toBeNull();
    expect(paidOnProblem("2026-11-24", "2026-11-23")).toMatch(/future/);
    expect(paidOnProblem("", "2026-11-23")).toMatch(/Pick/);
    expect(paidOnProblem("2026-02-30", "2026-11-23")).toMatch(/Pick/);
  });

  it("lays the month out as Monday-first weeks", () => {
    // 1 Nov 2026 is a Sunday: six empty cells before it
    const days = Array.from({ length: 30 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}` }));
    const weeks = monthWeeks(days);
    expect(weeks).toHaveLength(6);
    expect(weeks[0].slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(weeks[0][6]?.date).toBe("2026-11-01");
    expect(weeks[5][0]?.date).toBe("2026-11-30");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(monthWeeks([])).toEqual([]);
  });

  it("sends Not cleared rows to their payroll, and no-salary rows to the profile", () => {
    expect(payrollLink({ payroll: { id: 41 } as MissedRow["payroll"], payCycle: null }, "staff")).toBe(
      "/hr/payroll/details/41",
    );
    expect(payrollLink({ payroll: { id: 41 } as MissedRow["payroll"], payCycle: "weekly" }, "production")).toBe(
      "/hr/production-payroll/details/41",
    );
    expect(payrollLink({ payroll: null, payCycle: "biweekly" }, "production")).toBe("/hr/production-payroll/biweekly");
    expect(payrollLink({ payroll: null, payCycle: null }, "production")).toBeNull();
    expect(payrollLink({ payroll: null, payCycle: null }, "staff")).toBeNull();
    expect(profileEditPath(12)).toBe("/hr/employees/12/edit");
  });

  it("shows the server's own sentence for an error", () => {
    expect(errorText(new MissedPayrollDownloadError("Nobody to pay"))).toBe("Nobody to pay");
    const api = new ApiError(
      new Response(null, { status: 409 }),
      { error: "A payroll run is in progress." },
      { method: "POST", url: "/api/missed-payroll/done" },
    );
    expect(errorText(api)).toBe("A payroll run is in progress.");
    expect(errorText(null)).toMatch(/Could not reach the server/);
  });
});
