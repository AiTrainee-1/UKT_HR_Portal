import { describe, expect, it } from "vitest";
import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import { cyclePayload, savedProduction } from "../production-payroll/sections";
import {
  changedCycles,
  cycleLateErrors,
  cycleLateRules,
  deductsFromEveryone,
  firstLateProblem,
  hasCycleLateErrors,
  ownLateRules,
  productionLateChanges,
  productionLatePayload,
  sameProductionLate,
  savedProductionLate,
  sharedLatePayload,
  type ProductionLateForm,
} from "./production";

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
} as unknown as PayrollSettingsItem;

const label = (c: string) => c;

describe("saved values", () => {
  it("read the switch, the mode and each cycle's late values (shared ones filled in)", () => {
    const form = savedProductionLate(SETTINGS);
    expect(form.enabled).toBe(true);
    expect(form.mode).toBe("simple");
    expect(form.cycles.weekly).toEqual({
      lateFreeAllowance: "3",
      lateSlabs: [{ fromLates: "3", deductionShifts: "0.25" }],
    });
    expect(form.cycles.biweekly).toEqual({
      lateFreeAllowance: "1",
      lateSlabs: [{ fromLates: "1", deductionShifts: "0.5" }],
    });
    expect([ownLateRules(SETTINGS, "weekly"), ownLateRules(SETTINGS, "biweekly")]).toEqual([false, true]);
    expect(cycleLateRules(SETTINGS, "biweekly")).toEqual({ allowance: 1, slabs: OWN_SLABS, own: true });
  });

  it("fall back to the shared production values when the server sends no cycles, and to Off / Strict with nothing", () => {
    const older = { prodLateFreeAllowance: 2, prodLateDeductionSlabs: SHARED_SLABS } as unknown as PayrollSettingsItem;
    expect(savedProductionLate(older).cycles.monthly).toEqual({
      lateFreeAllowance: "2",
      lateSlabs: [{ fromLates: "3", deductionShifts: "0.25" }],
    });
    expect(ownLateRules(older, "monthly")).toBe(false);
    const empty = savedProductionLate(undefined);
    expect(empty.enabled).toBe(false);
    expect(empty.mode).toBe("strict");
    expect(empty.cycles.weekly).toEqual({ lateFreeAllowance: "3", lateSlabs: [] });
  });
});

describe("what was changed", () => {
  const saved = savedProductionLate(SETTINGS);

  it("compares the whole page, and names the cycles whose late values differ", () => {
    expect(sameProductionLate(saved, structuredClone(saved))).toBe(true);
    const edited: ProductionLateForm = structuredClone(saved);
    edited.cycles.monthly.lateFreeAllowance = "5";
    edited.mode = "strict";
    expect(sameProductionLate(edited, saved)).toBe(false);
    expect(changedCycles(edited, saved)).toEqual(["monthly"]);
    // "3" and "3.0" are one number
    const same: ProductionLateForm = structuredClone(saved);
    same.cycles.weekly.lateFreeAllowance = "3.0";
    expect(changedCycles(same, saved)).toEqual([]);
  });

  it("lists every changed value from -> to, with the cycle's name, for the confirm", () => {
    const edited: ProductionLateForm = structuredClone(saved);
    edited.enabled = false;
    edited.mode = "strict";
    edited.cycles.weekly.lateFreeAllowance = "4";
    edited.cycles.biweekly.lateSlabs = [];
    const changes = productionLateChanges(edited, saved);
    expect(changes.map((c) => [c.label, c.from, c.to])).toEqual([
      ["Late deductions", "On", "Off"],
      ["What counts as late", "Simple", "Strict"],
      ["Weekly: free late days a period", "3", "4"],
      ["BiWeekly: deduction slabs", "1 → 0.5", "no slabs (nothing deducted)"],
    ]);
    expect(changes.every((c) => c.money)).toBe(true);
    expect(productionLateChanges(saved, saved)).toEqual([]);
  });
});

describe("checks before sending", () => {
  const saved = savedProductionLate(SETTINGS).cycles;

  it("judges the late values once changed, and never a value left as it was saved", () => {
    const clean = cycleLateErrors(saved.weekly, saved.weekly);
    expect(clean).toEqual({ slabs: [{}] });
    expect(hasCycleLateErrors(clean)).toBe(false);
    const result = cycleLateErrors(
      {
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
    expect(hasCycleLateErrors(result)).toBe(true);
    const odd = { lateFreeAllowance: "999", lateSlabs: [{ fromLates: "-3", deductionShifts: "x" }] };
    expect(hasCycleLateErrors(cycleLateErrors(odd, odd))).toBe(false);
  });

  it("names the first cycle with a late value to fix", () => {
    const form = structuredClone(savedProductionLate(SETTINGS));
    expect(firstLateProblem(form, savedProductionLate(SETTINGS), label)).toBeNull();
    form.cycles.biweekly.lateFreeAllowance = "abc";
    expect(firstLateProblem(form, savedProductionLate(SETTINGS), label)).toBe("biweekly has a late value to fix.");
  });

  it("notices a slab that deducts from workers who were never late", () => {
    expect(deductsFromEveryone([{ fromLates: "0", deductionShifts: "0.25" }])).toBe(true);
    expect(deductsFromEveryone([{ fromLates: "0", deductionShifts: "0" }])).toBe(false);
    expect(deductsFromEveryone([{ fromLates: "3", deductionShifts: "0.25" }])).toBe(false);
  });
});

describe("the save sends only the keys this page owns, so it never overwrites a period rule", () => {
  const saved = savedProductionLate(SETTINGS);

  it("sends nothing for a page nothing was changed on", () => {
    expect(productionLatePayload(saved, saved)).toEqual({});
  });

  it("sends the switch and the mode only when they changed", () => {
    const edited: ProductionLateForm = { ...structuredClone(saved), enabled: false };
    expect(productionLatePayload(edited, saved)).toEqual({ prodLateDetectionEnabled: false });
    expect(productionLatePayload({ ...structuredClone(saved), mode: "strict" }, saved)).toEqual({
      prodAttendanceMode: "strict",
    });
  });

  it("sends a cycle's free late days and slabs only when changed, slabs in ascending order, and only that cycle", () => {
    const edited: ProductionLateForm = structuredClone(saved);
    edited.cycles.weekly.lateFreeAllowance = " 4";
    edited.cycles.weekly.lateSlabs = [
      { fromLates: "9", deductionShifts: "0.75" },
      { fromLates: " 6", deductionShifts: "0.5" },
    ];
    edited.cycles.monthly.lateSlabs = [];
    expect(productionLatePayload(edited, saved)).toEqual({
      prodCycles: {
        weekly: {
          lateFreeAllowance: 4,
          lateSlabs: [
            { fromLates: 6, deductionShifts: 0.5 },
            { fromLates: 9, deductionShifts: 0.75 },
          ],
        },
        monthly: { lateSlabs: [] },
      },
    });
    const onlySlabs: ProductionLateForm = structuredClone(saved);
    onlySlabs.cycles.biweekly.lateSlabs = [{ fromLates: "2", deductionShifts: "1" }];
    const entry = productionLatePayload(onlySlabs, saved).prodCycles?.biweekly;
    expect(entry).toEqual({ lateSlabs: [{ fromLates: 2, deductionShifts: 1 }] });
    expect(entry).not.toHaveProperty("lateFreeAllowance");
  });

  it("never carries a period key (week start, first period start): those belong to Production Payroll", () => {
    const edited: ProductionLateForm = structuredClone(saved);
    for (const cycle of ["weekly", "biweekly", "monthly"] as const) edited.cycles[cycle].lateFreeAllowance = "7";
    const sent = productionLatePayload(edited, saved).prodCycles ?? {};
    for (const entry of Object.values(sent)) {
      expect(Object.keys(entry ?? {})).toEqual(["lateFreeAllowance"]);
    }
  });

  it("and the period save never carries a late key, so the two saves never overlap on a key", () => {
    const period = savedProduction(SETTINGS).cycles;
    const lateKeys = new Set<string>();
    const edited: ProductionLateForm = structuredClone(saved);
    edited.cycles.weekly.lateFreeAllowance = "9";
    edited.cycles.weekly.lateSlabs = [{ fromLates: "1", deductionShifts: "1" }];
    for (const entry of Object.values(productionLatePayload(edited, saved).prodCycles ?? {})) {
      Object.keys(entry ?? {}).forEach((k) => lateKeys.add(k));
    }
    const periodKeys = new Set(Object.keys(cyclePayload("weekly", period.weekly).prodCycles?.weekly ?? {}));
    expect([...lateKeys].filter((k) => periodKeys.has(k))).toEqual([]);
    expect([...lateKeys].sort()).toEqual(["lateFreeAllowance", "lateSlabs"]);
    expect([...periodKeys].sort()).toEqual(["anchorDate", "weekStart"]);
  });

  it("hands the late rules back to the shared ones with nulls, touching nothing else", () => {
    expect(sharedLatePayload("biweekly")).toEqual({
      prodCycles: { biweekly: { lateFreeAllowance: null, lateSlabs: null } },
    });
  });
});
