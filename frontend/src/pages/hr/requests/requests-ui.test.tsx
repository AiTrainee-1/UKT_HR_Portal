import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApprovalProgress } from "@/lib/approval-workflow";
import { DecisionDialog, DetailDialog } from "./dialogs";
import { NO_FILTERS, type HubItem, type HubKind } from "./logic";
import type { ActionHandlers } from "./parts";
import RequestList from "./RequestList";
import Toolbar from "./Toolbar";

const phone = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => phone.value }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has none of these, and the dialogs / selects measure with them
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
  phone.value = false;
});

function mount(node: React.ReactElement) {
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
  steps: [{ index: 0, roles: ["hod", "hr"], mandatory: true, state: "pending", label: "HOD or HR" }],
  currentStep: 0,
  waitingFor: ["hod", "hr"],
  canAct: { hod: true, hr: true },
  canReject: { hod: true, hr: true },
  ...over,
});

const make = (over: Partial<HubItem>): HubItem => ({
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
  label: "Casual Leave",
  summary: "2026-10-12 → 2026-10-14 · 3 days",
  reason: "family function",
  date: "2026-10-12",
  details: [{ label: "From", value: "2026-10-12" }],
  status: "pending",
  rawStatus: "pending",
  statusLabel: null,
  queue: "hr",
  approval: progress(),
  submittedAt: "2026-10-10T08:00:00Z",
  decided: null,
  extra: {},
  ...over,
});

const kind = (key: HubKind["key"], over: Partial<HubKind> = {}): HubKind => ({
  key,
  label: key,
  group: "Requests",
  access: "edit",
  mode: "quick",
  openPath: null,
  openLabel: null,
  pipeline: "Employee → HOD or HR",
  enabled: true,
  waiting: 1,
  waitingHr: 1,
  waitingHod: 0,
  matched: 1,
  truncated: false,
  ...over,
});

const handlers = (): ActionHandlers & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    onApprove: (i) => calls.push(`approve:${i.key}`),
    onReject: (i) => calls.push(`reject:${i.key}`),
    onHandle: (i) => calls.push(`handle:${i.key}`),
    onOpenPage: (i, k) => calls.push(`open:${i.key}:${k.openPath}`),
  };
};

const names = (el: Element) => Array.from(el.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim());
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

const hodApproval = progress({
  workflow: "missing_punch",
  steps: [
    { index: 0, roles: ["hod"], mandatory: true, state: "pending", label: "HOD" },
    { index: 1, roles: ["hr"], mandatory: true, state: "waiting", label: "HR" },
  ],
  waitingFor: ["hod"],
  canAct: { hod: true, hr: false },
  canReject: { hod: true, hr: false },
});

describe("RequestList", () => {
  const leave = make({});
  const waitingHod = make({
    key: "missing_punch-2",
    kind: "missing_punch",
    id: 2,
    label: "Missing Punch",
    queue: "hod",
    approval: hodApproval,
  });
  const resignation = make({ key: "resignation-3", kind: "resignation", id: 3, label: "Resignation", queue: "hod" });
  const approved = make({
    key: "outpass-4",
    kind: "outpass",
    id: 4,
    label: "Outpass",
    status: "approved",
    rawStatus: "approved",
    queue: null,
    approval: progress({ currentStep: null, waitingFor: [], canAct: { hod: false, hr: false } }),
    decided: { by: "Meena", role: "hr", at: "2026-10-10T09:00:00Z", comment: null },
  });
  const kinds = {
    leave: kind("leave"),
    missing_punch: kind("missing_punch"),
    resignation: kind("resignation", {
      mode: "link",
      openPath: "/hr/recruitment/resignations",
      openLabel: "Resignations",
    }),
    outpass: kind("outpass"),
  } as Record<string, HubKind>;
  const items = [leave, waitingHod, resignation, approved];

  const render = (h = handlers(), busyKey: string | null = null, onOpen = vi.fn()) => {
    const el = mount(
      createElement(RequestList, { items, kinds, now: new Date("2026-10-11T08:00:00Z"), busyKey, handlers: h, onOpen }),
    );
    return { el, h, onOpen };
  };

  it("draws each request once, with the buttons that apply to it", () => {
    const { el } = render();
    for (const id of ["leave-1", "missing_punch-2", "resignation-3", "outpass-4"]) {
      const [kindKey, num] = [id.replace(/-\d+$/, ""), id.replace(/^.*-/, "")];
      expect(el.querySelectorAll(`[data-testid="request-${kindKey}-${num}"]`), id).toHaveLength(1);
    }
    const row = (id: string) => el.querySelector(`[data-testid="request-${id}"]`)!;
    expect(names(row("leave-1"))).toEqual(["Approve", "Reject"]);
    // with the HOD: nothing to press, and it says who it waits for
    expect(names(row("missing_punch-2"))).toEqual([]);
    expect(row("missing_punch-2").textContent).toContain("Waiting for HOD");
    // a resignation is decided on its own page
    expect(names(row("resignation-3"))).toEqual(["Open in Resignations"]);
    // decided: no buttons, and who decided it
    expect(names(row("outpass-4"))).toEqual([]);
    expect(row("outpass-4").textContent).toContain("Meena");
    expect(row("outpass-4").textContent).toContain("approved");
  });

  it("a button acts without opening the details, a click on the row opens them", () => {
    const { el, h, onOpen } = render();
    click(el.querySelector('[data-testid="approve-leave-1"]'));
    click(el.querySelector('[data-testid="reject-leave-1"]'));
    click(el.querySelector('[data-testid="open-resignation-3"]'));
    expect(h.calls).toEqual(["approve:leave-1", "reject:leave-1", "open:resignation-3:/hr/recruitment/resignations"]);
    expect(onOpen).not.toHaveBeenCalled();
    click(el.querySelector('[data-testid="request-leave-1"]'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("disables the buttons of the request being decided", () => {
    const { el } = render(handlers(), "leave-1");
    expect((el.querySelector('[data-testid="approve-leave-1"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("on a phone it is one card per request, not a table, and still once each", () => {
    phone.value = true;
    const { el } = render();
    expect(el.querySelector("table")).toBeNull();
    expect(el.querySelectorAll('[data-testid="request-leave-1"]')).toHaveLength(1);
    expect(el.querySelector('[data-testid="requests-cards"]')).not.toBeNull();
  });
});

describe("DetailDialog and DecisionDialog", () => {
  it("shows the whole approval trail, who decided and when", () => {
    const decided = make({
      status: "rejected",
      rawStatus: "rejected",
      queue: null,
      approval: progress({
        currentStep: null,
        waitingFor: [],
        canAct: { hod: false, hr: false },
        steps: [
          {
            index: 0,
            roles: ["hod", "hr"],
            mandatory: true,
            state: "rejected",
            label: "HOD or HR",
            by: "Meena",
            comment: "Not this week",
          },
        ],
      }),
      decided: { by: "Meena", role: "hr", at: "2026-10-10T09:00:00Z", comment: "Not this week" },
    });
    mount(
      createElement(DetailDialog, {
        item: decided,
        kind: kind("leave"),
        now: new Date("2026-10-11T08:00:00Z"),
        busy: false,
        handlers: handlers(),
        onClose: () => {},
      }),
    );
    const dialog = document.body.querySelector('[data-testid="request-detail"]')!;
    expect(dialog.querySelector('[data-testid="approval-trail"]')).not.toBeNull();
    expect(dialog.querySelector('[data-testid="decided-by"]')?.textContent).toContain("Rejected by");
    expect(dialog.textContent).toContain("Meena (HR)");
    expect(dialog.textContent).toContain("Not this week");
    expect(dialog.textContent).toContain("family function");
    // decided: nothing to approve, a way to the dedicated page only when the kind has one
    expect(names(dialog)).not.toContain("Approve");
  });

  it("offers Approve and Reject in the dialog when it is HR's turn, and the link to the page", () => {
    const h = handlers();
    mount(
      createElement(DetailDialog, {
        item: make({}),
        kind: kind("leave", { openPath: "/hr/leave?tab=leaves", openLabel: "Leave & Holiday" }),
        now: new Date("2026-10-11T08:00:00Z"),
        busy: false,
        handlers: h,
        onClose: () => {},
      }),
    );
    const dialog = document.body.querySelector('[data-testid="request-detail"]')!;
    expect(names(dialog)).toEqual(expect.arrayContaining(["Approve", "Reject", "Open in Leave & Holiday"]));
    click(Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Reject") ?? null);
    expect(h.calls).toEqual(["reject:leave-1"]);
  });

  it("the reject dialog asks for an optional reason and confirms with it", () => {
    const onConfirm = vi.fn();
    mount(createElement(DecisionDialog, { item: make({}), mode: "reject", busy: false, onClose: () => {}, onConfirm }));
    const note = document.body.querySelector('[data-testid="decision-note"]') as HTMLTextAreaElement;
    expect(note.placeholder).toContain("optional");
    const confirm = document.body.querySelector('[data-testid="decision-confirm"]') as HTMLButtonElement;
    expect(confirm.textContent).toContain("Confirm reject");
    click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("");
  });
});

describe("Toolbar", () => {
  it("reports each change as a new filter set, and clears them", () => {
    const onFilters = vi.fn();
    const onExport = vi.fn();
    mount(
      createElement(Toolbar, {
        filters: { ...NO_FILTERS, status: "waiting", query: "asha" },
        onFilters,
        options: {
          branches: [
            { id: 1, name: "A" },
            { id: 2, name: "B" },
          ],
          departments: [],
        },
        showRequestType: false,
        shown: 2,
        total: 9,
        canExport: true,
        onExport,
      }),
    );
    const count = document.body.querySelector('[data-testid="requests-count"]')!;
    expect(count.textContent).toContain("Showing 2 of 9 requests");
    expect(count.textContent).toContain("1 filter on");
    click(document.body.querySelector('[data-testid="requests-clear-filters"]'));
    expect(onFilters).toHaveBeenCalledWith({ ...NO_FILTERS });
    // the export button is wrapped so the Managing Director's view-only lock leaves it alone
    expect(document.body.querySelector('[data-testid="requests-export"]')?.closest("[data-view-safe]")).not.toBeNull();
  });
});
