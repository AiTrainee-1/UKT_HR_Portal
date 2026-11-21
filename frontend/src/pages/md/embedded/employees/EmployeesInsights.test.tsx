import { cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shiftMonth, thisMonthKey } from "@/components/md/kit/MonthPicker";
import { renderMdPage, type Fixtures, type RenderedPage } from "../../testing/renderMdPage";
import * as fx from "./fixtures";
import EmployeesInsights, { Strip } from "./index";

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

const BASE = "/api/md/employees";
const FIXTURES: Fixtures = {
  [`${BASE}/summary`]: fx.summary,
  [`${BASE}/briefing`]: fx.briefing,
  [`${BASE}/movement`]: fx.movement,
  [`${BASE}/insights`]: fx.attention,
  [`${BASE}/workforce`]: fx.workforce,
  [`${BASE}/composition`]: fx.composition,
  [`${BASE}/people`]: fx.people,
};

const text = (selector: string) => document.body.querySelector(selector)?.textContent ?? "";
const kpi = (id: string) => text(`[data-testid="md-emp-kpi-${id}-value"]`);

async function open(fixtures: Fixtures = FIXTURES) {
  page = await renderMdPage(EmployeesInsights, fixtures, { path: "/md/employees" });
  return page;
}

describe("Employees insights", () => {
  it("shows the summary, the tiles, the groups and what needs attention", async () => {
    await open();
    expect(text('[data-testid="md-emp-sentence-headcount"]')).toBe(
      "120 people are here today: 80 staff and 40 production; 9 of them are Factory Employees.",
    );
    expect([kpi("headcount"), kpi("joiners"), kpi("leavers"), kpi("net")]).toEqual(["120", "6", "4", "+2"]);
    expect([kpi("attrition"), kpi("early"), kpi("factory"), kpi("tenure")]).toEqual(["3.4%", "1", "9", "4.2 yrs"]);
    expect(text('[data-testid="md-emp-kpi-leavers"]')).toContain("1 with an approximate date");
    expect(text('[data-testid="md-emp-factory-list"]')).toContain("Driver");
    expect(text('[data-testid="md-emp-cycles"]')).toContain("2 without a cycle are in no production payroll");
    expect(text('[data-testid="md-emp-statutory-list"]')).toContain("Co Emp (PF and ESI)");
    expect(text('[data-testid="md-emp-departments-list"]')).toContain("Stitching");
    expect(text('[data-testid="md-emp-attention"]')).toContain("Stitching lost 3 people this month");
  });

  it("asks for the running month, then the month before, and keeps the today-figures off the month", async () => {
    const p = await open();
    expect(p.requests().some((r) => r.startsWith(`${BASE}/summary?period=this_month`))).toBe(true);
    expect(p.requests().find((r) => r.startsWith(`${BASE}/workforce`))).toBe(`${BASE}/workforce`);
    await p.click('[data-testid="month-prev"]');
    await p.settle();
    const previous = shiftMonth(thisMonthKey(), -1);
    expect(p.requests().some((r) => r === `${BASE}/summary?month=${previous}`)).toBe(true);
    expect(p.requests().some((r) => r === `${BASE}/movement?month=${previous}`)).toBe(true);
    expect(window.location.search).toContain(`i.month=${previous}`);
  });

  it("opens the people behind a figure", async () => {
    const p = await open();
    await p.click('[data-testid="md-emp-kpi-joiners"]');
    await p.settle();
    expect(text('[data-testid="md-emp-people"]')).toContain("Asha Devi");
    expect(text('[data-testid="md-emp-people"]')).toContain("2 people");
    expect(p.requests().some((r) => r.startsWith(`${BASE}/people?period=this_month&group=joiners`))).toBe(true);
  });

  it("opens the people of a factory label and of a department", async () => {
    const p = await open();
    const driver = [...document.body.querySelectorAll<HTMLElement>('[data-testid="md-emp-factory-list"] button')].find(
      (b) => b.textContent?.includes("Driver"),
    );
    expect(driver).toBeTruthy();
    driver!.click();
    await p.settle();
    expect(text('[data-testid="md-emp-people"]')).toContain("Mani Driver");
    expect(p.requests().some((r) => r.includes("group=factory") && r.includes("value=1"))).toBe(true);
  });

  it("keeps the other cards when one request fails, and says when there is nothing", async () => {
    await open({
      ...FIXTURES,
      [`${BASE}/summary`]: { status: 400, body: { error: "The summary broke." } },
      [`${BASE}/movement`]: { ...fx.movement, points: [] },
    });
    expect(document.body.textContent).toContain("The summary broke.");
    expect(text('[data-testid="md-emp-movement-empty"]')).toContain("Nobody joined or left");
    expect(text('[data-testid="md-emp-factory-list"]')).toContain("Driver");
  });
});

describe("Employees strip", () => {
  it("shows the brief's figures and top exception", async () => {
    page = await renderMdPage(Strip, { "/api/md/brief/employees": fx.brief }, { path: "/md/employees" });
    expect(text('[data-testid="strip-kpi-employees.headcount"]')).toContain("120");
    expect(text('[data-testid="md-emp-strip-insights"]')).toContain("Stitching lost 3 people");
  });

  it("is not drawn when the brief has nothing to say", async () => {
    page = await renderMdPage(Strip, { "/api/md/brief/employees": { ...fx.brief, kpis: [], insights: [] } });
    expect(document.body.querySelector('[data-testid="md-emp-strip"]')).toBeNull();
  });
});
