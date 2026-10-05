import { describe, expect, it } from "vitest";
import { CHART } from "@/components/md/kit/chartTheme";
import {
  EXCEPTIONS,
  EXCEPTIONS_EMPTY,
  OUTPASS,
  SUMMARY,
  SUMMARY_EMPTY,
  TREND,
  TREND_EMPTY,
  VISITORS,
  metric,
} from "./fixtures";
import {
  EMPTY_TEXT,
  KPI_KEYS,
  agingItems,
  assistantContext,
  bannerNotes,
  buildKpis,
  daysAgoText,
  departmentItems,
  dropOffs,
  durationItems,
  exceptionRule,
  exceptionTabs,
  funnelItems,
  hasTrendData,
  heatmapWindow,
  hostDepartmentItems,
  hourHeading,
  hourText,
  metricDelta,
  periodPhrase,
  plural,
  purposeSlices,
  rangeText,
  reasonItems,
  refusalItems,
  stampText,
  trendLabel,
  trendRows,
  waitText,
} from "./logic";

describe("texts", () => {
  it("says how long something waited the way a person would", () => {
    expect(waitText(null)).toBe("—");
    expect(waitText(1)).toBe("1 minute");
    expect(waitText(35)).toBe("35 minutes");
    expect(waitText(60)).toBe("1 hour");
    expect(waitText(300)).toBe("5 hours");
    expect(waitText(47 * 60)).toBe("47 hours"); // still hours under two days
    expect(waitText(48 * 60)).toBe("2 days");
    expect(waitText(51960)).toBe("36 days 2 hours");
    expect(waitText(24 * 60 * 3 + 60)).toBe("3 days 1 hour");
  });

  it("dates a record", () => {
    expect(daysAgoText(0)).toBe("today");
    expect(daysAgoText(1)).toBe("yesterday");
    expect(daysAgoText(6)).toBe("6 days ago");
    expect(stampText("2026-09-22T10:15:00")).toBe("22 Sep · 10:15 am");
    expect(stampText("2026-09-25T19:30:00")).toBe("25 Sep · 7:30 pm");
    expect(stampText(null)).toBe("—");
  });

  it("describes a page of the feed", () => {
    expect(rangeText(1, 25, 312, 25)).toBe("Showing 1–25 of 312");
    expect(rangeText(3, 25, 61, 11)).toBe("Showing 51–61 of 61");
    expect(rangeText(1, 25, 0, 0)).toBe("Nothing to show");
    expect(rangeText(1, 25, 1234, 25)).toBe("Showing 1–25 of 1,234"); // Indian grouping
  });

  it("pluralises", () => {
    expect(plural(1, "visit")).toBe("visit");
    expect(plural(2, "visit")).toBe("visits");
    expect(plural(0, "person", "people")).toBe("people");
  });

  it("puts the period into a sentence for the assistant", () => {
    expect(periodPhrase(undefined)).toBe("in this period");
    expect(periodPhrase({ preset: "last_30_days", label: "Last 30 days", days: 30 })).toBe("in the last 30 days");
    expect(periodPhrase({ preset: "this_month", label: "This month", days: 5 })).toBe("this month");
    expect(periodPhrase({ preset: "month", label: "Sep 2026", days: 30 })).toBe("in Sep 2026");
    expect(periodPhrase({ preset: "custom", label: "01 Sep – 15 Sep 2026", days: 15 })).toBe(
      "between 01 Sep – 15 Sep 2026",
    );
    expect(periodPhrase({ preset: "custom", label: "01 Sep 2026", days: 1 })).toBe("on 01 Sep 2026");
  });
});

describe("banner notes", () => {
  const notes = [
    "Visitors are recorded at check-in only (there is no check-out), so who is inside right now cannot be shown.",
    "The gate form does not ask for a company, so visits cannot be grouped by company.",
    "Today is still in progress, so its figures grow until the end of the day.",
    "Only 35% of the passes that left were scanned back in.",
  ];

  it("keeps what the MD must read and drops the standing limits (they sit beside their figures)", () => {
    expect(bannerNotes(notes, 30)).toEqual(["Only 35% of the passes that left were scanned back in."]);
  });

  it("keeps 'today is in progress' only for a short period", () => {
    expect(bannerNotes(notes, 1)).toEqual([notes[2], notes[3]]);
    expect(bannerNotes(notes, 7)).toContain(notes[2]);
    expect(bannerNotes(notes, 8)).not.toContain(notes[2]);
    expect(bannerNotes(undefined, 7)).toEqual([]);
  });
});

describe("change chips", () => {
  it("colours a change by whether it is good news", () => {
    const down = metricDelta(metric(9, 12), "number", "down");
    expect(down).toEqual({ text: "-25%", tone: "good", direction: "down" });
    const up = metricDelta(metric(12, 9), "number", "down");
    expect(up?.tone).toBe("bad");
    expect(metricDelta(metric(12, 9), "number", null)?.tone).toBe("neutral");
  });

  it("shows percentage points for a rate and a percent change for minutes", () => {
    expect(metricDelta(metric(87.5, 100), "pct", "up")).toEqual({ text: "-12.5 pts", tone: "bad", direction: "down" });
    expect(metricDelta(metric(325, 300), "minutes", "down")?.text).toBe("+8.3%");
  });

  it("has no chip when there is nothing to compare with", () => {
    expect(metricDelta(undefined, "number", null)).toBeNull();
    expect(metricDelta(metric(null, null), "pct", "up")).toBeNull();
    expect(metricDelta(metric(5, null), "number", null)).toBeNull();
  });

  it("falls back to the absolute change when the previous figure was zero", () => {
    expect(metricDelta(metric(3, 0), "number", null)?.text).toBe("+3");
  });
});

describe("the KPI strip", () => {
  const kpis = buildKpis(SUMMARY);
  const by = (key: string) => kpis.find((k) => k.key === key)!;

  it("has the eight cards in order", () => {
    expect(kpis.map((k) => k.key)).toEqual(KPI_KEYS);
  });

  it("writes each figure the way the MD reads it", () => {
    expect(by("visits").value).toBe("11");
    expect(by("visits").sub).toBe("6 unique visitors");
    expect(by("peak").value).toBe("11 am");
    expect(by("peak").sub).toBe("3 visits · busiest day Tue 22 Sep (2)");
    expect(by("outpasses").value).toBe("12");
    expect(by("outpasses").sub).toBe("10 approved · 1 rejected · 1 waiting");
    expect(by("hoursOut").value).toBe("5h 25m");
    expect(by("hoursOut").sub).toBe("46m on average per pass");
    expect(by("returnRate").value).toBe("87.5%");
    expect(by("returnRate").sub).toBe("1 never returned · 1 out now");
    expect(by("waiting").value).toBe("3");
    expect(by("waiting").sub).toBe("2 over 24 hours · oldest 36 days 2 hours");
    expect(by("approvalTime").value).toBe("16m");
    expect(by("approvalTime").sub).toBe("Half were decided within 10m");
    expect(by("rejection").value).toBe("9.1%");
    expect(by("rejection").sub).toBe("1 of 11 decided");
  });

  it("colours the changes by direction: more time out is bad, more returned is good, more visitors is neither", () => {
    expect(by("visits").delta?.tone).toBe("neutral");
    expect(by("outpasses").delta?.tone).toBe("bad"); // 5 -> 12 requests
    expect(by("hoursOut").delta?.tone).toBe("bad"); // 300 -> 325 minutes
    expect(by("returnRate").delta?.tone).toBe("bad"); // 100% -> 87.5%
    expect(by("approvalTime").delta?.tone).toBe("bad"); // 10m -> 16m: slower
    expect(by("rejection").delta?.tone).toBe("neutral");
    expect(by("peak").delta).toBeNull();
    expect(by("waiting").delta).toBeNull(); // a live snapshot has no previous period
  });

  it("flags the approvals queue by how bad it is", () => {
    expect(by("waiting").tone).toBe("red"); // some have waited over a day
    const calm = buildKpis({
      ...SUMMARY,
      outpass: { ...SUMMARY.outpass, waitingNow: { waiting: 2, overOneDay: 0, oldestMinutes: 90 } },
    }).find((k) => k.key === "waiting")!;
    expect(calm.tone).toBe("amber");
    expect(calm.sub).toBe("Oldest 1 hour");
    const none = buildKpis({
      ...SUMMARY,
      outpass: { ...SUMMARY.outpass, waitingNow: { waiting: 0, overOneDay: 0, oldestMinutes: null } },
    }).find((k) => k.key === "waiting")!;
    expect([none.tone, none.sub]).toEqual(["green", "No request is undecided"]);
  });

  it("tones the return rate by how much is scanned back", () => {
    const tone = (rate: number | null) =>
      buildKpis({ ...SUMMARY, outpass: { ...SUMMARY.outpass, returnRatePct: metric(rate, 90) } }).find(
        (k) => k.key === "returnRate",
      )!.tone;
    expect([tone(95), tone(80), tone(40), tone(null)]).toEqual(["green", "amber", "red", "slate"]);
  });

  it("shows dashes, never zeros, where there is nothing to divide", () => {
    const empty = buildKpis(SUMMARY_EMPTY);
    const get = (key: string) => empty.find((k) => k.key === key)!;
    expect(get("visits").value).toBe("0");
    expect(get("peak").value).toBe("—");
    expect(get("peak").sub).toBe("No visits in this period");
    expect(get("hoursOut").value).toBe("—");
    expect(get("hoursOut").sub).toBe("No pass scanned back in yet");
    expect(get("returnRate").value).toBe("—");
    expect(get("approvalTime").value).toBe("—");
    expect(get("rejection").value).toBe("—");
    expect(get("rejection").sub).toBe("Nothing decided yet");
    expect(get("visits").delta?.text).toBe("0"); // zero against zero: flat
  });

  it("explains every card", () => {
    for (const k of kpis) expect(k.provenanceIds.length).toBeGreaterThan(0);
  });
});

describe("trend", () => {
  it("shapes the points for the chart", () => {
    const rows = trendRows(TREND.points);
    expect(rows).toHaveLength(14);
    expect(Object.keys(rows[0]).sort()).toEqual(["gateFormExits", "key", "minutesOut", "passes", "visits"]);
  });

  it("labels days and weeks", () => {
    expect(trendLabel("day")("2026-09-22")).toBe("22 Sep");
    expect(trendLabel("week")("2026-09-21")).toBe("Wk 21 Sep");
  });

  it("knows an empty trend", () => {
    expect(hasTrendData(TREND.points)).toBe(true);
    expect(hasTrendData(TREND_EMPTY.points)).toBe(false);
    expect(hasTrendData(undefined)).toBe(false);
  });
});

describe("visitors", () => {
  it("colours the slices and keeps 'Other' grey", () => {
    const slices = purposeSlices([
      ...VISITORS.purposes.categories,
      { key: "other", label: "Other (not matched)", visits: 2, sharePct: 15.4 },
    ]);
    expect(slices.map((s) => s.value)).toEqual([4, 2, 2, 1, 1, 1, 2]);
    expect(slices.at(-1)?.color).toBe(CHART.slate);
    const others = slices.slice(0, -1).map((s) => s.color);
    expect(others).not.toContain(CHART.slate);
    expect(new Set(others).size).toBe(others.length); // distinct colours
  });

  it("adds a bar for the visits the gate could not match to an employee", () => {
    const items = hostDepartmentItems(VISITORS.hostDepartments, VISITORS.hostsNotLinked);
    expect(items.map((i) => [i.label, i.value])).toEqual([
      ["Stitching", 6],
      ["Accounts", 2],
      ["Not matched to an employee", 3],
    ]);
    expect(items[0].sub).toBe("3 visitors · 55% of visits");
    expect(items[2].color).toBe(CHART.slate);
    expect(hostDepartmentItems([], { visits: 0, sharePct: null })).toEqual([]);
  });

  it("heads the hours of the grid", () => {
    expect([0, 6, 9, 12, 15, 23].map(hourHeading)).toEqual(["12a", "6a", "9a", "12p", "3p", "11p"]);
    expect([0, 6, 11, 12, 14, 23].map(hourText)).toEqual(["12 am", "6 am", "11 am", "12 pm", "2 pm", "11 pm"]);
  });

  it("trims the heatmap to the working day plus any hour that had a visit", () => {
    const grid = heatmapWindow(VISITORS.heatmap!);
    expect(grid.hours[0]).toBe(6); // a visit at 06:45
    expect(grid.hours.at(-1)).toBe(19); // and one at 19:30
    expect(grid.cols[0]).toBe("6a");
    expect(grid.rows).toHaveLength(7);
    expect(grid.values.every((r) => r.length === grid.hours.length)).toBe(true);
    const mon = grid.values[0];
    expect(mon[grid.hours.indexOf(15)]).toBe(1);
    expect(mon[grid.hours.indexOf(10)]).toBeNull(); // no visit: a faint dot, not a dark 0
    expect(
      grid.values
        .flat()
        .filter((v) => v != null)
        .reduce((a, b) => (a ?? 0) + (b ?? 0), 0),
    ).toBe(11);
  });

  it("keeps the working day when nothing happened outside it", () => {
    const quiet = {
      weekdays: VISITORS.heatmap!.weekdays,
      hours: VISITORS.heatmap!.hours,
      values: VISITORS.heatmap!.values.map((r) => r.map((v, h) => (h === 10 ? v : 0))),
      max: 2,
    };
    const grid = heatmapWindow(quiet);
    expect([grid.hours[0], grid.hours.at(-1)]).toEqual([8, 17]);
  });
});

describe("outpasses", () => {
  it("lays the funnel out with each step's share of the requests", () => {
    const items = funnelItems(OUTPASS.funnel);
    expect(items.map((i) => [i.label, i.value, i.sub])).toEqual([
      ["Asked to leave", 12, undefined],
      ["Approved", 10, "83% of requests"],
      ["Left through the gate", 9, "75% of requests"],
      ["Scanned back in", 7, "58% of requests"],
    ]);
    expect(funnelItems({ ...OUTPASS.funnel, requested: 0 })[1].sub).toBeUndefined();
  });

  it("lists only the drop-offs that happened, worst first", () => {
    const list = dropOffs(OUTPASS.funnel);
    expect(list.map((d) => [d.key, d.count, d.tone])).toEqual([
      ["rejected", 1, "neutral"],
      ["waiting", 1, "warn"],
      ["approvedNotUsed", 1, "warn"],
      ["notReturned", 1, "bad"],
      ["earlyDismissal", 1, "neutral"],
    ]);
    expect(
      dropOffs({
        ...OUTPASS.funnel,
        dropOffs: {
          ...OUTPASS.funnel.dropOffs,
          rejected: 0,
          waiting: 0,
          approvedNotUsed: 0,
          notReturned: 0,
          earlyDismissal: 0,
        },
      }),
    ).toEqual([]);
  });

  it("ranks departments by time out and says what is behind each bar", () => {
    const items = departmentItems(OUTPASS.byDepartment, 2);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ label: "Stitching", value: 310, display: "5h 10m" });
    expect(items[0].sub).toBe("8 requests · avg 52m · 266.7 per 100 staff");
    expect(items[1].sub).toBe("2 requests · avg 15m · 200 per 100 staff · 1 never returned");
    const accounts = departmentItems(OUTPASS.byDepartment, 3)[2];
    expect([accounts.value, accounts.display]).toEqual([0, "—"]); // nobody came back: unknown, not zero minutes
  });

  it("describes reasons, durations, queue ages and refusals", () => {
    const reasons = reasonItems(OUTPASS.byReason);
    expect(reasons[1]).toMatchObject({ label: "Personal emergency", value: 8, sub: "2h 10m out · avg 33m" });
    expect(reasons[2].sub).toBe("No pass scanned back in yet");

    const bands = durationItems(OUTPASS.durations.buckets);
    expect(bands.map((b) => b.value)).toEqual([1, 1, 3, 1, 1, 0]);
    expect(bands[2].sub).toBe("43% of returned passes");

    const aging = agingItems(OUTPASS.approvals.aging.buckets);
    expect(aging.map((a) => a.color)).toEqual([CHART.good, CHART.teal, CHART.warn, CHART.bad]);

    const refusals = refusalItems(OUTPASS.gateScans);
    expect(refusals.map((r) => [r.label, r.value])).toEqual([
      ["Pass expired", 1],
      ["Unreadable or invalid QR", 1],
      ["Request not approved", 1],
    ]);
  });
});

describe("exceptions", () => {
  it("counts each tab", () => {
    expect(exceptionTabs(EXCEPTIONS).map((t) => [t.value, t.count])).toEqual([
      ["repeat", 1],
      ["notReturned", 2],
      ["long", 1],
      ["waiting", 2],
      ["afterHours", 2],
    ]);
    expect(exceptionTabs(EXCEPTIONS_EMPTY).every((t) => t.count === 0)).toBe(true);
    expect(exceptionTabs(undefined).every((t) => t.count === undefined)).toBe(true); // still loading: no counts
  });

  it("states the rule behind each tab with the numbers of this period", () => {
    expect(exceptionRule("repeat", EXCEPTIONS)).toContain("3 or more approved outpasses");
    expect(exceptionRule("repeat", EXCEPTIONS)).toContain("3 in 30 days");
    expect(exceptionRule("long", EXCEPTIONS)).toBe(
      "Passes that lasted 2h 00m or more: the longer of 2h 00m and 2× the typical pass (30m).",
    );
    expect(exceptionRule("waiting", EXCEPTIONS)).toContain("after 24 hours");
    expect(exceptionRule("waiting", EXCEPTIONS)).toContain("across all dates");
    expect(exceptionRule("afterHours", EXCEPTIONS)).toContain("before 8:00 am or from 6:00 pm");
    expect(exceptionRule("notReturned", EXCEPTIONS)).toContain("Early-dismissal passes");
    const unknownTypical = {
      ...EXCEPTIONS,
      thresholds: {
        ...EXCEPTIONS.thresholds,
        longOutpass: { ...EXCEPTIONS.thresholds.longOutpass, typicalMinutes: null },
      },
    };
    expect(exceptionRule("long", unknownTypical)).toBe(
      "Passes that lasted 2h 00m or more: the longer of 2h 00m and 2× the typical pass.",
    ); // too few passes to know what is typical
  });

  it("has an honest sentence for every empty tab", () => {
    for (const text of Object.values(EMPTY_TEXT)) expect(text.length).toBeGreaterThan(10);
  });
});

describe("the assistant's view of the page", () => {
  it("publishes the period, the scope and the headline numbers", () => {
    const ctx = assistantContext({
      periodLabel: "Last 30 days",
      scopeText: "Unit 1 · all departments · staff and production",
      summary: SUMMARY,
    });
    expect(ctx.page).toBe("visitors");
    expect(ctx.filters).toEqual({ Period: "Last 30 days", Scope: "Unit 1 · all departments · staff and production" });
    expect(ctx.summary).toMatchObject({
      Visits: 11,
      "Unique visitors": 6,
      "Outpass requests": 12,
      "Time out on outpasses": "5h 25m",
      "Return rate": "87.5%",
      "Never returned": 1,
      "Waiting for approval": 3,
    });
  });

  it("publishes nothing it does not know yet", () => {
    expect(assistantContext({ periodLabel: "", scopeText: "All" }).summary).toBeUndefined();
    const empty = assistantContext({ periodLabel: "x", scopeText: "y", summary: SUMMARY_EMPTY }).summary!;
    expect(empty["Time out on outpasses"]).toBeNull();
    expect(empty["Return rate"]).toBeNull();
  });
});
