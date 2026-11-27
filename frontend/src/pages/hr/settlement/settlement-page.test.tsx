import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { AdvanceDecisionItem } from "@/lib/api-client";
import Settlement from "../Settlement";
import type { SettlementRow } from "./logic";

// The Loan & Advance pages, Normal Method (the Settlement page renamed 2026-11-27), against a small fake server
// (customFetch is replaced): one page per address (/hr/Loan&Advance, /salary-advance, /term-loan: the sidebar chooses,
// no tab row on the page) and the month filter in the address, the remark rules of the Approve and Reject dialogs (what
// is sent, and the server's refusal shown in the dialog), the requested / approved amounts and the history in the detail
// sheet, delete only while pending, and HR's New request under the employee rules (2026-11-27): the employee's
// eligibility, what blocks a request, the body sent and the server's refusals.

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
/** The next POST's refusal ({error, code, field?}), when a test wants one; how often the eligibility was read. */
let refuseCreate: { status: number; body: Record<string, unknown> } | null = null;
let eligibilityReads = 0;
let deletes: number[] = [];
/** The next DELETE's refusal (409 not_pending), when a test wants one. */
let refuseDelete: { error: string; code: string } | null = null;
/** A test's change to an employee's eligibility (the Term Loan's limit, why it is blocked). */
let eligibilityPatch: ((e: ReturnType<typeof eligibility>) => unknown) | null = null;
/** GET /api/settlement-settings: Settings -> Loan & Advance's rules (null = this login cannot read Settings). */
let settings: Record<string, unknown> | null = null;
/** An advance's deduction schedule in its detail. */
let repaymentsOf: Record<number, unknown[]> = {};
/** Holds the next PUT until the test lets it go (to see the bulk step's progress). */
let hold: Promise<void> | null = null;

const RULES_IN_SETTINGS = {
  salaryAdvanceRules: {
    percent: 50,
    windowFromDay: 21,
    windowToDay: 22,
    earnedThroughDay: 20,
    perMonth: 1,
    rejectedAllowsReapply: true,
  },
  termLoanRules: {
    limitPercent: 100,
    allowAboveSalary: false,
    maxMonths: 6,
    minAmount: 1000,
    perYear: 1,
    minServiceMonths: 6,
    reapplyNextMonth: true,
    oneOpenAtATime: true,
  },
};

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
const RULES = [
  "Salary Advance: apply on the 21st and 22nd of each month. Term Loan: apply on any day.",
  "One Salary Advance per month.",
];
/** GET /api/advances/eligibility per employee: 7 a staff member who may apply for both, 8 a production employee of 2
 *  months (no Salary Advance, no Term Loan yet). */
const eligibility = (employeeId: number) => ({
  today: "2026-11-21",
  window: {
    isOpen: true,
    opensOn: "2026-11-21",
    closesOn: "2026-11-22",
    nextOpensOn: "2026-12-21",
    daysUntilOpen: 0,
    daysLeft: 2,
    message: "Salary Advance applications are open until 22 Nov (the 21st and 22nd of each month).",
  },
  workflowEnabled: true,
  workflowMessage: null,
  employeeActive: true,
  monthlySalary: employeeId === 8 ? null : 26000,
  salaryAdvance:
    employeeId === 8
      ? {
          canApply: false,
          reason: "You are paid per shift, so there is no monthly salary to take it from. Please speak to HR.",
          percent: 50,
          limit: null,
          deductionMonth: 11,
          deductionYear: 2026,
          deductionLabel: "November 2026",
          existing: null,
          earned: null,
        }
      : {
          canApply: true,
          reason: null,
          percent: 50,
          limit: 8060,
          deductionMonth: 11,
          deductionYear: 2026,
          deductionLabel: "November 2026",
          existing: null,
          earned: { ...EARNINGS, presentShifts: 12.5, holidayDays: 2, workingDays: 14.5, final: true },
        },
  termLoan: {
    canApply: employeeId !== 8,
    reason:
      employeeId === 8
        ? "A Term Loan needs 6 months of service. You can apply from 15 March 2027 (2/6 months of service)."
        : null,
    minMonths: 1,
    maxMonths: 12,
    minAmount: 1000,
    maxAmount: 9999999,
    firstDeductionMonth: 12,
    firstDeductionYear: 2026,
    firstDeductionLabel: "December 2026",
    pending: null,
    activeCount: 0,
    service:
      employeeId === 8
        ? {
            eligible: false,
            joinDate: "2026-09-15",
            serviceMonths: 2,
            requiredMonths: 6,
            eligibleFrom: "2027-03-15",
            reason: "A Term Loan needs 6 months of service. You can apply from 15 March 2027 (2/6 months of service).",
          }
        : {
            eligible: true,
            joinDate: "2025-01-10",
            serviceMonths: 22,
            requiredMonths: 6,
            eligibleFrom: "2025-07-10",
            reason: null,
          },
  },
  rules: RULES,
  approvalPath: "Employee -> HR",
  employee:
    employeeId === 8
      ? {
          id: 8,
          code: "P8",
          name: "Kumar Vel",
          department: "Stitching",
          branch: "Unit 1",
          type: "production",
          joinDate: "2026-09-15",
        }
      : {
          id: 7,
          code: "S7",
          name: "Priya Nair",
          department: "Accounts",
          branch: "Unit 1",
          type: "staff",
          joinDate: "2025-01-10",
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

function server(url: string, options?: { method?: string; body?: string }): Promise<unknown> {
  const calendar = /^\/api\/advances\/(\d+)\/leave-calendar$/.exec(url);
  if (calendar) {
    return Promise.resolve({
      employee: { code: "A1", name: "Asha Kumar" },
      month: 11,
      year: 2026,
      throughDay: 20,
      days: [{ date: "2026-11-04", kind: "on_leave", label: "On leave", weight: 1 }],
      holidays: [],
      total: 1,
      flag: "ok",
    });
  }
  if (hold && options?.method === "PUT") {
    const wait = hold;
    hold = null;
    return wait.then(() => server(url, options));
  }
  const asked = /^\/api\/advances\/eligibility\?employeeId=(\d+)/.exec(url);
  if (asked) {
    eligibilityReads += 1;
    const e = eligibility(Number(asked[1]));
    return Promise.resolve(eligibilityPatch ? eligibilityPatch(e) : e);
  }
  if (url === "/api/settlement-settings") return Promise.resolve(settings ?? []);
  if (url === "/api/advances" && options?.method === "POST") {
    const body = JSON.parse(options.body ?? "{}") as Record<string, unknown>;
    posts.push(body);
    if (refuseCreate) {
      const r = refuseCreate;
      refuseCreate = null;
      throw new ApiError(new Response(null, { status: r.status, statusText: "Refused" }), r.body, {
        method: "POST",
        url,
      });
    }
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
    return Promise.resolve({
      ...advances.find((x) => x.id === id),
      repayments: repaymentsOf[id] ?? [],
      history: history[id] ?? [],
    });
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
  refuseCreate = null;
  eligibilityReads = 0;
  deletes = [];
  refuseDelete = null;
  eligibilityPatch = null;
  settings = RULES_IN_SETTINGS;
  repaymentsOf = {};
  hold = null;
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

const OVERVIEW = "/hr/Loan&Advance";
const SALARY_ADVANCE = "/hr/Loan&Advance/salary-advance";
const TERM_LOAN = "/hr/Loan&Advance/term-loan";

function mount(search = "", path = OVERVIEW) {
  window.history.replaceState(null, "", `${path}${search}`);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(
    ["/api/advances", undefined],
    advances.map((a) => ({ ...a })),
  );
  client.setQueryData(["/api/employees", "lite", { status: "active" }], EMPLOYEES);
  client.setQueryData(["/api/payroll-settings"], { companyName: "UK Textiles" });
  // Settings -> Loan & Advance: the Normal Method (the pages these tests are about; settlement-automation.test.tsx has the other)
  client.setQueryData(["/api/settlement-automation/method"], { method: "normal" });
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

describe("the Loan & Advance pages (Normal Method)", () => {
  it("the Overview lists both kinds waiting, under its own name, with no tab row (the sidebar chooses the page)", () => {
    mount();
    expect(window.location.pathname).toBe("/hr/Loan&Advance");
    expect(text(q("loan-advance-title"))).toBe("Loan & Advance");
    expect(rowIds()).toEqual(["advance-row-2", "advance-row-1"]); // newest first, pending only
    expect(text(q("count-pending-value"))).toBe("2");
    expect(q("filter-type")).not.toBeNull(); // only the Overview has both types to choose from
    expect(q("settlement-tabs")).toBeNull();
    // the page's one row of pills is the status filter above the list (kept as it was): no row for the type
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(text(document.querySelector('[role="tablist"]'))).toContain("Pending approval");
    expect(document.body.textContent).not.toMatch(/\bSettlement\b/);
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

  it("/term-loan lists only the Term Loans and /salary-advance only the Salary Advances, each under its breadcrumb", () => {
    mount("?status=all&month=all", TERM_LOAN);
    expect(rowIds()).toEqual(["advance-row-2", "advance-row-3"]); // newest first
    expect(q("filter-type")).toBeNull();
    expect(text(q("stat-active"))).toContain("active term loans");
    expect(text(q("loan-advance-title"))).toBe("Term Loan");
    const crumbs = [...q("loan-advance-breadcrumb")!.querySelectorAll("li")].map(text).filter(Boolean);
    expect(crumbs).toEqual(["Loan & Advance", "Term Loan"]);
    expect(q("loan-advance-breadcrumb")!.querySelector("a")!.getAttribute("href")).toBe("/hr/Loan&Advance");
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1); // the status pills only
    act(() => root!.unmount());
    host!.remove();
    mount("?status=all&month=all", SALARY_ADVANCE);
    expect(rowIds()).toEqual(["advance-row-1"]);
    expect(text(q("loan-advance-title"))).toBe("Salary Advance");
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
  });

  it("an address written another way is sent to the page's own, with its query", async () => {
    mount("?status=all", "/hr/loan&advance/TERM-LOAN/");
    await flush();
    expect(window.location.pathname).toBe("/hr/Loan&Advance/term-loan");
    expect(window.location.search).toBe("?status=all");
    expect(text(q("loan-advance-title"))).toBe("Term Loan");
    act(() => root!.unmount());
    host!.remove();
    mount("?month=all", "/hr/Loan&Advance/nonsense");
    await flush();
    expect(window.location.pathname).toBe("/hr/Loan&Advance");
    expect(window.location.search).toBe("?month=all");
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

  it("says Salary Advance and Term Loan, and every page has New request", () => {
    mount();
    expect(text(q("advance-row-1"))).toContain("Salary Advance"); // the Overview's Type column
    expect(document.body.textContent).not.toMatch(/term advance/i);
    act(() => root!.unmount());
    host!.remove();
    mount("", SALARY_ADVANCE);
    expect(text(q("new-advance"))).toBe("New request");
    expect(document.querySelector('[data-testid="advances-table"] th')?.parentElement?.textContent).not.toContain(
      "Type",
    ); // one type per page: no Type column
    act(() => root!.unmount());
    host!.remove();
    mount("", TERM_LOAN);
    expect(text(q("new-advance"))).toBe("New request");
  });

  /** Opens New request on a page and picks the employee from the search list. */
  async function openNewFor(path: string, code: string) {
    mount("", path);
    click(q("new-advance"));
    expect(q("new-request-dialog")).not.toBeNull();
    click(q("new-request-employee-select"));
    const pick = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(code));
    click(pick ?? null);
    await flush();
  }
  const submit = () => q("new-request-submit") as HTMLButtonElement;

  it("New request on Salary Advance: the employee's eligibility, the earned figures and the limit, then the body sent", async () => {
    await openNewFor(SALARY_ADVANCE, "S7");
    expect(text(q("new-request-title"))).toBe("New Salary Advance request");
    expect(q("new-request-type-general")).toBeNull(); // the page's type is fixed
    expect(eligibilityReads).toBe(1);
    expect(text(q("new-request-employee"))).toContain("S7 · Priya Nair");
    expect(text(q("new-request-employee"))).toContain("Staff");
    expect(text(q("new-request-window"))).toContain("Window open");
    expect(text(q("new-request-earned-fixed"))).toBe("₹26,000");
    expect(text(q("new-request-earned-days"))).toBe("14.5 (12.5 worked + 2 holidays)");
    expect(text(q("new-request-earned-amount"))).toBe("₹16,120");
    expect(text(q("new-request-limit"))).toBe("₹8,060");
    expect(text(q("new-request-rules"))).toContain("One Salary Advance per month.");
    expect(q("new-request-blocked")).toBeNull();

    // above the limit is blocked as it is typed, and never sent
    type(q("new-request-amount"), "9000");
    expect(text(document.getElementById("new-request-amount-error"))).toBe(
      "The most that can be asked for is ₹8,060 (50% of the ₹16,120 earned from the 1st to the 20th).",
    );
    type(q("new-request-purpose"), "Medical");
    click(submit());
    await flush();
    expect(posts).toEqual([]);

    type(q("new-request-amount"), "8060");
    expect(document.getElementById("new-request-amount-error")).toBeNull();
    expect(text(q("new-request-schedule"))).toContain("Deducted once, in full, from the November 2026 salary.");
    click(submit());
    await flush();
    expect(posts).toEqual([{ employeeId: 7, advanceType: "general", amount: 8060, purpose: "Medical" }]);
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Salary Advance request raised",
        description: "Priya Nair: ₹8,060. It is waiting for approval.",
      }),
    );
    expect(q("new-request-dialog")).toBeNull();
  });

  it("asks for the purpose and whole rupees before anything is sent", async () => {
    await openNewFor(SALARY_ADVANCE, "S7");
    type(q("new-request-amount"), "500.5");
    click(submit());
    await flush();
    expect(text(document.getElementById("new-request-amount-error"))).toBe(
      "Enter the amount in whole rupees (no paise).",
    );
    expect(text(document.getElementById("new-request-purpose-error"))).toBe(
      "Write briefly what the money is for (at least 3 characters).",
    );
    expect(posts).toEqual([]);
  });

  it("a type the employee cannot apply for now cannot be sent, and says why in the employee app's words", async () => {
    await openNewFor(SALARY_ADVANCE, "P8");
    expect(text(q("new-request-blocked"))).toContain("You are paid per shift");
    expect(text(q("new-request-no-earned"))).toContain("No earned-salary figures");
    expect((q("new-request-amount") as HTMLInputElement).disabled).toBe(true);
    expect((q("new-request-purpose") as HTMLTextAreaElement).disabled).toBe(true);
    expect(submit().disabled).toBe(true);
    act(() => root!.unmount());
    host!.remove();
    await openNewFor(TERM_LOAN, "P8");
    expect(text(q("new-request-service"))).toContain("Less than 6 months of service");
    expect(text(q("new-request-blocked"))).toContain("You can apply from 15 March 2027");
    expect(submit().disabled).toBe(true);
  });

  it("New request on Term Loan: the service check, 1-12 months, the EMI preview and the body sent", async () => {
    await openNewFor(TERM_LOAN, "S7");
    expect(text(q("new-request-title"))).toBe("New Term Loan request");
    expect(text(q("new-request-service"))).toContain("22 months of service (6 needed)");
    expect(q("new-request-limit")).toBeNull(); // the 50% limit is the Salary Advance's
    type(q("new-request-amount"), "500");
    type(q("new-request-months"), "13");
    type(q("new-request-purpose"), "House repair");
    click(submit());
    await flush();
    expect(text(document.getElementById("new-request-amount-error"))).toBe("A Term Loan starts from ₹1,000.");
    expect(text(document.getElementById("new-request-months-error"))).toBe("A Term Loan is repaid in 1 to 12 months.");
    expect(posts).toEqual([]);
    type(q("new-request-amount"), "10000");
    type(q("new-request-months"), "3");
    expect(text(q("new-request-schedule"))).toContain(
      "3 deductions of ₹3,334 from Dec 2026 to Feb 2027 (the last ₹3,332)",
    );
    click(submit());
    await flush();
    expect(posts).toEqual([
      { employeeId: 7, advanceType: "term", amount: 10000, purpose: "House repair", repaymentMonths: 3 },
    ]);
  });

  it("on the Overview HR picks the type: both show whether the employee may apply now", async () => {
    await openNewFor(OVERVIEW, "S7");
    expect(text(q("new-request-title"))).toBe("New request");
    expect(q("new-request-type-general")!.getAttribute("aria-checked")).toBe("true");
    expect(text(q("new-request-type-term"))).toContain("Can apply now");
    click(q("new-request-type-term"));
    expect(q("new-request-type-term")!.getAttribute("aria-checked")).toBe("true");
    expect(q("new-request-months")).not.toBeNull();
    type(q("new-request-amount"), "12000");
    type(q("new-request-months"), "6");
    type(q("new-request-purpose"), "Wedding");
    click(submit());
    await flush();
    expect(posts).toEqual([
      { employeeId: 7, advanceType: "term", amount: 12000, purpose: "Wedding", repaymentMonths: 6 },
    ]);
  });

  it("shows the server's refusal with its rule, reads the eligibility again, and puts a field's error beside it", async () => {
    await openNewFor(SALARY_ADVANCE, "S7");
    type(q("new-request-amount"), "5000");
    type(q("new-request-purpose"), "School fees");
    refuseCreate = {
      status: 400,
      body: {
        error: "A Salary Advance can be applied for only on the 21st and 22nd of each month.",
        code: "window_closed",
      },
    };
    click(submit());
    await flush();
    expect(text(q("new-request-server-error"))).toBe(
      "Outside the Salary Advance windowA Salary Advance can be applied for only on the 21st and 22nd of each month.",
    );
    expect(q("new-request-server-error")!.getAttribute("data-code")).toBe("window_closed");
    expect(eligibilityReads).toBe(2); // read again: the window has moved on
    expect(q("new-request-dialog")).not.toBeNull();

    refuseCreate = {
      status: 400,
      body: { error: "Keep the purpose under 300 characters.", code: "invalid", field: "purpose" },
    };
    click(submit());
    await flush();
    expect(text(document.getElementById("new-request-purpose-error"))).toBe("Keep the purpose under 300 characters.");
    expect(q("new-request-server-error")).toBeNull();
    expect(h.toast).not.toHaveBeenCalled();
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
    expect(table.title).toBe("Loan & Advance – All types – All statuses – All months");
    expect(table.columns.map((c: { header: string }) => c.header).slice(-3)).toEqual(["Remarks", "Purpose", "Status"]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0][2]).toBe("Meena Iyer");
    expect(text(q("report-saved"))).toContain("Loan_Advance_All types_All statuses_All months.xlsx");
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

  it("the report on the Term Loan page starts on Term Loan and the page's status", () => {
    mount("?month=all&status=approved", TERM_LOAN);
    click(q("settlement-export"));
    expect(text(q("report-summary"))).toContain("1 term loan · Term Loan · Active · All months");
    expect(text(q("report-type"))).toContain("Term Loan");
  });

  // ───────────────────── 2026-11-27: the rules from Settings, the Term Loan's own figures and report ─────────────────────

  it("each page's line says the rules Settings has, and none without them", async () => {
    mount("", SALARY_ADVANCE);
    await flush();
    expect(text(q("loan-advance-description"))).toContain(
      "up to 50% of the salary earned from the 1st to the 20th; employees apply on the 21st and 22nd of each month",
    );
    act(() => root!.unmount());
    host!.remove();
    settings = {
      ...RULES_IN_SETTINGS,
      salaryAdvanceRules: {
        ...RULES_IN_SETTINGS.salaryAdvanceRules,
        percent: 40,
        earnedThroughDay: 18,
        windowFromDay: 19,
        windowToDay: 19,
      },
    };
    mount("", SALARY_ADVANCE);
    await flush();
    expect(text(q("loan-advance-description"))).toContain(
      "up to 40% of the salary earned from the 1st to the 18th; employees apply on the 19th of each month",
    );
    act(() => root!.unmount());
    host!.remove();
    mount("", TERM_LOAN);
    await flush();
    expect(text(q("loan-advance-description"))).toContain(
      "up to 100% of the fixed monthly salary, repaid in 1 to 6 monthly EMIs from ₹1,000, after 6 months of service; staff only",
    );
    act(() => root!.unmount());
    host!.remove();
    settings = null;
    mount();
    await flush();
    expect(text(q("loan-advance-description"))).not.toMatch(/\d+%|\d+(st|nd|rd|th)\b/);
  });

  it("approving a Term Loan: its salary and limit, months 1 to Settings' most, the EMI and schedule, months sent", async () => {
    Object.assign(advances[1], { salaryAtRequest: 26000, termLimit: 5000, employeeType: "staff" });
    mount();
    await flush();
    click(q("advance-approve-2"));
    await flush();
    expect(text(q("decision-term-figures"))).toBe(
      "Fixed monthly salary ₹26,000 · Eligible limit ₹5,000 · Asked over 3 months.",
    );
    // the ₹6,000 asked for is above the ₹5,000 limit
    expect(text(q("decision-problem"))).toBe("You can approve at most the ₹5,000 eligible limit.");
    expect(text(q("decision-requested"))).toBe("Asked for ₹6,000; no more than that or the ₹5,000 limit.");
    expect((q("decision-months") as HTMLInputElement).value).toBe("3");
    expect(text(q("decision-months-hint"))).toBe("1 to 6 months");
    type(q("decision-amount"), "4800");
    type(q("decision-months"), "7");
    expect(text(q("decision-problem"))).toBe("A Term Loan is repaid in 1 to 6 months.");
    expect((q("decision-confirm") as HTMLButtonElement).disabled).toBe(true);
    type(q("decision-months"), "4");
    expect(q("decision-problem")).toBeNull();
    expect(text(q("decision-emi"))).toBe("₹1,200 a month for 4 months");
    expect(text(q("decision-schedule"))).toContain("4 deductions of ₹1,200 from Dec 2026 to Mar 2027");
    type(q("decision-remark"), "Within the limit");
    click(q("decision-confirm"));
    await flush();
    expect(puts).toEqual([
      [2, { status: "approved", amount: 4800, repaymentMonths: 4, decisionRemark: "Within the limit" }],
    ]);
  });

  it("the detail sheet of a Term Loan: salary, limit, requested, approved, months, EMI, deducted and outstanding", async () => {
    Object.assign(advances[2], { salaryAtRequest: 26000, termLimit: 26000, employeeType: "staff" });
    repaymentsOf[3] = [
      { id: 1, advanceId: 3, month: 12, year: 2026, amount: 350, paymentMethod: "payroll", isProcessed: true },
      { id: 2, advanceId: 3, month: 1, year: 2027, amount: 350, paymentMethod: "payroll", isProcessed: false },
    ];
    mount("?status=approved&month=all");
    click(q("advance-row-3"));
    await flush();
    const figures = text(q("advance-term-figures"));
    for (const line of [
      "Fixed monthly salary₹26,000",
      "Eligible loan limit₹26,000",
      "Requested amount₹1,000",
      "Approved amount₹700",
      "Repayment period2 months",
      "Monthly EMI₹350",
      "EMIs deducted1 of 2",
      "Remaining outstanding₹700",
    ])
      expect(figures).toContain(line);
    expect(q("advance-earned")).toBeNull(); // the earned figures are the Salary Advance's
  });

  it("New request on Term Loan: the salary, the limit and the year's allowance; above the limit is refused", async () => {
    eligibilityPatch = (e) => ({
      ...e,
      termLoan: {
        ...e.termLoan,
        maxMonths: 6,
        limit: 26000,
        limitPercent: 100,
        monthlySalary: 26000,
        approvedThisYear: 0,
        perYear: 1,
        code: null,
      },
    });
    await openNewFor(TERM_LOAN, "S7");
    expect(text(q("new-request-term-salary"))).toContain("₹26,000");
    expect(text(q("new-request-term-limit"))).toBe("₹26,000");
    expect(text(q("new-request-term-figures"))).toContain("Eligible limit (100% of the salary)₹26,000");
    expect(text(q("new-request-term-year"))).toContain("0 of 1");
    expect((q("new-request-amount") as HTMLInputElement).placeholder).toBe("₹1,000 to ₹26,000");
    expect((q("new-request-months") as HTMLInputElement).placeholder).toBe("1 to 6");
    type(q("new-request-amount"), "30000");
    type(q("new-request-months"), "7");
    type(q("new-request-purpose"), "House repair");
    click(submit());
    await flush();
    expect(text(document.getElementById("new-request-amount-error"))).toBe(
      "The most is ₹26,000 (100% of the ₹26,000 fixed monthly salary).",
    );
    expect(text(document.getElementById("new-request-months-error"))).toBe("A Term Loan is repaid in 1 to 6 months.");
    expect(posts).toEqual([]);
  });

  it("New request on Term Loan, blocked: the open loan, the year's allowance used and when the employee may apply again", async () => {
    eligibilityPatch = (e) => ({
      ...e,
      termLoan: {
        ...e.termLoan,
        canApply: false,
        reason: "One Term Loan is approved per calendar year. You can apply again from 1 January 2027.",
        code: "yearly",
        limit: 26000,
        limitPercent: 100,
        monthlySalary: 26000,
        approvedThisYear: 1,
        perYear: 1,
        open: { id: 9, status: "approved", amount: 12000 },
        nextEligibleOn: "2027-01-01",
      },
    });
    await openNewFor(TERM_LOAN, "S7");
    expect(text(q("new-request-blocked"))).toContain("One Term Loan is approved per calendar year");
    expect(text(q("new-request-term-year"))).toContain("1 of 1");
    expect(text(q("new-request-term-open"))).toBe("Being repaid: a Term Loan of ₹12,000.");
    expect(text(q("new-request-next"))).toBe("Can apply again from 1 Jan 2027.");
    expect(submit().disabled).toBe(true);
    act(() => root!.unmount());
    host!.remove();
    // a production employee: Term Loans are for staff only
    eligibilityPatch = (e) =>
      e.employee.id === 8
        ? {
            ...e,
            termLoan: {
              ...e.termLoan,
              canApply: false,
              reason: "Term Loans are for staff employees only.",
              code: "staff_only",
            },
          }
        : e;
    await openNewFor(TERM_LOAN, "P8");
    expect(text(q("new-request-staff-only"))).toBe("Term Loans are for staff employees only.");
    expect(submit().disabled).toBe(true);
  });

  it("the Term Loan page's report: its own 16 columns, remembered apart from the Salary Advance report", async () => {
    window.localStorage.removeItem("uktex.settlement.termReportColumns.v1");
    window.localStorage.removeItem("uktex.settlement.reportColumns.v2");
    mount("?month=all&status=approved", TERM_LOAN);
    click(q("settlement-export"));
    expect(text(q("report-summary"))).toContain("16 columns");
    for (const key of ["termLimit", "months", "emi", "firstEmi", "lastEmi", "repaid", "outstanding", "status"])
      expect(checked(key)).toBe(true);
    for (const key of ["earned", "workingDays", "type"]) expect(q(`report-column-${key}`)).toBeNull();
    expect(checked("purpose")).toBe(false);
    click(q("report-column-purpose"));
    expect(JSON.parse(window.localStorage.getItem("uktex.settlement.termReportColumns.v1")!)).toContain("purpose");
    expect(window.localStorage.getItem("uktex.settlement.reportColumns.v2")).toBeNull();
    click(q("report-xlsx"));
    await flush();
    const table = h.excel.mock.calls[0][0].table;
    expect(table.columns.map((c: { header: string }) => c.header)).toContain("Eligible Limit");
    expect(table.columns).toHaveLength(17);
    expect(table.summary.map((c: { label: string }) => c.label)).toEqual([
      "Total Employees",
      "Total Requested",
      "Total Approved",
      "Total Monthly EMI",
      "Total Outstanding",
    ]);
    window.localStorage.removeItem("uktex.settlement.termReportColumns.v1");
  });

  // ───────────────────── 2026-11-27, round 5: the list's columns, several at once, the leave calendar ─────────────

  it("the list: every value under its own heading, the eligible limit of each type", () => {
    Object.assign(advances[0], { employeeType: "staff", earnings: { ...EARNINGS } });
    Object.assign(advances[1], { termLimit: 26000 });
    mount();
    const heads = [...q("advances-table")!.querySelectorAll("th")].map((th) => text(th));
    expect(heads).toEqual([
      "",
      "Employee",
      "Type",
      "Requested",
      "Eligible limit",
      "Approved",
      "Recovered",
      "Deduction from",
      "Leave",
      "Status",
      "Remarks",
      "Raised",
      "Actions",
    ]);
    const row1 = text(q("advance-row-1"));
    expect(row1).toContain("₹8,06050% of ₹16,120 earned"); // a Salary Advance: the earned limit
    expect(text(q("advance-row-2"))).toContain("₹26,0003 months · ₹2,000/month"); // a Term Loan: its limit, months, EMI
    expect(row1).toContain("Purpose: Medical");
  });

  it("bulk approve: Select all the waiting ones, one PUT each in turn with the progress, then a summary", async () => {
    mount();
    expect(text(q("advance-bulk-count"))).toBe("2 can be selected");
    click(q("advance-bulk-all"));
    expect(text(q("advance-bulk-count"))).toBe("2 of 2 selected");
    click(q("advance-bulk-approve"));
    expect(text(q("advance-bulk-list"))).toContain("Ravi Shankar (L1) · Term Loan · ₹6,000");
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    click(q("advance-bulk-dialog-confirm"));
    await flush();
    expect(text(q("advance-bulk-dialog-progress"))).toBe("Approving 1 of 2: Ravi Shankar…");
    expect(puts).toEqual([]);
    release();
    await flush();
    expect(puts).toEqual([
      [2, { status: "approved" }],
      [1, { status: "approved" }],
    ]);
    expect(text(q("advance-bulk-result"))).toBe("2 approved.");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 of 2 approved" }));
    expect(q("advance-bulk-dialog")).toBeNull();
  });

  it("bulk reject asks one reason; one the server refuses is left as it is and listed", async () => {
    mount();
    click(q("advance-select-1"));
    click(q("advance-select-2"));
    expect(text(q("advance-bulk-count"))).toBe("2 of 2 selected");
    click(q("advance-bulk-reject"));
    click(q("advance-bulk-dialog-confirm"));
    await flush();
    expect(text(q("advance-bulk-dialog-problem"))).toBe("Write the reason for rejecting (at least 3 characters).");
    expect(puts).toEqual([]);
    type(q("advance-bulk-dialog-remark"), "Budget closed this month");
    refuseNext = { error: "This advance was decided by someone else.", code: "invalid" };
    click(q("advance-bulk-dialog-confirm"));
    await flush();
    expect(puts).toEqual([
      [2, { status: "rejected", decisionRemark: "Budget closed this month" }],
      [1, { status: "rejected", decisionRemark: "Budget closed this month" }],
    ]);
    expect(text(q("advance-bulk-result"))).toBe(
      "1 rejected; 1 could not be: Ravi Shankar (This advance was decided by someone else.)",
    );
  });

  it("only a waiting request can be ticked", () => {
    mount("?status=all&month=all");
    expect(q("advance-select-1")).not.toBeNull();
    expect(q("advance-select-3")).toBeNull(); // approved
    expect(text(q("advance-bulk-count"))).toBe("2 can be selected");
  });

  it("the Leave column opens the request's leave calendar without opening the request", async () => {
    mount();
    click(q("advance-leave-1"));
    await flush();
    expect(h.fetch).toHaveBeenCalledWith("/api/advances/1/leave-calendar");
    expect(text(q("leave-calendar-dialog"))).toContain("Asha Kumar: leave calendar");
    expect(q("leave-calendar-2026-11-04")?.getAttribute("data-kind")).toBe("on_leave");
    expect(q("advance-detail")).toBeNull();
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
    expect(name).toBe("Loan_Advance_Bank_File_Overview_All_months.xlsx");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Bank file downloaded" }));
  });
});
