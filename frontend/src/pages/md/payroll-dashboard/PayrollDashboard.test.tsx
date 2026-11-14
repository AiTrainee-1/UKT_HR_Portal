import { act } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RenderedPage } from "../testing/renderMdPage";
import { EMPTY_MONTHLY, departmentsFixture, monthlyFixture, peopleFixture } from "./fixtures";
import {
  afterSearchPause,
  by,
  choose,
  lastRequest,
  openPayroll,
  quietCharts,
  requestsTo,
  textOf,
  url,
} from "./testing";

beforeAll(quietCharts);
afterAll(() => vi.restoreAllMocks());

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const p = () => page!;
const rows = (testId: string) =>
  [...p().container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"] tbody tr[data-testid^="row-"]`)].filter(
    (r) => r.dataset.testid !== "row-totals",
  );

describe("Monthly tab", () => {
  it("opens on the month the server picked and says where its payroll stands", async () => {
    page = await openPayroll();
    expect(url(p())).toBe("/md/payroll");
    expect(textOf(p(), "md-pay-status-month")).toBe("Oct 2026");
    expect(textOf(p(), "md-pay-status")).toContain("Payment pending");
    expect(by(p(), "md-pay-status")?.dataset.state).toBe("finalized");
    // no month is sent: the server picks the latest month with slips, and the picker names it
    expect(lastRequest(p(), "monthly")?.get("month")).toBeNull();
    expect(lastRequest(p(), "monthly")?.get("months")).toBe("12");
    expect(textOf(p(), "md-pay-month")).toBe("Latest month (Oct 2026)");
  });

  it("shows the nine headline figures, each against the month before", async () => {
    page = await openPayroll();
    const value = (key: string) => textOf(p(), `md-pay-kpi-${key}-value`);
    expect(value("companyCost")).toBe("₹5.7 L");
    expect(value("actualSalary")).toBe("₹3.5 L");
    expect(value("earnedSalary")).toBe("₹5.1 L");
    expect(value("attendanceDeduction")).toBe("₹5,976");
    expect(value("otherDeductions")).toBe("₹33,815");
    expect(value("netPaid")).toBe("₹4.9 L");
    expect(value("clDays")).toBe("5");
    expect(value("clAmount")).toBe("₹3,558");
    expect(value("employees")).toBe("29");
    expect(textOf(p(), "md-pay-kpi-companyCost")).toContain("-2.9%");
    expect(textOf(p(), "md-pay-kpi-attendanceDeduction")).toContain("₹4,683 LOP · ₹1,293 late");
    // cost falling is good news (sage); headcount is neither
    expect(by(p(), "md-pay-kpi-companyCost")?.querySelector(".md-chip-success")).not.toBeNull();
    expect(by(p(), "md-pay-kpi-employees")?.querySelector(".md-chip-success, .md-chip-danger")).toBeNull();
    expect(textOf(p(), "md-pay-kpi-caption")).toContain("Arrows compare Oct 2026 with Sep 2026");
  });

  it("explains what a figure means", async () => {
    page = await openPayroll();
    const button = by(p(), "md-pay-kpi-attendanceDeduction")?.querySelector<HTMLElement>(
      '[data-testid="provenance-button"]',
    );
    expect(button).not.toBeNull();
    button!.setAttribute("data-click", "1");
    await p().click('[data-click="1"]');
    expect(document.body.textContent).toContain("Loss of pay + late / early-out / permission penalties");
  });

  it("compares the month with the one before, line by line", async () => {
    page = await openPayroll();
    expect(textOf(p(), "md-pay-compare")).toContain("Oct 2026 against Sep 2026");
    expect(textOf(p(), "md-pay-compare-companyCost")).toContain("₹5.7 L");
    expect(textOf(p(), "md-pay-compare-companyCost")).toContain("-2.9%");
    expect(textOf(p(), "md-pay-compare-employees")).toContain("was 30");
  });

  it("lists every month, newest first, with a totals row, and opens a month from the table", async () => {
    page = await openPayroll();
    const months = rows("md-pay-month-table").map((r) => r.dataset.testid);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("row-2026-10");
    expect(months.at(-1)).toBe("row-2025-11");
    expect(by(p(), "row-2026-10")?.getAttribute("aria-current")).toBe("true");
    expect(textOf(p(), "row-totals")).toContain("12 months");

    await p().click('[data-testid="row-2026-03"]');
    expect(url(p())).toBe("/md/payroll?month=2026-03");
    expect(lastRequest(p(), "monthly")?.get("month")).toBe("2026-03");
    expect(textOf(p(), "md-pay-status-month")).toBe("Mar 2026");
  });

  it("sorts the month table by a column", async () => {
    page = await openPayroll();
    await p().click('[data-testid="md-pay-month-table"] [data-testid="sort-companyCost"]');
    const values = rows("md-pay-month-table").map((r) => r.dataset.testid);
    const data = monthlyFixture(new URLSearchParams());
    const expected = [...data.months].sort((a, b) => b.companyCost - a.companyCost).map((m) => `row-${m.month}`);
    expect(values).toEqual(expected);
  });

  it("hides and shows a deduction type from the legend", async () => {
    page = await openPayroll();
    const pf = by(p(), "md-pay-deductions-legend-pf")!;
    expect(pf.getAttribute("aria-pressed")).toBe("true");
    await p().click('[data-testid="md-pay-deductions-legend-pf"]');
    expect(by(p(), "md-pay-deductions-legend-pf")?.getAttribute("aria-pressed")).toBe("false");
    await p().click('[data-testid="md-pay-deductions-legend-pf"]');
    expect(by(p(), "md-pay-deductions-legend-pf")?.getAttribute("aria-pressed")).toBe("true");
    // loss of pay dwarfs the slip's own deductions, so it starts hidden and comes back on a tap
    expect(by(p(), "md-pay-deductions-legend-lossOfPay")?.getAttribute("aria-pressed")).toBe("false");
    await p().click('[data-testid="md-pay-deductions-legend-lossOfPay"]');
    expect(by(p(), "md-pay-deductions-legend-lossOfPay")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("picks a month from the month picker", async () => {
    page = await openPayroll();
    await choose(p(), "md-pay-month", "Sep 2026");
    expect(url(p())).toBe("/md/payroll?month=2026-09");
    expect(lastRequest(p(), "monthly")?.get("month")).toBe("2026-09");
    expect(textOf(p(), "md-pay-status-month")).toBe("Sep 2026");
    await choose(p(), "md-pay-month", "Latest month");
    expect(url(p())).toBe("/md/payroll");
  });

  it("sends the unit, department and type to every request", async () => {
    page = await openPayroll();
    await choose(p(), "scope-branch", "Unit 1");
    await choose(p(), "scope-department", "Cutting");
    await choose(p(), "scope-type", "Production");
    expect(url(p())).toBe("/md/payroll?branch=1&department=Cutting&type=production");
    const last = lastRequest(p(), "monthly")!;
    expect([last.get("branch"), last.get("department"), last.get("type")]).toEqual(["1", "Cutting", "production"]);
    // production has no fixed monthly salary: no actual salary, said plainly
    expect(textOf(p(), "md-pay-kpi-actualSalary-value")).toBe("—");
    expect(textOf(p(), "md-pay-kpi-actualSalary")).toContain("production is paid per shift");
  });

  it("says so when there is no payroll at all", async () => {
    page = await openPayroll("/md/payroll", { "/api/md/payroll/monthly": EMPTY_MONTHLY });
    expect(by(p(), "md-pay-monthly-empty")).not.toBeNull();
    expect(textOf(p(), "md-pay-monthly-empty")).toContain("No payroll for this selection");
  });

  it("offers the latest month when the chosen one has no slips", async () => {
    page = await openPayroll("/md/payroll?month=2026-10", {
      "/api/md/payroll/monthly": (params) => ({
        ...monthlyFixture(params),
        current: params.get("month") ? null : monthlyFixture(params).current,
      }),
    });
    expect(textOf(p(), "md-pay-month-empty")).toContain("Nothing was paid for Oct 2026");
    await p().click('[data-testid="md-pay-latest"]');
    expect(url(p())).toBe("/md/payroll");
    expect(by(p(), "md-pay-status")).not.toBeNull();
  });

  it("shows what the server said when the month fails, with a retry", async () => {
    page = await openPayroll("/md/payroll", {
      "/api/md/payroll/monthly": { status: 500, body: { error: "The payroll figures could not be computed." } },
    });
    // a server error is tried once more (useMdQuery) before the page gives up
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1150));
    });
    await p().settle();
    expect(textOf(p(), "md-error")).toContain("The payroll figures could not be computed.");
    expect(by(p(), "md-error")?.querySelector("button")?.textContent).toContain("Retry");
    expect(requestsTo(p(), "monthly")).toHaveLength(2);
  });

  it("still lists the employees when the month list fails", async () => {
    page = await openPayroll("/md/payroll?view=employees", {
      "/api/md/payroll/monthly": { status: 400, body: { error: "Bad month." } },
    });
    expect(textOf(p(), "md-note")).toContain("The list of payroll months could not be loaded");
    // no month to name: the server picks its own
    expect(lastRequest(p(), "people")?.get("month")).toBeNull();
    expect(textOf(p(), "md-pay-people-count-value")).toBe("29");
  });

  it("shows the server's notes", async () => {
    page = await openPayroll("/md/payroll", {
      "/api/md/payroll/monthly": (params) => ({ ...monthlyFixture(params), notes: ["Feb 2026 has no slips."] }),
    });
    expect(textOf(p(), "md-note")).toContain("Feb 2026 has no slips.");
  });
});

describe("Departments tab", () => {
  it("asks for the month the page shows, and compares every department", async () => {
    page = await openPayroll();
    await p().click('[data-testid="md-pay-tab-departments"]');
    expect(url(p())).toBe("/md/payroll?view=departments");
    const req = lastRequest(p(), "department-breakdown")!;
    expect(req.get("month")).toBe("2026-10");
    expect(req.get("department")).toBeNull(); // this tab compares every department
    expect(textOf(p(), "md-pay-dept-count-value")).toBe("5");
    expect(textOf(p(), "md-pay-dept-cost-value")).toBe("₹5.7 L");
    expect(textOf(p(), "md-pay-dept-cost")).toContain("largest: Cutting (29.1%)");
    expect(textOf(p(), "md-pay-dept-attendance-value")).toBe("98.1%");
    // the table: biggest company cost first, a totals row, the change against the month before
    expect(rows("md-pay-dept-table").map((r) => r.dataset.testid)).toEqual([
      "row-Cutting|Unit 1",
      "row-Stitching|Unit 1",
      "row-Maintenance|Unit 1",
      "row-Accounts|Head Office",
      "row-Packing|Unit 1",
    ]);
    expect(textOf(p(), "row-Packing|Unit 1")).toContain("▼ -24.3%");
    expect(textOf(p(), "row-totals")).toContain("All departments");
    expect(textOf(p(), "row-totals")).toContain("100%");
  });

  it("sorts the departments by any column", async () => {
    page = await openPayroll("/md/payroll?view=departments");
    await p().click('[data-testid="md-pay-dept-table"] [data-testid="sort-department"]');
    expect(rows("md-pay-dept-table")[0].dataset.testid).toBe("row-Accounts|Head Office");
    await p().click('[data-testid="md-pay-dept-table"] [data-testid="sort-department"]');
    expect(rows("md-pay-dept-table")[0].dataset.testid).toBe("row-Stitching|Unit 1");
    await p().click('[data-testid="md-pay-dept-table"] [data-testid="sort-employees"]');
    expect(rows("md-pay-dept-table")[0].dataset.testid).toBe("row-Stitching|Unit 1"); // 9 employees
  });

  it("opens a department's employees on the Employees tab", async () => {
    page = await openPayroll("/md/payroll?view=departments&month=2026-09");
    await p().click('[data-testid="row-Stitching|Unit 1"]');
    expect(url(p())).toBe("/md/payroll?view=employees&month=2026-09&department=Stitching");
    const req = lastRequest(p(), "people")!;
    expect([req.get("department"), req.get("month"), req.get("page")]).toEqual(["Stitching", "2026-09", "1"]);
    expect(textOf(p(), "md-pay-people-list")).toContain("employees paid in Sep 2026");
  });

  it("highlights the department the filter chose instead of hiding the others", async () => {
    page = await openPayroll("/md/payroll?view=departments&department=Accounts");
    expect(textOf(p(), "md-pay-dept-chosen")).toContain("Accounts is highlighted");
    expect(by(p(), "row-Accounts|Head Office")?.getAttribute("aria-current")).toBe("true");
    expect(rows("md-pay-dept-table")).toHaveLength(5);
  });

  it("switches what the comparison chart shows", async () => {
    page = await openPayroll("/md/payroll?view=departments");
    expect(by(p(), "md-pay-dept-measure-cost")?.getAttribute("aria-selected")).toBe("true");
    await p().click('[data-testid="md-pay-dept-measure-average"]');
    expect(by(p(), "md-pay-dept-measure-average")?.getAttribute("aria-selected")).toBe("true");
    expect(textOf(p(), "md-pay-dept-legend")).toContain("Average earned salary");
  });

  it("says so when no department was paid, and shows an error with a retry", async () => {
    page = await openPayroll("/md/payroll?view=departments", {
      "/api/md/payroll/department-breakdown": (params) => ({ ...departmentsFixture(params), rows: [] }),
    });
    expect(textOf(p(), "md-pay-dept-empty")).toContain("No department was paid in Oct 2026");
    page.unmount();
    page = await openPayroll("/md/payroll?view=departments", {
      "/api/md/payroll/department-breakdown": { status: 400, body: { error: "Department figures failed." } },
    });
    expect(textOf(p(), "md-error")).toContain("Department figures failed.");
  });
});

describe("Employees tab", () => {
  it("lists the month's employees with their figures, the selection added up above", async () => {
    page = await openPayroll("/md/payroll?view=employees");
    const req = lastRequest(p(), "people")!;
    expect([req.get("month"), req.get("sort"), req.get("dir"), req.get("page"), req.get("pageSize")]).toEqual([
      "2026-10",
      "name",
      "asc",
      "1",
      "25",
    ]);
    expect(textOf(p(), "md-pay-people-count-value")).toBe("29");
    expect(textOf(p(), "md-pay-people-net-value")).toBe("₹4.9 L");
    expect(rows("md-pay-people-table")).toHaveLength(25);
    expect(textOf(p(), "row-101")).toContain("Anitha Raman");
    expect(textOf(p(), "row-101")).toContain("₹31,800");
    expect(textOf(p(), "row-106")).toContain("On hold");
    expect(textOf(p(), "row-103")).toContain("4 periods");
    expect(textOf(p(), "row-totals")).toContain("All 29 matching");
    expect(textOf(p(), "md-pay-pager-range")).toBe("1–25 of 29 employees");
  });

  it("searches by name or code once typing pauses, and starts again at page 1", async () => {
    page = await openPayroll("/md/payroll?view=employees&page=2");
    const before = requestsTo(p(), "people").length;
    await p().type('[data-testid="md-pay-search"]', "stf00");
    // nothing is asked while the MD is still typing
    expect(requestsTo(p(), "people")).toHaveLength(before);
    await afterSearchPause(p());
    expect(url(p())).toBe("/md/payroll?view=employees&q=stf00");
    const req = lastRequest(p(), "people")!;
    expect([req.get("q"), req.get("page")]).toEqual(["stf00", "1"]);
    expect(rows("md-pay-people-table").map((r) => r.dataset.testid)).toEqual([
      "row-101",
      "row-102",
      "row-104",
      "row-106",
      "row-107",
      "row-110",
    ]);
  });

  it("clears the search, and says so when nothing matches", async () => {
    page = await openPayroll("/md/payroll?view=employees&q=zzz");
    expect((by(p(), "md-pay-search") as HTMLInputElement).value).toBe("zzz");
    expect(textOf(p(), "md-pay-people-empty")).toContain("No employee matches “zzz”");
    await p().click('[data-testid="md-pay-clear-search"]');
    expect(url(p())).toBe("/md/payroll?view=employees");
    expect((by(p(), "md-pay-search") as HTMLInputElement).value).toBe("");
    expect(rows("md-pay-people-table")).toHaveLength(25);
  });

  it("sorts on the server by a column header, turning the direction on a second click", async () => {
    page = await openPayroll("/md/payroll?view=employees");
    await p().click('[data-testid="md-pay-people-table"] [data-testid="sort-netPaid"]');
    expect(url(p())).toBe("/md/payroll?view=employees&sort=netPaid");
    expect([lastRequest(p(), "people")?.get("sort"), lastRequest(p(), "people")?.get("dir")]).toEqual([
      "netPaid",
      "desc",
    ]);
    expect(rows("md-pay-people-table")[0].dataset.testid).toBe("row-104"); // Deepak, the highest paid
    await p().click('[data-testid="md-pay-people-table"] [data-testid="sort-netPaid"]');
    expect(url(p())).toBe("/md/payroll?view=employees&sort=netPaid&dir=asc");
    expect(lastRequest(p(), "people")?.get("dir")).toBe("asc");
  });

  it("sorts from the phone's sort control too", async () => {
    page = await openPayroll("/md/payroll?view=employees");
    await choose(p(), "md-pay-sort-by", "Company cost");
    expect(url(p())).toBe("/md/payroll?view=employees&sort=companyCost");
    await p().click('[data-testid="md-pay-sort-dir"]');
    expect(url(p())).toBe("/md/payroll?view=employees&sort=companyCost&dir=asc");
  });

  it("pages through the list", async () => {
    page = await openPayroll("/md/payroll?view=employees");
    expect(by(p(), "md-pay-page-prev")?.hasAttribute("disabled")).toBe(true);
    await p().click('[data-testid="md-pay-page-next"]');
    expect(url(p())).toBe("/md/payroll?view=employees&page=2");
    expect(lastRequest(p(), "people")?.get("page")).toBe("2");
    expect(rows("md-pay-people-table")).toHaveLength(4);
    expect(textOf(p(), "md-pay-pager-range")).toBe("26–29 of 29 employees");
    expect(textOf(p(), "md-pay-page-of")).toBe("Page 2 of 2");
    expect(by(p(), "md-pay-page-next")?.hasAttribute("disabled")).toBe(true);
    await p().click('[data-testid="md-pay-page-prev"]');
    expect(url(p())).toBe("/md/payroll?view=employees");
  });

  it("opens an employee's history and goes back to the list with the same filters", async () => {
    page = await openPayroll("/md/payroll?view=employees&department=Stitching&q=a&sort=netPaid");
    await p().click('[data-testid="row-101"]');
    expect(url(p())).toBe("/md/payroll?employee=101&department=Stitching&q=a&sort=netPaid");
    expect(requestsTo(p(), "people/101").at(-1)?.get("months")).toBe("24");
    expect(textOf(p(), "md-pay-profile-name")).toBe("Anitha Raman");
    expect(by(p(), "md-filter-bar")).toBeNull(); // the history has no list filters
    expect(by(p(), "md-pay-tab-employees")?.getAttribute("aria-selected")).toBe("true");

    await p().click('[data-testid="md-pay-back"]');
    expect(url(p())).toBe("/md/payroll?view=employees&department=Stitching&q=a&sort=netPaid");
    expect((by(p(), "md-pay-search") as HTMLInputElement).value).toBe("a");
    const req = lastRequest(p(), "people")!;
    expect([req.get("department"), req.get("q"), req.get("sort")]).toEqual(["Stitching", "a", "netPaid"]);
  });

  it("opens an employee from a phone card too", async () => {
    page = await openPayroll("/md/payroll?view=employees");
    await p().click('[data-testid="md-pay-person-card-102"]');
    expect(url(p())).toBe("/md/payroll?employee=102");
    expect(textOf(p(), "md-pay-profile-name")).toBe("Bala Murugan");
  });

  it("shows a table on a wide screen and cards on a phone, with a sort control for the phone", async () => {
    page = await openPayroll("/md/payroll?view=employees");
    const table = p().container.querySelector('[data-layout="table"]')!;
    const cards = p().container.querySelector('[data-layout="cards"]')!;
    expect(table.className).toContain("hidden");
    expect(table.className).toContain("@3xl:block");
    expect(cards.className).toContain("@3xl:hidden");
    expect(cards.querySelectorAll("li")).toHaveLength(25);
    expect(by(p(), "md-pay-sort")?.parentElement?.className).toContain("@3xl:hidden");
    // the wide table scrolls inside its own box, never the page
    expect(by(p(), "md-pay-people-table")?.className).toContain("overflow-x-auto");
  });

  it("offers to compare the highest paid when the list is in name order", async () => {
    page = await openPayroll("/md/payroll?view=employees");
    await p().click('[data-testid="md-pay-sort-net"]');
    expect(url(p())).toBe("/md/payroll?view=employees&sort=netPaid");
    expect(by(p(), "md-pay-sort-net")).toBeNull();
  });

  it("shows an error with a retry when the list fails", async () => {
    page = await openPayroll("/md/payroll?view=employees", {
      "/api/md/payroll/people": { status: 400, body: { error: "The people list failed." } },
    });
    expect(textOf(p(), "md-error")).toContain("The people list failed.");
  });

  it("says so when nobody was paid for the selection", async () => {
    page = await openPayroll("/md/payroll?view=employees", {
      "/api/md/payroll/people": (params) => ({ ...peopleFixture(params), total: 0, rows: [] }),
    });
    expect(textOf(p(), "md-pay-people-empty")).toContain("Nobody was paid in Oct 2026");
  });
});

describe("An employee's history", () => {
  it("shows who they are, the totals over the history and every month", async () => {
    page = await openPayroll("/md/payroll?employee=101");
    expect(textOf(p(), "md-pay-profile-header")).toContain("STF001 · Supervisor");
    expect(textOf(p(), "md-pay-profile-chips")).toContain("Stitching");
    expect(textOf(p(), "md-pay-profile-chips")).toContain("Active");
    expect(textOf(p(), "md-pay-profile-salary")).toBe("₹32,000");
    expect(textOf(p(), "md-pay-profile-header")).toContain("14 months: Sep 2025 to Oct 2026");
    expect(textOf(p(), "md-pay-profile-earned-value")).toBe("₹4.4 L");
    expect(textOf(p(), "md-pay-profile-net-value")).toBe("₹4.4 L");
    expect(textOf(p(), "md-pay-profile-cl-value")).toBe("3.5 days");
    const months = rows("md-pay-history-table").map((r) => r.dataset.testid);
    expect(months).toHaveLength(14);
    expect(months[0]).toBe("row-2026-10");
    // the chosen month is highlighted; an HR adjustment is shown with its sign
    expect(by(p(), "row-2026-10")?.getAttribute("aria-current")).toBe("true");
    expect(textOf(p(), "row-2026-09")).toContain("+₹500");
    expect(textOf(p(), "row-2026-10")).toContain("Not paid");
    expect(textOf(p(), "row-totals")).toContain("14 months");
  });

  it("opens a month's details, a production month listing its pay periods", async () => {
    page = await openPayroll("/md/payroll?employee=103");
    expect(textOf(p(), "md-pay-profile-salary")).toBe("₹520 a shift");
    expect(textOf(p(), "row-2026-10")).toContain("4 pay periods");
    expect(by(p(), "md-pay-periods-2026-10")).toBeNull();
    await p().click('[data-testid="md-pay-expand-2026-10"]');
    expect(by(p(), "md-pay-expand-2026-10")?.getAttribute("aria-expanded")).toBe("true");
    const periods = textOf(p(), "md-pay-periods-2026-10");
    expect(periods).toContain("01 Oct – 07 Oct");
    expect(periods).toContain("6 shifts × ₹520");
    expect(periods).toContain("₹3,033");
    // the legend leaves out the actual salary a production worker does not have
    expect(textOf(p(), "md-pay-profile-legend")).not.toContain("Actual salary");
    await p().click('[data-testid="md-pay-expand-2026-10"]');
    expect(by(p(), "md-pay-periods-2026-10")).toBeNull();
  });

  it("shows the history as cards on a phone, each opening every figure of its month", async () => {
    page = await openPayroll("/md/payroll?employee=101");
    const cards = p().container.querySelector('[data-testid="md-pay-history"] [data-layout="cards"]')!;
    expect(cards.className).toContain("@3xl:hidden");
    expect(p().container.querySelector('[data-testid="md-pay-history"] [data-layout="table"]')?.className).toContain(
      "hidden @3xl:block",
    );
    expect(cards.querySelectorAll("li")).toHaveLength(14);
    expect(textOf(p(), "md-pay-history-card-2026-10")).toContain("₹31,800");
    expect(textOf(p(), "md-pay-history-card-2026-09")).not.toContain("Adjustment by HR");
    await p().click('[data-testid="md-pay-history-card-2026-09"] button');
    expect(textOf(p(), "md-pay-history-card-2026-09")).toContain("Adjustment by HR");
    expect(textOf(p(), "md-pay-history-card-2026-09")).toContain("+₹500");
  });

  it("shows a held month as on hold", async () => {
    page = await openPayroll("/md/payroll?employee=106");
    expect(textOf(p(), "row-2026-10")).toContain("On hold");
  });

  it("shows an error and still offers the way back", async () => {
    page = await openPayroll("/md/payroll?employee=999", {
      "/api/md/payroll/people/999": { status: 404, body: { error: "No such employee." } },
    });
    expect(textOf(p(), "md-error")).toContain("No such employee.");
    await p().click('[data-testid="md-pay-back"]');
    expect(url(p())).toBe("/md/payroll?view=employees");
  });

  it("leaves the history when another tab is chosen", async () => {
    page = await openPayroll("/md/payroll?employee=101&month=2026-09");
    await p().click('[data-testid="md-pay-tab-monthly"]');
    expect(url(p())).toBe("/md/payroll?month=2026-09");
    expect(by(p(), "md-pay-profile")).toBeNull();
    expect(textOf(p(), "md-pay-status-month")).toBe("Sep 2026");
  });
});

describe("the page", () => {
  it("keeps the tab in the address and lays the tabs out for a phone", async () => {
    page = await openPayroll();
    expect(by(p(), "md-pay-tab-monthly")?.getAttribute("aria-selected")).toBe("true");
    expect(by(p(), "md-pay-tabs")?.className).toContain("grid-cols-3");
    await p().click('[data-testid="md-pay-tab-employees"]');
    expect(url(p())).toBe("/md/payroll?view=employees");
    expect(by(p(), "md-pay-search")).not.toBeNull(); // the search belongs to the Employees tab
    await p().click('[data-testid="md-pay-tab-monthly"]');
    expect(url(p())).toBe("/md/payroll");
    expect(by(p(), "md-pay-search")).toBeNull();
  });

  it("puts the figure tiles two across on a phone, the odd last one spanning both", async () => {
    page = await openPayroll();
    const grid = by(p(), "md-pay-kpis")!;
    expect(grid.className).toContain("grid-cols-2");
    expect(grid.className).toContain("@max-3xl:[&>*:last-child:nth-child(odd)]:col-span-2");
    expect(grid.children).toHaveLength(9);
  });
});
