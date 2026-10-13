import type { SettingMeta } from "./kit/catalog";

export type PayrollSubTab = "rates" | "bonus" | "otCompensation" | "prodPfEf";

type PayrollSettingMeta = Omit<SettingMeta, "tab"> & { subTab: PayrollSubTab };

/** Section headings, so the blocks and this list cannot drift apart. */
export const PAYROLL_SECTIONS = {
  staff: "Staff PF and ESI",
  production: "Production PF and ESI (flat rates)",
  calendar: "Pay calendar and defaults",
  bonus: "Statutory bonus",
  features: "OT & Compensation Features",
  otDetection: "OT Detection",
  bands: "Production PF / EF salary bands",
} as const;

const S = PAYROLL_SECTIONS;

/** Every setting block on the Payroll tab: its anchor id, the sub-tab it sits in, and the words the block shows. */
const BLOCKS: PayrollSettingMeta[] = [
  {
    id: "staff-pf-esi-switch",
    subTab: "rates",
    section: S.staff,
    title: "Deduct PF and ESI from staff pay",
    purpose:
      "The on/off switch for staff PF and ESI. While it is off, no staff payslip gets a PF or ESI deduction, even if the rates below are filled in.",
    keywords: ["enable", "staff payroll rules", "provident fund", "deduction", "switch"],
  },
  {
    id: "staff-pf-rate",
    subTab: "rates",
    section: S.staff,
    title: "Staff PF rate",
    purpose:
      "The share of a staff member's Basic pay deducted as employee Provident Fund. Payroll fixes Basic at 50% of the salary earned in the month, whatever Salary Split is recorded on the employee.",
    keywords: ["pf", "provident fund", "percent", "basic", "employer pf"],
  },
  {
    id: "staff-esi-rate",
    subTab: "rates",
    section: S.staff,
    title: "Staff ESI rate",
    purpose:
      "The share of a staff member's pay for the month (OT pay not included) deducted as employee ESI, for staff whose full monthly salary is at or below the ESI ceiling.",
    keywords: ["esi", "employee state insurance", "percent", "employer esi"],
  },
  {
    id: "staff-esi-ceiling",
    subTab: "rates",
    section: S.staff,
    title: "Staff ESI ceiling",
    purpose:
      "The monthly salary up to which a staff member pays ESI. The full monthly salary is compared, and a salary equal to the ceiling still pays ESI.",
    keywords: ["esi applicable below", "limit", "21000", "wage limit"],
  },
  {
    id: "prod-pf-esi-switch",
    subTab: "rates",
    section: S.production,
    title: "Deduct flat-rate PF and ESI from production pay",
    purpose:
      "The on/off switch for the production flat rates below. A matching salary band (Production PF/EF sub-tab) is used instead whenever bands are on, even while this switch is off.",
    keywords: ["enable", "production payroll rules", "shift", "deduction", "switch"],
  },
  {
    id: "prod-pf-rate",
    subTab: "rates",
    section: S.production,
    title: "Production PF rate",
    purpose:
      "The share of a production worker's pay for the pay period deducted as PF. It is taken from the whole period pay, not from half of it as for staff.",
    keywords: ["pf", "provident fund", "shift", "percent"],
  },
  {
    id: "prod-esi-rate",
    subTab: "rates",
    section: S.production,
    title: "Production ESI rate",
    purpose:
      "The share of a production worker's pay for the pay period deducted as ESI, while their estimated monthly pay is at or below the production ESI ceiling.",
    keywords: ["esi", "shift", "percent"],
  },
  {
    id: "prod-esi-ceiling",
    subTab: "rates",
    section: S.production,
    title: "Production ESI ceiling",
    purpose:
      "The estimated monthly pay up to which a production worker pays ESI. Payroll estimates monthly pay from the pay cycle: the period's pay x 4 on Weekly, x 2 on BiWeekly, x 1 on Monthly.",
    keywords: ["esi applicable below", "monthly estimate", "limit", "shift"],
  },
  {
    id: "pay-day",
    subTab: "rates",
    section: S.calendar,
    title: "Salary pay day",
    purpose:
      "The day of the month by which last month's salary should be paid. Only the MD portal uses it, to warn when payroll is late; it does not change any pay.",
    keywords: ["salary day", "due date", "late payroll", "md portal"],
  },
  {
    id: "fy-start-month",
    subTab: "rates",
    section: S.calendar,
    title: "Financial year start month",
    purpose:
      "The month your financial year begins. It decides which 12 months of payslips make up a year for statutory bonus, and the financial-year periods of payroll reports.",
    keywords: ["fy", "april", "bonus year", "financial year"],
  },
  {
    id: "default-salary-per-shift",
    subTab: "rates",
    section: S.calendar,
    title: "Suggested rate per shift for new production employees",
    purpose:
      "The Salary Per Shift filled in for you when you add a new production employee. Pay always uses each employee's own rate, so changing it never changes anyone's pay.",
    keywords: ["default salary per shift", "rate", "add employee", "production"],
  },
  {
    id: "bonus-percent",
    subTab: "bonus",
    section: S.bonus,
    title: "Bonus rate",
    purpose:
      "The percentage of each eligible employee's bonus wage for the financial year that is paid as statutory bonus. The Payment of Bonus Act sets 8.33% as the minimum and 20% as the maximum.",
    keywords: ["bonus percent", "8.33", "payment of bonus act", "statutory"],
  },
  {
    id: "bonus-wage-ceiling",
    subTab: "bonus",
    section: S.bonus,
    title: "Bonus wage ceiling",
    purpose:
      "The most Basic pay per payslip that counts towards bonus. A payslip's Basic above it counts as this amount.",
    keywords: ["7000", "wage ceiling", "bonus", "cap"],
  },
  {
    id: "bonus-eligibility-ceiling",
    subTab: "bonus",
    section: S.bonus,
    title: "Bonus eligibility limit",
    purpose:
      "Who gets a bonus at all: employees whose latest payslip Basic in the year is above this amount get none. Basic, not salary, is compared.",
    keywords: ["eligibility ceiling", "21000", "bonus", "eligible"],
  },
  {
    id: "compensation-features",
    subTab: "otCompensation",
    section: S.features,
    title: "OT & Compensation features",
    purpose:
      "One switch that pauses or resumes everything the Compensation feature does by itself: finding overtime, adding announced OT pay to payslips, and letting Compensation Days excuse late and permission marks. The Compensation page always stays in the sidebar.",
    keywords: ["overtime", "compensation", "master switch", "compensation day", "ot pay"],
  },
  {
    id: "ot-detection",
    subTab: "otCompensation",
    section: S.otDetection,
    title: "Find overtime automatically",
    purpose:
      "Lets the system flag staff who keep working past the end of their own shift, so HR can review each day on the Compensation page. A flag alone pays nothing.",
    keywords: ["enable ot detection", "overtime", "ot"],
  },
  {
    id: "ot-threshold",
    subTab: "otCompensation",
    section: S.otDetection,
    title: "OT threshold",
    purpose:
      "How many minutes after their shift's end a staff member's last punch must be for that day to count as overtime. Exactly the threshold counts.",
    keywords: ["overtime", "minutes", "shift end", "ot"],
  },
  {
    id: "pf-ef-switch",
    subTab: "prodPfEf",
    section: S.bands,
    title: "Use salary bands for production PF and ESI",
    purpose:
      "Lets production PF and ESI depend on how much a worker earns: each band has its own PF % and EF % (EF is the ESI deduction). A matching band is used instead of the flat rates.",
    keywords: ["pf/ef", "salary range", "rules", "ef", "production"],
  },
  {
    id: "pf-ef-rules",
    subTab: "prodPfEf",
    section: S.bands,
    title: "Salary bands",
    purpose:
      "One row per band: a name, the lowest and highest estimated monthly pay it covers (both included; highest 0 = no upper limit), and the PF % and EF % taken from the period pay. The first band in the list that fits is used.",
    keywords: ["pf/ef", "salary range", "min salary", "max salary", "category"],
  },
];

/** Every setting on the Payroll tab, for the page's search (see kit/catalog.ts). */
export const PAYROLL_SETTINGS: SettingMeta[] = BLOCKS.map(({ subTab: _subTab, ...meta }) => ({
  ...meta,
  tab: "payroll",
}));

/** Which sub-tab holds each setting, so a link or a search result can open it. */
export const PAYROLL_SUB_TAB_OF: Record<string, PayrollSubTab> = Object.fromEntries(
  BLOCKS.map((b) => [b.id, b.subTab]),
);

/** The title and purpose a block shows (the same words the search finds). */
export function payrollText(id: string): { title: string; purpose: string } {
  const block = BLOCKS.find((b) => b.id === id);
  if (!block) throw new Error(`No Payroll setting "${id}"`);
  return { title: block.title, purpose: block.purpose };
}
