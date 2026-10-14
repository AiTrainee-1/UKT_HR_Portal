import { describe, expect, it } from "vitest";
import { appPath, byText, departmentsOf, errorDetail, paginateRows } from "./lists";

describe("appPath", () => {
  it("passes an address of this app", () => {
    expect(appPath("/hr/settings?tab=payroll#pf-rate")).toBe("/hr/settings?tab=payroll#pf-rate");
    expect(appPath("/hr/shifts")).toBe("/hr/shifts");
    expect(appPath("/")).toBe("/");
  });

  it("refuses anything else the server might send", () => {
    for (const bad of [
      "javascript:alert(1)",
      "https://example.com/hr/settings",
      "//example.com/hr/settings",
      "hr/settings",
      "",
      " /hr/settings",
      "/hr/settings\n",
      "\\\\example.com",
      null,
      undefined,
    ]) {
      expect(appPath(bad), String(bad)).toBeNull();
    }
  });
});

describe("paginateRows", () => {
  const rows = Array.from({ length: 53 }, (_, i) => i + 1);

  it("cuts a list into pages and says which rows are on each", () => {
    const first = paginateRows(rows, 1, 25);
    expect([first.page, first.totalPages, first.total, first.from, first.to]).toEqual([1, 3, 53, 1, 25]);
    expect(first.rows).toEqual(rows.slice(0, 25));
    const last = paginateRows(rows, 3, 25);
    expect([last.page, last.from, last.to, last.rows.length]).toEqual([3, 51, 53, 3]);
  });

  it("keeps the page inside the list", () => {
    expect(paginateRows(rows, 99, 25).page).toBe(3);
    expect(paginateRows(rows, 0, 25).page).toBe(1);
    expect(paginateRows(rows, -4, 25).page).toBe(1);
    expect(paginateRows(rows, Number.NaN, 25).page).toBe(1);
    expect(paginateRows(rows, 2.9, 25).page).toBe(2);
  });

  it("an exact multiple has no extra page, and a short or empty list is one page", () => {
    expect(paginateRows(rows.slice(0, 50), 1, 25).totalPages).toBe(2);
    const short = paginateRows([1, 2, 3], 1, 25);
    expect([short.totalPages, short.from, short.to]).toEqual([1, 1, 3]);
    const none = paginateRows([], 1, 25);
    expect([none.page, none.totalPages, none.total, none.from, none.to, none.rows]).toEqual([1, 1, 0, 0, 0, []]);
  });
});

describe("departmentsOf", () => {
  it("lists the departments once, sorted, and says whether some have none", () => {
    const items = [
      { department: "Weaving" },
      { department: "Cutting" },
      { department: "Weaving" },
      { department: null },
    ];
    expect(departmentsOf(items)).toEqual({ names: ["Cutting", "Weaving"], hasNone: true });
    expect(departmentsOf(items.slice(0, 3))).toEqual({ names: ["Cutting", "Weaving"], hasNone: false });
    expect(departmentsOf([])).toEqual({ names: [], hasNone: false });
    expect(departmentsOf([{ department: "" }])).toEqual({ names: [], hasNone: true });
  });
});

describe("byText", () => {
  it("orders text naturally and without regard to case", () => {
    expect(["Unit 10", "unit 2", "Unit 1"].sort(byText)).toEqual(["Unit 1", "unit 2", "Unit 10"]);
    expect(byText("abc", "ABC")).toBe(0);
  });
});

describe("errorDetail", () => {
  it("is the server's own words when it gave any", () => {
    expect(errorDetail(new Error("HTTP 400 Bad Request: month and year are required"))).toBe(
      "month and year are required",
    );
    expect(errorDetail(new Error("HTTP 500 Internal Server Error: boom"))).toBe("boom");
    expect(errorDetail(new Error("HTTP 500: boom"))).toBe("boom");
    expect(errorDetail(new Error("HTTP 404 Not Found: No such cycle: weekly"))).toBe("No such cycle: weekly");
    expect(errorDetail(new Error("HTTP 400 Bad Request: line one\nline two"))).toBe("line one\nline two");
  });

  it("says in a sentence that a permission error is one", () => {
    expect(errorDetail(new Error("HTTP 403 Forbidden"))).toBe("You do not have permission to view this.");
    expect(errorDetail(new Error("HTTP 403"))).toBe("You do not have permission to view this.");
  });

  it("gives the status when the server said nothing else", () => {
    expect(errorDetail(new Error("HTTP 502 Bad Gateway"))).toBe("The server answered: HTTP 502 Bad Gateway.");
  });

  it("has nothing to add for a network failure, something that is not an error, or no message", () => {
    expect(errorDetail(new TypeError("Failed to fetch"))).toBeUndefined();
    expect(errorDetail(new Error(""))).toBeUndefined();
    expect(errorDetail("HTTP 500: boom")).toBeUndefined();
    expect(errorDetail(null)).toBeUndefined();
    expect(errorDetail(undefined)).toBeUndefined();
    expect(errorDetail({ message: "HTTP 500: boom" })).toBeUndefined();
  });
});
