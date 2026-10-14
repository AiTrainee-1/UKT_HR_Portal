import { describe, expect, it } from "vitest";
import type { IssueCode, IssueSeverity, PayrollIssue, PayrollRunItem } from "@/lib/api-client/custom-hooks";
import {
  DEFAULT_FILTERS,
  FILTER_URL_DEFAULTS,
  activeFilterCount,
  applyPayrollFilters,
  buildIssueIndex,
  buildIssueSummaries,
  departmentLabel,
  departmentOptionsFromRuns,
  filterChips,
  filtersFromUrl,
  filtersToUrl,
  hasChanges,
  issueFilterOptions,
  issueTypeLabel,
  joinSeverities,
  parseSeverities,
  toggleSeverity,
  type PayrollFilterState,
} from "./filter-logic";

const run = (id: number, name: string, code: string, over: Partial<PayrollRunItem> = {}): PayrollRunItem => ({
  id,
  employeeId: id * 100,
  employeeName: name,
  employeeCode: code,
  departmentId: 1,
  departmentName: "Weaving",
  salaryMode: "monthly",
  month: 10,
  year: 2026,
  totalWorkingDays: 26,
  presentDays: 26,
  absentDays: 0,
  otHours: 0,
  otAmount: 0,
  baseSalary: 10000,
  grossSalary: 10000,
  deductions: 0,
  bonus: 0,
  finalSalary: 10000,
  status: "pending",
  ...over,
});

const issue = (
  payrollId: number | null,
  code: IssueCode,
  severity: IssueSeverity,
  over: Partial<PayrollIssue> = {},
): PayrollIssue => ({
  id: `${payrollId}:${code}:${over.date ?? "period"}`,
  payrollId,
  employeeId: (payrollId ?? 0) * 100,
  employeeCode: "X",
  employeeName: "X",
  department: null,
  designation: null,
  code,
  category: "attendance",
  severity,
  title: code === "late_in" ? "Late arrival" : code === "absent" ? "Absent" : code,
  detail: "",
  date: null,
  detectedAt: null,
  impact: null,
  rule: null,
  ...over,
});

const RUNS: PayrollRunItem[] = [
  run(1, "Asha Kumar", "E2E001", { finalSalary: 24000, status: "paid", departmentId: 1, departmentName: "Weaving" }),
  run(2, "ravi nair", "E2E002", { finalSalary: 15000, departmentId: 2, departmentName: "Stitching" }),
  run(3, "Meena Das", "PC-W3", { finalSalary: 30000, departmentId: null, departmentName: null }),
  run(4, "Bala Worker", "PC-W2", { finalSalary: 15000, departmentId: 2, departmentName: "Stitching" }),
];

const ISSUES: PayrollIssue[] = [
  issue(1, "late_in", "warning", { date: "2026-10-02" }),
  issue(1, "late_in", "warning", { date: "2026-10-05" }),
  issue(1, "ot_pay", "info"),
  issue(2, "absent", "critical", { date: "2026-10-03" }),
  issue(4, "late_in", "warning", { date: "2026-10-04" }),
  issue(null, "skipped", "critical"),
];

const state = (over: Partial<PayrollFilterState> = {}): PayrollFilterState => ({ ...DEFAULT_FILTERS, ...over });
const ids = (rows: PayrollRunItem[]) => rows.map((r) => r.id);

describe("severities", () => {
  it("reads a list worst first and drops what it does not know", () => {
    expect(parseSeverities("warning,critical")).toEqual(["critical", "warning"]);
    expect(parseSeverities("info, bogus ,critical")).toEqual(["critical", "info"]);
    expect(parseSeverities("all")).toEqual([]);
    expect(parseSeverities("")).toEqual([]);
    expect(parseSeverities(null)).toEqual([]);
    expect(parseSeverities(undefined)).toEqual([]);
  });

  it("writes it back, with 'all' for none", () => {
    expect(joinSeverities(["info", "critical"])).toBe("critical,info");
    expect(joinSeverities([])).toBe("all");
  });

  it("toggles one chip at a time", () => {
    expect(toggleSeverity("all", "warning")).toBe("warning");
    expect(toggleSeverity("warning", "critical")).toBe("critical,warning");
    expect(toggleSeverity("critical,warning", "critical")).toBe("warning");
    expect(toggleSeverity("warning", "warning")).toBe("all");
  });
});

describe("how many filters are on", () => {
  it("is 0 for the defaults, and the sort is not a filter", () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount(state({ sort: "net" }))).toBe(0);
  });

  it("counts each filter once", () => {
    expect(activeFilterCount(state({ q: "ravi" }))).toBe(1);
    expect(activeFilterCount(state({ q: "   " }))).toBe(0);
    expect(activeFilterCount(state({ dept: "3" }))).toBe(1);
    expect(activeFilterCount(state({ status: "paid" }))).toBe(1);
    expect(activeFilterCount(state({ issue: "late_in" }))).toBe(1);
    expect(activeFilterCount(state({ onlyIssues: true }))).toBe(1);
  });

  it("counts each chosen severity, as many as it has chips", () => {
    expect(activeFilterCount(state({ severity: "critical" }))).toBe(1);
    expect(activeFilterCount(state({ severity: "critical,warning" }))).toBe(2);
    const all = state({
      q: "a",
      dept: "1",
      status: "pending",
      issue: "absent",
      severity: "critical,info",
      onlyIssues: true,
    });
    expect(activeFilterCount(all)).toBe(7);
    expect(filterChips(all)).toHaveLength(7);
  });

  it("offers Reset when a filter is on or the sort was changed", () => {
    expect(hasChanges(DEFAULT_FILTERS)).toBe(false);
    expect(hasChanges(state({ status: "paid" }))).toBe(true);
    expect(hasChanges(state({ sort: "issues" }))).toBe(true);
  });
});

describe("labels and chips", () => {
  it("names a department from the list, 'No department', or a fallback", () => {
    const depts = [
      { id: 4, name: "Weaving" },
      { id: "7", name: "Stitching" },
    ];
    expect(departmentLabel("all", depts)).toBe("All departments");
    expect(departmentLabel("none", depts)).toBe("No department");
    expect(departmentLabel("4", depts)).toBe("Weaving");
    expect(departmentLabel("7", depts)).toBe("Stitching");
    expect(departmentLabel("99", depts)).toBe("Department 99");
  });

  it("names an issue type from the options, else from the kit", () => {
    const options = [
      {
        code: "late_in" as const,
        label: "Late (custom)",
        severity: "warning" as const,
        category: "attendance" as const,
        count: 2,
      },
    ];
    expect(issueTypeLabel("late_in", options)).toBe("Late (custom)");
    expect(issueTypeLabel("absent", options)).toBe("Absent");
    expect(issueTypeLabel("unheard_of_code", options)).toBe("unheard of code");
  });

  it("writes one removable chip per filter, each with the change that clears it", () => {
    const chips = filterChips(
      state({
        q: " ravi ",
        dept: "2",
        status: "pending",
        issue: "late_in",
        severity: "critical,warning",
        onlyIssues: true,
      }),
      { departments: [{ id: 2, name: "Stitching" }] },
    );
    expect(chips.map((c) => [c.key, c.label])).toEqual([
      ["q", 'Search: "ravi"'],
      ["dept", "Department: Stitching"],
      ["status", "Payment: Pending"],
      ["issue", "Issue: Late arrival"],
      ["severity-critical", "Severity: Critical"],
      ["severity-warning", "Severity: Needs a look"],
      ["onlyIssues", "Only with issues"],
    ]);
    expect(chips.map((c) => c.clear)).toEqual([
      { q: "" },
      { dept: "all" },
      { status: "all" },
      { issue: "all" },
      { severity: "warning" },
      { severity: "critical" },
      { onlyIssues: false },
    ]);
  });

  it("has no chips when nothing is filtered", () => {
    expect(filterChips(DEFAULT_FILTERS)).toEqual([]);
  });
});

describe("departmentOptionsFromRuns", () => {
  it("lists each department once by name, with 'No department' last when some rows have none", () => {
    expect(departmentOptionsFromRuns(RUNS)).toEqual([
      { id: "2", name: "Stitching" },
      { id: "1", name: "Weaving" },
      { id: "none", name: "No department" },
    ]);
  });

  it("has no 'No department' when every row has one, and is empty for nothing", () => {
    expect(departmentOptionsFromRuns(RUNS.filter((r) => r.departmentId !== null)).some((o) => o.id === "none")).toBe(
      false,
    );
    expect(departmentOptionsFromRuns([])).toEqual([]);
    expect(departmentOptionsFromRuns(undefined)).toEqual([]);
  });
});

describe("the issue index and summaries", () => {
  it("groups issues by payroll, with what filtering needs", () => {
    const index = buildIssueIndex(ISSUES);
    expect([...index.keys()].sort()).toEqual([1, 2, 4]);
    expect(index.get(1)).toEqual({
      total: 3,
      codes: new Set(["late_in", "ot_pay"]),
      severities: new Set(["warning", "info"]),
    });
    expect(index.get(2)?.severities).toEqual(new Set(["critical"]));
    expect(index.has(3)).toBe(false);
  });

  it("leaves out an issue that has no payroll (a skipped employee)", () => {
    const index = buildIssueIndex([issue(null, "skipped", "critical")]);
    expect(index.size).toBe(0);
  });

  it("is empty for nothing", () => {
    expect(buildIssueIndex([]).size).toBe(0);
    expect(buildIssueIndex(undefined).size).toBe(0);
    expect(buildIssueSummaries(null).size).toBe(0);
  });

  it("sums a payroll's issues by severity and by type, most frequent type first", () => {
    const summaries = buildIssueSummaries(ISSUES);
    expect(summaries.get(1)).toEqual({
      total: 3,
      bySeverity: { critical: 0, warning: 2, info: 1 },
      codes: [
        { code: "late_in", count: 2, severity: "warning", label: "Late arrival" },
        { code: "ot_pay", count: 1, severity: "info", label: "ot_pay" },
      ],
    });
    expect(summaries.get(2)?.bySeverity).toEqual({ critical: 1, warning: 0, info: 0 });
    expect(summaries.get(3)).toBeUndefined();
  });

  it("falls back to the kit's name when an issue has no title, and breaks a tie by severity", () => {
    const summaries = buildIssueSummaries([
      issue(9, "ot_pay", "info", { title: "" }),
      issue(9, "absent", "critical", { title: "Absent" }),
    ]);
    expect(summaries.get(9)?.codes).toEqual([
      { code: "absent", count: 1, severity: "critical", label: "Absent" },
      { code: "ot_pay", count: 1, severity: "info", label: "Overtime pay" },
    ]);
  });

  it("offers the types that have issues, worst severity first, never 'skipped'", () => {
    const options = issueFilterOptions([
      { code: "ot_pay", label: "Overtime pay", severity: "info", category: "pay", count: 9 },
      { code: "late_in", label: "Late arrival", severity: "warning", category: "attendance", count: 4 },
      { code: "late_penalty", label: "Late deduction", severity: "warning", category: "pay", count: 7 },
      { code: "absent", label: "Absent", severity: "critical", category: "attendance", count: 1 },
      { code: "skipped", label: "Skipped at generation", severity: "critical", category: "generation", count: 3 },
      { code: "no_shift", label: "No shift assigned", severity: "warning", category: "rule", count: 0 },
    ]);
    expect(options.map((o) => o.code)).toEqual(["absent", "late_penalty", "late_in", "ot_pay"]);
    expect(issueFilterOptions(undefined)).toEqual([]);
  });
});

describe("applyPayrollFilters", () => {
  const index = buildIssueIndex(ISSUES);

  it("with nothing chosen returns everyone by name, and never changes the input", () => {
    const input = [...RUNS].reverse();
    const copy = [...input];
    const out = applyPayrollFilters(input, DEFAULT_FILTERS, index);
    expect(ids(out)).toEqual([1, 4, 3, 2]); // Asha, Bala, Meena, ravi
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
  });

  it("returns an empty list for nothing", () => {
    expect(applyPayrollFilters([], DEFAULT_FILTERS)).toEqual([]);
    expect(applyPayrollFilters(undefined, DEFAULT_FILTERS)).toEqual([]);
    expect(applyPayrollFilters(null, DEFAULT_FILTERS)).toEqual([]);
  });

  describe("search", () => {
    it("finds a name in any case, and a code", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ q: "RAVI" })))).toEqual([2]);
      expect(ids(applyPayrollFilters(RUNS, state({ q: "asha" })))).toEqual([1]);
      expect(ids(applyPayrollFilters(RUNS, state({ q: "e2e00" })))).toEqual([1, 2]);
      expect(ids(applyPayrollFilters(RUNS, state({ q: "pc-w" })))).toEqual([4, 3]);
    });

    it("needs every word, in any order, across name and code", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ q: "nair ravi" })))).toEqual([2]);
      expect(ids(applyPayrollFilters(RUNS, state({ q: "ravi e2e002" })))).toEqual([2]);
      expect(ids(applyPayrollFilters(RUNS, state({ q: "ravi asha" })))).toEqual([]);
    });

    it("ignores surrounding and repeated spaces, and an empty query matches all", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ q: "   ravi    nair  " })))).toEqual([2]);
      expect(applyPayrollFilters(RUNS, state({ q: "   " }))).toHaveLength(4);
    });

    it("copes with a row that has no name or code", () => {
      const bare = [run(5, "", "", { employeeName: null, employeeCode: null })];
      expect(applyPayrollFilters(bare, state({ q: "x" }))).toEqual([]);
      expect(applyPayrollFilters(bare, DEFAULT_FILTERS)).toHaveLength(1);
    });
  });

  describe("department", () => {
    it("matches by id", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ dept: "2" })))).toEqual([4, 2]);
      expect(ids(applyPayrollFilters(RUNS, state({ dept: "1" })))).toEqual([1]);
      expect(applyPayrollFilters(RUNS, state({ dept: "77" }))).toEqual([]);
    });

    it("'none' keeps only the rows without a department", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ dept: "none" })))).toEqual([3]);
    });
  });

  describe("payment status", () => {
    it("paid and pending", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ status: "paid" })))).toEqual([1]);
      expect(ids(applyPayrollFilters(RUNS, state({ status: "pending" })))).toEqual([4, 3, 2]);
      expect(applyPayrollFilters(RUNS, state({ status: "all" }))).toHaveLength(4);
    });

    it("anything that is not paid still counts as pending", () => {
      const rows = [run(1, "A", "A", { status: "draft" }), run(2, "B", "B", { status: "paid" })];
      expect(ids(applyPayrollFilters(rows, state({ status: "pending" })))).toEqual([1]);
    });
  });

  describe("issues", () => {
    it("by issue type", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ issue: "late_in" }), index))).toEqual([1, 4]);
      expect(ids(applyPayrollFilters(RUNS, state({ issue: "absent" }), index))).toEqual([2]);
      expect(applyPayrollFilters(RUNS, state({ issue: "bank_missing" }), index)).toEqual([]);
    });

    it("by one severity", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ severity: "critical" }), index))).toEqual([2]);
      expect(ids(applyPayrollFilters(RUNS, state({ severity: "info" }), index))).toEqual([1]);
    });

    it("by several severities: any of them", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ severity: "critical,info" }), index))).toEqual([1, 2]);
      expect(ids(applyPayrollFilters(RUNS, state({ severity: "critical,warning,info" }), index))).toEqual([1, 4, 2]);
    });

    it("only with issues drops the clean payrolls", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ onlyIssues: true }), index))).toEqual([1, 4, 2]);
    });

    it("a payroll the index does not list has no issues", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ onlyIssues: true }), new Map()))).toEqual([]);
      expect(applyPayrollFilters(RUNS, state({ issue: "late_in" }), new Map())).toEqual([]);
    });

    it("are left out while the issues have not loaded, so no row is hidden for a reason nobody can see", () => {
      const filters = state({ issue: "late_in", severity: "critical", onlyIssues: true });
      expect(applyPayrollFilters(RUNS, filters)).toHaveLength(4);
      expect(applyPayrollFilters(RUNS, filters, null)).toHaveLength(4);
      expect(applyPayrollFilters(RUNS, filters, undefined)).toHaveLength(4);
    });
  });

  it("combines every filter: a row must pass all of them", () => {
    const filters = state({
      q: "a",
      dept: "2",
      status: "pending",
      issue: "late_in",
      severity: "warning",
      onlyIssues: true,
    });
    expect(ids(applyPayrollFilters(RUNS, filters, index))).toEqual([4]); // Bala: Stitching, pending, late arrival
    expect(applyPayrollFilters(RUNS, { ...filters, dept: "1" }, index)).toEqual([]); // Asha is paid in Weaving
  });

  describe("sort", () => {
    it("by name, case-insensitively, a code breaking a tie", () => {
      const rows = [run(3, "bala", "B2"), run(1, "Bala", "B1"), run(2, "Anu", "A1")];
      expect(ids(applyPayrollFilters(rows, state({ sort: "name" })))).toEqual([2, 1, 3]);
    });

    it("by name with numbers in order: Worker 2 before Worker 10", () => {
      const rows = [run(1, "Worker 10", "W10"), run(2, "Worker 2", "W2")];
      expect(ids(applyPayrollFilters(rows, state({ sort: "name" })))).toEqual([2, 1]);
    });

    it("by net, high to low, a tie by name", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ sort: "net" })))).toEqual([3, 1, 4, 2]);
    });

    it("by most issues, a tie (or none) by name", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ sort: "issues" }), index))).toEqual([1, 4, 2, 3]);
    });

    it("by issues without an index falls back to the name", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ sort: "issues" })))).toEqual([1, 4, 3, 2]);
    });

    it("sorts the filtered rows only", () => {
      expect(ids(applyPayrollFilters(RUNS, state({ dept: "2", sort: "net" })))).toEqual([4, 2]);
    });
  });
});

describe("the filters in the address", () => {
  it("has a default for every key, a clean address for the defaults", () => {
    expect(Object.keys(FILTER_URL_DEFAULTS).sort()).toEqual([
      "dept",
      "issue",
      "issues",
      "q",
      "severity",
      "sort",
      "status",
    ]);
    expect(filtersFromUrl({})).toEqual(DEFAULT_FILTERS);
    expect(filtersFromUrl(FILTER_URL_DEFAULTS)).toEqual(DEFAULT_FILTERS);
  });

  it("reads every filter from the address", () => {
    expect(
      filtersFromUrl({
        q: "ravi",
        dept: "4",
        status: "paid",
        issue: "late_in",
        severity: "warning,critical",
        issues: "1",
        sort: "net",
      }),
    ).toEqual({
      q: "ravi",
      dept: "4",
      status: "paid",
      issue: "late_in",
      severity: "critical,warning",
      onlyIssues: true,
      sort: "net",
    });
  });

  it("falls back to the defaults for a hand-edited address", () => {
    expect(filtersFromUrl({ status: "bogus", sort: "sideways", severity: "loud", issues: "yes" })).toEqual(
      DEFAULT_FILTERS,
    );
    expect(filtersFromUrl({ dept: "", issue: "", q: undefined })).toEqual(DEFAULT_FILTERS);
    expect(filtersFromUrl({ issues: "true" }).onlyIssues).toBe(true);
  });

  it("writes a change as address values; a switch that is off is written empty so the setter drops it", () => {
    expect(filtersToUrl({ q: "ravi" })).toEqual({ q: "ravi" });
    expect(filtersToUrl({ onlyIssues: true })).toEqual({ issues: "1" });
    expect(filtersToUrl({ onlyIssues: false })).toEqual({ issues: "" });
    expect(filtersToUrl({ severity: "warning,critical" })).toEqual({ severity: "critical,warning" });
    expect(filtersToUrl({})).toEqual({});
  });

  it("round-trips a whole state", () => {
    const full = state({
      q: "ravi",
      dept: "none",
      status: "pending",
      issue: "absent",
      severity: "critical",
      onlyIssues: true,
      sort: "issues",
    });
    expect(filtersFromUrl(filtersToUrl(full))).toEqual(full);
    expect(filtersFromUrl(filtersToUrl(DEFAULT_FILTERS))).toEqual(DEFAULT_FILTERS);
  });

  it("writes the defaults as values equal to the address defaults, so useUrlParams leaves them out", () => {
    const written = filtersToUrl(DEFAULT_FILTERS);
    for (const [key, value] of Object.entries(written)) {
      expect(value === "" || value === FILTER_URL_DEFAULTS[key as keyof typeof FILTER_URL_DEFAULTS]).toBe(true);
    }
  });
});
