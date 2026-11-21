// salary-slip-center: the standalone Salary Slip page (/hr/salary-slip, owner 2026-11-20). It works out a salary slip for
// ANY employee (active, inactive, on hold, new joiner) from the employee's current details, attendance and salary only,
// and never reads or writes Staff / Production Payroll. It also gives the salary statement (PDF / Excel) and the bank file
// for the employees picked, and its own per-month Hold / Release switch. Backend: /api/salary-slip-center/*.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { downloadBlob } from "@/lib/exportUtils";
import { filenameFromDisposition } from "@/lib/report-download";
import { ApiError, customFetch, getApiOrigin } from "../custom-fetch";

// ── Types ─────────────────────────────────────────────────────────────────────

/** What a slip deducts; each one can be switched off when generating or previewing. No OT pay, no bonus. */
export type SlipOptions = {
  /** PF / ESI / TDS, from the employee's Co Emp / TDS setting. */
  statutory: boolean;
  /** Late and permission deductions from attendance. */
  lateDeductions: boolean;
  /** This month's advance / loan instalments (read only: never marked recovered). */
  advances: boolean;
};

export const DEFAULT_SLIP_OPTIONS: SlipOptions = { statutory: true, lateDeductions: true, advances: true };

export type SlipCategory = "staff" | "production";

/** The month's saved slip of one employee, in short. */
export type SavedSlipSummary = {
  slipNumber: string;
  generatedAt: string | null;
  generatedBy: string | null;
  gross: number;
  deductions: number;
  net: number;
  /** Staff: paid days; production: total shifts. */
  paidDays: number | null;
  options: SlipOptions;
  /** The last day counted (a month in progress is counted up to the day it was generated). */
  countedTo: string | null;
};

export type SlipCenterEmployee = {
  id: number;
  code: string;
  name: string;
  category: SlipCategory;
  /** Raw Employee.status, lower-case ("active" / "inactive"). */
  status: string;
  departmentId: number | null;
  department: string | null;
  designationId: number | null;
  designation: string | null;
  branchId: number | null;
  unit: string | null;
  joinDate: string | null;
  /** The join date is inside the selected month. */
  isNewJoiner: boolean;
  /** This page's own Hold switch for the month (left out of the bank file, still on slips and the statement). */
  onHold: boolean;
  holdReason: string;
  heldAt: string | null;
  heldBy: string | null;
  /** Staff: the monthly salary; null for production. */
  monthlySalary: number | null;
  /** Production: the salary per shift; null for staff. */
  salaryPerShift: number | null;
  /** Why no slip can be worked out ("No monthly salary on the profile"), or null. */
  payIssue: string | null;
  /** Last four digits shown ("XXXXXX1234"), or null. */
  bankAccountMasked: string | null;
  /** What keeps the employee out of the bank file ("No bank account number" / "No IFSC code"), or null. */
  bankIssue: string | null;
  slip: SavedSlipSummary | null;
};

export type SlipCenterDepartment = { id: number; name: string; category: string | null };
export type SlipCenterDesignation = { id: number; title: string; category: string | null };
export type SlipCenterUnit = { id: number; name: string };

export type SlipCenterList = {
  month: number;
  year: number;
  periodLabel: string;
  monthStart: string;
  monthEnd: string;
  /** The month is not over yet: slips are counted up to today. */
  inProgress: boolean;
  /** May this login Generate and Hold / Release (the page's Edit right). */
  canEdit: boolean;
  defaultOptions: SlipOptions;
  employees: SlipCenterEmployee[];
  departments: SlipCenterDepartment[];
  designations: SlipCenterDesignation[];
  units: SlipCenterUnit[];
};

export type SlipAmountLine = { key: string; label: string; amount: number; note?: string };
export type SlipDayLine = { key: string; label: string; value: number | string | null };

export type SlipCalendarStatus =
  "present" | "half_shift" | "absent" | "leave" | "holiday" | "sunday" | "weekly_off" | "not_joined" | "future";

export type SlipCalendarDay = {
  date: string;
  day: string;
  status: SlipCalendarStatus | string;
  shifts: number | null;
  firstIn: string | null;
  lastOut: string | null;
  late: boolean;
  note: string;
};

/** One slip, worked out now (preview) or as it was saved. */
export type SlipResult = {
  employeeId: number;
  kind: SlipCategory;
  slipNumber: string | null;
  employee: {
    code: string;
    name: string;
    department: string | null;
    designation: string | null;
    unit: string | null;
    joinDate: string | null;
    status: string;
    category: SlipCategory;
    bankName: string | null;
    bankAccountMasked: string | null;
    ifsc: string | null;
    pfNumber: string | null;
    esiNumber: string | null;
    uanNumber: string | null;
  };
  period: {
    month: number;
    year: number;
    label: string;
    from: string;
    to: string;
    countedTo: string | null;
    inProgress: boolean;
  };
  rate: {
    monthlySalary: number | null;
    dailyRate: number | null;
    companyDays: number | null;
    salaryPerShift: number | null;
  };
  days: SlipDayLine[];
  earnings: SlipAmountLine[];
  grossTotal: number;
  deductions: SlipAmountLine[];
  deductionsTotal: number;
  net: number;
  netInWords: string;
  calendar: SlipCalendarDay[];
  notes: string[];
  options: SlipOptions;
  statement?: Record<string, unknown>;
};

export type SavedSlip = { result: SlipResult; slip: SavedSlipSummary };

export type GenerateSlipsBody = { month: number; year: number; employeeIds: number[]; options: SlipOptions };

export type SkippedSlip = { employeeId: number; code: string; name: string; reason: string };

export type GenerateSlipsResult = {
  generated: { employeeId: number; slip: SavedSlipSummary }[];
  skipped: SkippedSlip[];
};

export type HoldSlipsBody = { month: number; year: number; employeeIds: number[]; hold: boolean; reason?: string };

export type HoldSlipsResult = {
  updated: number;
  employees: { id: number; onHold: boolean; holdReason: string; heldAt: string | null; heldBy: string | null }[];
};

export type BankCheck = {
  included: { employeeId: number; code: string; name: string; amount: number }[];
  total: number;
  /** Reasons: "On hold", "No bank account number", "No IFSC code", "Net pay is zero", "Not generated yet". */
  leftOut: { employeeId: number; code: string; name: string; reason: string }[];
};

/** At most this many ids per Generate call (the server takes 50; the page sends smaller batches to show progress). */
export const SLIP_GENERATE_MAX_IDS = 50;

// ── Query keys ────────────────────────────────────────────────────────────────

export const SALARY_SLIP_CENTER_PREFIX = "/api/salary-slip-center";

const period = (month: number, year: number) => `month=${month}&year=${year}`;

/** "statutory=1&late=1&advances=1": the switches as the preview takes them. */
export const slipOptionsQuery = (o: SlipOptions): string =>
  `statutory=${o.statutory ? 1 : 0}&late=${o.lateDeductions ? 1 : 0}&advances=${o.advances ? 1 : 0}`;

export const getSalarySlipCenterListQueryKey = (month: number, year: number) =>
  [`${SALARY_SLIP_CENTER_PREFIX}/employees`, { month, year }] as const;

export const getSalarySlipPreviewQueryKey = (month: number, year: number, employeeId: number, options: SlipOptions) =>
  [`${SALARY_SLIP_CENTER_PREFIX}/preview`, { month, year, employeeId, ...options }] as const;

export const getSavedSalarySlipQueryKey = (month: number, year: number, employeeId: number) =>
  [`${SALARY_SLIP_CENTER_PREFIX}/slip`, { month, year, employeeId }] as const;

const isCenterKey = (key: readonly unknown[]): boolean =>
  typeof key[0] === "string" && key[0].startsWith(SALARY_SLIP_CENTER_PREFIX);

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Every employee the login may see, with the month's hold switch and saved slip, and the filter lists. */
export const useSalarySlipCenterList = (month: number, year: number) =>
  useQuery<SlipCenterList>({
    queryKey: getSalarySlipCenterListQueryKey(month, year),
    queryFn: () => customFetch<SlipCenterList>(`${SALARY_SLIP_CENTER_PREFIX}/employees?${period(month, year)}`),
    enabled: month > 0 && year > 0,
  });

/** One employee's slip worked out NOW, without saving (a 400 says why it cannot be worked out). */
export const useSalarySlipPreview = (
  params: { month: number; year: number; employeeId: number | null; options: SlipOptions },
  enabled = true,
) =>
  useQuery<SlipResult>({
    queryKey: getSalarySlipPreviewQueryKey(params.month, params.year, params.employeeId ?? 0, params.options),
    queryFn: async () => {
      const r = await customFetch<{ result: SlipResult }>(
        `${SALARY_SLIP_CENTER_PREFIX}/preview?${period(params.month, params.year)}&employeeId=${params.employeeId}&${slipOptionsQuery(params.options)}`,
      );
      return r.result;
    },
    enabled: enabled && params.employeeId !== null,
    retry: false,
  });

/** The month's SAVED slip of one employee; null when none was generated (the server's 404). */
export const useSavedSalarySlip = (
  params: { month: number; year: number; employeeId: number | null },
  enabled = true,
) =>
  useQuery<SavedSlip | null>({
    queryKey: getSavedSalarySlipQueryKey(params.month, params.year, params.employeeId ?? 0),
    queryFn: async () => {
      try {
        return await customFetch<SavedSlip>(
          `${SALARY_SLIP_CENTER_PREFIX}/slip?${period(params.month, params.year)}&employeeId=${params.employeeId}`,
        );
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: enabled && params.employeeId !== null,
    retry: false,
  });

// ── Writes ────────────────────────────────────────────────────────────────────

/** Works out and SAVES the slips of up to 50 employees (replacing the month's earlier ones). One call; the page batches. */
export const generateSalarySlips = (body: GenerateSlipsBody) =>
  customFetch<GenerateSlipsResult>(`${SALARY_SLIP_CENTER_PREFIX}/generate`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/** What the bank file would hold for these employees, and who is left out and why (asked before every bank file). */
export const fetchSalarySlipBankCheck = (month: number, year: number, ids: readonly number[]) =>
  customFetch<BankCheck>(`${SALARY_SLIP_CENTER_PREFIX}/bank-check?${period(month, year)}&ids=${ids.join(",")}`);

/** Refreshes everything this page shows (the list, saved slips and previews) after a Generate or a Hold. */
export function useRefreshSalarySlipCenter() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (q) => isCenterKey(q.queryKey) });
}

/** Hold (hold: true, with an optional reason) or Release (hold: false) employees for the month. */
export function useHoldSalarySlips() {
  const refresh = useRefreshSalarySlipCenter();
  return useMutation({
    mutationFn: (body: HoldSlipsBody) =>
      customFetch<HoldSlipsResult>(`${SALARY_SLIP_CENTER_PREFIX}/hold`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => void refresh(),
  });
}

// ── Files ─────────────────────────────────────────────────────────────────────

export type SlipFileRequest =
  /** single = one full A4 slip per page; double = two slips per landscape A4 page. */
  { kind: "slips"; layout: "single" | "double" } | { kind: "statement"; fmt: "pdf" | "xlsx" } | { kind: "bank-file" };

export class SlipDownloadError extends Error {
  readonly status: number;
  /** The ids with no saved slip (the server's 409), else empty. */
  readonly missing: number[];
  constructor(message: string, status = 0, missing: number[] = []) {
    super(message);
    this.name = "SlipDownloadError";
    this.status = status;
    this.missing = missing;
  }
}

const fileFormat = (req: SlipFileRequest): "pdf" | "xlsx" =>
  req.kind === "slips" ? "pdf" : req.kind === "statement" ? req.fmt : "xlsx";

/** The address of one file: `/api/salary-slip-center/download/slips?month=11&year=2026&ids=1,2&layout=single`. */
export function slipFileUrl(month: number, year: number, ids: readonly number[], req: SlipFileRequest): string {
  const extra = req.kind === "slips" ? `&layout=${req.layout}` : req.kind === "statement" ? `&fmt=${req.fmt}` : "";
  return `${SALARY_SLIP_CENTER_PREFIX}/download/${req.kind}?${period(month, year)}&ids=${ids.join(",")}${extra}`;
}

function readToken(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem("uk_textile_token") : null;
  } catch {
    return null;
  }
}

/**
 * Downloads a slips PDF, the salary statement or the bank file. A plain link cannot send the bearer token, so the file is
 * fetched, checked (a wrong API base answers index.html with HTTP 200 on a split deployment) and saved from a blob, named
 * from Content-Disposition (`fallbackName` when the header cannot be read). Resolves with the saved name; rejects with a
 * SlipDownloadError whose message is fit to show (and whose `missing` lists the ids with no saved slip on a 409).
 */
export async function downloadSalarySlipCenterFile(opts: {
  month: number;
  year: number;
  ids: readonly number[];
  request: SlipFileRequest;
  fallbackName: string;
}): Promise<string> {
  const format = fileFormat(opts.request);
  const what = format === "pdf" ? "PDF" : "Excel";
  const token = readToken();
  let response: Response;
  try {
    response = await fetch(`${getApiOrigin()}${slipFileUrl(opts.month, opts.year, opts.ids, opts.request)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new SlipDownloadError("Could not reach the server. Check your connection and try again.");
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.ok) {
    let message = `The ${what} file could not be made (error ${response.status}). Try again in a minute.`;
    let missing: number[] = [];
    if (type.includes("json")) {
      try {
        const body = (await response.json()) as { error?: string; message?: string; missing?: unknown };
        message = body.error || body.message || message;
        if (Array.isArray(body.missing)) missing = body.missing.map(Number).filter((n) => Number.isFinite(n));
      } catch {
        /* keep the generic message */
      }
    }
    throw new SlipDownloadError(message, response.status, missing);
  }
  const marker = format === "pdf" ? "application/pdf" : "spreadsheetml";
  if (!type.includes(marker)) {
    throw new SlipDownloadError(
      "The server sent something other than a file. Reload the page and try again.",
      response.status,
    );
  }
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get("content-disposition")) ?? opts.fallbackName;
  downloadBlob(blob, filename);
  return filename;
}
