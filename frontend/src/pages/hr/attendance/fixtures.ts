import type { AttendanceDailyRecord, ListedPunch } from "@/lib/api-client/custom-hooks";

// Rows of GET /api/attendance/daily for the Staff / Production Attendance tests: one of every kind of day.

export const DAY = "2026-11-04";

export const punch = (time: string, type: "IN" | "OUT", source = "biometric:Gate 1", over: Partial<ListedPunch> = {}) =>
  ({
    date: DAY,
    time,
    type,
    source,
    sourceLabel: source.startsWith("biometric")
      ? "Biometric"
      : source === "geo:auto"
        ? "Geo Punch"
        : source === "on_duty:approved"
          ? "On-Duty"
          : source === "manual"
            ? "HR Entry"
            : source,
    ...over,
  }) satisfies ListedPunch;

export const row = (code: string, name: string, over: Partial<AttendanceDailyRecord> = {}): AttendanceDailyRecord => ({
  employeeId: Number(code),
  employeeCode: code,
  employeeName: name,
  department: "Cutting",
  designation: "Operator",
  employmentType: "staff",
  status: "absent",
  firstPunch: null,
  lastPunch: null,
  source: null,
  sourceLabel: null,
  totalPunches: 0,
  punches: [],
  leaveState: null,
  leave: null,
  casualLeave: null,
  onDuty: null,
  ...over,
});

export const PRESENT = row("101", "Asha Kumar", {
  status: "present",
  firstPunch: "08:31",
  lastPunch: "18:05",
  totalPunches: 4,
  punches: [
    punch("08:31:05", "IN"),
    punch("13:00:00", "OUT", "geo:auto"),
    punch("13:40:00", "IN", "manual"),
    punch("18:05:00", "OUT", "missing_punch:approved", { sourceLabel: "Missing Punch" }),
  ],
});
export const MANUAL = row("102", "Ravi Nair", { status: "manual", department: "Stores" });
export const ABSENT = row("103", "Meena Raj");
export const PENDING_LEAVE = row("104", "Karthik Velu", {
  leaveState: "leave_applied",
  leave: {
    status: "pending",
    type: "sick",
    isHalfDay: false,
    halfDaySlot: null,
    startDate: DAY,
    endDate: DAY,
    reason: "Fever",
  },
});
export const ON_LEAVE = row("105", "Lakshmi Mani", {
  status: "on_leave",
  leaveState: "on_leave",
  leave: {
    status: "approved",
    type: "earned",
    isHalfDay: false,
    halfDaySlot: null,
    startDate: DAY,
    endDate: DAY,
    reason: null,
  },
});
export const CL = row("106", "Suresh Babu", {
  leaveState: "cl",
  casualLeave: { status: "approved", portion: "full", reason: "Family function" },
});
export const ON_DUTY = row("107", "Priya Shankar", {
  status: "present",
  leaveState: "on_duty",
  firstPunch: "09:10",
  totalPunches: 1,
  onDuty: { state: "punches_pending", label: "On-Duty approved; punches await HR", destination: "Erode" },
  punches: [
    punch("09:10:00", "IN", "on_duty:approved"),
    punch("12:40:00", "OUT", "on_duty:pending", {
      sourceLabel: "On-Duty (awaiting HR)",
      counted: false,
      verification: "pending",
    }),
  ],
});
export const NIGHT = row("201", "Murugan Sekar", {
  employmentType: "production",
  department: "Stitching",
  status: "present",
  firstPunch: "21:00",
  lastPunch: "05:30",
  lastPunchNextDay: true,
  totalPunches: 2,
  shiftsEarned: 1.5,
  isLate: true,
  ruleGroup: "Night shift",
  punches: [
    punch("05:30:00", "IN", "biometric:Line 2", { counted: false, note: "previous_shift" }),
    punch("21:00:00", "IN", "biometric:Line 2"),
    punch("05:30:00", "OUT", "biometric:Line 2", { date: "2026-11-05", nextDay: true }),
  ],
});

export const STAFF_DAY = [PRESENT, MANUAL, ABSENT, PENDING_LEAVE, ON_LEAVE, CL, ON_DUTY];
