import { cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type Fixtures, type RenderedPage } from "../../testing/renderMdPage";
import * as fx from "./fixtures";
import ShiftsInsights, { Strip } from "./index";

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

const BASE = "/api/md/shifts";
const FIXTURES: Fixtures = {
  [`${BASE}/summary`]: fx.summary,
  [`${BASE}/briefing`]: fx.briefing,
  [`${BASE}/coverage`]: fx.coverage,
  [`${BASE}/changes`]: fx.changes,
  [`${BASE}/attendance`]: fx.late,
  [`${BASE}/attention`]: fx.attention,
  [`${BASE}/people`]: fx.people,
};

const text = (selector: string) => document.body.querySelector(selector)?.textContent ?? "";
const kpi = (id: string) => text(`[data-testid="md-shifts-kpi-${id}-value"]`);

async function open(fixtures: Fixtures = FIXTURES) {
  page = await renderMdPage(ShiftsInsights, fixtures, { path: "/md/shifts" });
  return page;
}

describe("Manage Shift insights", () => {
  it("shows staffing today, the production shifts, changes, lateness and attention", async () => {
    await open();
    expect(text('[data-testid="md-shifts-sentence-production"]')).toContain("10 production workers follow");
    expect([kpi("active"), kpi("covered"), kpi("none"), kpi("changes")]).toEqual(["17", "88.2%", "2", "1"]);
    expect([kpi("ending"), kpi("overlap"), kpi("production"), kpi("inUse")]).toEqual(["1", "0", "10", "1 of 1"]);
    expect(text('[data-testid="md-shifts-kpi-production"]')).toContain("1 on a special shift");
    expect(text('[data-testid="md-shifts-coverage-list"]')).toContain("Production shifts (Settings)");
    expect(text('[data-testid="md-shifts-coverage-list"]')).toContain("No shift assigned");
    expect(text('[data-testid="md-shifts-production-defaults"]')).toContain("Night");
    expect(text('[data-testid="md-shifts-production-defaults"]')).toContain("21:00-05:30 (+1)");
    expect(text('[data-testid="md-shifts-special-7"]')).toContain("1 today");
    expect(text('[data-testid="md-shifts-special-starts"]')).toContain(
      "1 production worker was put on a special shift",
    );
    expect(text('[data-testid="md-shifts-late-list"]')).toContain("small sample");
    expect(text('[data-testid="md-shifts-attention"]')).toContain("2 employees have no shift");
  });

  it("sends the month to the period figures and only the scope to today's", async () => {
    const p = await open();
    expect(p.requests().some((r) => r.startsWith(`${BASE}/changes?period=this_month`))).toBe(true);
    expect(p.requests().find((r) => r.startsWith(`${BASE}/coverage`))).toBe(`${BASE}/coverage`);
  });

  it("opens the people without a shift, and on a special shift", async () => {
    const p = await open();
    await p.click('[data-testid="md-shifts-kpi-none"]');
    await p.settle();
    expect(text('[data-testid="md-shifts-people"]')).toContain("Person H");
    expect(text('[data-testid="md-shifts-people"]')).toContain("2 people today");
    expect(p.requests().some((r) => r.startsWith(`${BASE}/people?shift=none`))).toBe(true);
    page?.unmount();
    const q = await open();
    await q.click('[data-testid="md-shifts-special-7"] button');
    await q.settle();
    expect(text('[data-testid="md-shifts-people"]')).toContain("since 01 Oct");
    expect(q.requests().some((r) => r.includes("shift=special-7"))).toBe(true);
  });

  it("says when production is still on templates, and survives a failed card", async () => {
    await open({
      ...FIXTURES,
      [`${BASE}/coverage`]: { ...fx.coverage, production: { ...fx.coverage.production, inForce: false } },
      [`${BASE}/changes`]: { status: 400, body: { error: "The changes broke." } },
    });
    expect(text('[data-testid="md-shifts-production-off"]')).toContain("not in force");
    expect(document.body.textContent).toContain("The changes broke.");
    expect(text('[data-testid="md-shifts-coverage-list"]')).toContain("General");
  });

  it("says when nothing changed", async () => {
    await open({ ...FIXTURES, [`${BASE}/changes`]: { ...fx.changes, points: [] } });
    expect(text('[data-testid="md-shifts-changes-empty"]')).toContain("No shift was assigned or changed");
  });
});

describe("Manage Shift strip", () => {
  it("shows employees without a shift and the top exception", async () => {
    page = await renderMdPage(Strip, { "/api/md/brief/shifts": fx.brief }, { path: "/md/shifts" });
    expect(text('[data-testid="strip-kpi-shifts.unassigned"]')).toContain("2");
    expect(text('[data-testid="md-shifts-strip-insights"]')).toContain("2 employees have no shift");
  });
});
