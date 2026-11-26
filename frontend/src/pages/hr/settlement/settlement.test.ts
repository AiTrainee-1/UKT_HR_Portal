import { describe, expect, it, vi } from "vitest";
import { hasBothCategories, namedOrgOptions } from "@/lib/departments";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  DEFAULT_FILTERS,
  DEFAULT_FILTER_URL,
  DEFAULT_SORT,
  SETTLEMENT_URL_DEFAULTS,
  appliedByEmployee,
  approvalDefaults,
  approvalEmi,
  approvalPayload,
  approvalPreview,
  approvalProblem,
  approvalRemarkProblem,
  approvedLess,
  approvedOf,
  NO_FILTERS,
  EXPORT_STATUS_OPTIONS,
  BASIS_OPTIONS,
  COLUMN_CHOICE_KEY,
  DEFAULT_COLUMN_KEYS,
  EXPORT_COLUMNS,
  EXTRA_COLUMN_KEYS,
  SETTLEMENT_TABS,
  TAB_NOUN,
  bankFileLines,
  bankFileName,
  bankFileRows,
  bankFileSheet,
  bankFileTotal,
  cleanColumnChoice,
  currentPeriod,
  isDefaultPeriod,
  loadColumnChoice,
  missingBankDetails,
  periodToUrl,
  reportDefaults,
  reportState,
  saveColumnChoice,
  statusMatches,
  TYPE_LABEL,
  buildExport,
  canDelete,
  cleanRemark,
  decidedAtOf,
  deductionMonths,
  describeSchedule,
  describeScope,
  earnedPeriodLabel,
  emptyForm,
  exportColumns,
  exportState,
  exportStatusLabel,
  filterRows,
  filtersActive,
  filtersFromUrl,
  filtersToUrl,
  formLimit,
  formOverLimit,
  formPreview,
  hasLeft,
  historyText,
  inPeriod,
  overLimitBy,
  overLimitRefusal,
  pageView,
  parseBasis,
  parsePeriod,
  parseSort,
  parseTab,
  periodLabel,
  pickFilterUrl,
  previewForAdvance,
  progressPct,
  rejectionPayload,
  rejectionProblem,
  remarkRequired,
  rowsOfTab,
  schedulePreview,
  serverError,
  sortRows,
  startWarning,
  statusCounts,
  summarize,
  tabFilters,
  toPayload,
  validateForm,
  yearOptions,
  type AdvanceForm,
  type ApprovalEdit,
  type PageState,
  type SettlementRow,
} from "./logic";
import { buildStatementHtml } from "./statement";
import { formatDate, formatMoney, initials, inDayRange, localDay, matchesWords, rangeProblem } from "./shared";

let nextId = 1;
const adv = (over: Partial<SettlementRow> = {}): SettlementRow => ({
  id: nextId++,
  employeeId: 1,
  employeeCode: "E001",
  employeeName: "Asha Kumar",
  employeeDepartment: "Stitching",
  employeeDesignation: "Operator",
  employeePhone: null,
  employeeEmail: null,
  employeeBranch: "Tiruppur",
  employeeBranchId: 1,
  employeeType: "production",
  employeeStatus: "active",
  advanceType: "general",
  amount: 10000,
  purpose: "Medical",
  status: "pending",
  emiAmount: 0,
  totalRepaid: 0,
  outstanding: 10000,
  createdAt: "2026-10-05T08:00:00Z",
  ...over,
});

const form = (over: Partial<AdvanceForm> = {}): AdvanceForm => ({
  ...emptyForm(new Date(2026, 9, 10)),
  employeeId: "7",
  amount: "12000",
  ...over,
});

const edit = (over: Partial<ApprovalEdit> = {}): ApprovalEdit => ({
  amount: "10000",
  startMonth: 11,
  startYear: 2026,
  remark: "",
  ...over,
});

const page = (over: Partial<PageState> = {}): PageState => ({
  tab: "overview",
  period: null,
  basis: "applied",
  filters: NO_FILTERS,
  sort: DEFAULT_SORT,
  ...over,
});

describe("summary", () => {
  it("counts pending, active, completed and what employees who left still owe", () => {
    const rows = [
      adv({ status: "pending", amount: 5000 }),
      adv({ status: "pending", amount: 2500 }),
      adv({
        status: "approved",
        advanceType: "term",
        emiAmount: 1000,
        totalRepaid: 3000,
        outstanding: 9000,
        amount: 12000,
      }),
      adv({ status: "approved", totalRepaid: 0, outstanding: 4000, employeeStatus: "inactive" }),
      adv({ status: "closed", totalRepaid: 6000, outstanding: 0 }),
      adv({ status: "rejected", amount: 99999 }),
    ];
    expect(summarize(rows)).toEqual({
      pendingCount: 2,
      pendingAmount: 7500,
      activeCount: 2,
      outstanding: 13000,
      monthlyEmi: 1000,
      recovered: 9000,
      completedCount: 1,
      leftCount: 1,
      leftOutstanding: 4000,
    });
  });

  it("is all zero for no advances, and ignores rejected ones", () => {
    expect(summarize([]).activeCount).toBe(0);
    expect(summarize([adv({ status: "rejected" })]).pendingAmount).toBe(0);
  });

  it("does not count a left employee's advance that is fully recovered as owed", () => {
    const s = summarize([adv({ status: "approved", employeeStatus: "inactive", outstanding: 0, totalRepaid: 10000 })]);
    expect(s.leftCount).toBe(0);
    expect(s.leftOutstanding).toBe(0);
  });

  it("hasLeft needs a status that is not active", () => {
    expect(hasLeft(adv({ employeeStatus: "active" }))).toBe(false);
    expect(hasLeft(adv({ employeeStatus: undefined }))).toBe(false);
    expect(hasLeft(adv({ employeeStatus: "resigned" }))).toBe(true);
  });

  it("progressPct is 0-100 and safe for a zero amount", () => {
    expect(progressPct({ amount: 0, totalRepaid: 0 })).toBe(0);
    expect(progressPct({ amount: 1000, totalRepaid: 250 })).toBe(25);
    expect(progressPct({ amount: 1000, totalRepaid: 5000 })).toBe(100);
  });
});

describe("filters", () => {
  const rows = [
    adv({ employeeName: "Asha Kumar", employeeCode: "E001", status: "pending" }),
    adv({
      employeeName: "Ravi Shankar",
      employeeCode: "E002",
      status: "approved",
      advanceType: "term",
      employeeBranch: "Erode",
      employeeDepartment: "Cutting",
      employeeType: "staff",
      createdAt: "2026-09-02T08:00:00Z",
    }),
    adv({
      employeeName: "Meena",
      employeeCode: "E003",
      status: "closed",
      employeeStatus: "inactive",
      purpose: "Wedding",
    }),
  ];

  it("a search needs every word, in the name, code, department, branch or purpose", () => {
    expect(filterRows(rows, { ...NO_FILTERS, query: "asha kumar" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, query: "e002" })[0].employeeName).toBe("Ravi Shankar");
    expect(filterRows(rows, { ...NO_FILTERS, query: "erode cutting" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, query: "wedding" })[0].employeeName).toBe("Meena");
    expect(filterRows(rows, { ...NO_FILTERS, query: "asha nobody" })).toHaveLength(0);
  });

  it("filters by status, type, branch, department, employee type and employment", () => {
    expect(filterRows(rows, { ...NO_FILTERS, status: "approved" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, type: "term" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, branch: "Erode" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, department: "Stitching" })).toHaveLength(2);
    expect(filterRows(rows, { ...NO_FILTERS, employeeType: "staff" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, employee: "left" }).map((r) => r.employeeCode)).toEqual(["E003"]);
    expect(filterRows(rows, { ...NO_FILTERS, employee: "active" })).toHaveLength(2);
  });

  it("tells a Staff and a Production department of the same name apart (namedOrgOptions)", () => {
    const split = [
      adv({ employeeCode: "S1", employeeType: "staff", employeeDepartment: "Cutting" }),
      adv({ employeeCode: "P1", employeeType: "production", employeeDepartment: "Cutting" }),
      adv({ employeeCode: "P2", employeeType: "production", employeeDepartment: "Sewing" }),
    ];
    const options = namedOrgOptions(
      split,
      (r) => r.employeeDepartment,
      (r) => r.employeeType,
    );
    expect(options.map((o) => [o.value, o.label, o.group])).toEqual([
      ["production|Cutting", "Cutting", "Production"],
      ["staff|Cutting", "Cutting", "Staff"],
      ["production|Sewing", "Sewing", "Production"],
    ]);
    expect(hasBothCategories(options)).toBe(true);
    // one employee type offers only its own kind
    const production = namedOrgOptions(
      split,
      (r) => r.employeeDepartment,
      (r) => r.employeeType,
      "production",
    );
    expect(production.map((o) => o.value)).toEqual(["production|Cutting", "production|Sewing"]);
    expect(filterRows(split, { ...NO_FILTERS, department: "production|Cutting" }).map((r) => r.employeeCode)).toEqual([
      "P1",
    ]);
    expect(filterRows(split, { ...NO_FILTERS, department: "staff|Cutting" }).map((r) => r.employeeCode)).toEqual([
      "S1",
    ]);
    // a plain name (an older saved filter) still matches every Cutting
    expect(filterRows(split, { ...NO_FILTERS, department: "Cutting" })).toHaveLength(2);
  });

  it("filters by the day the advance was raised, both ends included", () => {
    expect(filterRows(rows, { ...NO_FILTERS, from: "2026-10-01" })).toHaveLength(2);
    expect(filterRows(rows, { ...NO_FILTERS, to: "2026-09-30" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, from: "2026-09-02", to: "2026-09-02" })).toHaveLength(1);
    expect(filterRows(rows, { ...NO_FILTERS, from: "2026-10-09", to: "2026-10-01" })).toHaveLength(0);
  });

  it("an older backend without branch or type leaves those filters with nothing to match", () => {
    const old = [adv({ employeeBranch: undefined, employeeType: undefined, employeeStatus: undefined })];
    expect(filterRows(old, { ...NO_FILTERS, branch: "Erode" })).toHaveLength(0);
    expect(filterRows(old, NO_FILTERS)).toHaveLength(1);
  });

  it("the status counts follow the other filters but not the status itself", () => {
    const counts = statusCounts(rows, { ...DEFAULT_FILTERS, department: "Stitching" });
    expect(counts).toEqual({ all: 2, pending: 1, approved: 0, rejected: 0, closed: 1, approved_all: 1 });
  });

  it("knows when a filter is on; the page opens on the pending approvals", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive(DEFAULT_FILTERS)).toBe(true);
    expect(DEFAULT_FILTERS.status).toBe("pending");
    expect(filtersActive({ ...NO_FILTERS, query: "  " })).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, to: "2026-01-01" })).toBe(true);
  });
});

describe("sorting", () => {
  const a = adv({
    employeeName: "Zed",
    amount: 100,
    outstanding: 50,
    totalRepaid: 50,
    createdAt: "2026-01-01T00:00:00Z",
    status: "approved",
    repaymentStartMonth: 3,
    repaymentStartYear: 2026,
  });
  const b = adv({
    employeeName: "Amy",
    amount: 300,
    outstanding: 300,
    totalRepaid: 0,
    createdAt: "2026-03-01T00:00:00Z",
    status: "pending",
    repaymentStartMonth: 1,
    repaymentStartYear: 2027,
  });
  const c = adv({
    employeeName: "Moe",
    amount: 200,
    outstanding: 20,
    totalRepaid: 180,
    createdAt: "2026-02-01T00:00:00Z",
    status: "closed",
    repaymentStartMonth: 12,
    repaymentStartYear: 2025,
  });
  const names = (rows: SettlementRow[]) => rows.map((r) => r.employeeName);

  it("sorts each column both ways, without changing the list it was given", () => {
    const input = [a, b, c];
    expect(names(sortRows(input, { key: "employee", dir: "asc" }))).toEqual(["Amy", "Moe", "Zed"]);
    expect(names(sortRows(input, { key: "amount", dir: "desc" }))).toEqual(["Amy", "Moe", "Zed"]);
    expect(names(sortRows(input, { key: "outstanding", dir: "asc" }))).toEqual(["Moe", "Zed", "Amy"]);
    expect(names(sortRows(input, { key: "recovery", dir: "desc" }))).toEqual(["Moe", "Zed", "Amy"]);
    expect(names(sortRows(input, { key: "start", dir: "asc" }))).toEqual(["Moe", "Zed", "Amy"]);
    expect(names(sortRows(input, { key: "status", dir: "asc" }))).toEqual(["Amy", "Zed", "Moe"]);
    expect(names(sortRows(input, { key: "created", dir: "desc" }))).toEqual(["Amy", "Moe", "Zed"]);
    expect(names(input)).toEqual(["Zed", "Amy", "Moe"]);
  });

  it("parses the sort dropdown's value", () => {
    expect(parseSort("amount:asc")).toEqual({ key: "amount", dir: "asc" });
    expect(parseSort("created:desc")).toEqual({ key: "created", dir: "desc" });
  });
});

describe("the schedule an approval creates (twin of the server's)", () => {
  it("a general advance is one deduction in its start month", () => {
    const p = schedulePreview({ type: "general", amount: 8000, startMonth: 11, startYear: 2026 });
    expect(p.items).toEqual([{ month: 11, year: 2026, amount: 8000 }]);
    expect(p.shortfall).toBe(0);
    expect(describeSchedule(p)).toBe("1 deduction of ₹8,000 in Nov 2026");
  });

  it("a term loan with an EMI runs until the amount is paid, the last EMI smaller", () => {
    const p = schedulePreview({ type: "term", amount: 10000, emi: 4000, startMonth: 11, startYear: 2026 });
    expect(p.items).toEqual([
      { month: 11, year: 2026, amount: 4000 },
      { month: 12, year: 2026, amount: 4000 },
      { month: 1, year: 2027, amount: 2000 },
    ]);
    expect(p.total).toBe(10000);
    expect(describeSchedule(p)).toBe("3 deductions of ₹4,000 from Nov 2026 to Jan 2027 (the last ₹2,000)");
  });

  it("a term loan with months works the EMI out to the paisa", () => {
    const p = schedulePreview({ type: "term", amount: 12000, months: 12, startMonth: 1, startYear: 2027 });
    expect(p.items).toHaveLength(12);
    expect(p.items[0].amount).toBe(1000);
    expect(p.items[11]).toEqual({ month: 12, year: 2027, amount: 1000 });
    expect(p.shortfall).toBe(0);
  });

  it("months that do not divide the amount leave a paisa off the schedule, as the server does", () => {
    const p = schedulePreview({ type: "term", amount: 1000, months: 3, startMonth: 1, startYear: 2027 });
    expect(p.items.map((i) => i.amount)).toEqual([333.33, 333.33, 333.33]);
    expect(p.shortfall).toBe(0.01);
  });

  it("an EMI that does not divide the amount gets a short last month, and nothing is left off", () => {
    const p = schedulePreview({ type: "term", amount: 1000, emi: 333.33, startMonth: 1, startYear: 2027 });
    expect(p.items.map((i) => i.amount)).toEqual([333.33, 333.33, 333.33, 0.01]);
    expect(p.shortfall).toBe(0);
  });

  it("gives nothing for a term loan with no EMI and no months, or no amount", () => {
    expect(schedulePreview({ type: "term", amount: 5000, startMonth: 1, startYear: 2027 }).items).toEqual([]);
    expect(schedulePreview({ type: "general", amount: 0, startMonth: 1, startYear: 2027 }).items).toEqual([]);
    expect(describeSchedule({ items: [], total: 0, shortfall: 0 })).toBe("No deduction schedule yet.");
  });

  it("reads a stored advance, starting this month when it has no start", () => {
    const stored = adv({
      advanceType: "term",
      amount: 6000,
      emiAmount: 2000,
      repaymentStartMonth: null,
      repaymentStartYear: null,
    });
    const p = previewForAdvance(stored, new Date(2026, 11, 15));
    expect(p.items.map((i) => [i.month, i.year])).toEqual([
      [12, 2026],
      [1, 2027],
      [2, 2027],
    ]);
  });
});

describe("the new-advance form", () => {
  it("starts on next month, and rolls into next year in December", () => {
    expect(emptyForm(new Date(2026, 9, 10))).toMatchObject({ repaymentStartMonth: 11, repaymentStartYear: 2026 });
    expect(emptyForm(new Date(2026, 11, 10))).toMatchObject({ repaymentStartMonth: 1, repaymentStartYear: 2027 });
  });

  it("a valid general advance has no errors", () => {
    expect(validateForm(form())).toEqual({});
  });

  it("asks for the employee and the amount", () => {
    const e = validateForm(form({ employeeId: "", amount: "" }));
    expect(e.employee).toMatch(/Choose the employee/);
    expect(e.amount).toBe("Enter the amount.");
  });

  it("refuses an amount that is zero, negative, too precise or too large", () => {
    expect(validateForm(form({ amount: "0" })).amount).toMatch(/more than 0/);
    expect(validateForm(form({ amount: "-5" })).amount).toMatch(/more than 0/);
    expect(validateForm(form({ amount: "10.555" })).amount).toMatch(/2 decimal places/);
    expect(validateForm(form({ amount: "100000000" })).amount).toMatch(/too large/);
    expect(validateForm(form({ amount: "999.99" })).amount).toBeUndefined();
  });

  it("a term loan needs the months or the EMI", () => {
    expect(validateForm(form({ advanceType: "term" })).repayment).toMatch(/months or the monthly EMI/);
    expect(validateForm(form({ advanceType: "term", repaymentMonths: "12" }))).toEqual({});
    expect(validateForm(form({ advanceType: "term", emiAmount: "1500" }))).toEqual({});
  });

  it("checks the months and the EMI", () => {
    expect(validateForm(form({ advanceType: "term", repaymentMonths: "0" })).months).toMatch(/whole number/);
    expect(validateForm(form({ advanceType: "term", repaymentMonths: "2.5" })).months).toMatch(/whole number/);
    expect(validateForm(form({ advanceType: "term", repaymentMonths: "121" })).months).toMatch(/120/);
    expect(validateForm(form({ advanceType: "term", emiAmount: "13000" })).emi).toMatch(/more than the amount/);
    expect(validateForm(form({ advanceType: "term", emiAmount: "-1" })).emi).toMatch(/more than 0/);
  });

  it("months and EMI of a general advance are not asked for", () => {
    expect(validateForm(form({ advanceType: "general", repaymentMonths: "x" }))).toEqual({});
  });

  it("checks the year", () => {
    expect(validateForm(form({ repaymentStartYear: 26 })).year).toMatch(/4-digit/);
    expect(validateForm(form({ repaymentStartYear: 2026.5 })).year).toMatch(/4-digit/);
  });

  it("warns, without blocking, when the first deduction month is already over", () => {
    const now = new Date(2026, 9, 10);
    expect(startWarning(form({ repaymentStartMonth: 9, repaymentStartYear: 2026 }), now)).toMatch(
      /Sep 2026 is already over/,
    );
    expect(startWarning(form({ repaymentStartMonth: 10, repaymentStartYear: 2026 }), now)).toBeNull();
    expect(startWarning(form({ repaymentStartMonth: 1, repaymentStartYear: 2027 }), now)).toBeNull();
  });

  it("sends the body the page always sent", () => {
    expect(toPayload(form({ purpose: "  School fees " }))).toEqual({
      employeeId: 7,
      advanceType: "general",
      amount: 12000,
      purpose: "School fees",
      repaymentMonths: undefined,
      emiAmount: undefined,
      repaymentStartMonth: 11,
      repaymentStartYear: 2026,
    });
    expect(toPayload(form({ advanceType: "term", repaymentMonths: "6" }))).toMatchObject({
      repaymentMonths: 6,
      emiAmount: undefined,
    });
    expect(toPayload(form({ advanceType: "term", emiAmount: "2500.5" }))).toMatchObject({ emiAmount: 2500.5 });
  });

  it("previews the schedule once the form says enough", () => {
    expect(formPreview(form({ amount: "" }))).toBeNull();
    expect(formPreview(form({ advanceType: "term" }))).toBeNull();
    expect(formPreview(form({ advanceType: "term", repaymentMonths: "4" }))?.items).toHaveLength(4);
    expect(formPreview(form())?.items).toHaveLength(1);
  });
});

describe("shared helpers", () => {
  it("formats money, dates and initials", () => {
    expect(formatMoney(1234567.5)).toBe("₹12,34,567.5");
    expect(formatMoney(null)).toBe("₹0");
    expect(formatDate("2026-10-09")).toBe("9 Oct 2026");
    expect(formatDate(null)).toBe("-");
    expect(initials("Asha Kumar")).toBe("AK");
    expect(initials("Meena")).toBe("M");
    expect(initials("  ")).toBe("?");
  });

  it("matches words, day ranges and spots an upside-down range", () => {
    expect(matchesWords("lunch out", "Lunch Check-Out")).toBe(true);
    expect(matchesWords("lunch in", "Lunch Check-Out")).toBe(false);
    expect(matchesWords("", "anything")).toBe(true);
    expect(inDayRange("2026-10-09", "2026-10-09", "")).toBe(true);
    expect(inDayRange("", "2026-10-09", "")).toBe(false);
    expect(inDayRange("", "", "")).toBe(true);
    expect(rangeProblem("2026-10-09", "2026-10-01")).toMatch(/after the end/);
    expect(rangeProblem("2026-10-01", "")).toBeNull();
    expect(localDay("2026-10-09")).toBe("2026-10-09");
    expect(localDay("nonsense")).toBe("");
  });
});

describe("export and statement", () => {
  const row = adv({
    advanceType: "term",
    status: "approved",
    amount: 12000,
    emiAmount: 1000,
    repaymentMonths: 12,
    repaymentStartMonth: 11,
    repaymentStartYear: 2026,
    totalRepaid: 3000,
    outstanding: 9000,
    approvedBy: "HR Admin",
    approvedAt: "2026-10-06T08:00:00Z",
  });

  it("exports one line per advance under the right headings", () => {
    const t = buildExport([row], page(), 1);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toHaveLength(t.columns.length);
    const at = (h: string) => t.rows[0][t.columns.findIndex((c) => c.header === h)];
    expect(at("S.No")).toBe(1);
    expect(at("Employee Code")).toBe("E001");
    expect(at("Type")).toBe("Term Loan");
    expect(at("Requested Amount")).toBe(12000);
    expect(at("Approved Amount")).toBe(12000);
    // a production employee: no earned salary figures, so blank cells
    expect(at("Fixed Salary")).toBe("");
    expect(at("Working Days")).toBe("");
    expect(at("Earned Salary")).toBe("");
    expect(at("Limit")).toBe("");
    expect(at("Remarks")).toBe("");
  });

  it("prints the salary earned 1st-20th and HR's over-the-limit reason on the statement", () => {
    const html = buildStatementHtml(
      {
        ...row,
        advanceType: "general",
        earnings: {
          month: 11,
          year: 2026,
          throughDay: 20,
          fixedSalary: 26000,
          workingDays: 14.5,
          paidDays: 15.5,
          earnedAmount: 16120,
          workingSalary: 16120,
          percent: 50,
          limit: 8060,
        },
        limitRemark: "Medical emergency",
      },
      [],
    );
    expect(html).toContain("Earned in 1st–20th November 2026");
    expect(html).toContain("<tr><th>Working days</th><td>14.5</td></tr>");
    expect(html).toContain("<tr><th>Earned salary</th><td>₹16,120</td></tr>");
    expect(html).toContain("<tr><th>Limit (50% of earned salary)</th><td>₹8,060</td></tr>");
    expect(html).toContain("<tr><th>Reason for going over the limit</th><td>Medical emergency</td></tr>");
    expect(html).toContain("Salary Advance");
  });

  it("builds a statement that escapes what it prints and lists the schedule", () => {
    const html = buildStatementHtml(
      { ...row, employeeName: "A <b>&</b> Co", employeeStatus: "inactive" },
      [
        { id: 1, advanceId: row.id, month: 11, year: 2026, amount: 1000, paymentMethod: "payroll", isProcessed: true },
        { id: 2, advanceId: row.id, month: 12, year: 2026, amount: 1000, paymentMethod: "payroll", isProcessed: false },
      ],
      new Date(2026, 9, 10, 9, 30),
    );
    expect(html).toContain("A &lt;b&gt;&amp;&lt;/b&gt; Co");
    expect(html).not.toContain("<b>&</b>");
    expect(html).toContain("November 2026");
    expect(html).toContain("Deducted via payroll");
    expect(html).toContain("Still scheduled: <strong>₹1,000</strong>");
    expect(html).toContain("full and final settlement");
  });

  it("prints what was asked for and approved apart, with HR's remark", () => {
    const html = buildStatementHtml(
      {
        ...row,
        amount: 9000,
        requestedAmount: 12000,
        decisionRemark: "Budget <limit>",
        decidedAt: "2026-11-20T05:00:00Z",
      },
      [],
    );
    expect(html).toContain("<tr><th>Requested</th><td>₹12,000</td></tr>");
    expect(html).toContain("<tr><th>Approved</th><td>₹9,000</td></tr>");
    expect(html).toContain("<tr><th>HR&#39;s remark</th><td>Budget &lt;limit&gt;</td></tr>");
    expect(html).toContain("<tr><th>Decided on</th><td>20 Nov 2026</td></tr>");
    const rejected = buildStatementHtml({ ...row, status: "rejected", decisionRemark: "Has one running" }, []);
    expect(rejected).toContain("<tr><th>Reason for rejecting</th><td>Has one running</td></tr>");
    expect(rejected).toContain("<tr><th>Approved</th><td>Rejected</td></tr>");
  });

  it("says so when there is no schedule", () => {
    expect(buildStatementHtml(adv(), [])).toContain("No deduction schedule has been created");
  });
});

describe("approving an employee's application (2026-10-31)", () => {
  const applied = (over: Partial<SettlementRow> = {}) =>
    adv({
      appliedBy: "employee",
      advanceType: "term",
      amount: 10000,
      requestedAmount: 10000,
      repaymentMonths: 3,
      emiAmount: 3334,
      repaymentStartMonth: 11,
      repaymentStartYear: 2026,
      ...over,
    });

  it("opens on the amount asked for and the start month on the advance, with no remark", () => {
    expect(approvalDefaults(applied())).toEqual({ amount: "10000", startMonth: 11, startYear: 2026, remark: "" });
  });

  it("keeps the whole-rupee EMI for an employee's loan and the paisa EMI for one HR recorded", () => {
    expect(approvalEmi(applied(), 10000)).toBe(3334);
    expect(approvalEmi(applied({ appliedBy: "hr" }), 10000)).toBe(3333.33);
    expect(approvalEmi(applied({ advanceType: "general" }), 10000)).toBe(0);
  });

  it("previews the smaller amount with the last EMI absorbing the rest", () => {
    const p = approvalPreview(applied(), edit({ amount: "7000", startMonth: 12, startYear: 2026 }));
    expect(p?.items.map((i) => [i.month, i.year, i.amount])).toEqual([
      [12, 2026, 2334],
      [1, 2027, 2334],
      [2, 2027, 2332],
    ]);
    expect(p?.shortfall).toBe(0);
  });

  it("refuses more than was asked, nothing, and a bad year", () => {
    const a = applied();
    expect(approvalProblem(a, edit({ amount: "10001" }))).toMatch("₹10,000");
    expect(approvalProblem(a, edit({ amount: "" }))).toMatch("Enter");
    expect(approvalProblem(a, edit({ amount: "0" }))).toMatch("more than 0");
    expect(approvalProblem(a, edit({ amount: "5000", startYear: 26 }))).toMatch("4-digit");
    expect(approvalProblem(a, edit({ amount: "5000" }))).toBeNull();
    // an older advance HR recorded has no requested amount stored: its amount is what was asked for
    expect(approvalProblem(adv({ amount: 4000 }), edit({ amount: "4000.5" }))).toMatch("at most the ₹4,000");
  });

  it("sends only what changed, so an untouched approval is the call it always was", () => {
    const a = applied();
    expect(approvalPayload(a, approvalDefaults(a))).toEqual({ status: "approved" });
    expect(
      approvalPayload(a, edit({ amount: "6000", startMonth: 1, startYear: 2027, remark: "  Budget\n limit " })),
    ).toEqual({
      status: "approved",
      amount: 6000,
      repaymentStartMonth: 1,
      repaymentStartYear: 2027,
      decisionRemark: "Budget limit",
    });
  });

  it("tells employee applications and smaller approvals apart", () => {
    expect(appliedByEmployee(applied())).toBe(true);
    expect(appliedByEmployee(adv())).toBe(false);
    expect(approvedLess(applied({ status: "approved", amount: 6000 }))).toBe(true);
    expect(approvedLess(applied({ status: "pending", amount: 6000 }))).toBe(false);
    expect(approvedLess(adv({ status: "approved" }))).toBe(false);
  });

  it("exports what the employee asked for and what was approved, and leaves Remarks empty", () => {
    const t = buildExport([applied({ status: "approved", amount: 6000, decisionRemark: "Budget" })], page(), 1);
    const at = (h: string) => t.rows[0][t.columns.findIndex((c) => c.header === h)];
    expect(at("Requested Amount")).toBe(10000);
    expect(at("Approved Amount")).toBe(6000);
    expect(at("Remarks")).toBe(""); // always empty, for HR to write in
    expect(t.rows[0]).toHaveLength(t.columns.length);
  });
});

// ───────────────────── 2026-11-20: tabs, the month filter, remarks, history, per-tab exports ─────────────────────

describe("the tabs: Overview, Term Loan, Salary Advance", () => {
  const loan = adv({ advanceType: "term", employeeCode: "L1", status: "approved", emiAmount: 1000 });
  const advance = adv({ advanceType: "general", employeeCode: "A1", status: "pending", amount: 2000 });
  const rows = [loan, advance];

  it("reads the tab from the address; anything else is Overview", () => {
    expect(parseTab("loan")).toBe("loan");
    expect(parseTab("advance")).toBe("advance");
    expect(parseTab("")).toBe("overview");
    expect(parseTab("nonsense")).toBe("overview");
    expect(parseTab(null)).toBe("overview");
  });

  it("Term Loan lists the term loans, Salary Advance the others, Overview both", () => {
    expect(rowsOfTab(rows, "loan").map((r) => r.employeeCode)).toEqual(["L1"]);
    expect(rowsOfTab(rows, "advance").map((r) => r.employeeCode)).toEqual(["A1"]);
    expect(rowsOfTab(rows, "overview")).toHaveLength(2);
  });

  it("a typed tab ignores Overview's type choice", () => {
    const termOnly = { ...NO_FILTERS, type: "term" as const };
    expect(tabFilters(termOnly, "advance").type).toBe("all");
    expect(tabFilters(termOnly, "overview").type).toBe("term");
    const v = pageView(rows, page({ tab: "advance", filters: termOnly }));
    expect(v.shown.map((r) => r.employeeCode)).toEqual(["A1"]);
  });

  it("each tab's figures are its own", () => {
    expect(pageView(rows, page({ tab: "loan" })).summary).toMatchObject({
      activeCount: 1,
      pendingCount: 0,
      monthlyEmi: 1000,
    });
    expect(pageView(rows, page({ tab: "advance" })).summary).toMatchObject({
      activeCount: 0,
      pendingCount: 1,
      pendingAmount: 2000,
    });
    expect(pageView(rows, page()).summary).toMatchObject({ activeCount: 1, pendingCount: 1 });
  });

  it("the figures follow every filter but the status, which the status tabs split", () => {
    const v = pageView(rows, page({ filters: { ...DEFAULT_FILTERS, query: "L1" } }));
    expect(v.shown).toHaveLength(0); // L1 is active, the list opens on Pending
    expect(v.summary.activeCount).toBe(1);
    expect(pageView(rows, page({ filters: { ...NO_FILTERS, query: "nobody" } })).summary.activeCount).toBe(0);
  });
});

describe("the month filter", () => {
  // applied 5 Oct, decided 2 Nov, deducted Dec and Jan
  const a = adv({
    status: "approved",
    advanceType: "term",
    createdAt: "2026-10-05T08:00:00Z",
    decidedAt: "2026-11-02T06:00:00Z",
    approvedAt: "2026-11-02T06:00:00Z",
    scheduleMonths: ["2026-12", "2027-01"],
  });
  const month = (m: number, y = 2026) => ({ month: m, year: y });

  it("reads the month and year from the address; no month is this month, 'all' is All months", () => {
    const now = new Date("2026-11-20T10:00:00Z");
    expect(parsePeriod("11", "2026", now)).toEqual({ month: 11, year: 2026 });
    expect(parsePeriod("4", "2025", now)).toEqual({ month: 4, year: 2025 }); // a deep link to an earlier month
    expect(parsePeriod("", "", now)).toEqual({ month: 11, year: 2026 });
    expect(parsePeriod("13", "2026", now)).toEqual({ month: 11, year: 2026 });
    expect(parsePeriod("0", "2026", now)).toEqual({ month: 11, year: 2026 });
    expect(parsePeriod("all", "", now)).toBeNull();
    expect(parsePeriod("all", "2026", now)).toBeNull();
    expect(parsePeriod("3", "", new Date(2027, 0, 5, 12))).toEqual({ month: 3, year: 2027 });
    expect(parsePeriod("3", "99", new Date(2027, 0, 5, 12))).toEqual({ month: 3, year: 2027 });
    expect(periodLabel({ month: 11, year: 2026 })).toBe("November 2026");
    expect(periodLabel(null)).toBe("All months");
    // the page opens on requests RAISED in the month; the other bases stay
    expect(parseBasis("")).toBe("applied");
    expect(parseBasis("x")).toBe("applied");
    expect(parseBasis("any")).toBe("any");
    expect(parseBasis("deducted")).toBe("deducted");
    expect(SETTLEMENT_URL_DEFAULTS.month).toBe("");
    expect(SETTLEMENT_URL_DEFAULTS.basis).toBe("applied");
    expect(BASIS_OPTIONS[0]).toEqual({ value: "applied", label: "Raised in the month" });
  });

  it("this month is the factory's (India) month, whatever zone the browser is in", () => {
    // 30 Nov 20:00 UTC is already 1 Dec 01:30 in India
    expect(currentPeriod(new Date("2026-11-30T20:00:00Z"))).toEqual({ month: 12, year: 2026 });
    expect(currentPeriod(new Date("2026-12-31T19:00:00Z"))).toEqual({ month: 1, year: 2027 });
    expect(currentPeriod(new Date("2026-11-30T17:00:00Z"))).toEqual({ month: 11, year: 2026 });
  });

  it("writes the month to the address: nothing for this month, 'all' for All months, a deep link otherwise", () => {
    const now = new Date("2026-11-20T10:00:00Z");
    expect(periodToUrl({ month: 11, year: 2026 }, now)).toEqual({ month: "", year: "" });
    expect(periodToUrl(null, now)).toEqual({ month: "all", year: "" });
    expect(periodToUrl({ month: 10, year: 2026 }, now)).toEqual({ month: "10", year: "2026" });
    expect(parsePeriod(periodToUrl({ month: 10, year: 2026 }, now).month, "2026", now)).toEqual(month(10));
    expect(isDefaultPeriod({ month: 11, year: 2026 }, "applied", now)).toBe(true);
    expect(isDefaultPeriod({ month: 11, year: 2026 }, "any", now)).toBe(false);
    expect(isDefaultPeriod({ month: 10, year: 2026 }, "applied", now)).toBe(false);
    expect(isDefaultPeriod(null, "applied", now)).toBe(false);
  });

  it("puts an advance in the month it was applied, decided or deducted in, as the basis says", () => {
    expect(inPeriod(a, null, "applied")).toBe(true);
    expect(inPeriod(a, month(10), "any")).toBe(true);
    expect(inPeriod(a, month(10), "applied")).toBe(true);
    expect(inPeriod(a, month(10), "decided")).toBe(false);
    expect(inPeriod(a, month(11), "decided")).toBe(true);
    expect(inPeriod(a, month(11), "applied")).toBe(false);
    expect(inPeriod(a, month(12), "deducted")).toBe(true);
    expect(inPeriod(a, month(1, 2027), "deducted")).toBe(true);
    expect(inPeriod(a, month(1, 2027), "any")).toBe(true);
    expect(inPeriod(a, month(2, 2027), "any")).toBe(false);
    expect(inPeriod(a, month(10, 2025), "any")).toBe(false);
  });

  it("an older advance: approvedAt is the decision, the schedule is worked out from the advance", () => {
    const old = adv({
      status: "approved",
      advanceType: "term",
      amount: 3000,
      emiAmount: 1000,
      repaymentStartMonth: 12,
      repaymentStartYear: 2026,
      approvedAt: "2026-11-02T06:00:00Z",
      decidedAt: null,
      scheduleMonths: undefined,
    });
    expect(decidedAtOf(old)).toBe("2026-11-02T06:00:00Z");
    expect(deductionMonths(old)).toEqual(["2026-12", "2027-01", "2027-02"]);
    expect(inPeriod(old, month(2, 2027), "deducted")).toBe(true);
    expect(inPeriod(old, month(11), "decided")).toBe(true);
    // a waiting advance has no decision and nothing deducted (even one decided before and sent back)
    const waiting = adv({ status: "pending", decidedAt: "2026-11-02T06:00:00Z", scheduleMonths: [] });
    expect(decidedAtOf(waiting)).toBeNull();
    expect(inPeriod(waiting, month(11), "decided")).toBe(false);
    expect(deductionMonths(adv({ status: "pending", scheduleMonths: undefined }))).toEqual([]);
  });

  it("the list, the counts and the figures follow the month", () => {
    const other = adv({ createdAt: "2026-08-01T08:00:00Z", status: "pending", employeeCode: "OLD" });
    const v = pageView([a, other], page({ period: month(10), filters: NO_FILTERS }));
    expect(v.periodRows).toEqual([a]);
    expect(v.shown).toEqual([a]);
    expect(v.summary.pendingCount).toBe(0);
    expect(pageView([a, other], page({ period: month(8), basis: "applied" })).shown.map((r) => r.employeeCode)).toEqual(
      ["OLD"],
    );
  });

  it("offers last year to next year, widened to the years advances are in", () => {
    const now = new Date(2026, 10, 20);
    expect(yearOptions([], null, now)).toEqual([2027, 2026, 2025]);
    expect(yearOptions([a], null, now)).toEqual([2027, 2026, 2025]);
    expect(yearOptions([adv({ createdAt: "2022-03-01T08:00:00Z" })], { month: 1, year: 2029 }, now)).toEqual([
      2029, 2028, 2027, 2026, 2025, 2024, 2023, 2022,
    ]);
  });
});

describe("remarks on a decision (owner 2026-11-20)", () => {
  const asked = adv({ amount: 1000, requestedAmount: 1000 });

  it("cleans a remark as the server does", () => {
    expect(cleanRemark("  Budget \n\n limit  ")).toBe("Budget limit");
    expect(cleanRemark("   ")).toBe("");
  });

  it("approving another amount than was asked for needs a remark; the full amount does not", () => {
    expect(remarkRequired(asked, { amount: "700" })).toBe(true);
    expect(remarkRequired(asked, { amount: "1000" })).toBe(false);
    expect(remarkRequired(asked, { amount: "1000.00" })).toBe(false);
    expect(remarkRequired(asked, { amount: "" })).toBe(false);
    expect(approvalRemarkProblem(asked, edit({ amount: "700" }))).toBe(
      "You are approving ₹700 of the ₹1,000 asked for - write why.",
    );
    expect(approvalRemarkProblem(asked, edit({ amount: "700", remark: " a  b" }))).toBeNull(); // "a b" = 3
    expect(approvalRemarkProblem(asked, edit({ amount: "700", remark: " ab " }))).not.toBeNull();
    expect(approvalRemarkProblem(asked, edit({ amount: "1000" }))).toBeNull();
    // an older advance HR recorded: the amount on it is what was asked for
    expect(remarkRequired(adv({ amount: 5000, requestedAmount: null }), { amount: "4000" })).toBe(true);
  });

  it("sends the remark with the approval only when there is one", () => {
    expect(approvalPayload(asked, edit({ amount: "1000" }))).toEqual({
      status: "approved",
      repaymentStartMonth: 11,
      repaymentStartYear: 2026,
    });
    expect(approvalPayload(asked, edit({ amount: "700", remark: "Budget limit" }))).toMatchObject({
      status: "approved",
      amount: 700,
      decisionRemark: "Budget limit",
    });
    expect(approvalPayload(asked, edit({ amount: "1000", remark: "Paid in cash first" })).decisionRemark).toBe(
      "Paid in cash first",
    );
  });

  it("a rejection always needs its reason, at least 3 characters", () => {
    expect(rejectionProblem("")).toBe("Write the reason for rejecting (at least 3 characters).");
    expect(rejectionProblem("  no ")).not.toBeNull();
    expect(rejectionProblem("Has a loan running")).toBeNull();
    expect(rejectionPayload("  Has a loan\nrunning ")).toEqual({
      status: "rejected",
      decisionRemark: "Has a loan running",
    });
  });

  it("shows the server's own words for a refusal, and says when it was about the remark", () => {
    const refused = new ApiError(
      new Response(null, { status: 400, statusText: "Bad Request" }),
      { error: "Write a remark: you are approving ₹700 of the ₹1,000 asked for.", code: "remark" },
      { method: "PUT", url: "/api/advances/1" },
    );
    expect(serverError(refused, "x")).toEqual({
      text: "Write a remark: you are approving ₹700 of the ₹1,000 asked for.",
      code: "remark",
    });
    const plain = new ApiError(new Response(null, { status: 500, statusText: "Server Error" }), null, {
      method: "PUT",
      url: "/api/advances/1",
    });
    expect(serverError(plain, "x").text).toMatch(/HTTP 500/);
    expect(serverError(new Error("Network down"), "x")).toEqual({ text: "Network down", code: null });
    expect(serverError("??", "Could not save")).toEqual({ text: "Could not save", code: null });
  });

  it("knows the approved amount only once approved", () => {
    expect(approvedOf(adv({ status: "approved", amount: 700 }))).toBe(700);
    expect(approvedOf(adv({ status: "closed", amount: 700 }))).toBe(700);
    expect(approvedOf(adv({ status: "pending" }))).toBeNull();
    expect(approvedOf(adv({ status: "rejected" }))).toBeNull();
  });
});

describe("the decision history", () => {
  const item = {
    id: 1,
    action: "approved" as const,
    requestedAmount: 1000,
    approvedAmount: 700,
    startMonth: 11,
    startYear: 2026,
    remark: "Budget",
    by: "HR Admin",
    at: "2026-11-20T05:00:00Z",
  };

  it("says what was asked for, what was approved and from when it is deducted", () => {
    expect(historyText(item, "term")).toEqual({
      title: "Approved ₹700 of the ₹1,000 asked for",
      detail: "Deductions from Nov 2026",
    });
    expect(historyText({ ...item, approvedAmount: 1000 }, "general")).toEqual({
      title: "Approved ₹1,000",
      detail: "Deducted in Nov 2026",
    });
    expect(historyText({ ...item, action: "rejected", approvedAmount: null }, "general")).toEqual({
      title: "Rejected (₹1,000 asked for)",
      detail: null,
    });
    expect(historyText({ ...item, action: "reopened" }, "term").title).toBe("Sent back to pending");
  });
});

describe("the page's state in the address", () => {
  it("opens on the pending approvals, newest first, with a clean address", () => {
    expect(filtersFromUrl(SETTLEMENT_URL_DEFAULTS)).toEqual(DEFAULT_FILTERS);
    expect(parseSort(SETTLEMENT_URL_DEFAULTS.sort)).toEqual(DEFAULT_SORT);
    expect(filtersToUrl(DEFAULT_FILTERS, DEFAULT_SORT)).toEqual(DEFAULT_FILTER_URL);
  });

  it("round-trips the filters and refuses what it does not know", () => {
    const f = {
      ...NO_FILTERS,
      query: "asha",
      status: "rejected" as const,
      type: "term" as const,
      department: "staff|Cutting",
      employee: "left" as const,
      from: "2026-10-01",
    };
    const sort = { key: "amount" as const, dir: "asc" as const };
    const u = { ...SETTLEMENT_URL_DEFAULTS, ...filtersToUrl(f, sort) };
    expect(filtersFromUrl(u)).toEqual(f);
    expect(parseSort(u.sort)).toEqual(sort);
    expect(filtersFromUrl({ status: "maybe", type: "x", emp: "y", from: "yesterday" })).toMatchObject({
      status: "pending",
      type: "all",
      employee: "all",
      from: "",
    });
    expect(parseSort("bogus:asc")).toEqual(DEFAULT_SORT);
  });

  it("a tab's own part leaves the tab and the month out", () => {
    const own = pickFilterUrl({ ...SETTLEMENT_URL_DEFAULTS, tab: "loan", month: "11", q: "asha" });
    expect(own).toMatchObject({ q: "asha", status: "pending" });
    expect(own).not.toHaveProperty("tab");
    expect(own).not.toHaveProperty("month");
  });
});

describe("exports (owner 2026-11-26: 12 columns, a status choice)", () => {
  const earned = (fixedSalary: number, workingDays: number, earnedAmount: number) => ({
    month: 11,
    year: 2026,
    throughDay: 20,
    fixedSalary,
    workingDays,
    paidDays: workingDays,
    earnedAmount,
    workingSalary: earnedAmount,
    percent: 50,
    limit: Math.floor(earnedAmount / 2),
  });
  const loanRow = adv({
    advanceType: "term",
    status: "approved",
    employeeCode: "L1",
    employeeType: "staff",
    amount: 700,
    requestedAmount: 1000,
    emiAmount: 234,
    repaymentMonths: 3,
    repaymentStartMonth: 12,
    repaymentStartYear: 2026,
    totalRepaid: 234,
    outstanding: 466,
    decisionRemark: "Budget limit",
    approvedBy: "HR Admin",
    decidedAt: "2026-11-20T05:00:00Z",
    earnings: earned(26000, 14.5, 16120),
  });
  const pendingLoan = adv({
    advanceType: "term",
    status: "pending",
    employeeCode: "L2",
    amount: 5000,
    requestedAmount: 5000,
    salaryAtRequest: 18000, // figures not worked out yet: the fixed salary falls back to the one kept at the request
  });
  const rejectedAdvance = adv({
    advanceType: "general",
    status: "rejected",
    employeeCode: "A1",
    amount: 3000,
    requestedAmount: 3000,
    outstanding: 3000,
    decisionRemark: "Already has one",
    approvedBy: "HR Admin",
    decidedAt: "2026-11-19T05:00:00Z",
  });
  const closedAdvance = adv({
    advanceType: "general",
    status: "closed",
    employeeCode: "A2",
    amount: 4000,
    requestedAmount: 4000,
    totalRepaid: 4000,
    outstanding: 0,
    earnings: earned(30000, 16, 20000),
  });

  it("has exactly the owner's 12 columns, in order, on every tab", () => {
    const expected = [
      "S.No",
      "Employee Code",
      "Employee",
      "Department",
      "Type",
      "Fixed Salary",
      "Working Days",
      "Earned Salary",
      "Requested Amount",
      "Limit",
      "Approved Amount",
      "Remarks",
    ];
    expect(exportColumns().map((c) => c.header)).toEqual(expected);
    for (const tab of ["overview", "loan", "advance"] as const) {
      expect(buildExport([loanRow], page({ tab }), 1).columns.map((c) => c.header)).toEqual(expected);
    }
    // the money columns are the ones summed
    expect(
      exportColumns()
        .filter((c) => c.money)
        .map((c) => c.header),
    ).toEqual(["Fixed Salary", "Earned Salary", "Requested Amount", "Limit", "Approved Amount"]);
    // "Working Salary" (the Earned Salary again) is not offered any more
    expect(EXPORT_COLUMNS.map((c) => c.header)).not.toContain("Working Salary");
  });

  it("numbers the rows, writes the earned figures, leaves missing ones and Remarks blank, and totals the money", () => {
    const t = buildExport(
      [loanRow, pendingLoan, rejectedAdvance, closedAdvance],
      page({ period: { month: 11, year: 2026 } }),
      6,
    );
    const col = (h: string) => t.columns.findIndex((c) => c.header === h);
    expect(t.rows.map((r) => r[col("S.No")])).toEqual([1, 2, 3, 4]);
    expect(t.rows.map((r) => r[col("Employee Code")])).toEqual(["L1", "L2", "A1", "A2"]);
    expect(t.rows.map((r) => r[col("Type")])).toEqual(["Term Loan", "Term Loan", "Salary Advance", "Salary Advance"]);
    // Fixed Salary, Working Days, Earned Salary, Requested Amount, Limit (50 % of earned), Approved Amount, Remarks
    expect(t.rows[0].slice(5)).toEqual([26000, 14.5, 16120, 1000, 8060, 700, ""]);
    // waiting: the fixed salary kept at the request and what was asked for; nothing earned yet, no limit, nothing approved
    expect(t.rows[1].slice(5)).toEqual([18000, "", "", 5000, "", "", ""]);
    // rejected: nothing approved
    expect(t.rows[2][col("Approved Amount")]).toBe("");
    // completed: the approved amount
    expect(t.rows[3][col("Approved Amount")]).toBe(4000);
    expect(t.rows.every((r) => r[col("Remarks")] === "")).toBe(true);
    expect(t.totals[col("Employee")]).toBe("Total (4 advances)");
    expect(t.totals[col("S.No")]).toBe("");
    expect(t.totals[col("Working Days")]).toBe("");
    expect(t.totals[col("Requested Amount")]).toBe(13000);
    expect(t.totals[col("Fixed Salary")]).toBe(74000);
    expect(t.totals[col("Earned Salary")]).toBe(36120);
    expect(t.totals[col("Limit")]).toBe(18060);
    expect(t.totals[col("Approved Amount")]).toBe(4700);
    expect(t.totals).toHaveLength(12);
  });

  it("puts the status in the title, the subtitle and the file name", () => {
    const loanPage = page({ tab: "loan", period: { month: 11, year: 2026 } });
    const all = buildExport([loanRow, pendingLoan], loanPage, 3);
    expect(buildExport([loanRow], page(), 1).title).toBe("Settlement - All types - All statuses - All months");
    expect(all.title).toBe("Settlement - Term Loan - All statuses - November 2026");
    expect(all.subtitle).toBe("2 of 3 term loans · Status: All statuses");
    expect(all.fileStem).toBe("Settlement_Term Loan_All statuses_November 2026");
    expect(all.sheet).toBe("Term Loan Nov 2026");
    const pending = buildExport([pendingLoan], exportState(loanPage, "pending"), 3);
    expect(pending.title).toBe("Settlement - Term Loan - Pending - November 2026");
    expect(pending.subtitle).toBe("1 of 3 term loans · Status: Pending");
    const advance = buildExport([rejectedAdvance], exportState(page({ tab: "advance" }), "rejected"), 1);
    expect(advance.title).toBe("Settlement - Salary Advance - Rejected - All months");
    expect(advance.subtitle).toBe("1 of 1 salary advance · Status: Rejected");
  });

  it("offers All, Pending, Active, Completed, Rejected and Approved (active + completed)", () => {
    expect(EXPORT_STATUS_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["all", "All"],
      ["pending", "Pending"],
      ["approved", "Active"],
      ["closed", "Completed"],
      ["rejected", "Rejected"],
      ["approved_all", "Approved"],
    ]);
    expect(exportStatusLabel("approved_all")).toBe("Approved");
    expect(exportStatusLabel("all")).toBe("All statuses");
    expect(exportStatusLabel("approved")).toBe("Active");
    expect(exportStatusLabel("closed")).toBe("Completed");
  });

  it("the chosen status replaces the page's; the tab, month, other filters, search and sort stay", () => {
    const rows = [loanRow, pendingLoan, rejectedAdvance, closedAdvance];
    // the page shows the waiting term loans searched for "L"
    const s = page({ tab: "loan", filters: { ...NO_FILTERS, status: "pending", query: "L" } });
    expect(pageView(rows, s).shown.map((r) => r.employeeCode)).toEqual(["L2"]);
    // exporting Active writes the approved one instead, still only term loans and still searched
    const active = exportState(s, "approved");
    expect(active.filters).toEqual({ ...s.filters, status: "approved" });
    expect(active.tab).toBe("loan");
    const v = pageView(rows, active);
    expect(v.shown.map((r) => r.employeeCode)).toEqual(["L1"]);
    const t = buildExport(v.shown, active, v.periodRows.length);
    expect(t.subtitle).toBe('1 of 2 term loans · Status: Active · Search: "L"');
    // All: every status of the tab
    const every = pageView(rows, exportState(s, "all"));
    expect(every.shown.map((r) => r.employeeCode).sort()).toEqual(["L1", "L2"]);
    // Completed on the Salary Advance tab
    const done = pageView(rows, exportState(page({ tab: "advance" }), "closed"));
    expect(done.shown.map((r) => r.employeeCode)).toEqual(["A2"]);
  });

  it("describes what narrows the list", () => {
    expect(describeScope(page())).toBe("");
    expect(
      describeScope(
        page({
          period: { month: 11, year: 2026 },
          basis: "deducted",
          filters: {
            ...NO_FILTERS,
            type: "term",
            department: "production|Cutting",
            employee: "left",
            to: "2026-11-30",
          },
        }),
      ),
    ).toBe(
      "Deducted in the month · Type: Term Loan · Department: Cutting (Production) · Employees who left · Raised to 30 Nov 2026",
    );
    // the type is the tab's own on Salary Advance, so it is not repeated
    expect(describeScope(page({ tab: "advance", filters: { ...NO_FILTERS, type: "term" } }))).toBe("");
  });
});

describe("the owner's names (2026-11-26)", () => {
  it("general is a Salary Advance, term a Term Loan, everywhere on the page", () => {
    expect(TYPE_LABEL).toEqual({ general: "Salary Advance", term: "Term Loan" });
    expect(SETTLEMENT_TABS.map((t) => t.label)).toEqual(["Overview", "Term Loan", "Salary Advance"]);
    expect(SETTLEMENT_TABS[0].hint).toBe("Term loans and salary advances together");
    expect(TAB_NOUN.advance).toEqual({ one: "salary advance", many: "salary advances" });
    expect(JSON.stringify([TYPE_LABEL, SETTLEMENT_TABS, TAB_NOUN])).not.toMatch(/term advance/i);
  });
});

describe("delete: only a waiting advance (owner 2026-11-26)", () => {
  it("can be deleted only while pending", () => {
    expect(canDelete(adv({ status: "pending" }))).toBe(true);
    expect(canDelete(adv({ status: "approved" }))).toBe(false);
    expect(canDelete(adv({ status: "rejected" }))).toBe(false);
    expect(canDelete(adv({ status: "closed" }))).toBe(false);
  });
});

describe("the Salary Advance limit in the New dialog (owner 2026-11-26)", () => {
  const preview = (limit: number | null) => ({
    employeeId: 7,
    employeeType: "staff",
    month: 11,
    year: 2026,
    throughDay: 20,
    percent: 50,
    earnings:
      limit == null
        ? null
        : {
            month: 11,
            year: 2026,
            throughDay: 20,
            fixedSalary: 26000,
            workingDays: 14,
            paidDays: 15,
            earnedAmount: limit * 2,
            percent: 50,
            limit,
          },
    noSalaryReason:
      limit == null ? "Paid per shift: there is no monthly fixed salary, so no Salary Advance limit." : null,
    termLoanService: {
      eligible: true,
      joinDate: "2025-01-10",
      serviceMonths: 22,
      requiredMonths: 6,
      eligibleFrom: "2025-07-10",
      reason: null,
    },
  });

  it("takes the limit from the preview, or from the server's refusal; none for a production employee", () => {
    expect(formLimit(preview(5000))).toBe(5000);
    expect(formLimit(preview(null))).toBeNull();
    expect(formLimit(undefined, 4200)).toBe(4200);
    expect(formLimit(preview(5000), 4200)).toBe(5000);
  });

  it("only a Salary Advance above the limit needs the reason, at least 3 characters", () => {
    const over = form({ advanceType: "general", amount: "6000" });
    expect(formOverLimit(over, 5000)).toBe(true);
    expect(formOverLimit(form({ amount: "5000" }), 5000)).toBe(false); // at the limit is fine
    expect(formOverLimit(over, null)).toBe(false); // no limit known
    expect(formOverLimit(form({ advanceType: "term", amount: "60000", repaymentMonths: "6" }), 5000)).toBe(false);
    expect(validateForm(over, 5000).limitRemark).toBe(
      "Write why this goes over the ₹5,000 limit (at least 3 characters).",
    );
    expect(validateForm({ ...over, limitRemark: " a  " }, 5000).limitRemark).toBeDefined();
    expect(validateForm({ ...over, limitRemark: "Medical emergency" }, 5000)).toEqual({});
    expect(validateForm(over, null)).toEqual({});
    expect(validateForm(form({ amount: "4000" }), 5000)).toEqual({});
    // a broken amount is reported on the amount alone
    expect(validateForm(form({ amount: "-1" }), 5000).limitRemark).toBeUndefined();
  });

  it("sends the reason as limitRemark for a Salary Advance only", () => {
    expect(toPayload(form({ amount: "6000", limitRemark: "  Medical\n emergency " }))).toMatchObject({
      limitRemark: "Medical emergency",
    });
    expect(toPayload(form({ amount: "6000" }))).not.toHaveProperty("limitRemark");
    expect(toPayload(form({ advanceType: "term", repaymentMonths: "3", limitRemark: "anything" }))).not.toHaveProperty(
      "limitRemark",
    );
  });

  it("works out how far above the limit, and reads the server's over_limit refusal", () => {
    expect(overLimitBy(6000, 5000)).toBe(1000);
    expect(overLimitBy(5000, 5000)).toBe(0);
    expect(overLimitBy(6000, null)).toBe(0);
    const refused = new ApiError(
      new Response(null, { status: 400, statusText: "Bad Request" }),
      { error: "₹6,000 is above the Salary Advance limit of ₹5,000.", code: "over_limit", limit: 5000 },
      { method: "POST", url: "/api/advances" },
    );
    expect(overLimitRefusal(refused)).toBe(5000);
    expect(serverError(refused, "x").text).toBe("₹6,000 is above the Salary Advance limit of ₹5,000.");
    expect(overLimitRefusal(new Error("Network down"))).toBeNull();
    const other = new ApiError(
      new Response(null, { status: 400, statusText: "Bad Request" }),
      { error: "Nope", code: "invalid" },
      { method: "POST", url: "/api/advances" },
    );
    expect(overLimitRefusal(other)).toBeNull();
  });

  it("names the days the earned salary covers", () => {
    expect(earnedPeriodLabel({ month: 11, year: 2026, throughDay: 20 })).toBe("1st–20th November 2026");
  });
});

// ───────────────────── 2026-11-26 (round 2): month by default, counts, the report, the bank file ─────────────────────

describe("the count cards (owner 2026-11-26)", () => {
  const rows = [
    adv({ status: "pending", employeeDepartment: "Stitching" }),
    adv({ status: "pending", employeeDepartment: "Cutting" }),
    adv({ status: "approved", employeeDepartment: "Stitching" }),
    adv({ status: "closed", employeeDepartment: "Stitching" }),
    adv({ status: "rejected", employeeDepartment: "Stitching" }),
  ];

  it("received = approved (active + completed) + rejected + pending, whatever the status pill", () => {
    for (const status of ["all", "pending", "approved", "closed", "rejected", "approved_all"] as const) {
      const c = statusCounts(rows, { ...NO_FILTERS, status });
      expect(c).toMatchObject({ all: 5, pending: 2, approved: 1, closed: 1, rejected: 1, approved_all: 2 });
      expect(c.approved_all + c.rejected + c.pending).toBe(c.all);
    }
    // the other filters do narrow them, and they still add up
    const c = statusCounts(rows, { ...NO_FILTERS, department: "Stitching" });
    expect(c).toMatchObject({ all: 4, pending: 1, approved_all: 2, rejected: 1 });
    expect(c.approved_all + c.rejected + c.pending).toBe(c.all);
  });

  it("Approved lists the active and the completed ones", () => {
    expect(statusMatches("approved", "approved_all")).toBe(true);
    expect(statusMatches("closed", "approved_all")).toBe(true);
    expect(statusMatches("pending", "approved_all")).toBe(false);
    expect(statusMatches("rejected", "approved_all")).toBe(false);
    expect(filterRows(rows, { ...NO_FILTERS, status: "approved_all" }).map((a) => a.status)).toEqual([
      "approved",
      "closed",
    ]);
    expect(filtersFromUrl({ status: "approved_all" }).status).toBe("approved_all");
    expect(describeScope(page({ filters: { ...NO_FILTERS, status: "approved_all" } }))).toBe(
      "Status: Approved (active + completed)",
    );
  });

  it("the page opens on this month's requests: an earlier one is not in the counts", () => {
    const now = new Date("2026-11-20T10:00:00Z");
    const nov = adv({ createdAt: "2026-11-03T05:00:00Z", status: "pending" });
    const oct = adv({ createdAt: "2026-10-10T05:00:00Z", status: "approved" });
    const s = page({ period: parsePeriod("", "", now), basis: parseBasis(""), filters: NO_FILTERS });
    const v = pageView([nov, oct], s);
    expect(v.periodRows).toEqual([nov]);
    expect(statusCounts(v.periodRows, v.filters)).toMatchObject({ all: 1, pending: 1, approved_all: 0 });
    // All months is still there
    expect(pageView([nov, oct], { ...s, period: parsePeriod("all", "", now) }).periodRows).toHaveLength(2);
  });
});

describe("the report dialog (owner 2026-11-26)", () => {
  it("has the owner's 12 columns ticked by default, then the 15 extras in a fixed order", () => {
    expect(EXPORT_COLUMNS.map((c) => c.header)).toEqual([
      "S.No",
      "Employee Code",
      "Employee",
      "Department",
      "Type",
      "Fixed Salary",
      "Working Days",
      "Earned Salary",
      "Requested Amount",
      "Limit",
      "Approved Amount",
      "Remarks",
      "Purpose",
      "Branch",
      "Designation",
      "Status",
      "EMI",
      "Months",
      "Deduction from",
      "Repaid",
      "Outstanding",
      "Decided by",
      "Decided on",
      "Decision remark",
      "Applied on",
      "Applied by",
      "Over-limit reason",
    ]);
    expect(DEFAULT_COLUMN_KEYS).toHaveLength(12);
    expect(EXTRA_COLUMN_KEYS).toHaveLength(15);
    expect(exportColumns().map((c) => c.key)).toEqual(DEFAULT_COLUMN_KEYS);
  });

  it("writes the chosen columns in the fixed order whatever order they were ticked in, totalling the ticked money", () => {
    const loan = adv({
      advanceType: "term",
      status: "approved",
      amount: 6000,
      requestedAmount: 6000,
      emiAmount: 2000,
      repaymentMonths: 3,
      repaymentStartMonth: 12,
      repaymentStartYear: 2026,
      totalRepaid: 2000,
      outstanding: 4000,
      employeeBranch: "Tiruppur",
      decisionRemark: "OK",
      limitRemark: "",
    });
    const t = buildExport([loan], page(), 1, ["outstanding", "employee", "emi", "months", "status", "code"]);
    expect(t.columns.map((c) => c.header)).toEqual([
      "Employee Code",
      "Employee",
      "Status",
      "EMI",
      "Months",
      "Outstanding",
    ]);
    expect(t.rows[0]).toEqual(["E001", "Asha Kumar", "Active", 2000, 3, 4000]);
    expect(t.totals).toEqual(["", "Total (1 advance)", "", 2000, "", 4000]);
    // without Employee the label goes in the first text column; with no money column there are no sums
    const narrow = buildExport([loan], page(), 1, ["sno", "purpose"]);
    expect(narrow.rows[0]).toEqual([1, "Medical"]);
    expect(narrow.totals).toEqual(["", "Total (1 advance)"]);
  });

  it("the extras: waiting and rejected ones have nothing repaid, decided or outstanding; HR's reasons are kept", () => {
    const keys = [
      "status",
      "repaid",
      "outstanding",
      "decidedBy",
      "decisionRemark",
      "appliedBy",
      "limitRemark",
      "start",
    ];
    const waiting = adv({ status: "pending", decisionRemark: "old", limitRemark: "Medical emergency" });
    const t = buildExport([waiting], page(), 1, keys);
    // the fixed order: Status, Deduction from, Repaid, Outstanding, Decided by, Decision remark, Applied by, Over-limit
    expect(t.columns.map((c) => c.key)).toEqual([
      "status",
      "start",
      "repaid",
      "outstanding",
      "decidedBy",
      "decisionRemark",
      "appliedBy",
      "limitRemark",
    ]);
    expect(t.rows[0]).toEqual(["Pending approval", "", "", "", "", "", "HR", "Medical emergency"]);
  });

  it("starts from the page: month, basis, status, type (the tab's), department, branch, Staff / Production", () => {
    const s = page({
      tab: "loan",
      period: { month: 10, year: 2026 },
      basis: "applied",
      filters: {
        ...NO_FILTERS,
        status: "rejected",
        type: "general", // Overview's choice: the Term Loan tab ignores it
        department: "staff|Accounts",
        branch: "Erode",
        employeeType: "staff",
        query: "asha",
      },
    });
    const r = reportDefaults(s, ["sno", "employee"]);
    expect(r).toEqual({
      period: { month: 10, year: 2026 },
      basis: "applied",
      status: "rejected",
      type: "term",
      department: "staff|Accounts",
      branch: "Erode",
      employeeType: "staff",
      columns: ["sno", "employee"],
    });
    expect(reportDefaults(page({ tab: "overview", filters: { ...NO_FILTERS, type: "general" } })).type).toBe("general");
    expect(reportDefaults(page({ tab: "advance" })).columns).toEqual([...DEFAULT_COLUMN_KEYS]);
  });

  it("the rows follow the dialog's month, status, type and filters, with the page's search text", () => {
    const rows = [
      adv({ employeeCode: "N1", advanceType: "term", status: "approved", createdAt: "2026-11-03T05:00:00Z" }),
      adv({ employeeCode: "N2", advanceType: "general", status: "approved", createdAt: "2026-11-04T05:00:00Z" }),
      adv({ employeeCode: "O1", advanceType: "term", status: "closed", createdAt: "2026-10-04T05:00:00Z" }),
      adv({ employeeCode: "N3", advanceType: "term", status: "pending", createdAt: "2026-11-05T05:00:00Z" }),
      adv({
        employeeCode: "N4",
        advanceType: "term",
        status: "approved",
        createdAt: "2026-11-06T05:00:00Z",
        employeeName: "Ravi",
      }),
    ];
    // the page: Overview, November, pending, searching "Asha"
    const pageState = page({
      period: { month: 11, year: 2026 },
      basis: "applied",
      filters: { ...NO_FILTERS, status: "pending", query: "Asha" },
    });
    const r = { ...reportDefaults(pageState), status: "approved_all" as const, type: "term" as const };
    const st = reportState(pageState, r);
    expect(st.tab).toBe("loan");
    expect(st.filters.query).toBe("Asha");
    expect(pageView(rows, st).shown.map((a) => a.employeeCode)).toEqual(["N1"]); // Ravi is not "Asha"
    // All months picks up October's completed one too
    const allMonths = reportState(pageState, { ...r, period: null });
    expect(
      pageView(rows, allMonths)
        .shown.map((a) => a.employeeCode)
        .sort(),
    ).toEqual(["N1", "O1"]);
    const v = pageView(rows, allMonths);
    const t = buildExport(v.shown, allMonths, v.periodRows.length);
    expect(t.title).toBe("Settlement - Term Loan - Approved - All months");
    expect(t.subtitle).toBe('2 of 4 term loans · Status: Approved · Search: "Asha"');
    expect(t.fileStem).toBe("Settlement_Term Loan_Approved_All months");
  });

  it("remembers the last column choice in this browser, and works without storage", () => {
    window.localStorage.removeItem(COLUMN_CHOICE_KEY);
    expect(loadColumnChoice()).toEqual([...DEFAULT_COLUMN_KEYS]);
    saveColumnChoice(["purpose", "sno", "employee"]);
    expect(loadColumnChoice()).toEqual(["sno", "employee", "purpose"]); // the fixed order
    // a broken or emptied value falls back to the default
    window.localStorage.setItem(COLUMN_CHOICE_KEY, "{not json");
    expect(loadColumnChoice()).toEqual([...DEFAULT_COLUMN_KEYS]);
    window.localStorage.setItem(COLUMN_CHOICE_KEY, JSON.stringify(["nonsense"]));
    expect(loadColumnChoice()).toEqual([...DEFAULT_COLUMN_KEYS]);
    expect(cleanColumnChoice("x")).toBeNull();
    expect(cleanColumnChoice([])).toBeNull();
    expect(cleanColumnChoice(["remarks", 3, "sno"])).toEqual(["sno", "remarks"]);
    // storage that throws (a private window): no crash, the default
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadColumnChoice()).toEqual([...DEFAULT_COLUMN_KEYS]);
    expect(() => saveColumnChoice(["sno"])).not.toThrow();
    get.mockRestore();
    set.mockRestore();
    window.localStorage.removeItem(COLUMN_CHOICE_KEY);
  });
});

describe("the bank file (owner 2026-11-26)", () => {
  const bank = { bankAccount: "1234567890", bankIfsc: "sbin0000001", bankName: "SBI" };
  const rows = [
    adv({
      ...bank,
      employeeCode: "A1",
      advanceType: "general",
      status: "approved",
      amount: 4000,
      requestedAmount: 5000,
      createdAt: "2026-11-03T05:00:00Z",
    }),
    adv({
      ...bank,
      employeeCode: "A2",
      advanceType: "general",
      status: "closed",
      amount: 3000.5,
      createdAt: "2026-11-04T05:00:00Z",
      employeeName: "Meena Iyer",
      bankIfsc: "",
    }),
    adv({ ...bank, employeeCode: "A3", advanceType: "general", status: "pending", createdAt: "2026-11-05T05:00:00Z" }),
    adv({ ...bank, employeeCode: "A4", advanceType: "general", status: "rejected", createdAt: "2026-11-05T05:00:00Z" }),
    adv({ ...bank, employeeCode: "L1", advanceType: "term", status: "approved", createdAt: "2026-11-06T05:00:00Z" }),
    adv({ ...bank, employeeCode: "O1", advanceType: "general", status: "approved", createdAt: "2026-10-06T05:00:00Z" }),
  ];
  const nov = page({ tab: "advance", period: { month: 11, year: 2026 }, basis: "applied" });

  it("pays the month's approved and completed ones of the tab only, whatever the status pill says", () => {
    for (const status of ["pending", "rejected", "all"] as const) {
      const s = { ...nov, filters: { ...NO_FILTERS, status } };
      expect(bankFileRows(rows, s).map((a) => a.employeeCode)).toEqual(["A2", "A1"]);
    }
    // Overview: the Term Loan too
    expect(
      bankFileRows(rows, { ...nov, tab: "overview" })
        .map((a) => a.employeeCode)
        .sort(),
    ).toEqual(["A1", "A2", "L1"]);
    // another month, All months
    expect(bankFileRows(rows, { ...nov, period: { month: 10, year: 2026 } }).map((a) => a.employeeCode)).toEqual([
      "O1",
    ]);
    expect(bankFileRows(rows, { ...nov, period: null })).toHaveLength(3);
    // the page's other filters still apply
    expect(
      bankFileRows(rows, { ...nov, filters: { ...NO_FILTERS, query: "Meena" } }).map((a) => a.employeeCode),
    ).toEqual(["A2"]);
  });

  it("pays the APPROVED amount, flags the missing bank details, and names the file after the tab and month", () => {
    const pay = bankFileRows(rows, nov);
    expect(bankFileLines(pay)).toEqual([
      {
        employeeCode: "A2",
        employeeName: "Meena Iyer",
        bankAccount: "1234567890",
        bankIfsc: "",
        bankName: "SBI",
        amount: 3001, // 3,000.50 approved, rounded UP to the rupee like the payroll bank file
      },
      {
        employeeCode: "A1",
        employeeName: "Asha Kumar",
        bankAccount: "1234567890",
        bankIfsc: "sbin0000001",
        bankName: "SBI",
        amount: 4000, // not the 5,000 asked for
      },
    ]);
    expect(bankFileTotal(pay)).toBe(7001);
    // float noise never adds a rupee (round-up-rupee.ts)
    expect(bankFileLines([adv({ amount: 2000.0000001 })])[0].amount).toBe(2000);
    expect(missingBankDetails(pay).map((a) => a.employeeCode)).toEqual(["A2"]);
    expect(missingBankDetails([adv({ bankAccount: null, bankIfsc: "X" })])).toHaveLength(1);
    expect(bankFileName(nov)).toBe("Settlement_Bank_File_Salary_Advance_November_2026.xlsx");
    expect(bankFileName({ ...nov, tab: "loan", period: null })).toBe("Settlement_Bank_File_Term_Loan_All_months.xlsx");
    expect(bankFileSheet(nov)).toBe("Salary Advance Nov 2026");
  });
});

describe("Working Days with company holidays (owner 2026-11-26)", () => {
  it("shows the split when the 1st-20th holds company holidays", async () => {
    const { workingDaysText } = await import("./logic");
    expect(workingDaysText({ workingDays: 16.5, presentShifts: 14.5, holidayDays: 2 })).toBe(
      "16.5 (14.5 worked + 2 holidays)",
    );
    expect(workingDaysText({ workingDays: 8, presentShifts: 7, holidayDays: 1 })).toBe("8 (7 worked + 1 holiday)");
  });

  it("is just the number without holidays or from an older server", async () => {
    const { workingDaysText } = await import("./logic");
    expect(workingDaysText({ workingDays: 13.5, presentShifts: 13.5, holidayDays: 0 })).toBe("13.5");
    expect(workingDaysText({ workingDays: 13.5 })).toBe("13.5");
  });
});
