import { describe, expect, it } from "vitest";
import { carryFilters, groupReports, searchGroups, sectionsByCategory, variantsOf } from "./report-catalog";
import type { ReportCategory, ReportFilter, ReportMeta } from "./report-center";

const flt = (key: string, kind: ReportFilter["kind"], def: unknown = null): ReportFilter => ({
  key,
  kind,
  label: key,
  required: false,
  multi: false,
  default: def,
});

const meta = (id: string, category: string, over: Partial<ReportMeta> = {}): ReportMeta => ({
  id,
  title: id.replace(/-/g, " "),
  description: `about ${id}`,
  category,
  icon: "FileText",
  tags: [],
  family: null,
  variant: null,
  landscape: true,
  filters: [],
  columns: [],
  dynamicColumns: false,
  exports: ["xlsx", "pdf"],
  ...over,
});

const REPORTS: ReportMeta[] = [
  meta("salary-register", "payroll", { title: "Salary Register", tags: ["wages", "payroll"] }),
  meta("late-coming-detail", "attendance", {
    title: "Late Coming Detail",
    family: "late-coming",
    variant: "Detail",
    tags: ["late"],
  }),
  meta("time-card", "attendance", { title: "Time Card", description: "Daily in and out per employee" }),
  meta("late-summary-counts", "attendance", { title: "Late Coming Summary", family: "late-coming", variant: "Counts" }),
  meta("visitor-register", "gate", { title: "Visitor Register", tags: ["visitors"] }),
];
const CATEGORIES: ReportCategory[] = [
  { id: "payroll", label: "Payroll", description: "", icon: "Wallet", count: 1 },
  { id: "attendance", label: "Attendance", description: "", icon: "CalendarCheck", count: 2 },
  { id: "leave", label: "Leave", description: "", icon: "CalendarOff", count: 0 },
  { id: "gate", label: "Gate", description: "", icon: "DoorOpen", count: 1 },
];

describe("groupReports", () => {
  it("collapses a family into one group and keeps first-seen order", () => {
    const groups = groupReports(REPORTS);
    expect(groups.map((g) => g.key)).toEqual([
      "salary-register",
      "attendance:late-coming",
      "time-card",
      "visitor-register",
    ]);
    const late = groups[1];
    expect(late.variants.map((v) => v.id)).toEqual(["late-coming-detail", "late-summary-counts"]);
    expect(late.primary.id).toBe("late-coming-detail");
  });
  it("does not merge equal family names across categories", () => {
    const groups = groupReports([
      meta("a", "payroll", { family: "x", variant: "1" }),
      meta("b", "gate", { family: "x", variant: "2" }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("sectionsByCategory", () => {
  it("follows the category order and drops empty categories", () => {
    const sections = sectionsByCategory(groupReports(REPORTS), CATEGORIES);
    expect(sections.map((s) => s.category.id)).toEqual(["payroll", "attendance", "gate"]);
    expect(sections[1].groups).toHaveLength(2);
  });
});

describe("searchGroups", () => {
  const groups = groupReports(REPORTS);
  it("returns everything for an empty query", () => {
    expect(searchGroups(groups, "  ")).toEqual(groups);
  });
  it("matches title, description, tags and variant names, all words required", () => {
    expect(searchGroups(groups, "wages").map((g) => g.key)).toEqual(["salary-register"]);
    expect(searchGroups(groups, "in and out").map((g) => g.key)).toEqual(["time-card"]);
    expect(searchGroups(groups, "counts").map((g) => g.key)).toEqual(["attendance:late-coming"]);
    expect(searchGroups(groups, "late detail").map((g) => g.key)).toEqual(["attendance:late-coming"]);
    expect(searchGroups(groups, "late payroll")).toEqual([]);
  });
  it("ranks title matches above description-only matches", () => {
    const g = groupReports([
      meta("one", "payroll", { title: "Bank advice", description: "salary transfer list" }),
      meta("two", "payroll", { title: "Salary slips", description: "printable" }),
    ]);
    expect(searchGroups(g, "salary").map((x) => x.key)).toEqual(["two", "one"]);
  });
});

describe("variantsOf", () => {
  it("lists the family members, or just the report itself", () => {
    expect(variantsOf(REPORTS, REPORTS[1]).map((r) => r.id)).toEqual(["late-coming-detail", "late-summary-counts"]);
    expect(variantsOf(REPORTS, REPORTS[0]).map((r) => r.id)).toEqual(["salary-register"]);
  });
});

describe("carryFilters", () => {
  const a = meta("a", "attendance", {
    filters: [flt("period", "period", "2026-09"), flt("department", "department", []), flt("mode", "select", "x")],
  });
  const b = meta("b", "attendance", {
    filters: [flt("period", "period", "2026-09"), flt("department", "department", []), flt("extra", "text", "")],
  });
  it("keeps values for filters present in both and defaults the rest", () => {
    const out = carryFilters(a, b, { period: "2026-07", department: ["3"], mode: "y" });
    expect(out).toEqual({ period: "2026-07", department: ["3"], extra: "" });
  });
  it("does not carry a filter whose kind changed", () => {
    const c = meta("c", "attendance", { filters: [flt("period", "year", 2026)] });
    expect(carryFilters(a, c, { period: "2026-07" }).period).toBe(2026);
  });
});
