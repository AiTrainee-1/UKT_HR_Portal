/**
 * The Payroll tab of a Production Payroll cycle page, brought level with Staff Payroll's (owner 2026-11-06: "the same
 * enhancements across all Production Payroll pages - Weekly, Biweekly and Monthly"): the records open as a TABLE, one
 * department at a time (`pdept`), and the Export menu downloads the printed Production Salary Statement of the Report
 * Center (Reports > HR Reports), the same file in the same format as Staff's Salary Payroll Statement.
 */

import type { CyclePeriod, PayCycle } from "@/lib/api-client/custom-hooks";
import { PRODUCTION_URL_DEFAULTS } from "./logic";

/**
 * The page's address keys. The cycle page's own defaults, with the two the Staff Payroll page also has: the records list
 * opens as a table (`layout=cards` keeps the cards), and `pdept` names the department open on the Payroll tab (empty =
 * the first department by name). A module-level constant: `useUrlParams` needs a stable identity.
 */
export const PRODUCTION_PAGE_URL_DEFAULTS: Record<string, string> = {
  ...PRODUCTION_URL_DEFAULTS,
  layout: "table",
  pdept: "",
};

/** The Report Center report the Export menu downloads: Reports > HR Reports > Production Salary Statement. */
export const PRODUCTION_STATEMENT_REPORT_ID = "hr-production-salary-statement";

/**
 * The report's filters for the cycle and pay period on the page: the cycle, the period's first and last day and, when the
 * page is showing only Cleared or only Pending payments, the same payment status. The statement lists every department of
 * the period, each with its sub total, unit by unit.
 */
export function productionStatementQuery(
  cycle: PayCycle,
  period: CyclePeriod,
  status: string = "all",
): URLSearchParams {
  const query = new URLSearchParams({ cycle, dateFrom: period.periodStart, dateTo: period.periodEnd });
  if (status === "paid" || status === "pending") query.set("paymentStatus", status);
  return query;
}
