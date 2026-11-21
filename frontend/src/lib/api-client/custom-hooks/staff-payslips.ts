// staff-payslips: the Payslip tab of Staff Payroll (/hr/payroll?tab=payslip, owner 2026-11-20) and of every Production
// Payroll cycle page (?tab=payslip). Each lists only the employees IN the month's / period's generated payroll (the
// Records list: staff not on hold, not a parked new joiner, not paid separately; production not waiting in New Joiners),
// each with the full payslip breakdown the PDF prints. Backend: /api/payslips/staff (permission key `salary_slip`) and
// /api/payslips/production (key `production_payroll.payslip`). The per-slip PDF / email / WhatsApp endpoints
// (/api/salary-slips/<slipId>/...) stay as they were.
import { useQuery } from "@tanstack/react-query";
import { downloadBlob } from "@/lib/exportUtils";
import { filenameFromDisposition } from "@/lib/report-download";
import { customFetch, getApiOrigin } from "../custom-fetch";
import { scopeQuery, type PayrollKind, type PayrollScope } from "./payroll-insights";
import type { CyclePeriod, PayCycle } from "./production-cycles";

// ── Types ─────────────────────────────────────────────────────────────────────

/** One printed line of a payslip: "Basic salary" 13,000 / "Detection (taken off by HR)" -500. */
export type PayslipLine = { label: string; amount: number };

/** What every payslip row has, staff or production. */
export type PayslipRowBase = {
  payrollId: number;
  /** The saved salary slip (its PDF / email / WhatsApp), or null when none was made for this payroll. */
  slipId: number | null;
  employeeId: number;
  code: string;
  name: string;
  department: string | null;
  designation: string | null;
  unit: string | null;
  joinDate: string | null;
  /** "XXXX1234", or null when the profile has no bank account. */
  bankAccountMasked: string | null;
  pfNumber: string | null;
  esiNumber: string | null;
  /** The payroll's own status: "pending", or "paid" (shown as Cleared). */
  status: string;
  /** The month / period workflow's Mark as Paid: "unpaid" | "paid". */
  paymentStatus: string;
  /** Staff: the engine's earned salary before OT; production: the period's gross (shifts x rate). Before Excess. */
  earned: number;
  ot: number;
  /** Added by HR on the Excess tab. */
  excess: number;
  /** Taken off by HR on the Excess tab. */
  detection: number;
  /** Earned + OT + Excess - Detection: the earnings total the payslip prints. */
  eSalary: number;
  pf: number;
  esi: number;
  tds: number;
  advance: number;
  others: number;
  totalDeduction: number;
  net: number;
  /** Exactly the earning lines the payslip PDF prints. */
  earnings: PayslipLine[];
  /** Exactly the deduction lines the payslip PDF prints. */
  deductions: PayslipLine[];
  hasSlip: boolean;
};

/** The days of a staff payslip. */
export type StaffPayslipDays = {
  fixedSalary: number;
  companyDays: number;
  paidDays: number;
  present: number;
  cl: number;
  hd: number;
  lop: number;
};

/** The shifts of a production payslip. */
export type ProductionPayslipShifts = {
  /** The rate per shift on the profile (null when it is not set). */
  salaryPerShift: number | null;
  shifts: number;
  daysWorked: number;
  absent: number;
};

/** One employee's payslip of the month, from the month's payroll record. */
export type StaffPayslipRow = PayslipRowBase & StaffPayslipDays;

/** One worker's payslip of the period, from the period's payroll record. */
export type ProductionPayslipRow = PayslipRowBase & ProductionPayslipShifts;

/** A payslip of either kind, as the shared Payslip list reads it (the kind of the page says which half is there). */
export type PayslipRow = PayslipRowBase & Partial<StaffPayslipDays> & Partial<ProductionPayslipShifts>;

export type StaffPayslipsSummary = {
  employees: number;
  earned: number;
  excess: number;
  detection: number;
  deductions: number;
  net: number;
};

/** The figures of one month / period, as the shared Payslip tab reads them. */
export type PeriodPayslips = {
  /** "November 2026", or the production period's own label. */
  periodLabel: string;
  /** The month / period is finalized (Payroll Done). */
  locked: boolean;
  summary: StaffPayslipsSummary;
  rows: PayslipRow[];
};

export type StaffPayslips = PeriodPayslips & { month: number; year: number; rows: StaffPayslipRow[] };

export type ProductionPayslips = PeriodPayslips & {
  cycle: PayCycle;
  periodStart: string;
  periodEnd: string;
  rows: ProductionPayslipRow[];
};

/** single = one A4 payslip per page; double = two payslips per landscape A4 page. */
export type PayslipLayout = "single" | "double";

// ── Queries ───────────────────────────────────────────────────────────────────

export const STAFF_PAYSLIPS_PATH = "/api/payslips/staff";
export const PRODUCTION_PAYSLIPS_PATH = "/api/payslips/production";

export const payslipsPath = (kind: PayrollKind): string =>
  kind === "production" ? PRODUCTION_PAYSLIPS_PATH : STAFF_PAYSLIPS_PATH;

/** Staff keys hold the month, production keys the cycle and the period. */
export const getPeriodPayslipsQueryKey = (scope: PayrollScope) =>
  scope.kind === "staff"
    ? ([STAFF_PAYSLIPS_PATH, { month: scope.month, year: scope.year }] as const)
    : ([
        PRODUCTION_PAYSLIPS_PATH,
        { cycle: scope.cycle, periodStart: scope.periodStart, periodEnd: scope.periodEnd },
      ] as const);

export const getStaffPayslipsQueryKey = (month: number, year: number) =>
  getPeriodPayslipsQueryKey({ kind: "staff", month, year });

const scopeReady = (scope: PayrollScope): boolean =>
  scope.kind === "staff"
    ? scope.month > 0 && scope.year > 0
    : !!scope.cycle && !!scope.periodStart && !!scope.periodEnd;

/**
 * The month's / period's payslips. Always asked again when the tab opens (staleTime 0): an Excess / Detection added on the
 * Excess tab or a payroll generated a moment ago changes these figures.
 */
export const usePeriodPayslips = (scope: PayrollScope, enabled = true) =>
  useQuery<PeriodPayslips>({
    queryKey: getPeriodPayslipsQueryKey(scope),
    queryFn: () => customFetch<PeriodPayslips>(`${payslipsPath(scope.kind)}?${scopeQuery(scope)}`),
    enabled: enabled && scopeReady(scope),
    staleTime: 0,
  });

/** One staff month. */
export const useStaffPayslips = (month: number, year: number, enabled = true) =>
  usePeriodPayslips({ kind: "staff", month, year }, enabled);

/** One period of a production pay cycle. */
export const useProductionPayslips = (cycle: PayCycle, period: CyclePeriod, enabled = true) =>
  usePeriodPayslips({ kind: "production", cycle, ...period }, enabled);

// ── Files ─────────────────────────────────────────────────────────────────────

/**
 * One PDF for the payrolls picked: `/api/payslips/staff/pdf?month=11&year=2026&ids=881,882&layout=single`, or
 * `/api/payslips/production/pdf?cycle=weekly&periodStart=...&periodEnd=...&ids=...&layout=double`.
 */
export function payslipsPdfUrl(scope: PayrollScope, payrollIds: readonly number[], layout: PayslipLayout): string {
  return `${payslipsPath(scope.kind)}/pdf?${scopeQuery(scope)}&ids=${payrollIds.join(",")}&layout=${layout}`;
}

/** The staff form of payslipsPdfUrl. */
export const staffPayslipsPdfUrl = (
  month: number,
  year: number,
  payrollIds: readonly number[],
  layout: PayslipLayout,
): string => payslipsPdfUrl({ kind: "staff", month, year }, payrollIds, layout);

export class PayslipDownloadError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "PayslipDownloadError";
    this.status = status;
  }
}

function readToken(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem("uk_textile_token") : null;
  } catch {
    return null;
  }
}

/**
 * Downloads the payslips of the payrolls picked as one PDF. A plain link cannot send the bearer token, so the file is
 * fetched, checked (a wrong API base answers index.html with HTTP 200 on a split deployment) and saved from a blob, named
 * from Content-Disposition (`fallbackName` when the header cannot be read). Resolves with the saved name; rejects with a
 * PayslipDownloadError whose message is the server's own sentence when it sent one.
 */
export async function downloadPayslipsPdf(opts: {
  scope: PayrollScope;
  payrollIds: readonly number[];
  layout: PayslipLayout;
  fallbackName: string;
}): Promise<string> {
  const token = readToken();
  let response: Response;
  try {
    response = await fetch(`${getApiOrigin()}${payslipsPdfUrl(opts.scope, opts.payrollIds, opts.layout)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new PayslipDownloadError("Could not reach the server. Check your connection and try again.");
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.ok) {
    let message = `The payslip PDF could not be made (error ${response.status}). Try again in a minute.`;
    if (type.includes("json")) {
      try {
        const body = (await response.json()) as { error?: string; message?: string };
        message = body.error || body.message || message;
      } catch {
        /* keep the generic message */
      }
    }
    throw new PayslipDownloadError(message, response.status);
  }
  if (!type.includes("application/pdf")) {
    throw new PayslipDownloadError(
      "The server sent something other than a PDF. Reload the page and try again.",
      response.status,
    );
  }
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get("content-disposition")) ?? opts.fallbackName;
  downloadBlob(blob, filename);
  return filename;
}

/** The staff form of downloadPayslipsPdf. */
export const downloadStaffPayslipsPdf = (opts: {
  month: number;
  year: number;
  payrollIds: readonly number[];
  layout: PayslipLayout;
  fallbackName: string;
}): Promise<string> =>
  downloadPayslipsPdf({
    scope: { kind: "staff", month: opts.month, year: opts.year },
    payrollIds: opts.payrollIds,
    layout: opts.layout,
    fallbackName: opts.fallbackName,
  });
