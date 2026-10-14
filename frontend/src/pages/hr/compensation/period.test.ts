import { describe, expect, it } from "vitest";
import { PERIODS, isPeriod, shiftAnchor } from "./period";

// Today / Week / Month: which periods there are and where the arrows step.

describe("the period control", () => {
  it("offers Today, Week and Month", () => {
    expect(PERIODS.map((p) => p.value)).toEqual(["today", "week", "month"]);
    expect(PERIODS.map((p) => p.label)).toEqual(["Today", "Week", "Month"]);
    expect(isPeriod("week")).toBe(true);
    expect(isPeriod("year")).toBe(false);
  });

  it("steps a day, a week or a month", () => {
    expect(shiftAnchor("today", "2026-10-14", -1)).toBe("2026-10-13");
    expect(shiftAnchor("today", "2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftAnchor("week", "2026-10-14", -1)).toBe("2026-10-07");
    expect(shiftAnchor("week", "2026-10-14", 1)).toBe("2026-10-21");
    expect(shiftAnchor("month", "2026-10-14", -1)).toBe("2026-09-14");
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-28");
  });
});
