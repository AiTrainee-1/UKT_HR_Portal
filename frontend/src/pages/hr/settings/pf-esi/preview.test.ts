import { describe, expect, it } from "vitest";
import {
  matchRule,
  productionAmounts,
  productionExample,
  ruleHolds,
  staffAmounts,
  staffExample,
  type PreviewRule,
} from "./preview";

// The live example uses the automatic 50% split (a 30,000 salary: Basic, DA and Retaining Allowance 5,000 each = a first
// portion of 15,000; the second portion 15,000), the way backend/api/pf_esi.py judges an employee, and takes PF / ESI from
// the first portion prorated by the days paid.

const pfBelow25k: PreviewRule = { label: "PF below 25,000", basis: "basic", min: 0, max: 25_000, rate: 12 };
const esiBelow30k: PreviewRule = { label: "ESI below 30,000", basis: "basic", min: 0, max: 30_000, rate: 0.75 };

describe("amounts an employee is judged on", () => {
  it("splits a staff salary automatically: Basic is a sixth, the first portion half, the total the salary", () => {
    expect(staffAmounts(3_000_000)).toEqual({ basic: 500_000, first_portion: 1_500_000, total: 3_000_000 });
    // paise left over when a portion is shared go to the earliest components (Basic first)
    expect(staffAmounts(1_000_004)).toEqual({ basic: 166_668, first_portion: 500_002, total: 1_000_004 });
  });

  it("knows nothing of a salary of nothing", () => {
    expect(staffAmounts(0)).toEqual({ basic: 0, first_portion: 0, total: 0 });
  });

  it("gives a production worker's monthly estimate the same shares", () => {
    expect(productionAmounts(3_000_000)).toEqual({ basic: 500_000, first_portion: 1_500_000, total: 3_000_000 });
  });
});

describe("which rule fits", () => {
  it("includes both ends of a range, and treats a Maximum of 0 as no upper limit", () => {
    expect(ruleHolds(pfBelow25k, 2_500_000)).toBe(true);
    expect(ruleHolds(pfBelow25k, 2_500_001)).toBe(false);
    expect(ruleHolds({ ...pfBelow25k, min: 100, max: 0 }, 9_999)).toBe(false);
    expect(ruleHolds({ ...pfBelow25k, min: 100, max: 0 }, 10_000)).toBe(true);
    expect(ruleHolds({ ...pfBelow25k, min: 100, max: 0 }, 99_999_999_999)).toBe(true);
  });

  it("measures each rule on its own basis, and the first rule in the list that fits wins", () => {
    const amounts = staffAmounts(3_000_000); // Basic 5,000, first portion 15,000, total 30,000
    const rules: PreviewRule[] = [
      { label: "Big salaries", basis: "total", min: 40_000, max: 0, rate: 5 },
      { label: "Mid salaries", basis: "total", min: 20_000, max: 40_000, rate: 8 },
      { label: "Anyone", basis: "basic", min: 0, max: 0, rate: 12 },
    ];
    const match = matchRule(rules, amounts);
    expect(match?.index).toBe(1);
    expect(match?.tested).toBe(3_000_000);
    expect(matchRule([rules[0]], amounts)).toBeNull();
    expect(matchRule([], amounts)).toBeNull();
  });
});

describe("a staff member's example", () => {
  it("30,000 a month, a full month: PF below 25,000 Basic is 12% of 15,000 = 1,800; ESI 0.75% = 112.50", () => {
    const e = staffExample({ salary: 30_000, daysPaid: 26, pfRules: [pfBelow25k], esiRules: [esiBelow30k] });
    expect(e.amounts.basic).toBe(500_000);
    expect(e.base).toBe(1_500_000);
    expect([e.pf.match?.rule.label, e.pf.rate, e.pf.amount]).toEqual(["PF below 25,000", 12, 180_000]);
    expect([e.esi.match?.rule.label, e.esi.rate, e.esi.amount]).toEqual(["ESI below 30,000", 0.75, 11_250]);
    expect(e.total).toBe(191_250);
  });

  it("prorates the first portion by the days paid: 24 of 26 days -> 1,384.62 of base, PF 1,661.54", () => {
    const e = staffExample({ salary: 30_000, daysPaid: 24, pfRules: [pfBelow25k], esiRules: [] });
    expect(e.base).toBe(1_384_615);
    expect(e.pf.amount).toBe(166_154);
    expect(e.esi).toEqual({ match: null, rate: 0, amount: 0 });
  });

  it("does not let a short month change who is eligible: the range is tested on the full monthly Basic", () => {
    const short = staffExample({ salary: 150_000, daysPaid: 1, pfRules: [pfBelow25k], esiRules: [] });
    // Basic 25,000 is the top of the range (included) however few days were paid
    expect(short.pf.match?.tested).toBe(2_500_000);
    const above = staffExample({ salary: 150_006, daysPaid: 26, pfRules: [pfBelow25k], esiRules: [] });
    expect(above.pf.match).toBeNull();
    expect(above.pf.amount).toBe(0);
  });

  it("deducts nothing without rules, and nothing for a rule of 0%", () => {
    const none = staffExample({ salary: 30_000, daysPaid: 26, pfRules: [], esiRules: [] });
    expect([none.pf.amount, none.esi.amount, none.total]).toEqual([0, 0, 0]);
    const zero = staffExample({
      salary: 30_000,
      daysPaid: 26,
      pfRules: [{ ...pfBelow25k, rate: 0 }],
      esiRules: [],
    });
    expect([zero.pf.match?.index, zero.pf.amount]).toEqual([0, 0]);
  });

  it("can use the first-portion and the full-salary bases too", () => {
    const e = staffExample({
      salary: 30_000,
      daysPaid: 26,
      pfRules: [{ label: "First portion up to 15,000", basis: "first_portion", min: 0, max: 15_000, rate: 12 }],
      esiRules: [{ label: "Whole salary up to 29,999", basis: "total", min: 0, max: 29_999, rate: 0.75 }],
    });
    expect(e.pf.amount).toBe(180_000);
    expect(e.esi.match).toBeNull();
  });
});

describe("a production worker's example", () => {
  it("scales the period's pay to a month: Weekly x 4, BiWeekly x 2, Monthly x 1", () => {
    const rules = { pfRules: [pfBelow25k], esiRules: [] };
    expect(productionExample({ periodPay: 7_500, cycle: "weekly", ...rules }).monthlyEquivalent).toBe(3_000_000);
    expect(productionExample({ periodPay: 15_000, cycle: "biweekly", ...rules }).monthlyEquivalent).toBe(3_000_000);
    expect(productionExample({ periodPay: 30_000, cycle: "monthly", ...rules }).monthlyEquivalent).toBe(3_000_000);
  });

  it("takes PF from half of the period's pay: 7,500 a week -> 3,750 -> 12% = 450.00", () => {
    const e = productionExample({ periodPay: 7_500, cycle: "weekly", pfRules: [pfBelow25k], esiRules: [esiBelow30k] });
    expect(e.base).toBe(375_000);
    expect([e.pf.amount, e.esi.amount, e.total]).toEqual([45_000, 2_813, 47_813]);
  });

  it("tests a 'Full monthly salary' rule on the monthly estimate, not on the period's pay", () => {
    const rule: PreviewRule = { label: "Under 20,000 a month", basis: "total", min: 0, max: 20_000, rate: 12 };
    // 6,000 a week is 24,000 a month: no match on Weekly; the same 6,000 on Monthly is 6,000: it matches
    expect(productionExample({ periodPay: 6_000, cycle: "weekly", pfRules: [rule], esiRules: [] }).pf.match).toBeNull();
    expect(
      productionExample({ periodPay: 6_000, cycle: "monthly", pfRules: [rule], esiRules: [] }).pf.match?.tested,
    ).toBe(600_000);
  });
});
