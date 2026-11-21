import { useMemo } from "react";
import { ExcessPanel } from "@/components/payroll/excess";
import type { CyclePeriod, PayCycle } from "@/lib/api-client/custom-hooks";
import { productionScope } from "./logic";

/**
 * Excess tab of a cycle page (owner 2026-11-20; it was the Salary tab: the tab value `salary` and the permission key
 * `production_payroll.salary` stay): the shared Excess panel of Staff Payroll, for this cycle and the pay period the page
 * chose. Amounts HR adds to (Excess) or takes off (Detection) a worker's earned salary for the period, each with a remark.
 */
export function ExcessTab({ cycle, period }: { cycle: PayCycle; period: CyclePeriod }) {
  const scope = useMemo(() => productionScope(cycle, period), [cycle, period]);
  return <ExcessPanel scope={scope} />;
}
