import type { SettingMeta } from "./kit/catalog";

const tab = "casual_leave";
const WHO = "Who may take Casual Leave";
const DAYS = "Days given";
const YEAR_END = "31 December";
const START = "When the policy starts";

/** Every setting on the Casual Leave tab, for the page's search (see kit/catalog.ts). */
export const CASUAL_LEAVE_SETTINGS: SettingMeta[] = [
  {
    id: "cl-service",
    tab,
    section: WHO,
    title: "Service before Casual Leave",
    purpose: "How long someone must have worked here before they may take Casual Leave: a number of months or of days.",
    keywords: ["casual leave", "cl", "eligibility", "eligible", "service", "months", "days", "probation", "new joiner"],
  },
  {
    id: "cl-allocation",
    tab,
    section: DAYS,
    title: "How the days are given",
    purpose: "Earned month by month, or the whole year's days at once.",
    keywords: ["casual leave", "cl", "allocation", "monthly", "yearly", "entitlement", "accrual", "earned"],
  },
  {
    id: "cl-days",
    tab,
    section: DAYS,
    title: "Days a month / Days a year",
    purpose: "How many Casual Leave days each month adds (or the year gives at once).",
    keywords: ["casual leave", "cl", "days", "per month", "per year", "quota", "balance", "12"],
  },
  {
    id: "cl-carry",
    tab,
    section: DAYS,
    title: "Carry forward unused days",
    purpose: "Whether a month's unused days stay for later months of the year, with no monthly limit on using them.",
    keywords: ["casual leave", "cl", "carry forward", "carry over", "accumulate", "unused", "lapse"],
  },
  {
    id: "cl-half-days",
    tab,
    section: DAYS,
    title: "Half days",
    purpose: "Whether employees may ask for half a day (first or second half of the shift, 0.5 day).",
    keywords: ["casual leave", "cl", "half day", "first half", "second half", "0.5"],
  },
  {
    id: "cl-year-end",
    tab,
    section: YEAR_END,
    title: "Unused days at the end of the year",
    purpose: "Whether the days left on 31 December lapse or move into the next year, and the most that may move.",
    keywords: ["casual leave", "cl", "year end", "31 december", "lapse", "carry", "next year", "maximum"],
  },
  {
    id: "cl-start",
    tab,
    section: START,
    title: "Policy starts on",
    purpose: "Casual Leave dated before this day never counts against the balance.",
    keywords: ["casual leave", "cl", "start", "cut-over", "since", "balance since"],
  },
];
