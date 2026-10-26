import type { SettingMeta } from "./kit/catalog";
import type { ClassView } from "./kit/view";

/** Section headings, so the blocks and this list cannot drift apart. */
export const PRODUCTION_SHIFT_SECTIONS = {
  staff: "Staff shifts and grace",
  when: "When the production rules apply",
  groups: "Shift groups and what each leaving time earns",
  breaks: "Breaks that are never paid",
  advanced: "Advanced settings",
  tryIt: "Check the rules on a day",
} as const;

const S = PRODUCTION_SHIFT_SECTIONS;

/** Every setting block on the Production Shifts tab: its anchor id, its section and the words the block shows. */
const BLOCKS: Omit<SettingMeta, "tab">[] = [
  {
    id: "staff-shifts-where",
    section: S.staff,
    title: "Where staff shifts and grace are set",
    purpose:
      "Nothing on this tab changes staff. A staff member's shift, its start and end and its grace come from the shift assigned in Manage Shifts, and how the day's punches become a Full Day, Half Day or Absent, a Late mark or an Early Out is set on Attendance, Staff page. This page only points to them; the production rules are on the Production page.",
    keywords: ["staff", "manage shifts", "shift", "grace", "where", "explanation", "attendance", "office"],
  },
  {
    id: "rules-enabled",
    section: S.when,
    title: "Use the production shift rules",
    purpose:
      "When on, the shifts a production worker earns each day come from the groups, ladders and breaks on this tab, for every day from the start date below. When off, every day keeps the old calculation (the old punch times and segments). Staff are never affected.",
    keywords: ["production", "switch", "on", "off", "enable", "shift rules", "shifts earned", "old calculation"],
  },
  {
    id: "rules-effective-from",
    section: S.when,
    title: "Production rules apply from",
    purpose:
      "The first day the rules are used. Every day before it keeps the old calculation, so a period that is already paid is never judged again. It starts on the day the rules were first set up. Pick an earlier date only on purpose: every day from then on is judged again, and its production payroll changes the next time it is generated.",
    keywords: [
      "effective",
      "from",
      "applies",
      "applies from",
      "start date",
      "retroactive",
      "past",
      "old calculation",
      "date",
    ],
  },
  {
    id: "rules-grace",
    section: S.when,
    title: "Grace (minutes)",
    purpose:
      "How many minutes a worker may be early or late and still count as on the dot. A first punch up to this long after the start is not late and loses nothing. A punch up to this long before a leaving time in a ladder counts as that time: with 5 minutes' grace, leaving at 5:42 PM earns what leaving at 5:45 PM earns. Beyond the grace the shifts are worked out by the minute.",
    keywords: ["grace", "minutes", "late", "early", "5 minutes", "punctual", "tolerance"],
  },
  {
    id: "shift-groups",
    section: S.groups,
    title: "Shift groups and their ladders",
    purpose:
      "A group is one kind of working day: Day (Monday to Saturday), Night and Sunday. A day belongs to the group whose first-punch window holds its first punch. A group's ladder is a list of leaving times and the shifts earned by leaving then. A worker who leaves between two rows earns a share of the difference, worked out by the minute without counting the breaks. Leaving after the last row earns the last row's shifts.",
    keywords: [
      "group",
      "day shift",
      "night shift",
      "sunday",
      "ladder",
      "rows",
      "rules",
      "leaving time",
      "out time",
      "shift value",
      "0.25",
      "0.50",
      "1.50",
      "2.50",
      "overtime",
      "ot",
      "start time",
      "first punch",
      "8:30",
      "9:00 pm",
      "5:30 am",
      "midnight",
      "next day",
      "add a row",
      "wage rate",
    ],
  },
  {
    id: "breaks",
    section: S.breaks,
    title: "Breaks that are never paid",
    purpose:
      "Tea, lunch and dinner. Time inside a break earns nothing and nobody punches for it, so the time a worker is out for lunch is not paid and does not need a punch. The breaks apply to every group on every day. Edit a break, switch it off, add one or remove one.",
    keywords: ["break", "tea", "lunch", "dinner", "10:30", "12:45", "1:30", "3:30", "5:45", "8:00 pm", "unpaid"],
  },
  {
    id: "min-credit",
    section: S.advanced,
    title: "Minimum shifts for a worked day",
    purpose:
      "A worker with at least one complete in and out pair earns at least this many shifts for the day, even when the ladder gives less. 0 means there is no minimum: a very short day earns only what its minutes are worth.",
    keywords: ["minimum", "credit", "floor", "least", "short day", "advanced"],
  },
  {
    id: "rounding",
    section: S.advanced,
    title: "Rounding of the day's shifts",
    purpose:
      "A day's shifts are rounded to this step before they are saved. 0.01 keeps the exact figure to two decimals; 0.05 or 0.25 round to steps. 'To the nearest step' rounds to the closest one, 'Down to the step below' always rounds down, so nobody is paid for time not completed.",
    keywords: ["rounding", "round", "step", "nearest", "down", "0.05", "0.25", "decimal", "advanced"],
  },
  {
    id: "full-day-value",
    section: S.advanced,
    title: "Full-day value (shifts)",
    purpose:
      "A day that earns less than this is a Half-shift day on the attendance pages; at or above it the worker is Present. It decides the label only: pay is always the shifts earned times the salary per shift.",
    keywords: ["full day", "half shift", "present", "status", "label", "advanced"],
  },
  {
    id: "night-session",
    section: S.advanced,
    title: "Night session length (hours)",
    purpose:
      "A night worker's out-punch comes on the next morning. A day that ends on an in-punch with no out-punch is closed by the first punch of the next calendar day only when that punch is within this many hours of it. After that the day stays open: a forgotten out-punch is never closed by the next day's arrival.",
    keywords: ["night", "session", "hours", "next morning", "cross midnight", "forgotten punch", "advanced"],
  },
  {
    id: "try-it",
    section: S.tryIt,
    title: "Try a day",
    purpose:
      "Type the punches of a made-up day and see the shifts it earns with the saved rules, the group used and the rule that decided it. Nothing is saved or changed by trying. Unsaved edits on this tab are not used until they are saved.",
    keywords: ["try", "calculator", "example", "test", "preview", "punches", "work out", "check"],
  },
];

/** Every setting on the Production Shifts tab, for the page's search (see kit/catalog.ts). */
export const PRODUCTION_SHIFT_SETTINGS: SettingMeta[] = BLOCKS.map((b) => ({ ...b, tab: "production_shifts" }));

/** The title and purpose a block shows (the same words the search finds). */
export function productionShiftText(id: string): { title: string; purpose: string } {
  const block = BLOCKS.find((b) => b.id === id);
  if (!block) throw new Error(`No Production Shifts setting "${id}"`);
  return { title: block.title, purpose: block.purpose };
}

/** The settings of the Staff page; every other setting of this tab is on the Production page (the page the tab opens on). */
const STAFF_PAGE = new Set(["staff-shifts-where"]);

/** Which page (Staff or Production) holds each setting, so a link or a search result can open it. */
export const PRODUCTION_SHIFT_VIEW_OF: Record<string, ClassView> = Object.fromEntries(
  BLOCKS.map((b) => [b.id, STAFF_PAGE.has(b.id) ? "staff" : "production"]),
);
