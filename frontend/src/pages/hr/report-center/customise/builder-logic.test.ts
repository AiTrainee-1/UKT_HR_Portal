import { describe, expect, it } from "vitest";
import { readDatasets, readSavedReport, readSavedReports } from "@/lib/api-client/custom-hooks/report-customise";
import {
  draftForDataset,
  draftFromSaved,
  draftProblem,
  draftSignature,
  draftToInput,
  editReportHref,
  emptyDraft,
  filtersToSaved,
  moveField,
  newReportHref,
  openReportHref,
  previewQuery,
  removeField,
  savedByLine,
  savedDatesMode,
  savedToParams,
  relativeToken,
  describeDates,
  searchSaved,
  searchSections,
  setSection,
  shortDate,
  toggleField,
} from "./builder-logic";
import { EMPLOYEES, MONTHLY, PUNCHES, savedItem } from "./test-fixtures";

/** The tests' today: 19 November 2026 (the fixtures' default range is 1 - 19 Nov 2026). */
const TODAY = new Date(2026, 10, 19);

describe("the chosen fields", () => {
  it("tick on at the end, tick off and remove", () => {
    expect(toggleField(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggleField(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    expect(removeField(["a", "b"], "a")).toEqual(["b"]);
    expect(removeField(["a", "b"], "zz")).toEqual(["a", "b"]);
  });

  it("move up, down and by drag, clamped at both ends", () => {
    expect(moveField(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
    expect(moveField(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveField(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveField(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveField(["a", "b", "c"], 2, 9)).toEqual(["a", "b", "c"]);
    const same = ["a", "b"];
    expect(moveField(same, 5, 0)).toBe(same); // out of range: unchanged
  });

  it("add or remove a whole section, keeping the order of what was there", () => {
    const attendance = EMPLOYEES.sections[1];
    expect(setSection(["emp.code", "att.late_count"], attendance, true)).toEqual([
      "emp.code",
      "att.late_count",
      "att.present_days",
      "att.ot_hours",
    ]);
    expect(setSection(["emp.code", "att.late_count", "att.ot_hours"], attendance, false)).toEqual(["emp.code"]);
  });

  it("searches labels, keys, sections and descriptions", () => {
    expect(searchSections(EMPLOYEES.sections, "").length).toBe(3);
    const net = searchSections(EMPLOYEES.sections, "deductions");
    expect(net.map((s) => s.id)).toEqual(["payroll"]);
    expect(net[0].fields.map((f) => f.key)).toEqual(["pay.net"]);
    expect(searchSections(EMPLOYEES.sections, "attendance late")[0].fields.map((f) => f.key)).toEqual([
      "att.late_count",
    ]);
    expect(searchSections(EMPLOYEES.sections, "nothing like this")).toEqual([]);
  });
});

describe("filters as the server stores them", () => {
  const values = {
    dateRange: { dateFrom: "2026-10-01", dateTo: "2026-10-31" },
    department: ["3", "4"],
    employeeStatus: "active",
    nameLike: "",
  };

  it("leave the dates out by default, keep them when fixed", () => {
    expect(filtersToSaved(EMPLOYEES, values, "default", TODAY)).toEqual({
      departmentIds: "3,4",
      employeeStatus: "active",
    });
    expect(filtersToSaved(EMPLOYEES, values, "fixed", TODAY)).toEqual({
      dateFrom: "2026-10-01",
      dateTo: "2026-10-31",
      departmentIds: "3,4",
      employeeStatus: "active",
    });
  });

  it("save a quick range as a period counted from the day the report is opened", () => {
    // 1 - 31 Oct is "Last month" on 19 Nov
    expect(relativeToken(EMPLOYEES, values, TODAY)).toBe("lastMonth");
    expect(filtersToSaved(EMPLOYEES, values, "relative", TODAY)).toEqual({
      dateRange: "lastMonth",
      departmentIds: "3,4",
      employeeStatus: "active",
    });
    const thisMonth = { ...values, dateRange: { dateFrom: "2026-11-01", dateTo: "2026-11-19" } };
    expect(relativeToken(EMPLOYEES, thisMonth, TODAY)).toBe("thisMonth");
    const last7 = { ...values, dateRange: { dateFrom: "2026-11-13", dateTo: "2026-11-19" } };
    expect(relativeToken(EMPLOYEES, last7, TODAY)).toBe("last7");
    // not a quick range: nothing relative to save
    const odd = { ...values, dateRange: { dateFrom: "2026-10-03", dateTo: "2026-10-09" } };
    expect(relativeToken(EMPLOYEES, odd, TODAY)).toBeNull();
    expect(filtersToSaved(EMPLOYEES, odd, "relative", TODAY)).toEqual({
      departmentIds: "3,4",
      employeeStatus: "active",
    });
    // a month filter: this month / last month
    expect(relativeToken(MONTHLY, { period: "2026-10" }, TODAY)).toBe("lastMonth");
    expect(relativeToken(MONTHLY, { period: "2026-11" }, TODAY)).toBe("thisMonth");
    expect(relativeToken(MONTHLY, { period: "2026-08" }, TODAY)).toBeNull();
    expect(filtersToSaved(MONTHLY, { period: "2026-10" }, "relative", TODAY)).toEqual({ period: "lastMonth" });
    expect(filtersToSaved(MONTHLY, { period: "2026-10" }, "fixed", TODAY)).toEqual({ period: "2026-10" });
    expect(filtersToSaved(MONTHLY, { period: "2026-10" }, "default", TODAY)).toEqual({});
  });

  it("tell how a saved report's dates were saved, and read them back without the tokens", () => {
    expect(savedDatesMode({ employeeStatus: "active" })).toBe("default");
    expect(savedDatesMode({ dateFrom: "2026-10-01", dateTo: "2026-10-31" })).toBe("fixed");
    expect(savedDatesMode({ period: "2026-10" })).toBe("fixed");
    expect(savedDatesMode({ year: "2026" })).toBe("fixed");
    expect(savedDatesMode({ dateRange: "lastMonth" })).toBe("relative");
    expect(savedDatesMode({ period: "thisMonth" })).toBe("relative");
    expect(savedDatesMode({ dateRange: "someday" })).toBe("default");
    expect(savedToParams({ dateRange: "lastMonth", period: "thisMonth", departmentIds: "3", x: "" }).toString()).toBe(
      "departmentIds=3",
    );
  });

  it("describe the dates on screen", () => {
    expect(describeDates(EMPLOYEES, values)).toBe("1 Oct 2026 - 31 Oct 2026");
    expect(describeDates(EMPLOYEES, { dateRange: { dateFrom: "2026-11-19", dateTo: "2026-11-19" } })).toBe(
      "19 Nov 2026",
    );
    expect(describeDates(EMPLOYEES, { dateRange: { dateFrom: "", dateTo: "" } })).toBe("");
    expect(describeDates(MONTHLY, { period: "2026-10" })).toBe("October 2026");
  });

  it("build the preview query: dataset, fields in order, sort, then the filters", () => {
    const q = new URLSearchParams(
      previewQuery(EMPLOYEES, ["att.late_count", "emp.code"], [{ key: "emp.code", dir: "desc" }], values),
    );
    expect(q.get("dataset")).toBe("employees");
    expect(q.get("fields")).toBe("att.late_count,emp.code");
    expect(q.get("sort")).toBe("emp.code:desc");
    expect(q.get("dateFrom")).toBe("2026-10-01");
    expect(q.get("departmentIds")).toBe("3,4");
    expect(q.has("nameLike")).toBe(false);
    expect(new URLSearchParams(previewQuery(EMPLOYEES, ["emp.code"], [], values)).has("sort")).toBe(false);
  });
});

describe("the draft", () => {
  it("takes a data source's default fields and filters, keeping the name", () => {
    const d = draftForDataset({ ...emptyDraft(), name: "Mine", fields: ["x"] }, EMPLOYEES);
    expect(d.dataset).toBe("employees");
    expect(d.fields).toEqual(["emp.code", "emp.name"]);
    expect(d.values.employeeStatus).toBe("active");
    expect(d.name).toBe("Mine");
  });

  it("opens a saved report, dropping fields the role can no longer use", () => {
    const item = savedItem({ fields: ["emp.code", "pay.secret", "att.late_count"], filters: { departmentIds: "3" } });
    const { draft, dropped } = draftFromSaved(item, EMPLOYEES);
    expect(draft.fields).toEqual(["emp.code", "att.late_count"]);
    expect(dropped).toEqual(["pay.secret"]);
    expect(draft.values.department).toEqual(["3"]);
    // no dates saved: the dataset's default range
    expect(draft.values.dateRange).toEqual(EMPLOYEES.filters[0].default);
    expect(draft.dates).toBe("default");
    // a sort on a dropped field is dropped too
    const sorted = draftFromSaved(savedItem({ sort: [{ key: "pay.secret", dir: "asc" }] }), EMPLOYEES);
    expect(sorted.draft.sort).toEqual([]);
    const dated = draftFromSaved(savedItem({ filters: { dateFrom: "2026-09-01", dateTo: "2026-09-30" } }), EMPLOYEES);
    expect(dated.draft.dates).toBe("fixed");
    expect(dated.draft.values.dateRange).toEqual({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    // a relative period opens as the dates it means today
    const relative = draftFromSaved(savedItem({ filters: { dateRange: "lastMonth" } }), EMPLOYEES, TODAY);
    expect(relative.draft.dates).toBe("relative");
    expect(relative.draft.values.dateRange).toEqual({ dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    const month = draftFromSaved(savedItem({ dataset: "monthly", filters: { period: "lastMonth" } }), MONTHLY, TODAY);
    expect(month.draft.values.period).toBe("2026-10");
    expect(month.draft.dates).toBe("relative");
  });

  it("notices a change, and not a re-typed space", () => {
    const { draft } = draftFromSaved(savedItem(), EMPLOYEES);
    const base = draftSignature(draft, EMPLOYEES);
    expect(draftSignature({ ...draft }, EMPLOYEES)).toBe(base);
    expect(draftSignature({ ...draft, name: `${draft.name}  ` }, EMPLOYEES)).toBe(base);
    expect(draftSignature({ ...draft, fields: moveField(draft.fields, 0, 1) }, EMPLOYEES)).not.toBe(base);
    expect(draftSignature({ ...draft, values: { ...draft.values, nameLike: "a" } }, EMPLOYEES)).not.toBe(base);
    expect(draftSignature({ ...draft, dates: "fixed" }, EMPLOYEES)).not.toBe(base);
  });

  it("says what stops a save, in order", () => {
    expect(draftProblem(emptyDraft(), undefined)?.part).toBe("dataset");
    const d = draftForDataset(emptyDraft(), EMPLOYEES);
    expect(draftProblem({ ...d, fields: [] }, EMPLOYEES)?.part).toBe("fields");
    expect(
      draftProblem(
        { ...d, values: { ...d.values, dateRange: { dateFrom: "2026-11-09", dateTo: "2026-11-01" } } },
        EMPLOYEES,
      )?.part,
    ).toBe("filters");
    expect(draftProblem(d, EMPLOYEES)).toEqual({ part: "name", message: "Give the report a name." });
    expect(draftProblem({ ...d, name: "x".repeat(121) }, EMPLOYEES)?.part).toBe("name");
    expect(draftProblem({ ...d, name: "Fine" }, EMPLOYEES)).toBeNull();
    // "counted from the day it is opened" needs a quick range on screen
    const relative = { ...d, name: "Fine", dates: "relative" as const };
    expect(draftProblem(relative, EMPLOYEES, TODAY)).toBeNull(); // the default 1 - 19 Nov is "This month"
    const custom = {
      ...relative,
      values: { ...d.values, dateRange: { dateFrom: "2026-11-02", dateTo: "2026-11-05" } },
    };
    expect(draftProblem(custom, EMPLOYEES, TODAY)?.part).toBe("filters");
    // a punch report wider than its 31 days
    const p = draftForDataset({ ...emptyDraft(), name: "P" }, PUNCHES);
    const wide = { ...p, values: { dateRange: { dateFrom: "2026-09-01", dateTo: "2026-10-31" } } };
    expect(draftProblem(wide, PUNCHES)?.message).toContain("31 days");
  });

  it("becomes the body of a save", () => {
    const d = {
      ...draftForDataset(emptyDraft(), EMPLOYEES),
      name: "  Monthly  ",
      description: " Per employee ",
      sort: [{ key: "emp.name", dir: "desc" as const }],
    };
    expect(draftToInput(d, EMPLOYEES)).toEqual({
      name: "Monthly",
      description: "Per employee",
      dataset: "employees",
      fields: ["emp.code", "emp.name"],
      filters: { employeeStatus: "active" },
      sort: [{ key: "emp.name", dir: "desc" }],
    });
  });
});

describe("addresses and the catalog tiles", () => {
  it("point at the builder and the Report Center", () => {
    expect(newReportHref()).toBe("/hr/reports/customise/new");
    expect(editReportHref(12)).toBe("/hr/reports/customise/12/edit");
    expect(openReportHref(12)).toBe("/hr/reports?report=custom-12");
  });

  it("search saved reports by name, description and data source", () => {
    const a = savedItem({ id: 1, name: "Late list", description: "", datasetLabel: "Attendance days" });
    const b = savedItem({ id: 2, name: "Net pay", description: "bank sheet", datasetLabel: "Payroll" });
    expect(searchSaved([a, b], "")).toEqual([a, b]);
    expect(searchSaved([a, b], "late")).toEqual([a]);
    expect(searchSaved([a, b], "payroll bank")).toEqual([b]);
    expect(searchSaved([a, b], "attendance")).toEqual([a]);
  });

  it("say who changed a report and when", () => {
    expect(shortDate("2026-11-19T10:42:00+05:30")).toBe("19 Nov 2026");
    expect(shortDate(null)).toBe("");
    expect(shortDate("yesterday")).toBe("yesterday");
    expect(savedByLine(savedItem())).toBe("Updated by Priya · 19 Nov 2026");
    expect(savedByLine(savedItem({ updatedBy: null, updatedAt: null }))).toBe("Created by Priya · 18 Nov 2026");
    expect(savedByLine(savedItem({ updatedBy: null, updatedAt: null, createdBy: null }))).toBe("Created 18 Nov 2026");
    expect(savedByLine(savedItem({ updatedBy: null, updatedAt: null, createdBy: null, createdAt: null }))).toBe("");
  });
});

describe("reading the server leniently", () => {
  it("keeps datasets with an id, drops empty sections, defaults the grain", () => {
    const list = readDatasets({
      datasets: [
        {
          id: "x",
          label: "X",
          grain: "weird",
          sections: [{ id: "s", label: "S", fields: [{ key: "a" }, {}] }, { id: "e" }],
        },
        { label: "no id" },
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0].grain).toBe("employee");
    expect(list[0].sections).toEqual([
      { id: "s", label: "S", fields: [{ key: "a", label: "a", type: "text", section: "s" }] },
    ]);
    expect(list[0].filters).toEqual([]);
    expect(readDatasets(null)).toEqual([]);
  });

  it("reads saved reports, lists of filter values and sorts", () => {
    const item = readSavedReport({
      id: 9,
      name: "N",
      fields: ["a", "b"],
      filters: { departmentIds: [3, 4], employeeStatus: "active", empty: "", gone: null, flag: false },
      sort: [{ key: "a", dir: "desc" }, { key: "" }, { key: "b", dir: "sideways" }],
      canEdit: true,
    });
    expect(item).toMatchObject({
      id: 9,
      reportId: "custom-9",
      filters: { departmentIds: "3,4", employeeStatus: "active", flag: "false" },
      sort: [
        { key: "a", dir: "desc" },
        { key: "b", dir: "asc" },
      ],
      canEdit: true,
      canDelete: false,
      createdBy: null,
    });
    expect(readSavedReport({ name: "no id" })).toBeNull();
    expect(readSavedReports({ items: [{ id: 1 }, { id: "x" }] }).map((r) => r.id)).toEqual([1]);
  });
});
