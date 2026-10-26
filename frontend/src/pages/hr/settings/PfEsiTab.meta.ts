import type { SettingMeta } from "./kit/catalog";

/** The two pages of the tab: one per kind of employee. PF and ESI are two lists on each. */
export type PfEsiSubTab = "staff" | "production";

type PfEsiSettingMeta = Omit<SettingMeta, "tab"> & { subTab: PfEsiSubTab | null };

/** Section headings, so the blocks and this list cannot drift apart. */
export const PF_ESI_SECTIONS = {
  scope: "Whose rules these are",
  staff: "Staff PF and ESI",
  production: "Production PF and ESI",
} as const;

const S = PF_ESI_SECTIONS;

/**
 * Every setting block on the PF & ESI tab: its anchor id, the page it sits on (null = shown above both pages) and the words
 * the block shows. Types only are imported here: this list is read by the search catalogue (metas.ts), which the end-to-end
 * specs load under Node.
 */
const BLOCKS: PfEsiSettingMeta[] = [
  {
    id: "pf-esi-scope",
    subTab: null,
    section: S.scope,
    title: "Whose rules these are",
    purpose:
      "PF and ESI rules are company-wide (All units) unless the Super Admin gives a unit, which is a branch, a rule set of its own. That set replaces the company-wide one for the unit's employees and shows, read-only, in the unit's logins. A unit without its own set follows the all-units rules. Only the Super Admin can change any of them.",
    keywords: [
      "unit",
      "units",
      "branch",
      "global",
      "all units",
      "own rules",
      "reset to global",
      "super admin",
      "scope",
      "company wide",
      "read only",
    ],
  },
  {
    id: "staff-pf-esi-how",
    subTab: "staff",
    section: S.staff,
    title: "Who pays staff PF and ESI, and on what",
    purpose:
      "Only staff switched ON in Employees, Co Emp can pay PF or ESI. A rule's percentage is taken from Basic + DA + Retaining Allowance, the first 50% of the salary, prorated by the days paid; the rule's range, measured on the basis you choose, decides who is eligible. Try a salary to see which rule fits it and what it comes to.",
    keywords: [
      "co emp",
      "who pays",
      "eligible",
      "eligibility",
      "example",
      "try",
      "illustration",
      "first portion",
      "50%",
      "salary split",
      "basic",
      "da",
      "retaining allowance",
      "staff",
      "pf",
      "esi",
    ],
  },
  {
    id: "staff-pf-rules",
    subTab: "staff",
    section: S.staff,
    title: "Staff PF rules",
    purpose:
      "The Provident Fund rules for staff: each one is a salary range, what the range is measured on and a percentage. A staff member whose amount falls in a rule's range pays that percentage of their first-portion pay; one who fits no rule pays no PF. Ranges in one list must not overlap, and the first rule that fits wins.",
    keywords: [
      "pf",
      "provident fund",
      "staff",
      "percentage",
      "rate",
      "range",
      "slab",
      "limit",
      "salary limit",
      "below 25000",
      "25000",
      "12",
      "basic",
      "add rule",
      "delete rule",
      "edit rule",
    ],
  },
  {
    id: "staff-esi-rules",
    subTab: "staff",
    section: S.staff,
    title: "Staff ESI rules",
    purpose:
      "The Employee State Insurance rules for staff, kept apart from PF so that, for example, PF can apply below 25,000 and ESI below 30,000. Each rule is a salary range, what the range is measured on and a percentage; a staff member who fits no rule pays no ESI.",
    keywords: [
      "esi",
      "employee state insurance",
      "staff",
      "percentage",
      "rate",
      "range",
      "slab",
      "ceiling",
      "limit",
      "salary limit",
      "below 30000",
      "30000",
      "0.75",
      "add rule",
      "delete rule",
      "edit rule",
    ],
  },
  {
    id: "prod-pf-esi-how",
    subTab: "production",
    section: S.production,
    title: "Who pays production PF and ESI, and on what",
    purpose:
      "Only production workers switched ON in Employees, Co Emp can pay PF or ESI. A rule's percentage is taken from the first 50% of the pay earned in the period; the rule's range is tested on the worker's monthly amount, estimated from the pay period (Weekly x 4, BiWeekly x 2, Monthly x 1). Try a pay to see which rule fits and what it comes to.",
    keywords: [
      "co emp",
      "who pays",
      "eligible",
      "eligibility",
      "example",
      "try",
      "illustration",
      "production",
      "weekly",
      "biweekly",
      "monthly",
      "monthly estimate",
      "first portion",
      "pf",
      "esi",
    ],
  },
  {
    id: "prod-pf-rules",
    subTab: "production",
    section: S.production,
    title: "Production PF rules",
    purpose:
      "The Provident Fund rules for production workers: each one is a salary range, what the range is measured on and a percentage. A worker whose amount falls in a rule's range pays that percentage of the first half of the period's pay; one who fits no rule pays no PF. Ranges in one list must not overlap, and the first rule that fits wins.",
    keywords: [
      "pf",
      "provident fund",
      "production",
      "percentage",
      "rate",
      "range",
      "slab",
      "limit",
      "salary limit",
      "salary range",
      "add rule",
      "delete rule",
      "edit rule",
    ],
  },
  {
    id: "prod-esi-rules",
    subTab: "production",
    section: S.production,
    title: "Production ESI rules",
    purpose:
      "The Employee State Insurance rules for production workers, kept apart from PF. Each rule is a salary range, what the range is measured on and a percentage; a worker who fits no rule pays no ESI.",
    keywords: [
      "esi",
      "employee state insurance",
      "production",
      "percentage",
      "rate",
      "range",
      "slab",
      "ceiling",
      "limit",
      "salary limit",
      "salary range",
      "add rule",
      "delete rule",
      "edit rule",
    ],
  },
];

/** Every setting on the PF & ESI tab, for the page's search (see kit/catalog.ts). */
export const PF_ESI_SETTINGS: SettingMeta[] = BLOCKS.map(({ subTab: _subTab, ...meta }) => ({
  ...meta,
  tab: "pf_esi",
}));

/** Which page holds each setting, so a link or a search result can open it (the scope block is on both: no entry). */
export const PF_ESI_SUB_TAB_OF: Record<string, PfEsiSubTab> = Object.fromEntries(
  BLOCKS.filter((b): b is PfEsiSettingMeta & { subTab: PfEsiSubTab } => b.subTab !== null).map((b) => [b.id, b.subTab]),
);

/** The title and purpose a block shows (the same words the search finds). */
export function pfEsiText(id: string): { title: string; purpose: string } {
  const block = BLOCKS.find((b) => b.id === id);
  if (!block) throw new Error(`No PF & ESI setting "${id}"`);
  return { title: block.title, purpose: block.purpose };
}
