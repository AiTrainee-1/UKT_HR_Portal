import { describe, expect, it } from "vitest";
import { checkPercent, matchesWords, pageOf, projectSalary, sortBy, compareText } from "./common";
import { formatDate, inRange, monthsBetween, monthsLabel, parseYmd, periodRange, tenureLabel, todayYmd } from "./dates";

describe("dates", () => {
  it("todayYmd uses the local calendar day, not the UTC one", () => {
    // 00:30 on 5 March in the machine's own zone is still the 5th, whatever UTC says
    expect(todayYmd(new Date(2026, 2, 5, 0, 30))).toBe("2026-03-05");
    expect(todayYmd(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });

  it("parseYmd reads a day or an ISO timestamp and refuses days that do not exist", () => {
    expect(parseYmd("2026-03-01")).toEqual({ y: 2026, m: 3, d: 1 });
    expect(parseYmd("2026-03-01T10:00:00Z")).toEqual({ y: 2026, m: 3, d: 1 });
    expect(parseYmd("2026-02-30")).toBeNull();
    expect(parseYmd("01/03/2026")).toBeNull();
    expect(parseYmd(null)).toBeNull();
  });

  it("monthsBetween counts whole months and only counts a month once its day has come", () => {
    expect(monthsBetween("2025-01-15", "2026-01-15")).toBe(12);
    expect(monthsBetween("2025-01-15", "2026-01-14")).toBe(11);
    expect(monthsBetween("2025-01-31", "2025-02-28")).toBe(0);
    expect(monthsBetween("2026-05-01", "2026-03-01")).toBe(-2);
    expect(monthsBetween("junk", "2026-03-01")).toBeNull();
  });

  it("formats dates and spans of time for people", () => {
    expect(formatDate("2026-03-01")).toBe("1 Mar 2026");
    expect(formatDate("nonsense")).toBe("-");
    expect(tenureLabel(0)).toBe("under a month");
    expect(tenureLabel(1)).toBe("1 month");
    expect(tenureLabel(5)).toBe("5 months");
    expect(tenureLabel(14)).toBe("1 yr 2 mo");
    expect(tenureLabel(24)).toBe("2 yrs");
    expect(monthsLabel(12)).toBe("1 year");
    expect(monthsLabel(24)).toBe("2 years");
    expect(monthsLabel(18)).toBe("18 months");
  });

  it("periodRange works out the first and last day of each period", () => {
    expect(periodRange("this_month", "2026-03-15")).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(periodRange("last_3_months", "2026-03-15")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(periodRange("last_3_months", "2026-01-20")).toEqual({ from: "2025-11-01", to: "2026-01-31" });
    expect(periodRange("this_year", "2026-03-15")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(periodRange("last_year", "2026-03-15")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(periodRange("all", "2026-03-15")).toEqual({ from: null, to: null });
    expect(periodRange("custom", "2026-03-15", { from: "2026-02-01", to: "" })).toEqual({
      from: "2026-02-01",
      to: null,
    });
  });

  it("inRange includes both ends and leaves a missing side open", () => {
    const r = { from: "2026-01-01", to: "2026-01-31" };
    expect(inRange("2026-01-01", r)).toBe(true);
    expect(inRange("2026-01-31", r)).toBe(true);
    expect(inRange("2026-02-01", r)).toBe(false);
    expect(inRange("2025-12-31", r)).toBe(false);
    expect(inRange("2030-01-01", { from: "2026-01-01", to: null })).toBe(true);
    expect(inRange("garbage", r)).toBe(false);
    expect(inRange("garbage", { from: null, to: null })).toBe(true);
  });
});

describe("search and paging", () => {
  it("matchesWords needs every word, in any field, in any case", () => {
    expect(matchesWords("asha sup", "Asha Kumar", "Supervisor")).toBe(true);
    expect(matchesWords("asha mgr", "Asha Kumar", "Supervisor")).toBe(false);
    expect(matchesWords("  ", "anything")).toBe(true);
    expect(matchesWords("E2E001", null, undefined, "e2e001")).toBe(true);
  });

  it("sortBy is stable and obeys direction", () => {
    const rows = [
      { n: "b", k: 1 },
      { n: "a", k: 1 },
      { n: "c", k: 0 },
    ];
    expect(sortBy(rows, (x, y) => x.k - y.k, "asc").map((r) => r.n)).toEqual(["c", "b", "a"]);
    expect(sortBy(rows, (x, y) => x.k - y.k, "desc").map((r) => r.n)).toEqual(["b", "a", "c"]);
    expect(sortBy(["b", "A", "c"], compareText, "asc")).toEqual(["A", "b", "c"]);
  });

  it("pageOf falls back to the last page when a filter shrinks the list", () => {
    const rows = Array.from({ length: 25 }, (_, i) => i);
    expect(pageOf(rows, 1, 10).rows).toHaveLength(10);
    expect(pageOf(rows, 3, 10).rows).toEqual([20, 21, 22, 23, 24]);
    expect(pageOf(rows, 9, 10)).toMatchObject({ page: 3, totalPages: 3 });
    expect(pageOf([], 4, 10)).toMatchObject({ page: 1, totalPages: 1, rows: [] });
  });
});

describe("the increment percentage", () => {
  it("checkPercent explains what is wrong", () => {
    expect(checkPercent("")).toMatchObject({ ok: false, message: "Enter the increment percentage." });
    expect(checkPercent("abc")).toMatchObject({ ok: false });
    expect(checkPercent("-5")).toMatchObject({ ok: false });
    expect(checkPercent("0")).toMatchObject({ ok: false, message: "The percentage must be more than 0." });
    expect(checkPercent("501")).toMatchObject({ ok: false });
    expect(checkPercent("1.23456")).toMatchObject({ ok: false, message: "Use at most 4 decimal places." });
    expect(checkPercent("7.5")).toEqual({ ok: true, value: 7.5 });
    expect(checkPercent(" 500 ")).toEqual({ ok: true, value: 500 });
    expect(checkPercent(".5")).toEqual({ ok: true, value: 0.5 });
    expect(checkPercent("1e3")).toMatchObject({ ok: false });
  });

  it("projectSalary matches the server: whole paise, ties to even", () => {
    // the Ravi example from the backend tests: 30,000 + 10% = 33,000
    expect(projectSalary(30000, "10")).toEqual({ newSalary: 33000, increase: 3000 });
    expect(projectSalary(20000, "5")).toEqual({ newSalary: 21000, increase: 1000 });
    // 12345.67 x 1.075 = 13271.59525: rounds to 13271.60
    expect(projectSalary(12345.67, "7.5")).toEqual({ newSalary: 13271.6, increase: 925.93 });
    // 100.05 x 1.1 = 110.055 exactly, a tie: the even neighbour is 110.06
    expect(projectSalary(100.05, "10")?.newSalary).toBe(110.06);
    // 100.15 x 1.1 = 110.165 exactly, a tie: the even neighbour is 110.16
    expect(projectSalary(100.15, "10")?.newSalary).toBe(110.16);
    // float arithmetic would give 1.0000000000000002 style noise; paise do not
    expect(projectSalary(24000, "0.1")).toEqual({ newSalary: 24024, increase: 24 });
  });

  it("projectSalary gives nothing for an invalid percentage or salary", () => {
    expect(projectSalary(20000, "")).toBeNull();
    expect(projectSalary(20000, "0")).toBeNull();
    expect(projectSalary(20000, "x")).toBeNull();
    expect(projectSalary(Number.NaN, "5")).toBeNull();
  });
});
