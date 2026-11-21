import { cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import { renderMdPage, type RenderedPage } from "../../testing/renderMdPage";
import { emptyPunchFixtures, punchFixtures, SUMMARY } from "./fixtures";
import PunchInsights, { Strip } from "./index";
import { familySlices, TILES, tileDelta } from "./logic";
import { punchLine } from "./PunchDrill";

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
const lastCall = (p: RenderedPage, path: string) => {
  const urls = p.requests().filter((u) => u.split("?")[0] === path);
  return new URLSearchParams((urls[urls.length - 1] ?? "").split("?")[1] ?? "");
};

describe("Attendance Search insights", () => {
  it("shows how punches arrived this month, with the server's own sentences", async () => {
    page = await renderMdPage(PunchInsights, punchFixtures(), { path: "/md/attendance/search" });
    expect(lastCall(page, "/api/md/punches/summary").get("period")).toBe("this_month");
    expect(text('[data-testid="md-punch-sentence-1"]')).toBe(
      "1 On-Duty punch is still waiting for HR to verify, so it is not attendance yet.",
    );
    expect(text('[data-testid="md-punch-kpi-punches-value"]')).toBe("11");
    expect(text('[data-testid="md-punch-kpi-hand-value"]')).toBe("3"); // too few punches for a share
    expect(text('[data-testid="md-punch-kpi-devices-value"]')).toBe("1 of 2");
    expect(text('[data-testid="md-punch-kpi-held-value"]')).toBe("1");
    expect(text('[data-testid="md-punch-attention"]')).toContain("Line 2 has stopped sending punches");
    expect(text('[data-testid="md-punch-families"]')).toContain("Auto Attendance");
    expect(text('[data-testid="md-punch-missing-1"]')).toContain("Anil T");
    const ctx = getAssistantState().context;
    expect(ctx?.page).toBe("attendance-search");
    expect(ctx?.summary?.["On-Duty punches waiting for HR"]).toBe(1);
  });

  it("drills from a figure to the people and on to one person's punches", async () => {
    page = await renderMdPage(PunchInsights, punchFixtures(), { path: "/md/attendance/search" });
    await page.click('[data-testid="md-punch-kpi-hand"]');
    expect(text('[data-testid="md-punch-drill"]')).toContain("Punches entered by hand");
    expect(text('[data-testid="md-punch-drill-person-1"]')).toContain("2 on 1 days");
    await page.click('[data-testid="md-punch-drill-person-1"] button');
    expect(text('[data-testid="md-punch-drill-day-2026-09-08"]')).toContain("a punch is missing");
    expect(text('[data-testid="md-punch-drill-day-2026-09-08"]')).toContain("11:00 IN On-Duty (waiting for HR)");
    expect(text('[data-testid="md-punch-drill-totals"]')).toContain("40%");
    await page.click('[data-testid="md-punch-drill-back"]');
    expect(q('[data-testid="md-punch-drill-manual"]')).not.toBeNull();
  });

  it("opens a person straight from the missing-punch list, and the devices", async () => {
    page = await renderMdPage(PunchInsights, punchFixtures(), { path: "/md/attendance/search" });
    await page.click('[data-testid="md-punch-missing-1"]');
    expect(lastCall(page, "/api/md/punches/employee/1").get("period")).toBe("this_month");
    expect(text('[data-testid="md-punch-drill"]')).toContain("Anil T");
  });

  it("follows a range of days", async () => {
    page = await renderMdPage(PunchInsights, punchFixtures(), { path: "/md/attendance/search" });
    await page.click('[data-testid="md-punch-filters-range-mode"]');
    expect(lastCall(page, "/api/md/punches/sources").get("period")).toBe("today");
  });

  it("is calm when there is nothing, and shows a failure", async () => {
    page = await renderMdPage(PunchInsights, emptyPunchFixtures(), { path: "/md/attendance/search" });
    expect(text('[data-testid="md-punch-sources"]')).toContain("No punches in this period.");
    expect(text('[data-testid="md-punch-missing"]')).toContain("Nobody missed a punch");
    expect(text('[data-testid="md-punch-notes"]')).toContain("No punches were recorded");
    page.unmount();
    page = await renderMdPage(
      PunchInsights,
      punchFixtures({ "/api/md/punches/summary": { status: 400, body: { error: "Bad month." } } }),
      { path: "/md/attendance/search" },
    );
    expect(page.text()).toContain("Bad month.");
  });

  it("the strip: this month's punches, devices and what waits for HR", async () => {
    page = await renderMdPage(Strip, punchFixtures(), { path: "/md/attendance/search" });
    expect(text('[data-testid="md-punch-strip-punches"]')).toContain("11");
    expect(text('[data-testid="md-punch-strip-devices"]')).toContain("1 silent");
    expect(text('[data-testid="md-punch-strip-held"]')).toContain("1");
    expect(text('[data-testid="md-punch-strip-insights"]')).toContain("Line 2 has stopped");
  });
});

describe("Attendance Search logic", () => {
  it("colours changes by what is good news", () => {
    const missing = TILES.find((t) => t.id === "missing")!;
    expect(tileDelta(missing, SUMMARY)).toEqual({ text: "+1", tone: "bad", direction: "up" });
    const punches = TILES.find((t) => t.id === "punches")!;
    expect(tileDelta(punches, SUMMARY)).toEqual({ text: "+11", tone: "neutral", direction: "up" });
  });

  it("orders the donut by size and words a day of punches", () => {
    expect(familySlices(SUMMARY).map((s) => s.name)).toEqual([
      "Biometric devices",
      "Geo Punch",
      "HR Entry",
      "Auto Attendance",
      "Missing Punch",
    ]);
    expect(
      punchLine({
        date: "2026-09-08",
        punches: [{ time: "09:00:00", type: "IN", family: "biometric", label: "Biometric", device: "dev1" }],
        held: [{ time: "11:00:00", type: "IN", status: "rejected" }],
        request: null,
        count: 1,
        odd: true,
      }),
    ).toBe("09:00 IN dev1 · 11:00 IN On-Duty (turned down)");
  });
});
