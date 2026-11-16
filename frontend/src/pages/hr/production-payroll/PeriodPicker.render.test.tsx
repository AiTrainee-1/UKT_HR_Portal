import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CyclePeriod,
  CyclePeriodRow,
  ProductionPeriodWorkflow,
  ProductionPeriods,
} from "@/lib/api-client/custom-hooks";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { apiError, click, installBrowserStubs, must, press, q, settle, text, typeInto, waitFor } from "./harness";
import { addDays, daysBetween } from "./period-calendar";
import { PeriodPicker } from "./PeriodPicker";
import { FROM_DELAY } from "./PeriodSummary";

// The pay-period calendar of a cycle page on its own (owner 2026-11-16), with a fake server behind customFetch: every
// period in the colour of where it stands, a click (or Enter, or a date typed into From) picks the whole period that holds
// the day, the quick picks, paging months asks the server for the periods it has not seen, the keyboard, reduced motion,
// and the calendar folded away.

const h = vi.hoisted(() => ({ fetch: vi.fn(), reduce: false, failAround: false }));

vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
// "today" is the calendar's own: only todayIso is replaced (faking Date would stop the waits in harness.waitFor)
vi.mock("./period-workflow", async (original) => ({
  ...(await original<typeof import("./period-workflow")>()),
  todayIso: () => "2026-11-24",
}));
vi.mock("framer-motion", async (original) => ({
  ...(await original<typeof import("framer-motion")>()),
  useReducedMotion: () => h.reduce,
}));

// BiWeekly with Monday weeks, as the live server lists them; "today" is Tuesday 24 Nov 2026
const TODAY = "2026-11-24";
const ANCHOR = "2026-10-26";

const row = (periodStart: string, periodEnd: string, over: Partial<CyclePeriodRow> = {}): CyclePeriodRow => ({
  periodStart,
  periodEnd,
  periodEnded: periodEnd < TODAY,
  isNext: false,
  generated: 0,
  paid: 0,
  state: "not_generated",
  parked: 0,
  ...over,
});

const SEP28 = { periodStart: "2026-09-28", periodEnd: "2026-10-11" };
const OCT12 = { periodStart: "2026-10-12", periodEnd: "2026-10-25" };
const OCT26 = { periodStart: "2026-10-26", periodEnd: "2026-11-08" };
const NOV9 = { periodStart: "2026-11-09", periodEnd: "2026-11-22" };
const NOV23 = { periodStart: "2026-11-23", periodEnd: "2026-12-06" };

/** The page's own list (newest first): the next due period, the ones before it, up to today's (not included here). */
const BASE: ProductionPeriods = {
  cycle: "biweekly",
  label: "BiWeekly",
  days: 14,
  roster: 112,
  periods: [
    row(NOV9.periodStart, NOV9.periodEnd),
    row(OCT26.periodStart, OCT26.periodEnd, { generated: 113, state: "generated", isNext: true }),
    row(OCT12.periodStart, OCT12.periodEnd, { generated: 114, state: "finalized" }),
    row(SEP28.periodStart, SEP28.periodEnd, { generated: 11, paid: 11, state: "paid" }),
  ],
};

function holding(date: string): [string, string] {
  const start = addDays(ANCHOR, Math.floor(daysBetween(ANCHOR, date) / 14) * 14);
  return [start, addDays(start, 13)];
}

const asked = () => h.fetch.mock.calls.map((c) => String(c[0]));
const aroundAsked = () => asked().filter((u) => u.includes("around="));

const WORKFLOW = {
  ...OCT12,
  cycle: "biweekly",
  label: "BiWeekly",
  periodLabel: "12 Oct - 25 Oct 2026",
  state: "finalized",
  stateLabel: "Payroll Done",
  locked: true,
  periodEnded: true,
  finalizedAt: "2026-10-27T10:00:00+05:30",
  finalizedBy: "HR",
  paidAt: null,
  paidBy: null,
  paidOn: null,
  daysToPay: null,
} as unknown as ProductionPeriodWorkflow;

const onChange = vi.fn();
const onPickDate = vi.fn();

function Host({ initial, workflow }: { initial: CyclePeriod | null; workflow?: ProductionPeriodWorkflow }) {
  const [period, setPeriod] = useState<CyclePeriod | null>(initial);
  return (
    <PeriodPicker
      cycle="biweekly"
      periods={BASE}
      period={period}
      onChange={(p) => {
        onChange(p);
        setPeriod(p);
      }}
      onPickDate={onPickDate}
      loading={false}
      workflow={workflow}
    />
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Renders the bar; the calendar starts hidden on every visit (owner 2026-11-16), so it is opened unless `open` is false. */
function mount(initial: CyclePeriod | null = OCT26, workflow?: ProductionPeriodWorkflow, { open = true } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <Host initial={initial} workflow={workflow} />
      </QueryClientProvider>,
    ),
  );
  if (open) click(must("pcp-cal-toggle"));
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
}

const day = (date: string) => must(`pcp-cal-day-${date}`);
const kind = (date: string) => q(`pcp-cal-day-${date}`)?.dataset.kind;
const selectedDays = () =>
  [...document.body.querySelectorAll<HTMLElement>('[data-testid^="pcp-cal-day-"][data-selected="true"]')].map(
    (el) => el.dataset.date,
  );
const fromInput = () => must("pcp-period-date") as HTMLInputElement;
/** The months on screen have every period: the one after today's (October + November), or September's. */
const loaded = (sept = false) =>
  sept
    ? waitFor(() => kind("2026-09-02") === "due", "September's periods")
    : waitFor(() => kind("2026-11-30") === "upcoming", "the period after today's");

beforeAll(installBrowserStubs);

beforeEach(() => {
  h.reduce = false;
  h.failAround = false;
  onChange.mockReset();
  onPickDate.mockReset();
  window.localStorage.clear();
  h.fetch.mockReset();
  h.fetch.mockImplementation(async (url: string) => {
    const [path, query = ""] = url.split("?");
    if (path !== "/api/payroll/production/periods") throw new Error(`unexpected request ${url}`);
    const around = new URLSearchParams(query).get("around");
    if (around && h.failAround) throw apiError(500);
    const list: ProductionPeriods = JSON.parse(JSON.stringify(BASE));
    if (around) {
      const [s, e] = holding(around);
      if (!list.periods.some((p) => p.periodStart === s)) list.periods.push(row(s, e));
    }
    return list;
  });
});

afterEach(() => {
  unmount();
  window.localStorage.clear();
});

describe("the pay-period calendar", () => {
  it("shows two months, every pay period in the colour of where it stands, today, and a legend that counts them", async () => {
    mount();
    await loaded();
    expect(text(q("pcp-cal-month-0"))).toBe("October 2026");
    expect(text(q("pcp-cal-month-1"))).toBe("November 2026");
    expect(kind("2026-10-01")).toBe("paid");
    expect(kind("2026-10-14")).toBe("done");
    expect(kind("2026-11-02")).toBe("generated");
    expect(kind("2026-11-10")).toBe("due");
    expect(kind("2026-11-24")).toBe("upcoming");
    // weeks start on the cycle's own weekday (Monday here): a period fills whole rows
    expect(text(must("pcp-calendar").querySelector('[role="row"]'))).toBe("MonTueWedThuFriSatSun");
    // today
    expect(day(TODAY).dataset.today).toBe("true");
    expect(day(TODAY).getAttribute("aria-current")).toBe("date");
    // each colour also has words and an icon: the legend, and the spoken label of every day
    for (const [k, n] of [
      ["paid", "1"],
      ["done", "1"],
      ["generated", "1"],
      ["due", "1"],
      ["upcoming", "1"],
    ]) {
      expect(text(q(`pcp-cal-legend-${k}`))).toMatch(new RegExp(`${n}$`));
    }
    expect(text(q("pcp-cal-legend-paid"))).toContain("Paid");
    expect(text(q("pcp-cal-legend-due"))).toContain("Ended · not generated");
    expect(day("2026-11-02").getAttribute("aria-label")).toBe(
      "Mon 2 Nov 2026, pay period 26 Oct 2026 to 8 Nov 2026, Generated, 113 payslips, next due, selected",
    );
    // only the period the page did not have was asked for, by its first day
    expect(aroundAsked()).toEqual(["/api/payroll/production/periods?cycle=biweekly&around=2026-11-23"]);
  });

  it("shows the selected period beside it: From / To, its status, payslips, and Next due", async () => {
    mount();
    await loaded();
    expect(selectedDays()).toEqual(
      Array.from({ length: 14 }, (_, i) => addDays(OCT26.periodStart, i)).filter((d) => d <= "2026-11-08"),
    );
    expect(text(q("pcp-period"))).toBe("26 Oct - 8 Nov 2026 Next due");
    expect(fromInput().value).toBe("2026-10-26");
    expect(text(q("pcp-period-to"))).toBe("08-11-2026");
    expect(must("pcp-period-state").dataset.state).toBe("generated");
    expect(text(q("pcp-period-state"))).toBe("Generated");
    expect(text(q("pcp-period-count"))).toBe("113 payslips · 112 on the cycle now");
    expect(text(q("pcp-period-timing"))).toBe("Ended 8 Nov 2026");
  });

  it("picks the whole pay period that holds a clicked day, with the period's own dates in From / To", async () => {
    mount(OCT26, WORKFLOW);
    await loaded();
    click(day("2026-10-15"));
    expect(onChange).toHaveBeenLastCalledWith(OCT12);
    expect(selectedDays()).toEqual(Array.from({ length: 14 }, (_, i) => addDays(OCT12.periodStart, i)));
    expect(fromInput().value).toBe("2026-10-12");
    expect(text(q("pcp-period-to"))).toBe("25-10-2026");
    expect(text(q("pcp-period"))).toBe("12 Oct - 25 Oct 2026");
    expect(must("pcp-period-state").dataset.state).toBe("finalized");
    expect(text(q("pcp-period-state"))).toBe("Payroll Done");
    // more payslips than people on the cycle now: said in words, not as "114 of 112"
    expect(text(q("pcp-period-count"))).toBe("114 payslips · 112 on the cycle now");
    expect(text(q("pcp-period-count-note"))).toContain("since moved to another cycle or left");
    expect(text(q("pcp-period-done"))).toContain("Payroll Done");
    expect(text(q("pcp-period-done"))).toContain("payment pending");
    // the block of the selected period is marked as such
    expect(must("pcp-cal-period-2026-10-2026-10-12").dataset.selected).toBe("true");
  });

  it("hands a day whose period is not known to the page, which asks the server for it", async () => {
    h.failAround = true;
    mount();
    await waitFor(() => aroundAsked().length === 1, "the request for the period after today's");
    await settle(20);
    expect(kind("2026-11-30")).toBe("unknown");
    expect(text(q("pcp-cal-preview"))).toContain("could not be loaded");
    click(day("2026-11-30"));
    expect(onPickDate).toHaveBeenCalledWith("2026-11-30");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("From / To", () => {
  it("a date typed into From opens the period that holds it; From then shows the period's first day and To follows", async () => {
    mount(SEP28);
    await loaded(true);
    typeInto(fromInput(), "2026-11-04");
    expect(onChange).not.toHaveBeenCalled(); // it waits for the typing to pause
    await waitFor(() => onChange.mock.calls.length === 1, "the period", FROM_DELAY.ms + 2000);
    expect(onChange).toHaveBeenLastCalledWith(OCT26);
    await waitFor(() => fromInput().value === "2026-10-26", "From to show the period's first day");
    expect(text(q("pcp-period-to"))).toBe("08-11-2026");
  });

  it("asks the page for a typed date whose period is not known yet", async () => {
    mount();
    await loaded();
    typeInto(fromInput(), "2027-01-20");
    await waitFor(() => onPickDate.mock.calls.length === 1, "the page to be asked", FROM_DELAY.ms + 2000);
    expect(onPickDate).toHaveBeenCalledWith("2027-01-20");
  });

  it("refuses a date outside the calendar, and says which dates it takes", async () => {
    mount();
    await loaded();
    typeInto(fromInput(), "2019-05-01");
    expect(text(q("pcp-period-date-problem"))).toBe("Pick a date from 1 Nov 2023 to 28 Feb 2027.");
    await settle(FROM_DELAY.ms + 150);
    expect(onChange).not.toHaveBeenCalled();
    expect(onPickDate).not.toHaveBeenCalled();
  });

  it("To cannot be set apart from the period: it is the period's last day", async () => {
    mount();
    await loaded();
    const to = must("pcp-period-to");
    expect(to.tagName).not.toBe("INPUT");
    expect(to.getAttribute("aria-label")).toBe("To: 8 Nov 2026 (the period's last day, set by the cycle)");
  });
});

describe("the quick picks", () => {
  it("Next due, Latest generated and This period (today)", async () => {
    mount();
    await loaded();
    click(day("2026-10-01"));
    expect(onChange).toHaveBeenLastCalledWith(SEP28);
    expect(must("pcp-quick-next").getAttribute("aria-pressed")).toBe("false");
    click(must("pcp-quick-next"));
    expect(onChange).toHaveBeenLastCalledWith(OCT26);
    expect(must("pcp-quick-next").getAttribute("aria-pressed")).toBe("true");
    click(day("2026-10-01"));
    click(must("pcp-quick-latest"));
    expect(onChange).toHaveBeenLastCalledWith(OCT26);
    click(must("pcp-quick-today"));
    expect(onChange).toHaveBeenLastCalledWith(NOV23);
    expect(text(q("pcp-period-timing"))).toBe("In progress · ends 6 Dec 2026 · can be generated from 7 Dec 2026");
  });

  it("This period (today) asks the page for today when no list holds today's period", async () => {
    h.failAround = true;
    mount();
    await waitFor(() => aroundAsked().length === 1, "the request");
    await settle(20);
    click(must("pcp-quick-today"));
    expect(onPickDate).toHaveBeenCalledWith(TODAY);
  });
});

describe("paging months", () => {
  it("asks the server, by a date in each, for the periods of the months it has not seen", async () => {
    mount();
    await loaded();
    click(must("pcp-cal-prev"));
    expect(text(q("pcp-cal-month-0"))).toBe("September 2026");
    await waitFor(() => kind("2026-09-02") === "due", "September's periods");
    expect(aroundAsked()).toEqual([
      "/api/payroll/production/periods?cycle=biweekly&around=2026-11-23",
      "/api/payroll/production/periods?cycle=biweekly&around=2026-08-31",
      "/api/payroll/production/periods?cycle=biweekly&around=2026-09-14",
    ]);
    // back again: nothing is asked twice
    click(must("pcp-cal-next"));
    await settle(20);
    expect(aroundAsked()).toHaveLength(3);
  });

  it("goes no further than two months ahead of today", async () => {
    mount();
    await loaded();
    click(must("pcp-cal-next"));
    click(must("pcp-cal-next"));
    expect(text(q("pcp-cal-month-1"))).toBe("January 2027");
    expect((must("pcp-cal-next") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pcp-cal-prev") as HTMLButtonElement).disabled).toBe(false);
  });

  it("moves to the selected period's months when the period changes from outside the months on screen", async () => {
    mount();
    await loaded();
    click(must("pcp-cal-next"));
    click(must("pcp-cal-next"));
    click(must("pcp-quick-next"));
    expect(text(q("pcp-cal-month-0"))).toBe("October 2026");
  });
});

describe("the keyboard", () => {
  it("moves between days with the arrows (across months), and Enter picks", async () => {
    mount();
    await loaded();
    const tabbable = must("pcp-calendar").querySelectorAll('button[data-date][tabindex="0"]');
    expect([...tabbable].map((b) => b.getAttribute("data-date"))).toEqual(["2026-10-26"]);
    act(() => day("2026-10-15").focus());
    press(day("2026-10-15"), "ArrowRight");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("pcp-cal-day-2026-10-16");
    press(document.activeElement!, "ArrowDown");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("pcp-cal-day-2026-10-23");
    for (let i = 0; i < 4; i += 1) press(document.activeElement!, "ArrowUp");
    // 25 Sep is in September: the months move with the focus
    expect(text(q("pcp-cal-month-0"))).toBe("September 2026");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("pcp-cal-day-2026-09-25");
    await waitFor(() => kind("2026-09-25") === "due", "September's periods");
    press(document.activeElement!, "Enter");
    expect(onChange).toHaveBeenLastCalledWith({ periodStart: "2026-09-14", periodEnd: "2026-09-27" });
    press(document.activeElement!, "PageDown");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("pcp-cal-day-2026-10-25");
    press(document.activeElement!, "Home");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("pcp-cal-day-2026-10-19");
    press(document.activeElement!, " ");
    expect(onChange).toHaveBeenLastCalledWith(OCT12);
  });

  it("previews the period under the pointer or focus before it is picked", async () => {
    mount();
    await loaded();
    act(() => day("2026-11-12").focus());
    expect(text(q("pcp-cal-preview"))).toBe("9 Nov - 22 Nov 2026 · Not generated · click to open");
    expect(must("pcp-cal-period-2026-11-2026-11-09").className).toContain("ring-2");
  });
});

describe("the sweep", () => {
  it("fills a newly picked period's days one after another", async () => {
    mount();
    await loaded();
    click(day("2026-10-15"));
    const sweep = (d: string) => day(d).querySelector<HTMLElement>("[data-sweep]")?.dataset.sweep;
    expect(sweep("2026-10-12")).toBe("0");
    expect(sweep("2026-10-13")).toBe("0.035");
    expect(sweep("2026-10-25")).toBe("0.455");
  });

  it("fills them all at once for someone who asked for reduced motion", async () => {
    h.reduce = true;
    mount();
    await loaded();
    click(day("2026-10-15"));
    const sweeps = [...document.body.querySelectorAll<HTMLElement>("[data-sweep]")].map((s) => s.dataset.sweep);
    expect(sweeps.length).toBeGreaterThanOrEqual(14);
    expect(new Set(sweeps)).toEqual(new Set(["none"]));
  });
});

describe("folding the calendar away", () => {
  it("starts hidden on every visit, keeps the period's bar, asks the server for nothing meanwhile, and remembers nothing", async () => {
    mount(OCT26, undefined, { open: false });
    await settle(20);
    const toggle = must("pcp-cal-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(text(toggle)).toBe("Show calendar");
    expect(q("pcp-calendar")).toBeNull();
    expect(text(q("pcp-period"))).toBe("26 Oct - 8 Nov 2026 Next due");
    expect(q("pcp-period-date")).not.toBeNull();
    expect(aroundAsked()).toEqual([]);
    click(toggle);
    await loaded();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(text(toggle)).toBe("Hide calendar");
    // a new visit: hidden again, and nothing was kept in the browser
    unmount();
    h.fetch.mockClear();
    mount(OCT26, undefined, { open: false });
    await settle(20);
    expect(q("pcp-calendar")).toBeNull();
    expect(window.localStorage.getItem("uktex.pcp.period-calendar")).toBeNull();
  });
});

describe("a View Only role", () => {
  it("can still use every control of the calendar: it only chooses what to look at", async () => {
    mount();
    await loaded();
    lockMutatingControls(document.body);
    const locked = [...must("pcp-period-bar").querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.disabled);
    expect(locked).toEqual([]);
    expect(fromInput().disabled).toBe(false);
  });
});
