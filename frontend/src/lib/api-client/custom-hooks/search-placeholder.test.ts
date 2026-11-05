import { describe, expect, it } from "vitest";
import { getListAuditLogsQueryKey } from "./accounts";
import { getAttendanceSheetQueryKey, getReportLogDailyQueryKey } from "./attendance";
import { keepPreviousWhileSearching } from "./shared";

const rows = ["the rows of the last search"];

describe("keepPreviousWhileSearching", () => {
  it("keeps the last rows on screen while only the search changed", () => {
    const next = keepPreviousWhileSearching(getReportLogDailyQueryKey({ date: "2026-11-05", search: "ash" }));
    const before = { queryKey: getReportLogDailyQueryKey({ date: "2026-11-05", search: "as" }) };
    expect(next(rows, before)).toBe(rows);
    // a search typed into an empty box, or emptied, is a change of the search alone too
    const cleared = keepPreviousWhileSearching(getReportLogDailyQueryKey({ date: "2026-11-05", search: undefined }));
    expect(cleared(rows, before)).toBe(rows);
  });

  it("shows the loader (no placeholder) when anything else changed", () => {
    const otherDate = keepPreviousWhileSearching(getReportLogDailyQueryKey({ date: "2026-11-06", search: "ash" }));
    expect(otherDate(rows, { queryKey: getReportLogDailyQueryKey({ date: "2026-11-05", search: "ash" }) })).toBe(
      undefined,
    );
    const otherDepartment = keepPreviousWhileSearching(
      getAttendanceSheetQueryKey({ dateFrom: "2026-11-01", dateTo: "2026-11-30", department: 4, search: "a" }),
    );
    expect(
      otherDepartment(rows, {
        queryKey: getAttendanceSheetQueryKey({ dateFrom: "2026-11-01", dateTo: "2026-11-30", search: "a" }),
      }),
    ).toBe(undefined);
    expect(otherDepartment(rows, undefined)).toBe(undefined);
  });

  it("reads the search from the param it is told to", () => {
    const page1 = { userName: "ravi", page: 1 };
    const next = keepPreviousWhileSearching(getListAuditLogsQueryKey(page1), "userName");
    expect(next(rows, { queryKey: getListAuditLogsQueryKey({ userName: "rav", page: 1 }) })).toBe(rows);
    expect(next(rows, { queryKey: getListAuditLogsQueryKey({ userName: "rav", page: 3 }) })).toBe(undefined);
  });
});
