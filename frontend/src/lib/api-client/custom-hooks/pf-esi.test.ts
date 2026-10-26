import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoverageDownloadError,
  PF_ESI_COVERAGE_KEY,
  TDS_EMPLOYEES_KEY,
  coverageFilename,
  dispositionFilename,
  downloadCoverageFile,
  getPfEsiCoverageQueryKey,
  getTdsEmployeesQueryKey,
  invalidateCoEmpQueries,
} from "./pf-esi";

// The Co Emp / TDS plumbing: the file name of a download, the download itself (what it asks for, what it refuses to save) and
// the refresh that keeps the employee lists, the TDS list and the coverage numbers in step.

describe("coverageFilename", () => {
  it("is pf_esi_coverage_<type>_<date>_<time>.<ext> in local time", () => {
    const at = new Date(2026, 9, 24, 9, 5);
    expect(coverageFilename("xlsx", "all", at)).toBe("pf_esi_coverage_all_20261024_0905.xlsx");
    expect(coverageFilename("pdf", "staff", at)).toBe("pf_esi_coverage_staff_20261024_0905.pdf");
  });
});

describe("dispositionFilename", () => {
  it("reads the plain and the UTF-8 forms, and nothing from nothing", () => {
    expect(dispositionFilename('attachment; filename="coverage.xlsx"')).toBe("coverage.xlsx");
    expect(dispositionFilename("attachment; filename=coverage.pdf")).toBe("coverage.pdf");
    expect(dispositionFilename("attachment; filename*=UTF-8''PF%20ESI.pdf")).toBe("PF ESI.pdf");
    expect(dispositionFilename("inline")).toBeNull();
    expect(dispositionFilename(null)).toBeNull();
  });

  it("falls back to the plain form when the UTF-8 form is broken", () => {
    expect(dispositionFilename("attachment; filename*=UTF-8''%E0%A4%A; filename=\"x.xlsx\"")).toBe("x.xlsx");
  });
});

describe("the query keys", () => {
  it("start with the address, so one invalidation reaches every variant", () => {
    expect(getTdsEmployeesQueryKey({ type: "staff" })[0]).toBe(TDS_EMPLOYEES_KEY);
    expect(getPfEsiCoverageQueryKey({ type: "all", detail: true })[0]).toBe(PF_ESI_COVERAGE_KEY);
  });
});

describe("invalidateCoEmpQueries", () => {
  it("refreshes the employee lists, the TDS list and the coverage together, and waits for the employees", async () => {
    const client = new QueryClient();
    let employeesDone = false;
    const calls: string[] = [];
    vi.spyOn(client, "invalidateQueries").mockImplementation(((filters?: { queryKey?: readonly unknown[] }) => {
      const key = String(filters?.queryKey?.[0]);
      calls.push(key);
      if (key === "/api/employees") {
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            employeesDone = true;
            resolve();
          }, 5),
        );
      }
      return Promise.resolve();
    }) as typeof client.invalidateQueries);
    await invalidateCoEmpQueries(client);
    expect(employeesDone).toBe(true);
    expect(calls.sort()).toEqual(["/api/employees", PF_ESI_COVERAGE_KEY, TDS_EMPLOYEES_KEY].sort());
  });
});

describe("downloadCoverageFile", () => {
  const fetchMock = vi.fn();
  const click = vi.fn();
  let clickSpy: ReturnType<typeof vi.spyOn>;
  const reply = (init: {
    ok?: boolean;
    status?: number;
    type?: string;
    disposition?: string | null;
    json?: unknown;
  }) => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers({
      ...(init.type ? { "content-type": init.type } : {}),
      ...(init.disposition ? { "content-disposition": init.disposition } : {}),
    }),
    blob: () => Promise.resolve(new Blob(["file"])),
    json: () => Promise.resolve(init.json),
  });
  const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(click);
    localStorage.setItem("uk_textile_token", "tok-1");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clickSpy.mockRestore();
    localStorage.clear();
    fetchMock.mockReset();
    click.mockReset();
  });

  it("asks for the file with the bearer token, saves it under the server's name and says what it was", async () => {
    fetchMock.mockResolvedValue(reply({ type: XLSX, disposition: 'attachment; filename="coverage_all.xlsx"' }));
    const name = await downloadCoverageFile({ format: "xlsx", type: "all", branchId: 3 });
    expect(name).toBe("coverage_all.xlsx");
    expect(fetchMock).toHaveBeenCalledWith("/api/pf-esi/coverage/export?format=xlsx&type=all&branchId=3", {
      headers: { Authorization: "Bearer tok-1" },
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });

  it("names the file itself when the server does not, and asks for both classes by default", async () => {
    fetchMock.mockResolvedValue(reply({ type: "application/pdf" }));
    const name = await downloadCoverageFile({ format: "pdf" });
    expect(name).toMatch(/^pf_esi_coverage_all_\d{8}_\d{4}\.pdf$/);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/pf-esi/coverage/export?format=pdf&type=all");
  });

  it("shows the server's message when it refuses", async () => {
    fetchMock.mockResolvedValue(
      reply({
        ok: false,
        status: 403,
        type: "application/json",
        json: { error: "permission_denied", message: "No access." },
      }),
    );
    await expect(downloadCoverageFile({ format: "xlsx" })).rejects.toMatchObject({
      name: "CoverageDownloadError",
      message: "No access.",
      status: 403,
    });
    expect(click).not.toHaveBeenCalled();
  });

  it("uses a plain message when the refusal has no readable body", async () => {
    fetchMock.mockResolvedValue(reply({ ok: false, status: 500, type: "text/html" }));
    await expect(downloadCoverageFile({ format: "pdf" })).rejects.toThrow(
      "The PDF file could not be created (HTTP 500).",
    );
    fetchMock.mockResolvedValue(reply({ ok: false, status: 500, type: "application/json" }));
    await expect(downloadCoverageFile({ format: "xlsx" })).rejects.toThrow(
      "The Excel file could not be created (HTTP 500).",
    );
  });

  it("refuses to save something that is not the file (a wrong API base answers index.html with 200)", async () => {
    fetchMock.mockResolvedValue(reply({ type: "text/html" }));
    await expect(downloadCoverageFile({ format: "xlsx" })).rejects.toThrow(
      "The server sent something other than a file",
    );
    expect(click).not.toHaveBeenCalled();
  });

  it("says so when the server cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const error = await downloadCoverageFile({ format: "pdf" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoverageDownloadError);
    expect((error as Error).message).toBe("Could not reach the server. Check your connection and try again.");
  });

  it("sends no token header when there is no token", async () => {
    localStorage.clear();
    fetchMock.mockResolvedValue(reply({ type: "application/pdf" }));
    await downloadCoverageFile({ format: "pdf", type: "staff" });
    expect(fetchMock.mock.calls[0][1]).toEqual({ headers: {} });
  });
});
