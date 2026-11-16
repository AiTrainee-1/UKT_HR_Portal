import { describe, expect, it } from "vitest";
import { SEEDED } from "./fixtures";
import { breakSpans, draftFrom, type ShiftRulesDraft } from "./form";
import {
  barBreaks,
  barOrigin,
  barPercent,
  barTicks,
  breakRangeText,
  breakTotals,
  groupSummary,
  labelsThatFit,
  ladderPoints,
  ladderValueAt,
} from "./summary";

const seeded = () => draftFrom(SEEDED);
function edited(edit: (d: ShiftRulesDraft) => void): ShiftRulesDraft {
  const d = structuredClone(seeded());
  edit(d);
  return d;
}
const summaries = (d: ShiftRulesDraft) => d.groups.map((g, i) => groupSummary(g, d.breaks, i));

describe("production shifts at a glance: each group's hours", () => {
  it("says the Day, Night and Sunday shifts as From / To ranges, with the next day marked", () => {
    const [day, night, sunday] = summaries(seeded());
    expect(day).toMatchObject({
      name: "Day shift",
      days: "Monday – Saturday",
      range: "From 08:30 AM to 08:00 PM",
      length: "11 h 30 min",
      unpaid: 90, // the four day breaks before 8:00 PM
      endSource: "set",
      window: "Punch in between 04:00 AM and 04:59 PM",
      pays: "1.50 shifts by 08:00 PM; up to 3.00 shifts by 05:30 AM next day",
    });
    expect(night).toMatchObject({
      days: "Every day",
      range: "From 09:00 PM to 05:30 AM next day",
      length: "8 h 30 min",
      unpaid: 0,
      window: "Punch in between 05:00 PM and 11:59 PM",
      pays: "1.50 shifts by 05:30 AM next day, the most this shift pays",
    });
    expect(sunday).toMatchObject({
      days: "Sunday",
      range: "From 08:30 AM to 05:00 PM",
      unpaid: 75,
      pays: "1.00 shift by 05:00 PM, the most this shift pays",
    });
  });

  it("works out what an end time between two rows pays, by the paid minute (breaks not counted)", () => {
    // 7:00 PM is halfway through the paid time between 5:45 PM (1.00) and 8:00 PM (1.50): the 5:45-6:00 tea is unpaid
    const [day] = summaries(edited((d) => (d.groups[0].mainOutTime = "19:00")));
    expect(day.range).toBe("From 08:30 AM to 07:00 PM");
    expect(day.pays).toBe("About 1.25 shifts by 07:00 PM; up to 3.00 shifts by 05:30 AM next day");
    // an end after the last row: the most is reached before it
    const [sunday] = summaries(edited((d) => (d.groups[2].mainOutTime = "18:00"))).slice(2);
    expect(sunday.pays).toBe("1.00 shift by 06:00 PM: the most this shift pays, reached at 05:00 PM");
  });

  it("shows a group with no end time up to its last paid leaving time, and says so", () => {
    const [day] = summaries(edited((d) => (d.groups[0].mainOutTime = "")));
    expect(day.endSource).toBe("last");
    expect(day.end).toBe(1770);
    expect(day.range).toBe("From 08:30 AM to 05:30 AM next day");
    expect(day.pays).toBe("Up to 3.00 shifts by 05:30 AM next day");
    // and with no row on either, it has only a start
    const bare = summaries(
      edited((d) => {
        d.groups[2].mainOutTime = "";
        d.groups[2].rules[0].enabled = false;
      }),
    )[2];
    expect(bare.endSource).toBe("none");
    expect(bare.range).toBe("From 08:30 AM");
    expect(bare.length).toBeNull();
    expect(bare.pays).toBe("No paid leaving time is switched on, so a day of this group earns nothing.");
  });

  it("does not trust an end that is not after the start, and says what is missing", () => {
    const [day] = summaries(
      edited((d) => {
        d.groups[0].mainOutTime = "07:00";
      }),
    );
    expect(day.endSource).toBe("none");
    expect(day.range).toBe("From 08:30 AM");
    const [noStart] = summaries(edited((d) => (d.groups[0].startTime = "")));
    expect(noStart.range).toBeNull();
    expect(noStart.pays).toBe("Enter the start time to see what the day pays.");
  });

  it("uses only the rows that are on and readable, in time order", () => {
    const d = edited((x) => {
      x.groups[0].rules[1].enabled = false;
      x.groups[0].rules[2].shiftValue = "";
    });
    expect(ladderPoints(d.groups[0]).map((p) => p.at)).toEqual([630, 1065, 1200, 1350, 1470, 1770]);
  });

  it("values a leaving time like the engine: 0 at the start, a row's own shifts on it, the top after the last row", () => {
    const d = seeded();
    const points = ladderPoints(d.groups[0]);
    const spans = breakSpans(d.breaks);
    expect(ladderValueAt(510, points, spans, 500)).toBe(0);
    expect(ladderValueAt(510, points, spans, 1200)).toBe(1.5);
    expect(ladderValueAt(510, points, spans, 1800)).toBe(3);
    // inside a break the value stays flat: 12:45 to 1:30 PM all earn what 12:45 earns
    expect(ladderValueAt(510, points, spans, 780)).toBeCloseTo(0.5, 10);
  });
});

describe("production shifts at a glance: the breaks", () => {
  it("adds up the breaks that are on, and writes each as a range", () => {
    expect(breakTotals(seeded().breaks)).toEqual({
      count: 5,
      minutes: 150,
      text: "5 breaks, 2 h 30 min unpaid each day",
    });
    expect(breakTotals(edited((d) => (d.breaks[0].enabled = false)).breaks).text).toBe(
      "4 breaks, 2 h 15 min unpaid each day",
    );
    // a break that cannot be read is not counted
    expect(breakTotals(edited((d) => (d.breaks[4].endTime = "")).breaks).text).toBe(
      "4 breaks, 1 h 30 min unpaid each day",
    );
    expect(breakTotals([]).text).toBe("No break is switched on: every minute between a worker's punches is paid");
    expect(breakRangeText(seeded().breaks[1])).toBe("12:45 PM – 01:30 PM");
  });
});

describe("production shifts at a glance: the 24-hour bar", () => {
  it("starts two hours before the shift, on the hour, so the night after it fits", () => {
    expect(barOrigin(510)).toBe(360); // Day: 6 AM to 6 AM
    expect(barOrigin(1260)).toBe(1140); // Night: 7 PM to 7 PM
    expect(barOrigin(60)).toBe(0);
    expect(barOrigin(null)).toBe(0);
    expect(barPercent(360, 360 + 720)).toBe(50);
    expect(barPercent(360, 0)).toBe(0);
    expect(barPercent(360, 9999)).toBe(100);
  });

  it("marks midnight, 6 AM, noon and 6 PM inside the bar", () => {
    expect(barTicks(360).map((t) => t.label)).toEqual(["Noon", "6 PM", "Midnight"]);
    expect(barTicks(1140).map((t) => t.label)).toEqual(["Midnight", "6 AM", "Noon", "6 PM"]);
    expect(barTicks(0).map((t) => t.label)).toEqual(["6 AM", "Noon", "6 PM"]);
  });

  it("draws each break on the shift day and again the morning after, clipped to the bar", () => {
    const spans = breakSpans(seeded().breaks);
    expect(barBreaks(1140, spans)).toEqual([
      [1200, 1260],
      [2070, 2085],
      [2205, 2250],
      [2370, 2385],
      [2505, 2520],
    ]);
    expect(barBreaks(0, spans)).toHaveLength(5);
  });

  it("keeps the labels that fit, and always the last one", () => {
    expect(labelsThatFit([10, 12, 30, 95, 97], 7)).toEqual([true, false, true, false, true]);
    expect(labelsThatFit([], 7)).toEqual([]);
    expect(labelsThatFit([50], 7)).toEqual([true]);
  });
});
