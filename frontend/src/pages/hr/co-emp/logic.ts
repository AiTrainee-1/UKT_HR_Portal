import type {
  CoverageCounts,
  CoverageResponse,
  CoverageRow,
  PaginatedEmployeesParams,
  PfEsiClass,
  TdsAddResult,
} from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";

// Pure rules of the Co Emp tab and the TDS panel of Employees: what the address says, how a percentage is checked, what the
// server's answers are turned into, and the words on the PF/ESI hint, the toggle and the coverage strip. No React here, so
// every rule is a plain unit test.

// ── The address: /hr/employees?tab=coemp&type=production&view=tds ─────────────

export type EmployeesTab = "staff" | "production" | "coemp";

export const EMPLOYEES_TABS: readonly EmployeesTab[] = ["staff", "production", "coemp"];

/** What the page keeps in its address. Module-level: useUrlParams needs a stable identity. A value equal to its default
 *  is left out of the address. `type` is the class pill inside Co Emp and the TDS panel; `view=tds` opens the TDS panel. */
export const EMPLOYEES_URL_DEFAULTS: { tab: string; type: string; view: string } = {
  tab: "staff",
  type: "staff",
  view: "",
};

export const parseEmployeesTab = (value: string | null | undefined): EmployeesTab =>
  value === "production" || value === "coemp" ? value : "staff";

export const parseClass = (value: string | null | undefined): PfEsiClass =>
  value === "production" ? "production" : "staff";

export const classLabel = (cls: PfEsiClass): string => (cls === "production" ? "Production" : "Staff");

// ── The Co Emp list: ONE class at a time ──────────────────────────────────────

export type CoEmpFilters = {
  departmentId?: number;
  branchId?: number;
  status?: string;
  search?: string;
};

/** The request for the Co Emp table. `employmentType` is always the class picked, so Staff and Production never mix. */
export function coEmpListParams(
  filters: CoEmpFilters,
  cls: PfEsiClass,
  page: number,
  pageSize: number,
): PaginatedEmployeesParams {
  return {
    departmentId: filters.departmentId,
    branchId: filters.branchId,
    status: filters.status,
    search: filters.search,
    employmentType: cls,
    page,
    pageSize,
  };
}

// ── Who is in which category, and the hint that says so ───────────────────────

type CategoryFields = {
  coEmpEnabled?: boolean | null;
  tdsEnabled?: boolean | null;
  tdsPercent?: number | null;
};

export type PfEsiHint = { text: string; tone: Tone; detail?: string };

const rate = (value: number | null | undefined): string => (value == null ? "" : `${formatPercent(value)}%`);

/**
 * The read-only "PF/ESI status" of a row. `row` is the coverage report's verdict for the employee (what the next payroll
 * would do); without it the hint says only which category the employee is in, never a guess about amounts.
 */
export function pfEsiHint(emp: CategoryFields, row?: CoverageRow): PfEsiHint {
  if (emp.tdsEnabled) {
    return {
      text: `TDS ${rate(emp.tdsPercent) || ""}`.trim(),
      tone: "accent",
      detail: "In TDS: no PF/ESI",
    };
  }
  if (!emp.coEmpEnabled) return { text: "No PF/ESI", tone: "neutral", detail: "Not Co Emp" };
  if (!row || row.category !== "co_emp") {
    return { text: "PF/ESI rules apply", tone: "info", detail: "Co Emp" };
  }
  const parts = [row.pf ? `PF ${rate(row.pfRatePercent)}` : null, row.esi ? `ESI ${rate(row.esiRatePercent)}` : null]
    .filter(Boolean)
    .join(" · ");
  switch (row.status) {
    case "pf_esi":
      return { text: "PF + ESI", tone: "success", detail: parts || undefined };
    case "pf_only":
      return { text: "PF only", tone: "success", detail: parts || undefined };
    case "esi_only":
      return { text: "ESI only", tone: "success", detail: parts || undefined };
    case "neither":
      return { text: "No deduction", tone: "warning", detail: "No PF/ESI rule matches" };
    case "not_evaluated":
      return { text: "Not known yet", tone: "neutral", detail: "No payroll generated yet" };
    default:
      return { text: "PF/ESI rules apply", tone: "info", detail: "Co Emp" };
  }
}

/** Coverage rows by employee id, for the hint column. */
export function coverageById(rows: readonly CoverageRow[] | undefined): Map<number, CoverageRow> {
  return new Map((rows ?? []).map((r) => [r.id, r]));
}

// ── The Co Emp toggle ─────────────────────────────────────────────────────────

export const TDS_CONFIRM_TEXT =
  "This employee is in TDS. Turning Co Emp on moves them out of TDS and applies PF/ESI rules.";

/** Turning Co Emp ON for a TDS employee takes them out of TDS, so it is confirmed first; every other flip goes straight through. */
export const toggleNeedsConfirm = (emp: CategoryFields, turningOn: boolean): boolean => turningOn && !!emp.tdsEnabled;

export function toggleToast(
  emp: CategoryFields & { employeeCode: string },
  turnedOn: boolean,
): { title: string; description: string } {
  if (turnedOn) {
    return {
      title: `${emp.employeeCode} is now Co Emp`,
      description: emp.tdsEnabled
        ? `Moved out of TDS${emp.tdsPercent != null ? ` (${rate(emp.tdsPercent)})` : ""}. PF/ESI rules apply from the next payroll.`
        : "PF/ESI rules apply from the next payroll.",
    };
  }
  return {
    title: `${emp.employeeCode} is no longer Co Emp`,
    description: "No PF/ESI will be deducted from the next payroll.",
  };
}

// ── Percentages ───────────────────────────────────────────────────────────────

export const PERCENT_MESSAGE = "Percentage must be greater than 0 and at most 100 (2 decimals).";

export type PercentCheck = { ok: true; value: number } | { ok: false; message: string };

/** "12.5" -> 12.5. Greater than 0, at most 100, at most 2 decimals; nothing else (no exponent, no sign, no spaces inside). */
export function parsePercent(text: string): PercentCheck {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: "Enter the TDS percentage." };
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return { ok: false, message: PERCENT_MESSAGE };
  const value = Number(trimmed);
  if (!(value > 0 && value <= 100)) return { ok: false, message: PERCENT_MESSAGE };
  return { ok: true, value };
}

/** 10 -> "10", 12.5 -> "12.5", 0.75 -> "0.75"; "—" for none. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Number(value.toFixed(2)));
}

// ── Adding to TDS ─────────────────────────────────────────────────────────────

export type TdsForm = { code: string; percent: string };

export type TdsFormCheck =
  { ok: true; employeeCode: string; percent: number } | { ok: false; errors: { code?: string; percent?: string } };

export function checkTdsForm(form: TdsForm): TdsFormCheck {
  const errors: { code?: string; percent?: string } = {};
  const employeeCode = form.code.trim();
  if (!employeeCode) errors.code = "Enter the employee code.";
  const percent = parsePercent(form.percent);
  if (!percent.ok) errors.percent = percent.message;
  if (errors.code || errors.percent || !percent.ok) return { ok: false, errors };
  return { ok: true, employeeCode, percent: percent.value };
}

/** What the server said, whichever shape it used: `{error: "<message>"}`, `{error: "<code>", message: "<message>"}`. */
export type ServerProblem = { message: string; code: string | null; status: number | null };

const MACHINE_CODE = /^[a-z0-9_]+$/;

export function serverProblem(err: unknown): ServerProblem {
  const status =
    typeof (err as { status?: unknown } | null)?.status === "number" ? (err as { status: number }).status : null;
  const data = (err as { data?: unknown } | null)?.data;
  const body = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const text = (key: string) => (typeof body?.[key] === "string" ? (body[key] as string).trim() : "");
  const code = text("code") || (MACHINE_CODE.test(text("error")) ? text("error") : "") || null;
  let message = text("message") || text("error");
  if (!message || MACHINE_CODE.test(message)) {
    message =
      status === 403
        ? "You do not have permission to do this."
        : status === null
          ? "Could not reach the server. Check the connection and try again."
          : "The server could not do this. Please try again.";
  }
  return { message, code, status };
}

export type TdsProblemField = "code" | "percent" | "form";

const CODE_PROBLEMS = new Set(["employee_not_found", "employee_inactive", "already_in_tds", "not_in_tds"]);

/** Which field of the Add dialog a server message belongs under. */
export function tdsProblemField(problem: ServerProblem): TdsProblemField {
  if (problem.code && CODE_PROBLEMS.has(problem.code)) return "code";
  if (/percent/i.test(problem.message)) return "percent";
  if (/employee ?code/i.test(problem.message)) return "code";
  return "form";
}

/** The toast after a successful add: says whether the employee was moved out of PF/ESI. */
export function addedMessage(result: TdsAddResult): { title: string; description: string } {
  const { employee, movedFromPfEsi } = result;
  const pct = `${formatPercent(employee.tdsPercent)}%`;
  return movedFromPfEsi
    ? {
        title: `${employee.employeeCode} moved from PF/ESI to TDS at ${pct}`,
        description: `${employee.name} is no longer Co Emp, so no PF/ESI applies. TDS is deducted from their earned pay.`,
      }
    : {
        title: `${employee.employeeCode} added to TDS at ${pct}`,
        description: `TDS is deducted from ${employee.name}'s earned pay at ${pct}.`,
      };
}

export function removeWording(row: { employeeCode: string; name: string }): { title: string; lines: string[] } {
  return {
    title: `Remove ${row.employeeCode} from TDS?`,
    lines: [
      `${row.name} will no longer have TDS deducted.`,
      "They end up with no PF/ESI and no TDS until you turn Co Emp on for them or add them to TDS again.",
    ],
  };
}

// ── The coverage strip ────────────────────────────────────────────────────────

export type StripColumn = { key: keyof CoverageCounts; label: string; hint: string };

export const STRIP_COLUMNS: readonly StripColumn[] = [
  { key: "coEmp", label: "Co Emp", hint: "Employees with the Co Emp switch on: the only ones PF/ESI can apply to" },
  { key: "withPf", label: "With PF", hint: "Co Emp employees who have PF deducted" },
  { key: "withEsi", label: "With ESI", hint: "Co Emp employees who have ESI deducted" },
  { key: "withBoth", label: "With PF + ESI", hint: "Co Emp employees who have both PF and ESI deducted" },
  {
    key: "withNeither",
    label: "Co Emp, no deduction",
    hint: "Co Emp employees for whom no PF/ESI rule matches, so nothing is deducted",
  },
  { key: "tds", label: "TDS", hint: "Employees in TDS: TDS only, never PF/ESI" },
  { key: "notCoEmp", label: "Not Co Emp", hint: "Employees who are neither Co Emp nor in TDS: no PF/ESI" },
];

export type StripRow = { cls: PfEsiClass; label: string; counts: CoverageCounts };

/** The classes the report answered with, Staff first. */
export function stripRows(data: CoverageResponse | undefined): StripRow[] {
  if (!data) return [];
  const rows: StripRow[] = [];
  if (data.staff) rows.push({ cls: "staff", label: "Staff", counts: data.staff });
  if (data.production) rows.push({ cls: "production", label: "Production", counts: data.production });
  return rows;
}

/** Production Co Emp employees whose PF/ESI is not known because no payroll was generated for them yet. */
export function notEvaluatedNote(rows: readonly StripRow[]): string | null {
  const count = rows.reduce((sum, r) => sum + (r.counts.notEvaluated ?? 0), 0);
  if (count <= 0) return null;
  return `${count} Co Emp ${count === 1 ? "employee has" : "employees have"} no payroll generated yet, so their PF/ESI is not counted above.`;
}

// ── A client-side page of a short list (the TDS list arrives whole) ───────────

export function pageOf<T>(
  rows: readonly T[],
  page: number,
  pageSize: number,
): { rows: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  return { rows: rows.slice((current - 1) * pageSize, current * pageSize), page: current, totalPages };
}
