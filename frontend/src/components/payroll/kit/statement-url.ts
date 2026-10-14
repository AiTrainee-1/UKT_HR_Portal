// The Salary Statement's toolbar in the address (?sq=asha&sdept=ACCOUNTS&sstatus=pending&sview=pages), shared by the Salary
// tab of Staff Payroll and of every Production Payroll cycle: a reload, a shared link and Back from a payroll's details
// page all land on the same statement. The values are the panel's own (`StatementUiState`): "all" is every department /
// status, the view is "scroll" or "pages".

// `sbranch` is the branch id the statement is narrowed to (empty = every branch); the panel does not hold it, the page does.
export const STATEMENT_URL_DEFAULTS = { sq: "", sdept: "all", sstatus: "all", sview: "scroll", sbranch: "" } as const;

export type StatementUrlUi = {
  search: string;
  department: string;
  status: string;
  view: "scroll" | "pages";
};

export function statementUiFromUrl(values: Partial<Record<string, string | null | undefined>>): StatementUrlUi {
  return {
    search: values.sq ?? "",
    department: values.sdept || STATEMENT_URL_DEFAULTS.sdept,
    status: values.sstatus === "paid" || values.sstatus === "pending" ? values.sstatus : STATEMENT_URL_DEFAULTS.sstatus,
    view: values.sview === "pages" ? "pages" : STATEMENT_URL_DEFAULTS.sview,
  };
}

export function statementUiToUrl(
  patch: Partial<StatementUrlUi>,
): Partial<Record<keyof typeof STATEMENT_URL_DEFAULTS, string>> {
  const out: Partial<Record<keyof typeof STATEMENT_URL_DEFAULTS, string>> = {};
  if (patch.search !== undefined) out.sq = patch.search;
  if (patch.department !== undefined) out.sdept = patch.department;
  if (patch.status !== undefined) out.sstatus = patch.status;
  if (patch.view !== undefined) out.sview = patch.view;
  return out;
}
