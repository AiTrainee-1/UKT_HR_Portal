import type { SettingMeta } from "./kit/catalog";
import type { ClassView } from "./kit/view";

const MODE = "Attendance Calculation Mode";
const DAY = "Full Day, Half Day or Absent";
const MARKS = "Late and Early Out marks";
const LUNCH = "Late back from lunch (Strict mode only)";
const MIDNIGHT = "Forgotten last punch after midnight";
const PRODUCTION = "Production workers";

/** Every setting on the Attendance tab, for the page's search (see kit/catalog.ts). Same words as the blocks. */
export const ATTENDANCE_SETTINGS: SettingMeta[] = [
  {
    id: "attendance-mode",
    tab: "attendance",
    section: MODE,
    title: "Strict or Simple mode",
    purpose:
      "Chooses whether a staff day also records how late someone came back from lunch. Full Day, Half Day or Absent, Late, Early Out and pay are worked out the same way in both modes.",
    keywords: ["strict", "simple", "4 punch", "four punch", "lunch", "calculation"],
  },
  {
    id: "late-window",
    tab: "attendance",
    section: DAY,
    title: "Late window (minutes)",
    purpose:
      "How long after the shift start plus its grace a first punch is only Late: the day stays a Full Day but counts one mark in the monthly late pool. A later arrival is not Late: it becomes a quarter-shift day (or is excused by a permission).",
    keywords: ["late", "arrival", "grace", "morning", "timeline", "punctuality"],
  },
  {
    id: "permission-window",
    tab: "attendance",
    section: DAY,
    title: "Permission window (minutes)",
    purpose:
      "Minutes after the Late window up to which an approved Morning Late-In permission (within the monthly cap) still excuses the arrival: a Full Day and no Late mark. Without such a permission these arrivals are quarter-shift days.",
    keywords: ["permission", "late in", "excused", "arrival", "timeline"],
  },
  {
    id: "extra-minutes",
    tab: "attendance",
    section: DAY,
    title: "Extra minutes",
    purpose:
      "A last stretch after the Permission window: an arrival in it still makes the morning half (the day is not cut to a Half Day) but always takes the quarter-shift deduction. A permission never covers these minutes.",
    keywords: ["first half", "limit", "morning half", "arrival", "timeline"],
  },
  {
    id: "quarter-deduction",
    tab: "attendance",
    section: DAY,
    title: "Quarter-shift deduction (shifts)",
    purpose:
      "How much of the day's pay is taken off for an arrival after the Late window that no permission covers, while still inside the morning half. It replaces the Late mark for that day: never both.",
    keywords: ["quarter", "deduction", "pay", "salary", "cut", "0.25"],
  },
  {
    id: "second-half-start",
    tab: "attendance",
    section: DAY,
    title: "Second Half Start Time",
    purpose:
      "The clock time after which any punch counts as having worked the afternoon half. Together with the morning half (a first punch by the first-half limit) it decides the day: both halves = Full Day, one = Half Day, neither = Absent.",
    keywords: ["half day", "absent", "full day", "afternoon", "evening half", "14:30"],
  },
  {
    id: "morning-late-in",
    tab: "attendance",
    section: MARKS,
    title: "Morning Late-In",
    purpose:
      "Turns the Late mark on or off for a first punch inside the Late window. Each Late day is one mark in the monthly late pool.",
    keywords: ["late", "switch", "mark", "pool", "whatsapp alert"],
  },
  {
    id: "evening-early-out",
    tab: "attendance",
    section: MARKS,
    title: "Evening Early-Out",
    purpose:
      "Turns the Early Out mark on or off for a last punch before the shift end minus its grace. Each Early Out day is one mark in the same monthly pool as Late.",
    keywords: ["early out", "leave early", "switch", "mark", "pool"],
  },
  {
    id: "night-late-window",
    tab: "attendance",
    section: LUNCH,
    title: "Night Late Window (minutes past lunch deadline)",
    purpose:
      "How many minutes after the lunch deadline a late return is labelled 'Late after lunch' (Night Late). Every late return is flagged in some way: this number and the next one only decide which label it gets.",
    keywords: ["night late", "lunch", "afternoon", "strict", "return"],
  },
  {
    id: "lunch-permission-zone",
    tab: "attendance",
    section: LUNCH,
    title: "Afternoon Permission Zone Width (minutes)",
    purpose:
      "A band straight after the Night Late window: a return in it is labelled 'Lunch-return permission' instead of Night Late. A return after the band is 'Late after lunch' again. 0 means there is no such band.",
    keywords: ["afternoon", "permission zone", "lunch", "strict"],
  },
  {
    id: "forgotten-last-out",
    tab: "attendance",
    section: MIDNIGHT,
    title: "Forgotten Last-Out Grace (hours after shift end)",
    purpose:
      "A punch on the next morning, up to this many hours after the shift's end, is treated as the day before's last punch, but only when that day has no punch at or after its own shift end. 0 switches this off.",
    keywords: ["midnight", "cross midnight", "missing punch", "last out", "exit", "night"],
  },
  {
    id: "early-arrival-protection",
    tab: "attendance",
    section: MIDNIGHT,
    title: "Next-Day Early-Arrival Protection (hours before shift start)",
    purpose:
      "The window above always stops this many hours before the next day's own shift starts, so a genuinely early arrival is never given to the day before. 0 lets the window run right up to the next shift's start.",
    keywords: ["midnight", "buffer", "early arrival", "protection"],
  },
  {
    id: "production-days-valued",
    tab: "attendance",
    section: PRODUCTION,
    title: "How a production day is valued",
    purpose:
      "Nothing on the Staff page applies to production workers. A production day is valued by the production shift rules on the Production Shifts tab (the shift group of the day, the shifts its leaving time earns, the unpaid breaks and the grace), and what a late day costs a production worker is set on Late Detection, Production page. This page only explains that, and shows the old calculation for earlier days.",
    keywords: ["production", "shifts earned", "production shifts", "where", "explanation", "late detection", "workers"],
  },
  {
    id: "production-attendance",
    tab: "attendance",
    section: PRODUCTION,
    title: "Old production punch times and pay segments",
    purpose:
      "Before the production shift rules start, a production day earns the segments its punches cover: a segment is earned when the worker arrives by its start plus the grace and leaves no earlier than its end minus the grace. This is the old calculation, kept read-only for those days; from the rules' start date the Production Shifts tab decides.",
    keywords: ["production", "segments", "punch 1", "punch 4", "shift value", "grace", "old calculation", "read-only"],
  },
  {
    id: "production-late",
    tab: "attendance",
    section: PRODUCTION,
    title: "Production late deductions",
    purpose:
      "What a late production arrival costs is set on Settings - Late Detection, Production page, with its own free allowance and slabs for each pay cycle. From the start date of the production shift rules a day is judged late from its group's start and the grace on the Production Shifts tab; before it, from the old production shift in Manage Shift, not from Punch 1 above.",
    keywords: ["production", "late", "deduction", "production payroll"],
  },
];

/** The settings of the Production page; every other setting of this tab is on the Staff page. */
const PRODUCTION_PAGE = new Set(["production-days-valued", "production-attendance", "production-late"]);

/** Which page (Staff or Production) holds each setting, so a link or a search result can open it. */
export const ATTENDANCE_VIEW_OF: Record<string, ClassView> = Object.fromEntries(
  ATTENDANCE_SETTINGS.map((m) => [m.id, PRODUCTION_PAGE.has(m.id) ? "production" : "staff"]),
);
