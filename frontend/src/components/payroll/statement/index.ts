// The Salary Statement: what the Salary tab of Staff Payroll and Production Payroll mounts.
//
//   <SalaryStatementPanel scope={...} accent="indigo" onOpenDetails={(row) => ...} />
//
// The export modules (Excel, PDF, Print) are not re-exported here on purpose: the panel loads them on demand, so a page that
// imports this folder does not pay for exceljs and jsPDF until somebody exports.

export {
  DEFAULT_STATEMENT_UI,
  SalaryStatementPanel,
  type SalaryStatementPanelProps,
  type StatementUiState,
} from "./SalaryStatementPanel";
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
