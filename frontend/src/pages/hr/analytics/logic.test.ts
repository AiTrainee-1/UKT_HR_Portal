import { describe, expect, it } from "vitest";
import { FIXTURE_HODS, FIXTURE_TODAY, fixtureSummary } from "./fixtures";
import {
  addDays,
  againstLimit,
  assignColors,
  buildInsights,
  cardState,
  dataGapNote,
  dayRuns,
  defaultTrendKeys,
  departmentChoices,
  departmentRows,
  distributionRows,
  employeeParams,
  filterWords,
  filtersActive,
  flagChips,
  fromIso,
  fromSearch,
  groupByMonth,
  hoursText,
  humanize,
  inLevel,
  levelCounts,
  matchesQuery,
  mondayOf,
  pageOf,
  patternExtras,
  patternNote,
  presetLabel,
  rangeLabel,
  recordDays,
  resolvePeriod,
  serverParams,
  sortEmployees,
  sortHods,
  sparkPath,
  stateFromUrl,
  stateToUrl,
  thresholdText,
  toSearch,
  topEmployees,
  weekOverWeek,
  weekdayBars,
  weeklyRows,
  type PageState,
} from "./logic";
import type { CategoryMeta, EmployeeHit } from "./types";

// HR Analytics (owner 2026-11-21): the pure rules of the page. Periods, the address, levels, the attention list, the
// insights, the chart rows and the drill-down helpers.

const TODAY = FIXTURE_TODAY; // Saturday 21 Nov 2026

describe("dates", () => {
  it("reads only real days and never shifts them by a time zone", () => {
    expect(fromIso("2026-11-21")?.getDate()).toBe(21);
    expect(fromIso("2026-02-30")).toBeNull();
    expect(fromIso("21/11/2026")).toBeNull();
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("puts a week on Monday to Sunday", () => {
    expect(mondayOf("2026-11-21")).toBe("2026-11-16"); // a Saturday
    expect(mondayOf("2026-11-22")).toBe("2026-11-16"); // the Sunday closes the same week
    expect(mondayOf("2026-11-16")).toBe("2026-11-16");
  });

  it("labels a range like the server does", () => {
    expect(rangeLabel("2026-11-01", "2026-11-21")).toBe("1 Nov - 21 Nov 2026");
    expect(rangeLabel("2025-12-29", "2026-01-04")).toBe("29 Dec 2025 - 4 Jan 2026");
    expect(rangeLabel("2026-11-21", "2026-11-21")).toBe("21 Nov 2026");
  });
});

describe("period presets", () => {
  it("defaults to this month, the 1st up to today", () => {
    expect(resolvePeriod("this_month", "", "", TODAY)).toEqual({
      preset: "this_month",
      from: "2026-11-01",
      to: TODAY,
    });
  });

  it("last month is the whole previous month, across a new year too", () => {
    expect(resolvePeriod("last_month", "", "", TODAY)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(resolvePeriod("last_month", "", "", "2026-01-10")).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("this week runs Monday to today; last week Monday to Sunday", () => {
    expect(resolvePeriod("this_week", "", "", TODAY)).toMatchObject({ from: "2026-11-16", to: TODAY });
    expect(resolvePeriod("last_week", "", "", TODAY)).toMatchObject({ from: "2026-11-09", to: "2026-11-15" });
  });

  it("a picked week is the Monday-Sunday around any day of it, cut at today while it runs", () => {
    expect(resolvePeriod("week", "2026-11-05", "", TODAY)).toEqual({
      preset: "week",
      from: "2026-11-02",
      to: "2026-11-08",
    });
    expect(resolvePeriod("week", "2026-11-20", "", TODAY)).toMatchObject({ from: "2026-11-16", to: TODAY });
    // a week that has not started yet falls back to this week
    expect(resolvePeriod("week", "2026-12-01", "", TODAY)).toMatchObject({ preset: "this_week" });
  });

  it("a picked month is the 1st to the last day, cut at today; a future or bad month falls back", () => {
    expect(resolvePeriod("month", "2026-02-14", "", TODAY)).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(resolvePeriod("month", "2026-11-01", "", TODAY)).toMatchObject({ from: "2026-11-01", to: TODAY });
    expect(resolvePeriod("month", "2027-01-01", "", TODAY).preset).toBe("this_month");
    expect(resolvePeriod("month", "nope", "", TODAY).preset).toBe("this_month");
  });

  it("a custom range is put in order and never runs past today", () => {
    expect(resolvePeriod("custom", "2026-10-31", "2026-08-01", TODAY)).toMatchObject({
      from: "2026-08-01",
      to: "2026-10-31",
    });
    expect(resolvePeriod("custom", "2026-11-10", "2026-12-31", TODAY)).toMatchObject({ to: TODAY });
    expect(resolvePeriod("custom", "2026-11-10", "", TODAY).preset).toBe("this_month");
  });

  it("names the period on its button", () => {
    expect(presetLabel(resolvePeriod("last_week", "", "", TODAY))).toBe("Last week");
    expect(presetLabel(resolvePeriod("month", "2026-10-01", "", TODAY))).toBe("October 2026");
    expect(presetLabel(resolvePeriod("week", "2026-11-11", "", TODAY))).toBe("Week of 9 Nov");
    expect(presetLabel(resolvePeriod("custom", "2026-08-01", "2026-10-31", TODAY))).toBe("Custom range");
  });
});

describe("filters <-> the address", () => {
  const state = (over: Partial<PageState> = {}): PageState => ({
    tab: "staff",
    period: resolvePeriod("this_month", "", "", TODAY),
    dept: null,
    emp: null,
    q: "",
    cat: null,
    person: null,
    ...over,
  });

  it("a fresh page has a clean address", () => {
    expect(toSearch(state())).toBe("");
    expect(fromSearch("", TODAY)).toEqual(state());
  });

  it("every filter and the open drill-downs survive the round trip", () => {
    const s = state({
      tab: "production",
      period: resolvePeriod("custom", "2026-08-01", "2026-10-31", TODAY),
      dept: 11,
      emp: 101,
      q: "murugan",
      cat: "leave",
      person: 101,
    });
    const search = toSearch(s);
    expect(search).toBe(
      "tab=production&period=custom&from=2026-08-01&to=2026-10-31&dept=11&emp=101&q=murugan&cat=leave&person=101",
    );
    expect(fromSearch(search, TODAY)).toEqual(s);
  });

  it("a quick pick keeps no days in the address (a shared 'Last week' is last week when opened)", () => {
    const s = state({ period: resolvePeriod("last_week", "", "", TODAY) });
    expect(toSearch(s)).toBe("period=last_week");
    expect(fromSearch("period=last_week", "2026-12-02").period).toMatchObject({ from: "2026-11-23", to: "2026-11-29" });
  });

  it("a picked week or month keeps its days", () => {
    const week = state({ period: resolvePeriod("week", "2026-11-04", "", TODAY) });
    expect(toSearch(week)).toBe("period=week&from=2026-11-02&to=2026-11-08");
    expect(fromSearch(toSearch(week), TODAY).period).toEqual(week.period);
    const month = state({ period: resolvePeriod("month", "2026-09-10", "", TODAY) });
    expect(toSearch(month)).toBe("period=month&from=2026-09-01&to=2026-09-30");
  });

  it("ignores rubbish in the address", () => {
    const s = fromSearch("tab=other&dept=abc&emp=-4&person=1.5&period=yesterday", TODAY);
    expect(s).toMatchObject({ tab: "staff", dept: null, emp: null, person: null });
    expect(s.period.preset).toBe("this_month");
  });

  it("a patch only touches what it names", () => {
    expect(stateToUrl({ dept: 4 })).toEqual({ dept: "4" });
    expect(stateToUrl({ q: "  sur  " })).toEqual({ q: "sur" });
    expect(stateToUrl({ emp: null, cat: null })).toEqual({ emp: "", cat: "" });
    expect(stateToUrl({ period: resolvePeriod("this_week", "", "", TODAY) })).toEqual({
      period: "this_week",
      from: "",
      to: "",
    });
  });

  it("asks the server with every filter; the employee drill-down only with the tab and the period", () => {
    const s = stateFromUrl({ tab: "staff", dept: "3", emp: "5", q: " surya " }, TODAY);
    expect(serverParams(s)).toEqual({
      type: "staff",
      from: "2026-11-01",
      to: TODAY,
      departmentId: "3",
      employeeId: "5",
      q: "surya",
    });
    expect(employeeParams(s)).toEqual({ type: "staff", from: "2026-11-01", to: TODAY });
    expect(filtersActive(s)).toBe(true);
    expect(filtersActive(state())).toBe(false);
  });

  it("offers a tab's own departments, and keeps a picked one from the other tab visible", () => {
    const options = fixtureSummary("staff").options.departments;
    const staff = departmentChoices(options, "staff", null);
    expect(staff.map((d) => d.label)).toEqual(["Accounts", "HR", "IT", "Merchandising", "Quality"]);
    const kept = departmentChoices(options, "production", 3);
    expect(kept[0]).toEqual({ id: 3, label: "IT (staff department)", foreign: true });
    expect(kept.slice(1).map((d) => d.label)).toEqual(["Cutting", "Ironing", "Packing", "Stitching"]);
  });

  it("puts the filters in words for an export", () => {
    const s = stateFromUrl({ dept: "3", emp: "5", q: "late" }, TODAY);
    expect(filterWords(s, { department: "IT", employee: "SURYA M (30020)" })).toEqual([
      "Department: IT",
      "Employee: SURYA M (30020)",
      'Search: "late"',
    ]);
  });
});

describe("levels and categories", () => {
  const staff = fixtureSummary("staff");
  const cat = (key: string) => staff.categories.find((c) => c.key === key)!;
  const emp = (code: string) => staff.employees.find((e) => e.code === code)!;

  it("the fixture follows the contract: high at twice a limit or 3+ categories, attention, watch", () => {
    expect(emp("30020").level).toBe("high"); // 6 late days, the limit is 3
    expect(emp("30031").level).toBe("high"); // over the limit in 3 categories
    expect(emp("30044").level).toBe("attention");
    expect(emp("30085").level).toBe("watch");
    expect(staff.totals).toEqual({ employeesInScope: 104, employeesWithIssues: 12, needingAttention: 8, high: 3 });
  });

  it("says the limit per month and for the period", () => {
    expect(thresholdText(cat("late"))).toBe("4+ days a month · 3 for this period");
    expect(thresholdText({ thresholdPerMonth: 1, threshold: 1, unit: "days", informational: false })).toBe(
      "1+ days a month",
    );
    const info = fixtureSummary("production").categories.find((c) => c.key === "late_details")!;
    expect(thresholdText(info)).toBe("For reference: never raises a level");
  });

  it("a card is high, attention, calm or reference-only", () => {
    expect(cardState(cat("late"))).toBe("high");
    expect(cardState(cat("on_duty"))).toBe("attention");
    const calm: CategoryMeta = { ...cat("late"), flagged: 0, high: 0 };
    expect(cardState(calm)).toBe("calm");
    expect(cardState({ ...calm, informational: true })).toBe("info");
  });

  it("names the top three of a category, most first", () => {
    expect(topEmployees(staff.employees, "late").map((e) => e.code)).toEqual(["30128", "30020", "30117"]);
  });

  it("lists an employee's categories, those over the limit first", () => {
    const chips = flagChips(emp("30020"), staff.categories);
    expect(chips.map((c) => [c.key, c.count, c.flagged])).toEqual([
      ["late", 6, true],
      ["permissions", 2, false],
    ]);
  });

  it("draws a sparkline inside its box", () => {
    expect(sparkPath([0, 4, 2], 100, 20)).toBe("M0 18 L50 2 L100 10");
    expect(sparkPath([], 100, 20)).toBe("");
    expect(sparkPath([3], 100, 20)).toBe("M0 2 L100 2");
  });

  it("measures a count against its limit (a full bar at twice the limit)", () => {
    expect(againstLimit(3, 3, false)).toMatchObject({ pct: 50, over: true, double: false });
    expect(againstLimit(7, 3, false)).toMatchObject({ pct: 100, over: true, double: true });
    expect(againstLimit(1, 3, false)).toMatchObject({ over: false });
    expect(againstLimit(2, 1, true)).toMatchObject({ pct: 100, over: false });
  });
});

describe("the attention list", () => {
  const list = fixtureSummary("staff").employees;

  it("counts and filters by level", () => {
    expect(levelCounts(list)).toMatchObject({ all: 12, needs: 8, high: 3, attention: 5, watch: 4 });
    expect(list.filter((e) => inLevel(e, "needs")).every((e) => e.level === "high" || e.level === "attention")).toBe(
      true,
    );
  });

  it("searches name, code, designation and department with every word", () => {
    const find = (q: string) => list.filter((e) => matchesQuery(e, q)).map((e) => e.code);
    expect(find("surya")).toEqual(["30020"]);
    expect(find("30031")).toEqual(["30031"]);
    expect(find("merchandiser")).toEqual(expect.arrayContaining(["30044", "30090", "30128"]));
    expect(find("quality inspector")).toEqual(["30063"]);
    expect(find("")).toHaveLength(12);
  });

  it("sorts by score, name, level, last record and departments", () => {
    const by = (key: Parameters<typeof sortEmployees>[1]) => sortEmployees(list, key).map((e) => e.code);
    expect(by({ key: "score", dir: "desc" }).slice(0, 3)).toEqual(["30031", "30044", "30020"]); // 3.33, 2.67, 2.67
    expect(by({ key: "name", dir: "asc" }).slice(0, 2)).toEqual(["30031", "30085"]); // ANITHA R, ARUN P
    const levels = sortEmployees(list, { key: "level", dir: "desc" }).map((e) => e.level);
    expect(levels.indexOf("watch")).toBeGreaterThan(levels.lastIndexOf("attention"));
    expect(levels.lastIndexOf("high")).toBeLessThan(levels.indexOf("attention"));
    expect(sortEmployees(list, { key: "lastDate", dir: "desc" })[0].lastDate).toBe("2026-11-20");
  });

  it("pages 25 at a time", () => {
    const many = Array.from({ length: 60 }, (_, i) => i);
    expect(pageOf(many, 1)).toMatchObject({ page: 1, pages: 3, first: 1, last: 25, total: 60 });
    expect(pageOf(many, 3).rows).toHaveLength(10);
    expect(pageOf(many, 9).page).toBe(3);
    expect(pageOf([], 1)).toMatchObject({ pages: 1, first: 0, last: 0 });
  });
});

describe("insights", () => {
  it("leads with the high ones, then the most common issue, the trend, a department, the HODs and the watch list", () => {
    const ins = buildInsights(fixtureSummary("staff"));
    expect(ins.map((i) => i.id)).toEqual(["high", "top-late", "dept-5", "hods-waiting", "watch"]);
    expect(ins[0]).toMatchObject({ tone: "danger", action: { type: "level", level: "high" } });
    expect(ins[0].detail).toContain("ANITHA R, SURYA M and 1 more");
    expect(ins[2].title).toBe("HR has the largest share flagged");
    expect(ins[1]).toMatchObject({ title: "Frequent late arrival is the most common issue", action: { key: "late" } });
    expect(ins[3].title).toBe("3 requests have waited more than 2 days");
  });

  it("one high employee opens that employee", () => {
    const s = fixtureSummary("staff", { employeeId: 5 });
    expect(buildInsights(s)[0]).toMatchObject({ action: { type: "employee", id: 5 }, actionLabel: "Open" });
  });

  it("says so when nobody has a record", () => {
    const s = fixtureSummary("staff", { q: "nobody-like-this" });
    expect(buildInsights(s)).toEqual([expect.objectContaining({ id: "clear", tone: "success" })]);
  });

  it("compares the last complete week with the one before", () => {
    const s = fixtureSummary("staff");
    expect(weekOverWeek(s.weekly, s.categories, s.period.to)).toMatchObject({ weekStart: "2026-11-09" });
    expect(weekOverWeek(s.weekly.slice(0, 1), s.categories, s.period.to)).toBeNull();
  });
});

describe("chart rows", () => {
  const s = fixtureSummary("staff");

  it("opens the trend on the three busiest counted categories", () => {
    expect(defaultTrendKeys(s.categories)).toEqual(["late", "permissions", "leave"]);
  });

  it("a category keeps its colour while others come and go", () => {
    const first = assignColors(["late", "leave", "permissions"]);
    const next = assignColors(["late", "permissions", "on_duty"], first);
    expect(next.late).toBe(first.late);
    expect(next.permissions).toBe(first.permissions);
    expect(next.on_duty).toBe(first.leave); // the freed colour
  });

  it("weekly rows carry each picked category, 0 when none", () => {
    const rows = weeklyRows(s.weekly, ["late", "night_work"]);
    expect(rows[0]).toMatchObject({ label: "26 Oct", range: "26 Oct - 1 Nov 2026", night_work: 0 });
    expect(rows.reduce((n, r) => n + Number(r.late), 0)).toBe(19);
  });

  it("department and category bars, most flagged first", () => {
    expect(departmentRows(s.departments)[0]).toMatchObject({ name: "Merchandising", flagged: 2, others: 29 });
    const dist = distributionRows(s.categories);
    expect(dist[0]).toMatchObject({ key: "late", high: 2, attention: 1, flagged: 3, affected: 5 });
  });
});

describe("HOD view", () => {
  it("puts the longest wait first and reads hours as people say them", () => {
    expect(sortHods(FIXTURE_HODS, { key: "oldestWaitingHours", dir: "desc" }).map((h) => h.name)).toEqual([
      "M DEVI",
      "R KUMAR",
      "K RAMESH",
      "S PRAKASH",
    ]);
    expect(sortHods(FIXTURE_HODS, { key: "rejectionRate", dir: "desc" })[0].name).toBe("M DEVI");
    expect(hoursText(0.5)).toBe("30 min");
    expect(hoursText(19.5)).toBe("19.5 h");
    expect(hoursText(70.2)).toBe("2.9 days");
    expect(hoursText(null)).toBe("-");
  });
});

describe("drill-down helpers", () => {
  it("draws Monday to Sunday and marks the busiest day", () => {
    const bars = weekdayBars({ byWeekday: { Mon: 4, Wed: 2 } });
    expect(bars.map((b) => b.count)).toEqual([4, 0, 2, 0, 0, 0, 0]);
    expect(bars[0]).toMatchObject({ peak: true, pct: 100 });
    expect(bars[2].pct).toBe(50);
  });

  it("finds a weekday pattern when the server gives no note", () => {
    expect(patternNote({ byWeekday: { Mon: 3, Tue: 1 }, note: null })).toBe("Mostly on Mondays");
    expect(patternNote({ byWeekday: { Mon: 2, Tue: 2 }, note: null })).toBeNull();
    expect(patternNote({ byWeekday: {}, note: "Mostly after holidays" })).toBe("Mostly after holidays");
  });

  it("shows a category's own numbers in words", () => {
    expect(
      patternExtras({
        byWeekday: {},
        longestStreak: 2,
        lastDate: null,
        note: null,
        avgFirstPunch: "09:21",
        nightHours: 23.66,
        nested: { a: 1 },
      }),
    ).toEqual([
      { label: "Avg first punch", value: "09:21" },
      { label: "Night hours", value: "23.7" },
    ]);
    expect(humanize("late_first_punch")).toBe("Late first punch");
  });

  it("writes a record's days and groups a timeline by month, newest first", () => {
    expect(recordDays({ date: "2026-11-03", endDate: "2026-11-06" })).toBe("3 Nov - 6 Nov");
    expect(recordDays({ date: "2026-11-03", endDate: null })).toBe("3 Nov");
    const groups = groupByMonth([{ date: "2026-10-30" }, { date: "2026-11-02" }, { date: "2026-11-20" }]);
    expect(groups.map((g) => [g.month, g.items.length])).toEqual([
      ["November 2026", 2],
      ["October 2026", 1],
    ]);
    expect(groups[0].items[0].date).toBe("2026-11-20");
  });

  it("names the days the devices sent nothing, as runs", () => {
    expect(dayRuns(["2026-11-04", "2026-11-03", "2026-11-11", "bad"])).toEqual([
      { from: "2026-11-03", to: "2026-11-04" },
      { from: "2026-11-11", to: "2026-11-11" },
    ]);
    expect(dataGapNote(["2026-11-03", "2026-11-04", "2026-11-11"])).toBe(
      "3 days left out: no punches arrived from the devices (3 Nov - 4 Nov, 11 Nov)",
    );
    expect(dataGapNote([])).toBeNull();
    const many = ["2026-10-01", "2026-10-03", "2026-10-05", "2026-10-07", "2026-10-09", "2026-10-11"];
    expect(dataGapNote(many)).toContain("and 2 more runs");
  });

  it("an employee hit without a department still searches", () => {
    const e = { name: "X", code: "1", designation: null, department: null } as unknown as EmployeeHit;
    expect(matchesQuery(e, "x")).toBe(true);
  });
});
