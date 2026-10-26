import { describe, expect, it } from "vitest";
import {
  addMinutes,
  bonusFor,
  divRoundHalfEven,
  divRoundHalfUp,
  formatPaise,
  fyLabelFor,
  fyMonths,
  NO_CYCLE_MONTHLY_FACTOR,
  ordinal,
  overtimeFor,
  payDayStatus,
  productionPay,
  staffFullMonthBasic,
  staffPay,
} from "./preview";

// Expected figures are the ones the settings inventory computed with the engine's own formulas (Decimal, ROUND_HALF_UP):
// shared samples are a ₹20,000 staff salary over 26 working days and ₹600 per production shift. PF and ESI are not worked
// out here any more: their rules, and their worked examples, are on the PF & ESI tab (./pf-esi/preview.test.ts).

const STAFF = { salary: 20_000, workingDays: 26 };
const PRODUCTION = { ratePerShift: 600 };

describe("rounding", () => {
  it("rounds half away from zero like Decimal ROUND_HALF_UP, and half to even like quantize", () => {
    expect([divRoundHalfUp(5, 2), divRoundHalfUp(4, 2), divRoundHalfUp(-5, 2), divRoundHalfUp(1, 3)]).toEqual([
      3, 2, -3, 0,
    ]);
    expect([divRoundHalfEven(5, 2), divRoundHalfEven(7, 2), divRoundHalfEven(6, 4), divRoundHalfEven(11, 4)]).toEqual([
      2, 4, 2, 3,
    ]);
  });

  it("prints rupees with Indian grouping", () => {
    expect(formatPaise(25_620_000)).toBe("₹2,56,200.00");
    expect(formatPaise(-15_000)).toBe("-₹150.00");
    expect(formatPaise(7)).toBe("₹0.07");
  });
});

describe("staff payslip pay", () => {
  it("₹20,000 full month: pay 20,000.00, Basic 10,000.00, HRA 4,000.00, net 20,000.00 (nothing deducted here)", () => {
    const pay = staffPay({ ...STAFF, daysPaid: 26 });
    expect([pay.gross, pay.basic, pay.hra, pay.net]).toEqual([2_000_000, 1_000_000, 400_000, 2_000_000]);
    expect(Object.keys(pay).sort()).toEqual(["basic", "dailyRate", "gross", "hra", "net", "ot"]);
  });

  it("24 of 26 days: pay 18,461.54, Basic 9,230.77", () => {
    const pay = staffPay({ ...STAFF, daysPaid: 24 });
    expect([pay.gross, pay.basic]).toEqual([1_846_154, 923_077]);
  });

  it("OT pay: 2 announced days x 769.23 = 1,538.46, net 21,538.46; none while the features are off", () => {
    const on = staffPay({ ...STAFF, daysPaid: 26, otDays: 2, otOn: true });
    expect([on.dailyRate, on.ot, on.net]).toEqual([76_923, 153_846, 2_153_846]);
    const off = staffPay({ ...STAFF, daysPaid: 26, otDays: 2, otOn: false });
    expect([off.ot, off.net]).toEqual([0, 2_000_000]);
  });

  it("a fully paid month's Basic is half the salary", () => {
    expect([staffFullMonthBasic(20_000), staffFullMonthBasic(42_002)]).toEqual([10_000, 21_001]);
  });
});

describe("production payslip pay", () => {
  it("16 shifts x 600 = 9,600; the monthly estimate has no cycle's factor yet (x 2)", () => {
    const pay = productionPay({ ...PRODUCTION, shifts: 16 });
    expect([pay.gross, pay.monthlyEstimate, pay.net]).toEqual([960_000, 1_920_000, 960_000]);
    expect(Object.keys(pay).sort()).toEqual(["gross", "latePenalty", "monthlyEstimate", "net"]);
  });

  it("20.5 shifts = 12,300 (quarter shifts keep their paisa)", () => {
    expect(productionPay({ ...PRODUCTION, shifts: 20.5 }).gross).toBe(1_230_000);
    expect(productionPay({ ratePerShift: 333.33, shifts: 0.25 }).gross).toBe(8_333);
  });

  it("the late penalty comes off take-home pay, not off the shifts earned", () => {
    const pay = productionPay({ ...PRODUCTION, shifts: 20.5, latePenalty: 15_000 });
    expect([pay.gross, pay.net]).toEqual([1_230_000, 1_215_000]);
  });
});

describe("estimated monthly pay follows the pay cycle", () => {
  it("is the period pay x 4 on Weekly, x 2 on BiWeekly, x 1 on Monthly, and x 2 with no cycle", () => {
    // six shifts x 600 = 3,600 of pay in the period
    const estimate = (monthlyFactor?: number) =>
      productionPay({ ...PRODUCTION, shifts: 6, monthlyFactor }).monthlyEstimate;
    expect([estimate(4), estimate(2), estimate(1), estimate()]).toEqual([1_440_000, 720_000, 360_000, 720_000]);
    expect(NO_CYCLE_MONTHLY_FACTOR).toBe(2);
  });
});

describe("statutory bonus", () => {
  const year = (basic: number) => Array.from({ length: 12 }, () => basic);
  const base = { wageCeiling: 7_000, eligibilityCeiling: 21_000, percent: 8.33 };

  it("₹20,000 staff (Basic 10,000) x 12 slips: base 12 x 7,000 = 84,000 -> 6,997.20; at 20% -> 16,800.00", () => {
    expect(bonusFor({ ...base, slipBasics: year(10_000) })).toEqual({
      base: 8_400_000,
      monthlyWage: 1_000_000,
      eligible: true,
      amount: 699_720,
    });
    expect(bonusFor({ ...base, percent: 20, slipBasics: year(10_000) }).amount).toBe(1_680_000);
  });

  it("₹12,000 staff (Basic 6,000): base 72,000 -> 5,997.60; ceiling 21,000 on Basic 10,000 -> 9,996.00", () => {
    expect(bonusFor({ ...base, slipBasics: year(6_000) }).amount).toBe(599_760);
    const raised = bonusFor({ ...base, wageCeiling: 21_000, slipBasics: year(10_000) });
    expect([raised.base, raised.amount]).toEqual([12_000_000, 999_600]);
  });

  it("eligibility compares the latest slip's Basic (at or below): salary 42,000 yes, 42,002 no", () => {
    expect(bonusFor({ ...base, slipBasics: [staffFullMonthBasic(42_000)] }).eligible).toBe(true);
    expect(bonusFor({ ...base, slipBasics: [staffFullMonthBasic(42_002)] }).eligible).toBe(false);
    // A production slip's Basic is the whole period pay.
    expect(bonusFor({ ...base, slipBasics: [24_600] }).eligible).toBe(false);
    expect(bonusFor({ ...base, slipBasics: [9_600] }).eligible).toBe(true);
    expect(bonusFor({ ...base, slipBasics: [], profileSalary: 0 }).eligible).toBe(false);
  });

  it("the amount is rounded half to even, like Decimal.quantize", () => {
    expect(bonusFor({ ...base, percent: 10, slipBasics: [0.05] }).amount).toBe(0);
    expect(bonusFor({ ...base, percent: 10, slipBasics: [0.15] }).amount).toBe(2);
  });
});

describe("financial year", () => {
  it("start month 4: 12 Oct 2026 is in 2026-27 = Apr 2026 to Mar 2027", () => {
    expect(fyLabelFor(2026, 10, 4)).toBe("2026-27");
    expect(fyLabelFor(2026, 3, 4)).toBe("2025-26");
    const months = fyMonths("2026-27", 4);
    expect([months[0], months[11]]).toEqual([
      { year: 2026, month: 4 },
      { year: 2027, month: 3 },
    ]);
  });

  it("start month 1: the months are Jan-Dec 2026 but the label is still 2026-27", () => {
    expect(fyLabelFor(2026, 10, 1)).toBe("2026-27");
    const months = fyMonths("2026-27", 1);
    expect([months[0], months[11]]).toEqual([
      { year: 2026, month: 1 },
      { year: 2026, month: 12 },
    ]);
  });
});

describe("overtime", () => {
  it("shift ends 17:30, threshold 60: 18:29 is not OT, 18:30 is, 19:45 is 135 minutes", () => {
    expect(overtimeFor("18:29", "17:30", 60)).toEqual({ minutes: 59, threshold: 60, flagged: false });
    expect(overtimeFor("18:30", "17:30", 60)).toEqual({ minutes: 60, threshold: 60, flagged: true });
    expect(overtimeFor("19:45", "17:30", 60).minutes).toBe(135);
    expect(overtimeFor("18:29:59", "17:30", 60).flagged).toBe(false);
    expect(overtimeFor("17:00", "17:30", 60).minutes).toBe(0);
  });

  it("a threshold of 0 behaves as 60", () => {
    expect(overtimeFor("17:45", "17:30", 0)).toEqual({ minutes: 15, threshold: 60, flagged: false });
  });

  it("builds example clock times", () => {
    expect([addMinutes("17:30", 59), addMinutes("17:30", 135), addMinutes("23:30", 45)]).toEqual([
      "18:29",
      "19:45",
      "00:15",
    ]);
  });
});

describe("salary pay day", () => {
  it("pay day 5: September's salary is due 5 Oct; 7 days past is a warning, 8 is critical", () => {
    const on12 = payDayStatus(5, { year: 2026, month: 10, day: 12 });
    expect(on12).toEqual({
      payDay: 5,
      salaryMonth: { year: 2026, month: 9 },
      due: { year: 2026, month: 10, day: 5 },
      daysPast: 7,
      level: "warning",
    });
    expect(payDayStatus(5, { year: 2026, month: 10, day: 13 }).level).toBe("critical");
    expect(payDayStatus(5, { year: 2026, month: 10, day: 5 }).level).toBe("not-due");
  });

  it("keeps the day within 1-28 (blank = 5) and handles January", () => {
    expect(payDayStatus(31, { year: 2026, month: 2, day: 1 }).payDay).toBe(28);
    expect(payDayStatus(0, { year: 2026, month: 2, day: 1 }).payDay).toBe(5);
    expect(payDayStatus(5, { year: 2027, month: 1, day: 20 }).salaryMonth).toEqual({ year: 2026, month: 12 });
  });

  it("says the day the way the MD portal does", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "28th",
    ]);
  });
});
