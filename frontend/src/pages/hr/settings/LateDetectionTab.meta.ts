import type { PayCycle } from "@/lib/api-client/custom-hooks";
import type { SettingMeta } from "./kit/catalog";
import type { ClassView } from "./kit/view";
import { CYCLE_INFO, CYCLES } from "./production-payroll/cycles";

type LateSettingMeta = Omit<SettingMeta, "tab"> & { view: ClassView; cycle?: PayCycle };

/** Section headings, so the blocks and this list cannot drift apart. */
export const LATE_SECTIONS = {
  policy: "Late Detection Policy",
  permission: "Permission Policy",
  pricing: "Permission Pricing",
  production: "Production late detection",
} as const;

/** Each pay cycle's section heading on the Production page ("Weekly late deductions"). */
export const CYCLE_LATE_SECTIONS: Record<PayCycle, string> = Object.fromEntries(
  CYCLES.map((cycle) => [cycle, `${CYCLE_INFO[cycle].label} late deductions`]),
) as Record<PayCycle, string>;

const S = LATE_SECTIONS;

const CYCLE_WORDS: Record<PayCycle, string[]> = {
  weekly: ["weekly", "week", "one week", "7 days"],
  biweekly: ["biweekly", "bi-weekly", "fortnight", "two weeks", "2 weeks", "14 days"],
  monthly: ["monthly", "four weeks", "4 weeks", "28 days"],
};

/** The two setting blocks of one pay cycle's late rules on the Production page. */
function cycleBlocks(cycle: PayCycle): LateSettingMeta[] {
  const { label, days } = CYCLE_INFO[cycle];
  const words = CYCLE_WORDS[cycle];
  return [
    {
      id: `${cycle}-late-allowance`,
      view: "production",
      cycle,
      section: CYCLE_LATE_SECTIONS[cycle],
      title: `Free late days a period (${label})`,
      purpose: `How many late days a production worker on the ${label} cycle may have in one ${days}-day period before anything is deducted. The shared production value applies until this cycle is given a value of its own.`,
      keywords: [...words, "free allowance", "late", "per period", "production"],
    },
    {
      id: `${cycle}-late-slabs`,
      view: "production",
      cycle,
      section: CYCLE_LATE_SECTIONS[cycle],
      title: `Deduction slabs (${label})`,
      purpose: `How many shifts of pay a worker on the ${label} cycle loses once they reach a number of billable lates (lates beyond the free allowance) in one period. The highest row reached applies, and the last row holds beyond it.`,
      keywords: [...words, "slab", "deduct shifts", "billable lates", "penalty", "production"],
    },
  ];
}

/**
 * Every setting block on the Late Detection tab: its anchor id, the page it sits on (Staff or Production), the pay cycle
 * it belongs to on the Production page, and the words the block shows. Types only are imported here: this list is read by
 * the search catalogue (metas.ts), which the end-to-end specs load under Node.
 */
const BLOCKS: LateSettingMeta[] = [
  {
    id: "free-allowance",
    view: "staff",
    section: S.policy,
    title: "Free allowance (marks a month that cost nothing)",
    purpose:
      "How many marks (Late, Early Out and, unless permissions are priced separately, permissions beyond the cap, together) each staff member gets free every calendar month before any salary is cut.",
    keywords: ["late", "free", "allowance", "occurrences", "pool", "deduction", "early out"],
  },
  {
    id: "deduction-slabs",
    view: "staff",
    section: S.policy,
    title: "Deduction slabs",
    purpose:
      "Turns the month's billable marks (those beyond the free allowance) into shifts of salary taken off. The highest row the billable count reaches applies, and the last row holds for anything beyond it. No rows means marks cost nothing.",
    keywords: ["late", "slab", "deduction", "salary", "cut", "billable", "penalty", "shifts"],
  },
  {
    id: "permission-cap",
    view: "staff",
    section: S.permission,
    title: "Permission Monthly Cap",
    purpose:
      "How many approved permissions per staff member per calendar month actually protect a day, counted earliest first. A permission beyond the cap can still be approved, but it excuses nothing and adds one mark to the late pool (or is priced on its own when permission pricing is on).",
    keywords: ["permission", "cap", "limit", "late in", "early out", "middle", "excess", "monthly"],
  },
  {
    id: "permission-pricing",
    view: "staff",
    section: S.pricing,
    title: "Price permissions separately",
    purpose:
      "Off (the default): every approved permission beyond the monthly cap is one more mark in the late pool, priced with the free allowance and slabs above. On: those extra permissions leave the late pool and are priced on their own, by the free permissions and slabs below, so nothing is deducted twice. Staff only, and company-wide.",
    keywords: ["permission", "pricing", "price", "separately", "switch", "excess", "extra permissions", "late pool"],
  },
  {
    id: "permission-free-allowance",
    view: "staff",
    section: S.pricing,
    title: "Free extra permissions a month",
    purpose:
      "Only while permissions are priced separately: how many of a month's permissions beyond the cap cost nothing before the slabs start. 0 means the very first extra permission is already priced.",
    keywords: ["permission", "free", "allowance", "extra permissions", "excess", "pricing"],
  },
  {
    id: "permission-deduction-slabs",
    view: "staff",
    section: S.pricing,
    title: "Permission deduction slabs",
    purpose:
      "Only while permissions are priced separately: turns the month's billable permissions (the extra ones beyond the free permissions) into shifts of salary taken off. The highest row the count reaches applies, and the last row holds beyond it. At least one row is needed to turn the pricing on.",
    keywords: ["permission", "slab", "deduction", "salary", "cut", "billable", "penalty", "shifts", "pricing"],
  },
  {
    id: "prod-late-switch",
    view: "production",
    section: S.production,
    title: "Deduct pay for late production workers",
    purpose:
      "The on/off switch for production late deductions on every pay cycle. When on, each worker's punches are checked against the start and the grace of their day's group on the Production Shifts tab (days before that tab's rules start use the production shift assigned in Manage Shifts), and late days beyond their cycle's free allowance cost shifts of pay.",
    keywords: ["late detection", "production", "enable", "deduction", "late", "switch"],
  },
  {
    id: "prod-attendance-mode",
    view: "production",
    section: S.production,
    title: "What counts as late (Attendance Mode)",
    purpose:
      "Simple: a day is late when the first punch is after the shift start plus grace. Strict: also when the last punch is before the shift end minus grace. A day counts once either way, on every pay cycle.",
    keywords: ["strict", "simple", "attendance mode", "early out", "grace", "production"],
  },
  ...CYCLES.flatMap(cycleBlocks),
];

/** Every setting on the Late Detection tab, for the page's search (see kit/catalog.ts). Same words as the blocks. */
export const LATE_DETECTION_SETTINGS: SettingMeta[] = BLOCKS.map(({ view: _view, cycle: _cycle, ...meta }) => ({
  ...meta,
  tab: "late_detection",
}));

/** Which page (Staff or Production) holds each setting, so a link or a search result can open it. */
export const LATE_VIEW_OF: Record<string, ClassView> = Object.fromEntries(BLOCKS.map((b) => [b.id, b.view]));

/** The pay cycle each Production setting belongs to, so a link or a search result opens that cycle's pill. */
export const LATE_CYCLE_OF: Record<string, PayCycle> = Object.fromEntries(
  BLOCKS.filter((b): b is LateSettingMeta & { cycle: PayCycle } => b.cycle !== undefined).map((b) => [b.id, b.cycle]),
);

/** The title and purpose a block shows (the same words the search finds). */
export function lateText(id: string): { title: string; purpose: string } {
  const block = BLOCKS.find((b) => b.id === id);
  if (!block) throw new Error(`No Late Detection setting "${id}"`);
  return { title: block.title, purpose: block.purpose };
}
