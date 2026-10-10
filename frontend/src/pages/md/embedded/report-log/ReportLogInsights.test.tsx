import { act, cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import { renderMdPage, type Fixtures, type RenderedPage } from "../../testing/renderMdPage";
import * as fx from "./fixtures";
import ReportLogInsights, { Strip } from "./index";

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

// A tab with seven requests, two charts and Radix popovers is slow to settle on a busy machine: leave room.
vi.setConfig({ testTimeout: 30_000 });

const BASE = "/api/md/reportlog";

/** Every endpoint the tab calls, answered with the hand-counted company. */
const FIXTURES: Fixtures = {
  [`${BASE}/summary`]: fx.summary,
  [`${BASE}/briefing`]: fx.briefing,
  [`${BASE}/attention`]: fx.attention,
  [`${BASE}/trend`]: fx.trend,
  [`${BASE}/gaps`]: fx.gaps,
  [`${BASE}/departments`]: (params: URLSearchParams) =>
    params.get("by") === "unit" ? fx.units : params.get("by") === "type" ? fx.types : fx.departments,
  [`${BASE}/exports`]: fx.exportsData,
};

const EMPTY: Fixtures = {
  [`${BASE}/summary`]: fx.emptySummary,
  [`${BASE}/briefing`]: fx.emptyBriefing,
  [`${BASE}/attention`]: fx.emptyAttention,
  [`${BASE}/trend`]: fx.emptyTrend,
  [`${BASE}/gaps`]: fx.emptyGaps,
  [`${BASE}/departments`]: (params: URLSearchParams) =>
    fx.emptyBreakdown((params.get("by") as "department") ?? "department"),
  [`${BASE}/exports`]: fx.emptyExports,
};

const text = (selector: string) => page?.container.querySelector(selector)?.textContent ?? null;
const kpi = (id: string) => text(`[data-testid="md-reportlog-kpi-${id}-value"]`);
const row = (id: string) => page?.container.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

async function open(fixtures: Fixtures = FIXTURES) {
  page = await renderMdPage(ReportLogInsights, fixtures, { path: "/md/attendance/report-log" });
  return page;
}

describe("Report Log insights", () => {
  it("shows the hand-counted figures on every card", async () => {
    const p = await open();

    // in plain words
    expect(text('[data-testid="md-reportlog-sentence-followup"]')).toContain(
      "9 absences on scheduled days; 44% have an Informed (2)",
    );
    expect(text('[data-testid="md-reportlog-sentence-gaps"]')).toContain("1 day had 2+ absences with nothing marked");
    expect(text('[data-testid="md-reportlog-sentence-limits"]')).toContain("not recorded");

    // the strip
    expect(kpi("absences")).toBe("9");
    expect(kpi("followed")).toBe("44.4%");
    expect(kpi("notInformed")).toBe("2");
    expect(kpi("unmarked")).toBe("5");
    expect(kpi("gaps")).toBe("1");
    expect(kpi("exports")).toBe("6");
    expect(kpi("people")).toBe("2");
    expect(kpi("latest")).toBe("Priya");
    expect(text('[data-testid="md-reportlog-compare"]')).toBe(
      "Changes compare with 31 Aug to 06 Sep 2026, the same number of days just before.",
    );
    expect(text('[data-testid="md-reportlog-kpi-followed"]')).toContain("-22.3 pts");
    expect(text('[data-testid="md-reportlog-kpi-latest"]')).toContain("Daily Attendance Register · 13 Sep, 11:50 pm");

    // what needs attention
    expect(p.container.querySelector('[data-testid="insight-reportlog.unmarked"]')?.getAttribute("data-severity")).toBe(
      "warning",
    );
    expect(p.text()).toContain("5 of 9 absences have no Informed / Not informed call");

    // are absences being followed up
    expect(
      p.container.querySelector(
        '[data-testid="md-reportlog-followup"] [data-testid="trend-chart"] svg.recharts-surface',
      ),
    ).not.toBeNull();
    expect(text('[data-testid="md-reportlog-followup-caption"]')).toBe(
      "5 of 9 absences have no call. Most unmarked on 08 Sep 2026 (2).",
    );

    // the gap calendar
    expect(p.container.querySelector('[data-testid="md-reportlog-gaps-grid"]')).not.toBeNull();
    expect(text('[data-testid="md-reportlog-gaps-grid"]')).toContain("Week of 07 Sep");
    expect(text('[data-testid="md-reportlog-gaps-text"]')).toBe(
      "1 day had 2+ absences and nobody marked any (the latest: 08 Sep 2026). 2 of 5 days with absences have every absence marked.",
    );
    expect(text('[data-testid="md-reportlog-gap-2026-09-08"]')).toBe("Tue 08 Sep 2026: 2 absences, none marked");

    // by department
    expect(row("row-Stitching")).toContain("37.5%");
    expect(row("row-Stitching")).toContain("+166.7%");
    expect(row("row-Stitching")).toContain("-29.2 pts");
    expect(row("row-Stitching")).toContain("3 employees");
    expect(text('[data-testid="md-reportlog-marks-Stitching"]')).toContain("2 informed · 1 not · 5 unmarked");
    expect(row("row-Cutting")).toContain("small sample");
    expect(p.text()).toContain("Overall: 9 absences, 44.4% followed up, 5 not yet marked.");

    // who produces the attendance reports
    expect(text('[data-testid="md-reportlog-exports-line"]')).toBe(
      "6 exports by 2 people on 5 of 7 days (up 2 on 4 before). 2 more exports were of other reports.",
    );
    expect(text('[data-testid="md-reportlog-exports-users"]')).toContain("Priya");
    expect(text('[data-testid="md-reportlog-exports-users"]')).toContain("4 · 67%");
    expect(text('[data-testid="md-reportlog-exports-reports"]')).toContain("Daily Attendance Register");
    expect(text('[data-testid="md-reportlog-exports-reports"]')).toContain("Attendance Search (punch export)");
    expect(text('[data-testid="md-reportlog-exports-latest"]')).toContain(
      "13 Sep, 11:50 pm · Priya · Daily Attendance Register",
    );

    // this period against the previous
    expect(row("md-reportlog-compare-absences")).toContain("9");
    expect(row("md-reportlog-compare-absences")).toContain("+200%");
    expect(row("md-reportlog-compare-followed")).toContain("44.4%");
    expect(row("md-reportlog-compare-followed")).toContain("66.7%");

    // what it cannot tell, and the caveats
    const limits = text('[data-testid="md-reportlog-limits"]') ?? "";
    expect(limits).toContain("What this page cannot tell you");
    expect(limits).toContain("Report Log page itself");
    expect(limits).toContain("failed export");
    expect(page?.container.querySelectorAll('[data-testid="md-reportlog-limits"] li')).toHaveLength(5);
    expect(text('[data-testid="md-reportlog-notes"]')).toContain("the audit trail is not split by unit or department");
  });

  it("asks the server for each card with the chosen period, and the exports for the period only", async () => {
    const p = await open();
    const requests = p.requests();
    for (const url of [
      `${BASE}/summary?period=last_30_days`,
      `${BASE}/briefing?period=last_30_days`,
      `${BASE}/attention?period=last_30_days`,
      `${BASE}/trend?period=last_30_days`,
      `${BASE}/gaps?period=last_30_days`,
      `${BASE}/departments?period=last_30_days&by=department&limit=25`,
      `${BASE}/exports?period=last_30_days&limit=10`,
    ]) {
      expect(requests).toContain(url);
    }
  });

  it("changes every figure with the period", async () => {
    const p = await open();
    await p.click('[data-testid="period-bar"] [role="tab"]:nth-of-type(2)'); // Last 7 days
    const requests = p.requests();
    expect(requests).toContain(`${BASE}/summary?period=last_7_days`);
    expect(requests).toContain(`${BASE}/gaps?period=last_7_days`);
    expect(requests).toContain(`${BASE}/exports?period=last_7_days&limit=10`);
  });

  it("switches the ranking between departments, units and staff vs production", async () => {
    const p = await open();
    expect(p.container.querySelector('[data-testid="row-Stitching"]')).not.toBeNull();
    await p.click('[data-testid="md-reportlog-group-tabs"] [role="tab"]:nth-of-type(2)');
    expect(p.requests()).toContain(`${BASE}/departments?period=last_30_days&by=unit&limit=25`);
    expect(row("row-Unit A")).toContain("44.4%");
    await p.click('[data-testid="md-reportlog-group-tabs"] [role="tab"]:nth-of-type(3)');
    expect(p.requests()).toContain(`${BASE}/departments?period=last_30_days&by=type&limit=25`);
    expect(row("row-Production")).toContain("small sample");
  });

  it("narrows the absence cards to a department when its row is clicked, but not the company-wide exports", async () => {
    const p = await open();
    await p.click('[data-testid="row-Stitching"]');
    const requests = p.requests();
    expect(requests).toContain(`${BASE}/summary?period=last_30_days&department=Stitching`);
    expect(requests).toContain(`${BASE}/gaps?period=last_30_days&department=Stitching`);
    expect(requests).toContain(`${BASE}/trend?period=last_30_days&department=Stitching`);
    expect(requests.filter((r) => r.startsWith(`${BASE}/exports`))).toEqual([
      `${BASE}/exports?period=last_30_days&limit=10`,
    ]);
  });

  it("opens the assistant with a question about what the card shows", async () => {
    const p = await open();
    const buttons = p.container.querySelectorAll<HTMLElement>('[data-testid="ask-ai"]');
    expect(buttons.length).toBeGreaterThanOrEqual(9); // the summary, every card, the exceptions and the limits
    expect(buttons[0].textContent).toContain("Explain with AI");
    await act(async () => {
      buttons[0].click();
    });
    expect(getAssistantState().open).toBe(true);
    expect(getAssistantState().prompt?.text).toBe(fx.briefing.ask);
  });

  it("explains an exception on request", async () => {
    const p = await open();
    const explain = p.container.querySelector<HTMLElement>(
      '[data-testid="insight-reportlog.gap-days"] [data-testid="ask-ai"]',
    );
    await act(async () => {
      explain?.click();
    });
    expect(getAssistantState().prompt?.text).toBe("Explain: 2 days had 2+ absences and nobody made the call");
  });

  it("tells the assistant what is on screen", async () => {
    await open();
    const context = getAssistantState().context;
    expect(context?.page).toBe("report-log");
    expect(context?.title).toBe("Report Log");
    expect(context?.filters?.Period).toBe("07 Sep – 13 Sep 2026");
    expect(context?.summary?.["Absences on scheduled days"]).toBe(9);
    expect(context?.summary?.["Followed up"]).toBe("44.4%");
    expect(context?.summary?.["Attendance report exports on record"]).toBe(6);
  });

  it("explains a figure on request", async () => {
    const p = await open();
    await p.click('[data-testid="md-reportlog-kpi-gaps"] [data-testid="provenance-button"]');
    expect(document.body.textContent).toContain("Days nobody made the call");
    expect(document.body.textContent).toContain("A day with 2 or more absences where none carries a mark.");
  });

  it("keeps the other cards when one request fails, and says what the server said", async () => {
    const p = await open({
      ...FIXTURES,
      [`${BASE}/exports`]: { status: 400, body: { error: "'limit' must be a whole number between 1 and 25." } },
    });
    expect(p.container.querySelector('[data-testid="md-reportlog-exports"] [data-testid="md-error"]')).not.toBeNull();
    expect(p.text()).toContain("'limit' must be a whole number between 1 and 25.");
    expect(kpi("absences")).toBe("9"); // the strip and the other cards are unaffected
    expect(p.container.querySelector('[data-testid="row-Stitching"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-reportlog-gaps-grid"]')).not.toBeNull();
  });

  it("shows an error banner when the summary itself fails", async () => {
    const p = await open({ ...FIXTURES, [`${BASE}/summary`]: { status: 400, body: { error: "No unit called 'X'." } } });
    expect(
      p.container.querySelector('[data-testid="md-reportlog-insights"] > [data-testid="md-error"]'),
    ).not.toBeNull();
    expect(p.text()).toContain("No unit called 'X'.");
  });

  it("says why it is empty when there are no absences and no exports", async () => {
    const p = await open(EMPTY);
    expect(kpi("absences")).toBe("0");
    expect(kpi("followed")).toBe("—");
    expect(kpi("exports")).toBe("0");
    expect(kpi("latest")).toBe("—");
    expect(p.container.querySelector('[data-testid="insights-empty"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-reportlog-followup-empty"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-reportlog-gaps-empty"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-reportlog-exports-empty"]')).not.toBeNull();
    expect(p.text()).toContain("No absences for this selection, so there is nothing to compare.");
    expect(p.text()).toContain("There were no absences on scheduled days in 07 sep");
    expect(text('[data-testid="md-reportlog-notes"]')).toContain("There were no absences on scheduled days");
    // what it cannot tell is still said: it does not depend on the data
    expect(p.container.querySelector('[data-testid="md-reportlog-limits"]')).not.toBeNull();
  });

  it("draws a weekly trend for a long period and explains the weekly points", async () => {
    const p = await open({ ...FIXTURES, [`${BASE}/trend`]: fx.weeklyTrend });
    expect(p.text()).toContain("Week by week");
    expect(p.text()).toContain("Each point is a week (Monday to Sunday)");
  });

  it("says there is no completed day when the period is only today", async () => {
    const p = await open({ ...FIXTURES, [`${BASE}/summary`]: fx.noCompletedDaySummary });
    expect(kpi("absences")).toBe("—");
    expect(kpi("gaps")).toBe("—");
    expect(text('[data-testid="md-reportlog-notes"]')).toContain("no completed day yet");
    expect(p.text()).toContain("No completed day in this period yet");
  });
});

describe("Report Log strip", () => {
  const brief = {
    page: "report-log",
    title: "Report Log",
    domain: "reportlog",
    generatedAt: "2026-09-21T10:00:00",
    kpis: [
      {
        id: "reportlog.reviewed-pct",
        label: "Absences followed up",
        value: 44.4,
        format: "pct",
        sub: "4 of 9 absences marked · 07 Sep to 13 Sep",
        delta: { abs: -22.3, pct: -33.4, good: "up" },
        spark: null,
        page: "report-log",
      },
      {
        id: "reportlog.not-informed",
        label: "Not-informed absences",
        value: 2,
        format: "number",
        delta: { abs: 1, pct: 100, good: "down" },
        page: "report-log",
      },
      { id: "reportlog.exports", label: "Attendance report exports", value: 6, format: "number", page: "report-log" },
    ],
    insights: fx.attention.items,
    provenance: [],
    notes: [],
  };
  const STRIP: Fixtures = { "/api/md/brief/report-log": brief };

  it("shows the figures that matter, the top exceptions and the one thing to remember", async () => {
    page = await renderMdPage(Strip, STRIP, { path: "/md/attendance/report-log" });
    const followed = page.container.querySelector('[data-testid="strip-kpi-reportlog.reviewed-pct"]');
    expect(followed?.textContent).toContain("Absences followed up44.4%");
    expect(followed?.textContent).toContain("-22.3 pts");
    expect(page.container.querySelector('[data-testid="strip-kpi-reportlog.exports"]')?.textContent).toContain(
      "Attendance report exports6",
    );
    const items = page.container.querySelectorAll('[data-testid="md-reportlog-strip-insights"] li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("5 of 9 absences have no Informed / Not informed call");
    expect(page.container.querySelector('[data-testid="md-reportlog-strip-caveat"]')?.textContent).toContain(
      "Exports made from this page (Excel, PDF, image) are produced in the browser and are not recorded",
    );
  });

  it("opens the assistant from the strip", async () => {
    page = await renderMdPage(Strip, STRIP, { path: "/md/attendance/report-log" });
    const explain = page.container.querySelector<HTMLElement>(
      '[data-testid="md-reportlog-strip-insights"] [data-testid="ask-ai"]',
    );
    await act(async () => {
      explain?.click();
    });
    expect(getAssistantState().prompt?.text).toContain("Explain: 5 of 9 absences have no Informed / Not informed call");
  });

  it("shows nothing at all when there is nothing to say", async () => {
    page = await renderMdPage(
      Strip,
      { "/api/md/brief/report-log": { ...brief, kpis: [], insights: [] } },
      { path: "/md/attendance/report-log" },
    );
    expect(page.container.querySelector('[data-testid="md-reportlog-strip"]')).toBeNull();
  });
});
