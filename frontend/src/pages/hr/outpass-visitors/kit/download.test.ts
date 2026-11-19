import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved: { name: string; size: number }[] = [];
vi.mock("@/lib/exportUtils", () => ({
  downloadBlob: (blob: Blob, name: string) => saved.push({ name, size: blob.size }),
}));

import { downloadGateFile, exportParams, GateDownloadError, TOO_MANY_ROWS_MESSAGE } from "./download";

// The Excel / PDF download of the gate pages: the token it sends (HR's, or the gate monitor's own and never HR's), the
// query it asks with, and what a person is told when the server refuses (too many rows, signed out, no access ...).

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const json = (body: unknown, status: number) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("downloadGateFile", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    saved.length = 0;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("uk_textile_token", "hr-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const base = { path: "/api/gate-devices/records/export", title: "Gate records", format: "xlsx" as const };

  it("asks with the filters that have a value and fmt (no paging), sends the HR token, saves the server's file", async () => {
    fetchMock.mockResolvedValue(
      new Response("PK", {
        headers: {
          "content-type": XLSX,
          "content-disposition": 'attachment; filename="gate_records_20261118_0834.xlsx"',
        },
      }),
    );
    const name = await downloadGateFile({
      ...base,
      query: new URLSearchParams("gateId=3&from=2026-11-01&to=2026-11-18&q=&page=4&pageSize=25"),
    });
    expect(name).toBe("gate_records_20261118_0834.xlsx");
    expect(saved).toEqual([{ name: "gate_records_20261118_0834.xlsx", size: 2 }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/gate-devices/records/export?gateId=3&from=2026-11-01&to=2026-11-18&fmt=xlsx");
    expect(init.headers).toEqual({ Authorization: "Bearer hr-token" });
  });

  it("takes a plain object as the query and a path without /api/", async () => {
    fetchMock.mockResolvedValue(new Response("%PDF", { headers: { "content-type": "application/pdf" } }));
    await downloadGateFile({
      path: "tea-break/records/export",
      title: "Tea breaks",
      format: "pdf",
      query: { view: "employees", departmentId: 4, q: null, status: "" },
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/tea-break/records/export?view=employees&departmentId=4&fmt=pdf");
    // no name from the server: the title and the time make one
    expect(saved[0].name).toMatch(/^tea_breaks_\d{8}_\d{4}\.pdf$/);
  });

  it("sends the gate monitor's own token, and no header at all (never HR's) when it has none", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("PK", { headers: { "content-type": XLSX } })));
    await downloadGateFile({ ...base, path: "/api/gate-monitor/records/export", token: () => "gate-token" });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer gate-token" });
    await downloadGateFile({ ...base, path: "/api/gate-monitor/records/export", token: () => null });
    expect(fetchMock.mock.calls[1][1].headers).toEqual({});
  });

  it("413 too_many_rows: says to narrow the dates, with the limit", async () => {
    fetchMock.mockReturnValue(
      json({ error: "too_many_rows", message: "Too many rows for one file. Narrow the dates.", limit: 5000 }, 413),
    );
    const err = await downloadGateFile({ ...base, format: "pdf" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GateDownloadError);
    const e = err as GateDownloadError;
    expect(e.status).toBe(413);
    expect(e.code).toBe("too_many_rows");
    expect(e.limit).toBe(5000);
    expect(e.message).toBe("Too many rows for one file. Narrow the dates. One file holds up to 5,000 rows.");
    expect(saved).toEqual([]);
  });

  it("413 with no readable body still says what to do", async () => {
    fetchMock.mockResolvedValue(new Response("Request Entity Too Large", { status: 413 }));
    const e = (await downloadGateFile(base).catch((x: unknown) => x)) as GateDownloadError;
    expect(e.message).toBe(TOO_MANY_ROWS_MESSAGE);
    expect(e.code).toBe("too_many_rows");
    expect(e.limit).toBeNull();
  });

  it("explains a refusal: signed out, no access, a server error", async () => {
    fetchMock.mockReturnValueOnce(json({ error: "Invalid or expired token" }, 401));
    expect(((await downloadGateFile(base).catch((x) => x)) as Error).message).toBe(
      "Your sign-in has ended. Sign in again, then download the file.",
    );
    fetchMock.mockReturnValueOnce(json({ error: "permission_denied", message: "View access needed." }, 403));
    const denied = (await downloadGateFile(base).catch((x) => x)) as GateDownloadError;
    expect(denied.message).toBe("View access needed.");
    expect(denied.code).toBe("permission_denied");
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    expect(((await downloadGateFile(base).catch((x) => x)) as Error).message).toBe(
      "The Excel file could not be made (error 500). Try again in a minute.",
    );
  });

  it("refuses a page that is not the file (a wrong address answered with the app's index.html)", async () => {
    fetchMock.mockResolvedValue(new Response("<!doctype html>", { headers: { "content-type": "text/html" } }));
    const e = (await downloadGateFile(base).catch((x) => x)) as GateDownloadError;
    expect(e.message).toBe("The server sent something other than a file. Reload the page and try again.");
    expect(saved).toEqual([]);
  });

  it("says the server could not be reached, and lets an abort through as it is", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(((await downloadGateFile(base).catch((x) => x)) as Error).message).toBe(
      "Could not reach the server. Check the connection and try again.",
    );
    const abort = new DOMException("stop", "AbortError");
    fetchMock.mockRejectedValueOnce(abort);
    expect(await downloadGateFile(base).catch((x) => x)).toBe(abort);
  });
});

describe("exportParams", () => {
  it("keeps the values, drops empty ones, the paging and a stale fmt, and adds fmt last", () => {
    expect(exportParams(new URLSearchParams("a=1&b=&page=2&pageSize=50&fmt=pdf"), "xlsx").toString()).toBe(
      "a=1&fmt=xlsx",
    );
    expect(exportParams({ on: true, off: false, n: 0 }, "pdf").toString()).toBe("on=true&n=0&fmt=pdf");
    expect(exportParams(undefined, "pdf").toString()).toBe("fmt=pdf");
  });
});
