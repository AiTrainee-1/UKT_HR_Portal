import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApprovalProgress } from "@/lib/approval-workflow";
import { setViewOnlyWorkflows } from "@/lib/approval-workflow";
import { lockIconOnlyDeletes, lockMutatingControls } from "@/lib/view-only-lock";
import ClTab from "../casual-leave/ClTab";
import { EligibleList, NotEligibleList, RequestList } from "../casual-leave/lists";
import { NO_CL_FILTERS, type BoardRow, type ClRequest } from "../casual-leave/logic";
import LeaveRequestsTab from "./LeaveRequestsTab";
import type { LeaveRow } from "./logic";

// jsdom render checks of the pieces the Leave and Casual Leave pages are built from: what a row shows, what the search
// leaves, which buttons exist and what they call, and that the MD's View Only copy has nothing to press on a leave card.
// (The pages themselves, with real data, are covered by e2e/leave-casual.spec.ts.)

// the pipeline note reads the approval summary and the signed-in user: not what these checks are about
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

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setViewOnlyWorkflows(null);
});

function mount(node: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const progress = (over: Partial<ApprovalProgress> = {}): ApprovalProgress => ({
  workflow: "leave",
  label: "Leave",
  enabled: true,
  steps: [{ index: 0, roles: ["hod", "hr"], mandatory: true, state: "pending", label: "HOD or HR" } as never],
  currentStep: 0,
  waitingFor: ["hod", "hr"],
  canAct: { hod: true, hr: true },
  canReject: { hod: true, hr: true },
  ...over,
});

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
  endDate: "2026-10-05",
  status: "pending",
  createdAt: `2026-10-0${over.id}T09:00:00Z`,
  approval: progress(),
  ...over,
});

const noop = () => {};
const tabProps = (over: Partial<React.ComponentProps<typeof LeaveRequestsTab>> = {}) => ({
  mode: "leave" as const,
  rows: [
    leave({
      id: 1,
      employeeName: "Asha Kumar",
      status: "approved",
      approval: progress({ currentStep: null, canAct: { hod: false, hr: false } }),
    }),
    leave({ id: 2, employeeName: "Ravi Shankar", type: "casual", department: "Stitching", departmentId: 2 }),
  ],
  loading: false,
  failed: false,
  onRetry: noop,
  today: "2026-10-05",
  busy: false,
  onOpen: noop,
  onDecide: noop,
  onDelete: noop,
  ...over,
});

const type = (el: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ");
const names = (el: Element) =>
  [...el.querySelectorAll('[data-testid^="leave-"]')].map((c) => c.getAttribute("data-testid"));

describe("the leave requests list", () => {
  it("lists what needs a decision first, with its Approve and Reject", () => {
    const el = mount(createElement(LeaveRequestsTab, tabProps()));
    const cards = el.querySelectorAll('[data-testid^="leave-"]');
    expect(names(el).filter((t) => /^leave-\d+$/.test(t ?? ""))).toEqual(["leave-2", "leave-1"]);
    expect(cards.length).toBeGreaterThan(0);
    const pending = el.querySelector('[data-testid="leave-2"]')!;
    expect([...pending.querySelectorAll("button")].map((b) => text(b).trim()).filter(Boolean)).toEqual([
      "Approve",
      "Reject",
    ]);
    // a decided request has no decision buttons
    const decided = el.querySelector('[data-testid="leave-1"]')!;
    expect([...decided.querySelectorAll("button")].map((b) => text(b).trim()).filter(Boolean)).toEqual([]);
  });

  it("calls the page's handlers with the request", () => {
    const onDecide = vi.fn();
    const onOpen = vi.fn();
    const el = mount(createElement(LeaveRequestsTab, tabProps({ onDecide, onOpen })));
    const card = el.querySelector('[data-testid="leave-2"]')!;
    const approve = [...card.querySelectorAll("button")].find((b) => text(b).includes("Approve"))!;
    act(() => approve.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), "approved");
    expect(onOpen).not.toHaveBeenCalled(); // pressing a button does not also open the card
    act(() => card.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });

  it("offers a decision only when the pipeline lets HR decide", () => {
    const waitingForHod = progress({
      canAct: { hod: true, hr: false },
      canReject: { hod: true, hr: false },
      waitingFor: ["hod"],
    });
    const el = mount(createElement(LeaveRequestsTab, tabProps({ rows: [leave({ id: 3, approval: waitingForHod })] })));
    const card = el.querySelector('[data-testid="leave-3"]')!;
    expect(text(card)).toContain("Waiting for HOD");
    expect([...card.querySelectorAll("button")].map((b) => text(b).trim()).filter(Boolean)).toEqual([]);
  });

  it("the search narrows the list and says how many are left; clearing brings them back", () => {
    const el = mount(createElement(LeaveRequestsTab, tabProps()));
    const search = el.querySelector<HTMLInputElement>('[data-testid="leave-search"]')!;
    type(search, "ravi stitching");
    expect(names(el).filter((t) => /^leave-\d+$/.test(t ?? ""))).toEqual(["leave-2"]);
    expect(text(el.querySelector('[data-testid="leave-count"]')!)).toContain("Showing 1 of 2 leave requests");
    type(search, "nobody at all");
    expect(el.querySelector('[data-testid="leave-no-match"]')).not.toBeNull();
    const clear = el.querySelector<HTMLButtonElement>('[data-testid="leave-count-clear"]')!;
    act(() => clear.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(names(el).filter((t) => /^leave-\d+$/.test(t ?? ""))).toHaveLength(2);
  });

  it("says something different for no requests at all, loading, and a failed load", () => {
    expect(
      mount(createElement(LeaveRequestsTab, tabProps({ rows: [] }))).querySelector('[data-testid="leave-empty"]'),
    ).not.toBeNull();
    act(() => root?.unmount());
    host?.remove();
    expect(
      mount(createElement(LeaveRequestsTab, tabProps({ loading: true }))).querySelector(
        '[data-testid="leave-loading"]',
      ),
    ).not.toBeNull();
    act(() => root?.unmount());
    host?.remove();
    const onRetry = vi.fn();
    const el = mount(createElement(LeaveRequestsTab, tabProps({ failed: true, onRetry })));
    expect(el.querySelector('[data-testid="load-error"]')).not.toBeNull();
    const retry = [...el.querySelectorAll("button")].find((b) => text(b).trim() === "Retry")!;
    act(() => retry.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("in the MD's View Only copy a leave card has nothing visible to press", () => {
    setViewOnlyWorkflows(["leave", "permission"]);
    const el = mount(createElement(LeaveRequestsTab, tabProps()));
    lockMutatingControls(el);
    lockIconOnlyDeletes(el);
    for (const id of ["leave-1", "leave-2"]) {
      const card = el.querySelector(`[data-testid="${id}"]`)!;
      const visible = [...card.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.style.display !== "none");
      expect(visible, id).toHaveLength(0);
    }
    // but the Export button stays usable: reading a list out is not a change
    const exportButton = el.querySelector<HTMLButtonElement>('[data-testid="leave-export"]')!;
    expect(exportButton.disabled).toBe(false);
  });

  it("keeps full-day and half-day in their own modes", () => {
    const half = leave({ id: 4, isHalfDay: true, halfDaySlot: "afternoon", totalDays: 0.5 });
    const el = mount(createElement(LeaveRequestsTab, tabProps({ mode: "half", rows: [half] })));
    expect(el.querySelector('[data-testid="tab-half-day"]')).not.toBeNull();
    expect(text(el.querySelector('[data-testid="leave-4"]')!)).toContain("Afternoon");
    expect(el.querySelector('[data-testid="leave-filter-type"]')).toBeNull(); // a leave type means nothing for a half day
  });
});

// ─── Casual Leave ───

const board = (over: Partial<BoardRow> & { employeeId: number }): BoardRow => ({
  employeeName: `Person ${over.employeeId}`,
  employeeCode: `E${over.employeeId}`,
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

describe("the Casual Leave lists", () => {
  it("names who is not eligible and why, with the date a new joiner qualifies", () => {
    const rows = [
      board({
        employeeId: 1,
        eligible: false,
        reasonCode: "under_service",
        serviceMonths: 5,
        eligibleFrom: "2026-10-20",
      }),
      board({ employeeId: 2, eligible: false, reasonCode: "not_staff", employmentType: "production" }),
      board({
        employeeId: 3,
        eligible: false,
        reasonCode: "used_this_month",
        usedThisMonth: true,
        usedStatus: "approved",
        usedDate: "2026-10-03",
      }),
    ];
    const el = mount(createElement(NotEligibleList, { rows, eligibilityMonths: 6 }));
    expect(text(el.querySelector('[data-testid="not-eligible-1"]')!)).toContain("Under 6 months of service");
    expect(text(el.querySelector('[data-testid="not-eligible-1"]')!)).toContain("Becomes eligible on Tue, 20 Oct 2026");
    expect(text(el.querySelector('[data-testid="not-eligible-2"]')!)).toContain("Production employee");
    expect(text(el.querySelector('[data-testid="not-eligible-3"]')!)).toContain("Already used this month");
    expect(el.querySelector('[data-testid="not-eligible-2"]')!.getAttribute("data-reason")).toBe("not_staff");
  });

  it("lists the eligible with service length and last CL, and Apply CL names the person", () => {
    const onApply = vi.fn();
    const rows = [
      board({ employeeId: 5, employeeName: "Ravi Shankar", serviceMonths: 31, lastClDate: "2026-09-12" }),
      board({ employeeId: 6 }),
    ];
    const el = mount(createElement(EligibleList, { rows, onApply, monthLabel: "October 2026" }));
    const first = el.querySelector('[data-testid="eligible-5"]')!;
    expect(text(first)).toContain("2 yr 7 mo");
    expect(text(first)).toContain("12 Sep 2026");
    expect(text(el.querySelector('[data-testid="eligible-6"]')!)).toContain("Never");
    const button = el.querySelector<HTMLButtonElement>('[data-testid="apply-cl-5"]')!;
    expect(button.getAttribute("aria-label")).toBe("Apply CL for Ravi Shankar in October 2026");
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 5 }));
  });

  it("shows who approved a CL and where it is in the pipeline", () => {
    const request: ClRequest = {
      id: 9,
      employeeId: 1,
      employeeName: "Meena Iyer",
      employeeCode: "E1",
      date: "2026-10-14",
      status: "approved",
      reviewedBy: "Suresh",
      reviewerRole: "dept_head",
      reviewedAt: "2026-10-10T09:00:00Z",
      approval: progress({
        workflow: "casual_leave",
        currentStep: null,
        steps: [
          {
            index: 0,
            roles: ["hod"],
            mandatory: true,
            state: "approved",
            label: "HOD",
            by: "Suresh",
            decidedBy: "hod",
          } as never,
        ],
        canAct: { hod: false, hr: false },
      }),
    };
    const el = mount(createElement(RequestList, { rows: [request], busy: false, onDecide: noop, onDelete: noop }));
    const row = el.querySelector('[data-testid="cl-9"]')!;
    expect(text(row)).toContain("Wed, 14 Oct 2026");
    expect(text(row)).toContain("Approved by Suresh (Dept Head)");
    expect(text(row)).toContain("HOD approved by Suresh");
  });

  it("a decided request can be deleted, a pending one decided", () => {
    const onDecide = vi.fn();
    const onDelete = vi.fn();
    const rows: ClRequest[] = [
      {
        id: 1,
        employeeId: 1,
        employeeName: "A",
        date: "2026-10-14",
        status: "pending",
        approval: progress({ workflow: "casual_leave" }),
      },
      { id: 2, employeeId: 2, employeeName: "B", date: "2026-10-15", status: "rejected" },
    ];
    const el = mount(createElement(RequestList, { rows, busy: false, onDecide, onDelete }));
    const pending = el.querySelector('[data-testid="cl-1"]')!;
    act(() =>
      [...pending.querySelectorAll("button")]
        .find((b) => text(b).includes("Reject"))!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "rejected");
    const decided = el.querySelector('[data-testid="cl-2"]')!;
    expect([...decided.querySelectorAll("button")].map((b) => text(b).trim()).filter(Boolean)).toEqual([]);
    act(() => decided.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });
});

describe("the Casual Leave view frame", () => {
  const frame = (over: Partial<React.ComponentProps<typeof ClTab>> = {}) =>
    createElement(ClTab, {
      id: "eligible",
      filters: NO_CL_FILTERS,
      onFilters: noop,
      noFilters: NO_CL_FILTERS,
      branches: [],
      departments: [],
      searchLabel: "Search eligible employees",
      loading: false,
      failed: false,
      onRetry: noop,
      total: 3,
      shown: 3,
      visible: 60,
      onMore: noop,
      noun: "eligible employees",
      active: false,
      empty: { icon: (() => null) as never, title: "Nobody is eligible", text: "Nobody." },
      onExport: noop,
      children: createElement("p", { "data-testid": "rows" }, "rows"),
      ...over,
    });

  it("draws the rows, or the right reason there are none", () => {
    expect(mount(frame()).querySelector('[data-testid="rows"]')).not.toBeNull();
    act(() => root?.unmount());
    host?.remove();
    // nothing yet
    const none = mount(frame({ total: 0, shown: 0 }));
    expect(none.querySelector('[data-testid="eligible-empty"]')).not.toBeNull();
    expect(none.querySelector('[data-testid="eligible-no-match"]')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    // nothing matches the filters
    const noMatch = mount(frame({ shown: 0, active: true }));
    expect(noMatch.querySelector('[data-testid="eligible-no-match"]')).not.toBeNull();
    expect(noMatch.querySelector('[data-testid="eligible-empty"]')).toBeNull();
  });

  it("offers more rows only when some are left, and Export is off with nothing to export", () => {
    const more = vi.fn();
    const el = mount(frame({ total: 100, shown: 100, visible: 60, onMore: more }));
    const button = el.querySelector<HTMLButtonElement>('[data-testid="show-more"]')!;
    expect(text(button)).toContain("40 left");
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(more).toHaveBeenCalledOnce();
    act(() => root?.unmount());
    host?.remove();
    expect(
      mount(frame({ shown: 0, total: 3, active: true })).querySelector<HTMLButtonElement>(
        '[data-testid="eligible-export"]',
      )!.disabled,
    ).toBe(true);
  });
});
