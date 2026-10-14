import { describe, expect, it } from "vitest";
import { dateTime } from "@/components/payroll/kit/format";
import type { PayrollIssue } from "@/lib/api-client/custom-hooks";
import {
  ASHA,
  BALA,
  CHITRA,
  DETECTED_AT,
  ISSUES,
  SKIPPED,
  makeIssue,
  manyIssues,
  summaryOf,
  type Person,
} from "./fixtures";
import {
  DEFAULT_ISSUE_FILTERS,
  NO_DEPARTMENT,
  activeFilterCount,
  describeIssueFilters,
  detailsTarget,
  filterIssues,
  groupIssues,
  issueDepartments,
  issueExportColumns,
  issueImpactText,
  issueTypeCounts,
  mergeSkipped,
  normalizeGroupBy,
  paginateGroups,
  sanitizeFilters,
  severityTypeNames,
  showingText,
  skippedToIssue,
  sumImpact,
  summarizeIssues,
  typeLabelMap,
  wholePeriodHiddenByRange,
  type IssueFilterState,
} from "./issues-logic";

const ids = (list: PayrollIssue[]) => list.map((i) => i.id);
const only = (over: Partial<IssueFilterState>): Partial<IssueFilterState> => over;
const idOf = (who: Person, code: PayrollIssue["code"], date: string | null) =>
  `${who.payrollId}:${code}:${date ?? "period"}`;

describe("the filters", () => {
  it("start with nothing narrowed and the timeline view", () => {
    expect(DEFAULT_ISSUE_FILTERS).toEqual({
      q: "",
      code: "",
      severity: "",
      dept: "",
      from: "",
      to: "",
      groupBy: "date",
    });
    expect(filterIssues(ISSUES, DEFAULT_ISSUE_FILTERS)).toHaveLength(11);
    expect(filterIssues(ISSUES, undefined)).toHaveLength(11);
    expect(activeFilterCount(DEFAULT_ISSUE_FILTERS)).toBe(0);
  });

  it("search keeps issues where every word is in the employee's name or code, the title or the detail", () => {
    expect(filterIssues(ISSUES, only({ q: "asha" }))).toHaveLength(4);
    expect(filterIssues(ISSUES, only({ q: "pc-s2" }))).toHaveLength(4); // Bala's code
    expect(ids(filterIssues(ISSUES, only({ q: "asha late" })))).toEqual([
      idOf(ASHA, "late_in", "2026-10-13"),
      idOf(ASHA, "late_penalty", null),
    ]);
    expect(ids(filterIssues(ISSUES, only({ q: "never punched" })))).toEqual([
      idOf(CHITRA, "missing_punch", "2026-10-13"),
    ]); // the detail
    expect(filterIssues(ISSUES, only({ q: "  ASHA   LATE  " }))).toHaveLength(2); // case and spaces do not matter
    expect(filterIssues(ISSUES, only({ q: "zzz" }))).toEqual([]);
  });

  it("severity and type keep exactly those", () => {
    expect(ids(filterIssues(ISSUES, only({ severity: "critical" })))).toEqual([
      idOf(ASHA, "absent", "2026-10-14"),
      idOf(BALA, "absent", "2026-10-13"),
    ]);
    expect(filterIssues(ISSUES, only({ severity: "info" }))).toHaveLength(2);
    expect(filterIssues(ISSUES, only({ code: "absent" }))).toHaveLength(2);
    expect(filterIssues(ISSUES, only({ code: "ot_pay" }))).toHaveLength(1);
    expect(filterIssues(ISSUES, only({ code: "not_a_code" }))).toEqual([]);
  });

  it("department keeps that department, and NO_DEPARTMENT the people with none", () => {
    expect(filterIssues(ISSUES, only({ dept: "Weaving" }))).toHaveLength(7);
    expect(filterIssues(ISSUES, only({ dept: "Stitching" }))).toHaveLength(4);
    const withNone = [...ISSUES, makeIssue({ ...BALA, department: null }, "bank_missing", null, { id: "x" })];
    expect(ids(filterIssues(withNone, only({ dept: NO_DEPARTMENT })))).toEqual(["x"]);
    expect(issueDepartments(withNone)).toEqual({ names: ["Stitching", "Weaving"], hasNone: true });
    expect(issueDepartments(ISSUES)).toEqual({ names: ["Stitching", "Weaving"], hasNone: false });
  });

  it("a date range keeps issues detected on a day inside it, ends included, and hides whole-period issues", () => {
    const days = (f: Partial<IssueFilterState>) => filterIssues(ISSUES, f).map((i) => i.date);
    expect(days({ from: "2026-10-13", to: "2026-10-14" })).toEqual([
      "2026-10-13",
      "2026-10-14",
      "2026-10-13",
      "2026-10-13",
    ]);
    expect(days({ from: "2026-10-15" })).toEqual(["2026-10-20", "2026-10-15"]); // open-ended
    expect(days({ to: "2026-10-13" })).toEqual(["2026-10-13", "2026-10-13", "2026-10-13"]);
    expect(filterIssues(ISSUES, { from: "2026-10-13", to: "2026-10-13" })).toHaveLength(3); // a single day
    expect(filterIssues(ISSUES, { from: "2026-11-01" })).toEqual([]);
  });

  it("a range typed the wrong way round still works", () => {
    expect(filterIssues(ISSUES, { from: "2026-10-14", to: "2026-10-13" })).toHaveLength(4);
    expect(sanitizeFilters({ from: "2026-10-14", to: "2026-10-13" })).toMatchObject({
      from: "2026-10-13",
      to: "2026-10-14",
    });
  });

  it("filters combine", () => {
    expect(filterIssues(ISSUES, { severity: "warning", dept: "Weaving" })).toHaveLength(4);
    // "punch" is in Chitra's missing punch and in the detail of Asha's late arrival ("First punch 09:42")
    expect(filterIssues(ISSUES, { severity: "warning", dept: "Weaving", q: "punch" })).toHaveLength(2);
    expect(filterIssues(ISSUES, { code: "absent", from: "2026-10-14" })).toHaveLength(1);
  });

  it("anything a page's address hands over is made safe: unknown severity, grouping or dates are dropped", () => {
    expect(sanitizeFilters({ severity: "bogus", groupBy: "zzz", from: "yesterday", to: "2026-13" })).toEqual(
      DEFAULT_ISSUE_FILTERS,
    );
    expect(filterIssues(ISSUES, { severity: "bogus", from: "yesterday" })).toHaveLength(11);
    expect(normalizeGroupBy("employee")).toBe("employee");
    expect(normalizeGroupBy("type")).toBe("type");
    expect(normalizeGroupBy("date")).toBe("date");
    expect(normalizeGroupBy(undefined)).toBe("date");
    expect(normalizeGroupBy("nope")).toBe("date");
  });

  it("count how many filters are on: a date range counts once and the grouping not at all", () => {
    expect(activeFilterCount({ q: "asha" })).toBe(1);
    expect(activeFilterCount({ q: "   " })).toBe(0);
    expect(activeFilterCount({ from: "2026-10-01", to: "2026-10-05" })).toBe(1);
    expect(activeFilterCount({ to: "2026-10-05" })).toBe(1);
    expect(activeFilterCount({ groupBy: "employee" })).toBe(0);
    expect(
      activeFilterCount({
        q: "a",
        code: "absent",
        severity: "critical",
        dept: "Weaving",
        from: "2026-10-01",
        groupBy: "type",
      }),
    ).toBe(5);
    expect(activeFilterCount({ severity: "bogus" })).toBe(0);
  });

  it("say how many whole-period issues a date range is hiding", () => {
    expect(wholePeriodHiddenByRange(ISSUES, { from: "2026-10-13" })).toBe(5);
    expect(wholePeriodHiddenByRange(ISSUES, { from: "2026-10-13", dept: "Stitching" })).toBe(2); // Bala's two
    expect(wholePeriodHiddenByRange(ISSUES, {})).toBe(0);
  });

  it("are described in words for the exported sheet", () => {
    expect(describeIssueFilters(DEFAULT_ISSUE_FILTERS)).toEqual([]);
    expect(
      describeIssueFilters(
        { q: " asha ", severity: "critical", code: "late_in", dept: "Weaving", from: "2026-10-05", to: "2026-10-12" },
        { late_in: "Late in" },
      ),
    ).toEqual([
      'Search "asha"',
      "Severity Critical",
      "Type Late in",
      "Department Weaving",
      "Detected 5 Oct 2026 to 12 Oct 2026",
    ]);
    expect(describeIssueFilters({ dept: NO_DEPARTMENT, from: "2026-10-05" })).toEqual([
      "Department none",
      "Detected 5 Oct 2026 to the end",
    ]);
    expect(describeIssueFilters({ to: "2026-10-05" })).toEqual(["Detected from the start to 5 Oct 2026"]);
  });
});

describe("what an issue cost, in words", () => {
  it("reads days, shifts and rupees, leaving out what is zero or missing", () => {
    expect(issueImpactText(null)).toBe("");
    expect(issueImpactText(undefined)).toBe("");
    expect(issueImpactText({})).toBe("");
    expect(issueImpactText({ days: 0, shifts: 0, amount: 0 })).toBe("");
    expect(issueImpactText({ days: 1 })).toBe("1 day");
    expect(issueImpactText({ days: 0.5 })).toBe("0.5 days");
    expect(issueImpactText({ days: 2 })).toBe("2 days");
    expect(issueImpactText({ shifts: 0.25 })).toBe("0.25 shifts");
    expect(issueImpactText({ shifts: 1 })).toBe("1 shift");
    expect(issueImpactText({ days: 0.5, amount: 567 })).toBe("0.5 days · ₹567");
    expect(issueImpactText({ days: 1, shifts: 2, amount: 1500 })).toBe("1 day · 2 shifts · ₹1,500");
  });

  it("keeps the paise when there are some, and groups rupees the Indian way", () => {
    expect(issueImpactText({ amount: 1134.62 })).toBe("₹1,134.62");
    expect(issueImpactText({ amount: 123456 })).toBe("₹1,23,456");
  });

  it("adds the server's own label after the numbers, or lets it stand alone", () => {
    expect(issueImpactText({ amount: 1200, label: "Added to pay" })).toBe("₹1,200 · Added to pay");
    expect(issueImpactText({ label: "Within the free allowance" })).toBe("Within the free allowance");
    expect(issueImpactText({ days: 1, label: "Covered" })).toBe("1 day · Covered");
  });

  it("adds up what a set of issues cost, leaving out the information-only ones", () => {
    expect(sumImpact(ISSUES)).toEqual({ days: 3.75, shifts: 0, amount: 3584.62 });
    // overtime pay (information) is not a loss: included only when asked for
    expect(sumImpact(ISSUES, { includeInfo: true }).amount).toBe(4784.62);
    expect(sumImpact([])).toEqual({ days: 0, shifts: 0, amount: 0 });
    expect(sumImpact([makeIssue(ASHA, "late_in", "2026-10-13", { impact: { shifts: 0.25 } })])).toEqual({
      days: 0,
      shifts: 0.25,
      amount: 0,
    });
  });
});

describe("the skipped employees", () => {
  it("become issues of code skipped: critical, no payroll, no day, the reason as the detail", () => {
    const issue = skippedToIssue(SKIPPED[0]);
    expect(issue).toMatchObject({
      id: "skipped:21",
      payrollId: null,
      employeeId: 21,
      employeeCode: "PC-S9",
      employeeName: "Divya Nair",
      department: "Accounts",
      code: "skipped",
      category: "generation",
      severity: "critical",
      title: "Skipped at generation",
      detail: "No Salary Amount set on this employee's profile",
      date: null,
      detectedAt: null,
      rule: null,
    });
    expect(issue.impact).toEqual({ label: "Not paid until fixed" });
    expect(skippedToIssue(SKIPPED[1]).department).toBeNull(); // not given
  });

  it("an employee who is already paid is skipped without being left unpaid", () => {
    const paid = skippedToIssue({
      employeeId: 5,
      employeeCode: "P5",
      name: "Paid Worker",
      reason: "Already paid for this period.",
    });
    expect(paid.impact).toBeNull();
    expect(paid.severity).toBe("critical"); // still listed as skipped
  });

  it("are merged in after the detected issues, once each", () => {
    const merged = mergeSkipped(ISSUES, SKIPPED);
    expect(merged).toHaveLength(13);
    expect(merged.slice(0, 11)).toEqual(ISSUES);
    expect(merged.slice(11).map((i) => i.code)).toEqual(["skipped", "skipped"]);
    // merging again, or listing someone twice, adds nobody
    expect(mergeSkipped(merged, SKIPPED)).toBe(merged);
    expect(mergeSkipped(ISSUES, [SKIPPED[0], SKIPPED[0]])).toHaveLength(12);
  });

  it("change nothing when nobody is skipped", () => {
    expect(mergeSkipped(ISSUES, undefined)).toBe(ISSUES);
    expect(mergeSkipped(ISSUES, [])).toBe(ISSUES);
    expect(mergeSkipped([], SKIPPED)).toHaveLength(2);
  });
});

describe("the counts", () => {
  it("count issues by severity and the people they belong to", () => {
    expect(summarizeIssues(ISSUES)).toEqual({
      total: 11,
      bySeverity: { critical: 2, warning: 7, info: 2 },
      employees: 3,
    });
    expect(summarizeIssues(mergeSkipped(ISSUES, SKIPPED))).toEqual({
      total: 13,
      bySeverity: { critical: 4, warning: 7, info: 2 },
      employees: 5,
    });
    expect(summarizeIssues([])).toEqual({ total: 0, bySeverity: { critical: 0, warning: 0, info: 0 }, employees: 0 });
  });

  it("list the issue types worst first, then the most frequent, then by name", () => {
    expect(issueTypeCounts(ISSUES).map((t) => [t.code, t.count])).toEqual([
      ["absent", 2],
      ["bank_missing", 1],
      ["half_day", 1],
      ["late_in", 1],
      ["late_penalty", 1],
      ["missing_punch", 1],
      ["no_shift", 1],
      ["unpaid_leave", 1],
      ["ot_pay", 1],
      ["pf_number_missing", 1],
    ]);
  });

  it("use the server's names and severities for the types when it sent them", () => {
    const byCode = summaryOf(ISSUES).byCode.map((c) =>
      c.code === "late_in" ? { ...c, label: "Late in", severity: "info" as const } : c,
    );
    expect(typeLabelMap(byCode).late_in).toBe("Late in");
    expect(typeLabelMap(undefined)).toEqual({});
    const types = issueTypeCounts(ISSUES, byCode);
    expect(types.find((t) => t.code === "late_in")).toMatchObject({ label: "Late in", severity: "info" });
    expect(types.find((t) => t.code === "absent")?.label).toBe("Absent");
  });

  it("know the skipped type even though the server never sends it", () => {
    const types = issueTypeCounts(mergeSkipped(ISSUES, SKIPPED), summaryOf(ISSUES).byCode);
    expect(types[0]).toMatchObject({ code: "absent", count: 2 });
    expect(types[1]).toMatchObject({ code: "skipped", count: 2, label: "Skipped at generation", severity: "critical" });
  });

  it("name the types of a severity under its figure, shortened to two", () => {
    const types = issueTypeCounts(ISSUES);
    expect(severityTypeNames(types, "critical")).toBe("Absent");
    expect(severityTypeNames(types, "info")).toBe("Overtime pay, PF number missing");
    expect(severityTypeNames(types, "warning")).toBe("Bank details missing, Half day +5 more");
    expect(severityTypeNames([], "critical")).toBeUndefined();
  });
});

describe("grouping by date", () => {
  const groups = groupIssues(ISSUES, "date");

  it("makes one group per day from the start of the period, the whole-period issues last", () => {
    expect(groups.map((g) => g.key)).toEqual(["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-20", "period"]);
    expect(groups.map((g) => g.label)).toEqual([
      "Tue, 13 Oct 2026",
      "Wed, 14 Oct 2026",
      "Thu, 15 Oct 2026",
      "Tue, 20 Oct 2026",
      "Whole period",
    ]);
    expect(groups.map((g) => g.issues.length)).toEqual([3, 1, 1, 1, 5]);
    expect(groups.map((g) => g.date)).toEqual(["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-20", null]);
    expect(groups.every((g) => g.by === "date")).toBe(true);
  });

  it("puts the worst issue of a day first, then orders by employee", () => {
    expect(groups[0].issues.map((i) => i.id)).toEqual([
      idOf(BALA, "absent", "2026-10-13"), // critical
      idOf(ASHA, "late_in", "2026-10-13"),
      idOf(CHITRA, "missing_punch", "2026-10-13"),
    ]);
    expect(groups[4].issues.map((i) => i.id)).toEqual([
      idOf(ASHA, "late_penalty", null),
      idOf(BALA, "bank_missing", null),
      idOf(BALA, "no_shift", null),
      idOf(ASHA, "ot_pay", null),
      idOf(CHITRA, "pf_number_missing", null),
    ]);
  });

  it("counts severities and adds up the cost of a day", () => {
    expect(groups[0].severity).toEqual({ critical: 1, warning: 2, info: 0 });
    expect(groups[0].impact).toEqual({ days: 1.25, shifts: 0, amount: 900 });
    expect(groups[4].impact).toEqual({ days: 0, shifts: 0, amount: 300 }); // overtime pay is information, not a cost
  });

  it("is empty for no issues", () => {
    expect(groupIssues([], "date")).toEqual([]);
    expect(groupIssues([], "employee")).toEqual([]);
    expect(groupIssues([], "type")).toEqual([]);
  });

  it("puts an issue with a datetime on its day", () => {
    const [g] = groupIssues([makeIssue(ASHA, "late_in", "2026-10-13T00:00:00+05:30")], "date");
    expect(g.key).toBe("2026-10-13");
  });
});

describe("grouping by employee", () => {
  const groups = groupIssues(ISSUES, "employee");

  it("lists the people with the worst issues first", () => {
    // Bala and Asha each have one critical issue; Bala has more that need a look. Chitra has no critical one.
    expect(groups.map((g) => g.label)).toEqual(["Bala Kumar", "Asha Worker", "Chitra Devi"]);
    expect(groups.map((g) => g.employeeId)).toEqual([12, 11, 13]);
    expect(groups.map((g) => g.severity)).toEqual([
      { critical: 1, warning: 3, info: 0 },
      { critical: 1, warning: 2, info: 1 },
      { critical: 0, warning: 2, info: 1 },
    ]);
  });

  it("lists a person's issues by day, whole-period ones last", () => {
    expect(groups[1].issues.map((i) => i.code)).toEqual(["late_in", "absent", "late_penalty", "ot_pay"]);
  });

  it("adds up what a person's issues cost, leaving out the information-only ones", () => {
    expect(groups[1].impact).toEqual({ days: 1.25, shifts: 0, amount: 1434.62 });
  });

  it("breaks a tie by name", () => {
    const tied = [makeIssue(CHITRA, "absent", "2026-10-13"), makeIssue(ASHA, "absent", "2026-10-13")];
    expect(groupIssues(tied, "employee").map((g) => g.label)).toEqual(["Asha Worker", "Chitra Devi"]);
  });
});

describe("grouping by type", () => {
  const groups = groupIssues(ISSUES, "type");

  it("lists the worst kinds first, then the most frequent, then by name", () => {
    expect(groups.map((g) => g.label)).toEqual([
      "Absent",
      "Bank details missing",
      "Half day",
      "Late arrival",
      "Late deduction",
      "Missing punch",
      "No shift assigned",
      "Unpaid leave",
      "Overtime pay",
      "PF number missing",
    ]);
    expect(groups[0]).toMatchObject({ code: "absent", key: "absent", by: "type" });
    expect(groups[0].issues).toHaveLength(2);
  });

  it("adds up what a kind cost in all, the information-only kinds included", () => {
    expect(groups[0].impact).toEqual({ days: 2, shifts: 0, amount: 2034.62 });
    expect(groups.find((g) => g.code === "ot_pay")?.impact).toEqual({ days: 0, shifts: 0, amount: 1200 });
  });

  it("uses the server's names when given", () => {
    const named = groupIssues(ISSUES, "type", { absent: "Absent from work" });
    expect(named.find((g) => g.code === "absent")?.label).toBe("Absent from work");
  });

  it("lists a kind's issues by day then employee", () => {
    expect(groups[0].issues.map((i) => i.id)).toEqual([
      idOf(BALA, "absent", "2026-10-13"),
      idOf(ASHA, "absent", "2026-10-14"),
    ]);
  });
});

describe("a page of the grouped issues", () => {
  const byDate = groupIssues(ISSUES, "date");

  it("by date holds that many issues, and a group carries on over the page break", () => {
    const sizes = [1, 2, 3, 4].map((p) => paginateGroups(byDate, "date", p, 3));
    expect(sizes.map((p) => [p.page, p.totalPages, p.total, p.from, p.to])).toEqual([
      [1, 4, 11, 1, 3],
      [2, 4, 11, 4, 6],
      [3, 4, 11, 7, 9],
      [4, 4, 11, 10, 11],
    ]);
    expect(sizes[0].groups.map((g) => [g.group.key, g.rows.length, g.continued])).toEqual([["2026-10-13", 3, false]]);
    expect(sizes[1].groups.map((g) => [g.group.key, g.rows.length, g.continued])).toEqual([
      ["2026-10-14", 1, false],
      ["2026-10-15", 1, false],
      ["2026-10-20", 1, false],
    ]);
    // the whole-period group has five issues: three on page 3 and the rest on page 4, which says it is continued
    expect(sizes[2].groups.map((g) => [g.group.key, g.rows.length, g.continued])).toEqual([["period", 3, false]]);
    expect(sizes[3].groups.map((g) => [g.group.key, g.rows.length, g.continued])).toEqual([["period", 2, true]]);
    // nothing is lost or repeated
    expect(sizes.flatMap((p) => p.groups.flatMap((g) => g.rows.map((i) => i.id))).sort()).toEqual(ids(ISSUES).sort());
  });

  it("a group that starts mid-page and goes on is split where the page ends", () => {
    const page = paginateGroups(byDate, "date", 1, 4);
    expect(page.groups.map((g) => [g.group.key, g.rows.length, g.continued])).toEqual([
      ["2026-10-13", 3, false],
      ["2026-10-14", 1, false],
    ]);
    const second = paginateGroups(byDate, "date", 2, 4);
    expect(second.groups.map((g) => [g.group.key, g.rows.length])).toEqual([
      ["2026-10-15", 1],
      ["2026-10-20", 1],
      ["period", 2],
    ]);
  });

  it("by type is cut the same way", () => {
    // Absent has two issues and Bank details missing one: that is the three of page 1
    const page = paginateGroups(groupIssues(ISSUES, "type"), "type", 1, 3);
    expect(page.groups.map((g) => g.group.label)).toEqual(["Absent", "Bank details missing"]);
    expect(page.groups.map((g) => g.rows.length)).toEqual([2, 1]);
    expect(paginateGroups(groupIssues(ISSUES, "type"), "type", 2, 3).groups.map((g) => g.group.label)).toEqual([
      "Half day",
      "Late arrival",
      "Late deduction",
    ]);
  });

  it("by employee holds that many employees, each with all their issues", () => {
    const byEmployee = groupIssues(ISSUES, "employee");
    const first = paginateGroups(byEmployee, "employee", 1, 2);
    const second = paginateGroups(byEmployee, "employee", 2, 2);
    expect([first.totalPages, first.total, first.from, first.to]).toEqual([2, 3, 1, 2]);
    expect([second.from, second.to]).toEqual([3, 3]);
    expect(first.groups.map((g) => [g.group.label, g.rows.length, g.continued])).toEqual([
      ["Bala Kumar", 4, false],
      ["Asha Worker", 4, false],
    ]);
    expect(second.groups.map((g) => [g.group.label, g.rows.length])).toEqual([["Chitra Devi", 3]]);
  });

  it("keeps the page inside the list", () => {
    expect(paginateGroups(byDate, "date", 99, 3).page).toBe(4);
    expect(paginateGroups(byDate, "date", 0, 3).page).toBe(1);
    expect(paginateGroups(byDate, "date", -2, 3).page).toBe(1);
    expect(paginateGroups(byDate, "date", Number.NaN, 3).page).toBe(1);
  });

  it("a short list is a single page, an empty one an empty page", () => {
    const one = paginateGroups(byDate, "date", 1);
    expect([one.page, one.totalPages, one.total, one.from, one.to]).toEqual([1, 1, 11, 1, 11]);
    const none = paginateGroups([], "date", 1);
    expect([none.page, none.totalPages, none.total, none.from, none.to, none.groups]).toEqual([1, 1, 0, 0, 0, []]);
  });

  it("is 30 to a page", () => {
    const many = groupIssues(manyIssues(75), "date");
    const p1 = paginateGroups(many, "date", 1);
    expect([p1.totalPages, p1.total, p1.from, p1.to]).toEqual([3, 75, 1, 30]);
    expect(p1.groups.reduce((n, g) => n + g.rows.length, 0)).toBe(30);
    const p3 = paginateGroups(many, "date", 3);
    expect([p3.from, p3.to]).toEqual([61, 75]);
    expect(p3.groups.reduce((n, g) => n + g.rows.length, 0)).toBe(15);
    // by employee: 75 people are 3 pages of 30, 30 and 15 employees
    const people = groupIssues(manyIssues(75), "employee");
    expect(paginateGroups(people, "employee", 3).groups).toHaveLength(15);
  });

  it("says what is showing", () => {
    const p = paginateGroups(byDate, "date", 1, 3);
    expect(showingText(p, "date", 11)).toBe("Showing 1–3 of 11 issues");
    expect(showingText(paginateGroups(byDate, "date", 4, 3), "date", 11)).toBe("Showing 10–11 of 11 issues");
    expect(showingText(paginateGroups(byDate, "date", 1), "date", 11)).toBe("Showing 1–11 of 11 issues");
    const single = groupIssues([makeIssue(ASHA, "absent", "2026-10-13")], "date");
    expect(showingText(paginateGroups(single, "date", 1), "date", 1)).toBe("Showing 1 of 1 issue");
    const people = paginateGroups(groupIssues(ISSUES, "employee"), "employee", 1, 2);
    expect(showingText(people, "employee", 11)).toBe("Showing employees 1–2 of 3 (11 issues)");
    expect(showingText(paginateGroups([], "date", 1), "date", 0)).toBe("");
  });
});

describe("an employee's Open details", () => {
  it("opens the first of their issues that has a payroll", () => {
    const skippedFirst = [skippedToIssue(SKIPPED[0]), makeIssue(ASHA, "late_in", "2026-10-13")];
    expect(detailsTarget(skippedFirst)?.code).toBe("late_in");
    expect(detailsTarget([skippedToIssue(SKIPPED[0])])).toBeUndefined();
  });
});

describe("the export", () => {
  const columns = issueExportColumns();

  it("has the columns the owner asked for, in order", () => {
    expect(columns.map((c) => c.label)).toEqual([
      "Date detected",
      "Employee code",
      "Employee",
      "Department",
      "Type",
      "Severity",
      "Title",
      "Details",
      "Impact",
      "Rule",
      "Flagged at",
    ]);
    expect(new Set(columns.map((c) => c.key)).size).toBe(columns.length); // unique keys
  });

  it("writes each issue as a row", () => {
    const issue = ISSUES[0]; // Asha late_in, 13 Oct, with an impact and a rule
    const row = Object.fromEntries(columns.map((c) => [c.label, c.value?.(issue)]));
    expect(row).toEqual({
      "Date detected": "2026-10-13",
      "Employee code": "PC-S1",
      Employee: "Asha Worker",
      Department: "Weaving",
      Type: "Late arrival",
      Severity: "Needs a look",
      Title: "Late arrival",
      Details: "First punch 09:42, after General 09:00 + 10 min grace (09:10)",
      Impact: "0.25 days",
      Rule: "Late allowance",
      "Flagged at": dateTime(DETECTED_AT),
    });
  });

  it("says Whole period for an issue with no day, and leaves empty what is missing", () => {
    const bank = ISSUES.find((i) => i.code === "bank_missing")!;
    const row = Object.fromEntries(
      columns.map((c) => [c.label, c.value?.({ ...bank, department: null, detectedAt: null })]),
    );
    expect(row["Date detected"]).toBe("Whole period");
    expect(row.Department).toBe("");
    expect(row.Impact).toBe("");
    expect(row.Rule).toBe("");
    expect(row["Flagged at"]).toBe("");
  });

  it("uses the server's names for the types", () => {
    const named = issueExportColumns({ late_in: "Late in" });
    expect(named.find((c) => c.label === "Type")?.value?.(ISSUES[0])).toBe("Late in");
  });

  it("the date column is written as a date", () => {
    expect(columns[0].type).toBe("date");
  });
});
