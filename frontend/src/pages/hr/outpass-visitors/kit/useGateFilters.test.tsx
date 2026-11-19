import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useGateFilters, type GateFilters } from "./useGateFilters";

// The filters of a list live in the address: what the hook reads from it, what it writes back (with replace, page back to
// 1 on a filter change, defaults left out), what Clear does, and what goes to the API and to an export.

const DEFAULTS = { range: "today", from: "", to: "", gateId: "", type: "", q: "" };
const WITH_VIEW = { view: "visits", range: "today", from: "", to: "", status: "" };

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: GateFilters<Record<string, string>> | null = null;

function Probe({ defaults, keep }: { defaults: Record<string, string>; keep?: string[] }) {
  latest = useGateFilters(defaults, { keep });
  return null;
}

function mount(url: string, defaults: Record<string, string> = DEFAULTS, keep?: string[]) {
  window.history.replaceState(null, "", url);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(Probe, { defaults, keep })));
  return () => latest!;
}

const search = () => window.location.search;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-18T06:00:00Z")); // Wednesday 18 Nov, 11:30 in India
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = null;
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
});

describe("useGateFilters", () => {
  it("reads the filters from the address, its defaults for the rest", () => {
    const f = mount("/list?range=week&type=exit&page=3");
    expect(f().filters).toMatchObject({ range: "week", type: "exit", gateId: "", q: "", page: "3" });
    expect(f().page).toBe(3);
    expect(f().pageSize).toBeUndefined();
    expect(f().activeCount).toBe(2);
  });

  it("gives the API the days of the date filter (never `range`), the filters with a value and the page", () => {
    const f = mount("/list?range=week&type=exit&page=3");
    expect(f().dateRange).toEqual({ from: "2026-11-16", to: "2026-11-18" });
    expect(f().params.toString()).toBe("type=exit&from=2026-11-16&to=2026-11-18&page=3");
    expect(f().queryKey).toBe(f().params.toString());
    // an export gets the same rows, every page
    expect(f().exportQuery.toString()).toBe("type=exit&from=2026-11-16&to=2026-11-18");
  });

  it("a fresh list is today, page 1, nothing active, and a clean address", () => {
    const f = mount("/list");
    expect(f().params.toString()).toBe("from=2026-11-18&to=2026-11-18&page=1");
    expect(f().activeCount).toBe(0);
    expect(search()).toBe("");
  });

  it("writes a change to the address with replace, and goes back to page 1", () => {
    const f = mount("/list?type=exit&page=4");
    const before = window.history.length;
    act(() => f().set({ q: "ravi" }));
    expect(search()).toBe("?type=exit&q=ravi");
    expect(f().page).toBe(1);
    expect(window.history.length).toBe(before);
    // a default value leaves the address
    act(() => f().set({ type: "" }));
    expect(search()).toBe("?q=ravi");
  });

  it("turns pages without touching the filters", () => {
    const f = mount("/list?type=exit");
    act(() => f().setPage(2));
    expect(search()).toBe("?type=exit&page=2");
    act(() => f().setPage(0));
    expect(search()).toBe("?type=exit");
  });

  it("custom days are sent as typed (swapped when From is after To), and count as one filter", () => {
    const f = mount("/list");
    act(() => f().set({ range: "custom", from: "2026-11-10", to: "2026-11-02" }));
    expect(search()).toBe("?range=custom&from=2026-11-10&to=2026-11-02");
    expect(f().dateRange).toEqual({ from: "2026-11-02", to: "2026-11-10" });
    expect(f().activeCount).toBe(1);
  });

  it("a link with days but no range opens on those days, not on today", () => {
    const f = mount("/list?from=2026-01-01&to=2026-11-18&status=out");
    expect(f().filters.range).toBe("custom");
    expect(f().dateRange).toEqual({ from: "2026-01-01", to: "2026-11-18" });
    expect(f().params.toString()).toContain("from=2026-01-01&to=2026-11-18");
    expect(f().activeCount).toBe(1);
    // a preset chosen afterwards wins again (it clears the days)
    act(() => f().set({ range: "week", from: "", to: "" }));
    expect(f().dateRange).toEqual({ from: "2026-11-16", to: "2026-11-18" });
  });

  it("Clear puts every filter back and keeps what is not a filter (?view=)", () => {
    const f = mount("/visitors?view=people&range=month&status=inside&page=2", WITH_VIEW, ["view"]);
    expect(f().activeCount).toBe(2);
    act(() => f().clear());
    expect(search()).toBe("?view=people");
    expect(f().activeCount).toBe(0);
    expect(f().filters.view).toBe("people");
  });

  it("knows a page size when the list has one", () => {
    const f = mount("/list?pageSize=50", { range: "all", from: "", to: "", pageSize: "25" });
    expect(f().pageSize).toBe(50);
    expect(f().params.toString()).toBe("page=1&pageSize=50");
    expect(f().exportQuery.toString()).toBe("");
  });

  it("an unreadable page in a pasted link is page 1", () => {
    const f = mount("/list?page=abc");
    expect(f().page).toBe(1);
    expect(f().params.get("page")).toBe("1");
  });
});

describe("a list left open past midnight in India", () => {
  /** The clock and the timers (beforeEach fakes only the clock; fake timers are not re-installed while on). */
  const fakeClockAndTimers = () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  };
  const MIDNIGHT_SOON = new Date("2026-11-30T18:29:00Z"); // Monday 30 Nov, 23:59 in India

  it("moves Today to the new day by itself at India's midnight (no click, no reload)", () => {
    fakeClockAndTimers();
    vi.setSystemTime(MIDNIGHT_SOON);
    const f = mount("/list");
    expect(f().dateRange).toEqual({ from: "2026-11-30", to: "2026-11-30" });
    act(() => vi.advanceTimersByTime(2 * 60_000)); // 00:01 on Tuesday 1 Dec
    expect(f().dateRange).toEqual({ from: "2026-12-01", to: "2026-12-01" });
    expect(f().params.toString()).toBe("from=2026-12-01&to=2026-12-01&page=1");
    expect(f().queryKey).toBe("from=2026-12-01&to=2026-12-01&page=1");
  });

  it("This month follows into the new month, and a re-render after midnight has the new day too", () => {
    vi.setSystemTime(MIDNIGHT_SOON); // only the clock is fake here: no timer fires
    const f = mount("/list?range=month");
    expect(f().dateRange).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    vi.setSystemTime(new Date("2026-11-30T18:31:00Z"));
    act(() => root!.render(createElement(Probe, { defaults: DEFAULTS })));
    expect(f().dateRange).toEqual({ from: "2026-12-01", to: "2026-12-01" });
  });

  it("custom days stay as they are", () => {
    fakeClockAndTimers();
    vi.setSystemTime(MIDNIGHT_SOON);
    const f = mount("/list?range=custom&from=2026-11-02&to=2026-11-05");
    act(() => vi.advanceTimersByTime(2 * 60_000));
    expect(f().dateRange).toEqual({ from: "2026-11-02", to: "2026-11-05" });
  });
});
