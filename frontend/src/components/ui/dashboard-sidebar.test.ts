import { describe, expect, it } from "vitest";
import { navGroups, navItemActive } from "./dashboard-sidebar";

// Which sidebar row is lit for the page being viewed. A payroll's details page has an address of its own, and the
// sidebar has to keep the right group open and lit while the reader is on it.

const row = (path: string) => navGroups.flatMap((g) => g.items).find((item) => item.path === path)!;

describe("navItemActive", () => {
  it("keeps Staff Payroll lit on a staff payroll's details page (a page under a row's path is that row)", () => {
    const staff = row("/hr/payroll");
    expect(navItemActive(staff, "/hr/payroll")).toBe(true);
    expect(navItemActive(staff, "/hr/payroll/details/101")).toBe(true);
    expect(navItemActive(staff, "/hr/production-payroll/details/301")).toBe(false);
  });

  it("keeps the Production Payroll group lit (so open) on a production payroll's details page", () => {
    const production = row("/hr/production-payroll");
    for (const path of [
      "/hr/production-payroll/weekly",
      "/hr/production-payroll/biweekly",
      "/hr/production-payroll/monthly",
      "/hr/production-payroll/details/301",
    ]) {
      expect(navItemActive(production, path), path).toBe(true);
    }
    expect(navItemActive(production, "/hr/payroll/details/101")).toBe(false);
    expect(navItemActive(production, "/hr/payroll")).toBe(false);
  });

  it("only the details pages are added: the bare address and look-alikes do not light the group", () => {
    const production = row("/hr/production-payroll");
    // the bare address redirects to Weekly, it is not a page of its own
    expect(navItemActive(production, "/hr/production-payroll")).toBe(false);
    expect(navItemActive(production, "/hr/production-payroll/details-archive")).toBe(false);
  });

  it("does not change any other group", () => {
    const employees = row("/hr/employees");
    expect(employees.alsoActiveFor).toBeUndefined();
    expect(navItemActive(employees, "/hr/employees/42")).toBe(true);
    expect(navItemActive(employees, "/hr/payroll/details/101")).toBe(false);
    const attendance = row("/hr/attendance");
    expect(navItemActive(attendance, "/hr/attendance/staff")).toBe(true);
    expect(navItemActive(attendance, "/hr/payroll/details/101")).toBe(false);
    // only Production Payroll lists extra pages
    const withExtras = navGroups.flatMap((g) => g.items).filter((item) => item.alsoActiveFor);
    expect(withExtras.map((item) => item.path)).toEqual(["/hr/production-payroll"]);
  });
});
