import { cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import { renderMdPage, type RenderedPage } from "../../testing/renderMdPage";
import ProductionInsights, { Strip as ProductionStrip } from "../attendance-production/index";
import { emptyInsightsFixtures, insightsFixtures } from "./fixtures";
import StaffInsights, { Strip } from "./index";

// jsdom has no layout: give recharts a size so the real chart configuration renders.
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

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const text = (selector: string) => q(selector)?.textContent ?? null;

/** The last request made to an endpoint, as its query string. */
function lastCall(p: RenderedPage, path: string): URLSearchParams {
  const urls = p.requests().filter((u) => u.split("?")[0] === path);
  return new URLSearchParams((urls[urls.length - 1] ?? "").split("?")[1] ?? "");
}

describe("Staff Attendance insights", () => {
  it("opens on this month for staff and shows the overview the server wrote", async () => {
    page = await renderMdPage(StaffInsights, insightsFixtures(), { path: "/md/attendance/staff" });
    const call = lastCall(page, "/api/md/attendance/summary");
    expect(call.get("period")).toBe("this_month");
    expect(call.get("type")).toBe("staff");
    expect(q('[data-testid="month-picker"]')).not.toBeNull();
    expect(q('[data-testid="scope-type"]')).toBeNull(); // the page is one kind of employee

    expect(text('[data-testid="md-att-sentence-attendance"]')).toBe(
      "Attendance was 75.9% of scheduled days (down 13.7 points on the previous period).",
    );
    expect(text('[data-testid="md-att-sentence-deductions"]')).toContain("1 shift deducted in all");
    expect(text('[data-testid="md-att-kpi-attendancePct"]')).toContain("75.9%");
    expect(text('[data-testid="md-att-kpi-quarterDays"]')).toContain("2");
    expect(text('[data-testid="md-att-kpi-shiftsEarned"]')).toContain("3.00");
    expect(text('[data-testid="md-att-today-present"]')).toContain("220");
    expect(text('[data-testid="md-att-today"]')).toContain("228 of 262 working");
    // the data gap note is shown
    expect(page.text()).toContain("1 day for production (2026-09-08)");
    // the older analytics cards are there, fed the same filters
    expect(q('[data-testid="md-attendance-attention"]')).not.toBeNull();
    expect(q('[data-testid="md-attendance-departments"]')).not.toBeNull();

    const ctx = getAssistantState().context;
    expect(ctx?.page).toBe("attendance");
    expect(ctx?.summary?.Attendance).toBe("75.9%");
    expect(ctx?.summary?.["Quarter shift off (days)"]).toBe("2");
  });

  it("drills from a figure to the people behind it and on to one person's days", async () => {
    page = await renderMdPage(StaffInsights, insightsFixtures(), { path: "/md/attendance/staff" });
    await page.click('[data-testid="md-att-kpi-absenteeismPct"]');
    await page.settle();
    expect(lastCall(page, "/api/md/attendance/people").get("metric")).toBe("absent");
    expect(text('[data-testid="md-att-drill"]')).toContain("3 people, 5 days");
    expect(text('[data-testid="md-att-drill-person-2"]')).toContain("Bala Raj");
    expect(text('[data-testid="md-att-drill-person-2"]')).toContain("3 days · 33.3% attendance");

    await page.click('[data-testid="md-att-drill-person-2"] button');
    await page.settle();
    expect(text('[data-testid="md-att-drill"]')).toContain("Bala Raj");
    expect(text('[data-testid="md-att-drill-day-2026-09-08"]')).toContain("late 40 min");
    expect(text('[data-testid="md-att-drill-day-2026-09-08"]')).toContain("0.25 off (after the Late window)");
    expect(text('[data-testid="md-att-drill-totals"]')).toContain("75%");

    await page.click('[data-testid="md-att-drill-back"]');
    await page.settle();
    expect(q('[data-testid="md-att-drill-people"]')).not.toBeNull();
  });

  it("opens who is on one of today's cards", async () => {
    page = await renderMdPage(StaffInsights, insightsFixtures(), { path: "/md/attendance/staff" });
    await page.click('[data-testid="md-att-today-absent"]');
    await page.settle();
    expect(lastCall(page, "/api/md/attendance/today-people").get("state")).toBe("absent");
    expect(text('[data-testid="md-att-drill-today-4"]')).toContain("Dev Prakash");
  });

  it("follows the month the MD picks and keeps it in the address", async () => {
    page = await renderMdPage(StaffInsights, insightsFixtures(), { path: "/md/attendance/staff" });
    await page.click('[data-testid="month-prev"]');
    await page.settle();
    const call = lastCall(page, "/api/md/attendance/trend");
    expect(call.get("month")).toMatch(/^\d{4}-\d{2}$/);
    expect(call.get("type")).toBe("staff");
    expect(window.location.search).toContain("i.month=");
  });

  it("says so when there is nothing, without breaking", async () => {
    page = await renderMdPage(StaffInsights, emptyInsightsFixtures(), { path: "/md/attendance/staff" });
    expect(text('[data-testid="md-att-briefing"]')).toContain("No completed day with attendance records yet.");
    expect(q('[data-testid="md-att-today"]')).toBeNull();
    expect(text('[data-testid="md-att-kpi-attendancePct"]')).toContain("—");
  });

  it("shows the server's message when the figures fail", async () => {
    page = await renderMdPage(
      StaffInsights,
      insightsFixtures({ "/api/md/attendance/summary": { status: 400, body: { error: "The figures broke." } } }),
      { path: "/md/attendance/staff" },
    );
    expect(page.text()).toContain("The figures broke.");
  });
});

describe("Production Attendance insights", () => {
  it("asks for production only and names the page", async () => {
    page = await renderMdPage(ProductionInsights, insightsFixtures(), { path: "/md/attendance/production" });
    expect(lastCall(page, "/api/md/attendance/summary").get("type")).toBe("production");
    expect(lastCall(page, "/api/md/attendance/departments").get("type")).toBe("production");
    expect(text('[data-testid="md-att-briefing"]')).toContain("Production Attendance in brief");
    expect(getAssistantState().context?.page).toBe("attendance-production");
  });
});

describe("the strip above the page", () => {
  it("shows today so far, this month and the top exception", async () => {
    page = await renderMdPage(Strip, insightsFixtures(), { path: "/md/attendance/staff" });
    expect(text('[data-testid="md-att-strip-today"]')).toContain("228 of 262");
    expect(text('[data-testid="md-att-strip-today"]')).toContain("17 not in yet");
    expect(text('[data-testid="md-att-strip-month"]')).toContain("75.9%");
    expect(text('[data-testid="md-att-strip-insights"]')).toContain("Stitching absenteeism is 14%");
  });

  it("production's strip asks for production", async () => {
    page = await renderMdPage(ProductionStrip, insightsFixtures(), { path: "/md/attendance/production" });
    expect(lastCall(page, "/api/md/attendance/summary").get("type")).toBe("production");
  });

  it("stays away when there is nothing to say", async () => {
    page = await renderMdPage(Strip, emptyInsightsFixtures(), { path: "/md/attendance/staff" });
    expect(q('[data-testid="md-att-strip"]')).toBeNull();
  });
});
