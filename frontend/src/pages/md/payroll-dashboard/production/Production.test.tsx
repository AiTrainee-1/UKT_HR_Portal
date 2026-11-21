import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { inrCompact, num } from "@/lib/md/format";
import type { RenderedPage } from "../../testing/renderMdPage";
import { by, choose, lastRequest, openPayroll, quietCharts, requestsTo, textOf, url } from "../testing";
import { EMPTY_OVERVIEW, overviewFixture, productionFixtures } from "./fixtures";

beforeAll(quietCharts);
afterAll(() => vi.restoreAllMocks());

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const p = () => page!;
const open = (path = "/md/payroll?kind=production", over = {}) =>
  openPayroll(path, { ...productionFixtures(), ...over });
const rows = (testId: string) =>
  [...p().container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"] tbody tr[data-testid^="row-"]`)].filter(
    (r) => r.dataset.testid !== "row-totals",
  );

describe("Staff | Production", () => {
  it("opens Staff by default and switches to Production, keeping the unit", async () => {
    page = await openPayroll("/md/payroll?branch=1", productionFixtures());
    expect(by(p(), "md-payroll")?.dataset.kind).toBe("staff");
    expect(by(p(), "md-pay-kind-staff")?.getAttribute("aria-selected")).toBe("true");
    // the Staff side asks for staff only
    expect(lastRequest(p(), "monthly")?.get("type")).toBe("staff");
    await p().click('[data-testid="md-pay-kind-production"]');
    expect(url(p())).toBe("/md/payroll?kind=production&branch=1");
    expect(by(p(), "md-payroll")?.dataset.kind).toBe("production");
    expect(lastRequest(p(), "production/overview")?.get("branch")).toBe("1");
    await p().click('[data-testid="md-pay-kind-staff"]');
    expect(url(p())).toBe("/md/payroll?branch=1");
  });

  it("opens Production from an older ?type=production link", async () => {
    page = await openPayroll("/md/payroll?type=production", productionFixtures());
    expect(by(p(), "md-pay-production")).not.toBeNull();
  });
});

describe("Production overview", () => {
  it("opens on the cycle and period the server picked and says where the period stands", async () => {
    page = await open();
    expect(lastRequest(p(), "production/overview")?.get("cycle")).toBeNull();
    expect(lastRequest(p(), "production/overview")?.get("periods")).toBe("12");
    expect(textOf(p(), "md-prod-status-period")).toBe("BiWeekly · 22 Oct - 4 Nov 2026");
    expect(by(p(), "md-prod-status")?.dataset.state).toBe("finalized");
    expect(textOf(p(), "md-prod-status")).toContain("Payroll Done");
    expect(by(p(), "md-prod-step-finalized")?.dataset.done).toBe("true");
    expect(by(p(), "md-prod-step-paid")?.dataset.done).toBe("false");
    expect(textOf(p(), "md-prod-parked")).toContain("1 new, 0 moved in");
    // only the cycles that have payroll, the chosen one marked
    expect(by(p(), "md-prod-cycle-biweekly")?.getAttribute("aria-selected")).toBe("true");
    expect(by(p(), "md-prod-cycle-monthly")).toBeNull();
  });

  it("shows the period's headline figures against the period before", async () => {
    page = await open();
    const data = overviewFixture();
    const value = (key: string) => textOf(p(), `md-prod-kpi-${key}-value`);
    expect(value("companyCost")).toBe(inrCompact(data.current!.companyCost));
    expect(value("netPaid")).toBe(inrCompact(data.current!.netPaid));
    expect(value("employees")).toBe(num(data.current!.employees));
    expect(value("bonus")).toBe(inrCompact(500));
    expect(textOf(p(), "md-prod-kpi-bonus")).toContain("+₹600 excess · -₹100 detection");
    expect(textOf(p(), "md-prod-kpi-caption")).toContain("Arrows compare 22 Oct - 4 Nov 2026 with 8 Oct - 21 Oct 2026");
    expect(textOf(p(), "md-prod-compare")).toContain("Against 8 Oct - 21 Oct 2026");
    expect(by(p(), "md-prod-kpis")?.children).toHaveLength(8);
  });

  it("lists the cycle's periods and opens one from the table", async () => {
    page = await open();
    expect(rows("md-prod-period-table").map((r) => r.dataset.testid)).toEqual([
      "row-2026-10-22_2026-11-04",
      "row-2026-10-08_2026-10-21",
      "row-2026-09-24_2026-10-07",
      "row-2026-09-10_2026-09-23",
    ]);
    await p().click('[data-testid="row-2026-10-08_2026-10-21"]');
    expect(url(p())).toBe("/md/payroll?kind=production&cycle=biweekly&period=2026-10-08_2026-10-21");
    const req = lastRequest(p(), "production/overview")!;
    expect([req.get("cycle"), req.get("periodStart"), req.get("periodEnd")]).toEqual([
      "biweekly",
      "2026-10-08",
      "2026-10-21",
    ]);
    expect(by(p(), "md-prod-status")?.dataset.state).toBe("paid");
  });

  it("steps to the older period with the arrow and picks one from the list", async () => {
    page = await open();
    await p().click('[data-testid="md-prod-period-prev"]');
    expect(url(p())).toContain("period=2026-10-08_2026-10-21");
    await choose(p(), "md-prod-period-select", "10 Sep - 23 Sep 2026 · Paid");
    expect(url(p())).toContain("period=2026-09-10_2026-09-23");
    expect(by(p(), "md-prod-period-prev")?.hasAttribute("disabled")).toBe(true);
  });

  it("switches the cycle, starting at its latest period", async () => {
    page = await open("/md/payroll?kind=production&cycle=biweekly&period=2026-10-08_2026-10-21");
    await p().click('[data-testid="md-prod-cycle-weekly"]');
    expect(url(p())).toBe("/md/payroll?kind=production&cycle=weekly");
    expect(lastRequest(p(), "production/overview")?.get("cycle")).toBe("weekly");
    expect(textOf(p(), "md-prod-status-period")).toBe("Weekly · 2 Nov - 8 Nov 2026");
  });

  it("shows production month by month and the year so far", async () => {
    page = await open();
    expect(by(p(), "md-prod-months")).not.toBeNull();
    expect(textOf(p(), "md-prod-months-legend")).toContain("Weekly");
    expect(textOf(p(), "md-prod-months-legend")).toContain("BiWeekly");
    expect(textOf(p(), "md-prod-year")).toContain("2026 so far against 2025");
    expect(textOf(p(), "md-prod-year-last-year")).toContain("no payroll that year");
  });

  it("says so when there is no production payroll", async () => {
    page = await open("/md/payroll?kind=production", { "/api/md/payroll/production/overview": EMPTY_OVERVIEW });
    expect(textOf(p(), "md-prod-empty")).toContain("No production payroll for this selection");
    expect(by(p(), "md-prod-cycles")).toBeNull();
  });

  it("offers the latest period when the chosen one has no payroll", async () => {
    page = await open("/md/payroll?kind=production&cycle=biweekly&period=2026-11-05_2026-11-18");
    expect(by(p(), "md-prod-period-empty")).not.toBeNull();
    await p().click('[data-testid="md-prod-latest"]');
    expect(url(p())).toBe("/md/payroll?kind=production&cycle=biweekly");
  });
});

describe("Production departments", () => {
  it("asks for the period the page shows and opens a department's workers", async () => {
    page = await open("/md/payroll?kind=production&view=departments");
    const req = lastRequest(p(), "production/departments")!;
    expect([req.get("cycle"), req.get("periodStart")]).toEqual(["biweekly", "2026-10-22"]);
    expect(rows("md-prod-dept-table").length).toBe(3);
    expect(textOf(p(), "md-prod-dept-previous")).toContain("8 Oct - 21 Oct 2026");
    await p().click('[data-testid="row-Cutting|Unit 2"]');
    expect(url(p())).toBe("/md/payroll?kind=production&view=workers&department=Cutting");
    expect(lastRequest(p(), "production/people")?.get("department")).toBe("Cutting");
  });
});

describe("Production workers", () => {
  it("lists the period's workers, sorts on the server and pages", async () => {
    page = await open("/md/payroll?kind=production&view=workers");
    expect(rows("md-prod-workers-table").map((r) => r.dataset.testid)).toEqual([
      "row-501",
      "row-502",
      "row-503",
      "row-504",
      "row-505",
      "row-506",
    ]);
    expect(textOf(p(), "md-prod-workers-count")).toContain("6");
    await p().click('[data-testid="md-prod-workers-table"] [data-testid="sort-netPaid"]');
    expect(url(p())).toBe("/md/payroll?kind=production&view=workers&sort=netPaid");
    expect(lastRequest(p(), "production/people")?.get("dir")).toBe("desc");
    expect(textOf(p(), "md-pay-pager-range")).toContain("of 6 workers");
  });

  it("opens a worker's pay periods with the days of the open period, and goes back", async () => {
    page = await open("/md/payroll?kind=production&view=workers");
    await p().click('[data-testid="row-501"]');
    expect(url(p())).toBe("/md/payroll?kind=production&worker=501");
    expect(requestsTo(p(), "production/people/501").at(-1)?.get("periods")).toBe("12");
    expect(textOf(p(), "md-prod-worker-name")).toBe("Kavi Arasu");
    expect(by(p(), "md-filter-bar")).toBeNull();
    expect(p().container.querySelectorAll('[data-testid="md-prod-day"]').length).toBe(3);
    expect(textOf(p(), "md-prod-days")).toContain("Late");
    await p().click('[data-testid="md-prod-worker-back"]');
    expect(url(p())).toBe("/md/payroll?kind=production&view=workers");
  });
});
