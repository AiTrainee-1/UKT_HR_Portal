import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  NO_FILTERS,
  describeSchedule,
  emptyForm,
  exportTable,
  filterRows,
  filtersActive,
  formPreview,
  hasLeft,
  parseSort,
  previewForAdvance,
  progressPct,
  schedulePreview,
  sortRows,
  startWarning,
  statusCounts,
  summarize,
  toPayload,
  validateForm,
  type AdvanceForm,
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
    expect(counts).toEqual({ all: 2, pending: 1, approved: 0, rejected: 0, closed: 1 });
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
    const t = exportTable([row]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toHaveLength(t.headers.length);
    const at = (h: string) => t.rows[0][t.headers.indexOf(h)];
    expect(at("Advance type")).toBe("Term loan");
    expect(at("Status")).toBe("Active");
    expect(at("Outstanding")).toBe(9000);
    expect(at("Recovered %")).toBe(25);
    expect(at("Deduction starts")).toBe("Nov 2026");
    expect(at("Approved on")).toBe("6 Oct 2026");
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

  it("says so when there is no schedule", () => {
    expect(buildStatementHtml(adv(), [])).toContain("No deduction schedule has been created");
  });
});
