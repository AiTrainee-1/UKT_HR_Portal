import { describe, expect, it } from "vitest";
import {
  addMinutes,
  bandIssues,
  bonusFor,
  divRoundHalfEven,
  divRoundHalfUp,
  formatPaise,
  fyLabelFor,
  fyMonths,
  matchingBand,
  NO_CYCLE_MONTHLY_FACTOR,
  ordinal,
  overtimeFor,
  payDayStatus,
  productionPay,
  staffFullMonthBasic,
  staffPay,
} from "./preview";

// Expected figures are the ones the settings inventory computed with the engine's own formulas (Decimal, ROUND_HALF_UP):
// shared samples are a ₹20,000 staff salary over 26 working days with PF 12 / ESI 0.75 / ceiling ₹21,000, and ₹600 per
// production shift.

const STAFF = { salary: 20_000, workingDays: 26, rulesOn: true, pfRate: 12, esiRate: 0.75, esiCeiling: 21_000 };
const FLAT = {
  ratePerShift: 600,
  flatOn: true,
  pfRate: 12,
  esiRate: 0.75,
  esiCeiling: 21_000,
  bandsOn: false,
  bands: [],
};
const BANDS = [
  { label: "Low", minSalary: 0, maxSalary: 20_000, pfRate: 12, efRate: 0.75 },
  { label: "High", minSalary: 20_001, maxSalary: 0, pfRate: 12, efRate: 0 },
];

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

describe("staff payslip PF / ESI", () => {
  it("switch on: ₹20,000 full month -> PF 1,200.00 + ESI 150.00 = 1,350.00, net 18,650.00", () => {
    const pay = staffPay({ ...STAFF, daysPaid: 26 });
    expect([pay.gross, pay.basic, pay.pf, pay.esi, pay.deductions, pay.net]).toEqual([
      2_000_000, 1_000_000, 120_000, 15_000, 135_000, 1_865_000,
    ]);
  });

  it("switch off: no deduction even with rates filled in, net 20,000.00", () => {
    const pay = staffPay({ ...STAFF, rulesOn: false, daysPaid: 26 });
    expect([pay.pf, pay.esi, pay.net]).toEqual([0, 0, 2_000_000]);
  });

  it("24 of 26 days: Basic 9,230.77 -> PF 1,107.69; earned 18,461.54 -> ESI 138.46", () => {
    const pay = staffPay({ ...STAFF, daysPaid: 24 });
    expect([pay.gross, pay.basic, pay.pf, pay.esi]).toEqual([1_846_154, 923_077, 110_769, 13_846]);
  });

  it("₹30,000: Basic 15,000 -> PF 1,800.00 (no PF ceiling) and ESI 0.00 (above the ESI ceiling)", () => {
    const pay = staffPay({ ...STAFF, salary: 30_000, daysPaid: 26 });
    expect([pay.basic, pay.pf, pay.esi, pay.esiApplies]).toEqual([1_500_000, 180_000, 0, false]);
  });

  it("the ESI ceiling includes an equal salary: 21,000 -> 157.50, 21,001 -> 0.00", () => {
    expect(staffPay({ ...STAFF, salary: 21_000, daysPaid: 26 }).esi).toBe(15_750);
    expect(staffPay({ ...STAFF, salary: 21_001, daysPaid: 26 }).esi).toBe(0);
  });

  it("OT pay: 2 announced days x 769.23 = 1,538.46, net 20,188.46; none while the features are off", () => {
    const on = staffPay({ ...STAFF, daysPaid: 26, otDays: 2, otOn: true });
    expect([on.dailyRate, on.ot, on.net]).toEqual([76_923, 153_846, 2_018_846]);
    const off = staffPay({ ...STAFF, daysPaid: 26, otDays: 2, otOn: false });
    expect([off.ot, off.net]).toEqual([0, 1_865_000]);
  });

  it("a fully paid month's Basic is half the salary", () => {
    expect([staffFullMonthBasic(20_000), staffFullMonthBasic(42_002)]).toEqual([10_000, 21_001]);
  });
});

describe("production payslip PF / ESI", () => {
  it("flat rates: 16 shifts x 600 = 9,600 -> PF 1,152.00 + ESI 72.00, net 8,376.00", () => {
    const pay = productionPay({ ...FLAT, shifts: 16 });
    expect([pay.gross, pay.monthlyEstimate, pay.pf, pay.esi, pay.net, pay.source]).toEqual([
      960_000,
      1_920_000,
      115_200,
      7_200,
      837_600,
      "flat",
    ]);
  });

  it("flat rates: 20.5 shifts = 12,300 -> PF 1,476.00, ESI 0.00 (estimate 24,600 is above the ceiling)", () => {
    const pay = productionPay({ ...FLAT, shifts: 20.5 });
    expect([pay.gross, pay.monthlyEstimate, pay.pf, pay.esi]).toEqual([1_230_000, 2_460_000, 147_600, 0]);
  });

  it("ESI ceiling on the estimate (x 2 with no cycle), equal included: 9,600 and 10,500 pay, 10,600 does not", () => {
    const esiFor = (gross: number) => productionPay({ ...FLAT, shifts: 1, ratePerShift: gross }).esi;
    expect([esiFor(9_600), esiFor(10_500), esiFor(10_600)]).toEqual([7_200, 7_875, 0]);
    // With no cycle a period pay of ₹6,000 is tested as ₹12,000 a month, so it pays ESI.
    expect(esiFor(6_000)).toBe(4_500);
  });

  it("switch off and no band: no PF or ESI", () => {
    const pay = productionPay({ ...FLAT, flatOn: false, shifts: 16 });
    expect([pay.pf, pay.esi, pay.net, pay.source]).toEqual([0, 0, 960_000, "none"]);
  });

  it("salary bands win over the flat rates, even with the flat switch off", () => {
    const low = productionPay({ ...FLAT, flatOn: false, bandsOn: true, bands: BANDS, shifts: 16 });
    expect([low.source, low.band?.position, low.pf, low.esi, low.net]).toEqual(["band", 1, 115_200, 7_200, 837_600]);
    const high = productionPay({ ...FLAT, flatOn: false, bandsOn: true, bands: BANDS, shifts: 20.5 });
    expect([high.band?.label, high.pf, high.esi]).toEqual(["High", 147_600, 0]);
  });

  it("bands include both ends and the first match wins; a gap matches nothing", () => {
    const touching = [
      { minSalary: 0, maxSalary: 15_000 },
      { minSalary: 15_000, maxSalary: 0 },
    ];
    expect(matchingBand(touching, 1_500_000)).toBe(0);
    expect(matchingBand(touching, 1_500_002)).toBe(1);
    expect(matchingBand(BANDS, 2_000_050)).toBe(-1);
    // With no band matching, the flat rates apply only while their switch is on.
    const gap = { ...FLAT, bandsOn: true, bands: BANDS, shifts: 1, ratePerShift: 10_000.25 };
    expect(productionPay(gap).source).toBe("flat");
    expect(productionPay({ ...gap, flatOn: false }).source).toBe("none");
  });

  it("rows the engine cannot read are skipped", () => {
    expect(
      matchingBand(
        [
          { minSalary: "abc", maxSalary: 0 },
          { minSalary: 0, maxSalary: 0 },
        ],
        100,
      ),
    ).toBe(1);
    expect(matchingBand([{ minSalary: "100", maxSalary: "200.5" }], 20_050)).toBe(0);
  });

  it("the late penalty comes off take-home pay, not off the shifts earned", () => {
    const pay = productionPay({ ...FLAT, shifts: 20.5, latePenalty: 15_000 });
    expect([pay.gross, pay.net]).toEqual([1_230_000, 1_067_400]);
  });
});

describe("estimated monthly pay follows the pay cycle", () => {
  it("is the period pay x 4 on Weekly, x 2 on BiWeekly, x 1 on Monthly, and x 2 with no cycle", () => {
    // six shifts x 600 = 3,600 of pay in the period
    const estimate = (monthlyFactor?: number) => productionPay({ ...FLAT, shifts: 6, monthlyFactor }).monthlyEstimate;
    expect([estimate(4), estimate(2), estimate(1), estimate()]).toEqual([1_440_000, 720_000, 360_000, 720_000]);
    expect(NO_CYCLE_MONTHLY_FACTOR).toBe(2);
  });

  it("tests the ESI ceiling on it: a Weekly 6,000 is 24,000 a month (no ESI), a BiWeekly or Monthly 6,000 pays ESI", () => {
    const esiFor = (monthlyFactor: number) =>
      productionPay({ ...FLAT, shifts: 1, ratePerShift: 6_000, monthlyFactor }).esi;
    expect([esiFor(4), esiFor(2), esiFor(1)]).toEqual([0, 4_500, 4_500]);
  });

  it("matches a salary band on it too", () => {
    const bandOf = (monthlyFactor: number) =>
      productionPay({ ...FLAT, bandsOn: true, bands: BANDS, shifts: 1, ratePerShift: 6_000, monthlyFactor }).band
        ?.label;
    expect([bandOf(4), bandOf(2), bandOf(1)]).toEqual(["High", "Low", "Low"]);
  });
});

describe("salary band problems", () => {
  it("names overlaps, gaps, an open top and rows that can never match", () => {
    expect(bandIssues(BANDS).map((i) => i.text)).toEqual([
      "An estimated monthly pay from ₹20,000.01 to ₹20,000.99 matches no band.",
    ]);
    expect(
      bandIssues([
        { minSalary: 0, maxSalary: 15_000 },
        { minSalary: 15_000, maxSalary: 0 },
      ]).map((i) => i.kind),
    ).toEqual(["overlap"]);
    expect(bandIssues([{ minSalary: 0, maxSalary: 15_000 }])[0].text).toBe(
      "An estimated monthly pay above ₹15,000.00 matches no band.",
    );
    expect(bandIssues([{ minSalary: 500, maxSalary: 100 }]).map((i) => i.kind)).toEqual(["never"]);
    expect(bandIssues([{ minSalary: "x", maxSalary: 0 }]).map((i) => i.kind)).toEqual(["unreadable"]);
    expect(bandIssues([])).toEqual([]);
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
