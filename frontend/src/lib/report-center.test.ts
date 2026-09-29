import { describe, expect, it } from "vitest";
import {
  buildQuery,
  datePresets,
  defaultValues,
  parseQuery,
  periodLabel,
  shiftPeriod,
  validateFilters,
  type ReportFilter,
} from "./report-center";

const f = (over: Partial<ReportFilter> & Pick<ReportFilter, "key" | "kind" | "label">): ReportFilter => ({
  required: false,
  multi: false,
  default: null,
  ...over,
});

const FILTERS: ReportFilter[] = [
  f({ key: "period", kind: "period", label: "Month", required: true, default: "2026-09" }),
  f({
    key: "dateRange",
    kind: "dateRange",
    label: "Date range",
    required: true,
    maxDays: 31,
    default: { dateFrom: "2026-09-01", dateTo: "2026-09-10" },
  }),
  f({ key: "department", kind: "department", label: "Department", multi: true, default: [] }),
  f({ key: "employee", kind: "employee", label: "Employee", multi: true, default: [] }),
  f({ key: "employmentType", kind: "employmentType", label: "Type" }),
  f({ key: "employeeStatus", kind: "employeeStatus", label: "Status", default: "active" }),
  f({ key: "mode", kind: "select", label: "Mode", default: "a" }),
  f({ key: "multi", kind: "select", label: "Multi", multi: true }),
  f({ key: "flag", kind: "boolean", label: "Flag", default: false }),
  f({ key: "min", kind: "number", label: "Min", default: 3 }),
  f({ key: "q", kind: "text", label: "Search" }),
  f({ key: "year", kind: "year", label: "Year", default: 2026 }),
];

describe("defaultValues", () => {
  it("uses each filter's default and empty lists for id filters", () => {
    const d = defaultValues(FILTERS);
    expect(d.period).toBe("2026-09");
    expect(d.department).toEqual([]);
    expect(d.employeeStatus).toBe("active");
    expect(d.flag).toBe(false);
    expect(d.q).toBe("");
  });
});

describe("buildQuery", () => {
  it("serialises with the backend's parameter names and omits empty values", () => {
    const values = {
      ...defaultValues(FILTERS),
      department: ["1", "2"],
      employee: ["7"],
      employmentType: "staff",
      multi: ["x", "y"],
      flag: true,
      q: "priya",
    };
    const q = buildQuery(FILTERS, values);
    expect(q.get("period")).toBe("2026-09");
    expect(q.get("dateFrom")).toBe("2026-09-01");
    expect(q.get("dateTo")).toBe("2026-09-10");
    expect(q.get("departmentIds")).toBe("1,2");
    expect(q.get("employeeIds")).toBe("7");
    expect(q.get("employmentType")).toBe("staff");
    expect(q.get("employeeStatus")).toBe("active");
    expect(q.get("mode")).toBe("a");
    expect(q.get("multi")).toBe("x,y");
    expect(q.get("flag")).toBe("true");
    expect(q.get("min")).toBe("3");
    expect(q.get("q")).toBe("priya");
    expect(q.get("year")).toBe("2026");
  });
  it("omits unset filters", () => {
    const q = buildQuery(FILTERS, defaultValues(FILTERS));
    expect(q.has("departmentIds")).toBe(false);
    expect(q.has("employmentType")).toBe(false);
    expect(q.has("flag")).toBe(false);
    expect(q.has("q")).toBe(false);
  });
});

describe("parseQuery", () => {
  it("round-trips buildQuery", () => {
    const values = {
      ...defaultValues(FILTERS),
      department: ["3"],
      multi: ["y"],
      flag: true,
      q: "x",
      employmentType: "production",
    };
    const back = parseQuery(FILTERS, buildQuery(FILTERS, values));
    expect(back.department).toEqual(["3"]);
    expect(back.multi).toEqual(["y"]);
    expect(back.flag).toBe(true);
    expect(back.q).toBe("x");
    expect(back.employmentType).toBe("production");
    expect(back.dateRange).toEqual({ dateFrom: "2026-09-01", dateTo: "2026-09-10" });
    expect(back.year).toBe(2026);
  });
  it("falls back to defaults for absent parameters", () => {
    const back = parseQuery(FILTERS, new URLSearchParams("departmentIds=5"));
    expect(back.period).toBe("2026-09");
    expect(back.department).toEqual(["5"]);
    expect(back.employeeStatus).toBe("active");
  });
  it("keeps the default end of a half-specified range", () => {
    const back = parseQuery(FILTERS, new URLSearchParams("dateFrom=2026-09-05"));
    expect(back.dateRange).toEqual({ dateFrom: "2026-09-05", dateTo: "2026-09-10" });
  });
});

describe("validateFilters", () => {
  const ok = defaultValues(FILTERS);
  it("accepts the defaults", () => {
    expect(validateFilters(FILTERS, ok)).toBeNull();
  });
  it("rejects reversed and too-wide ranges", () => {
    expect(validateFilters(FILTERS, { ...ok, dateRange: { dateFrom: "2026-09-10", dateTo: "2026-09-01" } })).toMatch(
      /after/,
    );
    expect(validateFilters(FILTERS, { ...ok, dateRange: { dateFrom: "2026-01-01", dateTo: "2026-06-30" } })).toMatch(
      /at most 31/,
    );
  });
  it("requires required filters", () => {
    expect(validateFilters(FILTERS, { ...ok, period: "" })).toMatch(/Month is required/);
    expect(validateFilters(FILTERS, { ...ok, dateRange: { dateFrom: "", dateTo: "" } })).toMatch(/both/);
  });
});

describe("date presets", () => {
  const today = new Date(2026, 8, 29); // 29 Sep 2026, a Tuesday
  const byId = Object.fromEntries(datePresets(today).map((p) => [p.id, p.range]));
  it("computes the common ranges", () => {
    expect(byId.today).toEqual({ dateFrom: "2026-09-29", dateTo: "2026-09-29" });
    expect(byId.yesterday).toEqual({ dateFrom: "2026-09-28", dateTo: "2026-09-28" });
    expect(byId.week).toEqual({ dateFrom: "2026-09-28", dateTo: "2026-09-29" });
    expect(byId.last7).toEqual({ dateFrom: "2026-09-23", dateTo: "2026-09-29" });
    expect(byId.month).toEqual({ dateFrom: "2026-09-01", dateTo: "2026-09-29" });
    expect(byId.lastMonth).toEqual({ dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    expect(byId.quarter).toEqual({ dateFrom: "2026-07-01", dateTo: "2026-09-29" });
    expect(byId.fy).toEqual({ dateFrom: "2026-04-01", dateTo: "2026-09-29" });
  });
  it("starts the financial year in the previous calendar year before April", () => {
    const early = Object.fromEntries(datePresets(new Date(2026, 1, 10)).map((p) => [p.id, p.range]));
    expect(early.fy).toEqual({ dateFrom: "2025-04-01", dateTo: "2026-02-10" });
  });
  it("handles a Sunday as the end of the week", () => {
    const sun = Object.fromEntries(datePresets(new Date(2026, 8, 27)).map((p) => [p.id, p.range]));
    expect(sun.week).toEqual({ dateFrom: "2026-09-21", dateTo: "2026-09-27" });
  });
});

describe("period helpers", () => {
  it("shifts across year boundaries", () => {
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
    expect(shiftPeriod("2026-12", 1)).toBe("2027-01");
    expect(shiftPeriod("junk", 1)).toBe("junk");
  });
  it("labels a period", () => {
    expect(periodLabel("2026-09")).toBe("September 2026");
  });
});
