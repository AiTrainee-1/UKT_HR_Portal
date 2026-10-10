import { describe, expect, it } from "vitest";
import type { Employee } from "@/lib/api-client/generated/api.schemas";
import type { IdCardData } from "@/lib/api-client/custom-hooks";
import {
  CARD_CHUNK,
  NO_FILTERS,
  addIds,
  allSelected,
  cardFileName,
  cardGaps,
  chunk,
  facetsOf,
  filterEmployees,
  filtersActive,
  keepKnown,
  orderCards,
  removeIds,
  summarizeEmployees,
  summarizeSelection,
  toggleId,
} from "./logic";

const emp = (over: Partial<Employee> & { id: number; employeeCode: string }): Employee =>
  ({
    firstName: "First",
    lastName: "Last",
    employmentType: "staff",
    status: "active",
    photoUrl: "data:image/png;base64,xx",
    bloodGroup: "O+",
    emergencyContact: "9000000000",
    ...over,
  }) as Employee;

const employees: Employee[] = [
  emp({
    id: 1,
    employeeCode: "HO-1",
    firstName: "Asha",
    lastName: "Kumar",
    designationTitle: "Accountant",
    departmentId: 10,
    departmentName: "Accounts",
    branchId: 100,
    branchName: "Head Office",
    unitCode: "HO-1",
  }),
  emp({
    id: 2,
    employeeCode: "U2-5",
    firstName: "Ravi",
    lastName: "S",
    employmentType: "production",
    photoUrl: null,
    departmentId: 11,
    departmentName: "Cutting",
    branchId: 101,
    branchName: "Unit 2",
  }),
  emp({
    id: 3,
    employeeCode: "U2-6",
    firstName: "Meena",
    lastName: "R",
    employmentType: "production",
    bloodGroup: null,
    emergencyContact: null,
    phone: "9111111111",
    departmentId: 11,
    departmentName: "Cutting",
    branchId: 101,
    branchName: "Unit 2",
  }),
  emp({
    id: 4,
    employeeCode: "X-1",
    firstName: "Zed",
    photoUrl: "  ",
    bloodGroup: "",
    emergencyContact: "",
    phone: null,
  }),
];

describe("cardGaps", () => {
  it("lists what the card will print blank", () => {
    expect(cardGaps(employees[0])).toEqual([]);
    expect(cardGaps(employees[1])).toEqual(["photo"]);
    expect(cardGaps(employees[3])).toEqual(["photo", "bloodGroup", "emergency"]);
  });
  it("accepts the phone number as the emergency contact", () => {
    expect(cardGaps(employees[2])).toEqual(["bloodGroup"]);
  });
});

describe("filterEmployees", () => {
  const codes = (f: Partial<typeof NO_FILTERS>) =>
    filterEmployees(employees, { ...NO_FILTERS, ...f }).map((e) => e.employeeCode);

  it("shows everyone with no filter", () => {
    expect(codes({})).toEqual(["HO-1", "U2-5", "U2-6", "X-1"]);
  });
  it("filters by type", () => {
    expect(codes({ type: "production" })).toEqual(["U2-5", "U2-6"]);
    expect(codes({ type: "staff" })).toEqual(["HO-1", "X-1"]);
  });
  it("ANDs the words over name, code, designation, department and branch", () => {
    expect(codes({ query: "asha" })).toEqual(["HO-1"]);
    expect(codes({ query: "cutting ravi" })).toEqual(["U2-5"]);
    expect(codes({ query: "unit 2" })).toEqual(["U2-5", "U2-6"]);
    expect(codes({ query: "accountant head" })).toEqual(["HO-1"]);
    expect(codes({ query: "u2-6" })).toEqual(["U2-6"]);
    expect(codes({ query: "asha ravi" })).toEqual([]);
  });
  it("filters by branch and department", () => {
    expect(codes({ branch: "101" })).toEqual(["U2-5", "U2-6"]);
    expect(codes({ department: "10" })).toEqual(["HO-1"]);
    expect(codes({ branch: "101", department: "10" })).toEqual([]);
  });
  it("filters by what is on file, a blank photo counting as none", () => {
    expect(codes({ details: "has_photo" })).toEqual(["HO-1", "U2-6"]);
    expect(codes({ details: "no_photo" })).toEqual(["U2-5", "X-1"]);
    expect(codes({ details: "incomplete" })).toEqual(["U2-5", "U2-6", "X-1"]);
  });
  it("knows when a filter is on", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, query: " " })).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, details: "no_photo" })).toBe(true);
  });
});

describe("facetsOf and summarizeEmployees", () => {
  it("lists each branch and department once, sorted", () => {
    const f = facetsOf(employees);
    expect(f.branches).toEqual([
      { value: "100", label: "Head Office" },
      { value: "101", label: "Unit 2" },
    ]);
    expect(f.departments.map((d) => d.label)).toEqual(["Accounts", "Cutting"]);
  });
  it("counts photos and complete cards", () => {
    expect(summarizeEmployees(employees)).toEqual({
      total: 4,
      staff: 2,
      production: 2,
      withPhoto: 2,
      withoutPhoto: 2,
      complete: 1,
      incomplete: 3,
    });
  });
});

describe("selection", () => {
  it("toggles an id", () => {
    expect(toggleId([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggleId([1, 2, 3], 2)).toEqual([1, 3]);
  });
  it("adds the shown employees after the chosen ones, without repeats", () => {
    expect(addIds([3, 1], [1, 2, 4])).toEqual([3, 1, 2, 4]);
  });
  it("removes only the shown ones", () => {
    expect(removeIds([1, 2, 3, 4], [2, 4, 9])).toEqual([1, 3]);
  });
  it("knows when every shown employee is chosen", () => {
    expect(allSelected(employees.slice(0, 2), [1, 2, 9])).toBe(true);
    expect(allSelected(employees.slice(0, 2), [1])).toBe(false);
    expect(allSelected([], [1])).toBe(false);
  });
  it("drops ids of employees that are gone", () => {
    expect(keepKnown([1, 99, 3], employees)).toEqual([1, 3]);
  });
  it("sums up the selection and lists who has no photo", () => {
    const s = summarizeSelection(employees, [1, 2, 4]);
    expect(s).toMatchObject({ count: 3, staff: 2, production: 1 });
    expect(s.noPhoto.map((e) => e.id)).toEqual([2, 4]);
    expect(summarizeSelection(employees, [])).toMatchObject({ count: 0, noPhoto: [] });
  });
});

describe("cards", () => {
  const card = (id: number, name = "N", code = `C${id}`) => ({ id, name, code }) as IdCardData;

  it("splits the ids into pieces the server accepts", () => {
    const ids = Array.from({ length: CARD_CHUNK * 2 + 5 }, (_, i) => i);
    const parts = chunk(ids, CARD_CHUNK);
    expect(parts.map((p) => p.length)).toEqual([CARD_CHUNK, CARD_CHUNK, 5]);
    expect(parts.flat()).toEqual(ids);
    expect(chunk([], 10)).toEqual([]);
  });
  it("shows the cards in the order selected, each once, and only the selected", () => {
    const got = orderCards([card(1), card(2), card(3), card(2)], [3, 1, 2]);
    expect(got.map((c) => c.id)).toEqual([3, 1, 2]);
    expect(orderCards([card(1), card(2)], [2]).map((c) => c.id)).toEqual([2]);
  });
  it("makes a safe file name", () => {
    expect(cardFileName({ code: "HO-1", name: "Asha K. / Kumar" })).toBe("ID-Card-HO-1-Asha_K_Kumar.png");
  });
});
