import { describe, expect, it } from "vitest";
import {
  buildQuery,
  datePresets,
  defaultValues,
  filterKeyForParam,
  filterParamNames,
  hasFilterParams,
  isOnByDefault,
  offersAny,
  parseQuery,
  periodLabel,
  rememberFilters,
  relativeToken,
  resolveToken,
  restoreFilters,
  shiftPeriod,
  validateFilters,
  type ReportCatalog,
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
  it("sends a cleared filter of a saved custom report empty (the server reads it as all, not the saved value)", () => {
    // a saved report: department and status saved, the user cleared both, the type and the kinds
    const saved: ReportFilter[] = [
      f({ key: "period", kind: "period", label: "Month", required: true, default: "2026-09" }),
      f({ key: "department", kind: "department", label: "Department", multi: true, default: [3], clearable: true }),
      f({ key: "employmentType", kind: "employmentType", label: "Type", default: "staff", clearable: true }),
      f({ key: "requestType", kind: "select", label: "Kind", multi: true, default: "leave", clearable: true }),
      f({ key: "requestStatus", kind: "select", label: "Status", default: "pending", clearable: true }),
    ];
    const cleared = { period: "2026-09", department: [], employmentType: "", requestType: [], requestStatus: "" };
    const q = buildQuery(saved, cleared);
    expect(q.toString()).toBe("period=2026-09&departmentIds=&employmentType=&requestType=&requestStatus=");
    // what the URL then holds reads back as the cleared values, and builds the same query again
    const back = parseQuery(saved, q);
    expect(back).toMatchObject(cleared);
    expect(buildQuery(saved, back).toString()).toBe(q.toString());
    // the saved values travel as they are
    expect(buildQuery(saved, defaultValues(saved)).toString()).toBe(
      "period=2026-09&departmentIds=3&employmentType=staff&requestType=leave&requestStatus=pending",
    );
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

describe("a tick box that is ON by default", () => {
  const ON = f({ key: "includeOffDays", kind: "boolean", label: "Include days off", default: true });
  const OFF = f({ key: "compact", kind: "boolean", label: "Compact", default: false });

  it("is sent as false when switched off (an absent box means the default to the server)", () => {
    expect(buildQuery([ON], { includeOffDays: false }).get("includeOffDays")).toBe("false");
    expect(buildQuery([ON], { includeOffDays: true }).get("includeOffDays")).toBe("true");
  });
  it("round-trips false through the URL instead of coming back ticked", () => {
    const q = buildQuery([ON, OFF], { includeOffDays: false, compact: false });
    expect(parseQuery([ON, OFF], q)).toEqual({ includeOffDays: false, compact: false });
    expect(parseQuery([ON], new URLSearchParams())).toEqual({ includeOffDays: true });
  });
  it("leaves an off-by-default box out of the URL unless ticked, as before", () => {
    expect(buildQuery([OFF], { compact: false }).has("compact")).toBe(false);
    expect(buildQuery([OFF], { compact: true }).get("compact")).toBe("true");
  });
  it("sends nothing for a value that was never set", () => {
    expect(buildQuery([ON], {}).has("includeOffDays")).toBe(false);
  });
  it("knows which boxes are on by default", () => {
    expect(isOnByDefault(ON)).toBe(true);
    expect(isOnByDefault({ ...ON, default: "true" })).toBe(true);
    expect(isOnByDefault(OFF)).toBe(false);
    expect(isOnByDefault(f({ key: "x", kind: "select", label: "X", default: true }))).toBe(false);
  });
});

describe("offersAny", () => {
  it("offers All only on an optional select with no default of its own", () => {
    expect(offersAny(f({ key: "a", kind: "select", label: "A" }))).toBe(true);
    expect(offersAny(f({ key: "a", kind: "select", label: "A", default: "" }))).toBe(true);
    expect(offersAny(f({ key: "a", kind: "select", label: "A", default: "detail" }))).toBe(false);
    expect(offersAny(f({ key: "a", kind: "select", label: "A", required: true }))).toBe(false);
    // a saved custom report's select: its default is the saved value, and "All" (sent empty) widens it
    expect(offersAny(f({ key: "a", kind: "select", label: "A", default: "pending", clearable: true }))).toBe(true);
    expect(offersAny(f({ key: "a", kind: "select", label: "A", required: true, clearable: true }))).toBe(false);
  });
});

describe("filter parameter names", () => {
  const byKey = (k: string) => FILTERS.find((x) => x.key === k)!;
  it("names what each filter travels under", () => {
    expect(filterParamNames(byKey("dateRange"))).toEqual(["dateFrom", "dateTo"]);
    expect(filterParamNames(byKey("department"))).toEqual(["departmentIds"]);
    expect(filterParamNames(byKey("employee"))).toEqual(["employeeIds"]);
    expect(filterParamNames(byKey("period"))).toEqual(["period"]);
    expect(filterParamNames(byKey("employmentType"))).toEqual(["employmentType"]);
    expect(filterParamNames(byKey("mode"))).toEqual(["mode"]);
    expect(filterParamNames(byKey("flag"))).toEqual(["flag"]);
    expect(filterParamNames(byKey("min"))).toEqual(["min"]);
    expect(filterParamNames(byKey("q"))).toEqual(["q"]);
  });
  it("tells a plain open from a link that carries filters", () => {
    expect(hasFilterParams(FILTERS, new URLSearchParams("report=x"))).toBe(false);
    expect(hasFilterParams(FILTERS, new URLSearchParams("report=x&cat=hr"))).toBe(false);
    expect(hasFilterParams(FILTERS, new URLSearchParams("report=x&dateTo=2026-09-01"))).toBe(true);
    expect(hasFilterParams(FILTERS, new URLSearchParams("report=x&departmentIds=3"))).toBe(true);
    expect(hasFilterParams(FILTERS, new URLSearchParams("report=x&mode=b"))).toBe(true);
  });
  it("finds the filter a server error points at", () => {
    expect(filterKeyForParam(FILTERS, "dateTo")).toBe("dateRange");
    expect(filterKeyForParam(FILTERS, "dateFrom")).toBe("dateRange");
    expect(filterKeyForParam(FILTERS, "departmentIds")).toBe("department");
    expect(filterKeyForParam(FILTERS, "period")).toBe("period");
    expect(filterKeyForParam(FILTERS, "employeeStatus")).toBe("employeeStatus");
    expect(filterKeyForParam(FILTERS, "mode")).toBe("mode");
    // a report's own check names the filter by kind (hr-time-card: "employee")
    const named = [f({ key: "people", kind: "employee", label: "Employees", multi: true, default: [] })];
    expect(filterKeyForParam(named, "employee")).toBe("people");
    expect(filterKeyForParam(FILTERS, "fmt")).toBeNull();
    expect(filterKeyForParam(FILTERS, null)).toBeNull();
    expect(filterKeyForParam(FILTERS, "")).toBeNull();
  });
});

describe("relative dates", () => {
  const today = new Date(2026, 10, 19); // 19 Nov 2026, a Thursday
  const P = f({ key: "period", kind: "period", label: "Month" });
  const Y = f({ key: "year", kind: "year", label: "Year" });
  const R = f({ key: "dateRange", kind: "dateRange", label: "Dates" });

  it("turns this / last month, this / last year and a preset range into tokens", () => {
    expect(relativeToken(P, "2026-11", today)).toBe("thisMonth");
    expect(relativeToken(P, "2026-10", today)).toBe("lastMonth");
    expect(relativeToken(P, "2026-09", today)).toBeNull();
    expect(relativeToken(Y, 2026, today)).toBe("thisYear");
    expect(relativeToken(Y, "2025", today)).toBe("lastYear");
    expect(relativeToken(Y, 2020, today)).toBeNull();
    expect(relativeToken(R, { dateFrom: "2026-11-01", dateTo: "2026-11-19" }, today)).toBe("month");
    expect(relativeToken(R, { dateFrom: "2026-10-01", dateTo: "2026-10-31" }, today)).toBe("lastMonth");
    expect(relativeToken(R, { dateFrom: "2026-11-16", dateTo: "2026-11-19" }, today)).toBe("week");
    expect(relativeToken(R, { dateFrom: "2026-11-03", dateTo: "2026-11-07" }, today)).toBeNull();
    expect(relativeToken(R, { dateFrom: "", dateTo: "" }, today)).toBeNull();
    expect(relativeToken(R, null, today)).toBeNull();
    expect(
      relativeToken(
        FILTERS.find((x) => x.key === "mode")!,
        "a",
        today,
      ),
    ).toBeNull();
  });
  it("prefers This month over Today on the 1st, when both give the same dates", () => {
    const first = new Date(2026, 11, 1);
    expect(relativeToken(R, { dateFrom: "2026-12-01", dateTo: "2026-12-01" }, first)).toBe("month");
  });
  it("works the token out again for a later day", () => {
    const later = new Date(2027, 0, 12);
    expect(resolveToken(P, "thisMonth", later)).toBe("2027-01");
    expect(resolveToken(P, "lastMonth", later)).toBe("2026-12");
    expect(resolveToken(Y, "thisYear", later)).toBe(2027);
    expect(resolveToken(Y, "lastYear", later)).toBe(2026);
    expect(resolveToken(R, "month", later)).toEqual({ dateFrom: "2027-01-01", dateTo: "2027-01-12" });
    expect(resolveToken(R, "nope", later)).toBeUndefined();
    expect(resolveToken(P, "week", later)).toBeUndefined();
    expect(resolveToken(Y, "month", later)).toBeUndefined();
    expect(resolveToken(f({ key: "x", kind: "text", label: "X" }), "thisMonth", later)).toBeUndefined();
  });
});

describe("last used filters: remember and restore", () => {
  const today = new Date(2026, 10, 19);
  const SPEC: ReportFilter[] = [
    f({ key: "period", kind: "period", label: "Month", required: true, default: "2026-10" }),
    f({
      key: "dateRange",
      kind: "dateRange",
      label: "Dates",
      default: { dateFrom: "2026-11-01", dateTo: "2026-11-19" },
    }),
    f({ key: "year", kind: "year", label: "Year", default: 2026 }),
    f({ key: "department", kind: "department", label: "Department", multi: true, default: [] }),
    f({ key: "branch", kind: "branch", label: "Branch", multi: true, default: [] }),
    f({ key: "employee", kind: "employee", label: "Employee", multi: true, default: [] }),
    f({ key: "employmentType", kind: "employmentType", label: "Employee type" }),
    f({ key: "employeeStatus", kind: "employeeStatus", label: "Status", default: "active" }),
    f({
      key: "view",
      kind: "select",
      label: "View",
      default: "detail",
      options: [
        { value: "detail", label: "Detail" },
        { value: "summary", label: "Summary" },
      ],
    }),
    f({ key: "includeOffDays", kind: "boolean", label: "Include days off", default: true }),
    f({ key: "minLate", kind: "number", label: "Minimum late minutes", default: 5 }),
    f({ key: "q", kind: "text", label: "Search" }),
  ];
  const OPTIONS: ReportCatalog["options"] = {
    departments: [
      { id: 3, name: "CUTTING" },
      { id: 4, name: "SEWING" },
    ],
    designations: [],
    branches: [{ id: 1, name: "Unit 1" }],
  };

  it("remembers nothing for a run on the defaults", () => {
    expect(rememberFilters(SPEC, defaultValues(SPEC), today)).toBeNull();
  });

  it("keeps who and how as values, dates as relative choices, and never employees or text", () => {
    const values = {
      ...defaultValues(SPEC),
      period: "2026-11", // this month (the default is last month)
      dateRange: { dateFrom: "2026-10-01", dateTo: "2026-10-31" }, // last month
      year: 2025,
      department: ["3"],
      employee: ["77"],
      employmentType: "production",
      employeeStatus: "all",
      view: "summary",
      includeOffDays: false,
      minLate: "15",
      q: "priya",
    };
    const kept = rememberFilters(SPEC, values, today)!;
    const q = new URLSearchParams(kept.query);
    expect(q.get("departmentIds")).toBe("3");
    expect(q.get("employmentType")).toBe("production");
    expect(q.get("employeeStatus")).toBe("all");
    expect(q.get("view")).toBe("summary");
    expect(q.get("includeOffDays")).toBe("false");
    expect(q.get("minLate")).toBe("15");
    for (const name of ["employeeIds", "q", "period", "dateFrom", "dateTo", "year"]) expect(q.has(name)).toBe(false);
    expect(kept.relative).toEqual({ period: "thisMonth", dateRange: "lastMonth", year: "lastYear" });
  });

  it("drops a fixed month or range (it is not remembered, so the next visit takes the default)", () => {
    const values = {
      ...defaultValues(SPEC),
      period: "2026-08",
      dateRange: { dateFrom: "2026-11-03", dateTo: "2026-11-05" },
    };
    expect(rememberFilters(SPEC, values, today)).toBeNull();
  });

  it("restores on a later visit with the relative choices worked out for that day", () => {
    const kept = rememberFilters(
      SPEC,
      { ...defaultValues(SPEC), period: "2026-11", department: ["3"], includeOffDays: false },
      today,
    )!;
    const december = new Date(2026, 11, 3);
    const { values, restored } = restoreFilters(SPEC, kept, december, OPTIONS);
    expect(values.period).toBe("2026-12"); // "this month" in December, not November
    expect(values.department).toEqual(["3"]);
    expect(values.includeOffDays).toBe(false);
    expect(values.employeeStatus).toBe("active");
    expect(restored).toEqual(["Month", "Department", "Include days off"]);
  });

  it("restores only the scope of an old fixed-date entry, never its month, dates, employees or text", () => {
    const legacy = {
      query: "period=2026-09&dateFrom=2026-09-01&dateTo=2026-09-30&departmentIds=4&employeeIds=9&q=x&view=summary",
      relative: {},
    };
    const { values, restored } = restoreFilters(SPEC, legacy, today, OPTIONS);
    expect(values.period).toBe("2026-10");
    expect(values.dateRange).toEqual({ dateFrom: "2026-11-01", dateTo: "2026-11-19" });
    expect(values.department).toEqual(["4"]);
    expect(values.employee).toEqual([]);
    expect(values.q).toBe("");
    expect(values.view).toBe("summary");
    expect(restored).toEqual(["Department", "View"]);
  });

  it("drops what the report no longer offers: a removed option, a deleted department", () => {
    const kept = { query: "view=pivot&departmentIds=3,99&branchIds=1", relative: { period: "nonsense" } };
    const { values, restored } = restoreFilters(SPEC, kept, today, OPTIONS);
    expect(values.view).toBe("detail");
    expect(values.department).toEqual(["3"]);
    expect(values.branch).toEqual(["1"]);
    expect(values.period).toBe("2026-10");
    expect(restored).toEqual(["Department", "Branch"]);
    // without the option lists the ids are taken as they are
    expect(restoreFilters(SPEC, kept, today).values.department).toEqual(["3", "99"]);
    // a designation that no longer exists goes too (this catalog lists none)
    const designation = f({ key: "designation", kind: "designation", label: "Designation", multi: true, default: [] });
    const gone = restoreFilters([designation], { query: "designationIds=5", relative: {} }, today, OPTIONS);
    expect(gone).toEqual({ values: { designation: [] }, restored: [] });
  });

  it("says nothing was restored when the remembered values equal today's defaults", () => {
    const same = { query: "employeeStatus=active", relative: { period: "lastMonth" } };
    expect(restoreFilters(SPEC, same, today).restored).toEqual([]);
  });
});
