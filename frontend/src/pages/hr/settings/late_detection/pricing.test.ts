import { describe, expect, it } from "vitest";
import {
  permissionSlabsOf,
  pricingChanges,
  pricingDraftFrom,
  pricingDraftProblem,
  pricingPayload,
  samePricing,
} from "./form";
import {
  MAX_PERMISSION_SLABS,
  PRICING_NEEDS_SLAB,
  latePool,
  monthOutcome,
  permissionAllowanceProblem,
  permissionPricing,
  permissionSlabHit,
  permissionSlabWarnings,
  permissionSlabsProblem,
  pricingProblem,
  type PermissionSlab,
} from "./preview";

// Permission pricing (S6): the same arithmetic the server applies when "Price permissions separately" is ON. The worked
// numbers are the spec's: excess = max(0, approved - cap); billable = max(0, excess - free); shifts = the highest slab row
// with fromPermissions <= billable (the last row holds beyond it, no rows = 0); penalty = shifts x the daily rate.

const PERMISSION_SLABS: PermissionSlab[] = [
  { fromPermissions: 1, deductionShifts: 0.25 },
  { fromPermissions: 3, deductionShifts: 0.5 },
  { fromPermissions: 6, deductionShifts: 1 },
];
const DAY = 1000;

describe("the permission slab lookup", () => {
  it("takes the highest row the billable count reaches, holds the last row beyond it, and costs nothing below the first", () => {
    expect(permissionSlabHit(0, PERMISSION_SLABS)).toEqual({ shifts: 0, row: null });
    expect(permissionSlabHit(1, PERMISSION_SLABS).shifts).toBe(0.25);
    expect(permissionSlabHit(2, PERMISSION_SLABS).shifts).toBe(0.25);
    expect(permissionSlabHit(3, PERMISSION_SLABS)).toEqual({ shifts: 0.5, row: PERMISSION_SLABS[1] });
    expect(permissionSlabHit(5, PERMISSION_SLABS).shifts).toBe(0.5);
    expect(permissionSlabHit(6, PERMISSION_SLABS).shifts).toBe(1);
    expect(permissionSlabHit(400, PERMISSION_SLABS).shifts).toBe(1);
  });

  it("reads the rows in ascending order whatever order they are typed in, skips rows that are not numbers, and no rows costs nothing", () => {
    const shuffled = [PERMISSION_SLABS[2], PERMISSION_SLABS[0], PERMISSION_SLABS[1]];
    expect(permissionSlabHit(4, shuffled).shifts).toBe(0.5);
    expect(permissionSlabHit(4, [...shuffled, { fromPermissions: NaN, deductionShifts: 9 }]).shifts).toBe(0.5);
    expect(permissionSlabHit(50, [])).toEqual({ shifts: 0, row: null });
  });
});

describe("permission pricing of one month (the slip's permissionSummary)", () => {
  const price = (approved: number, over: Partial<Parameters<typeof permissionPricing>[0]> = {}) =>
    permissionPricing({
      enabled: true,
      approved,
      cap: 3,
      freeAllowance: 0,
      slabs: PERMISSION_SLABS,
      dayRate: DAY,
      ...over,
    });

  it("is nothing while the switch is OFF: the extra permissions are counted, but not priced here", () => {
    expect(price(8, { enabled: false })).toEqual({
      enabled: false,
      approved: 8,
      cap: 3,
      excess: 5,
      freeAllowance: 0,
      free: 0,
      billable: 0,
      row: null,
      shifts: 0,
      penalty: 0,
    });
  });

  it("prices the permissions beyond the cap: excess, then the free ones, then the slab row, then money", () => {
    // 6 approved, cap 3 -> 3 extra; 1 free -> 2 billable -> row "from 1" -> 0.25 shift = ₹250
    expect(price(6, { freeAllowance: 1 })).toMatchObject({
      excess: 3,
      free: 1,
      billable: 2,
      row: PERMISSION_SLABS[0],
      shifts: 0.25,
      penalty: 250,
    });
    // 8 approved, cap 3 -> 5 extra, none free -> 5 billable -> row "from 3" -> 0.5 shift = ₹500
    expect(price(8)).toMatchObject({ excess: 5, billable: 5, shifts: 0.5, penalty: 500 });
    // 9 approved -> 6 billable -> the last row, a whole shift
    expect(price(9)).toMatchObject({ billable: 6, shifts: 1, penalty: 1000 });
    // never more than the last row, however many
    expect(price(60)).toMatchObject({ shifts: 1, penalty: 1000 });
  });

  it("is free while the extra permissions are within the free ones, and while approved permissions are within the cap", () => {
    expect(price(5, { freeAllowance: 2 })).toMatchObject({ excess: 2, free: 2, billable: 0, shifts: 0, penalty: 0 });
    expect(price(3)).toMatchObject({ excess: 0, billable: 0, shifts: 0, penalty: 0 });
    expect(price(0)).toMatchObject({ excess: 0, shifts: 0 });
  });

  it("with no slab rows costs nothing (the server refuses to turn the switch on like that)", () => {
    expect(price(9, { slabs: [] })).toMatchObject({ billable: 6, shifts: 0, penalty: 0 });
  });

  it("rounds the money to the paisa", () => {
    expect(price(5, { slabs: [{ fromPermissions: 1, deductionShifts: 0.33 }], dayRate: 1000 / 3 }).penalty).toBe(110);
  });
});

describe("the late pool and the permission pricing never deduct the same incident twice", () => {
  const month = (approved: number, enabled: boolean) =>
    monthOutcome({
      lateIn: 2,
      earlyOut: 1,
      approvedPermissions: approved,
      cap: 3,
      allowance: 3,
      slabs: [
        { fromLates: 1, deductionShifts: 0.25 },
        { fromLates: 3, deductionShifts: 0.5 },
      ],
      pricing: { enabled, freeAllowance: 0, slabs: PERMISSION_SLABS },
      dayRate: DAY,
    });

  it("OFF changes nothing: the extra permissions are marks of the late pool, exactly as before", () => {
    const off = month(6, false);
    expect(off.pool).toEqual(latePool({ lateIn: 2, earlyOut: 1, approvedPermissions: 6, cap: 3, allowance: 3 }));
    expect(off.pool.total).toBe(6); // 2 Late + 1 Early Out + 3 extra permissions
    expect(off.permissions.shifts).toBe(0);
    expect(off.totalShifts).toBe(off.poolShifts);
    expect(off.totalPenalty).toBe(off.poolPenalty);
    // 6 marks, 3 free, 3 billable -> the late slab "from 3" -> 0.5 shift
    expect(off.poolShifts).toBe(0.5);
  });

  it("ON takes the extra permissions out of the late pool and prices them on their own", () => {
    const on = month(6, true);
    expect(on.pool.total).toBe(3); // 2 Late + 1 Early Out only
    expect(on.pool.excess).toBe(3); // still reported, no longer a mark
    expect(on.poolShifts).toBe(0); // 3 marks, all 3 free
    expect(on.permissions).toMatchObject({ excess: 3, billable: 3, shifts: 0.5, penalty: 500 });
    expect(on.totalShifts).toBe(0.5);
    expect(on.totalPenalty).toBe(500);
  });

  it("every extra permission is in exactly one of the two pools, for any month", () => {
    for (const approved of [0, 2, 3, 4, 7, 12, 30]) {
      const off = month(approved, false).pool;
      const on = month(approved, true).pool;
      expect(off.total - on.total, `${approved} approved`).toBe(on.excess);
      expect(on.total).toBe(off.lateIn + off.earlyOut);
    }
  });

  it("with the permissions within the cap, ON and OFF are the same month", () => {
    const off = month(3, false);
    const on = month(3, true);
    expect(on.totalShifts).toBe(off.totalShifts);
    expect(on.pool.total).toBe(off.pool.total);
  });
});

describe("permission pricing checks before saving", () => {
  const row = (fromPermissions: string, deductionShifts: string) => ({ fromPermissions, deductionShifts });

  it("wants the free permissions to be a whole number from 0 to 999", () => {
    expect(permissionAllowanceProblem("0")).toBeNull();
    expect(permissionAllowanceProblem("999")).toBeNull();
    expect(permissionAllowanceProblem("1000")).toBe("The free permissions must be a whole number from 0 to 999.");
    expect(permissionAllowanceProblem("1.5")).toBeTruthy();
    expect(permissionAllowanceProblem("-1")).toBeTruthy();
    expect(permissionAllowanceProblem("")).toBeTruthy();
  });

  it("wants each slab to start at a whole 1 to 999 and take 0 to 31 shifts with two decimals, no threshold twice", () => {
    expect(permissionSlabsProblem([row("1", "0.25"), row("999", "31")])).toBeNull();
    expect(permissionSlabsProblem([row("0", "0.25")])).toContain("from 1 to 999");
    expect(permissionSlabsProblem([row("1000", "0.25")])).toContain("from 1 to 999");
    expect(permissionSlabsProblem([row("1.5", "0.25")])).toBeTruthy();
    expect(permissionSlabsProblem([row("", "0.25")])).toBeTruthy();
    expect(permissionSlabsProblem([row("2", "31.01")])).toContain("0 to 31 shifts");
    expect(permissionSlabsProblem([row("2", "0.125")])).toContain("2 decimals");
    expect(permissionSlabsProblem([row("2", "-1")])).toBeTruthy();
    expect(permissionSlabsProblem([row("2", "1"), row("2", "2")])).toBe(
      "Duplicate threshold: 2 billable permissions appears more than once.",
    );
  });

  it("allows 50 rows and no more", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(String(i + 1), "0.25"));
    expect(MAX_PERMISSION_SLABS).toBe(50);
    expect(permissionSlabsProblem(rows(50))).toBeNull();
    expect(permissionSlabsProblem(rows(51))).toBe("At most 50 slabs are allowed.");
  });

  it("turning the switch ON needs at least one slab (the server refuses it otherwise)", () => {
    const base = { enabled: true, allowance: "0", slabs: [] as ReturnType<typeof row>[] };
    expect(pricingProblem(base)).toBe(PRICING_NEEDS_SLAB);
    expect(PRICING_NEEDS_SLAB).toBe("Add at least one slab before turning this on.");
    expect(pricingProblem({ ...base, enabled: false })).toBeNull();
    expect(pricingProblem({ ...base, slabs: [row("1", "0.25")] })).toBeNull();
    // a bad allowance or row is said first
    expect(pricingProblem({ ...base, allowance: "x" })).toContain("free permissions");
  });

  it("warns, without refusing, about a row that costs less than the one before it", () => {
    expect(permissionSlabWarnings(PERMISSION_SLABS)).toEqual([]);
    expect(
      permissionSlabWarnings([
        { fromPermissions: 1, deductionShifts: 1 },
        { fromPermissions: 3, deductionShifts: 0.5 },
      ])[0],
    ).toContain("more permissions would cost less");
  });
});

describe("the permission pricing form", () => {
  const saved = pricingDraftFrom({
    permissionPricingEnabled: true,
    permissionFreeAllowance: 1,
    permissionDeductionSlabs: [PERMISSION_SLABS[1], PERMISSION_SLABS[0]],
  });

  it("loads with the server's defaults while nothing is reported: OFF, no free permissions, no rows", () => {
    expect(pricingDraftFrom({})).toEqual({ enabled: false, allowance: "0", slabs: [] });
    expect(saved).toEqual({
      enabled: true,
      allowance: "1",
      slabs: [
        { fromPermissions: "1", deductionShifts: "0.25" },
        { fromPermissions: "3", deductionShifts: "0.5" },
      ],
    });
  });

  it("compares in any row order and by number", () => {
    expect(samePricing({ ...saved, slabs: [...saved.slabs].reverse() }, saved)).toBe(true);
    expect(samePricing({ ...saved, allowance: "1.0" }, saved)).toBe(true);
    expect(samePricing({ ...saved, enabled: false }, saved)).toBe(false);
    expect(samePricing({ ...saved, slabs: saved.slabs.slice(1) }, saved)).toBe(false);
    expect(pricingDraftProblem(saved)).toBeNull();
    expect(permissionSlabsOf(saved)).toEqual([PERMISSION_SLABS[0], PERMISSION_SLABS[1]]);
  });

  it("sends exactly the three company-wide keys, the rows in ascending order", () => {
    const payload = pricingPayload({
      ...saved,
      allowance: " 2 ",
      slabs: [
        { fromPermissions: "6", deductionShifts: "1" },
        { fromPermissions: "1", deductionShifts: "0.25" },
      ],
    });
    expect(Object.keys(payload).sort()).toEqual([
      "permissionDeductionSlabs",
      "permissionFreeAllowance",
      "permissionPricingEnabled",
    ]);
    expect(payload).toEqual({
      permissionPricingEnabled: true,
      permissionFreeAllowance: 2,
      permissionDeductionSlabs: [PERMISSION_SLABS[0], PERMISSION_SLABS[2]],
    });
  });

  it("lists what changed for the confirm, every line marked as pay", () => {
    expect(pricingChanges(saved, saved)).toEqual([]);
    const changes = pricingChanges({ ...saved, enabled: false, allowance: "3", slabs: [] }, saved);
    expect(changes.map((c) => [c.label, c.from, c.to])).toEqual([
      ["Price permissions separately", "On", "Off"],
      ["Free permissions", "1 a month", "3 a month"],
      ["Permission deduction slabs", "1 → 0.25, 3 → 0.5", "no slabs (nothing deducted)"],
    ]);
    expect(changes.every((c) => c.money)).toBe(true);
  });
});
