import { describe, expect, it } from "vitest";
import { navChildActive, navGroups, navItemActive } from "./dashboard-sidebar";

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

describe("the Compensation group", () => {
  const compensation = () => row("/hr/compensation");
  const CHILDREN = [
    ["CTC Breakdown", "/hr/compensation/ctc-breakdown"],
    ["OT Detection", "/hr/compensation/ot-detection"],
    ["Compensation Leave", "/hr/compensation/compensation-leave"],
    ["History", "/hr/compensation/history"],
    ["Reports", "/hr/compensation/reports"],
  ];

  it("is a group with the five pages as children, in the owner's order, in the Payroll section", () => {
    expect(compensation().label).toBe("Compensation");
    expect(compensation().children?.map((c) => [c.label, c.path])).toEqual(CHILDREN);
    const payroll = navGroups.find((g) => g.heading === "Payroll")!;
    expect(payroll.items.map((i) => i.label)).toEqual([
      "Staff Payroll",
      "Production Payroll",
      "Compensation",
      "Settlement",
      "Reports",
    ]);
  });

  it("is lit (so open) on every page and every subtab, and not on look-alikes or other pages", () => {
    for (const path of [
      "/hr/compensation/ctc-breakdown",
      "/hr/compensation/ot-detection/type-1",
      "/hr/compensation/ot-detection/type-1/allowance",
      "/hr/compensation/ot-detection/type-2/waiting",
      "/hr/compensation/ot-detection/earlier",
      "/hr/compensation/compensation-leave/holiday-work",
      "/hr/compensation/compensation-leave/holiday-work/claims",
      "/hr/compensation/history/company-windows",
      "/hr/compensation/history/company-windows/early-out",
      "/hr/compensation/reports",
    ]) {
      expect(navItemActive(compensation(), path), path).toBe(true);
    }
    // the bare address redirects, it is not a page of its own
    expect(navItemActive(compensation(), "/hr/compensation")).toBe(false);
    expect(navItemActive(compensation(), "/hr/compensation/history-archive")).toBe(false);
    expect(navItemActive(compensation(), "/hr/reports")).toBe(false);
    expect(navItemActive(row("/hr/reports"), "/hr/compensation/reports")).toBe(false);
  });

  it("lights exactly the child of the page being viewed, on its subtabs too", () => {
    const lit = (path: string) =>
      compensation()
        .children!.filter((c) => navChildActive(c, path))
        .map((c) => c.label);
    expect(lit("/hr/compensation/ctc-breakdown")).toEqual(["CTC Breakdown"]);
    expect(lit("/hr/compensation/ot-detection")).toEqual(["OT Detection"]);
    expect(lit("/hr/compensation/ot-detection/type-2")).toEqual(["OT Detection"]);
    // a nested subtab keeps its page lit, and only its page
    expect(lit("/hr/compensation/ot-detection/type-2/waiting")).toEqual(["OT Detection"]);
    expect(lit("/hr/compensation/compensation-leave/holiday-work/claims")).toEqual(["Compensation Leave"]);
    expect(lit("/hr/compensation/history/company-windows/early-out")).toEqual(["History"]);
    expect(lit("/hr/compensation/compensation-leave/birthdays")).toEqual(["Compensation Leave"]);
    expect(lit("/hr/compensation/history/ot-pay")).toEqual(["History"]);
    expect(lit("/hr/compensation/reports")).toEqual(["Reports"]);
    expect(lit("/hr/compensation/reports-old")).toEqual([]);
    expect(lit("/hr/compensation")).toEqual([]);
  });

  it("leaves the children of every other group lit on their own exact path only", () => {
    const employees = row("/hr/employees").children!;
    const all = employees.find((c) => c.path === "/hr/employees")!;
    const production = employees.find((c) => c.path === "/hr/employees/productionEmployee")!;
    expect(navChildActive(all, "/hr/employees")).toBe(true);
    expect(navChildActive(all, "/hr/employees/productionEmployee")).toBe(false);
    expect(navChildActive(production, "/hr/employees/productionEmployee")).toBe(true);
  });
});

describe("the Outpass / Visitors group", () => {
  const gate = () => row("/hr/outpass-visitors");
  const lit = (path: string) =>
    gate()
      .children!.filter((c) => navChildActive(c, path))
      .map((c) => c.label);

  it("keeps its three entries, in this order, with these addresses", () => {
    expect(gate().label).toBe("Outpass / Visitors");
    expect(gate().children?.map((c) => [c.label, c.path])).toEqual([
      ["Outpass", "/hr/outpass-visitors/outpass"],
      ["Visitors", "/hr/outpass-visitors/visitors"],
      ["Tea Break", "/hr/outpass-visitors/tea-break"],
    ]);
  });

  it("lights the entry of the page being viewed, on its tabs and nested tabs too, and only that entry", () => {
    expect(lit("/hr/outpass-visitors/outpass")).toEqual(["Outpass"]);
    expect(lit("/hr/outpass-visitors/outpass/overview/passes")).toEqual(["Outpass"]);
    expect(lit("/hr/outpass-visitors/outpass/overview/qr-submissions")).toEqual(["Outpass"]);
    expect(lit("/hr/outpass-visitors/outpass/requests")).toEqual(["Outpass"]);
    expect(lit("/hr/outpass-visitors/outpass/in-out")).toEqual(["Outpass"]);
    expect(lit("/hr/outpass-visitors/visitors")).toEqual(["Visitors"]);
    expect(lit("/hr/outpass-visitors/tea-break")).toEqual(["Tea Break"]);
    expect(lit("/hr/outpass-visitors/tea-break/records")).toEqual(["Tea Break"]);
    expect(lit("/hr/outpass-visitors/tea-break/rule")).toEqual(["Tea Break"]);
    expect(lit("/hr/outpass-visitors/outpass-archive")).toEqual([]);
    for (const path of ["/hr/outpass-visitors/outpass/overview/passes", "/hr/outpass-visitors/tea-break/rule"])
      expect(navItemActive(gate(), path), path).toBe(true);
  });
});
