import { useMemo } from "react";
import { ExcessPanel } from "@/components/payroll/excess";
import type { PayrollScope } from "@/lib/api-client/custom-hooks";

/**
 * Excess tab of the Staff Payroll page (owner 2026-11-20; the tab value and permission key stay `salary`): the shared
 * Excess panel for the month the page header chose. Production Payroll's cycle pages show the same panel for a pay period.
 */
export function ExcessTab({ month, year }: { month: number; year: number }) {
  const scope = useMemo<PayrollScope>(() => ({ kind: "staff", month, year }), [month, year]);
  return <ExcessPanel scope={scope} />;
}
