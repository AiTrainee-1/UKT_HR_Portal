import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { AdvanceDecisionItem } from "@/lib/api-client";
import Settlement from "../Settlement";
import type { SettlementRow } from "./logic";

// The Settlement page against a small fake server (customFetch is replaced): the Overview / Term Loan / Term Advance tabs
// and the month filter in the address, the remark rules of the Approve and Reject dialogs (what is sent, and the server's
// refusal shown in the dialog), and the requested / approved amounts and the history in the detail sheet.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));

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

const base = (over: Partial<SettlementRow>): SettlementRow => ({
  id: 0,
  employeeId: 1,
  employeeCode: "E001",
  employeeName: "Asha Kumar",
  employeeDepartment: "Stitching",
  employeeBranch: "Tiruppur",
  employeeType: "production",
  employeeStatus: "active",
  advanceType: "general",
  amount: 1000,
  requestedAmount: 1000,
  purpose: "Medical",
  status: "pending",
  emiAmount: 0,
  totalRepaid: 0,
  outstanding: 1000,
  decisionRemark: "",
  decidedAt: null,
  scheduleMonths: [],
  createdAt: "2026-11-03T05:00:00Z",
  ...over,
});

/** The fake server's advances: a pending term advance (Nov), a pending term loan (Nov), an approved term loan applied in
 *  October, approved for less, deducted Dec-Jan. */
let advances: SettlementRow[] = [];
let history: Record<number, AdvanceDecisionItem[]> = {};
/** Every PUT the page sent: [id, body]. */
let puts: [number, Record<string, unknown>][] = [];
/** The next PUT's refusal, when a test wants one. */
let refuseNext: { error: string; code: string } | null = null;

const refusal = (status: number, data: unknown) =>
  new ApiError(new Response(null, { status, statusText: "Bad Request" }), data, {
    method: "PUT",
    url: "/api/advances",
  });

function server(url: string, options?: { method?: string; body?: string }) {
  const one = /^\/api\/advances\/(\d+)$/.exec(url);
  if (one && options?.method === "PUT") {
    const id = Number(one[1]);
    const body = JSON.parse(options.body ?? "{}") as Record<string, unknown>;
    puts.push([id, body]);
    if (refuseNext) {
      const r = refuseNext;
      refuseNext = null;
      throw refusal(400, r);
    }
    const a = advances.find((x) => x.id === id)!;
    const remark = String(body.decisionRemark ?? "").trim();
    const asked = a.requestedAmount ?? a.amount;
    const amount = typeof body.amount === "number" ? body.amount : a.amount;
    if (body.status === "rejected" && remark.length < 3)
      throw refusal(400, { error: "Write the reason for rejecting (at least 3 characters).", code: "remark" });
    if (body.status === "approved" && amount !== asked && remark.length < 3)
      throw refusal(400, { error: "Write a remark.", code: "remark" });
    Object.assign(a, {
      status: body.status,
      amount,
      decisionRemark: remark,
      decidedAt: "2026-11-20T05:00:00Z",
      approvedBy: "HR Admin",
    });
    return Promise.resolve({ ...a });
  }
  if (one) {
    const id = Number(one[1]);
    return Promise.resolve({ ...advances.find((x) => x.id === id), repayments: [], history: history[id] ?? [] });
  }
  if (url.startsWith("/api/advances")) return Promise.resolve(advances.map((a) => ({ ...a })));
  if (url.startsWith("/api/payroll-settings")) return Promise.resolve({ companyName: "UK Textiles" });
  return Promise.resolve([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-20T10:00:00") });
  advances = [
    base({
      id: 1,
      employeeCode: "A1",
      employeeName: "Asha Kumar",
      advanceType: "general",
      repaymentStartMonth: 11,
      repaymentStartYear: 2026,
    }),
    base({
      id: 2,
      employeeCode: "L1",
      employeeName: "Ravi Shankar",
      advanceType: "term",
      amount: 6000,
      requestedAmount: 6000,
      repaymentMonths: 3,
      emiAmount: 2000,
      repaymentStartMonth: 12,
      repaymentStartYear: 2026,
    }),
    base({
      id: 3,
      employeeCode: "L2",
      employeeName: "Meena Iyer",
      advanceType: "term",
      status: "approved",
      amount: 700,
      requestedAmount: 1000,
      repaymentMonths: 2,
      emiAmount: 350,
      repaymentStartMonth: 12,
      repaymentStartYear: 2026,
      outstanding: 700,
      decisionRemark: "Budget limit this month",
      approvedBy: "HR Admin",
      decidedAt: "2026-10-20T05:00:00Z",
      approvedAt: "2026-10-20T05:00:00Z",
      scheduleMonths: ["2026-12", "2027-01"],
      createdAt: "2026-10-10T05:00:00Z",
    }),
  ];
  history = {
    3: [
      {
        id: 31,
        action: "approved",
        requestedAmount: 1000,
        approvedAmount: 700,
        startMonth: 12,
        startYear: 2026,
        remark: "Budget limit this month",
        by: "HR Admin",
        at: "2026-10-20T05:00:00Z",
      },
    ],
  };
  puts = [];
  refuseNext = null;
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

function mount(search = "") {
  window.history.replaceState(null, "", `/hr/settlement${search}`);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(
    ["/api/advances", undefined],
    advances.map((a) => ({ ...a })),
  );
  client.setQueryData(["/api/employees", "lite", { status: "active" }], []);
  client.setQueryData(["/api/payroll-settings"], { companyName: "UK Textiles" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(Settlement))));
  return host;
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => {
  expect(el, "element to click").not.toBeNull();
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
function type(el: Element | null, value: string) {
  expect(el, "field to type in").not.toBeNull();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
const rowIds = () =>
  [...document.querySelectorAll('[data-testid^="advance-row-"]')].map((r) => r.getAttribute("data-testid"));

describe("the Settlement page", () => {
  it("opens on Overview: both kinds waiting, and a tab for each kind with its pending count", () => {
    mount();
    expect(rowIds()).toEqual(["advance-row-2", "advance-row-1"]); // newest first, pending only
    expect(text(q("settlement-tab-loan"))).toContain("Term Loan");
    expect(text(q("settlement-tab-loan"))).toContain("1");
    expect(text(q("stat-pending-value"))).toBe("2");
    expect(q("filter-type")).not.toBeNull(); // only Overview has both types to choose from
  });

  it("Term Loan lists only term loans, keeps the tab in the address, and Term Advance only the others", () => {
    mount("?status=all");
    click(q("settlement-tab-loan"));
    expect(window.location.search).toContain("tab=loan");
    expect(rowIds()).toEqual(["advance-row-2"]); // a new tab opens on its own filters: pending
    expect(q("filter-type")).toBeNull();
    expect(text(q("stat-active"))).toContain("Active term loans");
    click(q("settlement-tab-advance"));
    expect(window.location.search).toContain("tab=advance");
    expect(rowIds()).toEqual(["advance-row-1"]);
    // back on Overview, its own filters (status: all) come back
    click(q("settlement-tab-overview"));
    expect(window.location.search).toContain("status=all");
    expect(rowIds()).toHaveLength(3);
  });

  it("the month in the address narrows the list, and the basis says which activity counts", () => {
    mount("?status=all&month=10&year=2026");
    expect(rowIds()).toEqual(["advance-row-3"]); // applied and approved in October
    act(() => root!.unmount());
    host!.remove();
    mount("?status=all&month=12&year=2026&basis=deducted");
    expect(rowIds()).toEqual(["advance-row-3"]); // its first deduction is in December
    act(() => root!.unmount());
    host!.remove();
    mount("?status=all&month=11&year=2026&basis=applied");
    expect(rowIds()).toEqual(["advance-row-2", "advance-row-1"]);
    expect(text(q("settlement-figures-scope"))).toContain("Figures for November 2026 (applied)");
  });

  it("shows requested and approved apart, and HR's remark, in the list", () => {
    mount("?status=approved");
    expect(text(q("advance-asked-3"))).toBe("of ₹1,000 asked");
    expect(text(q("advance-row-3"))).toContain("₹700");
    expect(text(q("advance-remark-3"))).toContain("Budget limit this month");
  });

  it("Reject needs a reason: nothing is sent without one, and the reason goes as decisionRemark", async () => {
    mount();
    click(q("advance-reject-1"));
    expect(q("decision-dialog")).not.toBeNull();
    expect(text(q("decision-remark-problem"))).toBe("Write the reason for rejecting (at least 3 characters).");
    click(q("decision-confirm"));
    await flush();
    expect(puts).toEqual([]);
    type(q("decision-remark"), "ab");
    expect(q("decision-remark-problem")).not.toBeNull();
    type(q("decision-remark"), "  Has a loan\n running ");
    expect(q("decision-remark-problem")).toBeNull();
    click(q("decision-confirm"));
    await flush();
    expect(puts).toEqual([[1, { status: "rejected", decisionRemark: "Has a loan running" }]]);
    expect(q("decision-dialog")).toBeNull();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Advance rejected" }));
  });

  it("approving less than asked needs a remark; the full amount does not; the EMI is worked out", async () => {
    mount();
    click(q("advance-approve-2"));
    expect(text(q("decision-emi"))).toBe("₹2,000 a month for 3 months");
    expect(q("decision-remark-problem")).toBeNull(); // the full amount: the remark is optional
    type(q("decision-amount"), "4500");
    expect(text(q("decision-remark-problem"))).toBe("You are approving ₹4,500 of the ₹6,000 asked for - write why.");
    expect(text(q("decision-emi"))).toBe("₹1,500 a month for 3 months");
    expect(text(q("decision-confirm"))).toBe("Approve ₹4,500");
    click(q("decision-confirm"));
    await flush();
    expect(puts).toEqual([]);
    type(q("decision-amount"), "6001");
    expect(text(q("decision-problem"))).toBe("You can approve at most the ₹6,000 asked for.");
    expect((q("decision-confirm") as HTMLButtonElement).disabled).toBe(true);
    type(q("decision-amount"), "4500");
    type(q("decision-remark"), "Budget limit this month");
    click(q("decision-confirm"));
    await flush();
    expect(puts).toEqual([[2, { status: "approved", amount: 4500, decisionRemark: "Budget limit this month" }]]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Advance approved" }));
  });

  it("an untouched approval sends what it always did", async () => {
    mount();
    click(q("advance-approve-1"));
    click(q("decision-confirm"));
    await flush();
    expect(puts).toEqual([[1, { status: "approved" }]]);
  });

  it("shows the server's own words in the dialog when it refuses, and stays open", async () => {
    mount();
    click(q("advance-approve-1"));
    refuseNext = { error: "Advance approvals are switched off right now.", code: "invalid" };
    click(q("decision-confirm"));
    await flush();
    expect(text(q("decision-server-error"))).toBe("Advance approvals are switched off right now.");
    expect(q("decision-dialog")).not.toBeNull();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("the detail sheet shows requested and approved, HR's remark and the history", async () => {
    mount("?status=approved");
    click(q("advance-row-3"));
    await flush();
    const sheet = q("advance-detail");
    expect(text(sheet!.querySelector('[data-testid="advance-figures"]'))).toContain("Requested₹1,000");
    expect(text(sheet!.querySelector('[data-testid="advance-figures"]'))).toContain("Approved₹700");
    expect(text(q("advance-approved-less"))).toContain("₹700 approved of the ₹1,000 asked for");
    expect(text(q("advance-decision-remark"))).toContain("Budget limit this month");
    const item = text(q("advance-history-31"));
    expect(item).toContain("Approved ₹700 of the ₹1,000 asked for");
    expect(item).toContain("Deductions from Dec 2026");
    expect(item).toContain("by HR Admin");
  });
});
