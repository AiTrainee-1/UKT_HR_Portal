import { describe, expect, it } from "vitest";
import type { ProductionShiftGroup } from "@/lib/api-client/custom-hooks";
import { detectionTimes, ladderRows, shiftSpan, spanLength, timelinePieces, topValue } from "./production-shift-logic";

const rule = (outTime: string, shiftValue: number, outNextDay = false, enabled = true, label = "") => ({
  id: Math.random(),
  label,
  outTime,
  outNextDay,
  shiftValue,
  enabled,
});

const day: ProductionShiftGroup = {
  id: 1,
  label: "Day shift",
  kind: "day",
  appliesOn: "mon_sat",
  startTime: "08:30",
  firstPunchFrom: "06:00",
  firstPunchTo: "16:59",
  mainOutTime: "20:00",
  mainOutNextDay: false,
  enabled: true,
  rules: [
    rule("12:45", 0.5),
    rule("10:30", 0.25),
    rule("05:30", 3, true),
    rule("17:45", 1),
    rule("15:00", 0.6, false, false),
  ],
};

const night: ProductionShiftGroup = {
  ...day,
  id: 2,
  label: "Night shift",
  kind: "night",
  startTime: "21:00",
  firstPunchFrom: "17:00",
  firstPunchTo: "05:59",
  mainOutTime: "06:30",
  mainOutNextDay: true,
  rules: [rule("00:00", 0.5, true), rule("05:30", 1.5, true)],
};

describe("a production shift in plain clock times", () => {
  it("the detection timings follow from the start, the departure and the rules' grace", () => {
    expect(detectionTimes(day, 5)).toEqual({ onTimeUntil: "08:35", earlyOutBefore: "19:55", window: "06:00 – 16:59" });
    expect(detectionTimes(night, 5)).toEqual({
      onTimeUntil: "21:05",
      earlyOutBefore: "06:25 next day",
      window: "17:00 – 05:59",
    });
    expect(detectionTimes({ ...day, mainOutTime: null }, 5).earlyOutBefore).toBeNull();
  });

  it("the Earned Shift table: switched-on rows in time order, next-day rows last, and its top", () => {
    expect(ladderRows(day).map((r) => [r.at, r.value])).toEqual([
      ["10:30", 0.25],
      ["12:45", 0.5],
      ["17:45", 1],
      ["05:30 next day", 3],
    ]);
    expect(topValue(day)).toBe(3);
    expect(topValue(night)).toBe(1.5);
  });

  it("its length and a night shift's two pieces on the 24-hour bar", () => {
    const d = shiftSpan(day);
    expect(spanLength(d.start, d.end)).toBe("11h 30m");
    expect(timelinePieces(d.start, d.end)).toHaveLength(1);
    const n = shiftSpan(night);
    expect(n).toEqual({ start: 21 * 60, end: 30 * 60 + 30 });
    expect(spanLength(n.start, n.end)).toBe("9h 30m");
    const pieces = timelinePieces(n.start, n.end);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].left).toBeCloseTo(87.5);
    expect(pieces[1].left).toBe(0);
  });
});
