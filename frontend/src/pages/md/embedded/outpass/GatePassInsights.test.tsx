import { cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import { renderMdPage, type Fixtures, type RenderedPage } from "../../testing/renderMdPage";
import * as fx from "./fixtures";
import GatePassInsights, { Strip } from "./index";

// jsdom has no layout: give recharts a fixed size so the real chart configuration renders
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
  [`${B}/story`]: (p: URLSearchParams) => fx.story((p.get("focus") as "outpass") ?? "outpass"),
  [`${B}/summary`]: fx.summary,
  [`${B}/trend`]: fx.trend,
  [`${B}/outpass`]: fx.outpass,
  [`${B}/exceptions`]: fx.exceptions,
  [`${B}/pass-list`]: fx.passList,
  "/api/md/brief/outpass": fx.BRIEF("outpass"),
};
const EMPTY: Fixtures = {
  ...FIXTURES,
  [`${B}/story`]: () => fx.emptyStory("outpass"),
  [`${B}/summary`]: fx.emptySummary,
  [`${B}/trend`]: fx.emptyTrend,
  [`${B}/outpass`]: fx.emptyOutpass,
  [`${B}/exceptions`]: fx.emptyExceptions,
};

const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

async function open(fixtures: Fixtures = FIXTURES) {
  page = await renderMdPage(GatePassInsights, fixtures, { path: "/md/outpass-visitors/outpass" });
  return page;
}

describe("Gate Pass insights", () => {
  it("shows the executive overview for this month", async () => {
    const p = await open();
    expect(text("md-gate-pass-briefing")).toContain("12 gate passes in Nov 2026");
    expect(text("md-gate-pass-kpi-requests")).toContain("12");
    expect(text("md-gate-pass-kpi-requests")).toContain("9 the period before");
    expect(text("md-gate-pass-kpi-returned")).toContain("87.5% of passes that left");
    expect(text("md-gate-pass-kpi-hours")).toContain("5.5 h");
    expect(text("md-gate-pass-kpi-outside")).toContain("1 past their return time");
    expect(text("md-gate-pass-kpi-waiting")).toContain("1 over a day");
    expect(text("md-gate-pass-kpi-approval")).toContain("20m");
    // only the gate-pass findings, not the visitors' ones
    expect(text("md-gate-pass-attention")).toContain("never scanned back in");
    expect(text("md-gate-pass-attention")).not.toContain("inside for over 2 hours");
    expect(text("md-gate-pass-groups")).toContain("Stitching");
    expect(text("md-gate-pass-funnel")).toContain("12 requested · 10 approved · 9 left · 7 came back");
    expect(text("md-gate-pass-durations")).toContain("Refused at the gate: 3 of 20 scans");
    // every query carries this month (the running month is asked as this_month)
    const summaryCall = p.requests().find((r) => r.startsWith(`${B}/summary`)) ?? "";
    expect(summaryCall).toContain("period=this_month");
    // the assistant knows what is on screen
    expect(getAssistantState().context?.page).toBe("outpass");
    expect(getAssistantState().context?.summary?.["Passes requested"]).toBe("12");
  });

  it("follows a month picked with the arrows, in every query and the address", async () => {
    const p = await open();
    await p.click('[data-testid="month-prev"]');
    const calls = p.requests().filter((r) => r.startsWith(`${B}/`) && r.includes("month="));
    expect(calls.some((r) => r.startsWith(`${B}/summary`))).toBe(true);
    expect(calls.some((r) => r.startsWith(`${B}/outpass`))).toBe(true);
    expect(window.location.search).toMatch(/i\.month=\d{4}-\d{2}/);
  });

  it("drills from a tile into the passes behind it, and from a group", async () => {
    const p = await open();
    await p.click('[data-testid="md-gate-pass-kpi-not-returned"]');
    expect(p.requests().some((r) => r.startsWith(`${B}/pass-list`) && r.includes("outcome=not_returned"))).toBe(true);
    expect(text("md-gate-pass-sheet")).toContain("Asha Rao (A1) · Stitching");
    expect(text("md-gate-pass-sheet")).toContain("Reason: Not a valid reason");
    expect(text("md-gate-pass-sheet")).toContain("Open in Gate Pass");
  });

  it("opens a group's passes by gate", async () => {
    const p = await open();
    await p.click('[data-testid="md-gate-pass-group-tabs"] button:nth-child(3)');
    expect(text("md-gate-pass-group-bars")).toContain("Gate 1");
    await p.click('[data-testid="bar-Gate 1"] button');
    expect(p.requests().some((r) => r.startsWith(`${B}/pass-list`) && r.includes("gate=Gate+1"))).toBe(true);
  });

  it("says so when there is nothing, and keeps working when a card fails", async () => {
    await open(EMPTY);
    expect(text("md-gate-pass-trend-empty")).toContain("Nobody asked for a gate pass");
    expect(text("md-gate-pass-attention")).toContain("Nothing needs your attention");
    page?.unmount();
    page = await renderMdPage(
      GatePassInsights,
      { ...FIXTURES, [`${B}/outpass`]: { status: 400, body: { error: "The outpass figures failed." } } },
      { path: "/md/outpass-visitors/outpass" },
    );
    expect(text("md-gate-pass-groups")).toContain("The outpass figures failed.");
    expect(text("md-gate-pass-kpi-requests")).toContain("12");
  });

  it("the strip shows who is outside now and only the gate-pass figures", async () => {
    page = await renderMdPage(Strip, FIXTURES, { path: "/md/outpass-visitors/outpass" });
    expect(text("md-gate-pass-strip-outside")).toContain("Outside now1");
    expect(text("md-gate-pass-strip")).toContain("Outpasses today");
    expect(text("md-gate-pass-strip")).not.toContain("Visitors today");
    expect(text("md-gate-pass-strip-insights")).toContain("never scanned back in");
  });
});
