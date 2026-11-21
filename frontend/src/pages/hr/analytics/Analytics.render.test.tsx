import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Analytics from "../Analytics";
import { FIXTURE_EMPLOYEES_LITE, fixtureServer } from "./fixtures";

// The Analytics page against the fixture answers of the three endpoints (customFetch is replaced): the filters in the
// address both ways, a tab switch that keeps them, the period picker (quick picks, a month, a Mon-Sun week), the level
// chips of the list, the category drill-down and the employee drill-down with its records and patterns.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn(), urls: [] as string[] }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ user: null }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

function server(url: string) {
  h.urls.push(url);
  if (url.startsWith("/api/hr-analytics/")) {
    try {
      return Promise.resolve(fixtureServer(url));
    } catch (err) {
      return Promise.reject(err);
    }
  }
  if (url.startsWith("/api/employees")) return Promise.resolve(FIXTURE_EMPLOYEES_LITE);
  if (url.startsWith("/api/payroll-settings")) return Promise.resolve({ companyName: "UK Textiles" });
  return Promise.resolve([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.urls = [];
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-21T10:00:00") });
  h.fetch.mockImplementation(server);
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

async function mount(search = "") {
  window.history.replaceState(null, "", `/hr/analytics${search}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(Analytics))));
  await flush();
  return host;
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const all = (prefix: string) => [...document.querySelectorAll(`[data-testid^="${prefix}"]`)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const params = () => new URLSearchParams(window.location.search);
const click = (el: Element | null) => {
  expect(el, "element to click").not.toBeNull();
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
function type(el: Element | null, value: string) {
  expect(el, "field to type in").not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function choose(el: Element | null, value: string) {
  expect(el, "select").not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const tab = (name: string) =>
  [...document.querySelectorAll('[data-testid="analytics-tabs"] [role="tab"]')].find((b) => text(b).includes(name)) ??
  null;
const rowIds = () =>
  all("attention-row-").map((r) => Number(r.getAttribute("data-testid")!.replace("attention-row-", "")));
const lastSummaryUrl = () => [...h.urls].reverse().find((u) => u.startsWith("/api/hr-analytics/summary")) ?? "";

describe("the Analytics page", () => {
  it("opens on Staff, this month: figures, insights, category cards and who needs attention", async () => {
    await mount();
    expect(lastSummaryUrl()).toBe("/api/hr-analytics/summary?type=staff&from=2026-11-01&to=2026-11-21");
    expect(text(q("period-label"))).toBe("1 Nov - 21 Nov 2026");
    expect(text(q("kpi-scope-value"))).toBe("104");
    expect(text(q("kpi-attention-value"))).toBe("8");
    expect(text(q("kpi-high-value"))).toBe("3");
    expect(q("insight-high")).not.toBeNull();
    expect(all("category-card-").filter((c) => !c.getAttribute("data-testid")!.endsWith("-value"))).toHaveLength(11);
    expect(q("category-card-late")?.getAttribute("data-state")).toBe("high");
    expect(q("category-card-leave")?.getAttribute("data-state")).toBe("attention");
    // the list opens on those needing attention, worst first, each with a level in words
    expect(rowIds()).toEqual([6, 7, 5, 15, 14, 9, 10, 8]);
    expect(text(q("attention-row-5"))).toContain("High");
    expect(text(q("attention-row-7"))).toContain("Attention");
    expect(text(q("attention-count"))).toBe("8 needing attention listed");
    expect(q("hod-view")).not.toBeNull();
    expect(q("data-gap-note")).toBeNull();
  });

  it("filters in the address open the same page (round trip), and the server is asked for them", async () => {
    await mount("?period=custom&from=2026-11-02&to=2026-11-08&dept=3&q=surya");
    expect(lastSummaryUrl()).toBe(
      "/api/hr-analytics/summary?type=staff&from=2026-11-02&to=2026-11-08&departmentId=3&q=surya",
    );
    expect(text(q("period-label"))).toBe("2 Nov - 8 Nov 2026");
    expect(text(q("analytics-page"))).toContain('Search: "surya"');
    expect((q("analytics-search") as HTMLInputElement).value).toBe("surya");
    expect(rowIds()).toEqual([5]);
  });

  it("the search reaches the address and the server 300 ms after the last key", async () => {
    await mount();
    type(q("analytics-search"), "gokul");
    // the list narrows at once
    expect(rowIds()).toEqual([15]);
    expect(params().get("q")).toBeNull();
    await wait(350);
    await flush();
    expect(params().get("q")).toBe("gokul");
    expect(lastSummaryUrl()).toContain("q=gokul");
    click(document.querySelector('[aria-label="Clear search"]'));
    expect(params().get("q")).toBeNull();
  });

  it("switching to Production keeps every filter and shows production's own checks", async () => {
    await mount("?period=last_month&q=a&emp=101");
    click(tab("Production"));
    await flush();
    expect(params().get("tab")).toBe("production");
    expect(params().get("period")).toBe("last_month");
    expect(params().get("q")).toBe("a");
    expect(params().get("emp")).toBe("101");
    expect(lastSummaryUrl()).toBe(
      "/api/hr-analytics/summary?type=production&from=2026-10-01&to=2026-10-31&employeeId=101&q=a",
    );
    // and back: still the same filters
    click(tab("Staff"));
    await flush();
    expect(params().get("tab")).toBeNull();
    expect(params().get("period")).toBe("last_month");
  });

  it("Production: its five categories, the reference-only one calm, no HOD view, the device gap note", async () => {
    await mount("?tab=production");
    expect(all("category-card-").filter((c) => !c.getAttribute("data-testid")!.endsWith("-value"))).toHaveLength(5);
    expect(q("category-card-late_details")?.getAttribute("data-state")).toBe("info");
    expect(q("hod-view")).toBeNull();
    expect(text(q("data-gap-note"))).toContain(
      "3 days left out: no punches arrived from the devices (3 Nov - 4 Nov, 11 Nov)",
    );
  });

  it("the period picker: quick picks, a month (month + year) and a Mon-Sun week", async () => {
    await mount();
    click(q("period-button"));
    expect(q("period-panel")).not.toBeNull();
    click(q("period-last_week"));
    expect(params().get("period")).toBe("last_week");
    expect(params().get("from")).toBeNull();
    await flush();
    expect(lastSummaryUrl()).toContain("from=2026-11-09&to=2026-11-15");
    expect(text(q("period-label"))).toBe("9 Nov - 15 Nov 2026");

    click(q("period-button"));
    choose(q("period-month"), "9");
    expect(params().get("period")).toBe("month");
    expect(params().get("from")).toBe("2026-09-01");
    expect(params().get("to")).toBe("2026-09-30");
    choose(q("period-year"), "2025");
    expect(params().get("from")).toBe("2025-09-01");

    // any day picks its whole Monday-Sunday week; the arrows step a week
    type(q("period-week"), "2026-11-05");
    expect(params().get("period")).toBe("week");
    expect(params().get("from")).toBe("2026-11-02");
    expect(params().get("to")).toBe("2026-11-08");
    click(q("period-week-prev"));
    expect(params().get("from")).toBe("2026-10-26");
    expect(params().get("to")).toBe("2026-11-01");

    // a custom range is applied with its button
    type(q("period-from"), "2026-08-01");
    type(q("period-to"), "2026-10-31");
    click(q("period-apply"));
    expect(params().get("period")).toBe("custom");
    expect(params().get("from")).toBe("2026-08-01");
    expect(params().get("to")).toBe("2026-10-31");
  });

  it("the level chips choose who is listed, and a figure tile does the same", async () => {
    await mount();
    click(q("level-filter-high"));
    expect(rowIds()).toEqual([6, 5, 15]);
    expect(q("level-filter-high")?.getAttribute("aria-pressed")).toBe("true");
    click(q("level-filter-watch"));
    expect(rowIds()).toEqual([11, 12, 13, 16]);
    click(q("kpi-issues"));
    expect(rowIds()).toHaveLength(12);
    expect(text(q("attention-count"))).toBe("12 everyone with records listed");
  });

  it("sorts the list by a column heading", async () => {
    await mount();
    click(q("sort-name"));
    expect(rowIds()[0]).toBe(6); // ANITHA R
    click(q("sort-name"));
    expect(rowIds()[0]).toBe(9); // VIJAY K, Z to A
    click(q("sort-lastDate"));
    expect(rowIds().slice(0, 2)).toEqual([15, 5]); // the 20 Nov ones first, then A to Z
  });

  it("a category card opens its drill-down: people by count, against the limit, every record", async () => {
    await mount();
    click(q("category-card-late"));
    expect(params().get("cat")).toBe("late");
    await flush();
    const sheet = q("category-sheet");
    expect(sheet).not.toBeNull();
    expect(text(sheet)).toContain("Frequent late arrival");
    expect(text(q("category-sheet-figures"))).toContain("3Over the limit");
    const people = all("category-person-").filter((p) => /^category-person-\d+$/.test(p.getAttribute("data-testid")!));
    expect(people.map((p) => p.getAttribute("data-testid"))).toEqual([
      "category-person-15",
      "category-person-5",
      "category-person-14",
      "category-person-10",
      "category-person-11",
    ]);
    expect(text(q("category-person-5"))).toContain("6 / 3 days");
    expect(text(q("category-person-5"))).toContain("Mostly on Mondays");
    click(q("category-person-5-records"));
    expect(text(q("category-person-5"))).toContain("Late by first punch");
    // over the limit only
    click(q("category-over-only"));
    expect(text(q("category-count"))).toBe("3 employees match");
  });

  it("an employee opens from the category with a way back, showing counts, timeline and patterns", async () => {
    await mount("?cat=late");
    click(document.querySelector('[aria-label="Open SURYA M, 30020"]'));
    expect(params().get("person")).toBe("5");
    expect(params().get("cat")).toBe("late");
    await flush();
    const sheet = q("employee-sheet");
    expect(text(sheet)).toContain("SURYA M");
    expect(text(q("employee-limit-late"))).toContain("6 / 3 days");
    expect(text(q("employee-limit-late"))).toContain("Twice the limit");
    expect(text(q("employee-limits"))).toContain("No records in:");
    // the timeline, newest first, filterable by category
    expect(text(q("employee-timeline"))).toContain("November 2026 (8)");
    click(q("timeline-filter-permissions"));
    expect(text(q("employee-timeline"))).toContain("November 2026 (2)");
    // the patterns: weekday bars, longest run, extras, the note
    click(q("employee-view-patterns"));
    expect(text(q("pattern-late"))).toContain("Mostly on Mondays");
    expect(text(q("pattern-late"))).toContain("Avg first punch");
    expect(q("pattern-late")?.querySelector('[data-testid="weekday-bars"]')?.getAttribute("aria-label")).toBe(
      "By weekday: Mon 3, Tue 2, Wed 0, Thu 0, Fri 1, Sat 0, Sun 0",
    );
    expect(q("employee-export")).not.toBeNull();
    // back to the category
    click(q("employee-back"));
    expect(params().get("person")).toBeNull();
    expect(params().get("cat")).toBe("late");
  });

  it("an employee opens from the list (no way back), and the address reopens it after a reload", async () => {
    await mount();
    click(q("attention-row-7"));
    expect(params().get("person")).toBe("7");
    await flush();
    expect(text(q("employee-sheet"))).toContain("KARTHIK S");
    expect(q("employee-back")).toBeNull();
    act(() => root!.unmount());
    host!.remove();
    await mount(window.location.search);
    expect(text(q("employee-sheet"))).toContain("KARTHIK S");
    expect(h.urls).toContain("/api/hr-analytics/employee/7?type=staff&from=2026-11-01&to=2026-11-21");
  });

  it("an insight opens what it talks about", async () => {
    await mount();
    click(q("insight-top-late-action"));
    expect(params().get("cat")).toBe("late");
    act(() => root!.unmount());
    host!.remove();
    await mount();
    click(q("insight-dept-5-action"));
    expect(params().get("dept")).toBe("5");
  });

  it("clear puts every filter back", async () => {
    await mount("?period=last_month&dept=3&q=x");
    click(q("clear-filters"));
    expect(window.location.search).toBe("");
  });
});
