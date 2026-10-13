import { describe, expect, it } from "vitest";
import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import {
  carriedKeysFrom,
  firstError,
  sameStaff,
  staffAccess,
  staffChanges,
  staffDraftFrom,
  staffPayload,
  validateStaff,
} from "./form";

const SERVER: Partial<PayrollSettingsItem> = {
  attendanceMode: "strict",
  simpleHalfShiftCutoff: "13:30",
  morningLateInEnabled: true,
  eveningEarlyOutEnabled: false,
  halfDayFirstHalfEndTime: "13:30",
  halfDaySecondHalfStartTime: "14:30",
  arrivalLateWindowMinutes: 60,
  arrivalPermissionWindowMinutes: 60,
  arrivalExtraMinutes: 20,
  arrivalQuarterDeduction: 0.25,
  afternoonLateWindowMinutes: 60,
  afternoonPermissionWindowMinutes: 60,
  lastPunchPostShiftGraceHours: 9,
  firstPunchPreShiftBufferHours: 2,
  prodFirstHalfStart: "08:30",
  prodFirstHalfEnd: "12:30",
  prodSecondHalfStart: "13:30",
  prodSecondHalfEnd: "17:30",
  prodExtraStart: "17:50",
  prodExtraEnd: "20:00",
  defaultShiftGraceMinutes: 15,
  defaultShiftFirstHalfEnd: "13:30",
  defaultShiftLunchDurationMinutes: 60,
  defaultShiftLunchGraceMinutes: 10,
  companyWideRulesEditable: true,
};

const saved = staffDraftFrom(SERVER);
const carried = carriedKeysFrom(SERVER);
const access = staffAccess(SERVER);

describe("loading", () => {
  it("reads every Staff setting as the text its box shows", () => {
    expect(saved).toEqual({
      attendanceMode: "strict",
      morningLateInEnabled: true,
      eveningEarlyOutEnabled: false,
      secondHalfStart: "14:30",
      lateWindow: "60",
      permissionWindow: "60",
      extraMinutes: "20",
      quarterDeduction: "0.25",
      nightLateWindow: "60",
      lunchPermissionZone: "60",
      forgottenExitHours: "9",
      earlyArrivalProtectionHours: "2",
    });
  });

  it("says what an older backend or a branch login cannot change", () => {
    expect(access).toEqual({
      companyWideEditable: true,
      halfDayReported: true,
      arrivalReported: true,
      morningReported: true,
      eveningReported: true,
    });
    const old = staffAccess({ attendanceMode: "simple" });
    expect(old).toMatchObject({ halfDayReported: false, arrivalReported: false, morningReported: false });
    expect(staffDraftFrom({}).morningLateInEnabled).toBeNull();
    expect(staffAccess({ ...SERVER, companyWideRulesEditable: false }).companyWideEditable).toBe(false);
  });
});

describe("the Save Attendance Settings request", () => {
  it("sends the same keys as always, the dead ones exactly as loaded, and a switch only when it changed", () => {
    const body = staffPayload({ ...saved, lateWindow: "45" }, saved, carried, access);
    expect(Object.keys(body).sort()).toEqual(
      [
        "attendanceMode",
        "simpleHalfShiftCutoff",
        "halfDaySecondHalfStartTime",
        "arrivalLateWindowMinutes",
        "arrivalPermissionWindowMinutes",
        "arrivalExtraMinutes",
        "arrivalQuarterDeduction",
        "afternoonLateWindowMinutes",
        "afternoonPermissionWindowMinutes",
        "lastPunchPostShiftGraceHours",
        "firstPunchPreShiftBufferHours",
        "prodFirstHalfStart",
        "prodFirstHalfEnd",
        "prodSecondHalfStart",
        "prodSecondHalfEnd",
        "prodExtraStart",
        "prodExtraEnd",
        "defaultShiftGraceMinutes",
        "defaultShiftFirstHalfEnd",
        "defaultShiftLunchDurationMinutes",
        "defaultShiftLunchGraceMinutes",
      ].sort(),
    );
    expect(body).toMatchObject({
      arrivalLateWindowMinutes: 45,
      arrivalQuarterDeduction: 0.25,
      lastPunchPostShiftGraceHours: 9,
      defaultShiftGraceMinutes: 15,
      prodExtraEnd: "20:00",
    });
    expect("halfDayFirstHalfEndTime" in body).toBe(false);

    const flipped = staffPayload({ ...saved, eveningEarlyOutEnabled: true }, saved, carried, access);
    expect(flipped.eveningEarlyOutEnabled).toBe(true);
    expect("morningLateInEnabled" in flipped).toBe(false);
  });

  it("leaves the company-wide rules out for a branch login and for what the server did not report", () => {
    const branch = staffPayload(
      { ...saved, eveningEarlyOutEnabled: true },
      saved,
      carried,
      staffAccess({ ...SERVER, companyWideRulesEditable: false }),
    );
    for (const key of [
      "morningLateInEnabled",
      "eveningEarlyOutEnabled",
      "halfDaySecondHalfStartTime",
      "arrivalLateWindowMinutes",
      "arrivalQuarterDeduction",
    ]) {
      expect(key in branch).toBe(false);
    }
    expect(branch.afternoonLateWindowMinutes).toBe(60);

    const old = staffAccess({ ...SERVER, halfDaySecondHalfStartTime: undefined, arrivalLateWindowMinutes: undefined });
    const body = staffPayload(saved, saved, carried, old);
    expect("halfDaySecondHalfStartTime" in body).toBe(false);
    expect("arrivalLateWindowMinutes" in body).toBe(false);
  });

  it("falls back to the tab's old defaults for the carried keys", () => {
    expect(carriedKeysFrom({})).toEqual({
      simpleHalfShiftCutoff: "13:30",
      prodFirstHalfStart: "08:30",
      prodFirstHalfEnd: "12:30",
      prodSecondHalfStart: "13:30",
      prodSecondHalfEnd: "17:30",
      prodExtraStart: "17:50",
      prodExtraEnd: "20:00",
      defaultShiftGraceMinutes: 15,
      defaultShiftFirstHalfEnd: "13:30",
      defaultShiftLunchDurationMinutes: 60,
      defaultShiftLunchGraceMinutes: 10,
    });
  });
});

describe("checks before saving", () => {
  it("accepts the saved values", () => {
    expect(validateStaff(saved, access)).toEqual({});
    expect(firstError(validateStaff(saved, access))).toBeNull();
  });

  it("names the arrival number that is wrong, with the server's own message", () => {
    const errors = validateStaff({ ...saved, lateWindow: "300" }, access);
    expect(errors.arrival).toBe("Late window must be a whole number of minutes between 0 and 240.");
    expect(errors.lateWindow).toBeTruthy();
    expect(errors.permissionWindow).toBeUndefined();
    expect(validateStaff({ ...saved, quarterDeduction: "1.5" }, access).quarterDeduction).toBe(
      "Quarter-shift deduction must be between 0 and 1 shift, with at most 2 decimals.",
    );
    expect(validateStaff({ ...saved, extraMinutes: "" }, access).extraMinutes).toBeTruthy();
  });

  it("checks Second Half Start, the lunch numbers and the hours (one decimal, 0-24)", () => {
    expect(validateStaff({ ...saved, secondHalfStart: "" }, access).secondHalfStart).toBe(
      "Enter Second Half Start as a valid clock time.",
    );
    expect(validateStaff({ ...saved, nightLateWindow: "12.5" }, access).nightLateWindow).toBeTruthy();
    expect(validateStaff({ ...saved, lunchPermissionZone: "-5" }, access).lunchPermissionZone).toBeTruthy();
    expect(validateStaff({ ...saved, forgottenExitHours: "9.25" }, access).forgottenExitHours).toBeTruthy();
    expect(validateStaff({ ...saved, forgottenExitHours: "9.5" }, access).forgottenExitHours).toBeUndefined();
    expect(
      validateStaff({ ...saved, earlyArrivalProtectionHours: "25" }, access).earlyArrivalProtectionHours,
    ).toBeTruthy();
    expect(validateStaff({ ...saved, nightLateWindow: "0" }, access)).toEqual({});
  });

  it("does not judge company-wide rules this login cannot change", () => {
    const branch = staffAccess({ ...SERVER, companyWideRulesEditable: false });
    expect(validateStaff({ ...saved, lateWindow: "300", secondHalfStart: "" }, branch)).toEqual({});
  });
});

describe("what changed", () => {
  it("compares numbers as numbers and lists each change with its saved and new value", () => {
    expect(sameStaff({ ...saved, quarterDeduction: "0.250" }, saved)).toBe(true);
    expect(sameStaff({ ...saved, lateWindow: "" }, saved)).toBe(false);
    const changes = staffChanges({ ...saved, lateWindow: "45", attendanceMode: "simple" }, saved);
    expect(changes).toEqual([
      { key: "attendanceMode", label: "Attendance calculation mode", from: "Strict", to: "Simple", money: false },
      { key: "lateWindow", label: "Late window", from: "60 minutes", to: "45 minutes", money: true },
    ]);
  });
});
