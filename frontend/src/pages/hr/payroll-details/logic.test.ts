import { describe, expect, it } from "vitest";
import type { PayrollDay, PayrollIssue } from "@/lib/api-client/custom-hooks";
import type { DayKind } from "./logic";
import { cleanDetails, legacyDetails, noBreakdownDetails, productionDetails, staffDetails } from "./fixtures";
import {
  CALENDAR_HEADERS,
  DAY_KINDS,
  DAY_KIND_META,
  MARK_FILL_ORDER,
  MARK_KEYS,
  MARK_META,
  NO_ISSUE_FILTERS,
  SECTIONS,
  SECTION_IDS,
  activeFilterCount,
  addDaysIso,
  backLabelFor,
  buildCalendar,
  changedRules,
  countRules,
  dateRangeOf,
  dayKind,
  eachDay,
  factValue,
  fallbackListPath,
  fillKindCounts,
  fillMark,
  filterDays,
  filterIssues,
  groupIssuesByDate,
  groupIssuesByType,
  humanizeKey,
  isDegraded,
  impactParts,
  impactTotals,
  impactTotalsText,
  isRuleChanged,
  kindCounts,
  markCounts,
  marksOf,
  netBridge,
  normalizeDetails,
  parsePayrollId,
  parseSectionParam,
  pickActiveSection,
  sectionDomId,
  severityCounts,
  slug,
  statusLabel,
  typeOptions,
  weekStartIso,
  weekdayOffset,
  workTile,
  type IssueFilters,
} from "./logic";

const staff = staffDetails();
const issues = staff.issues;
const withFilters = (over: Partial<IssueFilters>): IssueFilters => ({ ...NO_ISSUE_FILTERS, ...over });
const ids = (list: PayrollIssue[]) => list.map((i) => i.id);

describe("sections", () => {
  it("are the three the nav shows, in reading order: the days first", () => {
    expect(SECTIONS.map((s) => s.label)).toEqual(["Attendance", "Issues", "Pay & deductions"]);
    expect(SECTION_IDS).toEqual(["attendance", "issues", "pay"]);
    expect(sectionDomId("issues")).toBe("pd-issues");
  });

  it("?section= accepts a section's name, a few aliases (days), and nothing else", () => {
    expect(parseSectionParam("issues")).toBe("issues");
    expect(parseSectionParam(" PAY ")).toBe("pay");
    expect(parseSectionParam("days")).toBe("attendance");
    expect(parseSectionParam("calendar")).toBe("attendance");
    expect(parseSectionParam("deductions")).toBe("pay");
    // the sections that are gone (links made before) open the page at its top
    for (const gone of ["overview", "rules", "employee", "history", "profile", "payroll"]) {
      expect(parseSectionParam(gone), gone).toBeNull();
    }
    expect(parseSectionParam("nonsense")).toBeNull();
    expect(parseSectionParam("")).toBeNull();
    expect(parseSectionParam(null)).toBeNull();
    expect(parseSectionParam(undefined)).toBeNull();
  });

  it("the scroll spy picks the last section whose top has passed the reading line", () => {
    const tops = [
      { id: "attendance", top: -400 },
      { id: "issues", top: -50 },
      { id: "pay", top: 900 },
    ];
    expect(pickActiveSection(tops, 96, false)).toBe("issues");
    expect(pickActiveSection(tops, 1000, false)).toBe("pay");
    // at the very top every section is still below the line: the first one is being read
    expect(
      pickActiveSection(
        tops.map((t) => ({ ...t, top: t.top + 1000 })),
        96,
        false,
      ),
    ).toBe("attendance");
    // at the bottom of the page the last section wins, even if it is too short to reach the line
    expect(pickActiveSection(tops, 96, true)).toBe("pay");
    expect(pickActiveSection([], 96, false)).toBeNull();
  });

  it("the route's :id is a positive whole number or nothing", () => {
    expect(parsePayrollId("12")).toBe(12);
    expect(parsePayrollId("007")).toBe(7);
    for (const bad of ["0", "-3", "1.5", "abc", "12abc", "", undefined, null, "99999999999999999999"]) {
      expect(parsePayrollId(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });

  it("Back says where it goes", () => {
    expect(backLabelFor("staff", staff)).toBe("Back to Payroll · October 2026");
    expect(backLabelFor("staff", null)).toBe("Back to Payroll");
    expect(backLabelFor("production", productionDetails())).toBe("Back to Production Payroll · Weekly");
    const noLabel = productionDetails({
      period: { ...productionDetails().period, cycleLabel: null },
      context: { ...productionDetails().context, cycle: "biweekly" },
    });
    expect(backLabelFor("production", noLabel)).toBe("Back to Production Payroll · BiWeekly");
    expect(backLabelFor("production", null)).toBe("Back to Production Payroll");
    expect(fallbackListPath("staff")).toBe("/hr/payroll");
    expect(fallbackListPath("production")).toBe("/hr/production-payroll");
  });
});

describe("dates", () => {
  it("count weekdays from Monday, so the calendar knows how many cells to leave blank", () => {
    expect(weekdayOffset("2026-10-05")).toBe(0); // Monday
    expect(weekdayOffset("2026-10-01")).toBe(3); // Thursday
    expect(weekdayOffset("2026-10-04")).toBe(6); // Sunday
    expect(weekdayOffset("not a date")).toBe(-1);
    expect(weekdayOffset(null)).toBe(-1);
  });

  it("find the Monday of a week, across a month end", () => {
    expect(weekStartIso("2026-10-13")).toBe("2026-10-12");
    expect(weekStartIso("2026-10-11")).toBe("2026-10-05"); // a Sunday belongs to the week before it
    expect(weekStartIso("2026-10-01")).toBe("2026-09-28");
    expect(weekStartIso(undefined)).toBeNull();
  });

  it("add days without a time zone getting in the way", () => {
    expect(addDaysIso("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysIso("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(eachDay("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(eachDay("2026-11-02", "2026-10-30")).toEqual([]);
    expect(eachDay("2026-01-01", "2030-01-01").length).toBe(400); // a bad range cannot run away
  });
});

describe("filtering the issues", () => {
  it("starts with everything", () => {
    expect(filterIssues(issues, NO_ISSUE_FILTERS)).toHaveLength(11);
    expect(activeFilterCount(NO_ISSUE_FILTERS)).toBe(0);
  });

  it("by severity: one or several", () => {
    expect(ids(filterIssues(issues, withFilters({ severities: ["critical"] })))).toEqual(["101:absent:2026-10-06"]);
    expect(filterIssues(issues, withFilters({ severities: ["warning"] }))).toHaveLength(8);
    expect(filterIssues(issues, withFilters({ severities: ["warning", "info"] }))).toHaveLength(10);
  });

  it("by kind", () => {
    const late = filterIssues(issues, withFilters({ code: "late_in" }));
    expect(late).toHaveLength(3);
    expect(late.every((i) => i.code === "late_in")).toBe(true);
    expect(filterIssues(issues, withFilters({ code: "no_shift" }))).toEqual([]);
  });

  it("by date range: inclusive at both ends, open-ended with one end, and the whole-period issues drop out", () => {
    const week = filterIssues(issues, withFilters({ from: "2026-10-13", to: "2026-10-20" }));
    expect(ids(week)).toEqual(["101:late_in:2026-10-13", "101:late_in:2026-10-14", "101:early_out:2026-10-20"]);
    expect(ids(filterIssues(issues, withFilters({ from: "2026-10-27" })))).toEqual([
      "101:missing_punch:2026-10-27",
      "101:late_in:2026-10-29",
    ]);
    expect(ids(filterIssues(issues, withFilters({ to: "2026-10-07" })))).toEqual([
      "101:absent:2026-10-06",
      "101:unpaid_leave:2026-10-07",
    ]);
    expect(filterIssues(issues, withFilters({ from: "2026-10-13", to: "2026-10-13" }))).toHaveLength(1);
  });

  it("a From later than the To is read the other way about", () => {
    expect(dateRangeOf({ from: "2026-10-20", to: "2026-10-13" })).toEqual({ from: "2026-10-13", to: "2026-10-20" });
    expect(filterIssues(issues, withFilters({ from: "2026-10-20", to: "2026-10-13" }))).toHaveLength(3);
    expect(dateRangeOf({ from: "", to: "" })).toBeNull();
  });

  it("by words: in the detail, the facts, the date and the period, ignoring case and blanks", () => {
    expect(filterIssues(issues, withFilters({ query: "grace" }))).toHaveLength(4); // 3 late arrivals + the early leaving
    expect(ids(filterIssues(issues, withFilters({ query: "09:42" })))).toEqual(["101:late_in:2026-10-13"]);
    expect(ids(filterIssues(issues, withFilters({ query: "tue, 13 oct" })))).toEqual(["101:late_in:2026-10-13"]);
    expect(filterIssues(issues, withFilters({ query: "WHOLE PERIOD" }))).toHaveLength(3);
    expect(ids(filterIssues(issues, withFilters({ query: "billable" })))).toEqual(["101:late_penalty:period"]);
    // a fact's name is searchable too: "excess permission" is only a key of the late pool's facts
    expect(ids(filterIssues(issues, withFilters({ query: "excess permission" })))).toEqual(["101:late_penalty:period"]);
    expect(filterIssues(issues, withFilters({ query: "   " }))).toHaveLength(11);
    expect(filterIssues(issues, withFilters({ query: "zzzz" }))).toEqual([]);
  });

  it("every filter has to pass", () => {
    const one = filterIssues(
      issues,
      withFilters({ severities: ["warning"], code: "late_in", query: "09:25", from: "2026-10-01", to: "2026-10-31" }),
    );
    expect(ids(one)).toEqual(["101:late_in:2026-10-14"]);
  });

  it("counts the filters that narrow the list (a date range counts once)", () => {
    expect(activeFilterCount(withFilters({ severities: ["critical", "info"] }))).toBe(1);
    expect(activeFilterCount(withFilters({ severities: ["critical"], code: "absent" }))).toBe(2);
    expect(activeFilterCount(withFilters({ from: "2026-10-01", to: "2026-10-05" }))).toBe(1);
    expect(activeFilterCount(withFilters({ to: "2026-10-05" }))).toBe(1);
    expect(activeFilterCount(withFilters({ query: "  " }))).toBe(0);
    expect(activeFilterCount({ severities: ["info"], code: "late_in", from: "2026-10-01", to: "", query: "x" })).toBe(
      4,
    );
  });

  it("counts severities from the issues", () => {
    expect(severityCounts(issues)).toEqual({ critical: 1, warning: 8, info: 2 });
    expect(severityCounts([])).toEqual({ critical: 0, warning: 0, info: 0 });
  });

  it("offers the kinds present, worst first and then by name, each with its count", () => {
    const options = typeOptions(staff.issueCounts.byCode, issues);
    expect(options.map((o) => o.code)).toEqual([
      "absent",
      "early_out",
      "half_day",
      "late_in",
      "late_penalty",
      "missing_punch",
      "unpaid_leave",
      "advance_recovery",
      "esi_number_missing",
    ]);
    expect(options.find((o) => o.code === "late_in")).toMatchObject({
      label: "Late arrival",
      count: 3,
      severity: "warning",
    });
    // without the server's counts they are worked out from the issues themselves
    expect(typeOptions({}, issues)).toEqual(options);
    expect(typeOptions(undefined, issues)).toEqual(options);
    expect(typeOptions(undefined, [])).toEqual([]);
    // a code the screens do not know yet is still offered, in words
    expect(typeOptions({ brand_new_code: 2 }, [])[0]).toMatchObject({
      code: "brand_new_code",
      label: "brand new code",
      count: 2,
    });
  });

  it("describes what an issue cost", () => {
    expect(impactParts({ days: 0.5, shifts: 0.25, amount: 100, label: "capped" })).toEqual([
      "0.5 days",
      "0.25 shifts",
      "₹100.00",
      "capped",
    ]);
    expect(impactParts({ days: 1 })).toEqual(["1 day"]);
    expect(impactParts(null)).toEqual([]);
    expect(impactParts({})).toEqual([]);
    expect(impactTotals(issues)).toEqual({ days: 2.5, shifts: 0.5, amount: 1134.62 * 2 + 567.31 * 2 + 1000 });
    expect(impactTotalsText({ days: 1, shifts: 0, amount: 1134.62 })).toBe("1 day · ₹1,134.62");
    expect(impactTotalsText({ days: 0, shifts: 0, amount: 0 })).toBe("");
  });

  it("writes keys and facts for people", () => {
    expect(humanizeKey("first_punch")).toBe("first punch");
    expect(humanizeKey("firstIn")).toBe("first in");
    expect(humanizeKey("graceMinutes")).toBe("grace minutes");
    expect(factValue(null)).toBe("—");
    expect(factValue(true)).toBe("yes");
    expect(factValue(false)).toBe("no");
    expect(factValue(10)).toBe("10");
    expect(factValue(1.23456)).toBe("1.23");
    expect(factValue("09:42")).toBe("09:42");
    expect(slug("Late detection")).toBe("late-detection");
    expect(statusLabel("paid_leave")).toBe("Paid leave");
    expect(statusLabel("")).toBe("—");
  });
});

describe("grouping the issues", () => {
  it("by date: the whole-period issues first, then a band per week (Monday to Sunday), then a header per day", () => {
    const bands = groupIssuesByDate(issues);
    expect(bands.map((b) => b.key)).toEqual(["period", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(bands[0]).toMatchObject({ label: "Whole period", count: 3, start: null });
    expect(bands[0].days).toHaveLength(1);
    expect(ids(bands[0].days[0].issues).sort()).toEqual([
      "101:advance_recovery:period",
      "101:esi_number_missing:period",
      "101:late_penalty:period",
    ]);
    expect(bands[1].label).toBe("Week of 5 Oct - 11 Oct 2026");
    expect(bands[1].days.map((d) => d.label)).toEqual(["Tue, 6 Oct 2026", "Wed, 7 Oct 2026"]);
    expect(bands.slice(1).map((b) => b.count)).toEqual([2, 2, 2, 2]);
  });

  it("by date: nothing is lost and a day lists its worst issue first", () => {
    const worse: PayrollIssue = { ...issues[3], id: "x:absent:2026-10-14", code: "absent", severity: "critical" };
    const all = [...issues, worse];
    const bands = groupIssuesByDate(all);
    expect(bands.flatMap((b) => b.days.flatMap((d) => d.issues))).toHaveLength(all.length);
    const day = bands.flatMap((b) => b.days).find((d) => d.date === "2026-10-14")!;
    expect(day.issues.map((i) => i.severity)).toEqual(["critical", "warning"]);
    expect(groupIssuesByDate([])).toEqual([]);
  });

  it("by type: worst kind first, then the commonest, with what each kind cost", () => {
    const groups = groupIssuesByType(issues);
    expect(groups.map((g) => g.code)).toEqual([
      "absent",
      "late_in",
      "early_out",
      "half_day",
      "late_penalty",
      "missing_punch",
      "unpaid_leave",
      "advance_recovery",
      "esi_number_missing",
    ]);
    expect(groups[1].issues).toHaveLength(3);
    expect(groups[0].totals).toEqual({ days: 1, shifts: 0, amount: 1134.62 });
    expect(groups.find((g) => g.code === "late_penalty")!.totals).toEqual({ days: 0, shifts: 0.5, amount: 567.31 });
    // the dates inside a kind run oldest first
    expect(groups[1].issues.map((i) => i.date)).toEqual(["2026-10-13", "2026-10-14", "2026-10-29"]);
    expect(groupIssuesByType([])).toEqual([]);
  });
});

const day = (over: Partial<PayrollDay>): PayrollDay => ({
  date: "2026-10-13",
  day: "Tue",
  status: "present",
  firstIn: "09:00",
  lastOut: "18:00",
  shifts: 1,
  flags: [],
  note: null,
  ...over,
});

describe("the days", () => {
  it("each day is one kind: the status, made more specific by what was flagged", () => {
    const kind = (over: Partial<PayrollDay>) => dayKind(day(over));
    expect(kind({})).toBe("present");
    expect(kind({ flags: ["late_in"] })).toBe("late");
    expect(kind({ flags: ["early_out"] })).toBe("early");
    expect(kind({ isLate: true })).toBe("late");
    expect(kind({ isEarlyOut: true })).toBe("early");
    expect(kind({ flags: ["missing_punch"] })).toBe("present");
    expect(kind({ flags: ["late_in", "half_day"] })).toBe("half");
    expect(kind({ status: "half_shift" })).toBe("half");
    expect(kind({ status: "absent", flags: ["absent"] })).toBe("absent");
    expect(kind({ status: "unpaid_leave" })).toBe("unpaid");
    expect(kind({ status: "paid_leave" })).toBe("leave");
    expect(kind({ status: "casual_leave" })).toBe("casual");
    // production calls a leave day on_leave, and it is not paid: its own kind
    expect(kind({ status: "on_leave" })).toBe("onleave");
    // staff payroll records a half day as a present day at half a shift
    expect(kind({ shifts: 0.5 })).toBe("half");
    expect(kind({ shifts: 0.5, flags: ["late_in"] })).toBe("half");
    expect(kind({ shifts: 0.75 })).toBe("present");
    expect(kind({ status: "absent", shifts: 0.5 })).toBe("absent");
    expect(kind({ status: "holiday" })).toBe("holiday");
    expect(kind({ status: "week_off" })).toBe("weekoff");
    expect(kind({ status: "PRESENT" })).toBe("present");
    expect(kind({ status: "something new" })).toBe("other");
    expect(DAY_KINDS).toHaveLength(19);
    expect(new Set(DAY_KINDS).size).toBe(19);
  });

  it("tells Casual Leave, compensations, On-Duty, Sundays and holidays apart", () => {
    const kind = (over: Partial<PayrollDay>) => dayKind(day(over));
    // an approved Casual Leave day is stored as a present day: only the flag tells it apart
    expect(kind({ casualLeave: true })).toBe("casual");
    expect(kind({ compensationType: "compensation" })).toBe("comp");
    expect(kind({ compensationType: "sunday_compensation" })).toBe("sunday_comp");
    expect(kind({ compensationType: "ot_compensation" })).toBe("ot_comp");
    // On-Duty only counts once HR approved it and the punches are there
    const od = (state: "verified" | "pending" | "no_punches" | "punches_pending" | "rejected") => ({
      state,
      label: "x",
      destination: "",
    });
    expect(kind({ onDuty: od("verified") })).toBe("onduty");
    for (const state of ["pending", "no_punches", "punches_pending", "rejected"] as const) {
      expect(kind({ status: "absent", shifts: 0, onDuty: od(state) }), state).toBe("onduty_pending");
    }
    expect(kind({ status: "absent", shifts: 0 })).toBe("absent");
    // a Sunday nobody worked is the quiet weekly off; a named holiday is a holiday; a worked Sunday is its attendance
    expect(kind({ status: "holiday", isSunday: true })).toBe("weekoff");
    expect(kind({ status: "holiday", isSunday: true, holidayName: "Deepavali" })).toBe("holiday");
    expect(kind({ status: "present", isSunday: true })).toBe("present");
    // worked on a Sunday or a holiday: the real attendance, in the gradient colours of a worked day off
    expect(kind({ status: "present", isSunday: true, workedOffDay: true })).toBe("sunday_worked");
    expect(kind({ status: "present", workedOffDay: true, holidayName: "Deepavali" })).toBe("holiday_worked");
  });

  it("every kind has its own colour", () => {
    const swatches = DAY_KINDS.filter(
      (k) => !["unpaid", "leave", "onleave", "holiday", "weekoff", "other"].includes(k),
    ).map((k) => DAY_KIND_META[k].swatch);
    expect(new Set(swatches).size).toBe(swatches.length);
    // the three leave kinds are one family: other leave
    expect(new Set(["unpaid", "leave", "onleave"].map((k) => DAY_KIND_META[k as DayKind].swatch)).size).toBe(1);
  });

  it("counts the October fixture's days by kind, and they add up to the month", () => {
    const counts = kindCounts(staff.days);
    expect(counts).toMatchObject({
      present: 17,
      late: 3,
      early: 1,
      half: 1,
      absent: 1,
      unpaid: 1,
      leave: 2,
      onleave: 0,
      holiday: 0,
      other: 0,
    });
    // staff payroll lists the 26 working days only: the Sundays and the holiday have no entry
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(26);
    expect(staff.days).toHaveLength(26);
  });

  it("filters by kind and by flagged only", () => {
    expect(filterDays(staff.days, { kind: "late", flaggedOnly: false })).toHaveLength(3);
    expect(filterDays(staff.days, { kind: "all", flaggedOnly: true })).toHaveLength(8);
    expect(filterDays(staff.days, { kind: "present", flaggedOnly: true }).map((d) => d.date)).toEqual(["2026-10-27"]);
    expect(filterDays(staff.days, { kind: "early", flaggedOnly: true }).map((d) => d.date)).toEqual(["2026-10-20"]);
    expect(filterDays(staff.days, { kind: "all", flaggedOnly: false })).toHaveLength(26);
    expect(filterDays(staff.days, { kind: "holiday", flaggedOnly: true })).toEqual([]);
  });
});

describe("the attendance categories of a day", () => {
  const d = (over: Partial<PayrollDay>) => day(over);

  it("are the six HR looks for, in one fixed order, each with a colour of its own", () => {
    expect(MARK_KEYS).toEqual(["late", "permission", "excess_permission", "on_duty", "on_duty_punch", "missed_punch"]);
    expect(Object.keys(MARK_META)).toEqual(MARK_KEYS);
    expect(MARK_META.late.label).toBe("Late attendance");
    expect(MARK_META.excess_permission.label).toBe("Excess permission");
    expect(MARK_META.on_duty_punch.label).toBe("On-Duty punch");
    expect(MARK_META.missed_punch.label).toBe("Missed punch");
    // no two categories share a fill, an edge or a tag colour
    for (const part of ["cell", "bar", "pill", "swatch"] as const) {
      expect(new Set(MARK_KEYS.map((k) => MARK_META[k][part])).size, part).toBe(6);
    }
    expect([...MARK_FILL_ORDER].sort()).toEqual([...MARK_KEYS].sort());
  });

  it("are what the server marked on the day plus what payroll flagged on it", () => {
    expect(marksOf(d({}))).toEqual([]);
    expect(marksOf(d({ marks: ["on_duty", "permission"] }))).toEqual(["permission", "on_duty"]); // fixed order
    // an older server sends no marks: the payroll's own flags still say late, excess permission and missing punch
    expect(marksOf(d({ flags: ["late_in", "missing_punch", "excess_permission"] }))).toEqual([
      "late",
      "excess_permission",
      "missed_punch",
    ]);
    expect(marksOf(d({ flags: ["absent", "half_day"] }))).toEqual([]);
    // the same category from both places counts once
    expect(marksOf(d({ marks: ["late"], flags: ["late_in"] }))).toEqual(["late"]);
    expect(marksOf({ marks: undefined, flags: undefined as never })).toEqual([]);
  });

  it("count the days that carry each", () => {
    expect(markCounts(staff.days)).toEqual({
      late: 3,
      permission: 3,
      excess_permission: 1,
      on_duty: 2,
      on_duty_punch: 1,
      missed_punch: 1,
    });
    expect(markCounts([])).toEqual({
      late: 0,
      permission: 0,
      excess_permission: 0,
      on_duty: 0,
      on_duty_punch: 0,
      missed_punch: 0,
    });
  });

  it("colour the cell of a worked day, the most pressing category first", () => {
    expect(fillMark(d({}))).toBeNull();
    expect(fillMark(d({ marks: ["late"] }))).toBe("late");
    expect(fillMark(d({ marks: ["late", "permission"] }))).toBe("permission");
    expect(fillMark(d({ marks: ["on_duty", "on_duty_punch"] }))).toBe("on_duty_punch");
    expect(fillMark(d({ marks: ["on_duty", "late"] }))).toBe("on_duty");
    expect(fillMark(d({ marks: ["permission", "excess_permission"] }))).toBe("excess_permission");
    expect(fillMark(d({ flags: ["missing_punch"] }))).toBe("missed_punch");
  });

  it("never hide that a day was not worked, or was cut to half: those keep the colour of their status", () => {
    expect(fillMark(d({ status: "absent", marks: ["permission"] }))).toBeNull();
    expect(fillMark(d({ status: "unpaid_leave", marks: ["on_duty"] }))).toBeNull();
    expect(fillMark(d({ status: "paid_leave", marks: ["on_duty"] }))).toBeNull();
    expect(fillMark(d({ status: "holiday", marks: ["on_duty"] }))).toBeNull();
    expect(fillMark(d({ shifts: 0.5, marks: ["permission"] }))).toBeNull();
    expect(fillMark(d({ flags: ["half_day"], marks: ["late"] }))).toBeNull();
  });

  it("leave the status legend counting the cells that really show that status", () => {
    // 26 days: 5 plain present days were filled by a category, and the 3 late days all are
    expect(fillKindCounts(staff.days)).toMatchObject({
      present: 12,
      late: 0,
      early: 1,
      half: 1,
      absent: 1,
      unpaid: 1,
      leave: 2,
      onleave: 0,
      holiday: 0,
      other: 0,
    });
    // the table counts every day of a status
    expect(kindCounts(staff.days).present).toBe(17);
  });

  it("filter the days by category, and by the status a cell shows", () => {
    const dates = (over: Parameters<typeof filterDays>[1]) => filterDays(staff.days, over).map((x) => x.date);
    expect(dates({ kind: "all", flaggedOnly: false, mark: "permission" })).toEqual([
      "2026-10-14",
      "2026-10-15",
      "2026-10-22",
    ]);
    expect(dates({ kind: "all", flaggedOnly: false, mark: "on_duty" })).toEqual(["2026-10-16", "2026-10-21"]);
    expect(dates({ kind: "all", flaggedOnly: false, mark: "missed_punch" })).toEqual(["2026-10-27"]);
    expect(dates({ kind: "all", flaggedOnly: false, mark: "all" })).toHaveLength(26);
    // "present" in the table is every present day; on the calendar only the cells that show the present colour
    expect(dates({ kind: "present", flaggedOnly: false })).toHaveLength(17);
    expect(dates({ kind: "present", flaggedOnly: false, plainOnly: true })).toHaveLength(12);
    // both filters have to pass
    expect(dates({ kind: "all", flaggedOnly: true, mark: "late" })).toEqual(["2026-10-13", "2026-10-14", "2026-10-29"]);
  });
});

describe("the calendar", () => {
  it("lays October 2026 out Monday first: three blanks before Thursday the 1st, one after the 31st", () => {
    const weeks = buildCalendar(staff.days, "2026-10-01", "2026-10-31");
    expect(CALENDAR_HEADERS[0]).toBe("Mon");
    expect(weeks).toHaveLength(5);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0].slice(0, 3).map((c) => c.type)).toEqual(["blank", "blank", "blank"]);
    expect(weeks[0][3]).toMatchObject({ type: "day", date: "2026-10-01", dayNumber: 1 });
    expect(weeks[0][6]).toMatchObject({ type: "day", date: "2026-10-04" }); // the first Sunday
    const last = weeks[4];
    expect(last.slice(0, 6).map((c) => (c.type === "day" ? c.dayNumber : 0))).toEqual([26, 27, 28, 29, 30, 31]);
    expect(last[6].type).toBe("blank");
    const cells = weeks.flat().filter((c) => c.type === "day");
    expect(cells).toHaveLength(31);
    // 26 working days have a record; the four Sundays and the 2 Oct holiday are cells with no data
    const without = cells.filter((c) => c.type === "day" && c.day === null);
    expect(without.map((c) => (c.type === "day" ? c.date : ""))).toEqual([
      "2026-10-02",
      "2026-10-04",
      "2026-10-11",
      "2026-10-18",
      "2026-10-25",
    ]);
    expect(without.every((c) => c.type === "day" && c.kind === null)).toBe(true);
    expect(cells.filter((c) => c.type === "day" && c.day !== null && c.kind !== null)).toHaveLength(26);
  });

  it("a week that starts on a Monday has no blanks", () => {
    const weeks = buildCalendar(productionDetails().days, "2026-10-05", "2026-10-11");
    expect(weeks).toHaveLength(1);
    expect(weeks[0].every((c) => c.type === "day")).toBe(true);
    expect(weeks[0].map((c) => (c.type === "day" ? c.kind : null))).toEqual([
      "present",
      "late",
      "present",
      "half",
      "present",
      "absent",
      "holiday",
    ]);
  });

  it("a day with no record is an empty cell, and a period running over a month end keeps going", () => {
    const some = [day({ date: "2026-10-29" }), day({ date: "2026-11-02" })];
    const weeks = buildCalendar(some, "2026-10-29", "2026-11-03");
    const cells = weeks.flat().filter((c) => c.type === "day");
    expect(cells.map((c) => (c.type === "day" ? c.date : ""))).toEqual([
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
    expect(cells[1]).toMatchObject({ day: null, kind: null });
    expect(cells[0]).toMatchObject({ kind: "present" });
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it("covers the days it was given even when the period says less, and is empty with nothing at all", () => {
    const weeks = buildCalendar([day({ date: "2026-10-12" })], null, null);
    expect(weeks.flat().filter((c) => c.type === "day")).toHaveLength(1);
    expect(buildCalendar([], null, null)).toEqual([]);
    expect(
      buildCalendar([], "2026-10-05", "2026-10-06")
        .flat()
        .filter((c) => c.type === "day"),
    ).toHaveLength(2);
  });
});

describe("the rules", () => {
  const groups = staff.rules;

  it("counts them, and finds the ones changed since the payroll was generated", () => {
    expect(countRules(groups)).toBe(15);
    const changed = changedRules(groups);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ group: "Late detection" });
    expect(changed[0].item).toMatchObject({
      key: "late_free_allowance",
      applied: "2 free, then slabs",
      value: "3 free, then slabs",
    });
    expect(changedRules(cleanDetails().rules)).toEqual([]);
  });

  it("a rule is changed when the server says so, or, when it says nothing, when what it was generated with differs", () => {
    const base = { key: "k", label: "L", source: "settings" as const, settingsPath: null };
    expect(isRuleChanged({ ...base, value: "b", changed: true })).toBe(true);
    expect(isRuleChanged({ ...base, value: "b", applied: "a", changed: false })).toBe(false);
    expect(isRuleChanged({ ...base, value: "b", applied: "a" })).toBe(true);
    expect(isRuleChanged({ ...base, value: "a", applied: "a" })).toBe(false);
    expect(isRuleChanged({ ...base, value: "a" })).toBe(false);
  });
});

describe("the dashboard figures", () => {
  it("staff: days worked of working days, with what they are made of", () => {
    expect(workTile(staff, "staff")).toEqual({
      label: "Days worked",
      value: "23.5",
      outOf: "26",
      sub: "21 present · 2 paid leave · 1 half · 2 LOP",
    });
    expect(workTile({ summary: {} }, "staff")).toMatchObject({ value: "—", outOf: null, sub: "" });
    // without the working days there is nothing to put the figure out of
    expect(workTile({ summary: { effectivePaidDays: 12 } }, "staff")).toMatchObject({ value: "12", outOf: null });
  });

  it("production: shifts, with the days behind them", () => {
    expect(workTile(productionDetails(), "production")).toEqual({
      label: "Shifts",
      value: "4.5",
      outOf: null,
      sub: "5 days worked · 1 absent",
    });
    expect(workTile({ summary: {} }, "production").value).toBe("—");
  });

  it("the net bridge: how much of the gross went on deductions, and what else moved the net", () => {
    const plain = netBridge(staff.money);
    expect(plain.deductionsPct).toBeCloseTo(11.88, 1);
    expect(plain.deductionsPct + plain.netPct).toBeCloseTo(100, 5);
    expect(plain.other).toBe(0);
    const overtime = netBridge({
      gross: 1000,
      deductions: 100,
      bonus: 0,
      otAmount: 200,
      net: 1100,
      monthlySalary: null,
      dailyRate: null,
    });
    expect(overtime).toMatchObject({ other: 200, otherIsOvertime: true });
    const bonus = netBridge({
      gross: 1000,
      deductions: 100,
      bonus: 50,
      otAmount: 0,
      net: 950,
      monthlySalary: null,
      dailyRate: null,
    });
    expect(bonus).toMatchObject({ bonus: 50, other: 0 });
    const unexplained = netBridge({
      gross: 1000,
      deductions: 100,
      bonus: 0,
      otAmount: 0,
      net: 800,
      monthlySalary: null,
      dailyRate: null,
    });
    expect(unexplained).toMatchObject({ other: -100, otherIsOvertime: false });
    expect(
      netBridge({ gross: 0, deductions: 0, bonus: 0, otAmount: 0, net: 0, monthlySalary: null, dailyRate: null })
        .deductionsPct,
    ).toBe(0);
    expect(
      netBridge({ gross: 100, deductions: 400, bonus: 0, otAmount: 0, net: 0, monthlySalary: null, dailyRate: null })
        .deductionsPct,
    ).toBe(100);
  });
});

describe("a payroll with no breakdown behind it", () => {
  it("is told apart from one that is merely clean: no days and no rules, or an older session-based payroll", () => {
    expect(isDegraded(staff)).toBe(false);
    expect(isDegraded(cleanDetails())).toBe(false); // no issues, but its days and rules are there
    expect(isDegraded(productionDetails())).toBe(false);
    expect(isDegraded(noBreakdownDetails())).toBe(true);
    expect(isDegraded(legacyDetails())).toBe(true);
    // an older payroll is degraded even if it somehow sent some days
    expect(isDegraded({ ...legacyDetails(), days: staff.days })).toBe(true);
    // days without rules (or rules without days) are still a breakdown
    expect(isDegraded({ ...staff, rules: [] })).toBe(false);
    expect(isDegraded({ ...staff, days: [] })).toBe(false);
  });
});

describe("a partly filled answer", () => {
  it("is given every list and object it lacks, so a section shows 'nothing here' instead of crashing", () => {
    const partial = {
      ...staff,
      rules: undefined,
      issues: undefined,
      days: undefined,
      advances: undefined,
      history: undefined,
      earnings: undefined,
      deductions: undefined,
      summary: undefined,
      issueCounts: undefined,
      neighbours: undefined,
      money: undefined,
      employee: { ...staff.employee, bank: undefined },
    } as unknown as Parameters<typeof normalizeDetails>[0];
    const safe = normalizeDetails(partial);
    expect(safe.rules).toEqual([]);
    expect(safe.issues).toEqual([]);
    expect(safe.days).toEqual([]);
    expect(safe.advances).toEqual([]);
    expect(safe.history).toEqual([]);
    expect(safe.earnings).toEqual([]);
    expect(safe.deductions).toEqual([]);
    expect(safe.summary).toEqual({});
    expect(safe.issueCounts).toMatchObject({ total: 0 });
    expect(safe.neighbours).toEqual({ previousId: null, nextId: null, position: 1, total: 1 });
    expect(safe.money.net).toBe(0);
    expect(safe.employee.bank).toEqual({ hasAccount: false, bankName: null, hasIfsc: false, accountLast4: null });
  });

  it("leaves a complete answer as it is", () => {
    expect(normalizeDetails(staff)).toMatchObject({ payrollId: 101, issues: staff.issues, rules: staff.rules });
    expect(normalizeDetails(staff).money).toEqual(staff.money);
  });
});
