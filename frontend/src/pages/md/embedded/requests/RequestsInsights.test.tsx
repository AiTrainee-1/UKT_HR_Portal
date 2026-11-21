import { cloneElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import { renderMdPage, type Fixtures, type RenderedPage } from "../../testing/renderMdPage";
import * as fx from "./fixtures";
import RequestsInsights, { Strip } from "./index";

// jsdom has no layout: give recharts a fixed size so the real chart configuration renders.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 800, height: 240 }),
  };
});

vi.setConfig({ testTimeout: 30_000 });

let page: RenderedPage | undefined;
beforeEach(() => window.history.replaceState(null, "", "/md/requests"));
afterEach(() => {
  page?.unmount();
  page = undefined;
  window.history.replaceState(null, "", "/");
});

const BASE = "/api/md/requests";
const FIXTURES: Fixtures = {
  [`${BASE}/summary`]: fx.summary,
  [`${BASE}/attention`]: fx.attention,
  [`${BASE}/trend`]: fx.trend,
  [`${BASE}/waiting`]: fx.waiting,
  [`${BASE}/breakdown`]: fx.breakdown,
  [`${BASE}/bottlenecks`]: fx.bottlenecks,
  [`${BASE}/rejections`]: fx.rejections,
  [`${BASE}/list`]: fx.list,
};
const EMPTY: Fixtures = {
  [`${BASE}/summary`]: fx.emptySummary,
  [`${BASE}/attention`]: fx.emptyAttention,
  [`${BASE}/trend`]: fx.emptyTrend,
  [`${BASE}/waiting`]: fx.emptyWaitingResponse,
  [`${BASE}/breakdown`]: fx.emptyBreakdown,
  [`${BASE}/bottlenecks`]: fx.emptyBottlenecks,
  [`${BASE}/rejections`]: fx.emptyRejections,
  [`${BASE}/list`]: fx.list,
};

const text = (selector: string) =>
  (page?.container.querySelector(selector) ?? document.body.querySelector(selector))?.textContent ?? null;

async function open(fixtures: Fixtures = FIXTURES) {
  page = await renderMdPage(RequestsInsights, fixtures, { path: "/md/requests" });
  return page;
}

describe("Requests insights", () => {
  it("leads with the briefing, the figures and what needs attention", async () => {
    const p = await open();
    expect(text('[data-testid="md-requests-sentence-waiting"]')).toContain("HR can act on 6 of them now.");
    expect(text('[data-testid="md-requests-kpi-waiting-value"]')).toBe("8");
    expect(text('[data-testid="md-requests-kpi-aged-value"]')).toBe("3");
    expect(text('[data-testid="md-requests-kpi-hod-value"]')).toBe("2");
    expect(text('[data-testid="md-requests-kpi-approval-value"]')).toBe("40%");
    expect(text('[data-testid="md-requests-kpi-speed-value"]')).toBe("24 hours");
    expect(text('[data-testid="md-requests-kpi-waiting"]')).toContain("6 with HR · 2 with Department Heads");
    // worst first
    const attention = text('[data-testid="md-requests-attention"]') ?? "";
    expect(attention.indexOf("3 requests have waited")).toBeLessThan(attention.indexOf("1 person made"));
    expect(text('[data-testid="md-requests-trend-total"]')).toContain(
      "6 submitted (3 in the period before) and 5 decided",
    );
    expect(text('[data-testid="md-requests-rejections-line"]')).toContain(
      "3 rejected (1 in the period before); 2 with a reason",
    );
    expect(p.text()).toContain('"Too many  permissions"');
    expect(text('[data-testid="md-requests-notes"]')).toContain("decided before decision times were kept");
  });

  it("never offers the MD a decision", async () => {
    const p = await open();
    expect(p.text()).not.toContain("You can decide");
    const buttons = [...document.body.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
    expect(buttons.filter((b) => /^(Approve|Reject)/.test(b))).toEqual([]);
  });

  it("asks every endpoint for the running month by default and follows the filters", async () => {
    const p = await open();
    expect(p.requests().some((r) => r.startsWith(`${BASE}/summary?period=this_month`))).toBe(true);
    await p.click('[data-testid="month-prev"]');
    const last =
      p
        .requests()
        .filter((r) => r.startsWith(`${BASE}/summary`))
        .pop() ?? "";
    expect(last).toMatch(/month=\d{4}-\d{2}/);
    expect(window.location.search).toMatch(/i\.month=\d{4}-\d{2}/);
    // the waiting snapshot has no period, only the scope
    expect(
      p
        .requests()
        .filter((r) => r.startsWith(`${BASE}/waiting`))
        .every((r) => !/period=|month=/.test(r)),
    ).toBe(true);
  });

  it("opens the requests behind a figure, with each one's full story", async () => {
    const p = await open();
    await p.click('[data-testid="md-requests-kpi-rejected"]');
    const sheet = document.body.querySelector('[data-testid="md-requests-drill"]');
    expect(sheet?.textContent).toContain("Rejected");
    expect(p.requests().some((r) => r.startsWith(`${BASE}/list`) && r.includes("status=rejected"))).toBe(true);
    await p.click('[data-testid="md-requests-item-permission-12"] button');
    const detail = text('[data-testid="md-requests-item-permission-12-detail"]') ?? "";
    expect(detail).toContain("10 Nov 2026 · at 17:00");
    expect(detail).toContain("Too many  permissions");
    expect(detail).toContain("Head Kumar (Department Head)");
  });

  it("drills from a group, a reason and an age band with the list's own filters", async () => {
    const p = await open();
    await p.click('[data-testid="bar-too many permissions"] button');
    expect(p.requests().some((r) => r.includes("/list?") && r.includes("reason=too+many+permissions"))).toBe(true);
    await p.click('[data-testid="md-requests-band-over_7d"]');
    expect(
      p.requests().some((r) => r.includes("/list?") && r.includes("band=over_7d") && r.includes("status=waiting")),
    ).toBe(true);
    await p.click('[data-testid="bar-hod"] button');
    expect(p.requests().some((r) => r.includes("/list?") && r.includes("holder=hod"))).toBe(true);
  });

  it("tells the assistant what is on screen", async () => {
    await open();
    const context = getAssistantState().context;
    expect(context?.page).toBe("requests");
    expect(context?.summary?.["Waiting now"]).toBe("8");
    expect(context?.filters?.Kind).toBe("All requests");
  });

  it("says when there is nothing, and survives a failed card", async () => {
    const p = await open({
      ...EMPTY,
      [`${BASE}/rejections`]: { status: 400, body: { error: "The rejections broke" } },
    });
    expect(text('[data-testid="md-requests-sentence-waiting"]')).toBe("Nothing is waiting for a decision right now.");
    expect(text('[data-testid="md-requests-waiting-empty"]')).toContain("Every request");
    expect(text('[data-testid="md-requests-trend-empty"]')).toContain("Nothing was submitted");
    expect(p.text()).toContain("The rejections broke");
  });
});

describe("Requests strip", () => {
  it("shows what waits now and the speed, folded behind Show insights by the frame", async () => {
    page = await renderMdPage(
      Strip,
      {
        "/api/md/brief/requests": {
          page: "requests",
          title: "Requests",
          domain: "requests",
          kpis: [{ id: "requests.median-decision", label: "Time to decide a request", value: 1440, format: "minutes" }],
          insights: fx.attention.items,
          provenance: [],
          notes: [],
        },
        [`${BASE}/summary`]: fx.summary,
      },
      { path: "/md/requests" },
    );
    expect(text('[data-testid="md-requests-strip-waiting"]')).toContain("8");
    expect(text('[data-testid="md-requests-strip-waiting"]')).toContain("2 with Department Heads");
    expect(text('[data-testid="md-requests-strip-speed"]')).toContain("24h 00m");
    expect(text('[data-testid="md-requests-strip-insights"]')).toContain("3 requests have waited");
  });
});
