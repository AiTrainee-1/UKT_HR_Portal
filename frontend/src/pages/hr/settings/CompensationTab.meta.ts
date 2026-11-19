import type { SettingMeta } from "./kit/catalog";

/** Section headings, so the blocks and this list cannot drift apart. */
export const COMPENSATION_SECTIONS = {
  claims: "How compensation is claimed",
  type1: "OT Detection - Type 1: next-day late-in allowance",
  type2: "OT Detection - Type 2: shift-based compensation",
  windows: "Compensation Leave - A. Company-announced late-in / early-out",
  holidayWork: "Compensation Leave - B. Work on Sundays and company holidays",
  birthday: "Compensation Leave - C. Birthday",
} as const;

const S = COMPENSATION_SECTIONS;

/** Every setting block on the Compensation tab: its anchor id, its section and the words the block shows. */
const BLOCKS: Omit<SettingMeta, "tab">[] = [
  {
    id: "claims-workflow",
    section: S.claims,
    title: "The claim workflow",
    purpose:
      "Every compensation follows the same steps: the system detects it from attendance, the employee (in the apps) or HR claims it, the employee's Department Head approves, an approved credit goes to the compensation balance, and the employee uses the balance on another working day (the Department Head approves that too).",
    keywords: [
      "claim",
      "workflow",
      "hod",
      "department head",
      "approval",
      "balance",
      "use balance",
      "employee app",
      "detect",
    ],
  },
  {
    id: "claims-from",
    section: S.claims,
    title: "Claims apply from",
    purpose:
      "The day the claim workflow started. From it, Type 1 allowances, Type 2 credits and birthday credits are given only after an approved claim, and staff OT is counted in quarters of the shift. Days before it keep the old rules, even when worked out again.",
    keywords: ["claims from", "effective date", "start date", "old rules", "history", "claim"],
  },
  {
    id: "allowance-enabled",
    section: S.type1,
    title: "Type 1: next-day late-in allowance",
    purpose:
      "When on, a staff member who works extra time after the shift end earns extra minutes for the first punch of the next working day, taken from the table below. It is never paid. From the claims date it is given only after a claim (by the employee or HR) that the Department Head approves; before that date it was automatic.",
    keywords: [
      "ot",
      "overtime",
      "allowance",
      "late in",
      "next day",
      "claim",
      "hod",
      "type 1",
      "compensation",
      "switch",
    ],
  },
  {
    id: "allowance-effective-from",
    section: S.type1,
    title: "Type 1 applies from",
    purpose:
      "The first day the allowance is used. Days before this date are never changed, so a month that is already paid is not judged again. Whenever you switch Type 1 on it starts today, unless you pick another date.",
    keywords: ["effective", "from", "start date", "allowance", "type 1", "retroactive"],
  },
  {
    id: "allowance-rules",
    section: S.type1,
    title: "Allowance table: extra work and the minutes it earns",
    purpose:
      "One row for each amount of extra work after the shift end. A day gets the allowance of the row with the most extra work it reaches. Edit a row, switch it off, add a row or remove one.",
    keywords: ["allowance", "minutes", "hours", "1 hour", "2 hours", "rows", "rules", "type 1", "extra work", "ot"],
  },
  {
    id: "shift-enabled",
    section: S.type2,
    title: "Type 2: shift-based compensation",
    purpose:
      "When on, a staff member who works past the shift end is listed on Compensation, OT Detection, with a credit of 0.25, 0.50, 0.75 or 1 shift: under the quarters rule from a quarter of their own shift, otherwise (and before the claims date) from more than the threshold. It is not automatic: the employee or HR claims it and the Department Head approves it into the compensation balance, or HR pays it while Payment is on. One day is paid or credited, never both.",
    keywords: ["ot", "overtime", "type 2", "shift", "quarter", "half", "claim", "compensation", "switch", "detection"],
  },
  {
    id: "shift-threshold",
    section: S.type2,
    title: "Type 2 starts after",
    purpose:
      "How many minutes after the shift end a day needs to reach to be listed for Type 2: more than this. Up to it only the Type 1 allowance applies. 150 minutes is 2 hours 30. It decides days before the claims date and days while the quarters rule is off; under the quarters rule a quarter of the employee's shift decides instead.",
    keywords: ["threshold", "minutes", "150", "2 hours 30", "type 2", "ot", "overtime"],
  },
  {
    id: "shift-quarter-rule",
    section: S.type2,
    title: "Count the credit in quarters of the shift",
    purpose:
      "When on, a Type 2 day's credit is its overtime divided by the employee's own working shift (shift end minus start minus lunch), rounded down to a quarter and at most 1.00. Below a quarter there is no Type 2 credit. Off: the last punch-out table below suggests the shifts.",
    keywords: ["quarter", "quarters", "0.25", "0.50", "0.75", "1.00", "shift length", "credit", "type 2", "ot", "rule"],
  },
  {
    id: "shift-relaxation",
    section: S.type2,
    title: "Give as Relaxation (an alternative day)",
    purpose:
      "Lets HR give a Type 2 day from before the claims date as an alternative day: on a date of the same month the attendance is topped up by the assigned shifts (never above one whole shift) and marked Compensation. From the claims date an approved claim credits the balance instead.",
    keywords: ["relaxation", "alternative day", "day off", "type 2", "compensation", "switch"],
  },
  {
    id: "shift-pay",
    section: S.type2,
    title: "Give as Payment",
    purpose:
      "Lets HR give a Type 2 day as money: the shifts times one day's pay are added to that month's payslip. Payment applies to Type 2 only; Type 1 is never paid.",
    keywords: ["payment", "pay", "money", "payslip", "salary", "type 2", "overtime pay", "switch"],
  },
  {
    id: "shift-ladder",
    section: S.type2,
    title: "Type 2 table: last punch-out and the shifts it earns",
    purpose:
      "Rows in time order. The shifts come from the first row whose time is later than the day's last punch-out; the last row can have no limit. Write a time after midnight with 'next day'. Used for days before the claims date, and from it only while the quarters rule is off.",
    keywords: [
      "ladder",
      "clock",
      "time",
      "9 pm",
      "midnight",
      "0.25",
      "0.50",
      "0.75",
      "1 shift",
      "rows",
      "rules",
      "type 2",
    ],
  },
  {
    id: "windows-enabled",
    section: S.windows,
    title: "A. Company-announced late-in / early-out",
    purpose:
      "When on, HR can announce a date, Late-in or Early-out, a time and a reason on the Compensation page. On that date all staff may arrive or leave by that time: their own shift start or end and grace do not apply, and no late-in or early-out is detected for it.",
    keywords: [
      "announce",
      "announcement",
      "late in",
      "early out",
      "festival",
      "all staff",
      "compensation leave",
      "switch",
    ],
  },
  {
    id: "holiday-work-enabled",
    section: S.holidayWork,
    title: "B. Work on Sundays and company holidays",
    purpose:
      "When on, staff who worked on a Sunday or a company holiday can get 0.25, 0.50, 0.75 or 1 shift of compensation leave. The employee (in the apps) or HR claims it, and it counts only once the Department Head approves it in Approvals; then it is added to the employee's compensation balance.",
    keywords: [
      "sunday",
      "holiday",
      "work on holiday",
      "hod",
      "approval",
      "balance",
      "alternative day",
      "compensation leave",
      "switch",
    ],
  },
  {
    id: "birthday-enabled",
    section: S.birthday,
    title: "C. Birthday leave",
    purpose:
      "When on, the birthday (from the date of birth on the employee record) is a normal working day, judged from attendance. Absent or on approved leave that day: paid Birthday leave (1.00 shift), no leave balance used. Present or half day: one 1.00 credit the employee or HR claims and the Department Head approves into the balance.",
    keywords: ["birthday", "date of birth", "dob", "paid leave", "claim", "credit", "compensation leave", "switch"],
  },
  {
    id: "birthday-effective-from",
    section: S.birthday,
    title: "Birthday leave applies from",
    purpose:
      "The first day birthday leave is given. Birthdays before this date are never changed, so a month that is already paid keeps its pay. Whenever you switch it on it starts today, unless you pick another date.",
    keywords: ["effective", "from", "start date", "birthday", "retroactive"],
  },
];

/** Every setting on the Compensation tab, for the page's search (see kit/catalog.ts). */
export const COMPENSATION_SETTINGS: SettingMeta[] = BLOCKS.map((b) => ({ ...b, tab: "compensation" }));

/** The title and purpose a block shows (the same words the search finds). */
export function compensationText(id: string): { title: string; purpose: string } {
  const block = BLOCKS.find((b) => b.id === id);
  if (!block) throw new Error(`No Compensation setting "${id}"`);
  return { title: block.title, purpose: block.purpose };
}
