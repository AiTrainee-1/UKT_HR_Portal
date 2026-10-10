import { act, cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import { renderMdPage, type Fixtures, type RenderedPage } from "../../testing/renderMdPage";
import * as fx from "./fixtures";
import GeoInsights, { Strip } from "./index";

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

// A tab with ten requests, a chart and Radix popovers is slow to settle on a busy machine: leave room.
vi.setConfig({ testTimeout: 30_000 });

const BASE = "/api/md/geo";

/** Every endpoint the tab calls, answered with the hand-counted company. */
const FIXTURES: Fixtures = {
  [`${BASE}/summary`]: fx.summary,
  [`${BASE}/briefing`]: fx.briefing,
  [`${BASE}/attention`]: fx.attention,
  [`${BASE}/trend`]: fx.trend,
  [`${BASE}/verification`]: fx.verification,
  [`${BASE}/departments`]: (params: URLSearchParams) =>
    params.get("by") === "unit" ? fx.units : params.get("by") === "type" ? fx.types : fx.departments,
  [`${BASE}/reach`]: fx.reach,
  [`${BASE}/unusual`]: fx.unusual,
  [`${BASE}/people`]: fx.people,
  [`${BASE}/live`]: fx.live,
};

const EMPTY: Fixtures = {
  [`${BASE}/summary`]: fx.emptySummary,
  [`${BASE}/briefing`]: fx.emptyBriefing,
  [`${BASE}/attention`]: fx.emptyAttention,
  [`${BASE}/trend`]: fx.emptyTrend,
  [`${BASE}/verification`]: fx.emptyVerification,
  [`${BASE}/departments`]: (params: URLSearchParams) =>
    fx.emptyBreakdown((params.get("by") as "department") ?? "department"),
  [`${BASE}/reach`]: fx.emptyReach,
  [`${BASE}/unusual`]: fx.emptyUnusual,
  [`${BASE}/people`]: fx.emptyPeople,
  [`${BASE}/live`]: fx.emptyLive,
};

const text = (selector: string) => page?.container.querySelector(selector)?.textContent ?? null;
const kpi = (id: string) => text(`[data-testid="md-geo-kpi-${id}-value"]`);
const row = (id: string) => page?.container.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

async function open(fixtures: Fixtures = FIXTURES) {
  page = await renderMdPage(GeoInsights, fixtures, { path: "/md/geo-attendance" });
  return page;
}

describe("Geo Attendance insights", () => {
  it("shows the hand-counted figures on every card", async () => {
    const p = await open();

    // in plain words
    expect(text('[data-testid="md-geo-sentence-volume"]')).toContain("10 on-duty sessions by 6 people (up 150%");
    expect(text('[data-testid="md-geo-sentence-unusual"]')).toContain("2 punches with simulated GPS");
    expect(text('[data-testid="md-geo-sentence-now"]')).toBe(
      "Right now 2 people are on duty (2 awaiting approval, 1 with no location signal).",
    );

    // the strip
    expect(kpi("sessions")).toBe("10");
    expect(kpi("people")).toBe("83%");
    expect(kpi("punches")).toBe("14");
    expect(kpi("office")).toBe("4");
    expect(kpi("verified")).toBe("57.1%");
    expect(kpi("waiting")).toBe("4");
    expect(kpi("speed")).toBe("3.0 h");
    expect(kpi("mocked")).toBe("2");
    expect(text('[data-testid="md-geo-compare"]')).toBe(
      "Changes compare with 18 Aug to 31 Aug 2026, the same number of days just before.",
    );
    expect(text('[data-testid="md-geo-kpi-verified"]')).toContain("-9.6 pts");
    expect(text('[data-testid="md-geo-kpi-waiting"]')).toContain("Oldest 10.5 days · 2 requests");

    // what needs attention
    expect(p.container.querySelector('[data-testid="insight-geo.backlog"]')?.getAttribute("data-severity")).toBe(
      "critical",
    );
    expect(p.text()).toContain("2 punches and 1 request waiting more than 2 days for HR");
    expect(p.text()).toContain("2 on-duty punches used a simulated GPS location");

    // rising or falling
    expect(p.container.querySelector('[data-testid="trend-chart"] svg.recharts-surface')).not.toBeNull();
    const verdict = p.container.querySelector('[data-testid="md-geo-verdict"]');
    expect(verdict?.getAttribute("data-verdict")).toBe("falling");
    expect(verdict?.textContent).toContain("On-duty requests are falling");
    expect(text('[data-testid="md-geo-busiest-day"]')).toBe(
      "Busiest day: 02 Sep 2026, 3 sessions and 5 on-duty punches.",
    );

    // who is on duty now
    expect(text('[data-testid="md-geo-live-chip-now"]')).toBe("On duty today: 2");
    expect(text('[data-testid="md-geo-live-chip-silent"]')).toBe("No location signal: 1");
    expect(row("md-geo-live-B")).toContain("Left open");
    expect(row("md-geo-live-A")).toContain("Awaiting approval");
    expect(row("md-geo-live-A")).toContain("To Dyeing unit, Tiruppur");
    expect(row("md-geo-live-A")).toContain("Phone: 1 h 30 m ago, 30.0 km from the unit");
    expect(row("md-geo-live-C")).toContain("Approved");
    expect(row("md-geo-live-C")).toContain("1 punch today (last 10:00)");
    expect(row("md-geo-live-C")).toContain("Phone: 20 m ago, 5.0 km from the unit");
    expect(p.text()).toContain("67% of 6 employees out");

    // is it being verified
    expect(text('[data-testid="md-geo-status-donut"]')).toContain("57%");
    expect(text('[data-testid="md-geo-status-donut"]')).toContain("Waiting for HR");
    expect(text('[data-testid="md-geo-decision-line"]')).toBe(
      "HR typically decides a punch in 3.0 h, 9 in 10 within 29 h, 89% within a day.",
    );
    expect(text('[data-testid="md-geo-request-line"]')).toBe(
      "Requests: 10 made · 7 approved · 1 awaiting approval · 2 rejected · decided in 3.0 h (median).",
    );
    expect(text('[data-testid="md-geo-backlog"]')).toContain("Waiting for HR now (4 punches, 2 requests)");
    expect(text('[data-testid="md-geo-age-bars"]')).toContain("Over a week");
    expect(text('[data-testid="md-geo-backlog"]')).toContain(
      "have waited more than 2 days; the oldest punch 10.5 days.",
    );

    // how far from the unit
    expect(text('[data-testid="md-geo-reach-bars"]')).toContain("2 to 10 km");
    expect(text('[data-testid="md-geo-reach-bars"]')).toContain("5 · 36%");
    expect(text('[data-testid="md-geo-reach-line"]')).toBe(
      "Farthest punch: 250.2 km from its unit. 1 punch was over 100 km away (1 person).",
    );
    expect(text('[data-testid="md-geo-reach"]')).toContain("3 of 14 punches cannot be placed");

    // who goes out
    expect(row("row-Sales")).toContain("3 employees · 100% went out");
    expect(row("row-Sales")).toContain("80% of all");
    expect(row("row-Sales")).toContain("+100%");
    expect(row("row-Stores")).toContain("small sample");
    expect(p.text()).toContain("Overall: 10 sessions by 6 people (83% of employees), 1.7 each.");

    // unusual sessions
    expect(p.container.querySelector('[data-testid="md-geo-unusual-5"]')?.getAttribute("data-severity")).toBe(
      "critical",
    );
    expect(row("md-geo-unusual-5")).toContain("Babu Test");
    expect(row("md-geo-unusual-5")).toContain("Simulated GPS location (1 punch)");
    expect(row("md-geo-unusual-5")).toContain("farthest 250 km");
    expect(row("md-geo-unusual-6")).toContain("Open for more than 16 hours (16.5 h)");
    expect(text('[data-testid="md-geo-repeat-rejected"]')).toContain("Asha Test");
    expect(text('[data-testid="md-geo-repeat-rejected"]')).toContain("2 requests and 1 punch rejected");
    expect(p.text()).toContain("Showing the 3 most serious of 6.");
    expect(p.text()).toContain("6 sessions flagged");

    // who goes out most
    expect(row("row-A")).toContain("Asha Test");
    expect(row("row-B")).toContain("0 · 2 · 1 · 2"); // rejected, simulated, far, odd
    expect(p.text()).toContain("6 people went on duty · 0 frequently (5+ sessions)");
    expect(p.text()).toContain("Showing the 3 who went out most, of 6.");

    // this period against the previous
    expect(row("md-geo-compare-sessions")).toContain("10");
    expect(row("md-geo-compare-sessions")).toContain("+150%");
    expect(row("md-geo-compare-verified")).toContain("57.1%");
    expect(row("md-geo-compare-verified")).toContain("66.7%");

    // the caveats
    expect(text('[data-testid="md-geo-notes"]')).toContain("a punch outside is refused and not stored");
  });

  it("asks the server for each card with the chosen period, and nothing it has no fixture for", async () => {
    const p = await open();
    const requests = p.requests();
    for (const url of [
      `${BASE}/summary?period=last_30_days`,
      `${BASE}/briefing?period=last_30_days`,
      `${BASE}/attention?period=last_30_days`,
      `${BASE}/trend?period=last_30_days`,
      `${BASE}/verification?period=last_30_days`,
      `${BASE}/departments?period=last_30_days&by=department&limit=25`,
      `${BASE}/reach?period=last_30_days`,
      `${BASE}/unusual?period=last_30_days&limit=25`,
      `${BASE}/people?period=last_30_days&limit=25`,
      `${BASE}/live`, // right now: no period
    ]) {
      expect(requests).toContain(url);
    }
  });

  it("changes every figure with the period, but not the live picture", async () => {
    const p = await open();
    await p.click('[data-testid="period-bar"] [role="tab"]:nth-of-type(2)'); // Last 7 days
    const requests = p.requests();
    expect(requests).toContain(`${BASE}/summary?period=last_7_days`);
    expect(requests).toContain(`${BASE}/briefing?period=last_7_days`);
    expect(requests).toContain(`${BASE}/verification?period=last_7_days`);
    expect(requests.filter((r) => r === `${BASE}/live`)).toHaveLength(1);
  });

  it("switches who-goes-out between departments, units and staff vs production", async () => {
    const p = await open();
    expect(p.container.querySelector('[data-testid="row-Sales"]')).not.toBeNull();
    await p.click('[data-testid="md-geo-group-tabs"] [role="tab"]:nth-of-type(2)');
    expect(p.requests()).toContain(`${BASE}/departments?period=last_30_days&by=unit&limit=25`);
    expect(row("row-Unit 1")).toContain("80% of all");
    await p.click('[data-testid="md-geo-group-tabs"] [role="tab"]:nth-of-type(3)');
    expect(p.requests()).toContain(`${BASE}/departments?period=last_30_days&by=type&limit=25`);
    expect(row("row-production")).toContain("Production");
  });

  it("narrows the whole tab to a department when its row is clicked", async () => {
    const p = await open();
    await p.click('[data-testid="row-Sales"]');
    const requests = p.requests();
    expect(requests).toContain(`${BASE}/summary?period=last_30_days&department=Sales`);
    expect(requests).toContain(`${BASE}/unusual?period=last_30_days&department=Sales&limit=25`);
    expect(requests).toContain(`${BASE}/live?department=Sales`);
  });

  it("opens the assistant with a question about what the card shows", async () => {
    const p = await open();
    const buttons = p.container.querySelectorAll<HTMLElement>('[data-testid="ask-ai"]');
    expect(buttons.length).toBeGreaterThanOrEqual(10); // the summary, every card and every exception
    expect(buttons[0].textContent).toContain("Explain with AI");
    await act(async () => {
      buttons[0].click();
    });
    expect(getAssistantState().open).toBe(true);
    expect(getAssistantState().prompt?.text).toBe(fx.briefing.ask);
  });

  it("explains an exception on request", async () => {
    const p = await open();
    const explain = p.container.querySelector<HTMLElement>('[data-testid="insight-geo.mocked"] [data-testid="ask-ai"]');
    expect(explain?.textContent).toContain("Explain");
    await act(async () => {
      explain?.click();
    });
    expect(getAssistantState().prompt?.text).toBe("Explain: 2 on-duty punches used a simulated GPS location");
  });

  it("tells the assistant what is on screen", async () => {
    await open();
    const context = getAssistantState().context;
    expect(context?.page).toBe("geo-attendance");
    expect(context?.title).toBe("Geo Attendance");
    expect(context?.filters?.Period).toBe("01 Sep – 14 Sep 2026");
    expect(context?.summary?.["On-duty sessions"]).toBe(10);
    expect(context?.summary?.["Verified by HR"]).toBe("57.1%");
    expect(context?.summary?.["Punches waiting for HR now"]).toBe(4);
  });

  it("explains a figure on request", async () => {
    const p = await open();
    await p.click('[data-testid="md-geo-kpi-waiting"] [data-testid="provenance-button"]');
    expect(document.body.textContent).toContain("Waiting for HR now");
    expect(document.body.textContent).toContain("Punches and requests still pending at this moment.");
  });

  it("keeps the other cards when one request fails, and says what the server said", async () => {
    const p = await open({
      ...FIXTURES,
      [`${BASE}/unusual`]: { status: 400, body: { error: "'limit' must be a whole number between 1 and 25." } },
    });
    expect(p.container.querySelector('[data-testid="md-geo-unusual"] [data-testid="md-error"]')).not.toBeNull();
    expect(p.text()).toContain("'limit' must be a whole number between 1 and 25.");
    expect(kpi("sessions")).toBe("10"); // the strip and the other cards are unaffected
    expect(p.container.querySelector('[data-testid="row-Sales"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-geo-live-A"]')).not.toBeNull();
  });

  it("shows an error banner when the summary itself fails", async () => {
    const p = await open({ ...FIXTURES, [`${BASE}/summary`]: { status: 400, body: { error: "No unit called 'X'." } } });
    expect(p.container.querySelector('[data-testid="md-geo-insights"] > [data-testid="md-error"]')).not.toBeNull();
    expect(p.text()).toContain("No unit called 'X'.");
  });

  it("says why it is empty when nobody went on duty", async () => {
    const p = await open(EMPTY);
    expect(kpi("sessions")).toBe("0");
    expect(kpi("punches")).toBe("0");
    expect(kpi("verified")).toBe("—");
    expect(kpi("speed")).toBe("—");
    expect(kpi("people")).toBe("—");
    expect(kpi("waiting")).toBe("0");
    expect(p.container.querySelector('[data-testid="insights-empty"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-geo-trend-empty"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-geo-verification-empty"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-geo-reach-empty"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-geo-unusual-empty"]')).not.toBeNull();
    expect(p.container.querySelector('[data-testid="md-geo-live-empty"]')).not.toBeNull();
    expect(p.text()).toContain("Nobody went on duty in this period, so there is nothing to compare.");
    expect(p.text()).toContain("Nobody went on duty in this period.");
    expect(p.text()).toContain("No on-duty sessions or geo punches were recorded in 01 sep");
    expect(text('[data-testid="md-geo-notes"]')).toContain(
      "No on-duty sessions, on-duty punches or office geo punches",
    );
  });

  it("draws a weekly trend for a long period and explains the weekly points", async () => {
    const p = await open({ ...FIXTURES, [`${BASE}/trend`]: fx.weeklyTrend });
    expect(p.text()).toContain("Week by week");
    expect(p.text()).toContain("Each point is a week (Monday to Sunday)");
  });
});

describe("Geo Attendance strip", () => {
  const brief = {
    page: "geo-attendance",
    title: "Geo Attendance",
    domain: "geo",
    generatedAt: "2026-09-15T15:30:00",
    kpis: [
      { id: "geo.on-duty-now", label: "On duty now", value: 2, format: "number", page: "geo-attendance" },
      {
        id: "geo.sessions",
        label: "On-duty sessions",
        value: 2,
        format: "number",
        sub: null,
        delta: { abs: -6, pct: -75, good: null },
        spark: null,
        page: "geo-attendance",
      },
      { id: "geo.awaiting-hr", label: "Punches waiting for HR", value: 4, format: "number", page: "geo-attendance" },
    ],
    insights: fx.attention.items.slice(0, 3),
    provenance: [],
    notes: [],
  };
  const STRIP: Fixtures = { "/api/md/brief/geo-attendance": brief, [`${BASE}/live`]: fx.live };

  it("shows who is on duty now, the figures that matter and the top exceptions", async () => {
    page = await renderMdPage(Strip, STRIP, { path: "/md/geo-attendance" });
    expect(page.container.querySelector('[data-testid="md-geo-strip-now"]')?.textContent).toContain("On duty now2");
    expect(page.container.querySelector('[data-testid="md-geo-strip-now"]')?.textContent).toContain(
      "2 awaiting approval",
    );
    expect(page.container.querySelector('[data-testid="md-geo-strip-now"]')?.textContent).toContain("2 left open");
    expect(page.container.querySelector('[data-testid="strip-kpi-geo.sessions"]')?.textContent).toContain(
      "On-duty sessions2",
    );
    expect(page.container.querySelector('[data-testid="strip-kpi-geo.awaiting-hr"]')?.textContent).toContain("4");
    expect(page.container.querySelector('[data-testid="strip-kpi-geo.on-duty-now"]')).toBeNull(); // the live figure is shown instead
    const items = page.container.querySelectorAll('[data-testid="md-geo-strip-insights"] li');
    expect(items).toHaveLength(2); // the two most serious
    expect(items[0].textContent).toContain("2 punches and 1 request waiting more than 2 days for HR");
  });

  it("opens the assistant from the strip", async () => {
    page = await renderMdPage(Strip, STRIP, { path: "/md/geo-attendance" });
    const explain = page.container.querySelector<HTMLElement>(
      '[data-testid="md-geo-strip-insights"] [data-testid="ask-ai"]',
    );
    await act(async () => {
      explain?.click();
    });
    expect(getAssistantState().prompt?.text).toContain("Explain: 2 punches and 1 request waiting");
  });

  it("shows nothing at all when there is nothing to say", async () => {
    page = await renderMdPage(
      Strip,
      { "/api/md/brief/geo-attendance": { ...brief, kpis: [], insights: [] }, [`${BASE}/live`]: fx.emptyLive },
      { path: "/md/geo-attendance" },
    );
    expect(page.container.querySelector('[data-testid="md-geo-strip"]')).toBeNull();
  });
});
