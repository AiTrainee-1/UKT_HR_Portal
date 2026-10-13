import type { SettingMeta } from "./kit/catalog";

/** Every setting on the Late Detection tab, for the page's search (see kit/catalog.ts). Same words as the blocks. */
export const LATE_DETECTION_SETTINGS: SettingMeta[] = [
  {
    id: "free-allowance",
    tab: "late_detection",
    section: "Late Detection Policy",
    title: "Free allowance (marks a month that cost nothing)",
    purpose:
      "How many marks (Late, Early Out and permissions beyond the cap, together) each staff member gets free every calendar month before any salary is cut.",
    keywords: ["late", "free", "allowance", "occurrences", "pool", "deduction", "early out"],
  },
  {
    id: "deduction-slabs",
    tab: "late_detection",
    section: "Late Detection Policy",
    title: "Deduction slabs",
    purpose:
      "Turns the month's billable marks (those beyond the free allowance) into shifts of salary taken off. The highest row the billable count reaches applies, and the last row holds for anything beyond it. No rows means marks cost nothing.",
    keywords: ["late", "slab", "deduction", "salary", "cut", "billable", "penalty", "shifts"],
  },
  {
    id: "permission-cap",
    tab: "late_detection",
    section: "Permission Policy",
    title: "Permission Monthly Cap",
    purpose:
      "How many approved permissions per staff member per calendar month actually protect a day, counted earliest first. A permission beyond the cap can still be approved, but it excuses nothing and adds one mark to the late pool.",
    keywords: ["permission", "cap", "limit", "late in", "early out", "middle", "excess", "monthly"],
  },
];
