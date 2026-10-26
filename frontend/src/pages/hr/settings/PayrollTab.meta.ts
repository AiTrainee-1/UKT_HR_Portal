import type { SettingMeta } from "./kit/catalog";

export type PayrollSubTab = "rates" | "bonus" | "otCompensation";

type PayrollSettingMeta = Omit<SettingMeta, "tab"> & { subTab: PayrollSubTab };

/** Section headings, so the blocks and this list cannot drift apart. */
export const PAYROLL_SECTIONS = {
  calendar: "Pay calendar (company-wide)",
  bonus: "Staff statutory bonus",
  features: "OT & Compensation Features",
} as const;

const S = PAYROLL_SECTIONS;

/**
 * Every setting block on the Staff Payroll tab (tab id "payroll"): its anchor id, the sub-tab it sits in, and the words the
 * block shows. The suggested rate per shift for new production employees and the production bonus are on the Production
 * Payroll tab (Pay & Bonus).
 */
const BLOCKS: PayrollSettingMeta[] = [
  {
    id: "pay-day",
    subTab: "rates",
    section: S.calendar,
    title: "Salary pay day",
    purpose:
      "The day of the month by which last month's salary should be paid. One company-wide value that applies to staff and production alike. Only the MD portal uses it, to warn when payroll is late; it does not change any pay.",
    keywords: ["salary day", "due date", "late payroll", "md portal", "company wide", "everyone", "production"],
  },
  {
    id: "fy-start-month",
    subTab: "rates",
    section: S.calendar,
    title: "Financial year start month",
    purpose:
      "The month your financial year begins. One company-wide value that applies to staff and production alike: it decides which payslips make up a year for statutory bonus (staff and production), and the financial-year periods of payroll reports.",
    keywords: ["fy", "april", "bonus year", "financial year", "company wide", "everyone", "production"],
  },
  {
    id: "bonus-percent",
    subTab: "bonus",
    section: S.bonus,
    title: "Staff bonus rate",
    purpose:
      "The percentage of each eligible staff member's bonus wage for the financial year that is paid as statutory bonus. Production workers have their own rate on Production Payroll. The Payment of Bonus Act sets 8.33% as the minimum and 20% as the maximum.",
    keywords: ["bonus percent", "8.33", "payment of bonus act", "statutory", "staff"],
  },
  {
    id: "bonus-wage-ceiling",
    subTab: "bonus",
    section: S.bonus,
    title: "Staff bonus wage ceiling",
    purpose:
      "The most Basic pay per payslip that counts towards a staff member's bonus. A payslip's Basic above it counts as this amount. Production workers have their own ceiling on Production Payroll.",
    keywords: ["7000", "wage ceiling", "bonus", "cap", "staff"],
  },
  {
    id: "bonus-eligibility-ceiling",
    subTab: "bonus",
    section: S.bonus,
    title: "Staff bonus eligibility limit",
    purpose:
      "Who gets a bonus at all: staff whose latest payslip Basic in the year is above this amount get none. Basic, not salary, is compared. Production workers have their own limit on Production Payroll.",
    keywords: ["eligibility ceiling", "21000", "bonus", "eligible", "staff"],
  },
  {
    id: "compensation-features",
    subTab: "otCompensation",
    section: S.features,
    title: "OT & Compensation features",
    purpose:
      "One switch that pauses or resumes everything the Compensation features do by themselves: finding overtime and giving the next-day allowance, adding OT pay to payslips, announced late-in / early-out days, birthday leave, and Compensation Days excusing late and permission marks. The Compensation page always stays in the sidebar; each feature has its own switch on the Compensation tab.",
    keywords: ["overtime", "compensation", "master switch", "compensation day", "ot pay", "birthday", "allowance"],
  },
];

/** Every setting on the Staff Payroll tab, for the page's search (see kit/catalog.ts). */
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
