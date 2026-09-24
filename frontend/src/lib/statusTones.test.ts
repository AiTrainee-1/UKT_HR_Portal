import { describe, expect, it } from "vitest";
import {
  ATTENDANCE_STATUS_TONE,
  REQUEST_STATUS_TONE,
  TONE,
  attendanceStatusClass,
  requestStatusClass,
  toneClass,
} from "./statusTones";

describe("statusTones", () => {
  it("gives every tone one full bg/text/border class triple", () => {
    for (const cls of Object.values(TONE)) {
      expect(cls).toMatch(/^bg-\w+-100 text-\w+-\d+ border-\w+-200$/);
    }
  });

  it("uses a single green for success (was two different greens across pages)", () => {
    expect(TONE.success).toContain("bg-green-100");
    expect(TONE.success).toContain("text-green-800");
  });

  it("maps every attendance verdict to a tone, with On Leave consistently blue", () => {
    expect(Object.keys(ATTENDANCE_STATUS_TONE).sort()).toEqual([
      "absent",
      "half_shift",
      "holiday",
      "on_leave",
      "present",
    ]);
    expect(attendanceStatusClass("present")).toBe(TONE.success);
    expect(attendanceStatusClass("absent")).toBe(TONE.danger);
    expect(attendanceStatusClass("on_leave")).toBe(TONE.info);
  });

  it("maps the approval workflow statuses", () => {
    expect(requestStatusClass("pending")).toBe(TONE.warning);
    expect(requestStatusClass("approved")).toBe(TONE.success);
    expect(requestStatusClass("rejected")).toBe(TONE.danger);
  });

  it("falls back to neutral for unknown, empty or missing statuses", () => {
    expect(toneClass(REQUEST_STATUS_TONE, "something_new")).toBe(TONE.neutral);
    expect(toneClass(REQUEST_STATUS_TONE, "")).toBe(TONE.neutral);
    expect(toneClass(REQUEST_STATUS_TONE, null)).toBe(TONE.neutral);
    expect(toneClass(REQUEST_STATUS_TONE, undefined)).toBe(TONE.neutral);
  });
});
