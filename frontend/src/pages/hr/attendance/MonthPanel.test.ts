import { describe, expect, it } from "vitest";
import { monthFigures, offDayLabel } from "./MonthPanel";

const point = (date: string, present: number, absent: number, offDay: string | null = null) => ({
  date,
  day: Number(date.slice(8)),
  label: String(Number(date.slice(8))),
  present,
  absent,
  offDay,
});

describe("offDayLabel", () => {
  it("names Sundays and holidays, and nothing else", () => {
    const holidays = new Map([["2026-11-09", "Deepavali"]]);
    expect(offDayLabel("2026-11-01", holidays)).toBe("Sunday");
    expect(offDayLabel("2026-11-02", holidays)).toBeNull();
    expect(offDayLabel("2026-11-09", holidays)).toBe("Deepavali");
  });

  it("names a holiday that falls on a Sunday by the holiday", () => {
    expect(offDayLabel("2026-11-08", new Map([["2026-11-08", "Founders' Day"]]))).toBe("Founders' Day");
  });
});

describe("monthFigures", () => {
  it("leaves Sundays and holidays out of the average, best and lowest day", () => {
    const figures = monthFigures([
      point("2026-11-01", 6, 40, "Sunday"),
      point("2026-11-02", 38, 8),
      point("2026-11-03", 34, 12),
      point("2026-11-04", 36, 10),
    ]);
    expect(figures).not.toBeNull();
    expect(figures?.avg).toBe(36);
    expect(figures?.best.date).toBe("2026-11-02");
    expect(figures?.low.date).toBe("2026-11-03");
    expect(figures?.workingDays).toBe(3);
  });

  it("has no figures when the month so far is only days off", () => {
    expect(monthFigures([point("2026-11-01", 2, 44, "Sunday")])).toBeNull();
  });
});
