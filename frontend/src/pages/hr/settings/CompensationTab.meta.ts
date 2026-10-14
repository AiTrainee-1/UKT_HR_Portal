import type { SettingMeta } from "./kit/catalog";

/** Section headings, so the blocks and this list cannot drift apart. */
export const COMPENSATION_SECTIONS = {
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
    id: "allowance-enabled",
    section: S.type1,
    title: "Type 1: automatic next-day late-in allowance",
    purpose:
      "When on, a staff member who works extra time after the shift end gets extra minutes for the first punch of the next working day, taken from the table below. It is automatic and never paid: nobody claims it, HR assigns nothing, and the employee may or may not use it.",
    keywords: ["ot", "overtime", "allowance", "late in", "next day", "automatic", "type 1", "compensation", "switch"],
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
      "When on, a staff member who works more than the threshold past the shift end is listed on Compensation, OT Detection, with a suggested 0.25, 0.50, 0.75 or 1 shift. It is not automatic: HR assigns it, as Relaxation or as Payment, for a date of the same month.",
    keywords: ["ot", "overtime", "type 2", "shift", "quarter", "half", "compensation", "switch", "detection"],
  },
  {
    id: "shift-threshold",
    section: S.type2,
    title: "Type 2 starts after",
    purpose:
      "How many minutes after the shift end a day needs to reach to be listed for Type 2: more than this. Up to it only the Type 1 allowance applies. 150 minutes is 2 hours 30.",
    keywords: ["threshold", "minutes", "150", "2 hours 30", "type 2", "ot", "overtime"],
  },
  {
    id: "shift-relaxation",
    section: S.type2,
    title: "Give as Relaxation (an alternative day)",
    purpose:
      "Lets HR give a Type 2 day as an alternative day: on a date of the same month the attendance is topped up by the assigned shifts (never above one whole shift) and marked Compensation, so the employee is paid for that day while taking time off.",
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
      "Rows in time order. The shifts come from the first row whose time is later than the day's last punch-out; the last row can have no limit. Write a time after midnight with 'next day'. Edit a row, switch it off, add a row or remove one.",
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
      "When on, HR can grant 0.25, 0.50, 0.75 or 1 shift of compensation leave to staff who worked on a Sunday or a company holiday. Only HR can assign it, and it counts only once the Department Head approves it in Approvals; then it is added to the employee's compensation balance.",
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
      "When on, a staff member gets a paid compensation-leave day on their birthday (from the date of birth on the employee record), automatically. Whether they attend, stay absent, work half a day, arrive late or leave early, no attendance detection applies that day.",
    keywords: ["birthday", "date of birth", "dob", "paid leave", "automatic", "compensation leave", "switch"],
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
