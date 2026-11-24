import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DateRangeValue } from "@/lib/date-range";
import { DateRangeBar } from "./DateRangeBar";
import { OutsideRangeNote } from "./OutsideRangeNote";
import { useDateRange } from "./useDateRange";

// The HR portal's one date filter in jsdom: the four presets, the month stepper and picker, the Custom days, the words, no
// future, and the address hook (This Month by default, every choice in the address, Back finds it again).

// Tuesday 24 Nov 2026, 11:30 in India.
const NOW = "2026-11-24T06:00:00Z";
const MONTH: DateRangeValue = { range: "month", month: "", from: "", to: "" };

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

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
});

function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

const $ = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string) => {
  const el = $(id);
  if (!el) throw new Error(`no ${id}`);
  return el;
};
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const pressed = (id: string) => must(id).getAttribute("aria-pressed") === "true";
function typeDay(el: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The bar with its value held here, as a page holds it. */
function Controlled({
  initial = MONTH,
  onChange,
}: {
  initial?: DateRangeValue;
  onChange?: (v: DateRangeValue) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <DateRangeBar
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

describe("the bar", () => {
  it("opens on This Month and says so", () => {
    mount(<Controlled />);
    expect(pressed("date-range-month")).toBe(true);
    expect(pressed("date-range-today")).toBe(false);
    expect(text($("date-range-month-name"))).toBe("November 2026");
    expect(text($("date-range-label"))).toBe("Showing November 2026");
    expect(must("date-range").dataset.from).toBe("2026-11-01");
    expect(must("date-range").dataset.to).toBe("2026-11-30");
    // no Custom days until Custom is chosen
    expect($("date-range-custom")).not.toBeNull();
    expect($("date-range-from")).toBeNull();
  });

  it("Today and Yesterday are one day each, in words", () => {
    const seen: DateRangeValue[] = [];
    mount(<Controlled onChange={(v) => seen.push(v)} />);
    click(must("date-range-today"));
    expect(text($("date-range-label"))).toBe("Showing Today, 24 Nov");
    expect(must("date-range").dataset.from).toBe("2026-11-24");
    click(must("date-range-yesterday"));
    expect(text($("date-range-label"))).toBe("Showing Yesterday, 23 Nov");
    expect(seen.map((v) => v.range)).toEqual(["today", "yesterday"]);
  });

  it("steps back a month at a time and never past the current month", () => {
    mount(<Controlled />);
    expect((must("date-range-next") as HTMLButtonElement).disabled).toBe(true);
    click(must("date-range-prev"));
    expect(text($("date-range-label"))).toBe("Showing October 2026");
    expect(pressed("date-range-month")).toBe(false); // This Month means the current one
    expect((must("date-range-next") as HTMLButtonElement).disabled).toBe(false);
    click(must("date-range-prev"));
    expect(must("date-range").dataset.from).toBe("2026-09-01");
    expect(must("date-range").dataset.to).toBe("2026-09-30");
    click(must("date-range-next"));
    click(must("date-range-next"));
    expect(pressed("date-range-month")).toBe(true);
  });

  it("picks a month from the month list; later months cannot be picked", async () => {
    mount(<Controlled />);
    click(must("date-range-month-name"));
    await act(async () => {});
    expect($("date-range-months")).not.toBeNull();
    expect((must("date-range-pick-2026-12") as HTMLButtonElement).disabled).toBe(true);
    expect((must("date-range-year-next") as HTMLButtonElement).disabled).toBe(true);
    click(must("date-range-year-prev"));
    expect(text($("date-range-year"))).toBe("2025");
    click(must("date-range-pick-2025-03"));
    await act(async () => {});
    expect(text($("date-range-label"))).toBe("Showing March 2025");
    expect($("date-range-months")).toBeNull();
  });

  it("Custom starts on the days on screen; a To day makes a range, an empty To one day; nothing after today", () => {
    mount(<Controlled initial={{ ...MONTH, range: "yesterday" }} />);
    click(must("date-range-custom"));
    const from = must("date-range-from") as HTMLInputElement;
    const to = must("date-range-to") as HTMLInputElement;
    expect(from.value).toBe("2026-11-23");
    expect(to.value).toBe(""); // one day
    expect(from.max).toBe("2026-11-24");
    expect(to.max).toBe("2026-11-24");
    typeDay(from, "2026-11-03");
    typeDay(must("date-range-to"), "2026-11-09");
    expect(text($("date-range-label"))).toBe("Showing 3 Nov – 9 Nov 2026");
    typeDay(must("date-range-to"), "");
    expect(text($("date-range-label"))).toBe("Showing 3 Nov 2026");
  });

  it("wears the page's accent on the chosen preset", () => {
    mount(<DateRangeBar value={MONTH} onChange={() => {}} accent="#006496" testId="geo" />);
    expect(must("geo-month").style.backgroundColor).toBe("rgb(0, 100, 150)");
    expect(must("geo-today").style.backgroundColor).toBe("");
  });
});

describe("the address hook", () => {
  function Page() {
    const dates = useDateRange();
    return (
      <div>
        <DateRangeBar value={dates.value} onChange={(next) => dates.set(next, { page: "" })} />
        <p data-testid="days">
          {dates.days.from}..{dates.days.to}
        </p>
      </div>
    );
  }

  it("is This Month with a clean address; every choice goes into the address, other keys stay", () => {
    window.history.replaceState(null, "", "/hr/requests?kind=leave&page=3");
    mount(<Page />);
    expect(text($("days"))).toBe("2026-11-01..2026-11-30");
    click(must("date-range-today"));
    // the page number goes in the same address change (extra keys), the tab key stays
    expect(window.location.search).toBe("?kind=leave&range=today");
    click(must("date-range-prev"));
    expect(window.location.search).toBe("?kind=leave&month=2026-10");
    expect(text($("days"))).toBe("2026-10-01..2026-10-31");
    click(must("date-range-next"));
    expect(window.location.search).toBe("?kind=leave");
  });

  it("reads a shared link, and Back to an entry finds its days again", () => {
    window.history.replaceState(null, "", "/hr/requests?range=custom&from=2026-11-03&to=2026-11-09");
    mount(<Page />);
    expect(text($("days"))).toBe("2026-11-03..2026-11-09");
    expect(pressed("date-range-custom")).toBe(true);
    // a new entry (another page), then Back: the old entry's address, and its days
    act(() => window.history.pushState(null, "", "/hr/requests?range=yesterday"));
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(text($("days"))).toBe("2026-11-23..2026-11-23");
    act(() => window.history.back());
    act(() => window.history.replaceState(null, "", "/hr/requests?range=custom&from=2026-11-03&to=2026-11-09"));
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(text($("days"))).toBe("2026-11-03..2026-11-09");
  });

  it("mends a future month in the address to the current month", () => {
    window.history.replaceState(null, "", "/x?month=2027-05");
    mount(<Page />);
    expect(text($("days"))).toBe("2026-11-01..2026-11-30");
  });
});

describe("the note about the other days", () => {
  it("says how many wait on other dates, and offers to show them from the earliest", () => {
    const show = vi.fn();
    mount(
      <OutsideRangeNote
        count={2}
        what="pending requests"
        rangeLabel="November 2026"
        earliest="2026-10-28"
        onShow={show}
      />,
    );
    expect(text($("outside-range"))).toContain(
      "2 more pending requests outside November 2026 (the earliest is for 28 Oct 2026).",
    );
    expect(text($("outside-range-show"))).toBe("Show them");
    click(must("outside-range-show"));
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("says nothing when nothing waits elsewhere, and has no button without a day it can show", () => {
    mount(
      <div>
        <OutsideRangeNote count={0} what="requests" rangeLabel="November 2026" />
        <OutsideRangeNote count={1} what="request" rangeLabel="November 2026" testId="later" onShow={() => {}} />
      </div>,
    );
    expect($("outside-range")).toBeNull();
    expect(text($("later"))).toBe("1 more request outside November 2026.");
    expect($("later-show")).toBeNull();
  });
});
