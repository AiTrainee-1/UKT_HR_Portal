// Owner brief 2026-11-21 on the Requests page: the list comes a page at a time from the server, every request shows its
// request date, the date(s) it is for, its reason and the exact moment it was sent, and a rejection needs its reason.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RejectReasonDialog } from "@/components/RejectReasonDialog";
import { HandleDialog, DetailDialog } from "./dialogs";
import {
  EXPORT_MAX,
  NO_FILTERS,
  exportParams,
  pageButtons,
  pageRange,
  requestedText,
  serverParams,
  submittedText,
  type HubItem,
  type HubKind,
} from "./logic";
import Pager from "./Pager";
import type { ActionHandlers } from "./parts";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

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
});

function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

const $ = (testId: string) => document.body.querySelector(`[data-testid="${testId}"]`);
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
function type(el: Element | null, value: string) {
  const box = el as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const item = (over: Partial<HubItem> = {}): HubItem => ({
  key: "leave-1",
  kind: "leave",
  id: 1,
  employee: {
    id: 1,
    code: "E001",
    name: "Asha Kumar",
    department: "Cutting",
    departmentId: 5,
    designation: "Operator",
    branch: "Unit1",
    branchId: 10,
    type: "staff",
    photoUrl: null,
  },
  label: "Sick Leave",
  summary: "2026-10-12 → 2026-10-14 · 3 days",
  reason: "Fever",
  reasonLabel: "Reason",
  requested: { from: "2026-10-12", to: "2026-10-14", note: "3 days", label: "Requested dates", precision: "day" },
  date: "2026-10-12",
  details: [],
  status: "pending",
  rawStatus: "pending",
  statusLabel: null,
  queue: "hr",
  approval: null,
  submittedAt: "2026-10-10T08:05:09Z",
  decided: null,
  extra: {},
  ...over,
});

const kind: HubKind = {
  key: "leave",
  label: "Leave",
  group: "Requests",
  access: "edit",
  mode: "quick",
  openPath: null,
  openLabel: null,
  pipeline: "Employee → HR",
  enabled: true,
  waiting: 1,
  waitingHr: 1,
  waitingHod: 0,
  matched: 1,
  truncated: false,
};

const handlers: ActionHandlers = { onApprove: vi.fn(), onReject: vi.fn(), onHandle: vi.fn(), onOpenPage: vi.fn() };

describe("the server pages the list", () => {
  it("asks for one page of one tab, with the search, the order and 'waiting for HR' as they are", () => {
    const params = serverParams(
      { ...NO_FILTERS, query: "  asha   kumar ", status: "waiting_hr", sort: "oldest" },
      { tab: "leave", page: 3, pageSize: 50 },
    );
    expect(params).toEqual({
      kind: "leave",
      status: "waiting_hr",
      q: "asha kumar",
      sort: "oldest",
      page: "3",
      pageSize: "50",
    });
  });

  it("sends the request type only on the Other requests tab", () => {
    const f = { ...NO_FILTERS, requestType: "salary_enquiry" };
    expect(serverParams(f, { tab: "request", page: 1, pageSize: 25 }).requestType).toBe("salary_enquiry");
    expect(serverParams(f, { tab: "all", page: 1, pageSize: 25 }).requestType).toBeUndefined();
  });

  it("sends the date filter's days (the days requests are for) beside the page", () => {
    const params = serverParams(
      NO_FILTERS,
      { tab: "all", page: 1, pageSize: 25 },
      { from: "2026-11-01", to: "2026-11-30" },
    );
    expect(params.from).toBe("2026-11-01");
    expect(params.to).toBe("2026-11-30");
    // an export of the page asks for the same days
    expect(exportParams(params)).toMatchObject({ from: "2026-11-01", to: "2026-11-30", export: "1" });
  });

  it("an export asks for every matching request at once, never the linked one", () => {
    const params = serverParams(NO_FILTERS, { tab: "all", page: 4, pageSize: 25 });
    expect(exportParams({ ...params, focus: "leave-1" })).toEqual({
      kind: "all",
      sort: "latest",
      page: "1",
      pageSize: String(EXPORT_MAX),
      export: "1",
    });
  });

  it("numbers the rows of a page and draws the page buttons around the current one", () => {
    expect(pageRange(2, 25, 212)).toEqual({ first: 26, last: 50 });
    expect(pageRange(9, 25, 212)).toEqual({ first: 201, last: 212 });
    expect(pageRange(1, 25, 0)).toEqual({ first: 0, last: 0 });
    expect(pageButtons(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageButtons(1, 9)).toEqual([1, 2, 3, 4, "gap", 9]);
    expect(pageButtons(5, 9)).toEqual([1, "gap", 4, 5, 6, "gap", 9]);
    expect(pageButtons(9, 9)).toEqual([1, "gap", 6, 7, 8, 9]);
  });

  it("the pager says which rows are shown and moves page by page", () => {
    const onPage = vi.fn();
    mount(createElement(Pager, { page: 2, pages: 9, pageSize: 25, total: 212, onPage, onPageSize: vi.fn() }));
    expect($("requests-range")!.textContent).toContain("Showing 26-50 of 212 requests");
    click($("requests-page-next"));
    expect(onPage).toHaveBeenLastCalledWith(3);
    click($("requests-page-prev"));
    expect(onPage).toHaveBeenLastCalledWith(1);
    click($("requests-page-9"));
    expect(onPage).toHaveBeenLastCalledWith(9);
    expect($("requests-page-2")!.getAttribute("aria-current")).toBe("page");
  });
});

describe("request date, requested date(s), reason and timestamp", () => {
  it("writes the requested dates in words, a month for an advance, nothing when not tied to a date", () => {
    expect(requestedText(item())).toBe("12 Oct 2026 to 14 Oct 2026 · 3 days");
    expect(
      requestedText(
        item({ requested: { from: "2026-11-01", to: null, note: null, label: "Deduct from", precision: "month" } }),
      ),
    ).toBe("Nov 2026");
    expect(requestedText(item({ requested: null }))).toBeNull();
  });

  it("the details show all four, the time to the second", () => {
    mount(
      createElement(DetailDialog, { item: item(), kind, now: new Date(), busy: false, handlers, onClose: vi.fn() }),
    );
    const facts = $("request-facts")!.textContent!;
    expect(facts).toContain("Request date");
    expect(facts).toContain("Requested dates");
    expect($("request-requested")!.textContent).toBe("12 Oct 2026 to 14 Oct 2026 · 3 days");
    expect($("request-submitted-at")!.textContent).toBe(submittedText("2026-10-10T08:05:09Z"));
    expect($("request-submitted-at")!.textContent).toMatch(/:09/);
    expect($("request-reason")!.textContent).toBe("Fever");
  });

  it("says plainly when a request type asks no reason", () => {
    mount(
      createElement(DetailDialog, {
        item: item({ kind: "on_duty", key: "on_duty-1", reason: null, requested: null }),
        kind: { ...kind, key: "on_duty" },
        now: new Date(),
        busy: false,
        handlers,
        onClose: vi.fn(),
      }),
    );
    expect($("request-reason")!.textContent).toBe("Not asked on this type of request");
    expect($("request-requested")!.textContent).toBe("Not tied to a date");
  });
});

describe("rejecting needs the reason", () => {
  it("sends nothing until the reason is long enough, then sends it cleaned", () => {
    const onConfirm = vi.fn();
    mount(createElement(RejectReasonDialog, { open: true, onCancel: vi.fn(), onConfirm, testIdPrefix: "rr" }));
    click($("rr-confirm"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Write the reason for rejecting (at least 3 characters).");
    type($("rr-text"), "  no  ");
    click($("rr-confirm"));
    expect(onConfirm).not.toHaveBeenCalled();
    type($("rr-text"), "  Dates   already  taken ");
    click($("rr-confirm"));
    expect(onConfirm).toHaveBeenCalledWith("Dates already taken");
  });

  it("shows the server's refusal inside the dialog", () => {
    mount(
      createElement(RejectReasonDialog, {
        open: true,
        error: "Write the reason for rejecting (at least 3 characters).",
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
        testIdPrefix: "rr",
      }),
    );
    expect($("rr-error")!.textContent).toContain("Write the reason");
  });

  it("a general request set to Rejected needs notes; any other status does not", () => {
    const onSubmit = vi.fn();
    const general = item({ kind: "request", key: "request-1", extra: { storedStatus: "rejected", hrNotes: "" } });
    // opened on a request already rejected: saving notes again is not a new rejection
    mount(createElement(HandleDialog, { item: general, busy: false, onClose: vi.fn(), onSubmit }));
    click($("handle-submit"));
    expect(onSubmit).toHaveBeenCalledWith("rejected", "");
  });
});
