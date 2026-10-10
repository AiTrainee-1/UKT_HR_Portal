import { describe, expect, it } from "vitest";
import type { Branch } from "@/lib/api-client/custom-hooks";
import type { BranchSummary, BranchSummaryRow } from "./api";
import {
  EMPTY_FORM,
  EXPORT_HEADERS,
  NO_FILTERS,
  exportRows,
  filterBranches,
  filtersActive,
  formOf,
  hasGeofence,
  headcount,
  mapLink,
  nextUnitCode,
  sortBranches,
  summaryMap,
  toCreatePayload,
  toUpdatePayload,
  totalsOf,
  validateForm,
} from "./logic";

const branch = (over: Partial<Branch> & { id: number; name: string }): Branch => ({
  isHeadOffice: false,
  isActive: true,
  ...over,
});

const branches: Branch[] = [
  branch({
    id: 1,
    name: "Head Office",
    code: "HO",
    location: "Tiruppur",
    address: "12 Mill Road",
    phone: "+91 98400 11111",
    isHeadOffice: true,
    geofenceLat: 11.1,
    geofenceLng: 77.3,
    geofenceRadiusM: 150,
    createdAt: "2025-01-01T00:00:00Z",
  }),
  branch({ id: 2, name: "Unit 2", code: "U2", location: "Surat", createdAt: "2026-03-01T00:00:00Z" }),
  branch({
    id: 3,
    name: "Alpha Works",
    location: "Erode",
    managerName: "Meena",
    geofenceLat: 11.3,
    geofenceLng: 77.7,
    createdAt: "2026-06-01T00:00:00Z",
  }),
];

const row = (branchId: number, over: Partial<BranchSummaryRow> = {}): BranchSummaryRow => ({
  branchId,
  staffActive: 0,
  productionActive: 0,
  inactive: 0,
  nextEmployeeSeq: 0,
  departments: [],
  ...over,
});

const summary: BranchSummary = {
  unassignedActive: 2,
  branches: [
    row(1, {
      staffActive: 10,
      productionActive: 40,
      inactive: 5,
      nextEmployeeSeq: 61,
      departments: [
        { id: 1, name: "Admin", activeCount: 10 },
        { id: 2, name: "Cutting", activeCount: 40 },
      ],
    }),
    row(2, { staffActive: 3, productionActive: 70, departments: [{ id: 3, name: "Sewing", activeCount: 70 }] }),
    row(3),
  ],
};

describe("hasGeofence", () => {
  it("needs both coordinates", () => {
    expect(hasGeofence(branches[0])).toBe(true);
    expect(hasGeofence(branches[1])).toBe(false);
    expect(hasGeofence({ geofenceLat: 11, geofenceLng: null })).toBe(false);
  });
});

describe("filterBranches", () => {
  const names = (f: Partial<typeof NO_FILTERS>) => filterBranches(branches, { ...NO_FILTERS, ...f }).map((b) => b.name);

  it("shows everything with no filter", () => {
    expect(names({})).toHaveLength(3);
  });

  it("ANDs the words across name, code, location, address, phone and manager", () => {
    expect(names({ query: "surat" })).toEqual(["Unit 2"]);
    expect(names({ query: "mill tiruppur" })).toEqual(["Head Office"]);
    expect(names({ query: "98400" })).toEqual(["Head Office"]);
    expect(names({ query: "meena erode" })).toEqual(["Alpha Works"]);
    expect(names({ query: "u2" })).toEqual(["Unit 2"]);
    expect(names({ query: "surat tiruppur" })).toEqual([]);
  });

  it("finds the head office by those words", () => {
    expect(names({ query: "head office" })).toEqual(["Head Office"]);
  });

  it("filters on whether a geofence is set", () => {
    expect(names({ geo: "set" })).toEqual(["Head Office", "Alpha Works"]);
    expect(names({ geo: "unset" })).toEqual(["Unit 2"]);
  });

  it("can show only the head office, and combines with the other filters", () => {
    expect(names({ headOfficeOnly: true })).toEqual(["Head Office"]);
    expect(names({ headOfficeOnly: true, geo: "unset" })).toEqual([]);
  });

  it("knows when a filter is on", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, query: "  " })).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, geo: "set" })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, headOfficeOnly: true })).toBe(true);
  });
});

describe("sortBranches", () => {
  const figures = summaryMap(summary);
  const order = (sort: Parameters<typeof sortBranches>[1]) => sortBranches(branches, sort, figures).map((b) => b.name);

  it("puts the head office first, then by name", () => {
    expect(order("name")).toEqual(["Head Office", "Alpha Works", "Unit 2"]);
  });
  it("sorts by code with the codeless last", () => {
    expect(order("code")).toEqual(["Head Office", "Unit 2", "Alpha Works"]);
  });
  it("sorts by people, then departments", () => {
    expect(order("people")).toEqual(["Unit 2", "Head Office", "Alpha Works"]);
    expect(order("departments")).toEqual(["Head Office", "Unit 2", "Alpha Works"]);
  });
  it("sorts newest first", () => {
    expect(order("newest")).toEqual(["Alpha Works", "Unit 2", "Head Office"]);
  });
  it("copes without the figures", () => {
    expect(sortBranches(branches, "people", new Map()).map((b) => b.name)).toEqual([
      "Alpha Works",
      "Head Office",
      "Unit 2",
    ]);
  });
  it("does not change the list it was given", () => {
    const before = branches.map((b) => b.id);
    sortBranches(branches, "newest", figures);
    expect(branches.map((b) => b.id)).toEqual(before);
  });
});

describe("totalsOf", () => {
  it("adds the branches up", () => {
    const t = totalsOf(branches, summary);
    expect(t).toMatchObject({
      branches: 3,
      staff: 13,
      production: 110,
      people: 123,
      unassigned: 2,
      withGeofence: 2,
      withoutGeofence: 1,
      departments: 3,
      emptyBranches: 1,
    });
    expect(t.headOffice?.name).toBe("Head Office");
  });
  it("still counts the geofences while the figures are missing", () => {
    const t = totalsOf(branches, undefined);
    expect(t.people).toBe(0);
    expect(t.emptyBranches).toBe(0);
    expect(t.withGeofence).toBe(2);
  });
  it("has no head office when none is marked", () => {
    expect(totalsOf([branches[1]], summary).headOffice).toBeNull();
  });
});

describe("headcount and unit codes", () => {
  it("adds staff and production", () => {
    expect(headcount(summary.branches[0])).toBe(50);
    expect(headcount(undefined)).toBe(0);
  });
  it("names the next unit code from the counter", () => {
    expect(nextUnitCode({ code: "HO" }, summary.branches[0])).toBe("HO-62");
    expect(nextUnitCode({ code: "U2" }, undefined)).toBe("U2-1");
  });
  it("has none for a branch without a code", () => {
    expect(nextUnitCode({ code: null }, summary.branches[0])).toBeNull();
    expect(nextUnitCode({ code: "  " }, summary.branches[0])).toBeNull();
  });
});

describe("validateForm", () => {
  const others = [
    { name: "Head Office", code: "HO" },
    { name: "Unit 2", code: null },
  ];
  const form = (over: Partial<typeof EMPTY_FORM>) => ({ ...EMPTY_FORM, name: "Unit 3", ...over });

  it("accepts a minimal form", () => {
    expect(validateForm(form({}), others)).toEqual({});
  });
  it("needs a name", () => {
    expect(validateForm(form({ name: "   " }), others).name).toBe("Branch name is required");
  });
  it("refuses a name or code another branch has, ignoring case and spaces", () => {
    expect(validateForm(form({ name: " head office " }), others).name).toMatch(/already has this name/);
    expect(validateForm(form({ code: "ho" }), others).code).toMatch(/already uses this code/);
  });
  it("lets a branch keep its own name and code (it is not among the others)", () => {
    expect(validateForm(form({ name: "Head Office", code: "HO" }), [])).toEqual({});
  });
  it("checks the phone loosely", () => {
    expect(validateForm(form({ phone: "+91 98400-11111" }), others)).toEqual({});
    expect(validateForm(form({ phone: "call me" }), others).phone).toBeDefined();
  });
  it("checks the radius only when a geofence is set", () => {
    expect(validateForm(form({ radius: "5" }), others)).toEqual({});
    const set = { geofenceLat: 11, geofenceLng: 77 };
    expect(validateForm(form({ ...set, radius: "5" }), others).radius).toBeDefined();
    expect(validateForm(form({ ...set, radius: "2500" }), others).radius).toBeDefined();
    expect(validateForm(form({ ...set, radius: "" }), others).radius).toBeDefined();
    expect(validateForm(form({ ...set, radius: "300" }), others)).toEqual({});
  });
});

describe("payloads", () => {
  it("fills the form from a branch", () => {
    expect(formOf(branches[0])).toMatchObject({ name: "Head Office", code: "HO", radius: "150", isHeadOffice: true });
    expect(formOf(branches[1])).toMatchObject({ address: "", geofenceLat: null, radius: "200" });
  });
  it("leaves empty optional fields out of a new branch", () => {
    const p = toCreatePayload({ ...EMPTY_FORM, name: " Unit 9 ", code: " " });
    expect(p.name).toBe("Unit 9");
    expect(p.code).toBeUndefined();
    expect(p.geofenceRadiusM).toBe(200);
  });
  it("sends cleared fields as null on an edit so they are really cleared", () => {
    const p = toUpdatePayload({ ...formOf(branches[0]), address: "", code: "" });
    expect(p.address).toBeNull();
    expect(p.code).toBeNull();
    expect(p.name).toBe("Head Office");
    expect(p.geofenceRadiusM).toBe(150);
  });
  it("falls back to the default radius for an unusable one", () => {
    expect(toUpdatePayload({ ...EMPTY_FORM, name: "x", radius: "abc" }).geofenceRadiusM).toBe(200);
    expect(toUpdatePayload({ ...EMPTY_FORM, name: "x", radius: "250.6" }).geofenceRadiusM).toBe(251);
  });
});

describe("export", () => {
  it("writes a row per branch with as many cells as headers", () => {
    const rows = exportRows(branches, summaryMap(summary));
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toHaveLength(EXPORT_HEADERS.length);
    expect(rows[0].slice(0, 3)).toEqual(["Head Office", "HO", "Yes"]);
    expect(rows[0].slice(6, 11)).toEqual([10, 40, 5, 2, "Set"]);
    expect(rows[1].slice(10)).toEqual(["Not set", "", "", ""]);
  });
  it("leaves the headcount cells empty without figures", () => {
    expect(exportRows([branches[1]], new Map())[0].slice(6, 10)).toEqual(["", "", "", ""]);
  });
  it("links to the geofence centre", () => {
    expect(mapLink(11.1, 77.3)).toBe("https://www.openstreetmap.org/?mlat=11.1&mlon=77.3#map=17/11.1/77.3");
  });
});
