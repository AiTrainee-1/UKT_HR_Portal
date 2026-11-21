import { cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import { renderMdPage, type Fixtures, type RenderedPage } from "../../testing/renderMdPage";
import * as fx from "./fixtures";
import TeaBreakInsights, { Strip } from "./index";

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

const B = "/api/md/tea-break";
const FIXTURES: Fixtures = {
  [`${B}/story`]: fx.story,
  [`${B}/summary`]: fx.summary,
  [`${B}/trend`]: fx.trend,
  [`${B}/departments`]: fx.groups,
  [`${B}/offenders`]: fx.offenders,
  [`${B}/attention`]: fx.attention,
  [`${B}/records`]: fx.records,
  "/api/md/brief/tea-break": fx.brief,
};

const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

async function open(fixtures: Fixtures = FIXTURES) {
  page = await renderMdPage(TeaBreakInsights, fixtures, { path: "/md/outpass-visitors/tea-break" });
  return page;
}

describe("Tea Break insights", () => {
  it("shows the overview, the trend, where the minutes go and who overran", async () => {
    await open();
    expect(text("md-tea-briefing")).toContain("58.3% ran over the 15 minutes allowed");
    expect(text("md-tea-kpi-breaks")).toContain("6 people · 83.3% of staff scan");
    expect(text("md-tea-kpi-overrun")).toContain("58.3%");
    expect(text("md-tea-kpi-overrun")).toContain("14 of 24 measured breaks");
    expect(text("md-tea-kpi-lost")).toContain("200");
    expect(text("md-tea-kpi-long")).toContain("2");
    expect(text("md-tea-kpi-refused")).toContain("3");
    expect(text("md-tea-kpi-refused")).toContain("1 the period before");
    expect(text("md-tea-verdict")).toContain("Better than the week before");
    expect(text("md-tea-worst-day")).toContain("19 Nov 2026");
    expect(text("md-tea-group-bars")).toContain("Stitching (small sample)");
    expect(text("md-tea-offender-bars")).toContain("Chitra Test (C)");
    expect(text("md-tea-attention")).toContain("Stitching overran 72% of breaks");
    expect(getAssistantState().context?.summary?.["Refused at a gate"]).toBe("3");
  });

  it("groups by gate, keeps the choice in the address and opens a gate's breaks", async () => {
    const p = await open();
    await p.click('[data-testid="md-tea-group-tabs"] button:nth-child(3)');
    expect(p.requests().some((r) => r.startsWith(`${B}/departments`) && r.includes("by=gate"))).toBe(true);
    expect(window.location.search).toContain("i.by=gate");
    expect(text("md-tea-group-bars")).toContain("3 refused");
    // the group-by is the card's own choice: the other figures are not asked again with it
    expect(p.requests().some((r) => r.startsWith(`${B}/summary`) && r.includes("by="))).toBe(false);
    await p.click('[data-testid="bar-Gate 1"] button');
    const call = p.requests().find((r) => r.startsWith(`${B}/records`)) ?? "";
    expect(call).toContain("by=gate");
    expect(call).toContain("group=Gate+1");
    expect(text("md-tea-sheet")).toContain("Over the allowance (+15m)");
    expect(text("md-tea-sheet")).toContain("Open in Tea Break");
  });

  it("drills from the refused tile and from a person", async () => {
    const p = await open();
    await p.click('[data-testid="md-tea-kpi-refused"]');
    expect(p.requests().some((r) => r.startsWith(`${B}/records`) && r.includes("status=refused"))).toBe(true);
    expect(text("md-tea-sheet")).toContain("Refused at the gate");
    expect(text("md-tea-sheet")).toContain("Gate 2");
    await p.click('[data-testid="bar-C"] button');
    expect(p.requests().some((r) => r.startsWith(`${B}/records`) && r.includes("employee=33"))).toBe(true);
  });

  it("says so when nobody scanned, and shows a failed card's reason", async () => {
    await open({
      ...FIXTURES,
      [`${B}/summary`]: fx.emptySummary,
      [`${B}/trend`]: fx.emptyTrend,
      [`${B}/story`]: fx.emptyStory,
    });
    expect(text("md-tea-trend-empty")).toContain("Nobody scanned a tea break");
    expect(text("md-tea-briefing")).toContain("Nobody scanned a tea break for this selection.");
    page?.unmount();
    page = await renderMdPage(
      TeaBreakInsights,
      { ...FIXTURES, [`${B}/offenders`]: { status: 400, body: { error: "The offenders failed." } } },
      { path: "/md/outpass-visitors/tea-break" },
    );
    expect(text("md-tea-offenders")).toContain("The offenders failed.");
    expect(text("md-tea-kpi-breaks")).toContain("28");
  });

  it("the strip shows who is on a break now", async () => {
    page = await renderMdPage(Strip, FIXTURES, { path: "/md/outpass-visitors/tea-break" });
    expect(text("md-tea-strip-now")).toContain("On a break now2");
    expect(text("md-tea-strip")).toContain("Break overruns");
  });
});
