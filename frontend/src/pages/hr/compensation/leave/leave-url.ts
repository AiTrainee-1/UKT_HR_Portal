import { useUrlParams } from "@/components/payroll/kit/url-state";
import type { SubtabOwnKeys } from "@/components/ui/subtab-nav";
import { subPath } from "../routes";
import { MONTH_NAMES, monthYearFromUrl } from "../logic";
import { WHOLE_YEAR } from "./leave-logic";

// The filters of the Compensation Leave lists, kept in the address like the rest of Compensation (so a reload, a shared
// link and Back show the same rows). Each list has its own prefix: w = announcements, r = the Raise strip, h = claims,
// bal = balance, l = ledger (Credits), b = birthdays. The page's older keys (hmonth / hyear / hstatus / hdate, bperiod /
// bdate) are repeated here with the same defaults, so ONE write can change a filter and reset its page (two writes in a row
// would each start from the same address and the second would undo the first). "" means "any" / "the current one".

export const LEAVE_URL_DEFAULTS = {
  // A. Announcements list
  wmonth: "",
  wyear: "",
  wkind: "",
  wdept: "",
  wbranch: "",
  wq: "",
  wstatus: "",
  wpage: "",
  // B. Raise (the month strip; hdate is the chosen day)
  rmonth: "",
  ryear: "",
  rdept: "",
  rbranch: "",
  rq: "",
  hdate: "",
  // B. Claims
  hmonth: "",
  hyear: "",
  hstatus: "all",
  hkind: "",
  hraised: "",
  hdept: "",
  hbranch: "",
  hq: "",
  hemp: "",
  hclaim: "",
  hpage: "",
  // B. Balance
  baldept: "",
  balbranch: "",
  balq: "",
  balemp: "",
  balpage: "",
  // B. Credits (the ledger)
  lmonth: "",
  lyear: "",
  ltype: "",
  lsource: "",
  ldept: "",
  lbranch: "",
  lq: "",
  lemp: "",
  lclaim: "",
  lpage: "",
  // C. Birthdays
  bperiod: "today",
  bdate: "",
  bdept: "",
  bbranch: "",
  bq: "",
  boutcome: "",
};

export type LeaveUrl = typeof LEAVE_URL_DEFAULTS;

const keysOf = (...prefixes: string[]): readonly string[] =>
  Object.keys(LEAVE_URL_DEFAULTS).filter((k) => prefixes.some((p) => k.startsWith(p)));

/**
 * The address keys each Compensation Leave subtab owns (SubtabBar `ownKeys`): a switch leaves them with their subtab and
 * gives them back when it is opened again, so the announcements' month never rides along to the Raise strip.
 */
export const LEAVE_OWN_KEYS: SubtabOwnKeys = {
  announcements: keysOf("w"),
  "holiday-work": keysOf("r", "h", "bal", "l"),
  birthdays: keysOf("b").filter((k) => !k.startsWith("bal")),
};
export type SetLeaveUrl = (patch: Partial<LeaveUrl>) => void;

export const useLeaveUrl = () => useUrlParams(LEAVE_URL_DEFAULTS);

/** A positive whole number from the address, else undefined (an id filter, a page). */
export const idOf = (value: string): number | undefined => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export const pageOf = (value: string): number => idOf(value) ?? 1;

/** The month a list shows: "all" (every month), or a month and year (the current one when the address has none). */
export type MonthChoice = { all: true; month: null; year: null } | { all: false; month: number; year: number };

export function monthChoice(month: string, year: string, today: string, allowAll = true): MonthChoice {
  if (allowAll && month === WHOLE_YEAR) return { all: true, month: null, year: null };
  const m = monthYearFromUrl(month, year, today);
  return { all: false, month: m.month, year: m.year };
}

export const monthChoiceLabel = (c: MonthChoice): string =>
  c.all ? "every month" : `${MONTH_NAMES[c.month - 1]} ${c.year}`;

const leaveLink = (sub: "holiday-work", nested: string, params: Record<string, string | number | null | undefined>) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  return subPath("leave", sub, qs.toString(), nested);
};

/** The Claims section with one claim's drawer open (every month and status of that employee, so it is on the list). */
export const claimLink = (claimId: number, employeeId: number): string =>
  leaveLink("holiday-work", "claims", { hmonth: WHOLE_YEAR, hemp: employeeId, hclaim: claimId });

/** The Credits section on one employee's entries (every month), marking the entry a claim made. */
export const creditLink = (employeeId: number, claimId?: number | null): string =>
  leaveLink("holiday-work", "credits", { lmonth: WHOLE_YEAR, lemp: employeeId, lclaim: claimId ?? undefined });

/** The Balance section with one employee's drawer open. */
export const balanceLink = (employeeId: number): string => leaveLink("holiday-work", "balance", { balemp: employeeId });
