import { describe, expect, it } from "vitest";
import {
  allowanceFor,
  allowanceLimit,
  dayWords,
  EXAMPLE_SHIFT,
  exampleDailyRate,
  judgeFirstPunch,
  ladderOrder,
  payForShifts,
  ruleName,
  shiftFor,
  shiftsText,
  type AllowanceValue,
  type ShiftValue,
} from "./preview";

// The seeded defaults.
const ALLOWANCE: AllowanceValue[] = [
  { enabled: true, minExtraMinutes: 60, allowanceMinutes: 30 },
  { enabled: true, minExtraMinutes: 90, allowanceMinutes: 30 },
  { enabled: true, minExtraMinutes: 120, allowanceMinutes: 60 },
  { enabled: true, minExtraMinutes: 150, allowanceMinutes: 60 },
];
const LADDER: ShiftValue[] = [
  { enabled: true, untilMinutes: 1260, shifts: 0.25 },
  { enabled: true, untilMinutes: 1440, shifts: 0.5 },
  { enabled: true, untilMinutes: 1560, shifts: 0.75 },
  { enabled: true, untilMinutes: null, shifts: 1 },
];

describe("Type 1: the allowance a day earns", () => {
  it("is the row with the most extra work the day reaches", () => {
    expect(allowanceFor(45, ALLOWANCE)).toEqual({ minutes: 0, rule: null });
    expect(allowanceFor(59, ALLOWANCE)).toEqual({ minutes: 0, rule: null });
    expect(allowanceFor(60, ALLOWANCE)).toEqual({ minutes: 30, rule: 0 });
    expect(allowanceFor(100, ALLOWANCE)).toEqual({ minutes: 30, rule: 1 });
    expect(allowanceFor(120, ALLOWANCE)).toEqual({ minutes: 60, rule: 2 });
    expect(allowanceFor(150, ALLOWANCE)).toEqual({ minutes: 60, rule: 3 });
    // beyond the last row the last row still holds
    expect(allowanceFor(400, ALLOWANCE)).toEqual({ minutes: 60, rule: 3 });
  });

  it("ignores a row that is switched off, and does not depend on the order of the rows", () => {
    const off = ALLOWANCE.map((r, i) => (i === 2 ? { ...r, enabled: false } : r));
    expect(allowanceFor(125, off)).toEqual({ minutes: 30, rule: 1 });
    const shuffled = [ALLOWANCE[3], ALLOWANCE[0], ALLOWANCE[2], ALLOWANCE[1]];
    expect(allowanceFor(125, shuffled).minutes).toBe(60);
    expect(
      allowanceFor(
        125,
        ALLOWANCE.map((r) => ({ ...r, enabled: false })),
      ),
    ).toEqual({ minutes: 0, rule: null });
    expect(allowanceFor(125, [])).toEqual({ minutes: 0, rule: null });
  });

  it("can give a row an allowance of 0 minutes (it then switches the allowance off for that much work)", () => {
    expect(allowanceFor(90, [{ enabled: true, minExtraMinutes: 60, allowanceMinutes: 0 }])).toEqual({
      minutes: 0,
      rule: 0,
    });
  });

  it("gives nothing beyond where Type 2 starts: MORE than the threshold of extra work is Type 2's", () => {
    expect(allowanceFor(150, ALLOWANCE, 150)).toEqual({ minutes: 60, rule: 3 });
    expect(allowanceFor(151, ALLOWANCE, 150)).toEqual({ minutes: 0, rule: null });
    expect(allowanceFor(400, ALLOWANCE, 150)).toEqual({ minutes: 0, rule: null });
    // a lower threshold: the rows above it can never apply
    expect(allowanceFor(80, ALLOWANCE, 90)).toEqual({ minutes: 30, rule: 0 });
    expect(allowanceFor(100, ALLOWANCE, 90)).toEqual({ minutes: 0, rule: null });
    // without a threshold (an older caller) every amount of extra work still reaches the last row
    expect(allowanceFor(400, ALLOWANCE)).toEqual({ minutes: 60, rule: 3 });
  });

  it("judges the next morning's first punch: on time, inside the allowance, or after it", () => {
    // 9:00 AM shift, 10 minutes' grace, 60 minutes' allowance: not Late up to 10:10 AM
    expect(EXAMPLE_SHIFT).toEqual({ start: 540, end: 1050, grace: 10 });
    expect(allowanceLimit(60)).toBe(610);
    expect(judgeFirstPunch(540, 60)).toBe("on-time");
    expect(judgeFirstPunch(550, 60)).toBe("on-time");
    expect(judgeFirstPunch(551, 60)).toBe("compensation");
    expect(judgeFirstPunch(580, 60)).toBe("compensation");
    expect(judgeFirstPunch(610, 60)).toBe("compensation");
    expect(judgeFirstPunch(611, 60)).toBe("late-rules");
    // no allowance: the usual 9:10 limit
    expect(judgeFirstPunch(550, 0)).toBe("on-time");
    expect(judgeFirstPunch(551, 0)).toBe("late-rules");
  });

  it("takes the shift's own start and grace", () => {
    const shift = { start: 600, end: 1080, grace: 0 };
    expect(allowanceLimit(30, shift)).toBe(630);
    expect(judgeFirstPunch(600, 30, shift)).toBe("on-time");
    expect(judgeFirstPunch(601, 30, shift)).toBe("compensation");
    expect(judgeFirstPunch(631, 30, shift)).toBe("late-rules");
  });

  it("names a row by its own name, or by its extra work when it has none", () => {
    expect(ruleName({ label: "Standard", minExtraMinutes: 60 })).toBe("Standard");
    expect(ruleName({ label: "  ", minExtraMinutes: 90 })).toBe("1 hour 30 minutes");
  });
});

describe("Type 2: the shifts a day earns", () => {
  const END = EXAMPLE_SHIFT.end; // 5:30 PM

  it("needs MORE than the threshold past the shift end; exactly the threshold is still Type 1", () => {
    expect(shiftFor(END + 149, 150, LADDER, END)).toMatchObject({ extra: 149, qualifies: false, shifts: null });
    expect(shiftFor(END + 150, 150, LADDER, END)).toMatchObject({ extra: 150, qualifies: false, shifts: null });
    expect(shiftFor(END + 151, 150, LADDER, END)).toMatchObject({ extra: 151, qualifies: true, shifts: 0.25 });
  });

  it("reads the default ladder: before 9 PM 0.25, before midnight 0.50, before 2 AM 0.75, later 1", () => {
    const at = (minutes: number) => shiftFor(minutes, 150, LADDER, END).shifts;
    expect(at(20 * 60 + 1)).toBe(0.25);
    expect(at(20 * 60 + 30)).toBe(0.25);
    expect(at(20 * 60 + 59)).toBe(0.25);
    // exactly 9 PM belongs to the next row ("21:00 up to 00:00")
    expect(at(21 * 60)).toBe(0.5);
    expect(at(22 * 60 + 30)).toBe(0.5);
    expect(at(24 * 60 - 1)).toBe(0.5);
    // exactly midnight, and anything after it
    expect(at(24 * 60)).toBe(0.75);
    expect(at(24 * 60 + 40)).toBe(0.75);
    expect(at(26 * 60 - 1)).toBe(0.75);
    expect(at(26 * 60)).toBe(1);
    expect(at(27 * 60 + 15)).toBe(1);
    expect(at(40 * 60)).toBe(1);
  });

  it("matches the five punch-outs the example shows", () => {
    const rows = [20 * 60, 20 * 60 + 30, 22 * 60 + 30, 24 * 60 + 40, 27 * 60 + 15].map((p) =>
      shiftFor(p, 150, LADDER, END),
    );
    expect(rows.map((r) => [r.extra, r.qualifies, r.shifts])).toEqual([
      [150, false, null],
      [180, true, 0.25],
      [300, true, 0.5],
      [430, true, 0.75],
      [585, true, 1],
    ]);
  });

  it("follows a different threshold", () => {
    expect(shiftFor(END + 100, 90, LADDER, END)).toMatchObject({ qualifies: true, shifts: 0.25 });
    expect(shiftFor(END + 100, 120, LADDER, END)).toMatchObject({ qualifies: false });
  });

  it("matches nothing after the last limit when no rule is open-ended", () => {
    const finite = LADDER.slice(0, 3);
    expect(shiftFor(26 * 60, 150, finite, END)).toMatchObject({ qualifies: true, shifts: null, row: null });
    expect(shiftFor(25 * 60, 150, finite, END).shifts).toBe(0.75);
  });

  it("skips a row that is switched off and reads the rows in time order whatever the list order", () => {
    const off = LADDER.map((r, i) => (i === 0 ? { ...r, enabled: false } : r));
    expect(shiftFor(20 * 60 + 30, 150, off, END).shifts).toBe(0.5);
    const shuffled = [LADDER[3], LADDER[1], LADDER[0], LADDER[2]];
    expect(ladderOrder(shuffled).map((r) => r.shifts)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(shiftFor(20 * 60 + 30, 150, shuffled, END).shifts).toBe(0.25);
    expect(ladderOrder(LADDER.map((r) => ({ ...r, enabled: false })))).toEqual([]);
  });

  it("returns the position of the matching row among the rows that are on", () => {
    const off = LADDER.map((r, i) => (i === 0 ? { ...r, enabled: false } : r));
    expect(shiftFor(20 * 60 + 30, 150, off, END).row).toBe(0);
    expect(shiftFor(27 * 60, 150, off, END).row).toBe(2);
  });
});

describe("what a shift is worth", () => {
  it("is shifts x the staff daily rate (₹26,000 over 26 days is ₹1,000, as on the other tabs)", () => {
    expect(exampleDailyRate()).toBe(100000);
    expect(payForShifts(0.25)).toBe("₹250.00");
    expect(payForShifts(0.5)).toBe("₹500.00");
    expect(payForShifts(0.75)).toBe("₹750.00");
    expect(payForShifts(1)).toBe("₹1,000.00");
  });

  it("is worded for the screen", () => {
    expect(shiftsText(0.5)).toBe("0.50 shift");
    expect(shiftsText(1)).toBe("1.00 shift");
    expect(dayWords(0.25)).toBe("a quarter of a day");
    expect(dayWords(0.5)).toBe("half a day");
    expect(dayWords(0.75)).toBe("three quarters of a day");
    expect(dayWords(1)).toBe("one whole day");
  });
});
