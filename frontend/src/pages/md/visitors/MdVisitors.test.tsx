// Smoke test of the Outpass & Visitors page: it is rendered inside the real providers with a fixture for every endpoint
// it calls (nothing touches a network), and asserts what the MD would see, including one failed endpoint and a period
// with nothing in it.

import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import MdVisitors from "../MdVisitors";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import {
  ACTIVITY,
  ACTIVITY_EMPTY,
  EXCEPTIONS,
  EXCEPTIONS_EMPTY,
  OUTPASS,
  OUTPASS_EMPTY,
  SUMMARY,
  SUMMARY_EMPTY,
  TREND,
  TREND_EMPTY,
  UNITS,
  UNITS_ONE,
  VISITORS,
  VISITORS_EMPTY,
} from "./fixtures";

const P = "/api/md/visitors/";

const FULL: Fixtures = {
  [`${P}summary`]: SUMMARY,
  [`${P}trend`]: TREND,
  [`${P}units`]: UNITS,
  [`${P}visitors`]: VISITORS,
  [`${P}outpass`]: OUTPASS,
  [`${P}exceptions`]: EXCEPTIONS,
  [`${P}activity`]: ACTIVITY,
};

const EMPTY: Fixtures = {
  [`${P}summary`]: SUMMARY_EMPTY,
  [`${P}trend`]: TREND_EMPTY,
  [`${P}units`]: UNITS_ONE,
  [`${P}visitors`]: VISITORS_EMPTY,
  [`${P}outpass`]: OUTPASS_EMPTY,
  [`${P}exceptions`]: EXCEPTIONS_EMPTY,
  [`${P}activity`]: ACTIVITY_EMPTY,
};

// jsdom has no layout, so recharts complains that its container has no size on every chart: not what these tests look at.
beforeAll(() => {
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("width(0) and height(0) of chart")) return;
      original(...args);
    });
  }
});

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const mount = async (fixtures: Fixtures = {}) => {
  page = await renderMdPage(MdVisitors, { ...FULL, ...fixtures }, { path: "/md/visitors" });
  return page;
};

const textOf = (p: RenderedPage, testId: string) =>
  p.container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

const count = (p: RenderedPage, selector: string) => p.container.querySelectorAll(selector).length;

/** Click the nth tab (1-based) of the tab strip with this test id. */
const tab = (testId: string, n: number) => `[data-testid="${testId}"] [role="tab"]:nth-child(${n})`;

const pause = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe("Outpass & Visitors page", () => {
  it("shows the headline figures, what needs attention and every section", async () => {
    const p = await mount();
    expect(textOf(p, "md-page-title")).toBe("Outpass & Visitors");

    // the eight headline cards, each with the figure the backend sent
    expect(textOf(p, "md-visitors-kpi-visits-value")).toBe("11");
    expect(textOf(p, "md-visitors-kpi-peak-value")).toBe("11 am");
    expect(textOf(p, "md-visitors-kpi-outpasses-value")).toBe("12");
    expect(textOf(p, "md-visitors-kpi-hoursOut-value")).toBe("5h 25m");
    expect(textOf(p, "md-visitors-kpi-returnRate-value")).toBe("87.5%");
    expect(textOf(p, "md-visitors-kpi-waiting-value")).toBe("3");
    expect(textOf(p, "md-visitors-kpi-approvalTime-value")).toBe("16m");
    expect(textOf(p, "md-visitors-kpi-rejection-value")).toBe("9.1%");
    expect(textOf(p, "md-visitors-kpi-waiting")).toContain("2 over 24 hours");
    expect(textOf(p, "md-visitors-kpi-visits")).toContain("+175%"); // 4 -> 11 against the previous 14 days

    // "Needs your attention": the critical finding first
    const attention = p.container.querySelector('[data-testid="md-visitors-attention"]')!;
    const items = [...attention.querySelectorAll("[data-severity]")].map((el) => el.getAttribute("data-severity"));
    expect(items).toEqual(["critical", "warning", "info"]);
    expect(attention.textContent).toContain("2 outpass requests waiting more than 24 hours for a decision");
    expect(attention.textContent).toContain("1 employee took 3 or more outpasses");

    // the trend and the visitors section
    expect(p.container.querySelector('[data-testid="md-visitors-trend"] [data-testid="trend-chart"]')).not.toBeNull();
    expect(textOf(p, "md-visitors-trend-totals")).toContain("11 visits · 12 outpass requests · 5h 25m out");
    expect(textOf(p, "md-visitors-purposes")).toContain("Supplier, vendor or sales");
    expect(textOf(p, "md-visitors-hosts")).toContain("Stitching");
    expect(textOf(p, "md-visitors-hosts")).toContain("Not matched to an employee");
    expect(textOf(p, "md-visitors-hosts")).toContain("does not ask for a company");
    expect(p.container.querySelector('[data-testid="md-visitors-heatmap"]')).not.toBeNull();
    expect(textOf(p, "md-visitors-times")).toContain("2 visits before 8:00 am or from 6:00 pm");
    expect(textOf(p, "md-visitors-top-hosts")).toContain("Asha Rao");
    expect(textOf(p, "md-visitors-top-hosts")).toContain("Name typed at the gate, not matched"); // "Stores"
    expect(textOf(p, "md-visitors-repeat")).toContain("Ravi Supplier");
    expect(textOf(p, "md-visitors-repeat")).toContain("Frequent"); // 4 visits
    expect(textOf(p, "md-visitors-section-heading")).toContain("check-in only"); // no check-out: said, not faked

    // unit by unit (two units to compare)
    expect(textOf(p, "md-units-table")).toContain("Unit 1");
    expect(textOf(p, "md-units-table")).toContain("4 active staff");
    expect(textOf(p, "md-units-table")).toContain("4h 55m"); // 295 minutes out in Unit 1

    // the outpass section
    expect(textOf(p, "md-outpass-funnel")).toContain("Asked to leave");
    expect(textOf(p, "md-outpass-funnel")).toContain("Never returned: 1");
    expect(textOf(p, "md-outpass-funnel")).toContain("1 On-Duty trip");
    expect(textOf(p, "md-outpass-departments")).toContain("5h 10m");
    expect(textOf(p, "md-outpass-departments")).toContain("266.7 per 100 staff");
    expect(textOf(p, "md-outpass-reasons")).toContain("Personal emergency");
    expect(textOf(p, "md-outpass-durations")).toContain("Typical (median) 30m");
    expect(textOf(p, "md-outpass-approvals")).toContain("36 days 2 hours");
    expect(textOf(p, "md-outpass-gate")).toContain("Pass expired");
    expect(textOf(p, "md-outpass-gate")).toContain("Gate 1");

    // exceptions and the feed
    expect(textOf(p, "md-exceptions-table-repeat")).toContain("Asha Rao");
    expect(textOf(p, "md-activity-table")).toContain("Esha Gupta");
    expect(textOf(p, "md-activity-table")).toContain("Ravi Supplier");
    expect(textOf(p, "md-activity-range")).toBe("Showing 1–4 of 25");

    // every card can be explained and questioned
    expect(count(p, '[data-testid="provenance-button"]')).toBeGreaterThan(15);
    expect(count(p, '[data-testid="ask-ai"]')).toBeGreaterThan(8);
  });

  it("calls every endpoint once with the chosen period and keeps the standing notes out of the banners", async () => {
    const p = await mount();
    const calls = p.requests();
    for (const endpoint of ["summary", "trend", "units", "visitors", "outpass", "exceptions", "activity"]) {
      expect(calls.filter((c) => c.startsWith(`${P}${endpoint}?`))).toHaveLength(1);
    }
    expect(calls.find((c) => c.startsWith(`${P}summary`))).toBe(`${P}summary?period=last_30_days`);
    expect(calls.find((c) => c.startsWith(`${P}exceptions`))).toContain("limit=25");
    expect(calls.find((c) => c.startsWith(`${P}activity`))).toContain("pageSize=25");
    expect(count(p, '[data-testid="md-note"]')).toBe(0); // the "no check-out" note sits beside the visitors instead
  });

  it("shows a note that matters (return scanning looks unused)", async () => {
    const note = "Only 35% of the passes that left were scanned back in, so hours out rest on few passes.";
    const p = await mount({ [`${P}summary`]: { ...SUMMARY, notes: [...SUMMARY.notes, note] } });
    expect(textOf(p, "md-note")).toContain("Only 35% of the passes that left");
  });

  it("opens each exception tab with its own rule and rows", async () => {
    const p = await mount();
    expect(textOf(p, "md-visitors-exceptions")).toContain("3 or more approved outpasses");

    await p.click(tab("md-visitors-exception-tabs", 2));
    expect(textOf(p, "md-exceptions-table-notReturned")).toContain("Farid Khan");
    expect(textOf(p, "md-exceptions-table-notReturned")).toContain("out for 3h 30m so far");
    expect(textOf(p, "md-exceptions-table-notReturned")).toContain("6 days ago");
    expect(textOf(p, "md-visitors-exceptions")).toContain("Early-dismissal passes are not expected back");

    await p.click(tab("md-visitors-exception-tabs", 3));
    expect(textOf(p, "md-exceptions-table-long")).toContain("2h 30m");
    expect(textOf(p, "md-visitors-exceptions")).toContain("2× the typical pass (30m)");

    await p.click(tab("md-visitors-exception-tabs", 4));
    expect(textOf(p, "md-exceptions-table-waiting")).toContain("36 days 2 hours");
    expect(textOf(p, "md-visitors-exceptions")).toContain("across all dates");

    await p.click(tab("md-visitors-exception-tabs", 5));
    expect(textOf(p, "md-exceptions-table-afterHours")).toContain("Early Bird");
    expect(textOf(p, "md-exceptions-table-afterHours")).toContain("Mr Kumar");
  });

  it("asks every endpoint again when the period changes", async () => {
    const p = await mount();
    await p.click(tab("period-bar", 2)); // Last 7 days
    const calls = p.requests();
    for (const endpoint of ["summary", "trend", "units", "visitors", "outpass", "exceptions", "activity"]) {
      expect(calls.some((c) => c.startsWith(`${P}${endpoint}?`) && c.includes("period=last_7_days"))).toBe(true);
    }
    expect(textOf(p, "md-visitors-kpi-visits-value")).toBe("11"); // the old figures stay up while the new ones load
  });

  it("searches the activity feed and pages through it", async () => {
    const pageOf = (params: URLSearchParams) => Number(params.get("page") ?? 1);
    const p = await mount({
      [`${P}activity`]: (params: URLSearchParams) =>
        pageOf(params) === 1
          ? { ...ACTIVITY, total: 27 }
          : { ...ACTIVITY, page: pageOf(params), total: 27, hasMore: false, items: ACTIVITY.items.slice(0, 2) },
    });
    expect(textOf(p, "md-activity-range")).toBe("Showing 1–4 of 27");

    await p.click('[data-testid="md-activity-next"]');
    expect(p.requests().some((c) => c.startsWith(`${P}activity`) && c.includes("page=2"))).toBe(true);
    expect(textOf(p, "md-activity-range")).toBe("Showing 26–27 of 27");
    expect(p.container.querySelector<HTMLButtonElement>('[data-testid="md-activity-next"]')?.disabled).toBe(true);

    await p.type('[data-testid="md-activity-search"]', "sales");
    await pause(400); // the search waits for a pause in typing before it asks
    await p.settle();
    const search = p.requests().filter((c) => c.startsWith(`${P}activity`) && c.includes("q=sales"));
    expect(search.length).toBeGreaterThan(0);
    expect(search[0]).toContain("page=1"); // a new search starts from the newest
    expect(p.requests().filter((c) => c.includes("q=sal")).length).toBe(search.length); // not one request per key

    await p.click(tab("md-activity-kinds", 2)); // Visitors only
    expect(p.requests().some((c) => c.startsWith(`${P}activity`) && c.includes("kind=visits"))).toBe(true);
  });

  it("shows the unit comparison only when there is more than one unit", async () => {
    const one = await mount({ [`${P}units`]: UNITS_ONE });
    expect(one.container.querySelector('[data-testid="md-visitors-units"]')).toBeNull();
    one.unmount();
    page = undefined;
    const two = await mount();
    expect(two.container.querySelector('[data-testid="md-visitors-units"]')).not.toBeNull();
  });

  it("lets the MD see every department, not just the first few", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...OUTPASS.byDepartment[0],
      department: `Dept ${i + 1}`,
      minutesOut: 400 - i * 10,
    }));
    const p = await mount({ [`${P}outpass`]: { ...OUTPASS, byDepartment: many, departmentsTotal: 8 } });
    const bars = () => count(p, '[data-testid="md-outpass-department-bars"] > li');
    expect(bars()).toBe(6);
    await p.click('[data-testid="md-outpass-show-all"]');
    expect(bars()).toBe(8);
    expect(textOf(p, "md-outpass-show-all")).toBe("Show fewer");
  });

  it("switches the trend to time out without losing the data", async () => {
    const p = await mount();
    await p.click(tab("md-visitors-trend-tabs", 2));
    expect(p.container.querySelector('[data-testid="trend-chart"]')).not.toBeNull();
    expect(textOf(p, "md-visitors-trend-totals")).toContain("5h 25m out");
  });

  it("publishes what it shows to the assistant", async () => {
    await mount();
    const ctx = getAssistantState().context;
    expect(ctx?.page).toBe("visitors");
    expect(ctx?.title).toBe("Outpass & Visitors");
    expect(ctx?.filters).toMatchObject({ Period: "21 Sep – 04 Oct 2026" });
    expect(ctx?.summary).toMatchObject({ Visits: 11, "Return rate": "87.5%", "Waiting for approval": 3 });
  });

  it("keeps the rest of the page when one endpoint fails", async () => {
    const p = await mount({ [`${P}exceptions`]: { status: 400, body: { error: "The gate data is unavailable" } } });
    expect(textOf(p, "md-visitors-kpi-visits-value")).toBe("11"); // everything else still loads
    expect(textOf(p, "md-visitors-purposes")).toContain("Supplier, vendor or sales");
    expect(textOf(p, "md-outpass-funnel")).toContain("Asked to leave");
    const errors = [...p.container.querySelectorAll('[data-testid="md-error"]')].map((e) => e.textContent);
    expect(errors).toHaveLength(2); // "Needs your attention" and "Exceptions" both depend on it
    expect(errors.every((e) => e?.includes("The gate data is unavailable"))).toBe(true);
  });

  it("never lets the figures of the old filter stand in for a filter that failed", async () => {
    // the first choice (last 30 days) loads; asking for the last 7 days is refused
    const p = await mount({
      [`${P}summary`]: (params: URLSearchParams) =>
        params.get("period") === "last_7_days"
          ? { status: 400, body: { error: "That period is not available" } }
          : SUMMARY,
      [`${P}outpass`]: (params: URLSearchParams) =>
        params.get("period") === "last_7_days"
          ? { status: 400, body: { error: "That period is not available" } }
          : OUTPASS,
    });
    expect(textOf(p, "md-visitors-kpi-visits-value")).toBe("11");
    await p.click(tab("period-bar", 2));
    expect(textOf(p, "md-visitors-kpi-visits-value")).toBe("—"); // not the 30-day figure under a 7-day filter
    expect(textOf(p, "md-visitors-purposes")).toContain("Supplier"); // endpoints that did answer stay
    expect(textOf(p, "md-outpass-section")).toContain("That period is not available");
    expect(p.container.querySelector('[data-testid="md-outpass-funnel"]')).toBeNull();
  });

  it("says so when the headline figures cannot be loaded", async () => {
    const p = await mount({ [`${P}summary`]: { status: 400, body: { error: "summary failed" } } });
    expect(textOf(p, "md-visitors-kpi-visits-value")).toBe("—");
    expect(textOf(p, "md-error")).toContain("summary failed");
    expect(textOf(p, "md-visitors-purposes")).toContain("Supplier, vendor or sales"); // the sections do not depend on it
  });

  it("tells the truth when nothing was recorded", async () => {
    const p = await mount(EMPTY);
    expect(textOf(p, "md-visitors-kpi-visits-value")).toBe("0");
    expect(textOf(p, "md-visitors-kpi-hoursOut-value")).toBe("—"); // not "0m": nothing was measured
    expect(textOf(p, "md-visitors-kpi-returnRate-value")).toBe("—");
    expect(textOf(p, "md-visitors-kpi-peak-value")).toBe("—");
    expect(textOf(p, "md-visitors-attention")).toContain("Nothing needs your attention at the gate in this period.");
    expect(textOf(p, "md-visitors-trend-empty")).toContain("Nothing recorded in this period");
    expect(textOf(p, "md-visitors-none")).toContain("Nobody checked in at the gate");
    expect(textOf(p, "md-outpass-none")).toContain("Nobody asked to leave");
    expect(textOf(p, "md-visitors-activity")).toContain("Nothing was recorded in this period.");
    expect(textOf(p, "md-visitors-exceptions")).toContain("Nobody took that many outpasses in this period.");
    expect(count(p, '[data-testid="md-error"]')).toBe(0);
  });
});
