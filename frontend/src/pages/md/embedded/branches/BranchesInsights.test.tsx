import { cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type Fixtures, type RenderedPage } from "../../testing/renderMdPage";
import * as fx from "./fixtures";
import BranchesInsights, { Strip } from "./index";

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 800, height: 260 }),
  };
});

vi.setConfig({ testTimeout: 30_000 });

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
  window.history.replaceState(null, "", "/");
});

const BASE = "/api/md/units";
const FIXTURES: Fixtures = {
  [`${BASE}/summary`]: fx.summary,
  [`${BASE}/attention`]: fx.attention,
  [`${BASE}/trend`]: fx.trend,
  [`${BASE}/profile`]: fx.profile,
  "/api/md/employees/people": fx.people,
};

const text = (selector: string) => document.body.querySelector(selector)?.textContent ?? "";

async function open(fixtures: Fixtures = FIXTURES) {
  page = await renderMdPage(BranchesInsights, fixtures, { path: "/md/branches" });
  return page;
}

describe("Branches insights", () => {
  it("shows the company, every unit against it, the trend and what needs attention", async () => {
    await open();
    expect(text('[data-testid="md-units-sentence-units"]')).toContain("The company has 2 units");
    expect(text('[data-testid="md-units-kpi-units-value"]')).toBe("2");
    expect(text('[data-testid="md-units-kpi-units"]')).toContain("120 active people · 9 factory");
    expect(text('[data-testid="md-units-kpi-attendancePct-value"]')).toBe("88%");
    expect(text('[data-testid="md-units-kpi-attendancePct"]')).toContain("+1.5 pts");
    expect(text('[data-testid="md-units-kpi-payrollCost"]')).toContain("Oct 2026, gross");
    expect(text('[data-testid="md-units-row-2-attendancePct"]')).toContain("80%");
    expect(text('[data-testid="md-units-row-2-attendancePct"]')).toContain("-8.0 pts vs company");
    expect(text('[data-testid="md-units-row-1"]')).toContain("6 factory");
    expect(text('[data-testid="md-units-attention"]')).toContain("Unit 2 attendance is 8.0 points below");
  });

  it("draws another figure over time, and keeps it in the address", async () => {
    const p = await open();
    expect(p.requests().some((r) => r.startsWith(`${BASE}/trend?period=this_month&metric=attendancePct`))).toBe(true);
    const late = [...document.body.querySelectorAll<HTMLElement>('[data-testid="md-units-trend-metric"] button')].find(
      (b) => b.textContent === "Late",
    );
    late!.click();
    await p.settle();
    expect(p.requests().some((r) => r.includes("/trend?") && r.includes("metric=latePct"))).toBe(true);
    expect(window.location.search).toContain("i.metric=latePct");
    // the figure is not sent to the summary
    expect(
      p
        .requests()
        .filter((r) => r.startsWith(`${BASE}/summary`))
        .every((r) => !r.includes("metric=")),
    ).toBe(true);
  });

  it("opens a unit's profile and, from a department, its people", async () => {
    const p = await open();
    await p.click('[data-testid="md-units-row-2"]');
    await p.settle();
    expect(p.requests().some((r) => r.startsWith(`${BASE}/profile?`) && r.includes("branch=2"))).toBe(true);
    expect(text('[data-testid="md-units-sheet"]')).toContain("Unit 2");
    expect(text('[data-testid="md-units-sheet-figure-attendancePct"]')).toContain("80%");
    expect(text('[data-testid="md-units-sheet-departments"]')).toContain("Stitching");
    await p.click('[data-testid="md-units-sheet-department-21"] button');
    await p.settle();
    expect(text('[data-testid="md-units-people"]')).toContain("Kavya S");
    expect(
      p
        .requests()
        .some(
          (r) => r.startsWith("/api/md/employees/people?") && r.includes("branch=2") && r.includes("department=21"),
        ),
    ).toBe(true);
  });

  it("keeps working when the trend fails and says when there are no units", async () => {
    await open({
      ...FIXTURES,
      [`${BASE}/trend`]: { status: 400, body: { error: "The trend broke." } },
      [`${BASE}/summary`]: { ...fx.summary, rows: [], unitCount: 0 },
    });
    expect(document.body.textContent).toContain("The trend broke.");
    expect(text('[data-testid="md-units-rows-empty"]')).toContain("Nobody works in this selection");
  });
});

describe("Branches strip", () => {
  it("shows the unit count and the top exception", async () => {
    page = await renderMdPage(Strip, { "/api/md/brief/branches": fx.brief }, { path: "/md/branches" });
    expect(text('[data-testid="strip-kpi-units.count"]')).toContain("2");
    expect(text('[data-testid="md-units-strip-insights"]')).toContain("Unit 2 attendance");
  });
});
