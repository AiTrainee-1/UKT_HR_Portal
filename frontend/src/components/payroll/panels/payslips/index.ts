// The old month-based Payslip panel was replaced on 2026-11-20 by components/payroll/period-payslips (Staff Payroll and the
// Production Payroll cycle pages); its helpers are still used there.
export {
  ALL_DEPARTMENTS,
  MONTH_NAMES,
  REGISTER_COLUMNS,
  emailedDay,
  errorText,
  filterSlips,
  parseYear,
  registerFileStem,
  slipCycleLabel,
  slipDepartments,
  slipFilterCount,
  slipPeriodText,
  slipTotals,
} from "./payslips-logic";
export type { SlipFilter, SlipTotals } from "./payslips-logic";
