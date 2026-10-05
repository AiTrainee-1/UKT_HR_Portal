import { describe, expect, it } from "vitest";
import { CHART } from "@/components/md/kit/chartTheme";
import {
  DEFAULT_DIRECTORY,
  assistantContext,
  askQuestions,
  attendanceTone,
  attritionBars,
  bandRows,
  bandTick,
  changeDelta,
  daysBetween,
  directoryFiltersActive,
  directoryParams,
  exitTick,
  groupBars,
  headcountDomain,
  initials,
  kpiTiles,
  movementRows,
  peopleText,
  reasonSlices,
  staffingBars,
  stepLabel,
  typeSlices,
  typeSplitText,
  uniqueNotes,
  whenText,
  yearsText,
} from "./logic";
import { composition, movementMonthly, movementWeekly, summary } from "./testing/fixtures";

describe("changeDelta", () => {
  it("colours a change by whether a rise is good news", () => {
    expect(changeDelta({ abs: 3, pct: 10 }, "count", true)).toEqual({ text: "+3", tone: "good", direction: "up" });
    expect(changeDelta({ abs: 3, pct: 10 }, "count", false)).toEqual({ text: "+3", tone: "bad", direction: "up" });
    expect(changeDelta({ abs: -2, pct: -8 }, "count", false)).toEqual({ text: "-2", tone: "good", direction: "down" });
    expect(changeDelta({ abs: 0, pct: 0 }, "count", true)).toEqual({ text: "0", tone: "neutral", direction: "flat" });
  });

  it("writes percentage points and years with their unit", () => {
    expect(changeDelta({ abs: 39.3, pct: 473.5 }, "pts", false)?.text).toBe("+39.3 pts");
    expect(changeDelta({ abs: -0.4, pct: -5 }, "years", true)?.text).toBe("-0.4 yrs");
  });

  it("says nothing when there is nothing to compare with", () => {
    expect(changeDelta(null, "count", true)).toBeNull();
    expect(changeDelta({ abs: null, pct: null }, "count", true)).toBeNull();
  });
});

describe("kpiTiles", () => {
  it("builds the eight tiles with their comparison and sparklines", () => {
    const tiles = kpiTiles(summary, movementMonthly);
    expect(tiles.map((t) => t.id)).toEqual([
      "headcount",
      "joiners",
      "leavers",
      "net",
      "attrition",
      "tenure",
      "early",
      "people",
    ]);
    const by = Object.fromEntries(tiles.map((t) => [t.id, t]));
    expect(by.headcount.value).toBe("1,240");
    expect(by.headcount.sub).toBe("Staff 310 · Production 930");
    expect(by.headcount.delta).toEqual({ text: "-12", tone: "bad", direction: "down" });
    expect(by.headcount.note).toBe("since 01 Nov");
    expect(by.headcount.spark).toEqual(movementMonthly.points.map((p) => p.headcount));
    expect(by.joiners.value).toBe("165");
    expect(by.joiners.note).toBe("vs previous 339 days");
    expect(by.leavers.delta?.tone).toBe("bad"); // more leavers than before is bad news
    expect(by.leavers.sub).toBe("3 with an approximate exit date");
    expect(by.net.value).toBe("-12");
    expect(by.attrition.value).toBe("14.2%");
    expect(by.attrition.sub).toBe("Of an average 1,246 people"); // 339 days is a year already: no "a year at this pace"
    expect(by.attrition.delta).toEqual({ text: "+2.1 pts", tone: "bad", direction: "up" });
    expect(by.tenure.value).toBe("3.4 yrs");
    expect(by.tenure.sub).toBe("12 without a usable join date");
    expect(by.early.value).toBe("14");
    expect(by.early.sub).toBe("8% of leavers");
    expect(by.people.value).toBe("38%");
    expect(by.people.sub).toBe("Average age 31.2 · gender known for 1,180");
  });

  it("scales a short period up to a year, and says so", () => {
    const quarter = {
      ...summary,
      period: { ...summary.period!, days: 90, preset: "last_90_days", label: "Last 90 days" },
      attrition: { ...summary.attrition, pct: 4.4, annualisedPct: 17.9 },
    };
    const tile = kpiTiles(quarter).find((t) => t.id === "attrition")!;
    expect(tile.value).toBe("4.4%");
    expect(tile.sub).toBe("About 18% a year at this pace");
  });

  it("shows today's headcount without a change chip when the period stops before today", () => {
    const old = { ...summary, period: { ...summary.period!, end: "2026-09-30" } };
    const hc = kpiTiles(old, undefined).find((t) => t.id === "headcount")!;
    expect(hc.delta).toBeNull();
    expect(hc.note).toBeUndefined();
    expect(hc.spark).toBeUndefined(); // no movement loaded yet
  });

  it("never shows 0 for what has no data", () => {
    const empty = {
      ...summary,
      attrition: { pct: null, annualisedPct: null, averageHeadcount: null, previousPct: null, change: null },
      tenure: { averageYears: null, previousYears: null, change: null, unknown: 0 },
      gender: { male: 0, female: 0, other: 0, unspecified: 0, recorded: 0, femalePct: null },
      age: { average: null, known: 0 },
      earlyAttrition: { count: 0, pctOfLeavers: null, previous: 0, change: null },
    };
    const by = Object.fromEntries(kpiTiles(empty).map((t) => [t.id, t]));
    expect(by.attrition.value).toBe("—");
    expect(by.attrition.sub).toBe("No headcount in this period");
    expect(by.tenure.value).toBe("—");
    expect(by.people.value).toBe("—");
    expect(by.early.sub).toBe("No leavers in this period");
    expect(by.early.value).toBe("0"); // a count of nobody is a real zero
  });
});

describe("movement chart rows", () => {
  it("labels months by name, with the year only when the chart spans years", () => {
    const sameYear = movementRows({ ...movementMonthly, points: movementMonthly.points.slice(2, 5) });
    expect(sameYear.map((r) => r.label)).toEqual(["Jan", "Feb", "Mar"]);
    const rows = movementRows(movementMonthly);
    expect(rows[0].label).toBe("Nov 25");
    expect(rows[2].label).toBe("Jan 26");
    expect(new Set(rows.map((r) => r.label)).size).toBe(rows.length); // unique, which the chart library needs
    expect(rows[0]).toEqual({ label: "Nov 25", joiners: 7, leavers: 9, headcount: 1250 });
  });

  it("labels week and day steps by their first day", () => {
    const rows = movementRows(movementWeekly);
    expect(rows.map((r) => r.label)).toEqual(["06 Sep", "13 Sep", "20 Sep"]);
    expect(stepLabel(movementWeekly.points[0], "day", false)).toBe("06 Sep");
  });
});

describe("bands and groups", () => {
  it("drops an empty 'not recorded' band but keeps empty real bands", () => {
    const rows = bandRows([
      { label: "Under 18", count: 0, pct: 0 },
      { label: "18-25", count: 10, pct: 50 },
      { label: "Not recorded", count: 0, pct: 0 },
    ]);
    expect(rows).toEqual([
      { label: "Under 18", count: 0 },
      { label: "18-25", count: 10 },
    ]);
    expect(bandRows([{ label: "Not known", count: 3, pct: 5 }])).toHaveLength(1);
  });

  it("shortens the axis text of bands so five columns fit a third of the page", () => {
    expect(bandTick("Under 1 year")).toBe("<1 yr");
    expect(bandTick("1-3 years")).toBe("1-3 yrs");
    expect(bandTick("10+ years")).toBe("10+ yrs");
    expect(bandTick("18-25")).toBe("18-25");
    expect(bandTick("Not recorded")).toBe("Unknown");
    expect(bandTick("Not known")).toBe("Unknown");
    expect(exitTick("Within 90 days")).toBe("≤90 days");
    expect(exitTick("3-12 months")).toBe("3-12 mo");
    expect(exitTick("5+ years")).toBe("5+ yrs");
  });

  it("gives the headcount line room above and below, never below zero", () => {
    expect(headcountDomain([])).toBeUndefined();
    expect(headcountDomain([{ headcount: 1240 }, { headcount: 1252 }, { headcount: 1233 }])).toEqual([1223, 1262]);
    expect(headcountDomain([{ headcount: 1000 }, { headcount: 1000 }])).toEqual([997, 1003]); // flat: still a visible line
    expect(headcountDomain([{ headcount: 2 }, { headcount: 5 }])).toEqual([0, 8]);
  });

  it("colours staff and production and sizes the slices by head count", () => {
    const slices = typeSlices(composition.byType);
    expect(slices).toEqual([
      { name: "Staff", value: 310, color: CHART.brand },
      { name: "Production", value: 930, color: CHART.warn },
    ]);
  });

  it("makes ranked people bars with the share, and the Other row grey", () => {
    const bars = groupBars(composition.byDepartment, typeSplitText);
    expect(bars[0]).toMatchObject({ label: "Stitching (Unit 1)", value: 410, display: "410 · 33%" });
    expect(bars[0].sub).toBe("10 staff · 400 production");
    expect(bars[bars.length - 1]).toMatchObject({ label: "Other (4)", color: CHART.slate });
    expect(typeSplitText({ id: 1, label: "x", count: 1, pct: 1 })).toBeUndefined();
  });

  it("reads reasons as a donut with the vague ones in grey", () => {
    const slices = reasonSlices([
      { key: "better_pay", label: "Better pay or opportunity", count: 5, pct: 50 },
      { key: "other", label: "Other reasons", count: 3, pct: 30 },
      { key: "none", label: "No reason recorded", count: 2, pct: 20 },
    ]);
    expect(slices[0].color).toBe(CHART.series[0]);
    expect(slices[1].color).toBe(CHART.slate);
    expect(slices[2].color).toBe("#cbd5e1");
  });
});

describe("attrition and staffing bars", () => {
  it("shows the rate, who left out of how many, and flags hot-spots in red", () => {
    const bars = attritionBars([
      {
        id: 1,
        label: "Stitching (Unit 1)",
        leavers: 18,
        averageHeadcount: 62.5,
        attritionPct: 28.8,
        opening: 70,
        closing: 55,
        hotspot: true,
      },
      { id: 2, label: "Cutting", leavers: 1, averageHeadcount: 40, attritionPct: 2.5, opening: 41, closing: 39 },
      {
        id: 3,
        label: "Empty dept",
        leavers: 2,
        averageHeadcount: null,
        attritionPct: null,
        opening: null,
        closing: null,
      },
    ]);
    expect(bars[0]).toMatchObject({
      label: "Stitching (Unit 1) · hot-spot",
      value: 28.8,
      display: "28.8%",
      sub: "18 left · average 63 people",
      color: CHART.bad,
    });
    expect(bars[1].color).toBeUndefined();
    expect(bars[2]).toMatchObject({ value: 0, display: "—", sub: "2 left" });
  });

  it("colours the planned-vs-actual fill by how far short a department is", () => {
    const bars = staffingBars([
      { departmentId: 1, label: "Accounts", unit: null, required: 10, actual: 6, gap: 4, fillPct: 60 },
      { departmentId: 2, label: "Cutting", unit: null, required: 10, actual: 9, gap: 1, fillPct: 90 },
      { departmentId: 3, label: "Stores", unit: null, required: 4, actual: 4, gap: 0, fillPct: 100 },
      { departmentId: 4, label: "HR", unit: null, required: 3, actual: 4, gap: -1, fillPct: 133.3 },
    ]);
    expect(bars.map((b) => b.color)).toEqual([CHART.bad, CHART.warn, CHART.good, CHART.good]);
    expect(bars[0]).toMatchObject({ value: 60, display: "6 of 10", sub: "4 short · 60% filled" });
    expect(bars[2].sub).toBe("Fully staffed");
    expect(bars[3]).toMatchObject({ value: 100, sub: "1 over plan" }); // a full bar is never more than full
  });
});

describe("text helpers", () => {
  it("counts people and years in the singular and the plural", () => {
    expect(peopleText(1)).toBe("1 person");
    expect(peopleText(1234)).toBe("1,234 people");
    expect(yearsText(1)).toBe("1 year");
    expect(yearsText(7)).toBe("7 years");
  });

  it("says when a date is, looking ahead", () => {
    expect(daysBetween("2026-10-05", "2026-10-12")).toBe(7);
    expect(daysBetween("2026-12-30", "2027-01-02")).toBe(3); // across a year end
    expect(whenText("2026-10-05", "2026-10-05")).toBe("Today");
    expect(whenText("2026-10-06", "2026-10-05")).toBe("Tomorrow");
    expect(whenText("2026-10-12", "2026-10-05")).toBe("In 7 days");
    expect(whenText("2026-10-03", "2026-10-05")).toBe("2 days ago");
  });

  it("makes initials from the first and last word of a name", () => {
    expect(initials("Anita Raman")).toBe("AR");
    expect(initials("  anita   kumari  raman ")).toBe("AR");
    expect(initials("Madonna")).toBe("M");
    expect(initials("")).toBe("?");
  });

  it("merges server notes without repeating one", () => {
    expect(uniqueNotes(["a", "b"], undefined, ["b", "c"], [])).toEqual(["a", "b", "c"]);
  });

  it("grades attendance", () => {
    expect(attendanceTone(null)).toBe("none");
    expect(attendanceTone(97)).toBe("good");
    expect(attendanceTone(95)).toBe("good");
    expect(attendanceTone(90)).toBe("warn");
    expect(attendanceTone(70)).toBe("bad");
  });
});

describe("directory parameters", () => {
  it("sends only what differs from the defaults", () => {
    expect(directoryParams(DEFAULT_DIRECTORY)).toEqual({ page: 1, pageSize: 10 });
    expect(
      directoryParams({
        ...DEFAULT_DIRECTORY,
        q: "  anita ",
        status: "all",
        designation: "Operator",
        sort: "joined",
        dir: "desc",
        page: 3,
      }),
    ).toEqual({
      page: 3,
      pageSize: 10,
      q: "anita",
      status: "all",
      designation: "Operator",
      sort: "joined",
      dir: "desc",
    });
  });

  it("knows when a filter is on (so 'clear' can be offered)", () => {
    expect(directoryFiltersActive(DEFAULT_DIRECTORY)).toBe(false);
    expect(directoryFiltersActive({ ...DEFAULT_DIRECTORY, q: "x" })).toBe(true);
    expect(directoryFiltersActive({ ...DEFAULT_DIRECTORY, status: "inactive" })).toBe(true);
    expect(directoryFiltersActive({ ...DEFAULT_DIRECTORY, sort: "code" })).toBe(false); // sorting is not filtering
  });
});

describe("what the assistant is told", () => {
  it("names the period and the scope in every question", () => {
    const q = askQuestions("Last 12 months", "Unit 1 · all departments · staff and production");
    expect(q.attrition).toContain("last 12 months");
    expect(q.attrition).toContain("Unit 1");
    expect(q.person("Anita Raman", "A1")).toContain("Anita Raman (A1)");
    const all = [q.attention, q.mix, q.units, q.departments, q.service, q.age, q.designations, q.staffing];
    for (const text of [...all, q.movement, q.attrition, q.tenure, q.reasons, q.early, q.milestones, q.directory]) {
      expect(text.length).toBeGreaterThan(30);
    }
  });

  it("publishes the headline numbers on screen", () => {
    const ctx = assistantContext(summary, "Last 12 months", "All units");
    expect(ctx.page).toBe("employees");
    expect(ctx.filters).toEqual({ Period: "Last 12 months", Scope: "All units" });
    expect(ctx.summary).toMatchObject({ "Active headcount": 1240, Joiners: 165, Leavers: 177, "Attrition %": 14.2 });
    expect(assistantContext(undefined, "x", "y").summary).toBeUndefined();
  });
});
