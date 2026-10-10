import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import CasualLeave from "../CasualLeave";
import type { BoardRow, ClBoard, ClRequest } from "./logic";

// The Casual Leave page with a filled query cache (nothing is fetched): the owner's three questions (who has taken CL
// this month, who is eligible, who is not and why) and the request list HR decides.

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/ApprovalTrail", async (original) => ({
  ...(await original<typeof import("@/components/ApprovalTrail")>()),
  PipelineNote: () => null,
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-15T10:00:00") });
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

const person = (id: number, name: string, over: Partial<BoardRow> = {}): BoardRow => ({
  employeeId: id,
  employeeName: name,
  employeeCode: `E${id}`,
  department: "Cutting",
  departmentId: 1,
  branch: "Head Office",
  branchId: 1,
  employmentType: "staff",
  serviceMonths: 24,
  eligible: true,
  usedThisMonth: false,
  ...over,
});

const board: ClBoard = {
  month: 10,
  year: 2026,
  eligibilityMonths: 6,
  employees: [
    person(1, "Asha Kumar", { lastClDate: "2026-09-12" }),
    person(2, "Ravi Shankar"),
    person(3, "Meena Iyer", {
      eligible: false,
      reasonCode: "used_this_month",
      usedThisMonth: true,
      usedStatus: "approved",
      usedDate: "2026-10-03",
    }),
    person(4, "Suresh Raj", {
      eligible: false,
      reasonCode: "under_service",
      serviceMonths: 5,
      eligibleFrom: "2026-10-20",
      branch: "Unit 2",
      branchId: 2,
    }),
    person(5, "Bala", { eligible: false, reasonCode: "not_staff", employmentType: "production" }),
  ],
};

const requests: ClRequest[] = [
  {
    id: 11,
    employeeId: 3,
    employeeName: "Meena Iyer",
    employeeCode: "E3",
    date: "2026-10-03",
    status: "approved",
    reviewedBy: "Suresh",
    reviewerRole: "dept_head",
    branch: "Head Office",
    branchId: 1,
    employmentType: "staff",
  },
  {
    id: 12,
    employeeId: 9,
    employeeName: "Lakshmi",
    employeeCode: "E9",
    date: "2026-10-20",
    status: "pending",
    branch: "Head Office",
    branchId: 1,
    employmentType: "staff",
  },
  {
    id: 13,
    employeeId: 8,
    employeeName: "Chitra",
    employeeCode: "E8",
    date: "2026-10-08",
    status: "rejected",
    branch: "Head Office",
    branchId: 1,
    employmentType: "staff",
  },
];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["/api/casual-leaves/eligibility", 10, 2026, "board"], board);
  client.setQueryData(["/api/casual-leaves", null, 10, 2026], requests);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(CasualLeave))));
  return host;
}

const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ");
const q = (el: Element, id: string) => el.querySelector(`[data-testid="${id}"]`);
const tab = (el: Element, name: string) =>
  [...el.querySelectorAll('[role="tab"]')].find((t) => text(t).trim().startsWith(name));

describe("the Casual Leave page", () => {
  it("has one title, its subtitle, and the four figures the owner asked for", () => {
    const el = mount();
    expect(el.querySelectorAll("h2")).toHaveLength(1);
    expect(text(el.querySelector("h2"))).toBe("Casual Leave (CL)");
    expect(text(el.querySelector("h2")!.parentElement!.querySelector("p"))).toContain(
      "eligible after 6 months of service",
    );
    expect(text(q(el, "cl-stat-taken"))).toContain("1"); // Meena
    expect(text(q(el, "cl-stat-eligible"))).toContain("2");
    expect(text(q(el, "cl-stat-not-eligible"))).toContain("3");
    expect(text(q(el, "cl-stat-not-eligible"))).toContain("1 production");
    expect(text(q(el, "cl-stat-pending"))).toContain("1"); // Lakshmi
  });

  it("opens on who has taken casual leave this month, with who approved it", () => {
    const el = mount();
    expect(q(el, "tab-taken")).not.toBeNull();
    const row = q(el, "cl-11")!;
    expect(text(row)).toContain("Meena Iyer");
    expect(text(row)).toContain("Sat, 3 Oct 2026");
    expect(text(row)).toContain("Approved by Suresh (Dept Head)");
    expect(q(el, "cl-12")).not.toBeNull(); // the pending one is listed as requested
    expect(q(el, "cl-13")).toBeNull(); // a rejected request is not CL taken
  });

  it("Eligible lists who can still take CL, with an Apply CL for each", () => {
    const el = mount();
    click(tab(el, "Eligible")!);
    expect(
      el.querySelectorAll('[data-testid^="eligible-"][data-testid$="1"], [data-testid^="eligible-"][data-testid$="2"]')
        .length,
    ).toBeGreaterThan(0);
    expect(text(q(el, "eligible-1"))).toContain("Asha Kumar");
    expect(text(q(el, "eligible-1"))).toContain("12 Sep 2026"); // last CL
    expect(q(el, "apply-cl-1")).not.toBeNull();
    expect(q(el, "eligible-3")).toBeNull(); // used this month
    expect(q(el, "eligible-5")).toBeNull(); // production
  });

  it("Not eligible lists everyone else with the reason, and the pills split the reasons", () => {
    const el = mount();
    click(tab(el, "Not eligible")!);
    expect(text(q(el, "not-eligible-3"))).toContain("Already used this month");
    expect(text(q(el, "not-eligible-4"))).toContain("Becomes eligible on Tue, 20 Oct 2026");
    expect(text(q(el, "not-eligible-5"))).toContain("Production employee");
    expect(q(el, "not-eligible-1")).toBeNull();
    click(tab(el, "Production")!);
    expect(q(el, "not-eligible-5")).not.toBeNull();
    expect(q(el, "not-eligible-4")).toBeNull();
    expect(text(q(el, "not-eligible-count"))).toContain("Showing 1 of 3 employees");
  });

  it("a stat card jumps to its view, and Pending goes to the requests waiting", () => {
    const el = mount();
    click(q(el, "cl-stat-not-eligible"));
    expect(q(el, "tab-not-eligible")).not.toBeNull();
    click(q(el, "cl-stat-pending"));
    expect(q(el, "tab-requests")).not.toBeNull();
    expect(q(el, "cl-12")).not.toBeNull();
    expect(q(el, "cl-11")).toBeNull(); // only the pending one
    // and the request list has the decision buttons
    expect([...q(el, "cl-12")!.querySelectorAll("button")].map((b) => text(b).trim())).toEqual(["Approve", "Reject"]);
  });

  it("filters by branch across the board", () => {
    const el = mount();
    click(tab(el, "Not eligible")!);
    const search = q(el, "not-eligible-search") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "unit 2");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(q(el, "not-eligible-4")).not.toBeNull();
    expect(q(el, "not-eligible-3")).toBeNull();
  });

  it("has a month picker that starts on the current month and one Refresh beside the title", () => {
    const el = mount();
    expect(text(q(el, "month-picker-month"))).toContain("October");
    expect(text(q(el, "month-picker-year"))).toContain("2026");
    expect([...el.querySelectorAll("button")].filter((b) => /^\s*Refresh( this page)?\s*$/.test(text(b)))).toHaveLength(
      1,
    );
  });
});
