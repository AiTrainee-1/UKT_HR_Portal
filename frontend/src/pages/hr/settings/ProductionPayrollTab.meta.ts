import type { PayCycle } from "@/lib/api-client/custom-hooks";
import type { SettingMeta } from "./kit/catalog";
import { CYCLE_INFO, CYCLES } from "./production-payroll/cycles";

/** The sub-tabs: one per pay cycle, the global late detection, and the read-only Attendance & Shift. */
export type ProductionPayrollSubTab = PayCycle | "late" | "shift";

type ProductionSettingMeta = Omit<SettingMeta, "tab"> & { subTab: ProductionPayrollSubTab };

/** Section headings, so the blocks and this list cannot drift apart. */
export const PRODUCTION_SECTIONS = {
  shift: "Shifts earned, pay and PF / ESI",
  late: "Production late detection",
  perCycle: "Free late days and slabs are set per cycle",
} as const;

/** Each cycle's two section headings ("Weekly pay period", "Weekly late deductions"). */
export const CYCLE_SECTIONS: Record<PayCycle, { period: string; late: string }> = Object.fromEntries(
  CYCLES.map((cycle) => [
    cycle,
    { period: `${CYCLE_INFO[cycle].label} pay period`, late: `${CYCLE_INFO[cycle].label} late deductions` },
  ]),
) as Record<PayCycle, { period: string; late: string }>;

const S = PRODUCTION_SECTIONS;

const CYCLE_WORDS: Record<PayCycle, string[]> = {
  weekly: ["weekly", "week", "one week", "7 days"],
  biweekly: ["biweekly", "bi-weekly", "fortnight", "two weeks", "2 weeks", "14 days"],
  monthly: ["monthly", "four weeks", "4 weeks", "28 days"],
};

/** The four setting blocks of one cycle's sub-tab: its period rule and its own late rules. */
function cycleBlocks(cycle: PayCycle): ProductionSettingMeta[] {
  const { label, weeks, days, every } = CYCLE_INFO[cycle];
  const length = weeks === 1 ? "one whole week" : `${weeks} whole weeks`;
  const words = CYCLE_WORDS[cycle];
  return [
    {
      id: `${cycle}-week-start`,
      subTab: cycle,
      section: CYCLE_SECTIONS[cycle].period,
      title: `Week starts on (${label})`,
      purpose: `Which weekday each ${label} pay period starts on, any of the seven. A week ends on the day before its start weekday comes round again: a Monday start ends on a Sunday, a Wednesday start on a Tuesday, a Sunday start on a Saturday. A ${label} period is ${length}, ${days} days, paid ${every}.`,
      keywords: [
        ...words,
        "week start",
        "weekday",
        "week day",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "pay period",
      ],
    },
    {
      id: `${cycle}-first-period`,
      subTab: cycle,
      section: CYCLE_SECTIONS[cycle].period,
      title: `First period starts on (${label})`,
      purpose:
        cycle === "weekly"
          ? "Optional for Weekly: every week starts on the weekday above whatever date is here, so Weekly periods are the same with or without it. It is kept so the three cycles are set up the same way."
          : `The date the ${label} periods are counted from, forwards and backwards: it decides which week a ${weeks}-week period begins on. Any date works, it is moved back to the start weekday. Without it, ${label} payroll cannot be generated.`,
      keywords: [...words, "anchor", "start date", "first period", "counted from"],
    },
    {
      id: `${cycle}-late-allowance`,
      subTab: cycle,
      section: CYCLE_SECTIONS[cycle].late,
      title: `Free late days a period (${label})`,
      purpose: `How many late days a production worker on the ${label} cycle may have in one ${days}-day period before anything is deducted. The shared production value applies until this cycle is given a value of its own.`,
      keywords: [...words, "free allowance", "late", "per period"],
    },
    {
      id: `${cycle}-late-slabs`,
      subTab: cycle,
      section: CYCLE_SECTIONS[cycle].late,
      title: `Deduction slabs (${label})`,
      purpose: `How many shifts of pay a worker on the ${label} cycle loses once they reach a number of billable lates (lates beyond the free allowance) in one period. The highest row reached applies, and the last row holds beyond it.`,
      keywords: [...words, "slab", "deduct shifts", "billable lates", "penalty"],
    },
  ];
}

/** Every setting block on the Production Payroll tab: its anchor id, its sub-tab, and the words the block shows. */
const BLOCKS: ProductionSettingMeta[] = [
  ...CYCLES.flatMap(cycleBlocks),
  {
    id: "prod-late-switch",
    subTab: "late",
    section: S.late,
    title: "Deduct pay for late production workers",
    purpose:
      "The on/off switch for production late deductions on every pay cycle. When on, each worker's punches are checked against the start and the grace of their day's group on the Production Shifts tab (days before that tab's rules start use the production shift assigned in Manage Shifts), and late days beyond their cycle's free allowance cost shifts of pay.",
    keywords: ["late detection", "production", "enable", "deduction", "late", "switch"],
  },
  {
    id: "prod-attendance-mode",
    subTab: "late",
    section: S.late,
    title: "What counts as late (Attendance Mode)",
    purpose:
      "Simple: a day is late when the first punch is after the shift start plus grace. Strict: also when the last punch is before the shift end minus grace. A day counts once either way, on every pay cycle.",
    keywords: ["strict", "simple", "attendance mode", "early out", "grace"],
  },
  {
    id: "prod-shifts-earned",
    subTab: "shift",
    section: S.shift,
    title: "How a production day earns pay",
    purpose:
      "Each day's punches are worked out by the production shift rules on the Production Shifts tab: the group the day belongs to, the shifts its leaving time earns on that group's ladder, with the unpaid breaks left out. Pay is the shifts earned times the worker's own Salary Per Shift. Days before the rules' start date keep the old calculation (the old punch times and segments). Nothing on this tab changes that.",
    keywords: [
      "shifts earned",
      "production shifts",
      "ladder",
      "segments",
      "punch times",
      "salary per shift",
      "attendance",
    ],
  },
  {
    id: "prod-pf-esi-where",
    subTab: "shift",
    section: S.shift,
    title: "PF and ESI on production payslips",
    purpose:
      "Production PF and ESI are set on the Payroll tab in two ways: flat rates (one rate each, behind their own switch) and salary bands by estimated monthly pay. A matching band is used first, even while the flat-rate switch is off; otherwise the flat rates when their switch is on; otherwise nothing is deducted.",
    keywords: ["pf", "esi", "ef", "flat rates", "salary bands", "provident fund", "production", "monthly estimate"],
  },
  {
    id: "prod-assigned-shifts",
    subTab: "shift",
    section: S.shift,
    title: "Assigned production shift rules",
    purpose:
      "Read-only: the production shifts kept in Manage Shifts. Before the Production Shifts rules start, production late detection compares each worker's punches with the start, end and grace of the shift they are assigned on that day, and a worker with no assigned shift is never late. From their start date the day's group on the Production Shifts tab (its start, its departure and the grace there) is used instead.",
    keywords: ["assigned shift", "grace", "shift template", "manage shift", "late"],
  },
];

/** Every setting on the Production Payroll tab, for the page's search (see kit/catalog.ts). */
export const PRODUCTION_PAYROLL_SETTINGS: SettingMeta[] = BLOCKS.map(({ subTab: _subTab, ...meta }) => ({
  ...meta,
  tab: "production_payroll",
}));

/** Which sub-tab holds each setting, so a link or a search result can open it. */
export const PRODUCTION_SUB_TAB_OF: Record<string, ProductionPayrollSubTab> = Object.fromEntries(
  BLOCKS.map((b) => [b.id, b.subTab]),
);

/** The title and purpose a block shows (the same words the search finds). */
export function productionText(id: string): { title: string; purpose: string } {
  const block = BLOCKS.find((b) => b.id === id);
  if (!block) throw new Error(`No Production Payroll setting "${id}"`);
  return { title: block.title, purpose: block.purpose };
}
