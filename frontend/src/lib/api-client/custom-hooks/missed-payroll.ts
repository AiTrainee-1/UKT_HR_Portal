// missed-payroll: the Missed Payroll page (/hr/missed-payroll, owner 2026-11-23). It lists, for one month, the employees the
// regular Staff / Production Payroll missed (salary not fixed, on hold, new joiners, not generated; inactive employees on
// their own; payroll rows not marked Cleared only to check), works their pay out (Generate), and takes each one through
// Clear -> Done (written into the month's payroll, remark MISSED PAYROLL) -> Paid, with its own payroll report, salary
// statement and bank file. Backend: /api/missed-payroll/* (backend/api/missed_payroll/views.py).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { downloadBlob } from "@/lib/exportUtils";
import { filenameFromDisposition } from "@/lib/report-download";
import { customFetch, getApiOrigin } from "../custom-fetch";
import type { MoneyLine } from "./payroll-insights";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MissedKind = "staff" | "production";

/** Why the regular payroll missed the employee (lists.py CATEGORIES). */
export type MissedCategory = "not_generated" | "no_salary" | "on_hold" | "new_joiner" | "not_cleared" | "inactive";

/** Where the page's own entry stands: Generated -> Cleared -> Done (in the month's payroll) -> Paid. */
export type MissedStatus = "generated" | "cleared" | "done" | "paid";

/** The month's regular payroll row of the employee, when there is one (on hold, a parked new joiner, not cleared ...). */
export type MissedPayrollRef = {
  id: number;
  net: number | null;
  /** Marked Cleared on Payroll Details. */
  cleared: boolean;
  onHold: boolean;
  newJoinerParked: boolean;
  paymentStatus: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  payCycle: string | null;
  source: string | null;
};

/** The page's own saved figures of the employee for the month (lists.py entry_json). */
export type MissedEntry = {
  id: number;
  status: MissedStatus;
  category: MissedCategory;
  gross: number | null;
  deductions: number | null;
  net: number | null;
  /** Production: the [from, to] day ranges this entry pays (ISO dates). */
  payRanges: [string, string][];
  /** How many calendar days the ranges cover. */
  payDays: number;
  /** The regular payroll row Done replaces (a held / parked one), if any. */
  replacesPayrollId: number | null;
  /** The month's payroll row Done wrote, once Done. */
  payrollId: number | null;
  generatedAt: string | null;
  generatedBy: string | null;
  clearedAt: string | null;
  clearedBy: string | null;
  doneAt: string | null;
  doneBy: string | null;
  paidAt: string | null;
  paidBy: string | null;
  /** The day HR said it was paid (ISO date). */
  paidOn: string | null;
};

/** Production: the days of the month no payroll pays yet. */
export type MissedPayDays = {
  ranges: [string, string][];
  /** "1 Nov - 14 Nov and 20 Nov - 30 Nov". */
  text: string;
  days: number;
  /** Days of those ranges the worker punched (or earned shifts). */
  worked: number;
};

export type MissedRow = {
  id: number;
  code: string;
  name: string;
  /** Employee.status, lower-case ("active" / "inactive"). */
  status: string;
  departmentId: number | null;
  department: string;
  designationId: number | null;
  designation: string;
  branchId: number | null;
  unit: string;
  joinDate: string | null;
  /** Staff: the monthly salary; production: the salary per shift; null when not set. */
  salary: number | null;
  /** Production: the worker's pay cycle (weekly / biweekly / monthly), else null. */
  payCycle: string | null;
  /** What keeps the employee out of a bank file ("No bank account number" / "No IFSC code"), or null. */
  bankIssue: string | null;
  category: MissedCategory;
  categoryLabel: string;
  /** Why the payroll missed them, in one sentence. */
  reason: string;
  /** More about it ("Held by Admin.", "Punched on 6 days ..."), or null. */
  detail: string | null;
  payroll: MissedPayrollRef | null;
  entry: MissedEntry | null;
  /** May be generated (again) now. */
  canGenerate: boolean;
  /** Why not, when it may not. */
  cannotGenerate: string | null;
  payDays: MissedPayDays | null;
};

export type MissedSummary = {
  total: number;
  active: number;
  inactive: number;
  byCategory: Record<MissedCategory, number>;
  byStatus: Record<MissedStatus, number>;
  netByStatus: Record<MissedStatus, number>;
};

export type MissedPayrollList = {
  kind: MissedKind;
  month: number;
  year: number;
  /** "November 2026". */
  periodLabel: string;
  monthStart: string;
  monthEnd: string;
  monthStarted: boolean;
  /** Production is worked out only once the month is over. */
  monthEnded: boolean;
  /** The regular payroll has worked out someone for the month. */
  mainGenerated: boolean;
  /** Staff: the month is finalized (Payroll Done) on the Staff Payroll. Done here still adds to it. */
  mainFinalized: boolean;
  mainPaid: boolean;
  /** May this login Generate and change statuses (the page's Edit right). */
  canEdit: boolean;
  /** A login for all units: Done and Paid need it. */
  wholeCompany: boolean;
  summary: MissedSummary;
  categories: { value: MissedCategory; label: string }[];
  departments: { id: number; name: string }[];
  units: { id: number; name: string }[];
  employees: MissedRow[];
};

/** One day of the entry's figures, as the payroll engine stored it (staff and production differ a little). */
export type MissedEntryDay = {
  date: string;
  day?: string;
  status?: string;
  isLate?: boolean;
  firstIn?: string | null;
  lastOut?: string | null;
  firstPunch?: string | null;
  lastPunch?: string | null;
  shiftsCompleted?: number | null;
  shiftsEarned?: number | null;
  leaveType?: string | null;
  [key: string]: unknown;
};

/** GET entry: one entry's figures (exports.py detail_json). */
export type MissedEntryDetail = {
  entry: MissedEntry;
  employee: { id: number; code: string; name: string };
  kind: MissedKind;
  month: number;
  year: number;
  periodStart: string | null;
  periodEnd: string | null;
  earnings: MoneyLine[];
  deductions: MoneyLine[];
  /** The salary statement row these figures become on Done (plus `status` and `category`). */
  statement: Record<string, string | number | null>;
  summary: Record<string, unknown>;
  days: MissedEntryDay[];
  notes: string | null;
};

export type MissedBody = { kind: MissedKind; month: number; year: number; employeeIds: number[] };

/** Who a call could not change, and why (the server's own sentence). */
export type MissedRefusal = { employeeId: number; employeeCode: string; name: string; reason: string };

export type MissedGenerateResult = {
  generated: { employeeId: number; employeeCode: string; name: string; entryId: number; net: number; gross: number }[];
  skipped: MissedRefusal[];
};

/** Clear / Undo clear / Remove answer entry ids in `done`; Done and Paid answer rows. Only the count is read. */
export type MissedStatusResult = {
  done: unknown[];
  refused: MissedRefusal[];
  /** Paid (staff): how many "salary paid" notifications were queued. */
  notified?: number;
};

export type MissedStatusAction = "clear" | "unclear" | "discard" | "done" | "paid";

export type MissedBankCheck = {
  included: { employeeId: number; code: string; name: string; amount: number }[];
  total: number;
  /** "Not Done yet ...", "Already marked paid", "No bank account number", "No IFSC code", "Net pay is zero". */
  leftOut: { employeeId: number; code: string; name: string; reason: string }[];
};

/** The server takes at most this many employees per Generate call. */
export const MISSED_GENERATE_MAX_IDS = 20;

// ── Query keys ────────────────────────────────────────────────────────────────

export const MISSED_PAYROLL_PREFIX = "/api/missed-payroll";

const period = (kind: MissedKind, month: number, year: number) => `kind=${kind}&month=${month}&year=${year}`;

export const getMissedPayrollListQueryKey = (kind: MissedKind, month: number, year: number) =>
  [`${MISSED_PAYROLL_PREFIX}/employees`, { kind, month, year }] as const;

export const getMissedPayrollEntryQueryKey = (id: number) => [`${MISSED_PAYROLL_PREFIX}/entry`, { id }] as const;

/** This page's keys, and the payroll lists Done / Paid change (Staff and Production Payroll, Payroll Details). */
const isRefreshedKey = (key: readonly unknown[]): boolean =>
  typeof key[0] === "string" &&
  (key[0].startsWith(MISSED_PAYROLL_PREFIX) || (key[0].startsWith("/api/payroll") && !key[0].includes("skip-check")));

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Who the regular payroll missed for the month, by category, with their entry, the banners' facts and the filter lists. */
export const useMissedPayrollList = (kind: MissedKind, month: number, year: number) =>
  useQuery<MissedPayrollList>({
    queryKey: getMissedPayrollListQueryKey(kind, month, year),
    queryFn: () => customFetch<MissedPayrollList>(`${MISSED_PAYROLL_PREFIX}/employees?${period(kind, month, year)}`),
    enabled: month > 0 && year > 0,
  });

/** One entry's figures: earnings, deductions, the statement row and the days. */
export const useMissedPayrollEntry = (id: number | null) =>
  useQuery<MissedEntryDetail>({
    queryKey: getMissedPayrollEntryQueryKey(id ?? 0),
    queryFn: () => customFetch<MissedEntryDetail>(`${MISSED_PAYROLL_PREFIX}/entry?id=${id}`),
    enabled: id !== null,
    retry: false,
  });

// ── Writes ────────────────────────────────────────────────────────────────────

/** Works out and saves the entries of up to 20 employees. One call; the page batches. */
export const generateMissedPayroll = (body: MissedBody) =>
  customFetch<MissedGenerateResult>(`${MISSED_PAYROLL_PREFIX}/generate`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/** Clear, Undo clear (unclear), Remove (discard), Done, or Paid (with `paidOn`, an ISO date not after today). */
export const changeMissedPayrollStatus = (action: MissedStatusAction, body: MissedBody & { paidOn?: string }) =>
  customFetch<MissedStatusResult>(`${MISSED_PAYROLL_PREFIX}/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/** Who the bank file would pay (Done, not yet paid, with bank details) and who it leaves out (asked before the file). */
export const fetchMissedPayrollBankCheck = (kind: MissedKind, month: number, year: number, ids: readonly number[]) =>
  customFetch<MissedBankCheck>(`${MISSED_PAYROLL_PREFIX}/bank-check?${period(kind, month, year)}&ids=${ids.join(",")}`);

/** Refreshes this page (list and entries) and the payroll lists a Done or Paid changed. */
export function useRefreshMissedPayroll() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (q) => isRefreshedKey(q.queryKey) });
}

// ── Files ─────────────────────────────────────────────────────────────────────

export type MissedFileRequest = { kind: "report" } | { kind: "statement"; fmt: "pdf" | "xlsx" } | { kind: "bank-file" };

export class MissedPayrollDownloadError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "MissedPayrollDownloadError";
    this.status = status;
  }
}

const fileFormat = (req: MissedFileRequest): "pdf" | "xlsx" => (req.kind === "statement" ? req.fmt : "xlsx");

/** `/api/missed-payroll/download/statement?kind=staff&month=11&year=2026&ids=1,2&fmt=pdf`. */
export function missedPayrollFileUrl(
  kind: MissedKind,
  month: number,
  year: number,
  ids: readonly number[],
  req: MissedFileRequest,
): string {
  const extra = req.kind === "statement" ? `&fmt=${req.fmt}` : "";
  return `${MISSED_PAYROLL_PREFIX}/download/${req.kind}?${period(kind, month, year)}&ids=${ids.join(",")}${extra}`;
}

function readToken(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem("uk_textile_token") : null;
  } catch {
    return null;
  }
}

/**
 * Downloads the payroll report, the salary statement or the bank file. A plain link cannot send the bearer token, so the
 * file is fetched, checked (a wrong API base answers index.html with HTTP 200 on a split deployment) and saved from a
 * blob, named from Content-Disposition (`fallbackName` when the header cannot be read). Resolves with the saved name;
 * rejects with a MissedPayrollDownloadError whose message is fit to show.
 */
export async function downloadMissedPayrollFile(opts: {
  kind: MissedKind;
  month: number;
  year: number;
  ids: readonly number[];
  request: MissedFileRequest;
  fallbackName: string;
}): Promise<string> {
  const format = fileFormat(opts.request);
  const what = format === "pdf" ? "PDF" : "Excel";
  const token = readToken();
  let response: Response;
  try {
    response = await fetch(
      `${getApiOrigin()}${missedPayrollFileUrl(opts.kind, opts.month, opts.year, opts.ids, opts.request)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
  } catch {
    throw new MissedPayrollDownloadError("Could not reach the server. Check your connection and try again.");
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.ok) {
    let message = `The ${what} file could not be made (error ${response.status}). Try again in a minute.`;
    if (type.includes("json")) {
      try {
        const body = (await response.json()) as { error?: string; message?: string };
        message = body.error || body.message || message;
      } catch {
        /* keep the generic message */
      }
    }
    throw new MissedPayrollDownloadError(message, response.status);
  }
  const marker = format === "pdf" ? "application/pdf" : "spreadsheetml";
  if (!type.includes(marker)) {
    throw new MissedPayrollDownloadError(
      "The server sent something other than a file. Reload the page and try again.",
      response.status,
    );
  }
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get("content-disposition")) ?? opts.fallbackName;
  downloadBlob(blob, filename);
  return filename;
}
