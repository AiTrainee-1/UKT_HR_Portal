import { cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import { renderMdPage, type Fixtures, type RenderedPage } from "../../testing/renderMdPage";
import * as fx from "../outpass/fixtures";
import VisitorsInsights, { Strip } from "./index";

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

const B = "/api/md/visitors";
const FIXTURES: Fixtures = {
  [`${B}/story`]: (p: URLSearchParams) => fx.story((p.get("focus") as "visitors") ?? "visitors"),
  [`${B}/summary`]: fx.summary,
  [`${B}/trend`]: fx.trend,
  [`${B}/visitors`]: fx.visitors,
  [`${B}/exceptions`]: fx.exceptions,
  [`${B}/visit-list`]: fx.visitList,
  "/api/md/brief/visitors": fx.BRIEF("visitors"),
};

const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

async function open(fixtures: Fixtures = FIXTURES) {
  page = await renderMdPage(VisitorsInsights, fixtures, { path: "/md/outpass-visitors/visitors" });
  return page;
}

describe("Visitors insights", () => {
  it("shows the overview with check-out and time inside", async () => {
    await open();
    expect(text("md-visitors-briefing")).toContain("12 of 16 visits since check-out began were checked out");
    expect(text("md-visitors-kpi-visits")).toContain("40");
    expect(text("md-visitors-kpi-inside")).toContain("1 for over 2 hours · 5 came today");
    expect(text("md-visitors-kpi-checked-out")).toContain("75%");
    expect(text("md-visitors-kpi-checked-out")).toContain("12 of 16 visits since 18 Nov");
    expect(text("md-visitors-kpi-stay")).toContain("48m");
    expect(text("md-visitors-kpi-stay")).toContain("Typical visit 40m");
    expect(text("md-visitors-kpi-no-checkout")).toContain("4");
    expect(text("md-visitors-attention")).toContain("inside for over 2 hours");
    expect(text("md-visitors-attention")).not.toContain("never scanned back in");
    expect(text("md-visitors-stay")).toContain("12 of 16 visits since 18 Nov 2026 checked out (75%)");
    expect(text("md-visitors-source-bars")).toContain("Reception desk");
    expect(text("md-visitors-group-bars")).toContain("Supplier, vendor or sales");
    expect(getAssistantState().context?.summary?.["Inside now"]).toBe("2");
  });

  it("drills into the visits behind a tile and a group", async () => {
    const p = await open();
    await p.click('[data-testid="md-visitors-kpi-checked-out"]');
    expect(p.requests().some((r) => r.startsWith(`${B}/visit-list`) && r.includes("status=checked_out"))).toBe(true);
    expect(text("md-visitors-sheet")).toContain("Ravi Supplier · Acme Ltd → Asha Rao");
    expect(text("md-visitors-sheet")).toContain("Open in Visitors");
    await p.click('[data-testid="md-visitors-group-tabs"] button:nth-child(3)');
    await p.click('[data-testid="bar-3"] button');
    expect(p.requests().some((r) => r.startsWith(`${B}/visit-list`) && r.includes("desk=3"))).toBe(true);
  });

  it("asks for today's visitors inside whatever month is chosen", async () => {
    const p = await open();
    await p.click('[data-testid="month-prev"]');
    await p.click('[data-testid="md-visitors-kpi-inside"]');
    const call = p.requests().find((r) => r.startsWith(`${B}/visit-list`) && r.includes("status=inside")) ?? "";
    expect(call).toContain("period=today");
    expect(call).not.toContain("month=");
  });

  it("is honest when nothing could be checked out", async () => {
    await open({
      ...FIXTURES,
      [`${B}/visitors`]: fx.emptyVisitors,
      [`${B}/trend`]: fx.emptyTrend,
      [`${B}/story`]: () => fx.emptyStory("visitors"),
    });
    expect(text("md-visitors-stay-empty")).toContain("Check-out is recorded from 18 Nov 2026");
    expect(text("md-visitors-trend-empty")).toContain("Nobody checked in");
    expect(text("md-visitors-briefing")).toContain("Nobody checked in for this selection.");
  });

  it("shows a failed card's reason and keeps the rest", async () => {
    await open({ ...FIXTURES, [`${B}/visitors`]: { status: 400, body: { error: "The visitor figures failed." } } });
    expect(text("md-visitors-stay")).toContain("The visitor figures failed.");
    expect(text("md-visitors-kpi-visits")).toContain("40");
  });

  it("the strip shows who is inside now and only the visitor figures", async () => {
    page = await renderMdPage(Strip, FIXTURES, { path: "/md/outpass-visitors/visitors" });
    expect(text("md-visitors-strip-inside")).toContain("Inside now2");
    expect(text("md-visitors-strip")).toContain("Visitors today");
    expect(text("md-visitors-strip")).not.toContain("Outpasses today");
  });
});
