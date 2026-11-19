// The Excel / PDF files of Gate Pass, Visitors and Tea Break (and of the gate monitor): the server builds each file
// (backend gate_exports.py, the Report Center's look); this fetches it with a bearer token, checks it really is a file and
// saves it. A plain <a href> cannot send the token, so the file comes as a blob, like lib/report-download.ts.

import { getApiOrigin } from "@/lib/api-client/custom-fetch";
import { downloadBlob } from "@/lib/exportUtils";
import { exportFilename, filenameFromDisposition, type ReportFileFormat } from "@/lib/report-download";

export type GateFileFormat = ReportFileFormat;

/** What the server says (413 too_many_rows) when a file would be too long; also the fallback when it says nothing. */
export const TOO_MANY_ROWS_MESSAGE = "Too many rows for one file. Narrow the dates.";

const MIME_MARKER: Record<GateFileFormat, string> = { xlsx: "spreadsheetml", pdf: "application/pdf" };
const FORMAT_NAME: Record<GateFileFormat, string> = { xlsx: "Excel", pdf: "PDF" };

export class GateDownloadError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The row limit the server named (413 too_many_rows), else null. */
  readonly limit: number | null;
  constructor(message: string, status = 0, code: string | null = null, limit: number | null = null) {
    super(message);
    this.name = "GateDownloadError";
    this.status = status;
    this.code = code;
    this.limit = limit;
  }
}

/** The HR sign-in: what every HR page sends. */
export function hrToken(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem("uk_textile_token") : null;
  } catch {
    return null;
  }
}

export type GateFileQuery = URLSearchParams | Record<string, string | number | boolean | null | undefined>;

export interface DownloadGateFileOptions {
  /** The export's address: "/api/gate-devices/records/export" (a path without "/api/" gets it). */
  path: string;
  /** The page's filters. Empty values, `page` and `pageSize` are left out: a file holds every matching row. */
  query?: GateFileQuery;
  format: GateFileFormat;
  /** Names the saved file when the server's name cannot be read: "Gate records" -> gate_records_20261118_0834.xlsx. */
  title: string;
  signal?: AbortSignal;
  /**
   * The bearer token to send. Default: the HR sign-in. The gate monitor passes its own gate token here and must never
   * send the HR one (a missing gate token sends no header at all).
   */
  token?: () => string | null;
}

/** The query string a file is asked for with: the filters that have a value, then `fmt`. */
export function exportParams(query: GateFileQuery | undefined, format: GateFileFormat): URLSearchParams {
  const out = new URLSearchParams();
  const entries: [string, unknown][] =
    query instanceof URLSearchParams ? [...query.entries()] : Object.entries(query ?? {});
  for (const [key, value] of entries) {
    if (key === "page" || key === "pageSize" || key === "fmt") continue;
    if (value === null || value === undefined || value === "" || value === false) continue;
    out.append(key, String(value));
  }
  out.set("fmt", format);
  return out;
}

async function readError(response: Response, format: GateFileFormat): Promise<GateDownloadError> {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  let body: { message?: string; error?: string; limit?: number } = {};
  if (type.includes("json")) {
    try {
      body = (await response.json()) as typeof body;
    } catch {
      /* keep the generic message */
    }
  }
  const code = typeof body.error === "string" ? body.error : null;
  const limit = typeof body.limit === "number" ? body.limit : null;
  if (response.status === 413 || code === "too_many_rows") {
    const base = body.message || TOO_MANY_ROWS_MESSAGE;
    const message = limit ? `${base} One file holds up to ${limit.toLocaleString("en-IN")} rows.` : base;
    return new GateDownloadError(message, response.status, code ?? "too_many_rows", limit);
  }
  if (response.status === 401) {
    return new GateDownloadError(
      body.message || "Your sign-in has ended. Sign in again, then download the file.",
      401,
      code,
    );
  }
  if (response.status === 403) {
    return new GateDownloadError(
      body.message || "Your role cannot download this file. Ask an administrator for access.",
      403,
      code,
    );
  }
  const fallback = `The ${FORMAT_NAME[format]} file could not be made (error ${response.status}). Try again in a minute.`;
  return new GateDownloadError(body.message || body.error || fallback, response.status, code);
}

/** Downloads one Excel / PDF file. Resolves with the saved file's name; rejects with GateDownloadError (or an AbortError). */
export async function downloadGateFile(opts: DownloadGateFileOptions): Promise<string> {
  const path = opts.path.startsWith("/api/") ? opts.path : `/api/${opts.path.replace(/^\/+/, "")}`;
  const params = exportParams(opts.query, opts.format);
  const token = (opts.token ?? hrToken)();
  let response: Response;
  try {
    response = await fetch(`${getApiOrigin()}${path}?${params.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new GateDownloadError("Could not reach the server. Check the connection and try again.");
  }

  if (!response.ok) throw await readError(response, opts.format);
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes(MIME_MARKER[opts.format])) {
    throw new GateDownloadError(
      "The server sent something other than a file. Reload the page and try again.",
      response.status,
    );
  }
  const blob = await response.blob();
  const filename =
    filenameFromDisposition(response.headers.get("content-disposition")) ?? exportFilename(opts.title, opts.format);
  downloadBlob(blob, filename);
  return filename;
}
