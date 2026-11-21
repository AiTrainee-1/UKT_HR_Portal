import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { thisMonthKey, shiftMonth } from "@/components/md/kit/MonthPicker";
import { readFilters, type InsightsFilters } from "./filters";
import InsightsFilterBar from "./InsightsFilterBar";
import DetailSheet, { DetailList, DetailRow } from "./DetailSheet";
import { useInsightsFilters } from "./useInsightsFilters";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  window.history.replaceState(null, "", "/md/requests?kind=leave");
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.history.replaceState(null, "", "/");
});

const click = (selector: string) =>
  act(() => {
    host.querySelector<HTMLElement>(selector)?.click();
  });

let latest: InsightsFilters | null = null;
let latestParams: Record<string, string> = {};

function Harness() {
  const { filters, params, setWhen, setScope } = useInsightsFilters();
  latest = filters;
  latestParams = params;
  return <InsightsFilterBar filters={filters} onWhen={setWhen} onScope={setScope} />;
}

describe("InsightsFilterBar + useInsightsFilters", () => {
  it("starts on this month, steps a month back and keeps the choice in the address", () => {
    act(() => root.render(<Harness />));
    expect(latest?.when).toEqual({ mode: "month", month: thisMonthKey() });
    expect(latestParams).toEqual({ period: "this_month" });
    expect(host.querySelector('[data-testid="month-picker"]')).not.toBeNull();

    click('[data-testid="month-prev"]');
    const previous = shiftMonth(thisMonthKey(), -1);
    expect(latest?.when).toEqual({ mode: "month", month: previous });
    expect(latestParams).toEqual({ month: previous });
    // the HR page's own parameter is kept, the Insights one added
    expect(window.location.search).toBe(`?kind=leave&i.month=${previous}`);
    expect(readFilters(window.location.search).when).toEqual({ mode: "month", month: previous });
  });

  it("switches to a range of days and back", () => {
    act(() => root.render(<Harness />));
    click('[data-testid="md-insights-filters-range-mode"]');
    expect(latest?.when).toEqual({ mode: "period", period: { preset: "today" } });
    expect(host.querySelector('[data-testid="period-bar"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="month-picker"]')).toBeNull();
    click('[data-testid="md-insights-filters-month-mode"]');
    expect(latest?.when.mode).toBe("month");
  });

  it("opens on the filters a link carries", () => {
    window.history.replaceState(null, "", "/md/leave?i.period=last_7_days&i.unit=1");
    act(() => root.render(<Harness />));
    expect(latest?.when).toEqual({ mode: "period", period: { preset: "last_7_days" } });
    expect(latestParams).toEqual({ period: "last_7_days", branch: "1" });
  });

  it("can hide the scope and add a page's own filter", () => {
    function Bare() {
      const [f] = useState<InsightsFilters>(() => readFilters(""));
      return (
        <InsightsFilterBar filters={f} onWhen={() => {}} showScope={false}>
          <span data-testid="own-filter">Gate</span>
        </InsightsFilterBar>
      );
    }
    act(() => root.render(<Bare />));
    expect(host.querySelector('[data-testid="scope-bar"]')).toBeNull();
    expect(host.querySelector('[data-testid="own-filter"]')?.textContent).toBe("Gate");
  });
});

describe("DetailSheet", () => {
  it("lists rows, offers the page and calls back on a row", () => {
    const onOpen = vi.fn();
    const onRow = vi.fn();
    act(() =>
      root.render(
        <DetailSheet
          open
          onClose={() => {}}
          title="Stitching"
          subtitle="Late in Nov 2026"
          openLabel="Open in Requests"
          onOpen={onOpen}
        >
          <DetailList testId="rows">
            <DetailRow primary="Asha" secondary="E001" value="3" onClick={onRow} testId="row-1" />
            <DetailRow primary="Ravi" value="1" testId="row-2" />
          </DetailList>
        </DetailSheet>,
      ),
    );
    const sheet = document.querySelector('[data-testid="md-insights-detail"]');
    expect(sheet?.textContent).toContain("Stitching");
    expect(sheet?.textContent).toContain("Late in Nov 2026");
    act(() => document.querySelector<HTMLElement>('[data-testid="md-insights-detail-open"]')?.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => document.querySelector<HTMLElement>('[data-testid="row-1"] button')?.click());
    expect(onRow).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="row-2"] button')).toBeNull();
  });

  it("says when there is nothing, or the error", () => {
    act(() => root.render(<DetailSheet open onClose={() => {}} title="Nobody" empty="No one was late." />));
    expect(document.querySelector('[data-testid="md-insights-detail-empty"]')?.textContent).toContain(
      "No one was late.",
    );
    act(() => root.render(<DetailSheet open onClose={() => {}} title="Oops" error="The server said no." />));
    expect(document.querySelector('[data-testid="md-insights-detail"]')?.textContent).toContain("The server said no.");
  });
});
