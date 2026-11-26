import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { AdvanceDecisionItem } from "@/lib/api-client";
import Settlement from "../Settlement";
import type { SettlementRow } from "./logic";

// The Settlement page against a small fake server (customFetch is replaced): the Overview / Term Loan / Salary Advance
// tabs and the month filter in the address, the remark rules of the Approve and Reject dialogs (what is sent, and the
// server's refusal shown in the dialog), the requested / approved amounts and the history in the detail sheet, and the
// 2026-11-26 rules: the salary earned 1st-20th and its 50 % limit in the New dialog, delete only while pending.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn(), excel: vi.fn(), pdf: vi.fn(), bank: vi.fn() }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ user: null }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
// the files themselves are tested in export.test.ts and lib/bankFile.test.ts: here, what the page hands them
vi.mock("./export", () => ({
  downloadSettlementExcel: h.excel,
  downloadSettlementPdf: h.pdf,
  exportFileName: (t: { fileStem: string }, ext: string) => `${t.fileStem}.${ext}`,
}));
vi.mock("@/lib/bankFile", () => ({ downloadBankFile: h.bank }));
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

/** The fake server's advances: a pending salary advance (Nov), a pending term loan (Nov), an approved term loan applied in
 *  October, approved for less, deducted Dec-Jan. */
let advances: SettlementRow[] = [];
let history: Record<number, AdvanceDecisionItem[]> = {};
/** Every PUT the page sent: [id, body]. */
let puts: [number, Record<string, unknown>][] = [];
/** The next PUT's refusal, when a test wants one. */
let refuseNext: { error: string; code: string } | null = null;
/** Every POST /api/advances body, and every DELETE's id. */
let posts: Record<string, unknown>[] = [];
let deletes: number[] = [];
/** The next DELETE's refusal (409 not_pending), when a test wants one. */
let refuseDelete: { error: string; code: string } | null = null;

const EARNINGS = {
  month: 11,
  year: 2026,
  throughDay: 20,
  through: "2026-11-20",
  fixedSalary: 26000,
  dailyRate: 1000,
  companyDays: 26,
  workingDays: 14.5,
  paidDays: 16.12,
  earnedAmount: 16120,
  percent: 50,
  limit: 8060,
};
/** GET /api/advances/earnings per employee: 7 is a staff member of 2 months, 8 a production employee. */
const preview = (employeeId: number) => ({
  employeeId,
  employeeType: employeeId === 8 ? "production" : "staff",
  month: 11,
  year: 2026,
  throughDay: 20,
  percent: 50,
  earnings: employeeId === 8 ? null : EARNINGS,
  noSalaryReason:
    employeeId === 8 ? "Paid per shift: there is no monthly fixed salary, so no Salary Advance limit." : null,
  termLoanService:
    employeeId === 8
      ? {
          eligible: true,
          joinDate: "2024-01-05",
          serviceMonths: 34,
          requiredMonths: 6,
          eligibleFrom: "2024-07-05",
          reason: null,
        }
      : {
          eligible: false,
          joinDate: "2026-09-15",
          serviceMonths: 2,
          requiredMonths: 6,
          eligibleFrom: "2027-03-15",
          reason: "A Term Loan needs 6 months of service. You can apply from 15 March 2027 (2/6 months of service).",
        },
});

const EMPLOYEES = [
  { id: 7, employeeCode: "S7", firstName: "Priya", lastName: "Nair", employmentType: "staff", status: "active" },
  { id: 8, employeeCode: "P8", firstName: "Kumar", lastName: "Vel", employmentType: "production", status: "active" },
];

const refusal = (status: number, data: unknown) =>
  new ApiError(new Response(null, { status, statusText: "Bad Request" }), data, {
    method: "PUT",
    url: "/api/advances",
  });

function server(url: string, options?: { method?: string; body?: string }) {
  const earnings = /^\/api\/advances\/earnings\?employeeId=(\d+)/.exec(url);
  if (earnings) return Promise.resolve(preview(Number(earnings[1])));
  if (url === "/api/advances" && options?.method === "POST") {
    const body = JSON.parse(options.body ?? "{}") as Record<string, unknown>;
    posts.push(body);
    return Promise.resolve({ ...base({ id: 99 }), ...body, status: "pending" });
  }
  const one = /^\/api\/advances\/(\d+)$/.exec(url);
  if (one && options?.method === "DELETE") {
    deletes.push(Number(one[1]));
    if (refuseDelete) {
      const r = refuseDelete;
      refuseDelete = null;
      throw new ApiError(new Response(null, { status: 409, statusText: "Conflict" }), r, {
        method: "DELETE",
        url,
      });
    }
    return Promise.resolve(undefined);
  }
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
  posts = [];
  deletes = [];
  refuseDelete = null;
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
  client.setQueryData(["/api/employees", "lite", { status: "active" }], EMPLOYEES);
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
    expect(text(q("count-pending-value"))).toBe("2");
    expect(q("filter-type")).not.toBeNull(); // only Overview has both types to choose from
  });

  it("opens on this month (raised in it): the counts add up, and All months is one choice away", () => {
    mount();
    expect(window.location.search).toBe(""); // a clean address
    expect(text(q("filter-month"))).toContain("November");
    expect(text(q("filter-basis"))).toContain("Raised in the month");
    // November: the two waiting ones (the approved loan was raised in October)
    const count = (id: string) => Number(text(q(`count-${id}-value`)));
    expect([count("received"), count("approved"), count("rejected"), count("pending")]).toEqual([2, 0, 0, 2]);
    expect(text(q("stat-pending-value"))).toBe("₹7,000"); // the money cards follow the same month
    act(() => root!.unmount());
    host!.remove();
    mount("?month=all");
    expect([count("received"), count("approved"), count("rejected"), count("pending")]).toEqual([3, 1, 0, 2]);
    expect(count("approved") + count("rejected") + count("pending")).toBe(count("received"));
    expect(text(q("count-approved"))).toContain("1 active · 0 completed");
  });

  it("a count card sets the status: Approved = active + completed, Received = all", () => {
    mount("?month=all");
    expect(rowIds()).toEqual(["advance-row-2", "advance-row-1"]);
    click(q("count-approved"));
    expect(window.location.search).toContain("status=approved_all");
    expect(rowIds()).toEqual(["advance-row-3"]);
    expect(q("count-approved")!.getAttribute("aria-pressed")).toBe("true");
    click(q("count-received"));
    expect(window.location.search).toContain("status=all");
    expect(rowIds()).toHaveLength(3);
    click(q("count-rejected"));
    expect(rowIds()).toEqual([]);
    click(q("count-pending"));
    expect(window.location.search).not.toContain("status="); // pending is the default
    expect(rowIds()).toEqual(["advance-row-2", "advance-row-1"]);
  });

  it("Term Loan lists only term loans, keeps the tab in the address, and Salary Advance only the others", () => {
    mount("?status=all&month=all");
    click(q("settlement-tab-loan"));
    expect(window.location.search).toContain("tab=loan");
    expect(rowIds()).toEqual(["advance-row-2"]); // a new tab opens on its own filters: pending
    expect(q("filter-type")).toBeNull();
    expect(text(q("stat-active"))).toContain("active term loans");
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
    expect(text(q("settlement-figures-scope"))).toContain("Figures for November 2026 (raised in it)");
  });

  it("shows requested and approved apart, and HR's remark, in the list", () => {
    mount("?status=approved&month=10&year=2026");
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
    mount("?status=approved&month=all");
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

  // ───────────────────── 2026-11-26: names, the earned limit, delete only while pending ─────────────────────

  it("says Salary Advance and Term Loan: the tabs, the badges and the New button", () => {
    mount("?tab=advance");
    expect(text(q("settlement-tab-advance"))).toContain("Salary Advance");
    expect(text(q("new-advance"))).toBe("New Salary Advance");
    expect(text(q("advance-row-1"))).toContain("Salary Advance");
    expect(document.body.textContent).not.toMatch(/term advance/i);
    click(q("settlement-tab-loan"));
    expect(text(q("new-advance"))).toBe("New Term Loan");
  });

  /** Opens New on the tab and picks the employee from the search list. */
  async function openNewFor(tab: "advance" | "loan", code: string) {
    mount(`?tab=${tab}`);
    click(q("new-advance"));
    expect(q("create-advance-dialog")).not.toBeNull();
    click(q("advance-employee"));
    const pick = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(code));
    click(pick ?? null);
    await flush();
  }

  it("New Salary Advance shows what was earned 1st-20th and the 50% limit; above it a reason is required and sent", async () => {
    await openNewFor("advance", "S7");
    expect(text(q("create-advance-title"))).toBe("New Salary Advance");
    expect(text(q("advance-earnings"))).toContain("Earned in 1st–20th November 2026");
    expect(text(q("advance-earned-fixed"))).toBe("₹26,000");
    expect(text(q("advance-earned-days"))).toBe("14.5");
    expect(text(q("advance-earned-amount"))).toBe("₹16,120");
    expect(text(q("advance-earnings"))).toContain("Working days14.5");
    expect(text(q("advance-earnings"))).toContain("Earned salary₹16,120");
    expect(text(q("advance-earnings"))).toContain("Limit (50% of earned salary)₹8,060");
    expect(text(q("advance-limit"))).toBe("₹8,060");

    type(q("advance-amount"), "8060");
    expect(q("advance-over-limit")).toBeNull(); // the limit itself is fine
    type(q("advance-amount"), "9000");
    expect(text(q("advance-over-limit"))).toContain("₹940 above the ₹8,060 Salary Advance limit");
    click(q("advance-submit"));
    await flush();
    expect(text(document.getElementById("advance-limit-remark-error"))).toBe(
      "Write why this goes over the ₹8,060 limit (at least 3 characters).",
    );
    expect(posts).toEqual([]);

    type(q("advance-limit-remark"), "Medical emergency");
    click(q("advance-submit"));
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      employeeId: 7,
      advanceType: "general",
      amount: 9000,
      limitRemark: "Medical emergency",
    });
  });

  it("a production employee has no limit: the reason is shown and nothing is above it", async () => {
    await openNewFor("advance", "P8");
    expect(text(q("advance-no-salary"))).toContain("Paid per shift");
    expect(q("advance-limit")).toBeNull();
    type(q("advance-amount"), "50000");
    expect(q("advance-over-limit")).toBeNull();
  });

  it("New Term Loan warns about the 6-month service but still lets HR record it", async () => {
    await openNewFor("loan", "S7");
    expect(text(q("create-advance-title"))).toBe("New Term Loan");
    expect(q("advance-limit")).toBeNull(); // the 50% limit is the Salary Advance's
    const warning = text(q("advance-service-warning"));
    expect(warning).toContain("Less than 6 months of service");
    expect(warning).toContain("You can apply from 15 March 2027");
    expect(warning).toContain("You can still record it.");
    type(q("advance-amount"), "12000");
    type(q("advance-months"), "6");
    click(q("advance-submit"));
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ advanceType: "term", amount: 12000, repaymentMonths: 6 });
    expect(posts[0]).not.toHaveProperty("limitRemark");
  });

  it("only a waiting advance has Delete: in the list and in the detail sheet", async () => {
    mount("?status=all&month=all");
    expect(q("advance-delete-1")).not.toBeNull();
    expect(q("advance-card-delete-1")).not.toBeNull();
    expect(q("advance-delete-3")).toBeNull(); // approved
    expect(q("advance-card-delete-3")).toBeNull();
    click(q("advance-row-3"));
    await flush();
    expect(q("advance-detail")).not.toBeNull();
    expect(q("detail-delete")).toBeNull();
  });

  it("a delete the server refuses (409 not_pending) is a toast with its words, and the list is read again", async () => {
    mount();
    click(q("advance-delete-1"));
    expect(text(q("delete-dialog"))).toContain("cannot be undone");
    refuseDelete = {
      error:
        "Only an advance still waiting for approval can be deleted. Approved, rejected and completed advances are kept.",
      code: "not_pending",
    };
    const reads = h.fetch.mock.calls.length;
    click(q("delete-confirm"));
    await flush();
    expect(deletes).toEqual([1]);
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "This advance can no longer be deleted",
        description:
          "Only an advance still waiting for approval can be deleted. Approved, rejected and completed advances are kept.",
        variant: "destructive",
      }),
    );
    expect(h.fetch.mock.calls.slice(reads).some(([url]) => url === "/api/advances")).toBe(true);
  });

  it("the detail sheet and the Approve dialog show the salary earned 1st-20th and the reason for going over", async () => {
    Object.assign(advances[0], {
      amount: 9000,
      requestedAmount: 9000,
      employeeType: "staff",
      earnings: { ...EARNINGS, workingSalary: 16120, workedOutOn: "2026-11-20" },
      limitRemark: "Medical emergency",
    });
    mount();
    click(q("advance-row-1"));
    await flush();
    const earned = text(q("advance-earned"));
    expect(earned).toContain("Earned in 1st–20th November 2026");
    expect(earned).toContain("Fixed salary₹26,000");
    expect(earned).toContain("Working days14.5");
    expect(earned).toContain("Earned salary₹16,120");
    expect(earned).toContain("Limit (50% of earned salary)₹8,060");
    expect(earned).not.toMatch(/working salary/i);
    expect(text(q("advance-limit-remark"))).toContain("Medical emergency");

    click(q("detail-approve"));
    expect(text(q("decision-earned"))).toBe(
      "Earned in 1st–20th November 2026: Fixed salary ₹26,000 · Working days 14.5 · Earned salary ₹16,120 · Limit (50% of earned salary) ₹8,060.",
    );
    expect(text(q("decision-limit-remark"))).toContain("Medical emergency");
    expect(text(q("decision-over-limit"))).toBe(
      "₹9,000 is ₹940 above the earned limit of ₹8,060. You can still approve it.",
    );
    type(q("decision-amount"), "8000");
    expect(q("decision-over-limit")).toBeNull();
  });

  // ───────────────────── 2026-11-26 (round 2): the report dialog and the bank file ─────────────────────

  const checked = (key: string) => q(`report-column-${key}`)!.getAttribute("data-state") === "checked";

  it("Export opens the report: the page's month and status, the owner's 12 columns ticked, extras not", async () => {
    window.localStorage.removeItem("uktex.settlement.reportColumns.v2");
    mount("?status=all&month=all&q=Meena");
    click(q("settlement-export"));
    expect(q("report-dialog")).not.toBeNull();
    expect(text(q("report-summary"))).toContain("1 advance · All types · All statuses · All months · 12 columns");
    expect(text(q("report-from-page"))).toContain('Search: "Meena"');
    for (const key of ["sno", "code", "employee", "type", "approved", "remarks"]) expect(checked(key)).toBe(true);
    for (const key of ["purpose", "branch", "status", "emi", "limitRemark"]) expect(checked(key)).toBe(false);

    // tick two extras: they go after the owner's 12, in the fixed order, and this browser remembers them
    click(q("report-column-status"));
    click(q("report-column-purpose"));
    expect(JSON.parse(window.localStorage.getItem("uktex.settlement.reportColumns.v2")!)).toEqual([
      "sno",
      "code",
      "employee",
      "department",
      "type",
      "fixedSalary",
      "workingDays",
      "earned",
      "requested",
      "limit",
      "approved",
      "remarks",
      "purpose",
      "status",
    ]);
    click(q("report-xlsx"));
    await flush();
    expect(h.excel).toHaveBeenCalledTimes(1);
    const table = h.excel.mock.calls[0][0].table;
    expect(table.title).toBe("Settlement - All types - All statuses - All months");
    expect(table.columns.map((c: { header: string }) => c.header).slice(-3)).toEqual(["Remarks", "Purpose", "Status"]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0][2]).toBe("Meena Iyer");
    expect(text(q("report-saved"))).toContain("Settlement_All types_All statuses_All months.xlsx");
  });

  it("the report remembers the last columns, resets to the default, and keeps at least one", async () => {
    window.localStorage.setItem("uktex.settlement.reportColumns.v2", JSON.stringify(["employee", "purpose"]));
    mount("?month=all");
    click(q("settlement-export"));
    expect(checked("purpose")).toBe(true);
    expect(checked("sno")).toBe(false);
    click(q("report-column-purpose"));
    expect(checked("employee")).toBe(true);
    expect((q("report-column-employee") as HTMLButtonElement).disabled).toBe(true); // the last one stays
    click(q("report-columns-reset"));
    expect(checked("sno")).toBe(true);
    expect(checked("purpose")).toBe(false);
    expect(text(q("report-summary"))).toContain("12 columns");
    click(q("report-pdf"));
    await flush();
    expect(h.pdf).toHaveBeenCalledTimes(1);
    expect(h.pdf.mock.calls[0][0].table.columns).toHaveLength(12);
    window.localStorage.removeItem("uktex.settlement.reportColumns.v2");
  });

  it("the report on the Term Loan tab starts on Term Loan and the page's status", () => {
    mount("?tab=loan&month=all&status=approved");
    click(q("settlement-export"));
    expect(text(q("report-summary"))).toContain("1 term loan · Term Loan · Active · All months");
    expect(text(q("report-type"))).toContain("Term Loan");
  });

  it("Export Bank File is off with a reason when the month has nothing approved", () => {
    mount(); // November: only waiting ones
    expect((q("settlement-bank-file") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q("settlement-bank-file-why"))).toBe("No approved advances in November 2026 to pay.");
  });

  it("the bank file pays the month's approved ones at the approved amount, after a confirm naming who has no bank details", async () => {
    advances[2].bankAccount = "";
    advances[2].bankIfsc = "";
    advances[0].bankAccount = "1234";
    advances[0].bankIfsc = "SBIN0001";
    mount("?month=all&status=rejected"); // the status pill does not matter
    click(q("settlement-bank-file"));
    expect(text(q("bank-file-summary"))).toContain("1 advance approved (active or completed), ₹700 in all");
    expect(text(q("bank-file-missing"))).toContain("Meena Iyer (L2): no account number, no IFSC");
    click(q("bank-file-confirm"));
    await flush();
    expect(h.bank).toHaveBeenCalledTimes(1);
    const [lines, sheet, name] = h.bank.mock.calls[0];
    expect(lines).toEqual([
      { employeeCode: "L2", employeeName: "Meena Iyer", bankAccount: "", bankIfsc: "", bankName: "", amount: 700 },
    ]);
    expect(sheet).toBe("Overview All months");
    expect(name).toBe("Settlement_Bank_File_Overview_All_months.xlsx");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Bank file downloaded" }));
  });
});
