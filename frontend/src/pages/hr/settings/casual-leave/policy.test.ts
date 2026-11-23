import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORM,
  eligibleFrom,
  exampleYear,
  formFromPolicy,
  halfDays,
  summary,
  toInput,
  validate,
  type ClPolicyForm,
} from "./policy";

const form = (patch: Partial<ClPolicyForm> = {}): ClPolicyForm => ({ ...DEFAULT_FORM, ...patch });

describe("Casual Leave policy form", () => {
  it("accepts the starting policy and refuses what the server refuses", () => {
    expect(validate(form())).toEqual({});
    expect(validate(form({ eligibilityValue: "6.5" })).eligibilityValue).toMatch(/whole number of months/);
    expect(validate(form({ eligibilityValue: "121" })).eligibilityValue).toMatch(/0 to 120/);
    expect(validate(form({ eligibilityBasis: "days", eligibilityValue: "180" }))).toEqual({});
    expect(validate(form({ monthlyAllocation: "0" })).monthlyAllocation).toMatch(/0.5 to 31/);
    expect(validate(form({ monthlyAllocation: "1.25" })).monthlyAllocation).toMatch(/whole or half/);
    // only the allocation in use is checked
    expect(validate(form({ yearlyAllocation: "x" }))).toEqual({});
    expect(validate(form({ allocation: "yearly", yearlyAllocation: "x" })).yearlyAllocation).toBeTruthy();
    expect(validate(form({ balanceSince: "2026-02-30" })).balanceSince).toBeTruthy();
  });

  it("will not move days into the next year when months do not carry forward", () => {
    expect(validate(form({ carryForward: false, yearEnd: "carry" })).yearEnd).toMatch(/Carry forward/);
    expect(validate(form({ allocation: "yearly", carryForward: false, yearEnd: "carry" }))).toEqual({});
  });

  it("asks for whole days when half days are off", () => {
    const f = form({ halfDayAllowed: false, monthlyAllocation: "1.5" });
    expect(validate(f).monthlyAllocation).toMatch(/whole days/);
    expect(validate(form({ halfDayAllowed: false, yearEnd: "carry", yearEndCarryMax: "2.5" })).yearEndCarryMax).toMatch(
      /whole days/,
    );
  });

  it("sends numbers, and no maximum while days lapse", () => {
    expect(toInput(form({ eligibilityValue: " 3 ", monthlyAllocation: "1.5", yearEndCarryMax: "4" }))).toMatchObject({
      eligibilityValue: 3,
      monthlyAllocation: 1.5,
      yearEnd: "lapse",
      yearEndCarryMax: null,
    });
    expect(toInput(form({ yearEnd: "carry", yearEndCarryMax: "4" })).yearEndCarryMax).toBe(4);
    expect(toInput(form({ yearEnd: "carry", yearEndCarryMax: "" })).yearEndCarryMax).toBeNull();
    // an unusable amount of the allocation not in use is left out, not sent as NaN
    expect("yearlyAllocation" in toInput(form({ yearlyAllocation: "" }))).toBe(false);
  });

  it("reads the server's policy", () => {
    const f = formFromPolicy({
      yearlyEntitlement: 12,
      halfDayCounts: 0.5,
      balanceSince: "2026-11-02",
      eligibilityMonths: null,
      staffOnly: true,
      rule: "",
      eligibilityBasis: "days",
      eligibilityValue: 180,
      serviceText: "180 days of service",
      allocation: "yearly",
      monthlyAllocation: 1,
      yearlyAllocation: 12,
      allocationText: "12 days a year",
      carryForward: true,
      yearEnd: "carry",
      yearEndCarryMax: 5,
      halfDayAllowed: false,
    });
    expect(f).toMatchObject({ eligibilityBasis: "days", eligibilityValue: "180", yearEndCarryMax: "5" });
  });

  it("parses half days", () => {
    expect(halfDays("1.5", 0.5, 31)).toBe(1.5);
    expect(halfDays("2", 0.5, 31)).toBe(2);
    expect(halfDays("-1", 0.5, 31)).toBeNull();
    expect(halfDays("1e1", 0.5, 31)).toBeNull();
  });

  it("words the whole policy in one sentence", () => {
    expect(summary(form())).toBe(
      "Staff with 6 months of service earn 1 day a month; unused days carry forward to later months (a month's days cannot be used before it). Half days count 0.5. Unused days lapse on 31 December.",
    );
    expect(summary(form({ allocation: "yearly", yearEnd: "carry", yearEndCarryMax: "5", halfDayAllowed: false }))).toBe(
      "Staff with 6 months of service get 12 days a year, to use any time in the year. Full days only. Unused days move into the next year (at most 5 days).",
    );
  });
});

describe("the day someone may start (the server's cl_balance.eligible_from)", () => {
  it("counts completed months, a month-end join landing on the shorter month's end or the next day", () => {
    expect(eligibleFrom("2026-04-15", "months", 6)).toBe("2026-10-15");
    expect(eligibleFrom("2025-12-01", "months", 6)).toBe("2026-06-01");
    expect(eligibleFrom("2026-01-31", "months", 6)).toBe("2026-07-31");
    expect(eligibleFrom("2026-08-31", "months", 6)).toBe("2027-03-01");
    expect(eligibleFrom("2023-08-31", "months", 6)).toBe("2024-03-01");
    expect(eligibleFrom("2026-04-15", "months", 0)).toBe("2026-04-15");
  });

  it("or days", () => {
    expect(eligibleFrom("2026-01-01", "days", 180)).toBe("2026-06-30");
    expect(eligibleFrom("2026-12-31", "days", 1)).toBe("2027-01-01");
  });
});

describe("the example year", () => {
  const wants = { 6: 3, 10: 1 };

  it("monthly with carry forward: the unused days of January to May are there in June", () => {
    const y = exampleYear(form(), 1, wants);
    const june = y.months[5];
    expect(june).toMatchObject({ given: 1, available: 6, taken: 3, refused: 0, left: 3 });
    expect(y.given).toBe(12);
    expect(y.taken).toBe(4);
    expect(y.leftAtYearEnd).toBe(8);
    expect(y.lapsesAtYearEnd).toBe(8);
  });

  it("monthly without carry forward: each month only its own days", () => {
    const y = exampleYear(form({ carryForward: false }), 1, wants);
    expect(y.months[5]).toMatchObject({ available: 1, taken: 1, refused: 2, left: 0 });
    expect(y.months[0]).toMatchObject({ left: 1, lapsed: 1 });
    expect(y.leftAtYearEnd).toBe(0);
  });

  it("starts in the month the service is complete", () => {
    const y = exampleYear(form(), 7, wants);
    expect(y.months[5]).toMatchObject({ counts: false, taken: 0 });
    expect(y.given).toBe(6);
    expect(y.months[9]).toMatchObject({ available: 4, taken: 1, left: 3 });
  });

  it("yearly: every day at once; the year end moves at most the maximum", () => {
    const y = exampleYear(form({ allocation: "yearly", yearEnd: "carry", yearEndCarryMax: "5" }), 1, wants);
    expect(y.months[0]).toMatchObject({ given: 12, available: 12 });
    expect(y.leftAtYearEnd).toBe(8);
    expect(y.movesToNextYear).toBe(5);
    expect(y.lapsesAtYearEnd).toBe(3);
  });

  it("only whole days are taken when half days are off", () => {
    const y = exampleYear(form({ monthlyAllocation: "0.5", halfDayAllowed: false }), 1, { 3: 1 });
    // 1.5 days are there in March but half days are off: one whole day
    expect(y.months[2]).toMatchObject({ available: 1.5, taken: 1, left: 0.5 });
  });
});
