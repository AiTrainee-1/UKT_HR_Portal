import { describe, expect, it } from "vitest";
import {
  PERMISSION_TYPES,
  clockMinutes,
  halfDayWorked,
  isEarlyOutDay,
  latePoolView,
  lateDetectionFlags,
  normalizeHalf,
  normalizePermissionType,
  permissionOutcome,
  permissionTypeKey,
  permissionTypeLabel,
  permissionTypeWire,
  validateHalfDayTimes,
} from "./late-detection";

describe("clock times", () => {
  it("reads HH:MM and HH:MM:SS, and nothing else", () => {
    expect(clockMinutes("13:30")).toBe(810);
    expect(clockMinutes("08:32:59")).toBe(512);
    expect(clockMinutes("0:05")).toBe(5);
    expect(clockMinutes("")).toBeNull();
    expect(clockMinutes(null)).toBeNull();
    expect(clockMinutes("24:00")).toBeNull();
    expect(clockMinutes("12:60")).toBeNull();
    expect(clockMinutes("noon")).toBeNull();
  });

  it("accepts a Half-Day pair where the Morning half ends before, or exactly when, the Evening half starts", () => {
    expect(validateHalfDayTimes("13:30", "14:30")).toBeNull();
    expect(validateHalfDayTimes("14:00", "14:00")).toBeNull();
  });

  it("rejects a Morning half that ends after the Evening half starts", () => {
    expect(validateHalfDayTimes("15:00", "14:30")).toMatch(/must not be later/);
    expect(validateHalfDayTimes("14:31", "14:30")).toMatch(/must not be later/);
  });

  it("rejects a blank or malformed time instead of letting the server refuse it", () => {
    expect(validateHalfDayTimes("", "14:30")).toMatch(/Enter both/);
    expect(validateHalfDayTimes("13:30", null)).toMatch(/Enter both/);
    expect(validateHalfDayTimes("13:30", "later")).toMatch(/Enter both/);
  });
});

describe("which half a Half Day was worked", () => {
  it("is the Morning half when the first punch is before First Half End", () => {
    expect(halfDayWorked("08:32")).toBe("morning");
    expect(halfDayWorked("13:29:59")).toBe("morning");
  });

  it("is the Evening half from First Half End on, including a first punch inside the lunch gap", () => {
    expect(halfDayWorked("13:30")).toBe("evening");
    expect(halfDayWorked("14:00")).toBe("evening"); // before Second Half Start, but no Morning punch exists
    expect(halfDayWorked("15:10")).toBe("evening");
  });

  it("follows a custom First Half End, and falls back to 13:30 for a bad one", () => {
    expect(halfDayWorked("12:45", "12:30")).toBe("evening");
    expect(halfDayWorked("12:45", "13:00")).toBe("morning");
    expect(halfDayWorked("13:10", "")).toBe("morning");
    expect(halfDayWorked("13:40", "not a time")).toBe("evening");
  });

  it("cannot say without a first punch", () => {
    expect(halfDayWorked(null)).toBeNull();
    expect(halfDayWorked("")).toBeNull();
  });

  it("reads the Attendance Sheet's 'afternoon' as the Evening half", () => {
    expect(normalizeHalf("morning")).toBe("morning");
    expect(normalizeHalf("afternoon")).toBe("evening");
    expect(normalizeHalf("evening")).toBe("evening");
    expect(normalizeHalf(null)).toBeNull();
    expect(normalizeHalf("night")).toBeNull();
  });
});

describe("a day's flags", () => {
  it("has none on an ordinary day", () => {
    expect(lateDetectionFlags({ status: "present", isLate: false })).toEqual([]);
    expect(lateDetectionFlags({})).toEqual([]);
  });

  it("raises Late and Early Out only for a day somebody worked", () => {
    expect(lateDetectionFlags({ status: "present", isLate: true, isEarlyOut: true }).map((f) => f.key)).toEqual([
      "late",
      "earlyOut",
    ]);
    expect(lateDetectionFlags({ status: "half_shift", isHalfShift: true, isLate: true }).map((f) => f.key)).toContain(
      "late",
    );
    // A manual override to Absent can leave a stale late mark behind; it must not surface.
    expect(lateDetectionFlags({ status: "absent", isLate: true, isEarlyOut: true })).toEqual([]);
    expect(lateDetectionFlags({ status: "on_leave", isLate: true })).toEqual([]);
  });

  it("reads an early out whichever way the endpoint spells it", () => {
    expect(isEarlyOutDay({ isEarlyOut: true })).toBe(true);
    expect(isEarlyOutDay({ earlyLeave: true })).toBe(true);
    expect(isEarlyOutDay({ isEarlyOut: false, earlyLeave: true })).toBe(false); // the new key wins when present
    expect(isEarlyOutDay({})).toBe(false);
    expect(lateDetectionFlags({ status: "present", earlyLeave: true }).map((f) => f.key)).toEqual(["earlyOut"]);
  });

  it("uses the server's reason as the tooltip, else explains the rule", () => {
    const [withReason] = lateDetectionFlags({ isLate: true, lateReason: "  Morning Late-In: 09:40 is after 09:15 " });
    expect(withReason.title).toBe("Morning Late-In: 09:40 is after 09:15");
    const [without] = lateDetectionFlags({ isLate: true, lateReason: null });
    expect(without.title).toMatch(/shift start plus grace/);
    const [blank] = lateDetectionFlags({ isLate: true, lateReason: "   " });
    expect(blank.title).toMatch(/shift start plus grace/);
  });

  it("treats the lunch-return lateness as its own informational flag, not as Late", () => {
    const flags = lateDetectionFlags({ status: "present", isLate: false, lateAfternoon: true });
    expect(flags.map((f) => f.key)).toEqual(["lateAfternoon"]);
    expect(flags[0].title).toMatch(/Informational/);
  });

  it("names the half of a Half Day from the first punch, or from the sheet's own answer", () => {
    expect(lateDetectionFlags({ status: "half_shift", isHalfShift: true, firstPunch: "08:45" })[0]).toMatchObject({
      kind: "halfDay",
      label: "Morning half only",
    });
    expect(lateDetectionFlags({ status: "half_shift", isHalfShift: true, firstPunch: "15:00" })[0].label).toBe(
      "Evening half only",
    );
    // The sheet says "afternoon" and knows better than a first punch.
    expect(lateDetectionFlags({ status: "half_shift", halfDayPeriod: "afternoon", firstPunch: "08:45" })[0].label).toBe(
      "Evening half only",
    );
  });

  it("stays quiet about a Half Shift whose half it cannot tell, but names a half-flagged day that is not one", () => {
    expect(lateDetectionFlags({ status: "half_shift", isHalfShift: true })).toEqual([]);
    expect(lateDetectionFlags({ status: "present", isHalfShift: true })[0]).toMatchObject({ label: "Half Day" });
  });

  it("quotes the configured Second Half Start in the half's tooltip", () => {
    const [flag] = lateDetectionFlags(
      { status: "half_shift", firstPunch: "08:45" },
      { firstHalfEnd: "13:00", secondHalfStart: "14:00" },
    );
    expect(flag.title).toContain("at or after 14:00");
  });

  it("names the half from the day's arrival zone, before any clock time", () => {
    // 12:30 is before the retired fixed 13:30 cut-off, but the day says the first half was missed
    const [late] = lateDetectionFlags({ status: "half_shift", firstPunch: "12:30", arrivalZone: "second_half" });
    expect(late.label).toBe("Evening half only");
    expect(late.title).toContain("first-half limit");
    const [early] = lateDetectionFlags({ status: "half_shift", firstPunch: "11:00", arrivalZone: "quarter" });
    expect(early.label).toBe("Morning half only");
    expect(halfDayWorked("12:30", "13:30", "second_half")).toBe("evening");
    expect(halfDayWorked("12:30", "13:30", "on_time")).toBe("morning");
    expect(halfDayWorked("12:30", "13:30")).toBe("morning"); // no zone: the retired fixed cut-off
  });

  it("flags a quarter-shift arrival, and never as Late", () => {
    const flags = lateDetectionFlags({
      status: "present",
      isLate: false,
      arrivalZone: "quarter",
      lateReason: "Quarter-shift arrival: first punch 11:00 ...",
    });
    expect(flags.map((f) => f.kind)).toEqual(["quarterShift"]);
    expect(flags[0]).toMatchObject({ label: "Quarter shift", detail: "late arrival" });
    expect(flags[0].title).toContain("Quarter-shift arrival: first punch 11:00");
    expect(lateDetectionFlags({ status: "present", arrivalZone: "late", isLate: true }).map((f) => f.kind)).toEqual([
      "late",
    ]);
  });

  it("shows an Allowed permission per edge, and both together", () => {
    const [morning] = lateDetectionFlags({ morningPermissionApplied: true });
    expect(morning).toMatchObject({
      kind: "permissionApplied",
      label: "Allowed permission applied",
      detail: "Morning",
    });
    expect(morning.title).toContain("excused the arrival up to the end of the permission window");
    const [evening] = lateDetectionFlags({ eveningPermissionApplied: true });
    expect(evening.detail).toBe("Evening");
    expect(evening.title).toContain("shift end 60 minutes earlier");
    const [both] = lateDetectionFlags({ morningPermissionApplied: true, eveningPermissionApplied: true });
    expect(both.detail).toBe("Morning + Evening");
  });

  it("shows an Excess permission as one that did not protect the day", () => {
    const [flag] = lateDetectionFlags({ status: "present", isLate: false, morningPermissionExcess: true });
    expect(flag).toMatchObject({ kind: "permissionExcess", label: "Excess permission" });
    expect(flag.detail).toBe("did not protect the day");
    expect(flag.title).toContain("Morning permission approved, but beyond the monthly cap");
    const [evening] = lateDetectionFlags({ eveningPermissionExcess: true });
    expect(evening.title).toContain("Evening permission");
  });

  it("shows a late day with an Excess permission as both, and the middle permission on its own", () => {
    const keys = lateDetectionFlags({ status: "present", isLate: true, morningPermissionExcess: true }).map(
      (f) => f.key,
    );
    expect(keys).toEqual(["late", "permExcess"]);
    expect(lateDetectionFlags({ middlePermissionToday: true }).map((f) => f.label)).toEqual(["Middle One-Hour"]);
  });

  it("orders Late, Early Out, half, permissions", () => {
    const keys = lateDetectionFlags({
      status: "half_shift",
      firstPunch: "09:00",
      isLate: true,
      isEarlyOut: true,
      morningPermissionApplied: true,
      eveningPermissionExcess: true,
      middlePermissionToday: true,
      permissionAfternoon: true,
    }).map((f) => f.key);
    expect(keys).toEqual(["late", "earlyOut", "half", "permApplied", "permExcess", "permMiddle", "permAfternoon"]);
  });
});

describe("permission types", () => {
  it("offers exactly the three types", () => {
    expect(PERMISSION_TYPES.map((t) => t.key)).toEqual(["morning_late_in", "evening_early_out", "middle_permission"]);
    expect(PERMISSION_TYPES.map((t) => t.label)).toEqual([
      "Morning Late-In",
      "Evening Early-Out",
      "Middle One-Hour Permission",
    ]);
  });

  it("recognises every spelling the API has used", () => {
    expect(normalizePermissionType("morning_late_in")).toBe("morning_late_in");
    expect(normalizePermissionType("Late In")).toBe("morning_late_in");
    expect(normalizePermissionType("late-in")).toBe("morning_late_in");
    expect(normalizePermissionType("Early Out")).toBe("evening_early_out");
    expect(normalizePermissionType("EVENING_EARLY_OUT")).toBe("evening_early_out");
    expect(normalizePermissionType("Short Leave")).toBe("middle_permission");
    expect(normalizePermissionType("Middle One-Hour Permission")).toBe("middle_permission");
    expect(normalizePermissionType("lunch break")).toBeNull();
    expect(normalizePermissionType("constructor")).toBeNull(); // not a key inherited from Object.prototype
    expect(normalizePermissionType("")).toBeNull();
    expect(normalizePermissionType(null)).toBeNull();
  });

  it("labels a request from typeLabel, then typeKey, then the deprecated type; null when untyped", () => {
    expect(permissionTypeLabel({ typeLabel: "Morning Late-In", typeKey: "morning_late_in", type: "Late In" })).toBe(
      "Morning Late-In",
    );
    expect(permissionTypeLabel({ typeKey: "evening_early_out" })).toBe("Evening Early-Out");
    expect(permissionTypeLabel({ type: "Short Leave" })).toBe("Middle One-Hour Permission");
    expect(permissionTypeLabel({ typeLabel: null, typeKey: null, type: null })).toBeNull();
    expect(permissionTypeLabel({})).toBeNull();
  });
});

describe("a permission's type on the wire and in the row", () => {
  it("sends the pre-rewrite spelling for every type, which both backends accept", () => {
    expect(permissionTypeWire("morning_late_in")).toBe("Late In");
    expect(permissionTypeWire("evening_early_out")).toBe("Early Out");
    expect(permissionTypeWire("middle_permission")).toBe("Short Leave");
    // ... and it round-trips through the normaliser, so what we send is read back as the same type.
    for (const t of PERMISSION_TYPES) expect(normalizePermissionType(permissionTypeWire(t.key))).toBe(t.key);
  });

  it("finds a row's type from typeKey, else from the legacy `type` an older backend sends", () => {
    expect(permissionTypeKey({ typeKey: "evening_early_out", type: "Late In" })).toBe("evening_early_out");
    expect(permissionTypeKey({ type: "Late In" })).toBe("morning_late_in"); // no typeKey at all: older backend
    expect(permissionTypeKey({ typeKey: null, type: "Short Leave" })).toBe("middle_permission");
    expect(permissionTypeKey({ typeKey: null, type: null })).toBeNull();
    expect(permissionTypeKey({})).toBeNull();
  });
});

describe("a permission's outcome", () => {
  it("is Pending until decided", () => {
    expect(permissionOutcome({ status: "pending", capStatus: "not_applicable", statusLabel: "Pending" })).toMatchObject(
      { label: "Pending", tone: "warning" },
    );
  });

  it("is Not Allowed once rejected", () => {
    expect(permissionOutcome({ status: "rejected", capStatus: "not_applicable" })).toMatchObject({
      label: "Not Allowed",
      tone: "danger",
    });
  });

  it("is Allowed when approved within the cap, and says what it moved", () => {
    const morning = permissionOutcome({ status: "approved", capStatus: "within_cap", typeKey: "morning_late_in" });
    expect(morning).toMatchObject({ label: "Allowed", tone: "success" });
    expect(morning.explanation).toContain("shift start moves 60 minutes later");
    expect(
      permissionOutcome({ status: "approved", capStatus: "within_cap", typeKey: "evening_early_out" }).explanation,
    ).toContain("shift end moves 60 minutes earlier");
    expect(
      permissionOutcome({ status: "approved", capStatus: "within_cap", typeKey: "middle_permission" }).explanation,
    ).toContain("nothing moves");
  });

  it("warns that an Allowed permission with no type cannot move anything", () => {
    expect(permissionOutcome({ status: "approved", capStatus: "within_cap", typeKey: null }).explanation).toContain(
      "no type yet",
    );
  });

  it("is Overdue / Excess when approved beyond the cap, in a tone distinct from Not Allowed", () => {
    const excess = permissionOutcome({
      status: "approved",
      capStatus: "excess",
      monthlyLimit: 3,
      typeKey: "morning_late_in",
    });
    expect(excess).toMatchObject({ label: "Overdue / Excess", tone: "caution" });
    expect(excess.tone).not.toBe(permissionOutcome({ status: "rejected" }).tone);
    expect(excess.explanation).toContain("beyond the monthly cap of 3");
    expect(excess.explanation).toContain("does not move the shift boundary");
  });

  it("says only 'Approved' -never 'Allowed' -when the server does not report the cap", () => {
    const older = permissionOutcome({ status: "approved", type: "Late In" });
    expect(older.label).toBe("Approved");
    expect(older.explanation).toBe(""); // no claim about what it moved
    expect(permissionOutcome({ status: "approved", capStatus: null }).label).toBe("Approved");
    expect(permissionOutcome({ status: "approved", capStatus: "not_applicable" }).label).toBe("Approved");
    // Pending on such a backend does not lecture about a cap it does not have.
    expect(permissionOutcome({ status: "pending" }).explanation).toBe("Waiting for a decision.");
  });

  it("prefers the server's own label", () => {
    expect(permissionOutcome({ status: "approved", capStatus: "excess", statusLabel: "Overdue / Excess" }).label).toBe(
      "Overdue / Excess",
    );
    expect(permissionOutcome({ status: "approved", capStatus: "within_cap", statusLabel: "Allowed" }).label).toBe(
      "Allowed",
    );
  });

  it("carries the tone's classes, so the badge and the tone can never disagree", () => {
    expect(permissionOutcome({ status: "approved", capStatus: "within_cap" }).className).toContain("bg-green-100");
    expect(permissionOutcome({ status: "approved", capStatus: "excess" }).className).toContain("bg-orange-100");
    expect(permissionOutcome({ status: "rejected" }).className).toContain("bg-red-100");
  });
});

describe("the monthly late pool", () => {
  it("lays out a current payslip's split", () => {
    const v = latePoolView({
      lateInCount: 3,
      earlyOutCount: 2,
      excessPermissionCount: 1,
      totalLateCount: 6,
      freeAllowanceUsed: 3,
      billableLateCount: 3,
      shiftDeductions: 0.5,
      lateInDays: 4,
      earlyOutDays: 2,
      freeAllowance: 3,
      permissionMonthlyCap: 3,
    })!;
    expect(v).toMatchObject({
      detailed: true,
      lateIn: 3,
      earlyOut: 2,
      excess: 1,
      total: 6,
      freeAllowance: 3,
      freeUsed: 3,
      billable: 3,
      shifts: 0.5,
      permissionCap: 3,
    });
    // 4 late days flagged but only 3 counted: one of them is the day of an Excess permission.
    expect(v.mergedIntoExcess).toBe(true);
  });

  it("does not claim a merge when flagged days and counts agree", () => {
    const v = latePoolView({
      lateInCount: 2,
      earlyOutCount: 0,
      excessPermissionCount: 0,
      lateInDays: 2,
      earlyOutDays: 0,
    })!;
    expect(v.mergedIntoExcess).toBe(false);
    expect(v.total).toBe(2);
  });

  it("falls back to the total alone for a payslip generated before the split", () => {
    const v = latePoolView({ totalLateCount: 5, billableLateCount: 2, shiftDeductions: 0.25 })!;
    expect(v).toMatchObject({
      detailed: false,
      lateIn: null,
      earlyOut: null,
      excess: null,
      total: 5,
      freeUsed: null,
      freeAllowance: null,
      billable: 2,
      shifts: 0.25,
      permissionCap: null,
      lateInDays: null,
      earlyOutDays: null,
      mergedIntoExcess: false,
    });
  });

  it("never yields NaN or undefined from a sparse summary", () => {
    const v = latePoolView({})!;
    expect(v).toMatchObject({ detailed: false, total: 0, billable: 0, shifts: 0 });
    expect(Object.values(v).some((x) => x === undefined || Number.isNaN(x))).toBe(false);
    expect(latePoolView(null)).toBeNull();
    expect(latePoolView(undefined)).toBeNull();
  });

  it("derives the pool total, free use and billable count from the parts when the API sends no totals", () => {
    // employee-shift-stats sends the split and the allowance, but its totalLateCount is late-in days only.
    const v = latePoolView({
      lateInCount: 2,
      earlyOutCount: 1,
      excessPermissionCount: 2,
      freeAllowance: 3,
      shiftDeductions: "0.25",
    })!;
    expect(v).toMatchObject({ total: 5, freeUsed: 3, billable: 2, shifts: 0.25 });
  });

  it("reads the shift deduction whether it arrives as a number or a decimal string", () => {
    expect(latePoolView({ shiftDeductions: "0.75" })!.shifts).toBe(0.75);
    expect(latePoolView({ shiftDeductions: 1 })!.shifts).toBe(1);
    expect(latePoolView({ shiftDeductions: "junk" })!.shifts).toBe(0);
  });
});
