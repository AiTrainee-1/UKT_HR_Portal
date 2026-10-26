import { describe, expect, it } from "vitest";
import type { PayrollSettingsItem, WeekStart } from "@/lib/api-client/custom-hooks";
import { WEEK_STARTS } from "./cycles";
import {
  cycleErrors,
  cyclePayload,
  hasCycleErrors,
  latestGeneratedPeriod,
  payBonusChanges,
  payBonusErrors,
  payBonusPayload,
  prodBonusReported,
  savedProduction,
  type CycleForm,
} from "./sections";

const SHARED_SLABS = [{ fromLates: 3, deductionShifts: 0.25 }];
const OWN_SLABS = [{ fromLates: 1, deductionShifts: 0.5 }];

const SETTINGS = {
  prodCycles: {
    weekly: {
      weekStart: "sunday",
      anchorDate: null,
      lateFreeAllowance: 3,
      lateSlabs: SHARED_SLABS,
      ownLateRules: false,
    },
    biweekly: {
      weekStart: "monday",
      anchorDate: "2026-02-02",
      lateFreeAllowance: 1,
      lateSlabs: OWN_SLABS,
      ownLateRules: true,
    },
    monthly: {
      weekStart: "monday",
      anchorDate: null,
      lateFreeAllowance: 3,
      lateSlabs: SHARED_SLABS,
      ownLateRules: false,
    },
  },
  defaultSalaryPerShift: 300,
  bonusPercent: 8.33,
  bonusWageCeiling: 7000,
  bonusEligibilityCeiling: 21000,
  prodBonusPercent: 10,
  prodBonusWageCeiling: 8000,
  prodBonusEligibilityCeiling: 25000,
  prodAttendanceMode: "simple",
  prodLateDetectionEnabled: true,
  prodLateFreeAllowance: 3,
  prodLateDeductionSlabs: SHARED_SLABS,
} as unknown as PayrollSettingsItem;

describe("saved values", () => {
  it("read each cycle's period rule and the Pay & Bonus values, and nothing of late detection", () => {
    const { cycles, payBonus } = savedProduction(SETTINGS);
    // a cycle form holds the period rule only: the late values moved to Late Detection -> Production
    expect(cycles.weekly).toEqual({ weekStart: "sunday", anchorDate: "" });
    expect(cycles.biweekly).toEqual({ weekStart: "monday", anchorDate: "2026-02-02" });
    expect(payBonus).toEqual({
      defaultSalaryPerShift: "300",
      prodBonusPercent: "10",
      prodBonusWageCeiling: "8000",
      prodBonusEligibilityCeiling: "25000",
    });
    expect(Object.keys(savedProduction(SETTINGS)).sort()).toEqual(["cycles", "payBonus"]);
  });

  it("fall back to Monday weeks and no date when the server sends no cycles, and to the staff bonus until it reports its own", () => {
    const older = { bonusPercent: 9, bonusWageCeiling: 7500, bonusEligibilityCeiling: 22000 } as PayrollSettingsItem;
    expect(savedProduction(older).cycles.monthly).toEqual({ weekStart: "monday", anchorDate: "" });
    expect(savedProduction(older).payBonus).toEqual({
      defaultSalaryPerShift: "0",
      prodBonusPercent: "9",
      prodBonusWageCeiling: "7500",
      prodBonusEligibilityCeiling: "22000",
    });
    expect(savedProduction(undefined).cycles.weekly).toEqual({ weekStart: "monday", anchorDate: "" });
    expect(savedProduction(undefined).payBonus.prodBonusPercent).toBe("8.33");
    expect([prodBonusReported(SETTINGS), prodBonusReported(older), prodBonusReported(undefined)]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("read any weekday as saved, and the first release's two keys as the weekday they meant", () => {
    const stored = (weekStart: string) =>
      ({
        prodCycles: {
          weekly: { weekStart, anchorDate: null, lateFreeAllowance: 3, lateSlabs: [], ownLateRules: false },
        },
      }) as unknown as PayrollSettingsItem;
    expect(savedProduction(stored("thursday")).cycles.weekly.weekStart).toBe("thursday");
    expect(savedProduction(stored("sun_sat")).cycles.weekly.weekStart).toBe("sunday");
    expect(savedProduction(stored("mon_sat")).cycles.weekly.weekStart).toBe("monday");
    expect(savedProduction(stored("nonsense")).cycles.weekly.weekStart).toBe("monday");
  });
});

describe("the latest generated period of a cycle", () => {
  it("is the row stamped with the cycle whose period ends last; rows without a stamp or dates are ignored", () => {
    const runs = [
      { periodStart: "2026-02-02", periodEnd: "2026-02-08", payCycle: "weekly" as const },
      { periodStart: "2026-02-09", periodEnd: "2026-02-15", payCycle: "weekly" as const },
      { periodStart: "2026-02-16", periodEnd: "2026-03-01", payCycle: "biweekly" as const },
      { periodStart: "2026-03-02", periodEnd: "2026-03-08", payCycle: null },
      { periodStart: null, periodEnd: null, payCycle: "weekly" as const },
    ];
    expect(latestGeneratedPeriod(runs, "weekly")).toEqual({
      start: { year: 2026, month: 2, day: 9 },
      end: { year: 2026, month: 2, day: 15 },
    });
    expect(latestGeneratedPeriod(runs, "monthly")).toBeNull();
    expect(latestGeneratedPeriod([], "weekly")).toBeNull();
  });
});

describe("the cycle save", () => {
  const saved = savedProduction(SETTINGS).cycles;

  it("sends the period rule of that cycle only, and never a late value", () => {
    expect(cyclePayload("weekly", saved.weekly)).toEqual({
      prodCycles: { weekly: { weekStart: "sunday", anchorDate: null } },
    });
    const dated: CycleForm = { ...saved.monthly, weekStart: "monday", anchorDate: " 2026-02-04 " };
    expect(cyclePayload("monthly", dated)).toEqual({
      prodCycles: { monthly: { weekStart: "monday", anchorDate: "2026-02-04" } },
    });
    for (const cycle of ["weekly", "biweekly", "monthly"] as const) {
      const entry = cyclePayload(cycle, saved[cycle]).prodCycles?.[cycle] ?? {};
      expect(Object.keys(entry).sort(), cycle).toEqual(["anchorDate", "weekStart"]);
    }
    expect(
      cyclePayload("weekly", { ...saved.weekly, weekStart: "odd" as WeekStart }).prodCycles?.weekly?.weekStart,
    ).toBe("monday");
  });

  it("sends whichever of the seven weekdays was chosen", () => {
    for (const weekStart of WEEK_STARTS) {
      expect(cyclePayload("biweekly", { ...saved.biweekly, weekStart }).prodCycles?.biweekly).toEqual({
        weekStart,
        anchorDate: "2026-02-02",
      });
    }
  });

  it("refuses a date that is not real or outside the server's years", () => {
    const clean = cycleErrors(saved.weekly);
    expect(clean).toEqual({});
    expect(hasCycleErrors(clean)).toBe(false);
    expect(cycleErrors({ ...saved.weekly, anchorDate: "2026-02-30" }).anchorDate).toBe("Pick a real date.");
    expect(cycleErrors({ ...saved.weekly, anchorDate: "1999-12-27" }).anchorDate).toBe(
      "Pick a date between the years 2000 and 2100.",
    );
    expect(cycleErrors({ ...saved.weekly, anchorDate: "" }).anchorDate).toBeUndefined();
    expect(hasCycleErrors(cycleErrors({ ...saved.weekly, anchorDate: "nonsense" }))).toBe(true);
  });
});

describe("the Pay & Bonus save", () => {
  const saved = savedProduction(SETTINGS).payBonus;

  it("sends only the values that were changed, as numbers, and never the staff bonus", () => {
    expect(payBonusPayload(saved, [])).toEqual({});
    expect(payBonusPayload({ ...saved, defaultSalaryPerShift: " 350 " }, ["defaultSalaryPerShift"])).toEqual({
      defaultSalaryPerShift: 350,
    });
    expect(
      payBonusPayload({ ...saved, prodBonusPercent: "12.5", prodBonusWageCeiling: "9000" }, [
        "prodBonusPercent",
        "prodBonusWageCeiling",
      ]),
    ).toEqual({ prodBonusPercent: 12.5, prodBonusWageCeiling: 9000 });
    const all = payBonusPayload(saved, [
      "defaultSalaryPerShift",
      "prodBonusPercent",
      "prodBonusWageCeiling",
      "prodBonusEligibilityCeiling",
    ]);
    expect(Object.keys(all).sort()).toEqual([
      "defaultSalaryPerShift",
      "prodBonusEligibilityCeiling",
      "prodBonusPercent",
      "prodBonusWageCeiling",
    ]);
    for (const staff of [
      "bonusPercent",
      "bonusWageCeiling",
      "bonusEligibilityCeiling",
      "bonusFyStartMonth",
      "payDay",
    ]) {
      expect(Object.keys(all)).not.toContain(staff);
    }
  });

  it("judges changed boxes against the server's ranges and never a value left as saved", () => {
    const errors = payBonusErrors(
      { ...saved, defaultSalaryPerShift: "300.505", prodBonusPercent: "101", prodBonusWageCeiling: "-1" },
      saved,
    );
    expect(errors).toEqual({
      defaultSalaryPerShift: "Use at most 2 decimals.",
      prodBonusPercent: "Must be from 0 to 100.",
      prodBonusWageCeiling: "Must be 0 or more.",
    });
    expect(payBonusErrors(saved, saved)).toEqual({});
    const odd = { ...saved, prodBonusPercent: "150" };
    expect(payBonusErrors(odd, odd)).toEqual({});
  });

  it("lists each changed value from -> to, in words", () => {
    const form = {
      ...saved,
      defaultSalaryPerShift: "350",
      prodBonusPercent: "12.5",
      prodBonusEligibilityCeiling: "30000",
    };
    expect(
      payBonusChanges(["defaultSalaryPerShift", "prodBonusPercent", "prodBonusEligibilityCeiling"], saved, form),
    ).toEqual([
      { label: "Suggested rate per shift", from: "₹300.00", to: "₹350.00" },
      { label: "Production bonus rate", from: "10%", to: "12.5%" },
      { label: "Production bonus eligibility limit", from: "₹25,000.00", to: "₹30,000.00" },
    ]);
  });
});
