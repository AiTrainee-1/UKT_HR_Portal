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

/** The whole catalogue for a staff day: Late can only be taken away (the day is already Late), the Morning Late-In
 *  permission is already approved, and only half a day of Casual Leave is left. */
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
      description: "A paid day given in return for extra work (the compensation balance is not touched).",
      items: [
        item({
          key: "sunday_compensation",
          label: "Sunday Compensation",
          group: "compensation",
          status: "present",
          shifts: "1.00",
          shiftChoices: SHIFT_CHOICES,
          worked: true,
          compensation: true,
        }),
      ],
    },
    {
      key: "not_worked",
      label: "Not worked",
      description: "The day was not worked.",
      items: [item({ key: "absent", label: "Absent", group: "not_worked", status: "absent", shifts: "0.00" })],
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
      key: "on_duty",
      label: "On-Duty",
      description: "The employee worked away from the branch: the day counts as Present (1.00 shift).",
      items: [
        item({ key: "on_duty", label: "On-Duty", group: "on_duty", status: "present", shifts: "1.00", worked: true }),
      ],
    },
  ];
}

/** The same for a production employee: no Permission and no Casual Leave (the server says why, once per item). */
export function productionOptions(): AttendanceEditGroup[] {
  const permissionReason = "Permission applies to staff only: production attendance has no permissions.";
  const clReason = "Casual Leave is available only for staff employees.";
  return staffOptions().map((g) => {
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
