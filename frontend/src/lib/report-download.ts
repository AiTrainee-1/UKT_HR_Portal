// Authenticated PDF / Excel download for the Report Center.
//
// A plain <a href> cannot send the bearer token, so the file is fetched, checked, and saved from a blob.
// Two production traps are handled here: Vercel's SPA rewrite answers a wrong API base with index.html and
// HTTP 200 (so the content type is verified), and Content-Disposition is not readable cross-origin unless
// the server exposes it (so a client-built filename is always the fallback).

import { getApiOrigin } from "@/lib/api-client/custom-fetch";
import { downloadBlob } from "@/lib/exportUtils";

export type ReportFileFormat = "xlsx" | "pdf";

const MIME_MARKER: Record<ReportFileFormat, string> = { xlsx: "spreadsheetml", pdf: "application/pdf" };

export class ReportDownloadError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status = 0, code: string | null = null) {
    super(message);
    this.name = "ReportDownloadError";
    this.status = status;
    this.code = code;
  }
}

/** Row ceilings per output, as the catalog sends them (lib/report-center.ts ExportLimits). */
type Limits = { screen: number; xlsx: number; pdf: number };

/**
 * Why a file cannot be made from the rows on screen, in plain words, or null when it can (or when the limits are not
 * known, in which case the server has the last word). `dataRows` excludes subtotal and total lines; `truncated` means
 * the screen itself was cut at its own ceiling, so the real count is only known to be above it.
 */
export function exportBlockReason(
  format: ReportFileFormat,
  dataRows: number,
  truncated: boolean,
  limits: Limits | undefined,
): string | null {
  if (!limits) return null;
  const max = format === "pdf" ? limits.pdf : limits.xlsx;
  const over = dataRows > max || (truncated && limits.screen >= max);
  if (!over) return null;
  const n = max.toLocaleString("en-IN");
  if (format === "pdf") {
    return limits.xlsx > max
      ? `Too many rows for one PDF (it holds up to ${n}). Download Excel instead, or narrow the filters.`
      : `Too many rows for one PDF (it holds up to ${n}). Narrow the filters (dates, department, employees).`;
  }
  return `Too many rows for one Excel file (it holds up to ${n}). Narrow the filters (dates, department, employees).`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "Salary Register" -> "salary_register_20260929_1345.xlsx" (local time; the app runs in a single timezone). */
export function exportFilename(title: string, ext: ReportFileFormat, now: Date = new Date()): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "report";
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${slug}_${stamp}.${ext}`;
}

/** Reads `filename="x"` / `filename*=UTF-8''x` from a Content-Disposition header (null if absent). */
export function filenameFromDisposition(header: string | null): string | null {
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

function readToken(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem("uk_textile_token") : null;
  } catch {
    return null;
  }
}

export interface DownloadReportOptions {
  reportId: string;
  title: string;
  format: ReportFileFormat;
  /** Filter query string (applied filters only, without `fmt`). */
  query: URLSearchParams;
  signal?: AbortSignal;
}

/** Downloads a report as PDF/Excel. Resolves with the saved filename; rejects with ReportDownloadError. */
export async function downloadReportFile(opts: DownloadReportOptions): Promise<string> {
  const params = new URLSearchParams(opts.query);
  params.set("fmt", opts.format);
  const token = readToken();
  let response: Response;
  try {
    response = await fetch(
      `${getApiOrigin()}/api/reports/export/${encodeURIComponent(opts.reportId)}?${params.toString()}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: opts.signal,
      },
    );
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ReportDownloadError("Could not reach the server. Check your connection and try again.");
  }

  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.ok) {
    let message = `The ${opts.format === "pdf" ? "PDF" : "Excel"} file could not be created (HTTP ${response.status}).`;
    let code: string | null = null;
    if (type.includes("json")) {
      try {
        const body = (await response.json()) as { message?: string; error?: string };
        message = body.message || body.error || message;
        code = body.error ?? null;
      } catch {
        /* keep the generic message */
      }
    }
    throw new ReportDownloadError(message, response.status, code);
  }
  if (!type.includes(MIME_MARKER[opts.format])) {
    throw new ReportDownloadError(
      "The server sent something other than a file. Please reload the page and try again.",
      response.status,
    );
  }

  const blob = await response.blob();
  const filename =
    filenameFromDisposition(response.headers.get("content-disposition")) ?? exportFilename(opts.title, opts.format);
  downloadBlob(blob, filename);
  return filename;
}
