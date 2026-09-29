import { describe, expect, it } from "vitest";
import type { AttendanceSearchDay } from "@/lib/api-client/custom-hooks";
import {
  activePreset,
  addDays,
  dayFlags,
  dayNotes,
  formatPeriodLabel,
  formatSpan,
  inclusiveDays,
  initialsOf,
  isIssueDay,
  monthRange,
  periodBounds,
  presetPeriod,
  punchSpanMinutes,
  summarize,
  todayStr,
  weekRange,
  type Period,
} from "./attendance-search";

const punch = (time: string, type: "IN" | "OUT" = "IN") => ({
  time,
  type,
  source: "biometric",
  sourceLabel: "Biometric",
});

function day(over: Partial<AttendanceSearchDay> = {}): AttendanceSearchDay {
  return {
    date: "2026-09-23",
    status: "present",
    isLate: false,
    isHalfShift: false,
    totalPunches: 0,
    punches: [],
    casualLeave: null,
    leave: null,
    permission: null,
    ...over,
  };
}

describe("dates", () => {
  it("week runs Monday to Sunday, including when the day is a Sunday", () => {
    expect(weekRange("2026-09-23")).toEqual(["2026-09-21", "2026-09-27"]); // Wednesday
    expect(weekRange("2026-09-27")).toEqual(["2026-09-21", "2026-09-27"]); // Sunday
    expect(weekRange("2026-09-21")).toEqual(["2026-09-21", "2026-09-27"]); // Monday
  });

  it("month covers its first to last day, leap years included", () => {
    expect(monthRange("2026-09")).toEqual(["2026-09-01", "2026-09-30"]);
    expect(monthRange("2028-02")).toEqual(["2028-02-01", "2028-02-29"]);
    expect(monthRange("2026-12")).toEqual(["2026-12-01", "2026-12-31"]);
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("counts the days a range covers, both ends included", () => {
    expect(inclusiveDays("2026-09-23", "2026-09-23")).toBe(1);
    expect(inclusiveDays("2026-09-21", "2026-09-27")).toBe(7);
    expect(inclusiveDays("2026-02-27", "2026-03-02")).toBe(4);
    expect(inclusiveDays("2026-03-28", "2026-04-02")).toBe(6); // across a month end
    expect(inclusiveDays("2026-09-27", "2026-09-21")).toBe(7); // either way round
    expect(inclusiveDays("", "2026-09-21")).toBe(0);
  });

  it("today is the local calendar date", () => {
    expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("quick ranges", () => {
  const today = "2026-09-23";
  const blank: Period = {
    mode: "day",
    date: today,
    weekAnchor: today,
    month: "2026-09",
    rangeStart: today,
    rangeEnd: today,
  };

  it("sets the period controls for each range", () => {
    expect(presetPeriod("yesterday", today)).toMatchObject({ mode: "day", date: "2026-09-22" });
    expect(presetPeriod("last-week", today)).toMatchObject({ mode: "week", weekAnchor: "2026-09-16" });
    expect(presetPeriod("last-month", today)).toMatchObject({ mode: "month", month: "2026-08" });
    expect(presetPeriod("last-month", "2026-01-10").month).toBe("2025-12");
  });

  it("recognises which range the controls amount to", () => {
    expect(activePreset(blank, today)).toBe("today");
    expect(activePreset({ ...blank, date: "2026-09-22" }, today)).toBe("yesterday");
    expect(activePreset({ ...blank, mode: "week", weekAnchor: "2026-09-25" }, today)).toBe("this-week");
    expect(activePreset({ ...blank, mode: "week", weekAnchor: "2026-09-16" }, today)).toBe("last-week");
    expect(activePreset({ ...blank, mode: "month", month: "2026-08" }, today)).toBe("last-month");
    expect(activePreset({ ...blank, mode: "day", date: "2026-07-01" }, today)).toBeNull();
    expect(activePreset({ ...blank, mode: "range" }, today)).toBeNull();
  });

  it("gives the start and end of whatever period is chosen", () => {
    expect(periodBounds(blank)).toEqual([today, today]);
    expect(periodBounds({ ...blank, mode: "week" })).toEqual(["2026-09-21", "2026-09-27"]);
    expect(periodBounds({ ...blank, mode: "month", month: "2026-02" })).toEqual(["2026-02-01", "2026-02-28"]);
    expect(periodBounds({ ...blank, mode: "range", rangeStart: "2026-09-01", rangeEnd: "2026-09-05" })).toEqual([
      "2026-09-01",
      "2026-09-05",
    ]);
  });
});

describe("a day's punches", () => {
  it("measures first punch to last punch", () => {
    expect(punchSpanMinutes([punch("08:30:00"), null, null, punch("17:35:12", "OUT")])).toBe(545);
    expect(punchSpanMinutes([punch("09:00"), punch("13:00", "OUT"), punch("14:00"), punch("18:00", "OUT")])).toBe(540);
  });

  it("has nothing to measure with fewer than two punches", () => {
    expect(punchSpanMinutes([])).toBeNull();
    expect(punchSpanMinutes([null, null, null, null])).toBeNull();
    expect(punchSpanMinutes([punch("08:30:00"), null, null, null])).toBeNull();
    expect(punchSpanMinutes([punch("08:30"), punch("08:30", "OUT")])).toBeNull();
  });

  it("writes the span readably", () => {
    expect(formatSpan(545)).toBe("9h 05m");
    expect(formatSpan(480)).toBe("8h 00m");
    expect(formatSpan(45)).toBe("45m");
  });
});

describe("labels", () => {
  it("names one day or a span, and puts the year where it matters", () => {
    expect(formatPeriodLabel("2026-09-23", "2026-09-23")).toContain("2026");
    expect(formatPeriodLabel("2026-09-23", "2026-09-23")).not.toContain("–");
    const week = formatPeriodLabel("2026-09-21", "2026-09-27");
    expect(week).toContain("–");
    expect(week.match(/2026/g)).toHaveLength(1);
    const overNewYear = formatPeriodLabel("2025-12-29", "2026-01-04");
    expect(overNewYear).toContain("2025");
    expect(overNewYear).toContain("2026");
  });

  it("takes initials from the first two words", () => {
    expect(initialsOf("Asha Kumar")).toBe("AK");
    expect(initialsOf("  ravi  s  kumar ")).toBe("RS");
    expect(initialsOf("Madonna")).toBe("M");
    expect(initialsOf("  ")).toBe("?");
  });
});

describe("a day's flags", () => {
  it("has none on an ordinary day", () => {
    expect(dayFlags(day())).toEqual([]);
    expect(dayNotes(day())).toEqual([]);
  });

  it("earns a badge for each thing that happened, and only those", () => {
    const flags = dayFlags(
      day({
        isLate: true,
        isEarlyOut: true,
        lateAfternoon: true,
        morningPermissionApplied: true,
        eveningPermissionExcess: true,
        middlePermissionToday: true,
        permissionAfternoon: true,
        permission: { status: "approved", type: "Late In", time: "10:30", reason: "Bank" },
        casualLeave: { status: "approved", reason: "Family" },
        isCompensationDay: true,
      }),
    );
    expect(flags.map((f) => f.key)).toEqual([
      "late",
      "earlyOut",
      "lateAfternoon",
      "permApplied",
      "permExcess",
      "permMiddle",
      "permAfternoon",
      "perm",
      "cl",
      "comp",
    ]);
    expect(flags.find((f) => f.key === "permApplied")).toMatchObject({
      tone: "permissionApplied",
      label: "Allowed permission applied",
      detail: "Morning",
    });
    expect(flags.find((f) => f.key === "permExcess")).toMatchObject({
      tone: "permissionExcess",
      label: "Excess permission",
      detail: "did not protect the day",
    });
    // A pre-rewrite "Late In" request still reads as its canonical type.
    expect(flags.find((f) => f.key === "perm")?.detail).toBe("Morning Late-In");
  });

  it("ignores the deprecated permission keys the server still sends for older apps", () => {
    const legacy: AttendanceSearchDay = {
      ...day(),
      permissionMorning: true,
      permissionDeparture: true,
      permissionZoneCount: 2,
      permissionEscalatedToHalfShift: true,
    } as AttendanceSearchDay;
    expect(dayFlags(legacy)).toEqual([]);
  });

  it("a permission request without a type falls back to its time", () => {
    const [flag] = dayFlags(day({ permission: { status: "approved", time: "10:30", reason: null } }));
    expect(flag).toMatchObject({ key: "perm", detail: "10:30" });
  });

  it("names a leave by its type", () => {
    expect(dayFlags(day({ leave: { status: "approved", type: "Sick Leave", reason: null } }))[0].label).toBe(
      "Sick Leave",
    );
    expect(dayFlags(day({ leave: { status: "approved", type: "", reason: null } }))[0].label).toBe("Leave");
  });

  it("doesn't repeat 'half shift' when the day's own status already says it", () => {
    expect(dayFlags(day({ status: "half_shift", isHalfShift: true }))).toEqual([]);
    expect(dayFlags(day({ status: "present", isHalfShift: true })).map((f) => f.key)).toEqual(["half"]);
  });

  it("says which half a Half Day was worked, from the first punch and the Half-Day cutoff", () => {
    const morning = dayFlags(
      day({ status: "half_shift", isHalfShift: true, punches: [punch("08:32:00"), null, null, null] }),
    );
    expect(morning.map((f) => f.label)).toEqual(["Morning half only"]);
    const evening = dayFlags(
      day({
        status: "half_shift",
        isHalfShift: true,
        punches: [punch("14:05:00"), null, null, punch("18:00:00", "OUT")],
      }),
    );
    expect(evening.map((f) => f.label)).toEqual(["Evening half only"]);
    // A first punch inside the lunch gap is not the Morning half, whatever Second Half Start says.
    const custom = dayFlags(
      day({ status: "half_shift", isHalfShift: true, punches: [punch("12:40:00"), null, null, null] }),
      { firstHalfEnd: "12:30", secondHalfStart: "13:30" },
    );
    expect(custom.map((f) => f.label)).toEqual(["Evening half only"]);
  });

  it("explains why a day was flagged when the server says", () => {
    const [flag] = dayFlags(day({ isLate: true, lateReason: "Morning Late-In: 09:40 is after 09:15" }));
    expect(flag.title).toBe("Morning Late-In: 09:40 is after 09:15");
  });

  it("keeps the reasons people gave and drops blank ones", () => {
    const notes = dayNotes(
      day({
        casualLeave: { status: "approved", reason: "  Family function " },
        leave: { status: "approved", type: "Sick Leave", reason: "" },
        permission: { status: "approved", time: "10:00", reason: null },
      }),
    );
    expect(notes).toEqual([{ key: "cl", label: "Casual leave", text: "Family function" }]);
  });

  it("puts the server's late reason first among a day's notes", () => {
    const notes = dayNotes(day({ isLate: true, lateReason: " Morning Late-In: 09:40 ", leave: null }));
    expect(notes).toEqual([{ key: "why", label: "Why flagged", text: "Morning Late-In: 09:40" }]);
  });
});

describe("a period's summary", () => {
  const days = [
    day({ status: "present" }),
    day({ status: "present", isLate: true, permission: { status: "approved", time: "10:00", reason: null } }),
    day({ status: "half_shift", isHalfShift: true }),
    day({ status: "absent" }),
    day({ status: "on_leave" }),
    day({ status: "holiday" }),
  ];

  it("counts each kind of day", () => {
    expect(summarize(days)).toEqual({
      total: 6,
      present: 2,
      halfShift: 1,
      absent: 1,
      onLeave: 1,
      holiday: 1,
      late: 1,
      earlyOut: 0,
      permission: 1,
      issues: 3,
    });
  });

  it("an issue is an absence, a half shift or a late mark, not leave or a holiday", () => {
    expect(days.map(isIssueDay)).toEqual([false, true, true, true, false, false]);
    expect(summarize([]).total).toBe(0);
  });

  it("an early out is an issue too, and is counted separately from late", () => {
    const early = day({ status: "present", isEarlyOut: true });
    expect(isIssueDay(early)).toBe(true);
    expect(summarize([early, day()])).toMatchObject({ late: 0, earlyOut: 1, issues: 1 });
  });
});
