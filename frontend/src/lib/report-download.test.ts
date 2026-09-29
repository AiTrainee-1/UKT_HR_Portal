import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved: { name: string; size: number }[] = [];
vi.mock("@/lib/exportUtils", () => ({
  downloadBlob: (blob: Blob, name: string) => saved.push({ name, size: blob.size }),
}));

import { downloadReportFile, exportFilename, filenameFromDisposition, ReportDownloadError } from "./report-download";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function respond(body: BodyInit | null, init: { status?: number; headers?: Record<string, string> } = {}) {
  return Promise.resolve(new Response(body, { status: init.status ?? 200, headers: init.headers }));
}

describe("exportFilename", () => {
  it("slugifies the title and stamps local time", () => {
    const at = new Date(2026, 8, 5, 9, 7);
    expect(exportFilename("Salary Register", "xlsx", at)).toBe("salary_register_20260905_0907.xlsx");
    expect(exportFilename("PF / ESI — Statement!", "pdf", at)).toBe("pf_esi_statement_20260905_0907.pdf");
    expect(exportFilename("  ", "pdf", at)).toBe("report_20260905_0907.pdf");
  });
});

describe("filenameFromDisposition", () => {
  it("reads quoted, bare and RFC 6266 forms", () => {
    expect(filenameFromDisposition('attachment; filename="a_b.xlsx"')).toBe("a_b.xlsx");
    expect(filenameFromDisposition("attachment; filename=plain.pdf")).toBe("plain.pdf");
    expect(filenameFromDisposition("attachment; filename*=UTF-8''sal%C3%A1ry.pdf")).toBe("saláry.pdf");
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition("inline")).toBeNull();
  });
});

describe("downloadReportFile", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    saved.length = 0;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("uk_textile_token", "tok123");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const opts = {
    reportId: "salary-register",
    title: "Salary Register",
    format: "xlsx" as const,
    query: new URLSearchParams("period=2026-09"),
  };

  it("sends the bearer token and fmt, saves the blob under the server's filename", async () => {
    fetchMock.mockReturnValue(
      respond("PKdata", {
        headers: { "content-type": XLSX, "content-disposition": 'attachment; filename="server_name.xlsx"' },
      }),
    );
    const name = await downloadReportFile(opts);
    expect(name).toBe("server_name.xlsx");
    expect(saved).toEqual([{ name: "server_name.xlsx", size: 6 }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/reports/export/salary-register?");
    expect(url).toContain("period=2026-09");
    expect(url).toContain("fmt=xlsx");
    expect(init.headers.Authorization).toBe("Bearer tok123");
  });

  it("falls back to a client-built name when the header is not exposed", async () => {
    fetchMock.mockReturnValue(respond("%PDF-1.4", { headers: { "content-type": "application/pdf" } }));
    const name = await downloadReportFile({ ...opts, format: "pdf" });
    expect(name).toMatch(/^salary_register_\d{8}_\d{4}\.pdf$/);
  });

  it("turns a JSON error body into a readable error with status and code", async () => {
    fetchMock.mockReturnValue(
      respond(JSON.stringify({ error: "too_many_rows", message: "Narrow the filters." }), {
        status: 413,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(downloadReportFile(opts)).rejects.toMatchObject({
      message: "Narrow the filters.",
      status: 413,
      code: "too_many_rows",
    });
    expect(saved).toHaveLength(0);
  });

  it("uses a generic message when the error body is not JSON", async () => {
    fetchMock.mockReturnValue(respond("boom", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(downloadReportFile(opts)).rejects.toThrow(/Excel file could not be created \(HTTP 502\)/);
  });

  it("rejects an HTML page served with HTTP 200 (SPA rewrite) instead of saving it as a file", async () => {
    fetchMock.mockReturnValue(respond("<html></html>", { headers: { "content-type": "text/html" } }));
    await expect(downloadReportFile(opts)).rejects.toBeInstanceOf(ReportDownloadError);
    expect(saved).toHaveLength(0);
  });

  it("reports a network failure plainly and lets an abort through untouched", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(downloadReportFile(opts)).rejects.toThrow(/Could not reach the server/);
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await expect(downloadReportFile(opts)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("omits the Authorization header when there is no token", async () => {
    localStorage.clear();
    fetchMock.mockReturnValue(respond("PK", { headers: { "content-type": XLSX } }));
    await downloadReportFile(opts);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({});
  });
});
