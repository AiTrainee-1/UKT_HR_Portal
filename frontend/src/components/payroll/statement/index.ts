// The on-screen Salary Statement (the paper layout, its model and its exports). The Salary tabs of Staff Payroll and
// Production Payroll that mounted its panel became the Excess tabs on 2026-11-20 (the Payroll tabs' Export menus keep the
// printed statement), so the panel itself is gone; the view, the model and the exports stay.
//
// The export modules (Excel, PDF, Print) are not re-exported here on purpose: they are loaded on demand, so a page that
// imports this folder does not pay for exceljs and jsPDF until somebody exports.

export { SalaryStatementView, type SalaryStatementViewProps, type StatementView } from "./SalaryStatementView";
export {
  ALL,
  buildTotalRow,
  departmentOptions,
  filterStatement,
  formatCell,
  paginateStatement,
  statementFileStem,
  statementHeadline,
  statementRowCount,
  statementTitle,
  type StatementAccent,
  type StatementFilters,
  type StatementLine,
  type StatementPage,
} from "./statement-model";
