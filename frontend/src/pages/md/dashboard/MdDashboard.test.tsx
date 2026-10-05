import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { closeAssistant, getAssistantState } from "@/lib/md/assistant-store";
import MdDashboard from "../MdDashboard";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import {
  emptyOverview,
  emptyTrends,
  ME,
  overview,
  overviewWithFailedPayroll,
  overviewWithFailedUnits,
  trends,
  trendsWithFailedPayroll,
  UNITS_WITH_LATE,
} from "./fixtures";
import { BRIEFING_QUESTION } from "./logic";

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
  closeAssistant();
});

const PATH = "/md/dashboard";

const data: Fixtures = {
  "/api/md/me": ME,
  "/api/md/dashboard/overview": overview,
  "/api/md/dashboard/trends": trends,
};

const refused = (message: string) => ({ status: 400, body: { error: message } }); // a 4xx is never retried by the hook

const byTestId = (p: RenderedPage, id: string) => p.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const textOf = (p: RenderedPage, id: string) => byTestId(p, id)?.textContent ?? null;
const count = (p: RenderedPage, needle: string) => p.requests().filter((r) => r.includes(needle)).length;

describe("MdDashboard", () => {
  it("answers 'how is the company today, what changed, what needs me' on one page", async () => {
    page = await renderMdPage(MdDashboard, data, { path: PATH });
    const text = page.text();

    // the hero: greeting by the factory's clock, the date, when the numbers were made
    expect(textOf(page, "md-page-title")).toBe("Good afternoon, Murugan");
    expect(textOf(page, "md-dashboard-date")).toBe("Monday, 5 October 2026");
    expect(textOf(page, "md-updated")).toContain("Numbers as of 2:10 pm");
    expect(byTestId(page, "md-brief-me")?.textContent).toContain("Brief me");

    // the briefing: plain sentences with numbers, each with the page it came from
    expect(text).toContain("Today's briefing");
    for (const sentence of overview.briefing.sentences) {
      expect(textOf(page, `md-briefing-${sentence.id}`)).toContain(sentence.text);
    }
    expect(page.container.querySelectorAll('[data-testid^="md-briefing-"] a').length).toBe(6);
    expect(byTestId(page, "md-briefing-payroll")?.querySelector("a")?.getAttribute("href")).toBe("/md/payroll");
    expect(byTestId(page, "md-briefing-weakest")?.getAttribute("data-tone")).toBe("watch");

    // the eight cards, each the page's own figure
    const values: Record<string, string> = {
      "employees.headcount": "1,240",
      "attendance-today": "90.3%",
      "absenteeism-30d": "4.2%",
      "employees.attrition-12m": "14.2%",
      "payroll-gross": "₹2.4 Cr",
      "payroll-overtime": "₹15 L",
      "recruitment.open_positions": "12",
      "visitors-today": "18",
    };
    for (const [id, value] of Object.entries(values)) expect(textOf(page, `kpi-${id}-value`)).toBe(value);
    expect(page.container.querySelectorAll('[data-testid="md-dashboard-kpis"] [role="button"]').length).toBe(8);
    expect(textOf(page, "kpi-absenteeism-30d")).toContain("+0.4 pts"); // a percentage moves in points

    // exceptions first
    expect(textOf(page, "md-dashboard-attention")).toContain("Needs your attention");
    expect(page.container.querySelectorAll('[data-testid="md-dashboard-attention"] [data-severity]').length).toBe(5);
    const severities = Array.from(
      page.container.querySelectorAll<HTMLElement>('[data-testid="md-dashboard-attention"] [data-severity]'),
    ).map((el) => el.dataset.severity);
    expect(severities).toEqual(["critical", "warning", "warning", "info", "good"]);
    expect(text).toContain("Stitching absenteeism is 14%, double its 90-day average");
    expect(textOf(page, "md-dashboard-attention-more")).toContain("And 2 more");

    // today by unit
    const units = textOf(page, "md-dashboard-units") ?? "";
    expect(units).toContain("Provisional · as of 2:10 pm · the day is still running");
    expect(textOf(page, "md-dashboard-units-total")).toBe("90.3%");
    expect(units).toContain("Unit 1");
    expect(units).toContain("595 of 700 in · 95 not in yet · 10 on leave");
    expect(units).toContain("480 of 490 in · 10 on leave");
    expect(textOf(page, "md-dashboard-units-weakest")).toContain("Stitching, 82.5% (330 of 400 in)");
    expect(units).toContain("Late arrivals are shown once HR's attendance records for today are ready.");

    // trends
    expect(text).toContain("Attendance, last 30 days");
    expect(text).toContain("Payroll, last 12 months");
    expect(text).toContain("Joiners and leavers, last 12 months");
    expect(textOf(page, "md-dashboard-trend-attendance-chips")).toContain("Average 93.4%");
    expect(textOf(page, "md-dashboard-trend-attendance-chips")).toContain("Absent 4.2%");
    expect(textOf(page, "md-dashboard-trend-payroll-chips")).toContain("Sep 2026: ₹2.4 Cr");
    expect(textOf(page, "md-dashboard-trend-movement-chips")).toContain("165 joined · 177 left · net -12");
    expect(textOf(page, "md-dashboard-trend-movement-chips")).toContain("Headcount now 1,240");

    // explore: a tile for every other page, with its own summary
    expect(page.container.querySelectorAll('[data-testid^="md-explore-"]').length).toBe(8);
    expect(textOf(page, "md-explore-payroll")).toContain("Payroll cost and its trend");
    expect(byTestId(page, "md-explore-payroll")?.querySelector("a")?.getAttribute("href")).toBe("/md/payroll");
    expect(text).toContain("Ask about this");
  });

  it("asks for each part once: the overview first, the trends on their own", async () => {
    page = await renderMdPage(MdDashboard, data, { path: PATH });
    expect(count(page, "/api/md/dashboard/overview")).toBe(1);
    expect(count(page, "/api/md/dashboard/trends")).toBe(1);
    expect(page.requests().filter((r) => r.includes("branch="))).toEqual([]); // the Dashboard is company-wide
  });

  it("opens the assistant with the briefing question from 'Brief me'", async () => {
    page = await renderMdPage(MdDashboard, data, { path: PATH });
    expect(getAssistantState().open).toBe(false);
    await page.click('[data-testid="md-brief-me"]');
    expect(getAssistantState().open).toBe(true);
    expect(getAssistantState().prompt?.text).toBe(BRIEFING_QUESTION);
    expect(getAssistantState().prompt?.text).toBe("Give me a briefing on how the company is doing today");
  });

  it("offers the full briefing, and a question for every card and tile", async () => {
    page = await renderMdPage(MdDashboard, data, { path: PATH });
    const asks = Array.from(page.container.querySelectorAll<HTMLElement>('[data-testid="ask-ai"]'));
    const full = asks.find((el) => el.textContent?.includes("Ask AI for the full briefing"));
    expect(full).toBeDefined();
    await act(async () => full!.click());
    expect(getAssistantState().prompt?.text).toBe(overview.briefing.ask);
    expect(asks.filter((el) => el.textContent?.includes("Ask about this")).length).toBe(8);
    expect(asks.length).toBeGreaterThanOrEqual(8 + 1 + 1 + 1 + 3); // tiles, briefing, attention, units, three charts
    expect(page.container.querySelectorAll('[data-testid="provenance-button"]').length).toBeGreaterThanOrEqual(8);
  });

  it("tells the assistant what it is looking at", async () => {
    page = await renderMdPage(MdDashboard, data, { path: PATH });
    const context = getAssistantState().context;
    expect(context?.page).toBe("dashboard");
    expect(context?.summary?.["Active headcount"]).toBe("1,240");
    expect(context?.summary?.["Attendance today"]).toBe("90.3%");
    expect(context?.filters?.Scope).toBe("Whole company");
  });

  it("shows late arrivals as soon as the server can say how many", async () => {
    page = await renderMdPage(
      MdDashboard,
      { ...data, "/api/md/dashboard/overview": { ...overview, units: UNITS_WITH_LATE } },
      { path: PATH },
    );
    const units = textOf(page, "md-dashboard-units") ?? "";
    expect(units).toContain("30 late");
    expect(units).toContain("11 late");
    expect(textOf(page, "md-dashboard-units-legend")).toContain("Late");
    expect(units).not.toContain("Late arrivals are shown once");
  });

  it("costs one failed page only its own cards, and says which, with a Retry", async () => {
    page = await renderMdPage(
      MdDashboard,
      {
        ...data,
        "/api/md/dashboard/overview": overviewWithFailedPayroll,
        "/api/md/dashboard/trends": trendsWithFailedPayroll,
      },
      { path: PATH },
    );
    const banner = byTestId(page, "md-error");
    expect(banner?.textContent).toContain(
      "Payroll Analysis could not be read just now, so its figures and exceptions are missing from this page.",
    );
    // the briefing, the cards and the exceptions of every other page are intact
    expect(page.text()).not.toContain("Payroll for Sep 2026 came to");
    expect(textOf(page, "kpi-employees.headcount-value")).toBe("1,240");
    expect(textOf(page, "kpi-late-30d-value")).toBe("6%"); // a reserve card took the place
    expect(page.container.querySelector('[data-testid="kpi-payroll-gross"]')).toBeNull();
    expect(page.text()).toContain("Stitching absenteeism is 14%");
    expect(page.text()).not.toContain("12 of 1,200 slips");
    expect(textOf(page, "md-dashboard-units-total")).toBe("90.3%");
    // the payroll chart says so itself; the other two charts still draw
    expect(textOf(page, "md-dashboard-trend-payroll")).toContain("Payroll Analysis could not be loaded just now.");
    expect(textOf(page, "md-dashboard-trend-attendance-chips")).toContain("Average 93.4%");
    expect(textOf(page, "md-dashboard-trend-movement-chips")).toContain("165 joined");
    // Retry asks the overview again
    expect(count(page, "/api/md/dashboard/overview")).toBe(1);
    await page.click('[data-testid="md-error"] button');
    expect(count(page, "/api/md/dashboard/overview")).toBe(2);
  });

  it("retries one chart without touching the rest", async () => {
    page = await renderMdPage(
      MdDashboard,
      { ...data, "/api/md/dashboard/trends": trendsWithFailedPayroll },
      { path: PATH },
    );
    expect(count(page, "/api/md/dashboard/trends")).toBe(1);
    const card = byTestId(page, "md-dashboard-trend-payroll");
    expect(card?.querySelector('[data-testid="md-error"]')).not.toBeNull();
    await page.click('[data-testid="md-dashboard-trend-payroll"] [data-testid="md-error"] button');
    expect(count(page, "/api/md/dashboard/trends")).toBe(2);
    expect(count(page, "/api/md/dashboard/overview")).toBe(1);
  });

  it("shows today by unit's own error inline while everything else answers", async () => {
    page = await renderMdPage(
      MdDashboard,
      { ...data, "/api/md/dashboard/overview": overviewWithFailedUnits },
      { path: PATH },
    );
    const units = byTestId(page, "md-dashboard-units");
    expect(units?.querySelector('[data-testid="md-error"]')?.textContent).toContain(
      "Attendance Analytics could not be loaded just now.",
    );
    expect(units?.textContent).not.toContain("Unit 1");
    expect(textOf(page, "kpi-employees.headcount-value")).toBe("1,240");
    expect(page.text()).toContain("Stitching absenteeism is 14%");
  });

  it("says so when the whole overview cannot be loaded, and still shows the trends and the tiles", async () => {
    page = await renderMdPage(
      MdDashboard,
      { ...data, "/api/md/dashboard/overview": refused("The overview broke.") },
      { path: PATH },
    );
    expect(textOf(page, "md-error")).toContain("The overview: The overview broke.");
    expect(page.container.querySelectorAll('[data-testid="md-dashboard-unavailable"]').length).toBe(3);
    // never claims all is well
    expect(page.text()).not.toContain("Nothing across the company needs your attention");
    // the tiles stop pulsing: dashes, not a loader
    expect(textOf(page, "kpi-employees.headcount-value")).toBe("—");
    expect(page.text()).toContain("Attendance, last 30 days");
    expect(textOf(page, "md-dashboard-trend-attendance-chips")).toContain("Average 93.4%");
    expect(page.container.querySelectorAll('[data-testid^="md-explore-"]').length).toBe(8);
    expect(textOf(page, "md-page-title")).toBe("Good afternoon, Murugan");
    expect(textOf(page, "md-updated")).toContain("Getting the numbers");
  });

  it("says so inside each chart when the trends cannot be loaded, and keeps the overview", async () => {
    page = await renderMdPage(
      MdDashboard,
      { ...data, "/api/md/dashboard/trends": refused("The trends broke.") },
      { path: PATH },
    );
    const cards = ["attendance", "payroll", "movement"].map((k) => byTestId(page!, `md-dashboard-trend-${k}`));
    for (const card of cards) expect(card?.textContent).toContain("The trends broke.");
    expect(textOf(page, "kpi-employees.headcount-value")).toBe("1,240");
    expect(textOf(page, "md-briefing-attendance")).toContain("Attendance is 90.3% so far today");
  });

  it("explains an empty company instead of showing zeros and blank charts", async () => {
    page = await renderMdPage(
      MdDashboard,
      { ...data, "/api/md/dashboard/overview": emptyOverview, "/api/md/dashboard/trends": emptyTrends },
      { path: PATH },
    );
    const text = page.text();
    expect(text).toContain("Nobody is scheduled today");
    expect(text).toContain("No attendance to chart yet");
    expect(text).toContain("No attendance records exist for the days of this period yet.");
    expect(text).toContain("No payroll to chart yet");
    expect(text).toContain("No joiners or leavers yet");
    expect(textOf(page, "md-briefing-exception")).toContain("needs your attention right now");
    // "no data" is a dash, never 0%
    expect(textOf(page, "kpi-attendance-today-value")).toBe("—");
    expect(textOf(page, "kpi-payroll-gross-value")).toBe("—");
    expect(textOf(page, "kpi-employees.headcount-value")).toBe("0");
    const figures = Array.from(page.container.querySelectorAll('[data-testid^="kpi-"][data-testid$="-value"]')).map(
      (el) => el.textContent,
    );
    expect(figures).not.toContain("0%");
    expect(figures.filter((f) => f === "—").length).toBe(4);
    expect(page.container.querySelectorAll('[data-testid="md-error"]').length).toBe(0);
  });

  it("early in the day says people are still arriving and names no weakest department", async () => {
    page = await renderMdPage(
      MdDashboard,
      { ...data, "/api/md/dashboard/overview": { ...overview, settled: false } },
      { path: PATH },
    );
    expect(textOf(page, "md-dashboard-units")).toContain("people are still arriving");
    expect(byTestId(page, "md-dashboard-units-weakest")).toBeNull();
    expect(textOf(page, "md-dashboard-units-total")).toBe("90.3%"); // the count itself is still shown
  });

  it("refreshes the overview and the trends from the hero", async () => {
    page = await renderMdPage(MdDashboard, data, { path: PATH });
    await page.click('[data-testid="md-dashboard-refresh"]');
    expect(count(page, "/api/md/dashboard/overview")).toBe(2);
    expect(count(page, "/api/md/dashboard/trends")).toBe(2);
  });

  it("keeps the Dashboard within a phone: no fixed widths, the grids follow the width of their own container", async () => {
    page = await renderMdPage(MdDashboard, data, { path: PATH });
    const html = page.container.innerHTML;
    expect(html).toContain("@container");
    expect(html).not.toMatch(/style="[^"]*min-width:\s*\d{3,}/);
    expect(page.container.querySelector('[data-testid="md-dashboard-kpis"] .grid')?.className).toContain("grid-cols-2");
  });
});
