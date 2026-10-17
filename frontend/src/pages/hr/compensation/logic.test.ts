import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  COMPENSATION_URL_DEFAULTS,
  MASTER_SWITCH_HREF,
  SHIFT_CHOICES,
  addDays,
  addMonths,
  clock12,
  compensationSettingsHref,
  countOf,
  dateLong,
  dateShort,
  errorMessage,
  errorStatus,
  fmtShifts,
  isIsoDate,
  isLeavePart,
  leavePartOf,
  isShiftsValue,
  isSunday,
  matchesText,
  minutesText,
  monthBounds,
  monthYear,
  monthYearFromUrl,
  problemsOf,
  rangeLabel,
  sameMonth,
  settingsHref,
  shiftsText,
  sumShifts,
  todayIst,
  yearChoices,
} from "./logic";

const apiError = (status: number, body: unknown = null) =>
  new ApiError(new Response(null, { status, statusText: String(status) }), body, { method: "GET", url: "/x" });

// The pure helpers shared by the pages of Compensation: the address, shifts, dates and what a failed request says.

describe("the address", () => {
  it("keeps every key of the page with an empty or default value, so a fresh page has a clean address", () => {
    // the page and its subtab are the path, no longer keys of the query string
    expect("tab" in COMPENSATION_URL_DEFAULTS).toBe(false);
    expect("sub" in COMPENSATION_URL_DEFAULTS).toBe(false);
    expect(COMPENSATION_URL_DEFAULTS.period).toBe("today");
    expect(COMPENSATION_URL_DEFAULTS.bperiod).toBe("today");
    expect(COMPENSATION_URL_DEFAULTS.month).toBe("");
    expect(Object.values(COMPENSATION_URL_DEFAULTS).every((v) => typeof v === "string")).toBe(true);
  });

  it("knows the three parts of Compensation Leave an old address names", () => {
    for (const part of ["windows", "holiday-work", "birthdays"]) expect(isLeavePart(part)).toBe(true);
    expect(isLeavePart("balance")).toBe(false);
    expect(isLeavePart("holiday")).toBe(false);
  });

  it("reads the part an old address asks for, with the link of the Requests hub, other spellings and a fallback", () => {
    expect(leavePartOf("holiday-work")).toBe("holiday-work");
    expect(leavePartOf("birthdays")).toBe("birthdays");
    expect(leavePartOf("holiday")).toBe("holiday-work");
    expect(leavePartOf("Holiday_Work")).toBe("holiday-work");
    expect(leavePartOf("birthday")).toBe("birthdays");
    expect(leavePartOf("")).toBe("windows");
    expect(leavePartOf("nonsense")).toBe("windows");
  });

  it("links to a setting of the Settings page, and to the master switch", () => {
    expect(settingsHref("compensation")).toBe("/hr/settings?tab=compensation");
    expect(compensationSettingsHref("shift-enabled")).toBe("/hr/settings?tab=compensation#shift-enabled");
    expect(MASTER_SWITCH_HREF).toBe("/hr/settings?tab=payroll#compensation-features");
  });
});

describe("shifts", () => {
  it("offers a quarter, a half, three quarters and one", () => {
    expect([...SHIFT_CHOICES]).toEqual([0.25, 0.5, 0.75, 1]);
    expect(isShiftsValue(0.5)).toBe(true);
    expect(isShiftsValue(0.6)).toBe(false);
    expect(isShiftsValue("0.5")).toBe(false);
    expect(isShiftsValue(null)).toBe(false);
  });

  it("writes them with two decimals, except a whole number", () => {
    expect(fmtShifts(0.25)).toBe("0.25");
    expect(fmtShifts(0.5)).toBe("0.50");
    expect(fmtShifts(1)).toBe("1");
    expect(fmtShifts(1.5)).toBe("1.50");
    expect(fmtShifts(null)).toBe("—");
  });

  it("says one shift in the singular and everything else in the plural", () => {
    expect(shiftsText(1)).toBe("1 shift");
    expect(shiftsText(0.5)).toBe("0.50 shifts");
    expect(shiftsText(2)).toBe("2 shifts");
    expect(shiftsText(undefined)).toBe("—");
  });

  it("adds shifts without float dust", () => {
    expect(sumShifts([0.1, 0.2])).toBe(0.3);
    expect(sumShifts([0.25, 0.75, null, undefined])).toBe(1);
    expect(sumShifts([])).toBe(0);
  });
});

describe("dates", () => {
  it("works out today in India, whatever the browser's own zone", () => {
    expect(todayIst(new Date("2026-10-14T06:00:00Z"))).toBe("2026-10-14");
    // 20:00 UTC is already the next morning in India
    expect(todayIst(new Date("2026-10-14T20:00:00Z"))).toBe("2026-10-15");
    // 18:29 UTC is still the same evening, 18:30 UTC is midnight
    expect(todayIst(new Date("2026-10-14T18:29:00Z"))).toBe("2026-10-14");
    expect(todayIst(new Date("2026-10-14T18:30:00Z"))).toBe("2026-10-15");
  });

  it("validates a real calendar day", () => {
    expect(isIsoDate("2026-10-14")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("14-10-2026")).toBe(false);
    expect(isIsoDate("")).toBe(false);
  });

  it("steps days and months, keeping the day of the month where it exists", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-14", -7)).toBe("2026-10-07");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-10-14", -1)).toBe("2026-09-14");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });

  it("finds the month a day is in, and whether two days share it", () => {
    expect(monthBounds("2026-10-14")).toEqual({ first: "2026-10-01", last: "2026-10-31" });
    expect(monthBounds("2028-02-10")).toEqual({ first: "2028-02-01", last: "2028-02-29" });
    expect(monthBounds("nonsense")).toBeNull();
    expect(sameMonth("2026-10-01", "2026-10-31")).toBe(true);
    expect(sameMonth("2026-10-31", "2026-11-01")).toBe(false);
    expect(sameMonth("2025-10-05", "2026-10-05")).toBe(false);
  });

  it("knows a Sunday", () => {
    expect(isSunday("2026-10-11")).toBe(true);
    expect(isSunday("2026-10-12")).toBe(false);
  });

  it("writes days and ranges for people", () => {
    expect(dateShort("2026-10-14")).toBe("14 Oct 2026");
    expect(dateLong("2026-10-14")).toBe("Wed, 14 Oct 2026");
    expect(dateShort(null)).toBe("—");
    expect(rangeLabel("2026-10-12", "2026-10-18")).toBe("12 Oct - 18 Oct 2026");
    expect(rangeLabel("2026-12-29", "2027-01-04")).toBe("29 Dec 2026 - 4 Jan 2027");
    expect(rangeLabel("2026-10-14", "2026-10-14")).toBe("14 Oct 2026");
    expect(monthYear(10, 2026)).toBe("October 2026");
  });

  it("writes clock times and durations", () => {
    expect(clock12("17:30")).toBe("5:30 PM");
    expect(clock12("00:15")).toBe("12:15 AM");
    expect(clock12("12:00")).toBe("12:00 PM");
    expect(clock12(null)).toBe("—");
    expect(minutesText(30)).toBe("30 min");
    expect(minutesText(60)).toBe("1 h");
    expect(minutesText(90)).toBe("1 h 30 min");
    expect(minutesText(null)).toBe("—");
    expect(countOf(1, "claim")).toBe("1 claim");
    expect(countOf(3, "claim")).toBe("3 claims");
  });

  it("takes the month and year from the address, else the current month", () => {
    expect(monthYearFromUrl("", "", "2026-10-14")).toEqual({ month: 10, year: 2026 });
    expect(monthYearFromUrl("3", "2025", "2026-10-14")).toEqual({ month: 3, year: 2025 });
    expect(monthYearFromUrl("13", "1999", "2026-10-14")).toEqual({ month: 10, year: 2026 });
    expect(monthYearFromUrl("abc", "x", "2026-10-14")).toEqual({ month: 10, year: 2026 });
  });

  it("offers next year, this year and the three before", () => {
    expect(yearChoices("2026-10-14")).toEqual([2027, 2026, 2025, 2024, 2023]);
  });
});

describe("what a failed request says", () => {
  it("shows the server's own sentence", () => {
    const err = apiError(400, { error: "The balance is 0.50 shift, so 1 shift cannot be redeemed." });
    expect(errorMessage(err, "fallback")).toBe("The balance is 0.50 shift, so 1 shift cannot be redeemed.");
    expect(errorStatus(err)).toBe(400);
  });

  it("explains a refused login and a missing record in plain words, and falls back for anything else", () => {
    expect(errorMessage(apiError(403), "fallback")).toBe("Your login is not allowed to do this.");
    expect(errorMessage(apiError(404), "fallback")).toContain("not found");
    expect(errorMessage(apiError(500), "fallback")).toBe("fallback");
    expect(errorMessage(new Error("network down"), "fallback")).toBe("fallback");
    expect(errorStatus(new Error("x"))).toBeUndefined();
  });

  it("reads the per-employee problems of an all-or-nothing request", () => {
    const err = apiError(400, {
      error: "2 of 3 employees cannot be claimed for.",
      problems: [
        { employeeId: 7, error: "Hari has no punches." },
        { employeeId: "x", error: "ignored" },
        { employeeId: 8, error: "Indu already has a claim." },
      ],
    });
    expect(problemsOf(err)).toEqual([
      { employeeId: 7, error: "Hari has no punches." },
      { employeeId: 8, error: "Indu already has a claim." },
    ]);
    expect(problemsOf(apiError(400, { error: "x" }))).toEqual([]);
    expect(problemsOf(new Error("x"))).toEqual([]);
  });
});

describe("free text search", () => {
  it("matches a name, a code or a department, whatever the case", () => {
    expect(matchesText("asha", "Asha Kumar", "E11", "Sales")).toBe(true);
    expect(matchesText("E11", "Asha Kumar", "E11", "Sales")).toBe(true);
    expect(matchesText("sal", "Asha Kumar", "E11", "Sales")).toBe(true);
    expect(matchesText("xyz", "Asha Kumar", "E11", null)).toBe(false);
    expect(matchesText("  ", "Asha")).toBe(true);
  });
});
