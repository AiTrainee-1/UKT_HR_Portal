import { describe, expect, it } from "vitest";
import { DEFAULT_ARRIVAL, clock, minutesOf } from "@/lib/arrival-rules";
import { DEFAULT_EXAMPLE, EXAMPLE_DAY_PAY, describeShift, exampleShift, payFor, rupees, shiftText } from "./example";
import {
  claimedByDayBefore,
  effectiveNightLateWindow,
  forgottenExitRule,
  halfDayStatus,
  judgeStaffDay,
  lunchReturn,
  productionDay,
  type StaffDayInput,
} from "./preview";

// The worked numbers below are the attendance engine's own (backend/api/attendance_final.py, arrival_rules.py,
// shift_engine.py, run or traced in the settings inventory of 2026-10-12): the previews must agree with them.

const m = (t: string) => minutesOf(t)!;
const base: Omit<StaffDayInput, "punches"> = {
  shift: DEFAULT_EXAMPLE,
  arrival: DEFAULT_ARRIVAL,
  secondHalfStart: m("14:30"),
  morningLateIn: true,
  eveningEarlyOut: false,
};
const day = (times: string[], extra: Partial<StaffDayInput> = {}) =>
  judgeStaffDay({ ...base, ...extra, punches: times.map(m) });

describe("the shared example", () => {
  it("is a 09:00-18:00 shift with 10 minutes' grace and a 13:30 lunch, at ₹1,000 a day", () => {
    expect([DEFAULT_EXAMPLE.start, DEFAULT_EXAMPLE.end, DEFAULT_EXAMPLE.lunchStart].map(clock)).toEqual([
      "09:00",
      "18:00",
      "13:30",
    ]);
    expect(DEFAULT_EXAMPLE.grace).toBe(10);
    expect(describeShift(DEFAULT_EXAMPLE)).toBe("a 09:00-18:00 shift with 10 minutes' grace");
    expect(EXAMPLE_DAY_PAY).toBe(1000);
    expect([rupees(1000), rupees(250), rupees(1250.5), rupees(100000)]).toEqual([
      "₹1,000",
      "₹250",
      "₹1,250.50",
      "₹1,00,000",
    ]);
    expect([payFor(0.75), shiftText(0.75), shiftText(1)]).toEqual([750, "0.75 shift", "1.00 shift"]);
  });

  it("moves the end and the lunch with the start, and refuses a start that is not a time", () => {
    const s = exampleShift("14:00", 5)!;
    expect([clock(s.end), clock(s.lunchStart), s.grace]).toEqual(["23:00", "18:30", 5]);
    expect(exampleShift("25:00", 10)).toBeNull();
    expect(exampleShift("09:00", -3)!.grace).toBe(0);
  });
});

describe("Full Day / Half Day / Absent (Second Half Start 14:30, default windows: first-half limit 11:30)", () => {
  it("decides the day from the two halves", () => {
    expect(day(["09:05", "17:50"])).toMatchObject({ status: "present", shifts: 1 });
    expect(day(["09:05", "13:00"])).toMatchObject({ status: "half_shift", shifts: 0.5 });
    expect(day(["14:45"])).toMatchObject({ status: "half_shift", shifts: 0.5, zone: "second_half" });
    expect(day(["12:00"])).toMatchObject({ status: "absent", shifts: 0 });
  });

  it("follows Second Half Start: at 12:30 leaving at 13:00 is a Full Day", () => {
    expect(day(["09:05", "13:00"], { secondHalfStart: m("12:30") })).toMatchObject({ status: "present", shifts: 1 });
  });

  it("uses the fixed first-half end for staff with no shift", () => {
    expect(halfDayStatus([m("12:00"), m("18:00")], m("14:30"), null)).toMatchObject({ status: "present" });
    expect(halfDayStatus([m("13:45")], m("14:30"), null)).toMatchObject({ status: "absent" });
    expect(halfDayStatus([], m("14:30"), 690)).toMatchObject({ status: "absent", shifts: 0 });
  });

  it("counts one punch as both halves when the first-half limit is not before Second Half Start", () => {
    // 09:00 shift, windows 60/60/20 -> limit 11:30; Second Half Start 11:00: one punch at 11:15 is a Full Day (a
    // quarter-shift arrival, so 0.75 of it), and one at 10:00 a whole Full Day.
    expect(day(["11:15"], { secondHalfStart: m("11:00") })).toMatchObject({ status: "present", shifts: 0.75 });
    expect(day(["10:00"], { secondHalfStart: m("09:30") })).toMatchObject({ status: "present", shifts: 1 });
  });
});

describe("the arrival timeline", () => {
  it("marks Late only inside the Late window, and only while Morning Late-In is on", () => {
    expect(day(["09:10", "18:05"])).toMatchObject({ zone: "on_time", late: false, shifts: 1 });
    expect(day(["09:11", "18:05"])).toMatchObject({ zone: "late", late: true, shifts: 1 });
    expect(day(["09:25", "18:05"])).toMatchObject({ zone: "late", late: true, status: "present" });
    expect(day(["09:25", "18:05"], { morningLateIn: false })).toMatchObject({ zone: "late", late: false, shifts: 1 });
    expect(day(["10:10", "18:05"])).toMatchObject({ zone: "late", late: true });
  });

  it("takes the quarter shift after the Late window: 10:30 in, 18:05 out earns 0.75 (₹750 instead of ₹1,000)", () => {
    const d = day(["10:30", "18:05"]);
    expect(d).toMatchObject({ zone: "quarter", late: false, status: "present", shifts: 0.75 });
    expect(payFor(d.shifts)).toBe(750);
    // the switch does not change it (the arrival timeline still applies)
    expect(day(["10:30", "18:05"], { morningLateIn: false }).shifts).toBe(0.75);
    // 0 = no deduction, and not Late either
    expect(day(["10:30", "18:05"], { arrival: { ...DEFAULT_ARRIVAL, quarterDeduction: 0 } })).toMatchObject({
      shifts: 1,
      late: false,
    });
    // 1 = 0.00 in attendance (payroll then pays the present day as a full one)
    expect(day(["10:30", "18:05"], { arrival: { ...DEFAULT_ARRIVAL, quarterDeduction: 1 } }).shifts).toBe(0);
  });

  it("does not dock a quarter-shift arrival twice when the day is already a Half Day", () => {
    expect(day(["10:30", "13:00"])).toMatchObject({ zone: "quarter", status: "half_shift", shifts: 0.5 });
  });

  it("lets an in-cap Morning Late-In permission excuse up to the end of the permission window (11:10)", () => {
    expect(day(["11:10", "18:05"], { morningPermission: true })).toMatchObject({
      zone: "excused",
      late: false,
      shifts: 1,
    });
    expect(day(["09:40", "18:05"], { morningPermission: true })).toMatchObject({ zone: "excused", late: false });
    // the extra minutes are never covered: 11:15 is a quarter shift even with a permission
    expect(day(["11:15", "18:05"], { morningPermission: true })).toMatchObject({ zone: "quarter", shifts: 0.75 });
    // without the permission (an excess one) 09:40 is plain Late
    expect(day(["09:40", "18:05"])).toMatchObject({ zone: "late", late: true });
  });

  it("misses the morning half after 11:30: Absent alone, Half Day with an afternoon punch", () => {
    expect(day(["11:31"])).toMatchObject({ zone: "second_half", status: "absent", shifts: 0 });
    expect(day(["11:31", "18:00"])).toMatchObject({ zone: "second_half", status: "half_shift", shifts: 0.5 });
  });

  it("follows a 30-minute Late window: Late 09:11-09:40, quarter shift 09:41-11:00, morning missed after 11:00", () => {
    // (the inventory's "after 10:50" was an arithmetic slip: 09:10 + 30 + 60 + 20 = 11:00, as the e2e spec says)
    const arrival = { ...DEFAULT_ARRIVAL, lateWindowMinutes: 30 };
    expect(day(["09:40", "18:00"], { arrival }).zone).toBe("late");
    expect(day(["09:41", "18:00"], { arrival }).zone).toBe("quarter");
    expect(day(["11:00", "18:00"], { arrival }).zone).toBe("quarter");
    expect(day(["11:01", "18:00"], { arrival }).zone).toBe("second_half");
  });
});

describe("Evening Early-Out (shift end 18:00, grace 10)", () => {
  it("marks a last punch before 17:50 only while the switch is on", () => {
    expect(day(["09:00", "17:49"], { eveningEarlyOut: true }).earlyOut).toBe(true);
    expect(day(["09:00", "17:50"], { eveningEarlyOut: true }).earlyOut).toBe(false);
    expect(day(["09:00", "17:49"]).earlyOut).toBe(false);
  });

  it("never marks a lone punch, and moves the end 60 minutes earlier with an in-cap permission", () => {
    expect(day(["09:00"], { eveningEarlyOut: true }).earlyOut).toBe(false);
    const permitted = day(["09:00", "16:50"], { eveningEarlyOut: true, eveningPermission: true });
    expect(permitted.earlyOut).toBe(false);
    expect(clock(permitted.earlyOutBefore)).toBe("16:50");
    expect(day(["09:00", "16:49"], { eveningEarlyOut: true, eveningPermission: true }).earlyOut).toBe(true);
  });
});

describe("the lunch return (Strict mode): out 13:10, 60-minute lunch, due back 14:10", () => {
  const back = (t: string, window = 60, zone = 60) => lunchReturn(m("13:10"), m(t), 60, window, zone);

  it("flags every late return, the two numbers only choosing the label", () => {
    expect(back("14:10")).toMatchObject({ verdict: "on_time", minutesOver: 0, deadline: m("14:10") });
    expect(back("14:20")).toMatchObject({ verdict: "night_late", minutesOver: 10 });
    expect(back("15:10").verdict).toBe("night_late");
    expect(back("15:30")).toMatchObject({ verdict: "lunch_permission", minutesOver: 80 });
    expect(back("16:10").verdict).toBe("lunch_permission");
    expect(back("16:30")).toMatchObject({ verdict: "night_late", minutesOver: 140 });
  });

  it("reads a Night Late window of 0 as 60, and a zone of 0 as no permission band", () => {
    expect(effectiveNightLateWindow(0)).toBe(60);
    expect(back("15:10", 0).verdict).toBe("night_late");
    expect(back("15:30", 0).verdict).toBe("lunch_permission");
    expect(back("15:30", 60, 0).verdict).toBe("night_late");
  });
});

describe("a forgotten last punch after midnight", () => {
  it("09:00-18:00 shift, 9 h grace, 2 h protection: punches up to 03:00 go back to the day before", () => {
    const rule = forgottenExitRule(m("18:00"), m("09:00"), 9, 2)!;
    expect(rule).toEqual({ cutoff: m("03:00"), reach: m("03:00"), protectedFrom: m("07:00"), limitedBy: "grace" });
    // Monday's last punch 14:15 (no exit punch): Tuesday 01:10 is Monday's last-out
    expect(claimedByDayBefore(m("01:10"), m("14:15"), m("18:00"), rule)).toBe(true);
    // a Monday that already has a punch after its shift end keeps nothing
    expect(claimedByDayBefore(m("01:10"), m("18:05"), m("18:00"), rule)).toBe(false);
    expect(claimedByDayBefore(m("03:01"), m("14:15"), m("18:00"), rule)).toBe(false);
  });

  it("20:00 end, next shift 06:00, 9 h grace, 2 h protection: the protection stops it at 04:00", () => {
    const rule = forgottenExitRule(m("20:00"), m("06:00"), 9, 2)!;
    expect(rule).toMatchObject({
      cutoff: m("04:00"),
      reach: m("05:00"),
      protectedFrom: m("04:00"),
      limitedBy: "protection",
    });
    expect(claimedByDayBefore(m("03:50"), null, m("20:00"), rule)).toBe(true);
    expect(claimedByDayBefore(m("04:30"), null, m("20:00"), rule)).toBe(false);
  });

  it("is off at 0, does nothing when the window ends before midnight, and takes half hours", () => {
    expect(forgottenExitRule(m("18:00"), m("09:00"), 0, 2)).toBeNull();
    expect(forgottenExitRule(m("18:00"), m("09:00"), 5, 2)).toBeNull();
    expect(forgottenExitRule(m("18:00"), m("09:00"), 9.5, 2)!.cutoff).toBe(m("03:30"));
    expect(forgottenExitRule(m("18:00"), m("09:00"), 20, 0)!.cutoff).toBe(m("09:00"));
    expect(claimedByDayBefore(m("01:10"), null, m("18:00"), null)).toBe(false);
  });
});

describe("a production day (default segments, grace 10, ₹600 a shift)", () => {
  const seg = (label: string, startTime: string, endTime: string, shiftValue: number, isActive = true) => ({
    label,
    startTime,
    endTime,
    shiftValue,
    isActive,
  });
  const DEFAULT = [
    seg("Morning 1", "08:30", "10:30", 0.25),
    seg("Morning 2", "10:30", "12:45", 0.25),
    seg("Afternoon 1", "13:30", "15:30", 0.25),
    seg("Afternoon 2", "15:30", "17:30", 0.25),
    seg("Evening", "17:30", "20:00", 0.5),
  ];
  const prod = (times: string[], segments = DEFAULT, grace = 10) =>
    productionDay(times.map(m), segments, grace, "08:30", "20:00");

  it("08:35, 12:50, 13:35, 17:35 earns the four day segments: 1.00 shift", () => {
    expect(prod(["08:35", "12:50", "13:35", "17:35"])).toMatchObject({
      shifts: 1,
      covered: ["Morning 1", "Morning 2", "Afternoon 1", "Afternoon 2"],
      maxPossible: 1.5,
      half: false,
      late: false,
      earlyOut: true,
    });
  });

  it("staying until 19:55 adds the Evening: 1.50 shifts; grace 0 behaves as 10", () => {
    expect(prod(["08:35", "12:50", "13:35", "19:55"]).shifts).toBe(1.5);
    expect(prod(["08:35", "12:50", "13:35", "19:55"], DEFAULT, 0)).toMatchObject({ shifts: 1.5, grace: 10 });
    // an Evening worth 0.25, or switched off
    const cheap = DEFAULT.map((s) => (s.label === "Evening" ? { ...s, shiftValue: 0.25 } : s));
    expect(prod(["08:35", "12:50", "13:35", "19:55"], cheap)).toMatchObject({ shifts: 1.25, maxPossible: 1.25 });
    const off = DEFAULT.map((s) => (s.label === "Evening" ? { ...s, isActive: false } : s));
    expect(prod(["08:35", "12:50", "13:35", "19:55"], off)).toMatchObject({ shifts: 1, maxPossible: 1 });
  });

  it("earns the Evening when leaving at 19:50 but not at 19:49", () => {
    expect(prod(["13:35", "19:50"]).covered).toContain("Evening");
    expect(prod(["13:35", "19:49"]).covered).not.toContain("Evening");
  });

  it("gives 0.25 for punches that cover no segment, and flags Late after 08:40 / Early Out before 19:50", () => {
    expect(prod(["21:00", "22:00"])).toMatchObject({ shifts: 0.25, covered: [], half: true });
    expect(prod(["08:40", "19:50"])).toMatchObject({ late: false, earlyOut: false });
    expect(prod(["08:41", "19:49"])).toMatchObject({ late: true, earlyOut: true });
    expect(prod(["08:35"])).toMatchObject({ shifts: 0, covered: [] });
    expect(productionDay([m("08:35"), m("20:00")], [], 10, "08:30", "20:00")).toMatchObject({
      shifts: 0.25,
      maxPossible: 1.5,
    });
  });
});
