// pf-esi: the Co Emp / TDS side of PF and ESI. Backend: api/pf_esi.py and the /api/tds/employees and
// /api/pf-esi/coverage views.
//
// Three kinds of employee, mutually exclusive:
//   * Co Emp  (Employee.coEmpEnabled)  the ONLY employees PF/ESI can apply to (also visible in the CoPortal)
//   * TDS     (Employee.tdsEnabled)    TDS only, never PF/ESI (also visible in the CoPortal)
//   * neither                          nothing is deducted, ever
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { customFetch, getApiOrigin } from "../custom-fetch";

/** The two kinds of employee payroll treats separately everywhere (Settings, payroll pages, this page). */
export type PfEsiClass = "staff" | "production";

export const PF_ESI_CLASSES: readonly PfEsiClass[] = ["staff", "production"];

// ── Query keys (and what must be refreshed together) ──────────────────────────

export const TDS_EMPLOYEES_KEY = "/api/tds/employees";
export const PF_ESI_COVERAGE_KEY = "/api/pf-esi/coverage";
const EMPLOYEES_KEY = "/api/employees";

/**
 * Everything that shows who is Co Emp / TDS: the employee lists (their toggles and TDS percentages), the TDS list with
 * its counts and the coverage numbers. A change to any one of them (a Co Emp toggle, an employee added to TDS, a
 * percentage edited, someone removed) refreshes all of them so no screen is left showing the old category.
 * Resolves once the EMPLOYEE lists are fresh (the other two refresh in the background), so a toggle that waits for this
 * never snaps back to its old position before the new one arrives.
 */
export function invalidateCoEmpQueries(queryClient: QueryClient): Promise<void> {
  void queryClient.invalidateQueries({ queryKey: [TDS_EMPLOYEES_KEY] });
  void queryClient.invalidateQueries({ queryKey: [PF_ESI_COVERAGE_KEY] });
  return queryClient.invalidateQueries({ queryKey: [EMPLOYEES_KEY] });
}

// ── TDS employees ─────────────────────────────────────────────────────────────

export type TdsEmployeeRow = {
  id: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
  designationTitle: string | null;
  branchId: number | null;
  branchName: string | null;
  employmentType: PfEsiClass;
  status: string;
  tdsPercent: number | null;
};

export type TdsListParams = {
  type?: PfEsiClass | "all";
  search?: string;
  status?: "active" | "all";
  branchId?: number;
};

/** `counts` are the TDS employees in the caller's scope whatever `type`, `search` and `status` were asked for. */
export type TdsListResponse = {
  employees: TdsEmployeeRow[];
  counts: { all: number; staff: number; production: number };
};

export type TdsAddResult = { employee: TdsEmployeeRow; movedFromPfEsi: boolean };

function queryString(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : "";
}

export const getTdsEmployeesQueryKey = (params: TdsListParams = {}) => [TDS_EMPLOYEES_KEY, params] as const;

export const useTdsEmployees = (params: TdsListParams = {}, options?: { enabled?: boolean }) =>
  useQuery<TdsListResponse>({
    queryKey: getTdsEmployeesQueryKey(params),
    queryFn: () => customFetch<TdsListResponse>(`${TDS_EMPLOYEES_KEY}${queryString(params)}`),
    enabled: options?.enabled ?? true,
    // The previous list stays on screen while a new search or tab loads, so the table does not flash empty.
    placeholderData: (previous) => previous,
  });

/** Puts an employee in TDS by code. A Co Emp employee is taken out of Co Emp in the same step (`movedFromPfEsi`). */
export const useAddTdsEmployee = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeCode, percent }: { employeeCode: string; percent: number }) =>
      customFetch<TdsAddResult>(TDS_EMPLOYEES_KEY, {
        method: "POST",
        body: JSON.stringify({ employeeCode, percent }),
      }),
    onSuccess: () => invalidateCoEmpQueries(queryClient),
  });
};

export const useUpdateTdsPercent = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, percent }: { employeeId: number; percent: number }) =>
      customFetch<{ employee: TdsEmployeeRow }>(`${TDS_EMPLOYEES_KEY}/${employeeId}`, {
        method: "PATCH",
        body: JSON.stringify({ percent }),
      }),
    onSuccess: () => invalidateCoEmpQueries(queryClient),
  });
};

/** Takes an employee out of TDS only: they end up in no category (not Co Emp, not TDS). */
export const useRemoveTdsEmployee = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId }: { employeeId: number }) =>
      customFetch<{ employee: TdsEmployeeRow; removed: boolean }>(`${TDS_EMPLOYEES_KEY}/${employeeId}`, {
        method: "DELETE",
      }),
    onSuccess: () => invalidateCoEmpQueries(queryClient),
  });
};

// ── Coverage: who has PF / ESI and who does not ───────────────────────────────

/** One class's numbers. total = coEmp + tds + notCoEmp, and coEmp = withAny + withNeither + notEvaluated. */
export type CoverageCounts = {
  total: number;
  coEmp: number;
  tds: number;
  notCoEmp: number;
  withPf: number;
  withEsi: number;
  withBoth: number;
  /** PF and/or ESI deducted (withPf + withEsi - withBoth). */
  withAny: number;
  /** Co Emp, but no rule matched, so nothing is deducted. */
  withNeither: number;
  /** Production only: Co Emp employees with no generated payroll yet, so their PF/ESI is not known. */
  notEvaluated: number;
};

export type CoverageStatus = "pf_esi" | "pf_only" | "esi_only" | "neither" | "not_evaluated" | "tds" | "not_co_emp";

export type CoverageRow = {
  id: number;
  employeeCode: string;
  name: string;
  employmentType: PfEsiClass;
  departmentName: string | null;
  branchId: number | null;
  branchName: string | null;
  category: "co_emp" | "tds" | "none";
  pf: boolean | null;
  esi: boolean | null;
  pfRatePercent: number | null;
  esiRatePercent: number | null;
  status: CoverageStatus;
  tdsPercent: number | null;
};

export type CoverageParams = {
  type?: PfEsiClass | "all";
  branchId?: number;
  /** Also return one row per employee (`employees`). */
  detail?: boolean;
};

/** A class that was not asked for (`type=staff`) is absent. */
export type CoverageResponse = {
  asOf: string;
  filters: { type: PfEsiClass | "all"; branchId: number | null };
  staff?: CoverageCounts;
  production?: CoverageCounts;
  employees?: CoverageRow[];
};

export const getPfEsiCoverageQueryKey = (params: CoverageParams = {}) => [PF_ESI_COVERAGE_KEY, params] as const;

export const usePfEsiCoverage = (params: CoverageParams = {}, options?: { enabled?: boolean }) =>
  useQuery<CoverageResponse>({
    queryKey: getPfEsiCoverageQueryKey(params),
    queryFn: () =>
      customFetch<CoverageResponse>(
        `${PF_ESI_COVERAGE_KEY}${queryString({
          type: params.type,
          branchId: params.branchId,
          detail: params.detail ? 1 : undefined,
        })}`,
      ),
    enabled: options?.enabled ?? true,
    placeholderData: (previous) => previous,
  });

// ── Coverage export (Excel / PDF) ─────────────────────────────────────────────

export type CoverageFileFormat = "xlsx" | "pdf";

export class CoverageDownloadError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "CoverageDownloadError";
    this.status = status;
  }
}

const FILE_MARKER: Record<CoverageFileFormat, string> = { xlsx: "spreadsheetml", pdf: "application/pdf" };

/** "pf_esi_coverage_all_20261024_1030.xlsx" (local time, like every other export of the portal). */
export function coverageFilename(format: CoverageFileFormat, type: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `pf_esi_coverage_${type}_${stamp}.${format}`;
}

/** Reads `filename="x"` / `filename*=UTF-8''x` from a Content-Disposition header (null if absent). */
export function dispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  return plain ? plain[1].trim() : null;
}

/**
 * Downloads the PF/ESI coverage report as Excel or PDF. A plain link cannot send the bearer token, so the file is fetched,
 * checked (a wrong API base answers index.html with HTTP 200 on a split deployment) and saved from a blob. Resolves with the
 * file name; rejects with a CoverageDownloadError whose message is fit to show.
 * Kept free of the Excel library so this module (re-exported to every page) stays light.
 */
export async function downloadCoverageFile(opts: {
  format: CoverageFileFormat;
  type?: PfEsiClass | "all";
  branchId?: number;
}): Promise<string> {
  const type = opts.type ?? "all";
  const url = `${getApiOrigin()}${PF_ESI_COVERAGE_KEY}/export${queryString({
    format: opts.format,
    type,
    branchId: opts.branchId,
  })}`;
  let token: string | null = null;
  try {
    token = typeof localStorage !== "undefined" ? localStorage.getItem("uk_textile_token") : null;
  } catch {
    token = null;
  }
  const what = opts.format === "pdf" ? "PDF" : "Excel";
  let response: Response;
  try {
    response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new CoverageDownloadError("Could not reach the server. Check your connection and try again.");
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.ok) {
    let message = `The ${what} file could not be created (HTTP ${response.status}).`;
    if (contentType.includes("json")) {
      try {
        const body = (await response.json()) as { message?: string; error?: string };
        message = body.message || body.error || message;
      } catch {
        /* keep the generic message */
      }
    }
    throw new CoverageDownloadError(message, response.status);
  }
  if (!contentType.includes(FILE_MARKER[opts.format])) {
    throw new CoverageDownloadError(
      "The server sent something other than a file. Please reload the page and try again.",
      response.status,
    );
  }
  const blob = await response.blob();
  const filename =
    dispositionFilename(response.headers.get("content-disposition")) ?? coverageFilename(opts.format, type);
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  // attached first: Firefox ignores .click() on a detached anchor
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(objectUrl);
  return filename;
}
