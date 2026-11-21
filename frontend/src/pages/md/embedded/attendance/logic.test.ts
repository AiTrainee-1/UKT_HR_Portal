import { describe, expect, it } from "vitest";
import { dayDetail, dayTone } from "./DrillSheet";
import { INSIGHTS_SUMMARY } from "./fixtures";
import { assistantContext, boardSentence, personLine, TILES, tileDelta, tileQuestion, tileValue } from "./logic";

const metric = (value: number | null, abs: number | null, good: "up" | "down" | null) => ({
  value,
  previous: null,
  delta: abs == null ? null : { abs, pct: null },
  good,
  spark: null,
});

describe("attendance insights logic", () => {
  it("shows the new figures as counts and shifts", () => {
    expect(tileValue("shiftsEarned", metric(3, null, null))).toBe("3.00");
    expect(tileValue("quarterDays", metric(2, null, "down"))).toBe("2");
    expect(tileValue("penaltyEarlyOuts", null)).toBe("—");
    expect(tileValue("attendancePct", metric(75.9, null, "up"))).toBe("75.9%");
  });

  it("colours a change by the figure's good direction", () => {
    expect(tileDelta("quarterDays", metric(2, 2, "down"))).toEqual({ text: "+2", tone: "bad", direction: "up" });
    expect(tileDelta("quarterDays", metric(1, -1, "down"))).toEqual({ text: "-1", tone: "good", direction: "down" });
    expect(tileDelta("shiftsEarned", metric(3, 0.5, null))).toEqual({
      text: "+0.50",
      tone: "neutral",
      direction: "up",
    });
    expect(tileDelta("shiftsEarned", metric(3, null, null))).toBeNull();
  });

  it("every figure with people behind it says which list it opens", () => {
    const drills = Object.fromEntries(TILES.map((t) => [t.key, t.drill ?? null]));
    expect(drills).toMatchObject({
      attendancePct: "absent",
      latePct: "late",
      quarterDays: "quarter",
      penaltyEarlyOuts: "penalty",
      halfDays: "half",
      shiftsEarned: "worked",
      overtimeHours: null,
    });
  });

  it("words today's cards and a person row", () => {
    expect(boardSentence({ present: 220, onDuty: 8, onLeave: 10, cl: 4, leaveApplied: 3, absent: 17 }, 262)).toBe(
      "228 of 262 working (87%)",
    );
    expect(boardSentence(undefined, 0)).toBe("Nobody is scheduled today.");
    expect(personLine(3, 33.3)).toBe("3 days · 33.3% attendance");
    expect(personLine(1, null, 40)).toBe("1 day · 40m late on average");
  });

  it("tells the assistant the page, the filters and the figures", () => {
    const ctx = assistantContext("production", INSIGHTS_SUMMARY, "Sep 2026", "All units");
    expect(ctx.page).toBe("attendance-production");
    expect(ctx.filters).toMatchObject({ Period: "Sep 2026", Employees: "production workers" });
    expect(ctx.summary).toMatchObject({ "Shifts earned": "3.00", "Data-gap days left out": 1 });
    const tile = TILES.find((t) => t.key === "penaltyEarlyOuts")!;
    expect(tileQuestion(tile, "staff", "Sep 2026", "2")).toContain("2 Penalty Early Outs among staff");
  });

  it("explains a day in the person's list", () => {
    const day = {
      date: "2026-09-08",
      label: "Present",
      scheduled: true,
      late: true,
      lateMinutes: 40,
      quarterOff: true,
      firstPunch: "09:40",
      lastPunch: "18:00",
      source: "Biometric",
    };
    expect(dayDetail(day)).toBe("09:40–18:00 · late 40 min · 0.25 off (after the Late window) · Biometric");
    expect(dayTone(day)).toBe("md-analytics-tone-watch");
    expect(dayTone({ date: "x", label: "Absent", scheduled: true })).toBe("md-analytics-tone-bad");
    expect(dayDetail({ date: "x", label: "Absent", scheduled: true, dataGap: true })).toBe(
      "no punches arrived that day",
    );
  });
});
