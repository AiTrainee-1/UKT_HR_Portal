import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCTION_SKIPPED, REAL_REASONS } from "./fixtures";
import {
  NO_SKIP_FILTERS,
  SKIP_CATEGORY_ORDER,
  SKIP_GUIDE,
  classifySkipReason,
  classifySkipped,
  filterSkipped,
  skipCategoryCards,
  skipFiltersActive,
  skipSummary,
  skippedExportColumns,
} from "./skipped-logic";
import type { SkipCategory, SkippedItem } from "./skipped-types";

// The links must be pages that exist: App.tsx is read, and every address a fix points at must match one of its routes.
// (`relative` is a variable on purpose: Vite turns a literal `new URL("...", import.meta.url)` into an asset address.)
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const APP = read("../../../../App.tsx");
const ROUTES = [...APP.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
const routeExists = (href: string) => {
  const path = href.split(/[?#]/)[0];
  return ROUTES.some((pattern) => new RegExp(`^${pattern.replace(/:[^/]+\??/g, "[^/]+")}$`).test(path));
};

describe("what each real skip reason means", () => {
  for (const { reason, category, kind } of REAL_REASONS) {
    it(`${kind}: "${reason}" is ${category}`, () => {
      const info = classifySkipReason(reason);
      expect(info.category).toBe(category);
      expect(info.label).toBe(SKIP_GUIDE[category].label);
      expect(info.fix.length).toBeGreaterThan(20);
      expect(info.tone).toBe(SKIP_GUIDE[category].tone);
    });
  }

  it("covers every category the panel can show", () => {
    const seen = new Set(REAL_REASONS.map((r) => r.category));
    expect([...seen].sort()).toEqual([...SKIP_CATEGORY_ORDER].sort());
  });

  it("is not thrown by case, spacing or a trailing full stop", () => {
    expect(classifySkipReason("  NO SALARY AMOUNT SET on this employee's profile ").category).toBe("no_salary");
    expect(classifySkipReason("Not  assigned  to the Weekly cycle (assigned to   no pay cycle)").category).toBe(
      "no_cycle",
    );
    expect(classifySkipReason("already paid for this period").category).toBe("already_paid");
  });

  it("calls anything else Other, and an empty reason too", () => {
    for (const reason of [
      "",
      "   ",
      "Something nobody has seen",
      "Salary missing",
      "'NoneType' object has no attribute 'x'",
    ]) {
      const info = classifySkipReason(reason);
      expect(info.category).toBe("other");
      expect(info.label).toBe("Other");
      expect(info.blocksPay).toBe(true);
    }
    expect(classifySkipReason(undefined as unknown as string).category).toBe("other");
  });

  it("links a missing salary or rate to the employee's own profile, or to the list when the id is not known", () => {
    expect(classifySkipReason("No Salary Amount set on this employee's profile")).toMatchObject({
      href: "/hr/employees",
      hrefLabel: "Open Employees",
    });
    expect(classifySkipReason("No Salary Amount set on this employee's profile", 7)).toMatchObject({
      href: "/hr/employees/7/edit",
      hrefLabel: "Open profile",
    });
    expect(classifySkipReason("No Salary Per Shift set on this employee's profile")).toMatchObject({
      href: "/hr/employees/productionEmployee",
      hrefLabel: "Open Production Employees",
    });
    expect(classifySkipReason("No Salary Per Shift set on this employee's profile", 9).href).toBe(
      "/hr/employees/9/edit",
    );
    expect(classifySkipReason("Not an active employee.", 5).href).toBe("/hr/employees/5/edit");
    expect(classifySkipReason("division by zero", 5)).toMatchObject({
      href: "/hr/employees/5",
      hrefLabel: "Open employee",
    });
  });

  it("points no working days at the shift and the holidays, naming the month", () => {
    const info = classifySkipReason(
      "No working days found in 10/2026 for this employee's shift (check Holidays and Saturday-off configuration)",
      3,
    );
    expect(info.fix).toContain("October 2026");
    expect(info.href).toBe("/hr/shifts");
    expect(info.hrefLabel).toBe("Open Manage Shifts");
    expect(info.secondary).toEqual({ href: "/hr/leave?tab=holidays", label: "Holidays" });
    // a message without the month still classifies
    expect(classifySkipReason("No working days found").fix).toContain("the month");
  });

  it("names the other payslip an overlap is with", () => {
    const info = classifySkipReason("Overlaps the payroll already generated for 2026-02-01 to 2026-02-14.");
    expect(info.fix).toContain("1 Feb - 14 Feb 2026");
    expect(info.href).toBeUndefined();
    expect(info.blocksPay).toBe(true);
  });

  it("says which cycle they are on and which they should be on", () => {
    const wrong = classifySkipReason("Not assigned to the Weekly cycle (assigned to BiWeekly).");
    expect(wrong.category).toBe("wrong_cycle");
    expect(wrong.fix).toContain("They are on BiWeekly, not Weekly");
    expect(wrong.fix).toContain("generate them from the BiWeekly page");
    expect(wrong.href).toBe("/hr/employees/productionEmployee");

    const none = classifySkipReason("Not assigned to the Monthly cycle (assigned to no pay cycle).");
    expect(none.category).toBe("no_cycle");
    expect(none.fix).toContain("Assign them to Monthly on Production Employees");
    expect(none.href).toBe("/hr/employees/productionEmployee");
  });

  it("says an already paid employee has nothing to fix, and is not left unpaid", () => {
    const info = classifySkipReason("Already paid for this period.");
    expect(info.blocksPay).toBe(false);
    expect(info.tone).toBe("info");
    expect(info.href).toBeUndefined();
    expect(info.fix).toMatch(/^Nothing to fix/);
    const others = REAL_REASONS.filter((r) => r.category !== "already_paid");
    expect(others.every((r) => classifySkipReason(r.reason).blocksPay)).toBe(true);
  });

  it("sends a staff employee found on a production page to Staff Payroll", () => {
    expect(classifySkipReason("Not a production employee in your scope.")).toMatchObject({
      category: "not_production",
      href: "/hr/payroll",
      hrefLabel: "Open Staff Payroll",
    });
  });
});

describe("the fix links", () => {
  const links = (): string[] => {
    const out = new Set<string>();
    for (const category of SKIP_CATEGORY_ORDER) {
      const guide = SKIP_GUIDE[category];
      if (guide.href) out.add(guide.href);
      if (guide.secondary) out.add(guide.secondary.href);
    }
    for (const { reason } of REAL_REASONS) {
      for (const id of [undefined, 77]) {
        const info = classifySkipReason(reason, id);
        if (info.href) out.add(info.href);
        if (info.secondary) out.add(info.secondary.href);
      }
    }
    return [...out];
  };

  it("are all real routes of the app", () => {
    expect(ROUTES.length).toBeGreaterThan(40); // the route table was found
    const all = links();
    expect(all.length).toBeGreaterThanOrEqual(7);
    for (const href of all) expect(routeExists(href), `${href} is not a route in App.tsx`).toBe(true);
  });

  it("the routes the fixes rely on are the ones the brief names", () => {
    const all = links();
    for (const wanted of [
      "/hr/employees",
      "/hr/employees/productionEmployee",
      "/hr/employees/77/edit",
      "/hr/shifts",
      "/hr/payroll",
    ]) {
      expect(all).toContain(wanted);
    }
  });

  it("the Holidays link opens a tab the Leave & Holiday page has", () => {
    expect(read("../../../../pages/hr/LeaveHoliday.tsx")).toMatch(/TABS = \[[^\]]*"holidays"/);
  });

  it("give every category some advice", () => {
    for (const category of SKIP_CATEGORY_ORDER) {
      expect(SKIP_GUIDE[category].label.length).toBeGreaterThan(2);
      expect(SKIP_GUIDE[category].fix.length).toBeGreaterThan(20);
    }
  });
});

describe("the skipped employees as a list", () => {
  it("are classified, grouped by category in a fixed order, then by name", () => {
    const rows = classifySkipped(PRODUCTION_SKIPPED);
    expect(rows.map((r) => [r.info.category, r.name])).toEqual([
      ["no_rate", "Mani Selvam"],
      ["no_rate", "Ravi Kumar"],
      ["wrong_cycle", "Kumar Raj"],
      ["overlap", "Selvi Rani"],
      ["already_paid", "Lakshmi Devi"],
      ["other", "Mystery Worker"],
    ]);
    // each carries the link to their own profile
    expect(rows[0].info.href).toBe("/hr/employees/42/edit");
  });

  it("list one employee once, and nothing for nothing", () => {
    const twice = [PRODUCTION_SKIPPED[0], { ...PRODUCTION_SKIPPED[0], reason: "something else" }];
    expect(classifySkipped(twice)).toHaveLength(1);
    expect(classifySkipped(undefined)).toEqual([]);
    expect(classifySkipped([])).toEqual([]);
  });

  it("make a card for each category that occurs, the biggest first", () => {
    const cards = skipCategoryCards(classifySkipped(PRODUCTION_SKIPPED));
    expect(cards.map((c) => [c.category, c.count])).toEqual([
      ["no_rate", 2],
      ["wrong_cycle", 1],
      ["overlap", 1],
      ["already_paid", 1],
      ["other", 1],
    ]);
    expect(cards[0]).toMatchObject({
      label: "No salary per shift",
      href: "/hr/employees/productionEmployee",
      hrefLabel: "Open Production Employees",
      blocksPay: true,
    });
    expect(cards[0].fix).toBe(SKIP_GUIDE.no_rate.fix); // the general advice, not one person's
    expect(skipCategoryCards([])).toEqual([]);
  });

  it("break a tie between categories by the fixed order", () => {
    const a: SkippedItem = { employeeId: 1, employeeCode: "A", name: "A", reason: "Already paid for this period." };
    const b: SkippedItem = {
      employeeId: 2,
      employeeCode: "B",
      name: "B",
      reason: "No Salary Amount set on this employee's profile",
    };
    expect(skipCategoryCards(classifySkipped([a, b])).map((c) => c.category)).toEqual(["no_salary", "already_paid"]);
  });

  it("are searched by name, code, department, reason or category, every word having to match", () => {
    const rows = classifySkipped(PRODUCTION_SKIPPED);
    const names = (q: string, category = "") => filterSkipped(rows, { q, category }).map((r) => r.name);
    expect(names("")).toHaveLength(6);
    expect(names("ravi")).toEqual(["Ravi Kumar"]);
    expect(names("pw-3")).toEqual(["Selvi Rani"]);
    expect(names("weaving")).toEqual(["Mani Selvam", "Ravi Kumar", "Lakshmi Devi"]);
    expect(names("biweekly")).toEqual(["Kumar Raj"]); // the reason
    expect(names("no salary")).toEqual(["Mani Selvam", "Ravi Kumar"]); // the reason / category
    expect(names("weaving shift")).toEqual(["Mani Selvam", "Ravi Kumar"]);
    expect(names("zzz")).toEqual([]);
    expect(names("", "overlap")).toEqual(["Selvi Rani"]);
    expect(names("kumar", "no_rate")).toEqual(["Ravi Kumar"]);
    expect(names("", "no_salary")).toEqual([]);
  });

  it("counts the filters that are on", () => {
    expect(skipFiltersActive(NO_SKIP_FILTERS)).toBe(0);
    expect(skipFiltersActive({ q: "  ", category: "" })).toBe(0);
    expect(skipFiltersActive({ q: "a", category: "" })).toBe(1);
    expect(skipFiltersActive({ q: "a", category: "overlap" })).toBe(2);
  });
});

describe("the banner", () => {
  const some = (n: number, reason = "No Salary Amount set on this employee's profile"): SkippedItem[] =>
    Array.from({ length: n }, (_, i) => ({ employeeId: i + 1, employeeCode: `E${i}`, name: `Person ${i}`, reason }));

  it("says nobody is skipped, with how many were checked", () => {
    expect(skipSummary([], 42, "October 2026")).toEqual({
      tone: "success",
      title: "Nobody is skipped",
      hint: "All 42 employees can be paid for October 2026.",
      count: 0,
    });
    expect(skipSummary(undefined, 1, "October 2026").hint).toBe("All 1 employee can be paid for October 2026.");
    expect(skipSummary([], 0, "October 2026").hint).toBe("There are no employees to check for October 2026.");
    expect(skipSummary([], undefined, "2 Feb - 8 Feb 2026").hint).toBe("Everyone can be paid for 2 Feb - 8 Feb 2026.");
  });

  it("says how many of those checked are skipped, and that they are not paid until it is fixed", () => {
    expect(skipSummary(some(5), 42, "October 2026")).toEqual({
      tone: "danger",
      title: "5 of 42 employees were skipped",
      hint: "No payroll is generated for them for October 2026, so they are not paid until each reason below is fixed.",
      count: 5,
    });
  });

  it("reads right for one employee, and without a total", () => {
    const one = skipSummary(some(1), 42, "October 2026");
    expect(one.title).toBe("1 of 42 employees was skipped");
    expect(one.hint).toBe(
      "No payroll is generated for this employee for October 2026, so they are not paid until the reason below is fixed.",
    );
    expect(skipSummary(some(2), undefined, "October 2026").title).toBe("2 employees were skipped");
    expect(skipSummary(some(1), undefined, "October 2026").title).toBe("1 employee was skipped");
    // a total smaller than the count cannot be right, so it is not quoted
    expect(skipSummary(some(3), 2, "October 2026").title).toBe("3 employees were skipped");
  });

  it("is only a note when everyone skipped is already paid", () => {
    const paid = skipSummary(some(2, "Already paid for this period."), 10, "2 Feb - 8 Feb 2026");
    expect(paid.tone).toBe("info");
    expect(paid.hint).toBe("Nothing is left to pay for them for 2 Feb - 8 Feb 2026.");
    // one person who is not paid is enough to make it an alarm
    const mixed = skipSummary(
      [...some(1, "Already paid for this period."), { ...some(1)[0], employeeId: 99 }],
      10,
      "p",
    );
    expect(mixed.tone).toBe("danger");
  });

  it("counts an employee once however many times they are listed", () => {
    expect(skipSummary([...some(2), ...some(2)], 10, "p").count).toBe(2);
  });
});

describe("the export", () => {
  it("has a row per employee with the reason and how to fix it", () => {
    expect(skippedExportColumns.map((c) => c.label)).toEqual([
      "Employee code",
      "Employee",
      "Department",
      "Reason",
      "Category",
      "How to fix",
    ]);
    const [row] = classifySkipped(PRODUCTION_SKIPPED);
    expect(Object.fromEntries(skippedExportColumns.map((c) => [c.label, c.value?.(row)]))).toEqual({
      "Employee code": "PW-2",
      Employee: "Mani Selvam",
      Department: "Weaving",
      Reason: "No Salary Per Shift set on this employee's profile",
      Category: "No salary per shift",
      "How to fix": SKIP_GUIDE.no_rate.fix,
    });
  });

  it("leaves the department empty when the employee has none", () => {
    const mystery = classifySkipped(PRODUCTION_SKIPPED).find((r) => r.name === "Mystery Worker")!;
    expect(skippedExportColumns.find((c) => c.label === "Department")?.value?.(mystery)).toBe("");
  });

  it("has the categories in the order the cards use", () => {
    const order: SkipCategory[] = [...SKIP_CATEGORY_ORDER];
    expect(new Set(order).size).toBe(order.length);
    expect(order).toHaveLength(Object.keys(SKIP_GUIDE).length);
  });
});
