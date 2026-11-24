// Test data for the Edit Attendance form's option catalogue (GET /api/attendance/edit-context `options`, 2026-11-02) and
// for the "!" of an HR edit. Shaped exactly like api/attendance_edit.py option_catalogue and api/hr_edit_marks.py send them.

import type {
  AttendanceEditChoice,
  AttendanceEditGroup,
  AttendanceEditItem,
  CasualLeaveBalance,
  HrEdit,
} from "@/lib/api-client/custom-hooks";

export const choice = (
  over: Partial<AttendanceEditChoice> & { value: string; label: string },
): AttendanceEditChoice => ({
  description: `${over.label}.`,
  shifts: null,
  days: null,
  durationMinutes: null,
  available: true,
  unavailableReason: null,
  ...over,
});

export const item = (
  over: Partial<AttendanceEditItem> & Pick<AttendanceEditItem, "key" | "label" | "group">,
): AttendanceEditItem => ({
  groupLabel: over.label,
  description: `${over.label}.`,
  status: null,
  shifts: null,
  shiftChoices: [],
  choices: [],
  choiceRequired: (over.choices ?? []).length > 0,
  worked: false,
  compensation: false,
  staffOnly: false,
  available: true,
  unavailableReason: null,
  ...over,
});

const SHIFT_CHOICES = ["0.25", "0.50", "0.75", "1.00"];

export const FULL_DAY_REFUSAL =
  "02 Nov 2026 has punches, so the attendance counts it as worked and a full-day leave would not apply. Choose Absent, or correct the punches first.";
export const LOCK_MESSAGE =
  "November 2026 payroll is finalized (Payroll Done), so the attendance of 02 Nov 2026 can no longer change.";

/** The whole catalogue for a staff day: Late can only be taken away (the day is already Late) and Early-Out only marked,
 *  the Morning Late-In permission is already approved, only half a day of Casual Leave is left, the day counts 0.50 so
 *  at most 0.50 of the compensation balance fits, a full-day leave is refused (the day has punches), a Lunch Check-In
 *  request is already waiting, the day has a 0.25 Penalty Early-Out deduction and 95 minutes of overtime (0.50 shift). */
export function staffOptions(): AttendanceEditGroup[] {
  return [
    {
      key: "worked",
      label: "Worked",
      description: "The day was worked: choose how much of a shift it counts.",
      items: [
        item({ key: "present", label: "Present", group: "worked", status: "present", shifts: "1.00", worked: true }),
        item({
          key: "half_day",
          label: "Half Day",
          group: "worked",
          status: "half_shift",
          shifts: "0.50",
          worked: true,
        }),
      ],
    },
    {
      key: "compensation",
      label: "Compensation",
      description:
        "Use the employee's compensation balance: the shift chosen is added to the day and taken from the balance.",
      items: [
        item({
          key: "sunday_compensation",
          label: "Sunday Compensation",
          group: "compensation",
          status: "present",
          shifts: "1.00",
          // only the amounts that fit: the day counts 0.50 already
          shiftChoices: ["0.25", "0.50"],
          worked: false,
          compensation: true,
          staffOnly: true,
          dayShifts: "0.50",
          balanceAvailable: 2.5,
        }),
      ],
    },
    {
      key: "not_worked",
      label: "Not worked",
      description: "The day was not worked.",
      items: [
        item({ key: "absent", label: "Absent", group: "not_worked", status: "absent", shifts: "0.00" }),
        item({ key: "holiday", label: "Holiday", group: "not_worked", status: "holiday", shifts: "0.00" }),
      ],
    },
    {
      key: "permission",
      label: "Permission",
      description: "Give the day an approved permission: it uses the monthly permission allowance.",
      items: [
        item({
          key: "permission",
          label: "Permission",
          group: "permission",
          worked: true,
          staffOnly: true,
          choices: [
            choice({
              value: "morning_late_in",
              label: "Morning Late-In",
              durationMinutes: 60,
              available: false,
              unavailableReason: "02 Nov 2026 already has an approved Morning Late-In permission.",
            }),
            choice({ value: "evening_early_out", label: "Evening Early-Out", durationMinutes: 60 }),
            choice({ value: "middle_permission", label: "Middle One-Hour Permission", durationMinutes: 60 }),
          ],
        }),
      ],
    },
    {
      key: "late",
      label: "Late",
      description: "Mark the day Late, or take its Late mark away.",
      items: [
        item({
          key: "late",
          label: "Late",
          group: "late",
          worked: true,
          choices: [
            choice({
              value: "mark",
              label: "Mark as Late",
              description: "The day counts as one Late in the late deductions.",
              available: false,
              unavailableReason: "02 Nov 2026 is already marked Late.",
            }),
            choice({
              value: "unmark",
              label: "Unmark Late",
              description: "The Late mark is taken away: the day no longer counts toward the late deductions.",
            }),
          ],
        }),
      ],
    },
    {
      key: "early_out",
      label: "Early-Out",
      description: "Mark the day Early-Out, or take its Early-Out mark away.",
      items: [
        item({
          key: "early_out",
          label: "Early-Out",
          group: "early_out",
          worked: true,
          choices: [
            choice({
              value: "mark",
              label: "Mark as Early-Out",
              description: "The day counts as one Early-Out in the late deductions.",
            }),
            choice({
              value: "unmark",
              label: "Unmark Early-Out",
              description: "The Early-Out mark is taken away: the day no longer counts toward the late deductions.",
              available: false,
              unavailableReason: "02 Nov 2026 is not marked Early-Out, so there is no Early-Out mark to take away.",
            }),
          ],
        }),
      ],
    },
    {
      key: "casual_leave",
      label: "Casual Leave",
      description: "Give the day as paid Casual Leave: it uses the employee's yearly Casual Leave balance.",
      items: [
        item({
          key: "casual_leave",
          label: "Casual Leave",
          group: "casual_leave",
          status: "present",
          staffOnly: true,
          choices: [
            choice({
              value: "full",
              label: "Full day",
              shifts: "1.00",
              days: 1,
              available: false,
              unavailableReason: "Only half a day of Casual Leave is left for 2026. Choose First half or Second half.",
            }),
            choice({ value: "first_half", label: "First half", shifts: "0.50", days: 0.5 }),
            choice({ value: "second_half", label: "Second half", shifts: "0.50", days: 0.5 }),
          ],
        }),
      ],
    },
    {
      key: "leave",
      label: "Leave",
      description: "Record the day as an approved leave, with its reason. A leave day is not paid.",
      items: [
        item({
          key: "leave",
          label: "Leave",
          group: "leave",
          status: "on_leave",
          choices: [
            choice({ value: "sick", label: "Sick Leave", description: "A leave for illness." }),
            choice({ value: "emergency", label: "Emergency", description: "A leave for an emergency." }),
            choice({ value: "personal", label: "Personal", description: "A leave for personal reasons." }),
            choice({ value: "other", label: "Other Reasons", description: "A leave for any other reason." }),
          ],
          portions: [
            choice({
              value: "full",
              label: "Full day",
              description: "The whole day is leave.",
              shifts: "1.00",
              days: 1,
              available: false,
              unavailableReason: FULL_DAY_REFUSAL,
            }),
            choice({
              value: "first_half",
              label: "First half",
              description: "The first half is leave; the other half counts by the punches.",
              shifts: "0.50",
              days: 0.5,
            }),
            choice({
              value: "second_half",
              label: "Second half",
              description: "The second half is leave; the other half counts by the punches.",
              shifts: "0.50",
              days: 0.5,
            }),
          ],
        }),
      ],
    },
    {
      key: "on_duty",
      label: "On-Duty",
      description:
        "The employee worked away from the branch: the day counts as Present (1.00 shift) and an On-Duty record is added.",
      items: [
        item({ key: "on_duty", label: "On-Duty", group: "on_duty", status: "present", shifts: "1.00", worked: true }),
      ],
    },
    {
      key: "missing_punch",
      label: "Missing Punch",
      description: "Add the punch the device missed: it is recorded as an approved missing-punch request.",
      items: [
        item({
          key: "missing_punch",
          label: "Missing Punch",
          group: "missing_punch",
          worked: true,
          needsTime: true,
          choices: [
            choice({ value: "morning_in", label: "Morning Check-In", description: "The first punch of the day (IN)." }),
            choice({ value: "lunch_out", label: "Lunch Check-Out", description: "Going out for lunch (OUT)." }),
            choice({
              value: "lunch_in",
              label: "Lunch Check-In",
              description: "Back from lunch (IN).",
              available: false,
              unavailableReason:
                "A Lunch Check-In request for 02 Nov 2026 is waiting for approval: decide that request instead.",
            }),
            choice({
              value: "evening_out",
              label: "Evening Check-Out",
              description: "The last punch of the day (OUT).",
            }),
          ],
        }),
      ],
    },
    {
      key: "penalty_waiver",
      label: "Penalty Waiver",
      description: "Take back the day's Penalty Early-Out deduction: the shift it took off is added back.",
      items: [
        item({
          key: "penalty_waiver",
          label: "Penalty Waiver",
          group: "penalty_waiver",
          description: "Take back the Penalty Early-Out deduction of 02 Nov 2026: 0.25 shift is added back to the day.",
          status: "present",
          shifts: "0.25",
          penaltyMinutes: 80,
        }),
      ],
    },
    {
      key: "ot_pay",
      label: "OT Pay",
      description: "Pay the day's overtime: its overtime record is set to Pay with the shifts chosen.",
      items: [
        item({
          key: "ot_pay",
          label: "OT Pay",
          group: "ot_pay",
          shiftChoices: SHIFT_CHOICES,
          staffOnly: true,
          defaultShifts: "0.50",
          otMinutes: 95,
        }),
      ],
    },
  ];
}

/** The same day once its payroll is finalized (Payroll Done): every item, choice and part of the day refused with the
 *  lock's sentence, exactly as option_catalogue does. */
export function lockedOptions(message = LOCK_MESSAGE): AttendanceEditGroup[] {
  const off = <T extends { available: boolean; unavailableReason: string | null }>(x: T): T => ({
    ...x,
    available: false,
    unavailableReason: message,
  });
  return staffOptions().map((g) => ({
    ...g,
    items: g.items.map((i) => ({
      ...off(i),
      choices: i.choices.map(off),
      ...(i.portions ? { portions: i.portions.map(off) } : {}),
    })),
  }));
}

/** The same for a production employee: no Permission, no Casual Leave, no compensation balance and no OT Pay (the server
 *  says why, once per item). */
export function productionOptions(): AttendanceEditGroup[] {
  const permissionReason = "Permission applies to staff only: production attendance has no permissions.";
  const clReason = "Casual Leave is available only for staff employees.";
  const compensationReason =
    "Compensation applies to staff employees only: production attendance has no compensation balance.";
  const otReason = "OT pay applies to staff employees only.";
  return staffOptions().map((g) => {
    if (g.key === "compensation") {
      return {
        ...g,
        items: g.items.map((i) => ({
          ...i,
          shiftChoices: [],
          dayShifts: "0.00",
          balanceAvailable: 0,
          available: false,
          unavailableReason: compensationReason,
        })),
      };
    }
    if (g.key === "ot_pay") {
      return {
        ...g,
        items: g.items.map((i) => ({
          ...i,
          defaultShifts: null,
          otMinutes: null,
          available: false,
          unavailableReason: otReason,
        })),
      };
    }
    if (g.key === "permission") {
      return {
        ...g,
        items: g.items.map((i) => ({
          ...i,
          available: false,
          unavailableReason: permissionReason,
          choices: i.choices.map((c) => ({ ...c, available: false, unavailableReason: permissionReason })),
        })),
      };
    }
    if (g.key === "casual_leave") {
      return {
        ...g,
        items: g.items.map((i) => ({
          ...i,
          available: false,
          unavailableReason: clReason,
          choices: i.choices.map((c) => ({ ...c, available: false, unavailableReason: clReason })),
        })),
      };
    }
    return g;
  });
}

export const clBalance = (over: Partial<CasualLeaveBalance> = {}): CasualLeaveBalance => ({
  total: 12,
  used: 11,
  pending: 0.5,
  remaining: 0.5,
  year: 2026,
  since: "2026-11-02",
  endsOn: "2026-12-31",
  cutOver: "2026-11-02",
  tracked: true,
  ...over,
});

export const hrEdit = (over: Partial<HrEdit> = {}): HrEdit => ({
  requestId: 41,
  status: "waiting_hod",
  stageLabel: "Waiting for Department Head (Suresh Raj)",
  from: { label: "Present", shifts: 1 },
  to: { label: "Half Day", shifts: 0.5 },
  option: "worked",
  type: "half_day",
  typeLabel: "Half Day",
  reason: "Left at lunch for a family function",
  comment: null,
  raisedBy: "Meena (HR)",
  raisedAt: "2026-11-02T06:30:00Z",
  decidedBy: null,
  decidedAt: null,
  ...over,
});
