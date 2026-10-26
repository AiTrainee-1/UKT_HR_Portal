import type { PayCycle } from "@/lib/api-client/custom-hooks";
import type { SettingMeta } from "./kit/catalog";
import { CYCLE_INFO, CYCLES } from "./production-payroll/cycles";

/** The sub-tabs: the read-only Overview, one per pay cycle (its period rule), and Pay & Bonus. */
export type ProductionPayrollSubTab = "overview" | PayCycle | "payBonus";

type ProductionSettingMeta = Omit<SettingMeta, "tab"> & { subTab: ProductionPayrollSubTab };

/** Section headings, so the blocks and this list cannot drift apart. */
export const PRODUCTION_SECTIONS = {
  shift: "Shifts earned, pay and PF / ESI",
  pay: "Rate for new production employees",
  bonus: "Production statutory bonus",
} as const;

/** Each cycle's section heading ("Weekly pay period"). What a late day costs is on Late Detection -> Production. */
export const CYCLE_SECTIONS: Record<PayCycle, { period: string }> = Object.fromEntries(
  CYCLES.map((cycle) => [cycle, { period: `${CYCLE_INFO[cycle].label} pay period` }]),
) as Record<PayCycle, { period: string }>;

const S = PRODUCTION_SECTIONS;

const CYCLE_WORDS: Record<PayCycle, string[]> = {
  weekly: ["weekly", "week", "one week", "7 days"],
  biweekly: ["biweekly", "bi-weekly", "fortnight", "two weeks", "2 weeks", "14 days"],
  monthly: ["monthly", "four weeks", "4 weeks", "28 days"],
};

/** The two setting blocks of one cycle's sub-tab: its period rule. */
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
  ];
}

/** Every setting block on the Production Payroll tab: its anchor id, its sub-tab, and the words the block shows. */
const BLOCKS: ProductionSettingMeta[] = [
  {
    id: "prod-shifts-earned",
    subTab: "overview",
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
      "overview",
    ],
  },
  {
    id: "prod-pf-esi-where",
    subTab: "overview",
    section: S.shift,
    title: "PF and ESI on production payslips",
    purpose:
      "Production PF and ESI are set on the PF & ESI tab, Production page, as rules: a salary range, what the range is measured on and a percentage. Only workers switched ON in Employees, Co Emp pay them. The first rule that fits the worker applies; with none, nothing is deducted. Here you only see how the pay cycle scales a month.",
    keywords: ["pf", "esi", "provident fund", "production", "monthly estimate", "co emp", "rules", "pf & esi"],
  },
  {
    id: "prod-assigned-shifts",
    subTab: "overview",
    section: S.shift,
    title: "Assigned production shift rules",
    purpose:
      "Read-only: the production shifts kept in Manage Shifts. Before the Production Shifts rules start, production late detection compares each worker's punches with the start, end and grace of the shift they are assigned on that day, and a worker with no assigned shift is never late. From their start date the day's group on the Production Shifts tab (its start, its departure and the grace there) is used instead.",
    keywords: ["assigned shift", "grace", "shift template", "manage shift", "late"],
  },
  ...CYCLES.flatMap(cycleBlocks),
  {
    id: "default-salary-per-shift",
    subTab: "payBonus",
    section: S.pay,
    title: "Suggested rate per shift for new production employees",
    purpose:
      "The Salary Per Shift filled in for you when you add a new production employee. Pay always uses each employee's own rate, so changing it never changes anyone's pay.",
    keywords: ["default salary per shift", "rate", "add employee", "production", "new employee"],
  },
  {
    id: "prod-bonus-percent",
    subTab: "payBonus",
    section: S.bonus,
    title: "Production bonus rate",
    purpose:
      "The percentage of each eligible production worker's bonus wage for the financial year that is paid as statutory bonus. Staff have their own rate on Staff Payroll. The Payment of Bonus Act sets 8.33% as the minimum and 20% as the maximum.",
    keywords: ["bonus percent", "8.33", "payment of bonus act", "statutory", "production", "worker"],
  },
  {
    id: "prod-bonus-wage-ceiling",
    subTab: "payBonus",
    section: S.bonus,
    title: "Production bonus wage ceiling",
    purpose:
      "The most pay per production payslip that counts towards a worker's bonus. A production payslip's Basic is its whole period pay, and anything above this amount counts as this amount. Staff have their own ceiling on Staff Payroll.",
    keywords: ["7000", "wage ceiling", "bonus", "cap", "production", "per payslip"],
  },
  {
    id: "prod-bonus-eligibility-ceiling",
    subTab: "payBonus",
    section: S.bonus,
    title: "Production bonus eligibility limit",
    purpose:
      "Who gets a bonus at all: production workers whose latest payslip in the year has period pay above this amount get none. Staff have their own limit on Staff Payroll.",
    keywords: ["eligibility ceiling", "21000", "bonus", "eligible", "production"],
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
