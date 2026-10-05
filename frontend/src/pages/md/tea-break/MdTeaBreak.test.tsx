import { act, cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import MdTeaBreak from "../MdTeaBreak";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import * as fx from "./fixtures";

// jsdom has no layout, so recharts' ResponsiveContainer would draw nothing (and warn). Give the chart a fixed size so the
// page's real chart configuration is rendered and a wrong series or axis setting fails here.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 800, height: 260 }),
  };
});

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

// A page with eight requests, a chart and Radix popovers is slow to settle on a busy machine: leave room.
vi.setConfig({ testTimeout: 30_000 });

const BASE = "/api/md/tea-break";

/** Every endpoint the page calls, answered with the hand-counted company. */
const FIXTURES: Fixtures = {
  [`${BASE}/summary`]: fx.summary,
  [`${BASE}/attention`]: fx.attention,
  [`${BASE}/trend`]: fx.trend,
  [`${BASE}/departments`]: (params: URLSearchParams) =>
    params.get("by") === "unit" ? fx.units : params.get("by") === "type" ? fx.types : fx.departments,
  [`${BASE}/shifts`]: fx.shifts,
  [`${BASE}/heatmap`]: fx.heatmap,
  [`${BASE}/offenders`]: fx.offenders,
  [`${BASE}/rule`]: fx.rule,
};

const EMPTY: Fixtures = {
  [`${BASE}/summary`]: fx.emptySummary,
  [`${BASE}/attention`]: fx.emptyAttention,
  [`${BASE}/trend`]: fx.emptyTrend,
  [`${BASE}/departments`]: fx.emptyBreakdown("department"),
  [`${BASE}/shifts`]: fx.emptyBreakdown("shift"),
  [`${BASE}/heatmap`]: fx.emptyHeatmap,
  [`${BASE}/offenders`]: fx.emptyOffenders,
  [`${BASE}/rule`]: fx.rule,
};

const text = (selector: string) => page?.container.querySelector(selector)?.textContent ?? null;
const kpi = (id: string) => text(`[data-testid="md-tea-break-kpi-${id}-value"]`);

async function open(fixtures: Fixtures = FIXTURES) {
  page = await renderMdPage(MdTeaBreak, fixtures, { path: "/md/tea-break" });
  return page;
}

describe("Tea Break page", () => {
  it("shows the hand-counted figures on every card", async () => {
    const p = await open();
    expect(p.text()).toContain("Is break discipline costing production time?");

    // the strip
    expect(kpi("breaks")).toBe("28");
    expect(kpi("average")).toBe("22.2 min");
    expect(kpi("overrun")).toBe("58.3%");
    expect(kpi("lost")).toBe("3h 20m");
    expect(kpi("within")).toBe("41.7%");
    expect(kpi("repeat")).toBe("2");
    expect(text('[data-testid="md-tea-break-compare"]')).toBe(
      "Changes compare with 18 Aug to 31 Aug 2026, the same number of days just before.",
    );
    expect(p.text()).toContain("14 of 24 breaks ran over");
    expect(p.text()).toContain("≈ 3.3 hours across 14 overruns");

    // what needs attention
    expect(p.container.querySelector('[data-testid="insight-tea-break.trend"]')?.getAttribute("data-severity")).toBe(
      "critical",
    );
    expect(p.text()).toContain("Break overruns rose to 58% from 50%");

    // better or worse
    expect(p.container.querySelector('[data-testid="trend-chart"] svg.recharts-surface')).not.toBeNull();
    const verdict = p.container.querySelector('[data-testid="md-tea-break-verdict"]');
    expect(verdict?.getAttribute("data-verdict")).toBe("worse");
    expect(verdict?.textContent).toContain("Getting worse");
    expect(text('[data-testid="md-tea-break-worst-day"]')).toContain(
      "Worst day: 05 Sep 2026, 45m lost (75% of breaks ran over)",
    );

    // rankings
    const stitching = p.container.querySelector('[data-testid="row-Stitching"]');
    expect(stitching?.textContent).toContain("66.7%");
    expect(stitching?.textContent).toContain("2h 30m");
    expect(stitching?.textContent).toContain("75% of the total");
    expect(stitching?.textContent).toContain("+33.4 pts");
    expect(stitching?.textContent).toContain("2 employees · 100% scan");
    expect(p.container.querySelector('[data-testid="row-__none__"]')?.textContent).toContain("1 employee · 0% scan");
    expect(p.container.querySelector('[data-testid="row-Admin"]')?.textContent).toContain("-100 pts");
    expect(p.container.querySelector('[data-testid="row-2"]')?.textContent).toContain("Evening");
    expect(p.container.querySelector('[data-testid="row-2"]')?.textContent).toContain("14:00–22:00 · Production");
    expect(p.text()).toContain("Morning (Unit 1)");
    expect(p.text()).toContain("No shift assigned");
    expect(p.text()).toContain("Overall: 58.3% of breaks ran over, average 22.2 min.");

    // time of day
    expect(p.container.querySelector('[data-testid="md-tea-break-heatmap-grid"]')).not.toBeNull();
    expect(p.text()).toContain("Busiest half hour: 10:00 (67% of breaks)");
    expect(p.text()).toContain("Highest overrun rate: Sat 10:00 (67%)");

    // people
    expect(p.container.querySelector('[data-testid="row-C"]')?.textContent).toContain("Chitra Test");
    expect(p.container.querySelector('[data-testid="row-C"]')?.textContent).toContain("60 min on 06 Sep");
    expect(p.container.querySelector('[data-testid="row-B"]')?.textContent).toContain("Babu Test");
    expect(text('[data-testid="md-tea-break-offenders-share"]')).toContain(
      "2 people account for 75% of the minutes lost",
    );

    // the rule and the caveats
    expect(text('[data-testid="md-tea-break-allowed"]')).toBe("15");
    expect(text('[data-testid="md-tea-break-legend"]')).toContain("Over 60 min");
    expect(text('[data-testid="md-tea-break-statements"]')).toContain("no grace period");
    expect(text('[data-testid="md-tea-break-coverage"]')).toContain(
      "5 of 6 active employees (83%) scanned at least one break",
    );
  });

  it("asks the server for each card with the chosen period, and nothing it has no fixture for", async () => {
    const p = await open();
    const requests = p.requests();
    for (const url of [
      `${BASE}/summary?period=last_30_days`,
      `${BASE}/attention?period=last_30_days`,
      `${BASE}/trend?period=last_30_days`,
      `${BASE}/departments?period=last_30_days&by=department&limit=25`,
      `${BASE}/shifts?period=last_30_days&limit=25`,
      `${BASE}/heatmap?period=last_30_days`,
      `${BASE}/offenders?period=last_30_days&limit=25`,
      `${BASE}/rule`,
    ]) {
      expect(requests).toContain(url);
    }
  });

  it("changes every figure with the period", async () => {
    const p = await open();
    await p.click('[data-testid="period-bar"] [role="tab"]:nth-of-type(2)'); // Last 7 days
    const requests = p.requests();
    expect(requests).toContain(`${BASE}/summary?period=last_7_days`);
    expect(requests).toContain(`${BASE}/shifts?period=last_7_days&limit=25`);
    expect(requests).toContain(`${BASE}/rule`);
    expect(requests.filter((r) => r === `${BASE}/rule`)).toHaveLength(1); // the rule does not depend on the period
  });

  it("switches the ranking between departments, units and staff vs production", async () => {
    const p = await open();
    expect(p.container.querySelector('[data-testid="row-Stitching"]')).not.toBeNull();
    await p.click('[data-testid="md-tea-break-group-tabs"] [role="tab"]:nth-of-type(2)');
    expect(p.requests()).toContain(`${BASE}/departments?period=last_30_days&by=unit&limit=25`);
    expect(p.container.querySelector('[data-testid="row-Unit 1"]')?.textContent).toContain("60%");
    await p.click('[data-testid="md-tea-break-group-tabs"] [role="tab"]:nth-of-type(3)');
    expect(p.requests()).toContain(`${BASE}/departments?period=last_30_days&by=type&limit=25`);
    expect(p.container.querySelector('[data-testid="row-production"]')?.textContent).toContain("Production");
  });

  it("narrows the whole page to a department when its row is clicked", async () => {
    const p = await open();
    await p.click('[data-testid="row-Stitching"]');
    const requests = p.requests();
    expect(requests).toContain(`${BASE}/summary?period=last_30_days&department=Stitching`);
    expect(requests).toContain(`${BASE}/trend?period=last_30_days&department=Stitching`);
    expect(requests).toContain(`${BASE}/shifts?period=last_30_days&department=Stitching&limit=25`);
    expect(requests).toContain(`${BASE}/offenders?period=last_30_days&department=Stitching&limit=25`);
  });

  it("narrows to a unit by its id, and ignores the group of people who have none", async () => {
    const p = await open();
    await p.click('[data-testid="md-tea-break-group-tabs"] [role="tab"]:nth-of-type(2)');
    await p.click('[data-testid="row-Unit 1"]');
    expect(p.requests()).toContain(`${BASE}/summary?period=last_30_days&branch=1`);
    const before = p.requests().length;
    await p.click('[data-testid="md-tea-break-group-tabs"] [role="tab"]:nth-of-type(1)');
    await p.click('[data-testid="row-__none__"]'); // "No department" is not something to focus on
    expect(
      p
        .requests()
        .slice(before)
        .some((r) => r.includes("department=No")),
    ).toBe(false);
  });

  it("opens the assistant with a question about what the card shows", async () => {
    const p = await open();
    const buttons = p.container.querySelectorAll<HTMLElement>('[data-testid="ask-ai"]');
    expect(buttons.length).toBeGreaterThanOrEqual(7); // the page, the trend, both rankings, the heat map, the people, the rule
    await act(async () => {
      buttons[0].click();
    });
    expect(getAssistantState().open).toBe(true);
    expect(getAssistantState().prompt?.text).toContain("Summarise tea-break discipline (01 Sep – 14 Sep 2026)");
  });

  it("tells the assistant what is on screen", async () => {
    await open();
    const context = getAssistantState().context;
    expect(context?.page).toBe("tea-break");
    expect(context?.filters?.Period).toBe("01 Sep – 14 Sep 2026");
    expect(context?.summary?.["Overrun rate"]).toBe("58.3%");
    expect(context?.summary?.["Minutes lost"]).toBe(200);
    expect(context?.summary?.["Allowed minutes"]).toBe(15);
  });

  it("explains a figure on request", async () => {
    const p = await open();
    await p.click('[data-testid="md-tea-break-kpi-overrun"] [data-testid="provenance-button"]');
    expect(document.body.textContent).toContain("Overrun and overrun rate");
    expect(document.body.textContent).toContain("A break that lasted longer than the 15 minutes HR allows.");
  });

  it("keeps the other cards when one request fails, and says what the server said", async () => {
    const p = await open({
      ...FIXTURES,
      [`${BASE}/offenders`]: { status: 400, body: { error: "'limit' must be a whole number between 1 and 25." } },
    });
    expect(p.container.querySelector('[data-testid="md-tea-break-offenders"] [data-testid="md-error"]')).not.toBeNull();
    expect(p.text()).toContain("'limit' must be a whole number between 1 and 25.");
    expect(kpi("overrun")).toBe("58.3%"); // the strip and the other cards are unaffected
    expect(p.container.querySelector('[data-testid="row-Stitching"]')).not.toBeNull();
    expect(kpi("repeat")).toBe("—"); // the repeat count comes from the failed request
  });

  it("shows an error banner when the summary itself fails", async () => {
    const p = await open({ ...FIXTURES, [`${BASE}/summary`]: { status: 400, body: { error: "No unit called 'X'." } } });
    expect(p.container.querySelector('[data-testid="md-tea-break"] > [data-testid="md-error"]')).not.toBeNull();
    expect(p.text()).toContain("No unit called 'X'.");
  });

  it("says why it is empty when nobody has scanned a break", async () => {
    const p = await open(EMPTY);
    expect(kpi("breaks")).toBe("0");
    expect(kpi("overrun")).toBe("—");
    expect(kpi("lost")).toBe("—");
    expect(kpi("average")).toBe("—");
    expect(p.container.querySelector('[data-testid="insights-empty"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-tea-break-trend-empty"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-tea-break-heatmap-empty"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-tea-break-offenders-empty"]')).not.toBeNull();
    expect(p.text()).toContain("No departments, units or groups to compare for this selection.");
    expect(p.text()).toContain("No shifts to compare for this selection.");
    expect(text('[data-testid="md-tea-break-coverage"]')).toContain("No tea-break scans were recorded");
    expect(text('[data-testid="md-tea-break-allowed"]')).toBe("15"); // the rule is still there
  });

  it("mentions the people who ran over once or twice when nobody is a repeat overrunner", async () => {
    const p = await open({ ...FIXTURES, [`${BASE}/offenders`]: { ...fx.emptyOffenders, overrunners: 4 } });
    expect(text('[data-testid="md-tea-break-offenders-empty"]')).toContain(
      "Nobody ran over their break 3 or more times in this period; 4 people ran over once or twice.",
    );
    expect(p.text()).not.toContain("Showing the");
  });

  it("keeps the unmeasured and coverage caveats where the MD will read them", async () => {
    const p = await open();
    expect(p.text()).toContain("About these figures");
    expect(p.text()).toContain("could not be measured");
  });
});
