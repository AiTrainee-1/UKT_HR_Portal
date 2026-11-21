import { useMemo } from "react";
import { PeriodPayslipsPanel } from "@/components/payroll/period-payslips";
import type { CyclePeriod, PayCycle } from "@/lib/api-client/custom-hooks";
import { productionScope, type UrlSetter } from "./logic";

/**
 * Payslip tab of a cycle page (rebuilt 2026-11-20 like Staff Payroll's): the payslips of the workers in this cycle's
 * payroll for the pay period the page chose (rate per shift, shifts, days worked, earned, excess, detection, deductions,
 * NET), each payslip's breakdown, its PDF / email / WhatsApp and one PDF of many. Its filters live in the page's address.
 */
export function PayslipTab({
  cycle,
  period,
  url,
  setUrl,
}: {
  cycle: PayCycle;
  period: CyclePeriod;
  url: Record<string, string>;
  setUrl: UrlSetter;
}) {
  const scope = useMemo(() => productionScope(cycle, period), [cycle, period]);
  return <PeriodPayslipsPanel scope={scope} url={url} setUrl={setUrl} />;
}
