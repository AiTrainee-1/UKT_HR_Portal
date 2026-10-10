import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import BalancesTab from "./BalancesTab";
import CalendarTab from "./CalendarTab";
import HolidaysTab from "./HolidaysTab";
import type { HolidayRow, LeaveBalanceRow, LeaveRow } from "./logic";

// jsdom renders of the tabs that load their own data, from a query cache that is already filled (nothing is fetched).
// Today is pinned to 2026-10-05 so the month on screen is known.

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-05T10:00:00") });
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

function mount(node: ReturnType<typeof createElement>, seed: [readonly unknown[], unknown][]) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  for (const [key, data] of seed) client.setQueryData(key, data);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, node)));
  return host;
}

const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ");
const q = (el: Element, id: string) => el.querySelector(`[data-testid="${id}"]`);

const leave = (over: Partial<LeaveRow> & { id: number }): LeaveRow => ({
  employeeId: over.id * 10,
  employeeName: "Asha Kumar",
  employeeCode: `E${over.id}`,
  department: "Cutting",
  departmentId: 1,
  branch: "Head Office",
  branchId: 1,
  employmentType: "staff",
  type: "sick",
  startDate: "2026-10-05",
  endDate: "2026-10-07",
  status: "approved",
  ...over,
});

describe("the leave calendar", () => {
  const leaves = [
    leave({ id: 1, employeeName: "Asha Kumar" }),
    leave({ id: 2, employeeName: "Ravi Shankar", startDate: "2026-10-06", endDate: "2026-10-06", status: "pending" }),
    leave({ id: 3, employeeName: "Meena Iyer", startDate: "2026-10-06", endDate: "2026-10-06", status: "rejected" }),
  ];
  const seed: [readonly unknown[], unknown][] = [
    [["/api/casual-leaves", null, 10, 2026], []],
    [["/api/casual-leaves", null, 11, 2026], []],
    [
      ["/api/holidays", { year: 2026 }],
      [{ id: 1, name: "Founders Day", date: "2026-10-11", holidayType: "company", isRecurring: false }],
    ],
  ];
  const mountCalendar = () =>
    mount(
      createElement(CalendarTab, { leaves, loading: false, failed: false, onRetry: () => {}, today: "2026-10-05" }),
      seed,
    );

  it("starts on this month with today picked, and counts who is away each day", () => {
    const el = mountCalendar();
    expect(text(q(el, "cal-month-month"))).toContain("October");
    expect(q(el, "cal-day-2026-10-05")!.getAttribute("data-count")).toBe("1");
    expect(q(el, "cal-day-2026-10-06")!.getAttribute("data-count")).toBe("2"); // a rejected request is not leave
    expect(q(el, "cal-day-2026-10-08")!.getAttribute("data-count")).toBe("0");
    expect(text(q(el, "cal-stat-people"))).toContain("2"); // Asha and Ravi
    expect(text(q(el, "cal-stat-busiest"))).toContain("6 Oct");
    expect(text(q(el, "cal-day-panel"))).toContain("Asha Kumar"); // today is picked
  });

  it("a day opens its list of people with their status", () => {
    const el = mountCalendar();
    click(q(el, "cal-day-2026-10-06"));
    const people = el.querySelectorAll('[data-testid="cal-day-person"]');
    expect(people).toHaveLength(2);
    expect(text(q(el, "cal-day-panel"))).toContain("Ravi Shankar");
    expect(text(q(el, "cal-day-panel"))).toContain("pending");
    expect(text(q(el, "cal-day-panel"))).not.toContain("Meena");
  });

  it("marks a holiday on its day and in the panel", () => {
    const el = mountCalendar();
    expect(q(el, "cal-day-2026-10-11")!.getAttribute("aria-label")).toContain("holiday");
    click(q(el, "cal-day-2026-10-11"));
    expect(text(q(el, "cal-day-panel"))).toContain("Founders Day");
    expect(text(q(el, "cal-day-panel"))).toContain("Nobody is on leave");
  });

  it("the search narrows the calendar", () => {
    const el = mountCalendar();
    const search = q(el, "cal-search") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "ravi");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(q(el, "cal-day-2026-10-05")!.getAttribute("data-count")).toBe("0");
    expect(q(el, "cal-day-2026-10-06")!.getAttribute("data-count")).toBe("1");
    expect(text(q(el, "cal-count"))).toContain("1 person away in October");
  });

  it("moves to another month and says nobody is away there", () => {
    const el = mountCalendar();
    click(el.querySelector('button[aria-label="Next month"]'));
    expect(text(q(el, "cal-month-month"))).toContain("November");
    expect(q(el, "cal-empty")).not.toBeNull();
  });
});

describe("the holidays tab", () => {
  const holidays: HolidayRow[] = [
    { id: 1, name: "Pongal", date: "2026-01-14", holidayType: "national", isRecurring: true },
    {
      id: 2,
      name: "Deepavali",
      date: "2026-10-20",
      holidayType: "regional",
      isRecurring: false,
      branchId: 2,
      branchName: "Unit 2",
    },
    { id: 3, name: "Founders Day", date: "2026-10-11", holidayType: "company", isRecurring: false },
  ];
  const mountHolidays = (data: HolidayRow[] = holidays) =>
    mount(createElement(HolidaysTab, { today: "2026-10-05" }), [[["/api/holidays", { year: 2026 }], data]]);

  it("groups by month with a card for each holiday, and says what is next", () => {
    const el = mountHolidays();
    expect(text(q(el, "hol-year-label"))).toBe("2026");
    expect(el.querySelectorAll('[data-testid^="holiday-"]')).toHaveLength(3);
    expect(text(q(el, "hol-stat-next"))).toContain("In 6 days");
    expect(text(q(el, "hol-stat-next"))).toContain("Founders Day");
    expect(text(q(el, "hol-stat-sunday"))).toContain("1"); // 11 Oct 2026 is a Sunday
    expect(text(q(el, "hol-list"))).toContain("October (2)");
  });

  it("filters by type and by search, with a count and a way back", () => {
    const el = mountHolidays();
    const search = q(el, "hol-search") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "deepa");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(el.querySelectorAll('[data-testid^="holiday-"]')).toHaveLength(1);
    expect(text(q(el, "hol-count"))).toContain("Showing 1 of 3 holidays");
    click(q(el, "hol-count-clear"));
    expect(el.querySelectorAll('[data-testid^="holiday-"]')).toHaveLength(3);
  });

  it("has an honest empty state for a year with none", () => {
    const el = mountHolidays([]);
    expect(q(el, "hol-empty")).not.toBeNull();
    expect(text(q(el, "hol-empty"))).toContain("No holidays for 2026");
  });

  it("the year view draws twelve months with the holidays marked", () => {
    const el = mountHolidays();
    const tab = [...el.querySelectorAll('[role="tab"]')].find((t) => text(t).includes("Year view"));
    click(tab!);
    const view = q(el, "hol-year-view")!;
    expect(view.querySelectorAll("[data-holiday]")).toHaveLength(3);
    expect(text(view)).toContain("Pongal");
  });

  it("a holiday has Edit and Delete buttons named after it (the View Only lock catches both words)", () => {
    const el = mountHolidays();
    expect(el.querySelector('button[aria-label="Edit Pongal"]')).not.toBeNull();
    expect(el.querySelector('button[aria-label="Delete Pongal"]')).not.toBeNull();
  });
});

describe("the balances tab", () => {
  const employee = (id: number, first: string, over: Record<string, unknown> = {}) => ({
    id,
    employeeCode: `E${id}`,
    firstName: first,
    lastName: "Test",
    status: "active",
    employmentType: "staff",
    departmentId: 1,
    departmentName: "Cutting",
    branchId: 1,
    branchName: "Head Office",
    ...over,
  });
  const balance = (id: number, over: Partial<LeaveBalanceRow>): LeaveBalanceRow => ({
    id,
    employeeId: id,
    leaveTypeId: 1,
    leaveTypeName: "Casual",
    year: 2026,
    allocated: 12,
    used: 0,
    remaining: 12,
    carriedForward: 0,
    ...over,
  });
  const types = [
    {
      id: 1,
      name: "Casual",
      code: "CL",
      maxDaysPerYear: 12,
      carryForward: false,
      maxCarryForwardDays: 0,
      isPaid: true,
      applicableGender: "all",
      isActive: true,
    },
  ];
  const mountBalances = (balances: LeaveBalanceRow[], leaveTypes = types) =>
    mount(createElement(BalancesTab), [
      [["/api/leave-balances", 2026], balances],
      [["/api/leave-types"], leaveTypes],
      [
        ["/api/employees", "lite"],
        [employee(1, "Asha"), employee(2, "Ravi"), employee(3, "Meena"), employee(4, "Gone", { status: "inactive" })],
      ],
    ]);

  it("flags low and exhausted balances and counts them", () => {
    const el = mountBalances([
      balance(1, { used: 4, remaining: 8 }),
      balance(2, { used: 10, remaining: 2 }),
      balance(3, { used: 12, remaining: 0 }),
      balance(4, {}), // an inactive employee: not listed
    ]);
    expect(el.querySelectorAll('[data-testid^="balance-"][data-flag]')).toHaveLength(3);
    expect(q(el, "balance-2")!.getAttribute("data-flag")).toBe("low");
    expect(q(el, "balance-3")!.getAttribute("data-flag")).toBe("exhausted");
    expect(text(q(el, "bal-stat-low"))).toContain("1");
    expect(text(q(el, "bal-stat-exhausted"))).toContain("1");
    expect(text(q(el, "balance-2"))).toContain("Low balance");
    expect(text(q(el, "balance-3"))).toContain("Exhausted");
    expect(text(q(el, "leave-types"))).toContain("12 days a year");
  });

  it("the low-balance card filters the table, and pressing it again clears it", () => {
    const el = mountBalances([
      balance(1, { used: 4, remaining: 8 }),
      balance(2, { used: 10, remaining: 2 }),
      balance(3, { used: 12, remaining: 0 }),
    ]);
    click(q(el, "bal-stat-low"));
    expect(el.querySelectorAll('[data-testid^="balance-"][data-flag]')).toHaveLength(2); // low or exhausted
    click(q(el, "bal-stat-low"));
    expect(el.querySelectorAll('[data-testid^="balance-"][data-flag]')).toHaveLength(3);
  });

  it("explains an empty year, and asks for a leave type first when there is none", () => {
    const el = mountBalances([], []);
    expect(q(el, "bal-empty")).not.toBeNull();
    expect(text(q(el, "bal-empty"))).toContain("Add a leave type first");
    expect(q(el, "no-leave-types")).not.toBeNull();
  });
});
