import { describe, expect, it } from "vitest";
import type { PayrollSettingsItem, WeekStart } from "@/lib/api-client/custom-hooks";
import { WEEK_STARTS } from "./cycles";
import {
  cycleErrors,
  cyclePayload,
  deductsFromEveryone,
  hasCycleErrors,
  lateKeysChanged,
  latePayload,
  latestGeneratedPeriod,
  ownLateRules,
  savedProduction,
  sharedLatePayload,
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
  prodAttendanceMode: "simple",
  prodLateDetectionEnabled: true,
  prodLateFreeAllowance: 3,
  prodLateDeductionSlabs: SHARED_SLABS,
  pfRate: 12,
} as unknown as PayrollSettingsItem;

describe("saved values", () => {
  it("read each cycle's rule and late values (shared ones filled in), and the global switch and mode", () => {
    const { cycles, late } = savedProduction(SETTINGS);
    expect(cycles.weekly).toEqual({
      weekStart: "sunday",
      anchorDate: "",
      lateFreeAllowance: "3",
      lateSlabs: [{ fromLates: "3", deductionShifts: "0.25" }],
    });
    expect(cycles.biweekly).toEqual({
      weekStart: "monday",
      anchorDate: "2026-02-02",
      lateFreeAllowance: "1",
      lateSlabs: [{ fromLates: "1", deductionShifts: "0.5" }],
    });
    expect(late).toEqual({ mode: "simple", enabled: true });
    expect([ownLateRules(SETTINGS, "weekly"), ownLateRules(SETTINGS, "biweekly")]).toEqual([false, true]);
  });

  it("fall back to Monday weeks, no date and the shared production values when the server sends no cycles", () => {
    const older = { prodLateFreeAllowance: 2, prodLateDeductionSlabs: SHARED_SLABS } as unknown as PayrollSettingsItem;
    expect(savedProduction(older).cycles.monthly).toEqual({
      weekStart: "monday",
      anchorDate: "",
      lateFreeAllowance: "2",
      lateSlabs: [{ fromLates: "3", deductionShifts: "0.25" }],
    });
    expect(ownLateRules(older, "monthly")).toBe(false);
    expect(savedProduction(undefined).cycles.weekly).toEqual({
      weekStart: "monday",
      anchorDate: "",
      lateFreeAllowance: "3",
      lateSlabs: [],
    });
    expect(savedProduction(undefined).late).toEqual({ mode: "strict", enabled: false });
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

  it("always sends the period rule for that cycle only, and the late values only when they were changed", () => {
    expect(cyclePayload("weekly", saved.weekly, [])).toEqual({
      prodCycles: { weekly: { weekStart: "sunday", anchorDate: null } },
    });
    const dated: CycleForm = { ...saved.monthly, weekStart: "monday", anchorDate: " 2026-02-04 " };
    expect(cyclePayload("monthly", dated, ["anchorDate"])).toEqual({
      prodCycles: { monthly: { weekStart: "monday", anchorDate: "2026-02-04" } },
    });
    const edited: CycleForm = {
      ...saved.weekly,
      lateFreeAllowance: " 4",
      lateSlabs: [
        { fromLates: "9", deductionShifts: "0.75" },
        { fromLates: " 6", deductionShifts: "0.5" },
      ],
    };
    expect(cyclePayload("weekly", edited, ["lateFreeAllowance", "lateSlabs"])).toEqual({
      prodCycles: {
        weekly: {
          weekStart: "sunday",
          anchorDate: null,
          lateFreeAllowance: 4,
          lateSlabs: [
            { fromLates: 6, deductionShifts: 0.5 },
            { fromLates: 9, deductionShifts: 0.75 },
          ],
        },
      },
    });
    expect(cyclePayload("weekly", edited, ["lateSlabs"]).prodCycles?.weekly).not.toHaveProperty("lateFreeAllowance");
    expect(
      cyclePayload("weekly", { ...saved.weekly, weekStart: "odd" as WeekStart }, []).prodCycles?.weekly?.weekStart,
    ).toBe("monday");
    expect([lateKeysChanged(["weekStart"]), lateKeysChanged(["anchorDate", "lateSlabs"])]).toEqual([false, true]);
  });

  it("sends whichever of the seven weekdays was chosen", () => {
    for (const weekStart of WEEK_STARTS) {
      expect(cyclePayload("biweekly", { ...saved.biweekly, weekStart }, ["weekStart"]).prodCycles?.biweekly).toEqual({
        weekStart,
        anchorDate: "2026-02-02",
      });
    }
  });

  it("hands the late rules back to the shared ones with nulls, touching nothing else", () => {
    expect(sharedLatePayload("biweekly")).toEqual({
      prodCycles: { biweekly: { lateFreeAllowance: null, lateSlabs: null } },
    });
  });

  it("refuses a date that is not real or outside the server's years, and judges the late values once changed", () => {
    const clean = cycleErrors(saved.weekly, saved.weekly);
    expect(clean).toEqual({ slabs: [{}] });
    expect(hasCycleErrors(clean)).toBe(false);
    expect(cycleErrors({ ...saved.weekly, anchorDate: "2026-02-30" }, saved.weekly).anchorDate).toBe(
      "Pick a real date.",
    );
    expect(cycleErrors({ ...saved.weekly, anchorDate: "1999-12-27" }, saved.weekly).anchorDate).toBe(
      "Pick a date between the years 2000 and 2100.",
    );
    expect(cycleErrors({ ...saved.weekly, anchorDate: "" }, saved.weekly).anchorDate).toBeUndefined();
    const result = cycleErrors(
      {
        ...saved.weekly,
        lateFreeAllowance: "-1",
        lateSlabs: [
          { fromLates: "3", deductionShifts: "0.25" },
          { fromLates: "3", deductionShifts: "x" },
          { fromLates: "2.5", deductionShifts: "0.333" },
        ],
      },
      saved.weekly,
    );
    expect(result).toEqual({
      allowance: "Must be 0 or more.",
      slabs: [
        { fromLates: "3 is used by more than one row." },
        {
          fromLates: "3 is used by more than one row.",
          deductionShifts: "Enter a number, using digits and at most one dot.",
        },
        { fromLates: "Use a whole number.", deductionShifts: "Use at most 2 decimals." },
      ],
    });
    expect(hasCycleErrors(result)).toBe(true);
  });

  it("notices a slab that deducts from workers who were never late", () => {
    expect(deductsFromEveryone([{ fromLates: "0", deductionShifts: "0.25" }])).toBe(true);
    expect(deductsFromEveryone([{ fromLates: "0", deductionShifts: "0" }])).toBe(false);
    expect(deductsFromEveryone([{ fromLates: "3", deductionShifts: "0.25" }])).toBe(false);
  });
});

describe("the late detection save", () => {
  it("sends the switch and the attendance mode, nothing per cycle", () => {
    expect(latePayload({ mode: "strict", enabled: false })).toEqual({
      prodAttendanceMode: "strict",
      prodLateDetectionEnabled: false,
    });
  });
});
