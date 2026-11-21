import { useMemo } from "react";
import { PeriodPayslipsPanel } from "@/components/payroll/period-payslips";
import type { PayrollScope } from "@/lib/api-client/custom-hooks";

/**
 * Payslip tab of the Staff Payroll page (owner 2026-11-20): the shared Payslip panel for the month the page header chose
 * (only the employees in the month's payroll). Its filters live in the page's address (the pl* keys).
 */
export function StaffPayslipsTab({
  month,
  year,
  url,
  setUrl,
}: {
  month: number;
  year: number;
  url: Record<string, string>;
  setUrl: (patch: Record<string, string>) => void;
}) {
  const scope = useMemo<PayrollScope>(() => ({ kind: "staff", month, year }), [month, year]);
  return <PeriodPayslipsPanel scope={scope} url={url} setUrl={setUrl} />;
}
