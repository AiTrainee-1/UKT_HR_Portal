import { describe, expect, it } from "vitest";
import { areas, heatmap, summary, trend } from "./fixtures";
import {
  MAX_PAGE_SIZE,
  afterHoursSub,
  afterHoursText,
  afterKindText,
  alertTone,
  areaBars,
  ask,
  assistantSummary,
  canShowMore,
  changeText,
  countText,
  daysSinceText,
  deltaOf,
  failedSub,
  feedParams,
  heatmapShape,
  hourLabel,
  hourText,
  nextPageSize,
  peakText,
  peopleSub,
  periodLabel,
  plural,
  previousText,
  severitySub,
  signInsSub,
  sparkOf,
  trendCaption,
  trendRows,
  whenText,
} from "./logic";
import type { ActivityTrend } from "./types";

describe("changes against the previous period", () => {
  it("has no chip without a comparison", () => {
    expect(deltaOf(null, "down")).toBeNull();
  });

  it("colours a change by whether it is good news", () => {
    expect(deltaOf({ abs: 8, pct: 160 }, "down")).toEqual({ text: "+160%", tone: "bad", direction: "up" });
    expect(deltaOf({ abs: -2, pct: -40 }, "down")).toEqual({ text: "-40%", tone: "good", direction: "down" });
    expect(deltaOf({ abs: 8, pct: 160 }, "up")?.tone).toBe("good");
  });

  it("keeps a neutral chip when neither direction is good news (more actions is not good or bad)", () => {
    expect(deltaOf({ abs: 8, pct: 160 }, null)).toEqual({ text: "+160%", tone: "neutral", direction: "up" });
  });

  it("falls back to the absolute change when there was nothing before, and shows flat for no change", () => {
    expect(deltaOf({ abs: 3, pct: null }, null)).toEqual({ text: "+3", tone: "neutral", direction: "up" });
    expect(deltaOf({ abs: 0, pct: null }, "down")).toEqual({ text: "0", tone: "neutral", direction: "flat" });
  });

  it("says a change in words", () => {
    expect(changeText({ abs: 4, pct: 80 })).toBe("+4 (+80%)");
    expect(changeText({ abs: -1, pct: -100 })).toBe("-1 (-100%)");
    expect(changeText({ abs: 33, pct: 33.3 })).toBe("+33 (+33%)");
    expect(changeText({ abs: 1, pct: null })).toBe("+1 (new)");
    expect(changeText({ abs: 0, pct: 0 })).toBe("no change");
    expect(changeText(null)).toBe("—");
  });

  it("names the previous period beside its figure", () => {
    expect(previousText("Previous 7 days", 5)).toBe("Previous 7 days: 5");
    expect(previousText("Previous day", 1234)).toBe("Previous day: 1,234");
  });
});

describe("the headline tiles", () => {
  it("lists the severities that exist, most severe first", () => {
    expect(severitySub({ critical: 1, high: 4, medium: 3 })).toBe("1 critical · 4 high · 3 medium");
    expect(severitySub({ critical: 0, high: 2, medium: 0 })).toBe("2 high");
    expect(severitySub({ critical: 0, high: 0, medium: 0 })).toBe("None in this period");
  });

  it("describes after-hours activity without printing an empty percentage", () => {
    expect(afterHoursSub({ value: 4, sharePct: 30.8, weekend: 1 })).toBe("30.8% of actions · 1 on Sunday");
    expect(afterHoursSub({ value: 4, sharePct: 30.8, weekend: 0 })).toBe("30.8% of actions");
    expect(afterHoursSub({ value: 3, sharePct: null, weekend: 0 })).toBe("Outside working hours");
    expect(afterHoursSub({ value: 0, sharePct: null, weekend: 0 })).toBe("None outside working hours");
  });

  it("describes failed sign-ins by what happened", () => {
    expect(failedSub({ lockouts: 1, blockedAttempts: 1 })).toBe("1 lock-out · 1 blocked try");
    expect(failedSub({ lockouts: 2, blockedAttempts: 3 })).toBe("2 lock-outs · 3 blocked tries");
    expect(failedSub({ lockouts: 0, blockedAttempts: 0 })).toBe("No lock-outs");
  });

  it("words people and accounts in the singular too", () => {
    expect(peopleSub(4)).toBe("of 4 enabled accounts");
    expect(peopleSub(1)).toBe("of 1 enabled account");
    expect(signInsSub(1)).toBe("1 person");
    expect(signInsSub(4)).toBe("4 people");
    expect(plural(1, "try", "tries")).toBe("try");
    expect(plural(2, "action")).toBe("actions");
  });

  it("colours an alert tile by how serious it is", () => {
    expect(alertTone(1, 8)).toBe("red");
    expect(alertTone(0, 3)).toBe("amber");
    expect(alertTone(0, 0)).toBe("green");
  });
});

describe("the trend", () => {
  it("keeps the three series the chart draws", () => {
    const rows = trendRows(trend);
    expect(rows).toHaveLength(7);
    expect(rows[4]).toEqual({ date: "2026-10-02", actions: 4, sensitive: 4, afterHours: 0 });
  });

  it("lends a column of the trend to a sparkline", () => {
    expect(sparkOf(trend, "actions")).toEqual([3, 2, 1, 1, 4, 1, 1]);
    expect(sparkOf(trend, "failedSignIns")).toEqual([0, 2, 3, 1, 0, 0, 0]);
    expect(sparkOf(undefined, "actions")).toBeUndefined();
  });

  it("captions the busiest day and the average", () => {
    expect(trendCaption(trend)).toBe("Busiest day: Fri 02 Oct (4 actions) · 1.9 a day on average");
  });

  it("says when a point is a week, and has nothing to say about an empty period", () => {
    const weekly: ActivityTrend = {
      ...trend,
      granularity: "week",
      busiest: { date: "2026-09-28", end: "2026-10-04", actions: 13 },
    };
    expect(trendCaption(weekly)).toBe(
      "Busiest week: 28 Sep (13 actions) · 1.9 a day on average · each point is a week (Monday to Sunday), named by its first day",
    );
    expect(trendCaption({ ...trend, busiest: null, averagePerDay: null })).toBe("");
    expect(trendCaption({ ...trend, busiest: { date: "2026-10-02", end: "2026-10-02", actions: 1 } })).toContain(
      "(1 action)",
    );
  });
});

describe("the heatmap", () => {
  it("labels the hours the way the portal writes times", () => {
    expect([0, 1, 7, 11, 12, 13, 21, 23].map(hourLabel)).toEqual(["12a", "1a", "7a", "11a", "12p", "1p", "9p", "11p"]);
    expect([0, 9, 12, 16, 23].map(hourText)).toEqual(["12 am", "9 am", "12 pm", "4 pm", "11 pm"]);
  });

  it("leaves a quiet hour blank instead of printing 0", () => {
    const shape = heatmapShape(heatmap);
    expect(shape.rows).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(shape.cols).toHaveLength(24);
    expect(shape.cols[16]).toBe("4p");
    expect(shape.values[4][16]).toBe(3);
    expect(shape.values[0][1]).toBeNull();
    expect(shape.values.flat().filter((v) => v !== null)).toHaveLength(11);
  });

  it("names the busiest cell", () => {
    expect(peakText(heatmap)).toBe("Fri 4 pm (3 actions)");
    expect(peakText({ peak: { weekday: "Mon", hour: 0, count: 1 } })).toBe("Mon 12 am (1 action)");
    expect(peakText({ peak: null })).toBeNull();
  });

  it("explains how much happened outside normal hours", () => {
    expect(afterHoursText(4, 13, 30.8, 1, 3)).toBe(
      "4 of 13 actions (30.8%) were outside working hours: 3 at night, 1 on Sunday.",
    );
    expect(afterHoursText(1, 20, 5, 0, 1)).toBe("1 of 20 actions (5%) was outside working hours: 1 at night.");
    expect(afterHoursText(2, 2, null, 2, 0)).toBe("2 of 2 actions were outside working hours: 2 on Sunday.");
    expect(afterHoursText(0, 5, null, 0, 0)).toBe("Nothing was done outside working hours.");
    expect(afterKindText("weekend")).toBe("Sunday");
    expect(afterKindText("night")).toBe("After hours");
    expect(afterKindText(null)).toBeNull();
  });
});

describe("areas", () => {
  it("turns areas into bars with their share, sensitive count and change", () => {
    const bars = areaBars(areas.areas, false);
    expect(bars.map((b) => [b.key, b.value, b.display])).toEqual([
      ["employees", 9, "9"],
      ["access", 2, "2"],
      ["payroll", 1, "1"],
      ["reports", 1, "1"],
    ]);
    expect(bars[0].sub).toBe("69.2% of actions · 4 sensitive · +4 (+80%) vs before");
    expect(bars[1].sub).toBe("15.4% of actions · 2 sensitive · +2 (new) vs before");
  });

  it("shows the top few until asked for all", () => {
    expect(areaBars(areas.areas, false, 2)).toHaveLength(2);
    expect(areaBars(areas.areas, true, 2)).toHaveLength(4);
  });

  it("leaves 'sensitive' out for an area that has none", () => {
    const quiet = { ...areas.areas[0], sensitive: 0 };
    expect(areaBars([quiet], true)[0].sub).toBe("69.2% of actions · +4 (+80%) vs before");
  });
});

describe("people and time", () => {
  it("writes the server's wall-clock timestamp for a person", () => {
    expect(whenText("2026-10-03T20:59:59")).toBe("Sat 03 Oct, 8:59 pm");
    expect(whenText("2026-10-05T00:00:00")).toBe("Mon 05 Oct, 12:00 am");
    expect(whenText(null)).toBe("—");
  });

  it("says how long ago in words", () => {
    expect(daysSinceText(null)).toBe("Never");
    expect(daysSinceText(0)).toBe("today");
    expect(daysSinceText(1)).toBe("yesterday");
    expect(daysSinceText(64)).toBe("64 days ago");
  });

  it("marks a line that stands for many rows (a bulk upload)", () => {
    expect(countText(1)).toBeNull();
    expect(countText(120)).toBe("× 120");
    expect(countText(1200)).toBe("× 1,200");
  });
});

describe("the sensitive feed", () => {
  it("asks for ten more at a time up to what the server returns in one go", () => {
    expect(nextPageSize(10)).toBe(20);
    expect(nextPageSize(95)).toBe(MAX_PAGE_SIZE);
    expect(nextPageSize(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
  });

  it("offers more only while there is more to show and room to ask", () => {
    expect(canShowMore(25, 10, 10)).toBe(true);
    expect(canShowMore(8, 8, 10)).toBe(false);
    expect(canShowMore(250, 100, 100)).toBe(false);
  });

  it("sends the period, the page and only the filters that are set", () => {
    expect(feedParams({ preset: "last_7_days" }, { pageSize: 10 })).toEqual({
      period: "last_7_days",
      page: 1,
      pageSize: 10,
    });
    expect(
      feedParams({ preset: "last_7_days" }, { pageSize: 20, q: "  anita ", category: "payroll", user: "Babu K" }),
    ).toEqual({ period: "last_7_days", page: 1, pageSize: 20, q: "anita", category: "payroll", user: "Babu K" });
    expect(
      feedParams(
        { preset: "custom", from: "2026-09-01", to: "2026-09-30" },
        { pageSize: 10, q: "   ", category: null, user: null },
      ),
    ).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      page: 1,
      pageSize: 10,
    });
  });
});

describe("the assistant", () => {
  it("names the period in words", () => {
    expect(periodLabel({ preset: "last_30_days" })).toBe("Last 30 days");
    expect(periodLabel({ preset: "custom", from: "2026-09-01", to: "2026-09-30" })).toBe("2026-09-01 to 2026-09-30");
  });

  it("tells it the figures on screen", () => {
    expect(assistantSummary(undefined)).toBeUndefined();
    expect(assistantSummary(summary)).toEqual({
      Actions: 13,
      "Active people": 4,
      "Sensitive actions": 8,
      "Critical or high": 5,
      "After-hours actions": 4,
      "Sign-ins": 7,
      "Failed sign-ins": 6,
      "Lock-outs": 1,
    });
  });

  it("writes a ready-made question about exactly what a card shows", () => {
    expect(ask.page("Last 30 days")).toContain("last 30 days");
    expect(ask.trend("This month")).toContain("this month");
    expect(ask.sensitive("Last 7 days", "Payroll & pay")).toBe(
      "What payroll & pay actions happened over last 7 days, who did them and when?",
    );
    expect(ask.sensitive("Last 7 days")).toContain("sensitive actions");
    expect(ask.attention()).toContain("last 7 days");
    for (const q of [ask.areas("x"), ask.users("x"), ask.heatmap("x"), ask.signIns("x")])
      expect(q.endsWith("?") || q.endsWith(".")).toBe(true);
  });
});
