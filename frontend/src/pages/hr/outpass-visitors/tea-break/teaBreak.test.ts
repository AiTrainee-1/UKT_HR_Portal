import { describe, expect, it } from "vitest";
import type { TeaBreakAdminRecord } from "@/lib/api-client/custom-hooks";
import { liveMinutes, liveStatus, nextSort, readSort, statusOf, teaExportQuery, teaQuery, teaView } from "./teaBreak";

const params = new URLSearchParams(
  "departmentId=4&status=overtime&q=ravi&view=employees&sort=-avg&from=2026-11-01&to=2026-11-18&page=3&pageSize=50",
);

const open = (outAt: string, taken: number, status: TeaBreakAdminRecord["status"] = "on_break") =>
  ({ outAt, inAt: null, takenMinutes: taken, remark: "in_progress", status }) as TeaBreakAdminRecord;

describe("what each request is sent", () => {
  it("the breaks list: the filters and the page, never the view or the order", () => {
    expect(Object.fromEntries(new URLSearchParams(teaQuery(params, "breaks")))).toEqual({
      departmentId: "4",
      status: "overtime",
      q: "ravi",
      from: "2026-11-01",
      to: "2026-11-18",
      page: "3",
      pageSize: "50",
    });
  });

  it("the employees list keeps its order", () => {
    const q = new URLSearchParams(teaQuery(params, "employees"));
    expect(q.get("sort")).toBe("-avg");
    expect(q.get("view")).toBeNull();
    expect(q.get("page")).toBe("3");
  });

  it("the tiles: no status and no paging (they are the period's overview)", () => {
    expect(Object.fromEntries(new URLSearchParams(teaQuery(params, "summary")))).toEqual({
      departmentId: "4",
      q: "ravi",
      from: "2026-11-01",
      to: "2026-11-18",
    });
  });

  it("an export: every filter, the view, and the order only for the employees file", () => {
    const employees = teaExportQuery(params, "employees");
    expect(employees.get("view")).toBe("employees");
    expect(employees.get("sort")).toBe("-avg");
    expect(employees.get("status")).toBe("overtime");
    expect(employees.get("page")).toBeNull();
    const breaks = teaExportQuery(params, "breaks");
    expect(breaks.get("view")).toBe("breaks");
    expect(breaks.get("sort")).toBeNull();
    expect(breaks.get("pageSize")).toBeNull();
  });

  it("an unknown view is the breaks", () => {
    expect(teaView("employees")).toBe("employees");
    expect(teaView("whatever")).toBe("breaks");
    expect(teaView(undefined)).toBe("breaks");
  });
});

describe("an open break's minutes keep running", () => {
  const now = new Date("2026-11-18T10:00:00Z"); // 15:30 India

  it("counts up to now, never below what the server said", () => {
    expect(liveMinutes(open("2026-11-18T09:45:00Z", 14), now)).toBe(15);
    expect(liveMinutes(open("2026-11-18T09:45:00Z", 20), now)).toBe(20);
    expect(liveMinutes({ outAt: "2026-11-18T09:00:00Z", inAt: "2026-11-18T09:12:00Z", takenMinutes: 12 }, now)).toBe(
      12,
    );
  });

  it("turns into not returned once it passes the hour", () => {
    expect(liveStatus(open("2026-11-18T09:00:00Z", 59), now)).toBe("on_break"); // 60 min: not yet
    expect(liveStatus(open("2026-11-18T08:59:00Z", 59), now)).toBe("not_returned");
    expect(liveStatus(open("2026-11-18T07:00:00Z", 180, "not_returned"), now)).toBe("not_returned");
  });

  it("reads an old row's remark when it has no status", () => {
    expect(statusOf({ remark: "in_progress" })).toBe("on_break");
    expect(statusOf({ remark: "overtime" })).toBe("overtime");
    expect(statusOf({ remark: "on_time", status: "on_time" })).toBe("on_time");
  });
});

describe("the employees table's order", () => {
  it("reads the address", () => {
    expect(readSort("")).toEqual({ key: "breaks", desc: true });
    expect(readSort("-total")).toEqual({ key: "total", desc: true });
    expect(readSort("name")).toEqual({ key: "name", desc: false });
  });

  it("a new column starts high to low (names A to Z), the same column flips", () => {
    expect(nextSort("", "total")).toBe("-total");
    expect(nextSort("-total", "total")).toBe("total");
    expect(nextSort("total", "total")).toBe("-total");
    expect(nextSort("-total", "name")).toBe("name");
    expect(nextSort("", "breaks")).toBe("breaks");
  });
});
