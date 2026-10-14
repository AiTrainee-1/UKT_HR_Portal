import { PayslipsPanel } from "@/components/payroll/panels/payslips";
import type { PayCycle } from "@/lib/api-client/custom-hooks";

/**
 * Payslip tab of a cycle page: the salary slips of the cycle for a month (a slip belongs to the month its period ends
 * in), with the PDF / email / WhatsApp actions, the bulk versions of them and the Payslip register, all limited to this
 * cycle's slips. The month is kept in the address (?tab=payslip&month=2&year=2026), so a reload lands on the same one.
 */
export function PayslipTab({
  cycle,
  month,
  year,
  onPeriodChange,
}: {
  cycle: PayCycle;
  month: number;
  year: number;
  onPeriodChange: (month: number, year: number) => void;
}) {
  return (
    <PayslipsPanel
      kind="production"
      cycle={cycle}
      accent="amber"
      month={month}
      year={year}
      onPeriodChange={onPeriodChange}
    />
  );
}
