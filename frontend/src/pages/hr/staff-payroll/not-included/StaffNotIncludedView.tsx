import { useMemo } from "react";
import { NotIncludedView } from "@/components/payroll/not-included";
import type { PayrollScope } from "@/lib/api-client/custom-hooks";

/**
 * The "Not included" view of Staff Payroll's Payroll tab (owner 2026-11-20): the shared view for the month the page header
 * chose, Staff first. Its filters live in the page's address (the ni* keys).
 */
export function StaffNotIncludedView({
  month,
  year,
  ...rest
}: {
  month: number;
  year: number;
  periodLabel: string;
  url: Record<string, string>;
  setUrl: (patch: Record<string, string>) => void;
  onOpenPayroll: (payrollId: number) => void;
  /** Opens the Generate dialog; left out when the role may not generate or the month is locked. */
  onGenerate?: () => void;
}) {
  const scope = useMemo<PayrollScope>(() => ({ kind: "staff", month, year }), [month, year]);
  return <NotIncludedView scope={scope} {...rest} />;
}
