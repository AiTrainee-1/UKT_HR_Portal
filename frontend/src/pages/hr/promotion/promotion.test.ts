import { describe, expect, it } from "vitest";
import {
  checkPromotion,
  distinct,
  dueForReview,
  employeeTimeline,
  filterDue,
  filterPromotions,
  filtersActive,
  lastPromotionDates,
  monthsInRole,
  NO_DUE_FILTERS,
  NO_FILTERS,
  promotionKind,
  sortPromotions,
  summarizePromotions,
  type PromoEmployee,
  type PromotionRecord,
} from "./logic";

const TODAY = "2026-10-10";

let nextId = 1;
const promo = (over: Partial<PromotionRecord>): PromotionRecord => ({
  id: nextId++,
  employeeId: 1,
  employeeCode: "E001",
  employeeName: "Asha Kumar",
  previousDesignation: "Operator",
  newDesignation: "Supervisor",
  previousDepartment: "Stitching",
  newDepartment: "Stitching",
  effectiveDate: "2026-02-01",
  notes: null,
  promotedBy: "HR Admin",
  branchName: "Head Office",
  employmentType: "staff",
  ...over,
});

const emp = (over: Partial<PromoEmployee> & { id: number }): PromoEmployee => ({
  employeeCode: `E00${over.id}`,
  firstName: "First",
  lastName: `Last${over.id}`,
  departmentId: 10,
  departmentName: "Stitching",
  designationId: 20,
  designationTitle: "Operator",
  branchId: 1,
  branchName: "Head Office",
  employmentType: "staff",
  joinDate: "2020-01-01",
  status: "active",
  ...over,
});

describe("promotionKind", () => {
  it("says what the record changed", () => {
    expect(promotionKind(promo({}))).toBe("designation");
    expect(promotionKind(promo({ newDepartment: "Cutting" }))).toBe("both");
    expect(promotionKind(promo({ newDesignation: "Operator", newDepartment: "Cutting" }))).toBe("department");
    // old data where nothing differs still reads as a designation change
    expect(promotionKind(promo({ newDesignation: "Operator" }))).toBe("designation");
  });
});

describe("filtering and sorting the history", () => {
  const rows = [
    promo({ id: 1, employeeId: 1, employeeName: "Asha Kumar", effectiveDate: "2026-02-01", notes: "Annual review" }),
    promo({
      id: 2,
      employeeId: 2,
      employeeCode: "E002",
      employeeName: "Ravi Singh",
      previousDesignation: "Supervisor",
      newDesignation: "Manager",
      previousDepartment: "Stitching",
      newDepartment: "Cutting",
      effectiveDate: "2025-11-15",
      branchName: "Unit 2",
      employmentType: "production",
    }),
    promo({ id: 3, employeeId: 3, employeeCode: "E003", employeeName: "Meena Das", effectiveDate: "2026-10-01" }),
  ];

  it("starts with no filter on", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filterPromotions(rows, NO_FILTERS, TODAY)).toHaveLength(3);
  });

  it("searches name, code, notes and positions, every word having to match", () => {
    const find = (query: string) => filterPromotions(rows, { ...NO_FILTERS, query }, TODAY).map((p) => p.id);
    expect(find("ravi")).toEqual([2]);
    expect(find("e003")).toEqual([3]);
    expect(find("annual")).toEqual([1]);
    expect(find("manager cutting")).toEqual([2]);
    expect(find("manager asha")).toEqual([]);
  });

  it("filters by department (either side of the move), designation, branch, type and kind", () => {
    const f = (patch: Partial<typeof NO_FILTERS>) =>
      filterPromotions(rows, { ...NO_FILTERS, ...patch }, TODAY).map((p) => p.id);
    expect(f({ department: "Cutting" })).toEqual([2]);
    expect(f({ department: "Stitching" })).toEqual([1, 2, 3]);
    expect(f({ designation: "Manager" })).toEqual([2]);
    expect(f({ branch: "Unit 2" })).toEqual([2]);
    expect(f({ type: "production" })).toEqual([2]);
    expect(f({ kind: "both" })).toEqual([2]);
    expect(f({ kind: "designation" })).toEqual([1, 3]);
  });

  it("filters by period and by a custom range", () => {
    const f = (patch: Partial<typeof NO_FILTERS>) =>
      filterPromotions(rows, { ...NO_FILTERS, ...patch }, TODAY).map((p) => p.id);
    expect(f({ period: "this_month" })).toEqual([3]);
    expect(f({ period: "this_year" })).toEqual([1, 3]);
    expect(f({ period: "last_year" })).toEqual([2]);
    expect(f({ period: "custom", from: "2025-11-01", to: "2026-02-01" })).toEqual([1, 2]);
    expect(filtersActive({ ...NO_FILTERS, period: "this_year" })).toBe(true);
  });

  it("sorts by date, employee and designation in either direction", () => {
    expect(sortPromotions(rows, "date", "desc").map((p) => p.id)).toEqual([3, 1, 2]);
    expect(sortPromotions(rows, "date", "asc").map((p) => p.id)).toEqual([2, 1, 3]);
    expect(sortPromotions(rows, "employee", "asc").map((p) => p.employeeName)).toEqual([
      "Asha Kumar",
      "Meena Das",
      "Ravi Singh",
    ]);
    expect(sortPromotions(rows, "designation", "asc")[0].newDesignation).toBe("Manager");
  });

  it("distinct gives the sorted, unique, non-empty values", () => {
    expect(distinct(["b", "a", null, "b", undefined, ""])).toEqual(["a", "b"]);
  });

  it("summarises this year, this month, people and department moves", () => {
    const s = summarizePromotions(rows, TODAY);
    expect(s).toEqual({ total: 3, thisYear: 2, thisMonth: 1, employees: 3, departmentMoves: 0 });
    const withMove = summarizePromotions(
      [...rows, promo({ newDepartment: "Cutting", effectiveDate: "2026-05-05" })],
      TODAY,
    );
    expect(withMove.departmentMoves).toBe(1);
    expect(withMove.employees).toBe(3);
  });
});

describe("who is due for review", () => {
  const people = [
    emp({ id: 1, joinDate: "2020-01-01" }), // promoted 2026-02-01: 8 months ago
    emp({ id: 2, joinDate: "2020-01-01" }), // never promoted: 6 yrs 9 mo
    emp({ id: 3, joinDate: "2024-06-01" }), // never promoted: 2 yrs 4 mo
    emp({ id: 4, joinDate: null }), // no date at all
    emp({ id: 5, joinDate: "2021-01-01", status: "inactive" }), // not active
    emp({ id: 6, joinDate: "2027-01-01" }), // joins in the future
  ];
  const promotions = [
    promo({ employeeId: 1, effectiveDate: "2026-02-01" }),
    promo({ employeeId: 1, effectiveDate: "2023-01-01" }),
  ];

  it("takes each person's newest promotion, else their joining date", () => {
    expect(lastPromotionDates(promotions).get(1)).toBe("2026-02-01");
    const { rows, unknown } = dueForReview(people, promotions, 24, TODAY);
    expect(rows.map((r) => r.employee.id)).toEqual([2, 3]);
    expect(rows.map((r) => r.basis)).toEqual(["joining", "joining"]);
    expect(rows[0].months).toBe(81);
    expect(unknown).toBe(1);
  });

  it("a shorter wait brings more people in, longest wait first", () => {
    const { rows } = dueForReview(people, promotions, 6, TODAY);
    expect(rows.map((r) => r.employee.id)).toEqual([2, 3, 1]);
    expect(rows[2]).toMatchObject({ basis: "promotion", since: "2026-02-01", months: 8 });
  });

  it("filters the due list", () => {
    const { rows } = dueForReview(people, promotions, 6, TODAY);
    expect(filterDue(rows, { ...NO_DUE_FILTERS, basis: "promotion" }).map((r) => r.employee.id)).toEqual([1]);
    expect(filterDue(rows, { ...NO_DUE_FILTERS, query: "last3" }).map((r) => r.employee.id)).toEqual([3]);
    expect(filterDue(rows, { ...NO_DUE_FILTERS, department: "Cutting" })).toEqual([]);
  });

  it("works out the time in the current position", () => {
    expect(monthsInRole("2020-01-01", "2026-02-01", TODAY)).toBe(8);
    expect(monthsInRole("2020-01-01", null, TODAY)).toBe(81);
    expect(monthsInRole(null, null, TODAY)).toBeNull();
  });
});

describe("checkPromotion", () => {
  const e = { designationId: 20, departmentId: 10, joinDate: "2020-01-01" };
  const draft = { newDesignationId: "", newDepartmentId: "", effectiveDate: TODAY };

  it("needs a designation or a department", () => {
    expect(checkPromotion(e, draft, TODAY).errors).toEqual(["Choose a new designation or department."]);
  });

  it("refuses a change that changes nothing, like the server does", () => {
    const same = checkPromotion(e, { ...draft, newDesignationId: "20", newDepartmentId: "10" }, TODAY);
    expect(same.errors).toHaveLength(1);
    expect(same.designationChanges || same.departmentChanges).toBe(false);
  });

  it("accepts a designation change, a department change, or both", () => {
    expect(checkPromotion(e, { ...draft, newDesignationId: "21" }, TODAY)).toMatchObject({
      errors: [],
      designationChanges: true,
      departmentChanges: false,
    });
    expect(checkPromotion(e, { ...draft, newDepartmentId: "11" }, TODAY)).toMatchObject({
      errors: [],
      departmentChanges: true,
    });
    // choosing today's designation again next to a real department change is still a valid promotion
    expect(checkPromotion(e, { ...draft, newDesignationId: "20", newDepartmentId: "11" }, TODAY).errors).toEqual([]);
  });

  it("needs a real effective date", () => {
    expect(checkPromotion(e, { ...draft, newDesignationId: "21", effectiveDate: "" }, TODAY).errors).toEqual([
      "Pick the effective date.",
    ]);
  });

  it("warns, without stopping, about dates that look wrong", () => {
    const before = checkPromotion(e, { ...draft, newDesignationId: "21", effectiveDate: "2019-12-31" }, TODAY);
    expect(before.errors).toEqual([]);
    expect(before.warnings).toEqual(["The effective date is before their joining date."]);
    const earlier = checkPromotion(
      e,
      { ...draft, newDesignationId: "21", effectiveDate: "2026-01-01" },
      TODAY,
      "2026-02-01",
    );
    expect(earlier.warnings).toEqual(["The effective date is earlier than their last promotion."]);
    const future = checkPromotion(e, { ...draft, newDesignationId: "21", effectiveDate: "2026-12-01" }, TODAY);
    expect(future.warnings[0]).toContain("in the future");
  });
});

describe("employeeTimeline", () => {
  it("lists promotions newest first and ends with the position they joined in", () => {
    const records = [
      promo({ id: 1, effectiveDate: "2023-01-01", previousDesignation: "Helper", newDesignation: "Operator" }),
      promo({ id: 2, effectiveDate: "2026-02-01", previousDesignation: "Operator", newDesignation: "Supervisor" }),
    ];
    const t = employeeTimeline(
      { joinDate: "2020-01-01", designationTitle: "Supervisor", departmentName: "Stitching" },
      records,
    );
    expect(t.map((x) => x.kind)).toEqual(["promotion", "promotion", "joined"]);
    expect(t.map((x) => x.date)).toEqual(["2026-02-01", "2023-01-01", "2020-01-01"]);
    expect(t[2]).toMatchObject({ designation: "Helper", department: "Stitching" });
  });

  it("with no promotions, they joined in the position they hold", () => {
    const t = employeeTimeline({ joinDate: null, designationTitle: "Operator", departmentName: "Cutting" }, []);
    expect(t).toEqual([{ kind: "joined", date: null, designation: "Operator", department: "Cutting" }]);
  });
});
