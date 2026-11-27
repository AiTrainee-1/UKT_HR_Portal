import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type {
  SettlementBatch,
  SettlementMonth,
  SettlementOverview,
} from "@/lib/api-client/custom-hooks/settlement-automation";
import Settlement from "../../Settlement";
import type { SettlementRow } from "../logic";
import { actionsFor, batchAt, item, monthOf, overviewOf, overviewType, trackerFor, withAuditor } from "./test-fixtures";

// The Loan & Advance pages (the Settlement page renamed 2026-11-27) with Settings -> Loan & Advance's two methods (owner
// 2026-11-26), against a small fake server: the method decides the pages; the Normal Method's list shows the leave
// check; with the Automation Method the Overview shows both types' workflows side by side and each type's page is its
// own workflow (?type=general|term): the tracker, the stage card and buttons at every stage (from the batch's `actions`,
// only for a login that may move the workflow), what each step sends, and a refused e-mail that does not move the batch
// on. The files themselves are tested in logic.test.ts (rows and columns) and export.test.ts / lib/bankFile.test.ts (the
// writers): here they are stand-ins.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: null as unknown,
  auditorFiles: vi.fn(),
  bankFile: vi.fn(),
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ user: h.user }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("./files", () => ({
  buildAuditorFiles: h.auditorFiles,
  buildBatchBankFile: h.bankFile,
  saveFile: vi.fn(),
}));
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

const refusal = (status: number, data: unknown, url = "/api/settlement-automation") =>
  new ApiError(new Response(null, { status, statusText: "Refused" }), data, { method: "POST", url });

/** The fake server's state. */
let method: "normal" | "automation" = "automation";
let month: SettlementMonth = monthOf([batchAt("hr_review")]);
let monthReads = 0;
/** Every month / overview address read. */
let reads: string[] = [];
let overview: SettlementOverview = overviewOf([]);
let advances: SettlementRow[] = [];
/** Every write: [method, url, body]. */
let writes: [string, string, unknown][] = [];
/** The answer of the next write (a batch), or the refusal it throws. */
let nextWrite: SettlementBatch | ApiError | null = null;
/** The answers of the writes after it, in order (a step that writes twice: resubmit, then send). */
let laterWrites: (SettlementBatch | ApiError)[] = [];

/** GET /api/advances/<id>/leave-calendar (2026-11-27): Meena's 5 days, one of them the 3rd. */
const leaveCalendar = (advanceId: number) => ({
  employee: { code: `S${advanceId}`, name: advanceId === 103 ? "Meena Iyer" : "Someone" },
  month: 11,
  year: 2026,
  throughDay: 20,
  days: [{ date: "2026-11-03", kind: "absent", label: "Absent", weight: 1 }],
  holidays: [],
  total: 5,
  flag: "critical",
});

function server(url: string, options?: { method?: string; body?: unknown }) {
  const verb = options?.method ?? "GET";
  const calendar = /^\/api\/advances\/(\d+)\/leave-calendar$/.exec(url);
  if (calendar) return Promise.resolve(leaveCalendar(Number(calendar[1])));
  if (url === "/api/settlement-automation/method") return Promise.resolve({ method });
  if (url.startsWith("/api/settlement-automation/month")) {
    monthReads += 1;
    reads.push(url);
    return Promise.resolve(JSON.parse(JSON.stringify(month)) as SettlementMonth);
  }
  if (url.startsWith("/api/settlement-automation/overview")) {
    reads.push(url);
    return Promise.resolve(JSON.parse(JSON.stringify(overview)) as SettlementOverview);
  }
  if (url.startsWith("/api/advances/eligibility")) return Promise.resolve(ELIGIBILITY);
  if (url === "/api/settlement-settings") return Promise.resolve(SETTLEMENT_SETTINGS);
  if (url === "/api/advances" && verb === "POST") {
    const body = JSON.parse(String(options?.body ?? "{}"));
    writes.push([verb, url, body]);
    return Promise.resolve({ ...body, id: 500, status: "pending", createdAt: "2026-11-26T05:00:00Z" });
  }
  if (url.startsWith("/api/employees")) return Promise.resolve(EMPLOYEES);
  if (url.startsWith("/api/settlement-automation/") && verb !== "GET") {
    const body = options?.body instanceof FormData ? options.body : JSON.parse(String(options?.body ?? "{}"));
    writes.push([verb, url, body]);
    const answer = nextWrite ?? laterWrites.shift() ?? null;
    nextWrite = null;
    if (answer instanceof ApiError) return Promise.reject(answer);
    const batch = answer ?? month.batches[0];
    month = { ...month, batches: month.batches.map((b) => (b.id === batch.id ? batch : b)), tracker: batch.tracker };
    return Promise.resolve(JSON.parse(JSON.stringify(batch)) as SettlementBatch);
  }
  const one = /^\/api\/advances\/(\d+)$/.exec(url);
  if (one) {
    const found = advances.find((a) => a.id === Number(one[1]));
    return Promise.resolve({ ...found, repayments: [], history: [] });
  }
  if (url.startsWith("/api/advances")) return Promise.resolve(advances.map((a) => ({ ...a })));
  if (url.startsWith("/api/payroll-settings")) return Promise.resolve({ companyName: "UK Textiles" });
  return Promise.resolve([]);
}

let root: Root | null = null;
let host: HTMLElement | null = null;

const EMPLOYEES = [{ id: 7, employeeCode: "S7", firstName: "Priya", lastName: "Nair", status: "active" }];
/** Settings -> Loan & Advance: the rules in force (a Term Loan is repaid in 1 to 6 months). */
const SETTLEMENT_SETTINGS = {
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
/** The New request dialog's employee: may apply for both types. */
const ELIGIBILITY = {
  today: "2026-11-26",
  window: { isOpen: false, message: "Salary Advance applications open on 21 Dec and close on 22 Dec." },
  workflowEnabled: true,
  workflowMessage: null,
  employeeActive: true,
  monthlySalary: 26000,
  salaryAdvance: {
    canApply: false,
    reason: "A Salary Advance can be applied for only on the 21st and 22nd of each month.",
    percent: 50,
    limit: null,
    deductionMonth: 12,
    deductionYear: 2026,
    deductionLabel: "December 2026",
    existing: null,
    earned: null,
  },
  termLoan: {
    canApply: true,
    reason: null,
    minMonths: 1,
    maxMonths: 12,
    minAmount: 1000,
    maxAmount: 9999999,
    firstDeductionMonth: 12,
    firstDeductionYear: 2026,
    firstDeductionLabel: "December 2026",
    pending: null,
    activeCount: 0,
    service: {
      eligible: true,
      joinDate: "2024-01-10",
      serviceMonths: 34,
      requiredMonths: 6,
      eligibleFrom: "2024-07-10",
      reason: null,
    },
  },
  rules: [],
  employee: {
    id: 7,
    code: "S7",
    name: "Priya Nair",
    department: "Accounts",
    branch: "Unit 1",
    type: "staff",
    joinDate: "2024-01-10",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-26T10:00:00") });
  method = "automation";
  month = monthOf([batchAt("hr_review")]);
  monthReads = 0;
  reads = [];
  overview = overviewOf([overviewType("general", [batchAt("hr_final")]), overviewType("term", [])]);
  advances = [];
  writes = [];
  nextWrite = null;
  laterWrites = [];
  h.user = null;
  h.fetch.mockImplementation(server);
  h.auditorFiles.mockResolvedValue({
    pdf: new File(["%PDF"], "Settlement_November_2026_Batch_1_Final.pdf", { type: "application/pdf" }),
    xlsx: new File(["xlsx"], "Settlement_November_2026_Batch_1_Final.xlsx"),
  });
  h.bankFile.mockResolvedValue(new File(["xlsx"], "Settlement_Bank_File_November_2026_Batch_1.xlsx"));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const OVERVIEW = "/hr/Loan&Advance";
const SALARY_ADVANCE = "/hr/Loan&Advance/salary-advance";
const TERM_LOAN = "/hr/Loan&Advance/term-loan";

/** The workflow's tests run on the Salary Advance page (each type's page is its own workflow). */
async function mount(path = SALARY_ADVANCE) {
  window.history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(Settlement))));
  await flush();
  return host;
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
async function click(el: Element | null) {
  expect(el, "element to click").not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}
async function type(el: Element | null, value: string) {
  expect(el, "field to type in").not.toBeNull();
  await act(async () => {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const atStage = (b: SettlementBatch) => {
  month = monthOf([b]);
};

/** Opens one of the page's top tabs (Workflow, Requests, Summary, Files sent, History) by its label. */
async function openTab(label: string) {
  const bar = q("auto-tabs");
  expect(bar, "the row of tabs").not.toBeNull();
  const tab = [...bar!.querySelectorAll("button")].find((b) => text(b).startsWith(label)) ?? null;
  await click(tab);
}

describe("Settings -> Loan & Advance decides the pages", () => {
  it("shows the Normal Method's pages when the Normal Method is on", async () => {
    method = "normal";
    for (const [path, page] of [
      [OVERVIEW, "overview"],
      [SALARY_ADVANCE, "general"],
      [TERM_LOAN, "term"],
    ]) {
      await mount(path);
      expect(q("settlement-normal")?.getAttribute("data-page"), path).toBe(page);
      expect(q("settlement-export")).not.toBeNull();
      expect(q("settlement-automation")).toBeNull();
      expect(q("settlement-automation-overview")).toBeNull();
      act(() => root!.unmount());
      host!.remove();
    }
    expect(reads).toEqual([]);
  });

  it("with the Automation Method each type's page is that type's own workflow (?type=)", async () => {
    await mount(SALARY_ADVANCE);
    expect(q("settlement-automation")?.getAttribute("data-advance-type")).toBe("general");
    expect(text(q("settlement-method-badge"))).toBe("Automation Method");
    expect(text(q("loan-advance-title"))).toBe("Salary Advance");
    expect(text(q("auto-tracker-title"))).toBe("Salary Advance · November 2026 · Batch 1");
    expect(text(q("new-advance"))).toBe("New request");
    expect(reads).toEqual(["/api/settlement-automation/month?month=11&year=2026&type=general"]);
    act(() => root!.unmount());
    host!.remove();
    reads = [];
    month = monthOf([batchAt("md_review", { advanceType: "term", id: 9 })]);
    await mount(TERM_LOAN);
    expect(q("settlement-automation")?.getAttribute("data-advance-type")).toBe("term");
    expect(text(q("loan-advance-title"))).toBe("Term Loan");
    expect(text(q("auto-tracker-title"))).toBe("Term Loan · November 2026 · Batch 1");
    expect(reads).toEqual(["/api/settlement-automation/month?month=11&year=2026&type=term"]);
  });

  it("shows neither page until the method is known", async () => {
    h.fetch.mockImplementation((url: string, options?: { method?: string; body?: unknown }) =>
      url === "/api/settlement-automation/method" ? new Promise(() => {}) : server(url, options),
    );
    await mount();
    expect(q("settlement-method-loading")).not.toBeNull();
    expect(q("settlement-normal")).toBeNull();
    expect(q("settlement-automation")).toBeNull();
  });
});

describe("the Overview with the Automation Method (owner 2026-11-27): both types side by side", () => {
  it("shows one panel per type: its batch's stage, what to do next, the tracker, counts, leave flags and amounts", async () => {
    await mount(OVERVIEW);
    expect(q("settlement-automation-overview")).not.toBeNull();
    expect(text(q("loan-advance-title"))).toBe("Loan & Advance");
    expect(reads).toEqual(["/api/settlement-automation/overview?month=11&year=2026"]);
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(0); // one panel per type, no tabs
    expect(text(q("loan-advance-breadcrumb"))).toBe("Loan & Advance");

    const panel = text(q("overview-panel-general"));
    expect(panel).toContain("Salary Advance");
    expect(text(q("overview-month-general"))).toBe(
      "3 requests in November 2026 · 1 batch · 0 completed · 0 waiting for the MD",
    );
    expect(text(q("overview-stage-general"))).toBe("Batch 1 · hr_final");
    expect(text(q("overview-next-general"))).toBe("What to do next: Next action at hr_final.");
    expect(text(q("overview-tracker-general-where"))).toBe("Step 4 of 8 · HR Final Settlement");
    expect(text(q("overview-received-general-value"))).toBe("3");
    expect(text(q("overview-approved-general-value"))).toBe("2");
    expect(text(q("overview-rejected-general-value"))).toBe("1");
    expect(text(q("overview-pending-general-value"))).toBe("0");
    expect(text(q("overview-leave-general"))).toBe("Leave flags: 1 critical · 1 warning");
    expect(text(q("overview-amounts-general"))).toBe("Requested₹43,000MD approved₹33,000Final approved₹31,000");
    expect(q("overview-open-general")?.getAttribute("href")).toBe("/hr/Loan&Advance/salary-advance");

    // a type with nothing in the month yet
    expect(text(q("overview-stage-term"))).toBe("No requests yet");
    expect(text(q("overview-empty-term"))).toContain("No Term Loan request raised in November 2026");
    expect(text(q("overview-open-term"))).toBe("Open Term Loan");
    expect(q("overview-open-term")?.getAttribute("href")).toBe("/hr/Loan&Advance/term-loan");
  });

  it("counts the batches waiting for the MD and the completed ones; another month opens the type on that month", async () => {
    const done = batchAt("completed", { id: 3, number: 1 });
    const waiting = batchAt("md_review", { id: 4, number: 2, label: "Batch 2", advanceType: "term" });
    overview = overviewOf([
      overviewType("general", [done]),
      overviewType("term", [{ ...done, id: 5, advanceType: "term" }, waiting]),
    ]);
    window.history.replaceState(null, "", `${OVERVIEW}?month=10&year=2026`);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(Settlement))));
    await flush();
    expect(reads).toEqual(["/api/settlement-automation/overview?month=10&year=2026"]);
    expect(text(q("overview-stage-general"))).toBe("Batch 1 · Completed");
    expect(text(q("overview-tracker-general-where"))).toBe("All 8 steps done");
    expect(text(q("overview-month-term"))).toBe(
      "6 requests in October 2026 · 2 batches · 1 completed · 1 waiting for the MD",
    );
    expect(text(q("overview-stage-term"))).toBe("Batch 2 · md_review");
    expect(q("overview-open-term")?.getAttribute("href")).toBe("/hr/Loan&Advance/term-loan?month=10&year=2026");
  });

  it("New request on the Overview: HR picks the type, and the request joins its type's open batch", async () => {
    await mount(OVERVIEW);
    expect(text(q("new-advance"))).toBe("New request");
    await click(q("new-advance"));
    await click(q("new-request-employee-select"));
    await click([...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("S7")) ?? null);
    // outside the 21st-22nd: a Salary Advance cannot be raised, a Term Loan can
    expect(text(q("new-request-type-general"))).toContain("Cannot apply now");
    expect(text(q("new-request-blocked"))).toContain("only on the 21st and 22nd");
    expect((q("new-request-submit") as HTMLButtonElement).disabled).toBe(true);
    await click(q("new-request-type-term"));
    expect(q("new-request-blocked")).toBeNull();
    await type(q("new-request-amount"), "6000");
    await type(q("new-request-months"), "6");
    await type(q("new-request-purpose"), "Medical");
    const before = reads.length;
    await click(q("new-request-submit"));
    expect(writes).toEqual([
      [
        "POST",
        "/api/advances",
        { employeeId: 7, advanceType: "term", amount: 6000, purpose: "Medical", repaymentMonths: 6 },
      ],
    ]);
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Term Loan request raised",
        description: "Priya Nair: ₹6,000. It joins November's open Term Loan batch.",
      }),
    );
    // the overview is read again: the request is in a batch now
    expect(reads.slice(before)).toContain("/api/settlement-automation/overview?month=11&year=2026");
  });

  it("an empty month's tracker says it has not started", async () => {
    overview = overviewOf([
      overviewType("general", [], { tracker: trackerFor("hr_review") }),
      overviewType("term", []),
    ]);
    await mount(OVERVIEW);
    expect(text(q("overview-stage-general"))).toBe("No requests yet");
    expect(q("overview-tracker-general")).toBeNull(); // nothing to track yet
  });
});

describe("the leave check on the Normal Method's list", () => {
  it("marks 3 days of leave orange, more red, grey below that, in its own column and the phone cards", async () => {
    method = "normal";
    const row = (id: number, days: number, flag: "ok" | "warning" | "critical"): SettlementRow => ({
      id,
      employeeId: id,
      employeeCode: `E${id}`,
      employeeName: `Person ${id}`,
      advanceType: "general",
      amount: 1000,
      requestedAmount: 1000,
      purpose: "Medical",
      status: "pending",
      emiAmount: 0,
      totalRepaid: 0,
      outstanding: 1000,
      createdAt: "2026-11-21T05:00:00Z",
      leaveCheck: { month: 11, year: 2026, throughDay: 20, days, flag, warningAt: 3 },
    });
    advances = [
      row(1, 3, "warning"),
      row(2, 4.5, "critical"),
      row(3, 1, "ok"),
      { ...row(4, 0, "ok"), leaveCheck: null },
    ];
    await mount();
    expect(q("advance-leave-1")?.getAttribute("data-flag")).toBe("warning");
    expect(text(q("advance-leave-1"))).toBe("Leave warning: 3 days leave");
    expect(text(q("advance-leave-2"))).toBe("Leave critical: 4.5 days leave");
    // the Leave column (2026-11-27, round 5): a quiet grey chip below the warning, "Calendar" without a check
    expect(q("advance-leave-3")?.getAttribute("data-flag")).toBe("ok");
    expect(text(q("advance-leave-3"))).toBe("Leave: 1 day");
    expect(q("advance-leave-4")?.getAttribute("data-flag")).toBeNull();
    expect(text(q("advance-leave-4"))).toBe("Calendar");
    expect(q("advance-card-leave-1")?.getAttribute("data-flag")).toBe("warning");
    expect(q("advance-card-leave-2")?.getAttribute("data-flag")).toBe("critical");

    // the detail sheet spells it out
    await click(q("advance-view-2"));
    expect(q("advance-detail-leave")?.getAttribute("data-flag")).toBe("critical");
    expect(text(q("advance-leave-note"))).toContain("Critical: 4.5 days of leave (absent or on leave) in 1st-20th");
  });
});

describe("the workflow tracker", () => {
  it("ticks the done stages with when and who, highlights the current one with what to do, greys the rest", async () => {
    atStage(batchAt("hr_final"));
    await mount();
    const state = (key: string) => q(`tracker-step-${key}`)?.getAttribute("data-state");
    expect(["received", "hr_review", "md_review"].map(state)).toEqual(["done", "done", "done"]);
    expect(state("hr_final")).toBe("current");
    expect(q("tracker-step-hr_final")?.getAttribute("aria-current")).toBe("step");
    expect(["auditor_send", "auditor_review", "auditor_changes", "accounts_send", "completed"].map(state)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    // the MD's rework loop was not needed: the MD approved without a return
    expect(state("md_changes")).toBe("skipped");
    expect(text(q("tracker-detail-md_changes"))).toBe("No MD changes");
    expect(text(q("tracker-step-received"))).toContain("3 requests");
    expect(text(q("tracker-step-md_review"))).toContain("Priya HR");
    expect(text(q("tracker-step-hr_final"))).toContain("Current step: HR Final Settlement");
    expect(text(q("tracker-step-auditor_review"))).toContain("Auditor Review");
    expect(text(q("tracker-step-auditor_changes"))).toContain("HR Rework (Auditor Changes)");
    expect(text(q("tracker-next-action"))).toBe("Next: Next action at hr_final.");
    // the phone layout says the same
    expect(q("tracker-step-hr_final-row")?.getAttribute("data-state")).toBe("current");
  });

  it("greys a skipped step with why, and says what happened at the audit and at Accounts", async () => {
    atStage(
      batchAt("completed", {
        tracker: trackerFor("completed", "", { sentVia: "auditor" }),
        accounts: { sentAt: "2026-11-26T05:00:00Z", sentBy: "Auditor", recipients: [], sentVia: "auditor" },
      }),
    );
    await mount();
    expect(q("tracker-step-auditor_changes")?.getAttribute("data-state")).toBe("skipped");
    expect(text(q("tracker-step-auditor_changes"))).toContain("Skipped: HR Rework (Auditor Changes)");
    expect(text(q("tracker-detail-auditor_changes"))).toBe("No auditor changes");
    expect(text(q("tracker-detail-auditor_review"))).toBe("Approved by the auditor");
    expect(text(q("tracker-detail-accounts_send"))).toBe("Sent by the auditor");
    expect(text(q("auto-accounts-sent-via"))).toContain("sent by the auditor (from the review portal)");
  });

  it("shows the headline numbers and the leave flags of the batch", async () => {
    atStage(batchAt("hr_final"));
    await mount();
    await openTab("Summary");
    expect(text(q("auto-count-received-value"))).toBe("3");
    expect(text(q("auto-count-approved-value"))).toBe("2");
    expect(text(q("auto-count-rejected-value"))).toBe("1");
    expect(text(q("auto-amount-final-value"))).toBe("₹31,000");
    expect(text(q("auto-leave-flags"))).toContain("1 critical (more than 3 days) · 1 warning (3 days)");
    await openTab("Requests");
    expect(q("auto-leave-2")?.getAttribute("data-flag")).toBe("warning");
    expect(q("auto-leave-3")?.getAttribute("data-flag")).toBe("critical");
    expect(text(q("auto-leave-1"))).toBe("Leave: 1 day");
  });

  it("says when the month has no requests, and when some were decided outside the workflow", async () => {
    month = monthOf([], { outsideWorkflow: 2, received: 0 });
    await mount();
    expect(q("auto-empty")).not.toBeNull();
    await openTab("Requests");
    expect(q("auto-empty")).not.toBeNull();
    expect(text(q("auto-outside-note"))).toContain(
      "2 Salary Advance requests of this month were decided outside the workflow",
    );
  });
});

describe("one row of tabs at the top (owner 2026-11-27: no section stacked or nested in another)", () => {
  it("shows one section per tab, the batch as a select beside the month, and keeps the tab in the address", async () => {
    atStage(batchAt("hr_final"));
    await mount();
    const labels = [...q("auto-tabs")!.querySelectorAll("button")].map((b) => text(b));
    const expected = ["Workflow", "Requests", "Summary", "Files sent", "History"];
    expect(labels).toHaveLength(expected.length);
    labels.forEach((label, i) => expect(label.startsWith(expected[i]), label).toBe(true));
    // the Workflow tab: the tracker and the stage's own step, nothing else
    expect(q("auto-view-workflow")).not.toBeNull();
    expect(q("auto-headline")).toBeNull();
    expect(q("auto-view-requests")).toBeNull();
    // no second row of tabs: the batch is a select
    expect(q("auto-batch-select")).not.toBeNull();
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    await openTab("Summary");
    expect(q("auto-headline")).not.toBeNull();
    expect(q("auto-view-workflow")).toBeNull();
    expect(window.location.search).toContain("view=summary");
  });
});

describe("what can be done at each stage", () => {
  const present = (ids: string[]) => ids.filter((id) => q(id) !== null);

  it.each([
    ["hr_review", ["auto-forward", "auto-note-1"]],
    ["md_review", ["auto-waiting-md"]],
    ["md_changes", ["auto-resubmit-md", "auto-note-1", "auto-open-requests"]],
    ["hr_final", ["auto-finalize", "auto-final-1", "auto-md-note"]],
    ["auditor_send", ["auto-send-auditor", "auto-auditor-recipients", "auto-download-pdf", "auto-download-xlsx"]],
    [
      "auditor_review",
      ["auto-proceed", "auto-resend-auditor", "auto-download-pdf", "auto-download-xlsx", "auto-link-none"],
    ],
    ["auditor_changes", ["auto-resubmit-auditor", "auto-final-1", "auto-open-requests"]],
    ["accounts_send", ["auto-send-accounts", "auto-accounts-recipients", "auto-bank-missing", "auto-download-bank"]],
    ["completed", ["auto-completed", "auto-resend-accounts"]],
  ] as const)("%s offers its own step only", async (stage, expected) => {
    const accountsSent = stage === "completed";
    atStage(
      batchAt(
        stage,
        accountsSent
          ? { accounts: { sentAt: "2026-11-26T05:00:00Z", sentBy: "Priya HR", recipients: [], sentVia: "hr" } }
          : {},
      ),
    );
    await mount();
    const all = [
      "auto-forward",
      "auto-note-1",
      "auto-waiting-md",
      "auto-finalize",
      "auto-final-1",
      "auto-md-note",
      "auto-send-auditor",
      "auto-auditor-recipients",
      "auto-download-pdf",
      "auto-download-xlsx",
      "auto-proceed",
      "auto-resend-auditor",
      "auto-link-none",
      "auto-resubmit-md",
      "auto-resubmit-auditor",
      "auto-open-requests",
      "auto-send-accounts",
      "auto-accounts-recipients",
      "auto-bank-missing",
      "auto-download-bank",
      "auto-complete",
      "auto-completed",
      "auto-resend-accounts",
    ];
    const extra = stage === "completed" ? ["auto-download-pdf", "auto-download-xlsx", "auto-download-bank"] : [];
    expect(q("auto-stage-panel")?.getAttribute("data-stage")).toBe(stage);
    const onWorkflow = present(all);
    await openTab("Requests"); // the per-request buttons are on the Requests tab
    const onRequests = present(all);
    expect([...new Set([...onWorkflow, ...onRequests])].sort()).toEqual([...expected, ...extra].sort());
  });

  it("completes a batch with nothing approved without a bank file", async () => {
    const b = batchAt("accounts_send");
    b.items.forEach((i) => (i.final = { ...i.final, decision: "rejected", amount: null }));
    b.actions = { ...b.actions, canSendAccounts: false, canCompleteWithoutBankFile: true };
    atStage(b);
    await mount();
    expect(q("auto-send-accounts")).toBeNull();
    expect(q("auto-nothing-to-pay")).not.toBeNull();
    nextWrite = batchAt("completed");
    await click(q("auto-complete"));
    await type(q("complete-dialog-note"), "All rejected by the MD");
    await click(q("complete-dialog-confirm"));
    expect(writes).toEqual([
      ["POST", "/api/settlement-automation/batches/7/complete", { note: "All rejected by the MD" }],
    ]);
    expect(q("auto-stage-panel")?.getAttribute("data-stage")).toBe("completed");
  });

  it("shows no step to a view-only login, and says why", async () => {
    h.user = { role: "hr", isSuperAdmin: false, permissions: { settlement: "view" } };
    await mount();
    expect(q("auto-forward")).toBeNull();
    expect(q("auto-note-1")).toBeNull();
    expect(text(q("auto-view-only"))).toBe("View only: moving the workflow needs the Loan & Advance edit right.");
  });

  it("lets a branch login look but not move the workflow", async () => {
    month = { ...monthOf([batchAt("hr_review")]), branchScoped: true };
    await mount();
    expect(q("auto-branch-note")).not.toBeNull();
    expect(q("auto-forward")).toBeNull();
    expect(text(q("auto-view-only"))).toContain("A branch login can look at the workflow but not move it");
  });

  it("does not offer Finalize to a login without the approval right of a type in the batch", async () => {
    h.user = {
      role: "hr",
      isSuperAdmin: false,
      permissions: { settlement: "edit" },
      approvalMode: "explicit",
      approvals: { advance_general: true, advance_term: false },
    };
    atStage(batchAt("hr_final"));
    await mount();
    expect((q("auto-finalize") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q("auto-finalize-blocked"))).toContain("Term Loans");
  });
});

describe("the steps", () => {
  it("forwards the requests HR saw to the MD, with HR's note", async () => {
    await mount();
    nextWrite = batchAt("md_review");
    await click(q("auto-forward"));
    expect(text(q("forward-dialog"))).toContain(
      "3 requests, ₹43,000 asked for in all; leave flags: 1 critical, 1 warning",
    );
    await type(q("forward-dialog-note"), "  Two are above the limit ");
    await click(q("forward-dialog-confirm"));
    expect(writes).toEqual([
      [
        "POST",
        "/api/settlement-automation/batches/7/forward",
        { advanceIds: [101, 102, 103], note: "Two are above the limit" },
      ],
    ]);
    expect(q("forward-dialog")).toBeNull();
    expect(q("auto-stage-panel")?.getAttribute("data-stage")).toBe("md_review");
    expect(q("tracker-step-md_review")?.getAttribute("data-state")).toBe("current");
  });

  it("refetches and tells HR when the requests changed since the page was loaded", async () => {
    await mount();
    const reads = monthReads;
    nextWrite = refusal(409, { error: "The requests in this batch changed", code: "changed" });
    await click(q("auto-forward"));
    await click(q("forward-dialog-confirm"));
    expect(q("forward-dialog")).toBeNull();
    expect(monthReads).toBeGreaterThan(reads);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "The requests changed" }));
    expect(q("auto-stage-panel")?.getAttribute("data-stage")).toBe("hr_review");
  });

  it("keeps an HR note on a request", async () => {
    await mount();
    await openTab("Requests");
    await click(q("auto-note-1"));
    await type(q("hr-note-text"), "Second advance this year");
    await click(q("hr-note-confirm"));
    expect(writes).toEqual([["PATCH", "/api/settlement-automation/items/1", { hrNote: "Second advance this year" }]]);
  });

  it("keeps HR's final decision within the MD's: no more than the MD approved, a remark for a change", async () => {
    atStage(batchAt("hr_final"));
    await mount();
    await openTab("Requests");
    await click(q("auto-final-2"));
    expect(text(q("final-md"))).toContain("approved ₹25,000");
    await type(q("final-amount"), "26000");
    expect(text(q("final-problem"))).toBe("The final amount cannot be more than the ₹25,000 the MD approved.");
    expect((q("final-confirm") as HTMLButtonElement).disabled).toBe(true);

    await type(q("final-amount"), "20000");
    expect(q("final-changed")).not.toBeNull();
    await click(q("final-confirm"));
    expect(text(q("final-remark-problem"))).toBe(
      "Write a remark for changing the MD's decision (at least 3 characters).",
    );
    expect(writes).toEqual([]);

    await type(q("final-remark"), "Budget limit");
    await click(q("final-confirm"));
    expect(writes).toEqual([
      [
        "PATCH",
        "/api/settlement-automation/items/2/final",
        { decision: "approved", amount: 20000, startMonth: 1, startYear: 2027, remark: "Budget limit" },
      ],
    ]);
  });

  it("a Term Loan's final months: 1 to Settings' most, the EMI follows, and a change is sent", async () => {
    atStage(batchAt("hr_final"));
    await mount();
    await openTab("Requests");
    await click(q("auto-final-2"));
    // the request's own 6 months to start with: ₹25,000 over 6 = ₹4,166.67 a month (an HR-recorded loan, to the paisa)
    expect((q("final-months") as HTMLInputElement).value).toBe("6");
    await type(q("final-months"), "8");
    expect(text(q("final-problem"))).toBe("A Term Loan is repaid in 1 to 6 months.");
    expect((q("final-confirm") as HTMLButtonElement).disabled).toBe(true);
    await type(q("final-months"), "5");
    expect(q("final-problem")).toBeNull();
    expect(text(q("final-emi"))).toBe("₹5,000 a month for 5 months");
    await click(q("final-confirm"));
    expect(writes).toEqual([
      [
        "PATCH",
        "/api/settlement-automation/items/2/final",
        { decision: "approved", amount: 25000, startMonth: 1, startYear: 2027, months: 5, remark: "" },
      ],
    ]);
  });

  it("cannot approve a request the MD rejected", async () => {
    atStage(batchAt("hr_final"));
    await mount();
    await openTab("Requests");
    await click(q("auto-final-3"));
    expect((q("final-decision-approved") as HTMLButtonElement).disabled).toBe(true);
    expect(q("final-decision-rejected")?.getAttribute("aria-checked")).toBe("true");
  });

  it("lists every decision and the changes from the MD before Finalize", async () => {
    atStage(batchAt("hr_final"));
    await mount();
    nextWrite = batchAt("auditor_send");
    await click(q("auto-finalize"));
    expect(text(q("finalize-review"))).toContain("Changed from the MD1");
    expect(text(q("finalize-line-1"))).toContain("Amount ₹8,000 -> ₹6,000");
    expect(text(q("finalize-line-3"))).toContain("Rejected");
    await click(q("finalize-dialog-confirm"));
    expect(writes).toEqual([["POST", "/api/settlement-automation/batches/7/finalize", { note: "" }]]);
    expect(q("auto-stage-panel")?.getAttribute("data-stage")).toBe("auditor_send");
  });

  it("sends the finalized report to the auditor as a PDF and an Excel file", async () => {
    atStage(batchAt("auditor_send"));
    await mount();
    nextWrite = batchAt("auditor_review");
    await click(q("auto-send-auditor"));
    expect(h.auditorFiles).toHaveBeenCalledTimes(1);
    expect(h.auditorFiles.mock.calls[0][0].id).toBe(7);
    expect(writes).toHaveLength(1);
    const [verb, url, body] = writes[0];
    expect([verb, url]).toEqual(["POST", "/api/settlement-automation/batches/7/send-auditor"]);
    const form = body as FormData;
    expect((form.get("pdf") as File).name).toBe("Settlement_November_2026_Batch_1_Final.pdf");
    expect((form.get("xlsx") as File).name).toBe("Settlement_November_2026_Batch_1_Final.xlsx");
    expect(q("auto-stage-panel")?.getAttribute("data-stage")).toBe("auditor_review");
    expect(text(q("auto-stage-title"))).toBe("Waiting for the Auditor's Review");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Review link sent to the auditor" }));
  });

  it("explains that Send to Auditor e-mails a secure review link with the report attached", async () => {
    atStage(batchAt("auditor_send"));
    await mount();
    expect(text(q("auto-send-auditor-explain"))).toContain("secure link to the Auditor Review Portal");
    expect(text(q("auto-send-auditor-explain"))).toContain("finalized report attached as a PDF and an Excel file");
  });

  it("does not move on when the e-mail is not sent, and shows the server's words", async () => {
    atStage(batchAt("auditor_send"));
    await mount();
    const reads = monthReads;
    nextWrite = refusal(502, { error: "Not sent: SMTP timeout", code: "email_failed" });
    await click(q("auto-send-auditor"));
    expect(q("auto-send-error")?.getAttribute("data-code")).toBe("email_failed");
    expect(text(q("auto-send-error"))).toContain("Not sent: SMTP timeout");
    expect(q("auto-stage-panel")?.getAttribute("data-stage")).toBe("auditor_send");
    // the files of the failed attempt are kept: the month is read again to show them
    expect(monthReads).toBeGreaterThan(reads);
  });

  it("links to Settings when no auditor address is set, and does not send", async () => {
    month = {
      ...monthOf([batchAt("auditor_send")]),
      recipients: { auditor: [], auditorCc: [], accounts: [], accountsCc: [] },
    };
    await mount();
    expect(q("auto-no-auditor")?.querySelector("a")?.getAttribute("href")).toBe("/hr/settings?tab=settlement");
    expect((q("auto-send-auditor") as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirms the auditor's review by hand only as a fallback, which applies HR's settlement and closes the link", async () => {
    atStage(batchAt("auditor_review"));
    await mount();
    expect(text(q("auto-fallback"))).toContain("Auditor confirmed another way?");
    expect(text(q("auto-fallback"))).toContain("closes the review link");
    nextWrite = batchAt("accounts_send");
    await click(q("auto-proceed"));
    expect(text(q("proceed-dialog"))).toContain("HR's final settlement is applied exactly as finalized");
    await type(q("proceed-dialog-note"), "Confirmed by phone");
    await click(q("proceed-dialog-confirm"));
    expect(writes).toEqual([
      ["POST", "/api/settlement-automation/batches/7/auditor-done", { note: "Confirmed by phone" }],
    ]);
    expect(q("auto-stage-panel")?.getAttribute("data-stage")).toBe("accounts_send");
  });

  it("follows the review link: sent to, valid until, opened, answered; and resends a new one", async () => {
    const link = {
      sentTo: ["auditor@firm.in"],
      createdAt: "2026-11-25T05:00:00Z",
      createdBy: "Priya HR",
      expiresAt: "2026-12-02T05:00:00Z",
      expired: false,
      revoked: false,
      firstOpenedAt: "2026-11-25T09:00:00Z",
      lastOpenedAt: "2026-11-26T04:00:00Z",
      openCount: 3,
      submittedAt: null,
      decision: null,
      active: true,
    };
    const b = batchAt("auditor_review");
    atStage({ ...b, auditor: { ...b.auditor, link } });
    await mount();
    expect(text(q("auto-link-state"))).toBe("Active");
    expect(text(q("auto-link-status"))).toContain("auditor@firm.in");
    expect(text(q("auto-link-status"))).toContain("Valid until");
    expect(text(q("auto-link-opened"))).toMatch(/^3 times · first .* · last /);
    expect(text(q("auto-link-answered"))).toBe("Not yet");
    expect(text(q("auto-resend-auditor"))).toBe("Resend review link");
    nextWrite = { ...b, auditor: { ...b.auditor, link: { ...link, createdAt: "2026-11-26T05:00:00Z", openCount: 0 } } };
    await click(q("auto-resend-auditor"));
    expect(writes.map(([verb, url]) => [verb, url])).toEqual([
      ["POST", "/api/settlement-automation/batches/7/send-auditor"],
    ]);
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "New review link sent to the auditor",
        description: expect.stringContaining("The earlier link no longer works."),
      }),
    );
  });

  it("says when the link expired", async () => {
    const b = batchAt("auditor_review");
    atStage({
      ...b,
      auditor: {
        ...b.auditor,
        link: {
          sentTo: ["auditor@firm.in"],
          createdAt: "2026-11-10T05:00:00Z",
          createdBy: "Priya HR",
          expiresAt: "2026-11-17T05:00:00Z",
          expired: true,
          revoked: false,
          firstOpenedAt: null,
          lastOpenedAt: null,
          openCount: 0,
          submittedAt: null,
          decision: null,
          active: false,
        },
      },
    });
    await mount();
    expect(text(q("auto-link-state"))).toBe("Expired");
    expect(text(q("auto-link-opened"))).toBe("Not opened yet");
  });

  it("HR Rework (Auditor Changes): every change from -> to, the remarks and totals, and no Accounts before approval", async () => {
    atStage(auditorChangesBatch());
    await mount();
    expect(text(q("auto-stage-title"))).toBe("HR Rework (Auditor Changes)");
    expect(text(q("auto-auditor-changes-review-line-1"))).toContain("Reduced ₹6,000 -> ₹5,000");
    expect(text(q("auto-auditor-changes-review-line-1"))).toContain("Two absent days");
    expect(text(q("auto-auditor-changes-review-line-2"))).toContain("Rejected (HR approved ₹25,000)");
    expect(text(q("auto-auditor-changes-review-note"))).toContain("Please check");
    expect(text(q("auto-auditor-changes-review"))).toContain("HR final approved₹31,000");
    expect(text(q("auto-auditor-changes-review"))).toContain("With the auditor's changes₹5,000");
    expect(text(q("auto-auditor-changes-review-answer-1"))).toBe("Waiting for your answer");
    expect(text(q("auto-no-accounts-yet"))).toBe(
      "Nothing goes to Accounts until the auditor approves the revised settlement.",
    );
    expect(text(q("auto-rework-progress"))).toBe("0 of 2 requests answered · 2 still wait for you");
    expect((q("auto-resubmit-auditor") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q("auto-resubmit-auditor-blocked"))).toBe(
      "2 requests still wait for your answer: accept the auditor's change, keep yours or change it first.",
    );
    expect(q("auto-accept-changes")).toBeNull(); // no more "accept and go to Accounts"
    expect(q("tracker-step-auditor_changes")?.getAttribute("data-state")).toBe("current");

    // the Requests tab: the flagged requests on top with the auditor's change, the remark and the answers
    await openTab("Requests");
    expect(q("auto-row-1")?.getAttribute("data-auditor-changed")).toBe("true");
    expect(text(q("auto-flag-1"))).toBe("Auditor changed this");
    expect(text(q("auto-auditor-view-1"))).toContain("Reduced to ₹5,000");
    expect(text(q("auto-auditor-view-1"))).not.toContain("pays"); // a question to HR, not yet what is paid
    expect(text(q("auto-reviewer-remark-1"))).toBe("“Two absent days”");
    expect(text(q("auto-auditor-view-2"))).toContain("Rejected by the auditor");
    expect(text(q("auto-auditor-view-3"))).toContain("No change");
    expect(q("auto-final-view-1")).not.toBeNull(); // HR's final beside the auditor's change
    expect(q("auto-hr-view-1")).toBeNull(); // HR's proposal and the MD's decision stay in the trail, not the row
    // HR's final settlement is what goes back (the Approved column), not the auditor's figure
    expect(text(q("auto-row-1")?.querySelector('[data-column="approved"]') ?? null)).toContain("₹6,000");
    expect(q("auto-accept-1")).not.toBeNull();
    expect(q("auto-keep-own-1")).not.toBeNull();
    expect(q("auto-final-1")).not.toBeNull();
    expect(q("auto-rework-1")).toBeNull(); // waiting: nothing to reopen
    expect(q("auto-rework-3")).not.toBeNull(); // Meena: not flagged, rejected in HR's final settlement
    expect(q("auto-accept-3")).toBeNull();
    // the Summary tab says what the auditor changed
    await openTab("Summary");
    expect(text(q("auto-auditor-changes-value"))).toBe("2");
  });

  it("tells HR when the auditor approved but their e-mail to Accounts did not go", async () => {
    const b = batchAt("accounts_send");
    b.history = [
      {
        at: "2026-11-25T06:00:00Z",
        by: "Auditor",
        action: "auditor_approved",
        note: "",
        via: "approved_send_accounts",
      },
      { at: "2026-11-25T06:00:01Z", by: "Auditor", action: "accounts_failed_from_auditor", note: "SMTP timeout" },
    ];
    atStage(b);
    await mount();
    expect(q("auto-auditor-send-failed")).not.toBeNull();
    expect(text(q("auto-audit-outcome"))).toContain("Approved by the auditor");
  });

  it("sends the bank file to Accounts, which completes the workflow", async () => {
    atStage(batchAt("accounts_send"));
    await mount();
    expect(text(q("auto-bank-summary"))).toContain("2 requests, ₹31,000 in all");
    expect(text(q("auto-bank-summary"))).toContain("after the auditor's changes");
    expect(text(q("auto-bank-missing"))).toContain("Ravi Shankar (S102): no IFSC");
    nextWrite = batchAt("completed");
    await click(q("auto-send-accounts"));
    expect(h.bankFile).toHaveBeenCalledTimes(1);
    const [, url, body] = writes[0];
    expect(url).toBe("/api/settlement-automation/batches/7/send-accounts");
    expect(((body as FormData).get("bank") as File).name).toBe("Settlement_Bank_File_November_2026_Batch_1.xlsx");
    expect(q("auto-completed")).not.toBeNull();
  });

  it("lists the files sent and the history once there are some", async () => {
    atStage(
      batchAt("auditor_review", {
        files: [
          {
            id: 31,
            kind: "report_pdf",
            kindLabel: "Report (PDF)",
            filename: "Settlement_November_2026_Batch_1_Final.pdf",
            size: 20480,
            sentTo: ["auditor@firm.in"],
            emailStatus: "sent",
            createdBy: "Priya HR",
            createdAt: "2026-11-25T05:00:00Z",
          },
        ],
        history: [
          { at: "2026-11-22T05:30:00Z", by: "Priya HR", action: "forwarded", note: "", count: 3 },
          { at: "2026-11-25T05:00:00Z", by: "Priya HR", action: "auditor_sent", note: "", to: ["auditor@firm.in"] },
        ],
      }),
    );
    await mount();
    expect(q("auto-file-31")).toBeNull(); // on its own tab, not stacked under the workflow
    await openTab("Files sent");
    expect(text(q("auto-file-31"))).toContain("Settlement_November_2026_Batch_1_Final.pdf");
    expect(text(q("auto-file-31"))).toContain("Sent");
    expect(q("auto-history")).toBeNull();
    await openTab("History");
    const history = text(q("auto-history"));
    expect(history.indexOf("Sent to the auditor")).toBeLessThan(history.indexOf("HR forwarded it to the MD"));
    expect(history).toContain("3 requests");
  });
});

// ───────────────────── round 5 (owner 2026-11-27): clickable stages and cards, the table, bulk, HR's proposals ─────

const focusRows = () =>
  [...document.querySelectorAll('[data-testid^="auto-focus-row-"]')].map((r) => r.getAttribute("data-testid"));

describe("a click on a tracker stage or a summary card lists those requests under the tracker", () => {
  it("each stage lists what matters there; a second click closes it; a stage not reached says so", async () => {
    atStage(batchAt("hr_final"));
    await mount();
    expect(q("auto-focus-panel")).toBeNull();
    await click(q("tracker-open-md_review"));
    expect(q("auto-focus-panel")?.getAttribute("data-focus")).toBe("md_review");
    expect(text(q("auto-focus-title"))).toContain("MD Review: the MD's decisions · 3 requests");
    expect(text(q("auto-focus-row-2"))).toContain("Approved ₹25,000");
    expect(text(q("auto-focus-row-3"))).toContain("Rejected");
    expect(text(q("auto-focus-row-3"))).toContain("“Too many leaves”");
    expect(window.location.search).toContain("focus=md_review");
    expect(q("tracker-open-md_review")?.getAttribute("aria-pressed")).toBe("true");

    await click(q("tracker-open-hr_review"));
    expect(q("auto-focus-panel")?.getAttribute("data-kind")).toBe("hr");
    expect(text(q("auto-focus-row-1"))).toContain("Keep as asked");
    expect(text(q("auto-focus-row-1"))).toContain("“Regular, no earlier advance”");
    await click(q("tracker-open-hr_review"));
    expect(q("auto-focus-panel")).toBeNull();

    await click(q("tracker-open-accounts_send"));
    expect(text(q("auto-focus-empty"))).toBe("The audit is not through yet: no bank file.");
    await click(q("auto-focus-close"));
    expect(q("auto-focus-panel")).toBeNull();
  });

  it("Accounts lists the bank-file rows paid, at the amount paid", async () => {
    atStage(batchAt("accounts_send"));
    await mount();
    await click(q("tracker-open-accounts_send"));
    expect(q("auto-focus-panel")?.getAttribute("data-kind")).toBe("bank");
    expect(focusRows()).toEqual(["auto-focus-row-1", "auto-focus-row-2"]); // Meena was rejected
    expect(text(q("auto-focus-count"))).toBe("· 2 requests · ₹31,000");
    expect(text(q("auto-focus-row-1"))).toContain("•••• 6789");
    expect(text(q("auto-focus-row-1"))).toContain("₹6,000");
  });

  it("a summary card under the tracker, or on the Summary tab, filters to its requests", async () => {
    atStage(batchAt("hr_final"));
    await mount();
    expect(text(q("auto-focus-card-rejected-value"))).toBe("1");
    await click(q("auto-focus-card-rejected"));
    expect(q("auto-focus-panel")?.getAttribute("data-focus")).toBe("rejected");
    expect(focusRows()).toEqual(["auto-focus-row-3"]);
    await click(q("auto-focus-card-leave"));
    expect(focusRows()).toEqual(["auto-focus-row-2", "auto-focus-row-3"]);
    expect(q("auto-focus-leave-3")?.getAttribute("data-flag")).toBe("critical");

    await openTab("Summary");
    await click(q("auto-count-approved"));
    expect(q("auto-count-approved")?.getAttribute("aria-pressed")).toBe("true");
    expect(q("auto-focus-panel")?.getAttribute("data-focus")).toBe("approved");
    expect(focusRows()).toEqual(["auto-focus-row-1", "auto-focus-row-2"]);
  });

  it("the Overview's figures, leave flags and tracker stages open the type's page with those requests listed", async () => {
    month = monthOf([batchAt("hr_final")]);
    await mount(OVERVIEW);
    expect(q("overview-approved-general")?.getAttribute("href")).toBe("/hr/Loan&Advance/salary-advance?focus=approved");
    expect(q("overview-leave-general")?.getAttribute("href")).toBe("/hr/Loan&Advance/salary-advance?focus=leave");
    expect(q("overview-tracker-general-md_review")?.getAttribute("href")).toBe(
      "/hr/Loan&Advance/salary-advance?focus=md_review",
    );
    await click(q("overview-approved-general"));
    expect(q("settlement-automation")?.getAttribute("data-advance-type")).toBe("general");
    expect(q("auto-focus-panel")?.getAttribute("data-focus")).toBe("approved");
  });
});

describe("the Requests table (round 5): every value under its own heading", () => {
  const cell = (id: number, column: string) => q(`auto-row-${id}`)?.querySelector(`[data-column="${column}"]`) ?? null;
  const heads = () => [...q("auto-requests-table")!.querySelectorAll("th")].map((th) => text(th));

  it("a Salary Advance: requested, fixed salary, working days, earned, eligible limit, approved, leave, decisions, remarks", async () => {
    atStage(batchAt("hr_final"));
    await mount();
    await openTab("Requests");
    expect(heads()).toEqual([
      "",
      "Employee",
      "Fixed salary",
      "Working days",
      "Earned",
      "Requested",
      "Eligible limit",
      "Rounded",
      "Approved",
      "Leave",
      "Status",
      "Remarks",
      "Actions",
    ]);
    expect(text(cell(1, "requested"))).toBe("₹8,000");
    // already a whole ₹500 within the limit: the rounded amount, no note, no line under the ask
    expect(text(cell(1, "rounded"))).toBe("₹8,000");
    expect(cell(1, "requested")?.className).toContain("text-right");
    expect(text(cell(1, "workingDays"))).toBe("16");
    expect(text(cell(1, "earned"))).toBe("₹16,000");
    expect(text(cell(1, "limit"))).toBe("₹8,000");
    expect(text(cell(1, "approved"))).toBe("₹6,000finalless than asked");
    // the house table (All Employees): the shared component's own headings, no uppercase / tracked / coloured class
    const th = q("auto-requests-table")!.querySelector('th[data-column="requested"]')!;
    expect(th.className).not.toMatch(/uppercase|tracking-|text-\[#/);
    // the row actions are icon buttons with their hover label, on one line
    expect(q("auto-final-1")?.getAttribute("data-variant")).toBe("ghost");
    expect(text(q("auto-hr-view-1"))).toBe("HRKeep as asked");
    expect(text(q("auto-md-view-1"))).toBe("MDApproved ₹8,000");
    expect(text(q("auto-final-view-1"))).toBe("FinalApproved ₹6,000");
    expect(text(cell(1, "remarks"))).toContain("HR: “Regular, no earlier advance”");
    expect(text(cell(1, "remarks"))).toContain("Final: “Budget limit”");
    expect(text(cell(3, "approved"))).toContain("Rejected");
  });

  it("a Term Loan: fixed salary, eligible limit, months, monthly EMI and first EMI in their own columns", async () => {
    const b = batchAt("hr_final", { advanceType: "term" });
    b.items[1] = { ...b.items[1], advance: { ...b.items[1].advance, termLimit: 26000, salaryAtRequest: 26000 } };
    atStage(b);
    await mount(TERM_LOAN);
    await openTab("Requests");
    expect(heads()).toEqual([
      "",
      "Employee",
      "Fixed salary",
      "Requested",
      "Eligible limit",
      "Approved",
      "Months",
      "Monthly EMI",
      "First EMI",
      "Leave",
      "Status",
      "Remarks",
      "Actions",
    ]);
    expect(text(cell(2, "limit"))).toBe("₹26,000");
    expect(cell(2, "limit")?.querySelector("[data-over-limit]")).not.toBeNull(); // ₹30,000 asked for
    expect(text(cell(2, "months"))).toBe("6");
    expect(text(cell(2, "emi"))).toBe("₹4,166.67"); // ₹25,000 over 6 months, to the paisa (an HR-recorded loan)
    expect(text(cell(2, "firstEmi"))).toBe("Jan 2027");
  });
});

describe("several requests at once (round 5)", () => {
  it("HR Review: Select all, then propose to reject with one reason (hr-review-bulk)", async () => {
    await mount();
    await openTab("Requests");
    expect(text(q("auto-bulk-count"))).toBe("3 can be selected");
    await click(q("auto-bulk-all"));
    expect(text(q("auto-bulk-count"))).toBe("3 of 3 selected");
    await click(q("auto-bulk-reject"));
    await click(q("auto-bulk-dialog-confirm"));
    expect(text(q("auto-bulk-dialog-problem"))).toBe("Write the reason for rejecting (at least 3 characters).");
    expect(writes).toEqual([]);
    await type(q("auto-bulk-dialog-remark"), "Too many leave days");
    await click(q("auto-bulk-dialog-confirm"));
    expect(writes).toEqual([
      [
        "POST",
        "/api/settlement-automation/batches/7/hr-review-bulk",
        { itemIds: [1, 2, 3], action: "reject", remark: "Too many leave days" },
      ],
    ]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Rejection proposed for 3 requests" }));
    expect(text(q("auto-bulk-count"))).toBe("3 can be selected"); // cleared
  });

  it("HR Review: Select all takes only what the filter shows; approve keeps them as asked", async () => {
    await mount(`${SALARY_ADVANCE}?view=requests&show=leave`);
    expect(
      [...document.querySelectorAll('[data-testid^="auto-row-"]')].map((r) => r.getAttribute("data-testid")),
    ).toEqual(["auto-row-2", "auto-row-3"]);
    await click(q("auto-select-all"));
    expect(q("auto-row-2")?.getAttribute("data-selected")).toBe("true");
    await click(q("auto-bulk-approve"));
    await click(q("auto-bulk-dialog-confirm"));
    expect(writes).toEqual([
      [
        "POST",
        "/api/settlement-automation/batches/7/hr-review-bulk",
        { itemIds: [2, 3], action: "approve", remark: "" },
      ],
    ]);
  });

  it("HR Final Settlement: approve at the MD's amount; the one the MD rejected is left out and named", async () => {
    atStage(batchAt("hr_final"));
    await mount();
    await openTab("Requests");
    await click(q("auto-select-2"));
    await click(q("auto-select-3"));
    expect(text(q("auto-bulk-count"))).toBe("2 of 3 selected");
    nextWrite = { ...batchAt("hr_final"), skipped: [{ id: 3, reason: "The MD rejected it." }] } as SettlementBatch;
    await click(q("auto-bulk-approve"));
    expect(text(q("auto-bulk-dialog"))).toContain("Approve 2 requests at the MD's amount?");
    await click(q("auto-bulk-dialog-confirm"));
    expect(writes).toEqual([
      [
        "POST",
        "/api/settlement-automation/batches/7/final-bulk",
        { itemIds: [2, 3], decision: "approved", remark: "" },
      ],
    ]);
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Final decision kept for 1 request",
        description: "Left out: Meena Iyer: The MD rejected it.",
      }),
    );
  });

  it("no checkboxes and no bulk bar where this login cannot act", async () => {
    atStage(batchAt("md_review"));
    await mount();
    await openTab("Requests");
    expect(q("auto-bulk")).toBeNull();
    expect(q("auto-select-1")).toBeNull();
    expect(q("auto-select-all")).toBeNull();
  });
});

describe("HR's proposal at HR Review (round 5)", () => {
  it("Reduce (below the amount asked, with a remark), Reject (with the reason), Keep (clears a proposal)", async () => {
    const b = batchAt("hr_review");
    b.items[1] = { ...b.items[1], hrNote: "Limit", hr: { action: "reduce", amount: 20000, remark: "Limit" } };
    atStage(b);
    await mount();
    await openTab("Requests");
    expect(text(q("auto-hr-view-2"))).toBe("HRProposes ₹20,000");
    expect(text(q("auto-row-2")?.querySelector('[data-column="approved"]') ?? null)).toContain("HR proposes");
    // not reviewed yet (2026-11-27): Keep as asked is a review of its own
    expect((q("auto-keep-1") as HTMLButtonElement).disabled).toBe(false);
    expect(text(q("auto-hr-view-1"))).toBe("HRNot reviewed yet");
    expect(q("auto-reduce-2")?.getAttribute("aria-pressed")).toBe("true");

    await click(q("auto-reduce-1"));
    await type(q("hr-proposal-amount"), "8000");
    await click(q("hr-proposal-confirm"));
    expect(text(q("hr-proposal-amount-problem"))).toBe("A reduced amount must be less than the rounded ₹8,000.");
    await type(q("hr-proposal-amount"), "6000");
    await type(q("hr-proposal-remark"), "Above the earned limit");
    await click(q("hr-proposal-confirm"));

    await click(q("auto-hr-reject-3"));
    await click(q("hr-proposal-confirm"));
    expect(text(q("hr-proposal-remark-problem"))).toBe("Write the reason for rejecting (at least 3 characters).");
    await type(q("hr-proposal-remark"), "Too many leave days");
    await click(q("hr-proposal-confirm"));

    await click(q("auto-keep-2"));
    expect(writes).toEqual([
      [
        "PATCH",
        "/api/settlement-automation/items/1",
        { hrNote: "Above the earned limit", action: "reduce", amount: 6000 },
      ],
      ["PATCH", "/api/settlement-automation/items/3", { hrNote: "Too many leave days", action: "reject" }],
      ["PATCH", "/api/settlement-automation/items/2", { action: "keep" }],
    ]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Smaller amount proposed" }));
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Rejection proposed" }));
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Kept as asked" }));
  });

  it("the MD's decision pre-filled from HR's proposal is marked so", async () => {
    const b = batchAt("md_review");
    b.items[0] = {
      ...b.items[0],
      hr: { action: "reduce", amount: 6000, remark: "Limit" },
      md: { decision: "approved", amount: 6000, remark: "", decidedAt: null, fromHr: true },
    };
    atStage(b);
    await mount();
    await openTab("Requests");
    expect(text(q("auto-md-view-1"))).toBe("MDApproved ₹6,000from HR");
    expect(text(q("auto-row-1")?.querySelector('[data-column="approved"]') ?? null)).toContain(
      "HR's proposal (MD to confirm)",
    );
  });
});

describe("the Salary Advance rounding at HR Review (owner 2026-11-27)", () => {
  const cell = (id: number, column: string) => q(`auto-row-${id}`)?.querySelector(`[data-column="${column}"]`) ?? null;
  const limited = (limit: number) => ({ ...batchAt("hr_review").items[0].advance.earnings!, limit });
  /** Asha (₹8,000, kept), Ravi (Term Loan), Meena, then three that the rounding changes: ₹15,000 asked over an ₹11,560
   *  limit (-> ₹11,500, capped), ₹4,800 (-> ₹5,000, rounded up) and ₹200 (-> ₹0: only reject). */
  function rounded(): SettlementBatch {
    const b = batchAt("hr_review");
    b.items = [
      ...b.items,
      item(4, {
        rounding: true,
        advance: {
          employeeName: "Karthik Raja",
          employeeCode: "S104",
          amount: 15000,
          requestedAmount: 15000,
          earnings: limited(11560),
        },
      }),
      item(5, {
        rounding: true,
        advance: { employeeName: "Lakshmi N", employeeCode: "S105", amount: 4800, requestedAmount: 4800 },
      }),
      item(6, {
        rounding: true,
        advance: { employeeName: "Devi Priya", employeeCode: "S106", amount: 200, requestedAmount: 200 },
      }),
    ];
    b.counts = { ...b.counts, total: 6, undecided: 6 };
    b.amounts = { ...b.amounts, requested: 63000, rounded: 59500 };
    return b;
  }

  it("the Rounded column after the limit, with one short note and how it was rounded on hover", async () => {
    atStage(rounded());
    await mount();
    await openTab("Requests");
    const heads = [...q("auto-requests-table")!.querySelectorAll("th")].map((th) => text(th));
    expect(heads.slice(heads.indexOf("Eligible limit"), heads.indexOf("Eligible limit") + 3)).toEqual([
      "Eligible limit",
      "Rounded",
      "Approved",
    ]);
    // the Rounded column shows from a full-HD screen on; right-aligned like every amount
    const th = q("auto-requests-table")!.querySelector('th[data-column="rounded"]')!;
    expect(th.className).toContain("min-[1880px]:table-cell");
    expect(th.className).toContain("text-right");
    // Requested keeps what the employee asked for
    expect(text(q("auto-row-4")?.querySelector('[data-column="requested"] p') ?? null)).toBe("₹15,000");
    expect(text(cell(4, "limit"))).toBe("₹11,560");
    expect(text(cell(4, "rounded"))).toBe("₹11,500capped at limit");
    expect(text(cell(5, "rounded"))).toBe("₹5,000rounded up");
    expect(text(cell(6, "rounded"))).toBe("₹0rounds to ₹0 — reject");
    expect(q("auto-rounded-6-note")?.className).toContain("text-red-600");
    expect(q("auto-rounded-4")?.getAttribute("data-steps")).toBe(
      "₹15,000 asked → brought down to the ₹11,560 limit → rounded to the nearest ₹500 = ₹11,500",
    );
    expect(q("auto-rounded-5")?.getAttribute("data-steps")).toBe(
      "₹4,800 asked → rounded to the nearest ₹500 = ₹5,000 (within the ₹8,000 limit)",
    );
    // below a full-HD screen the rounded amount is a line under the ask (only where the rounding changed it)
    const line = q("auto-rounded-line-4");
    expect(text(line)).toBe("rounded ₹11,500");
    expect(line?.className).toContain("min-[1880px]:hidden");
    expect(line?.getAttribute("data-steps")).toContain("brought down to the ₹11,560 limit");
    expect(text(q("auto-rounded-line-6"))).toBe("rounds to ₹0");
    expect(q("auto-rounded-line-1")).toBeNull();
    // the hover text is the shared Radix tooltip (drawn in a portal), opened from the keyboard too
    await act(async () => {
      (q("auto-rounded-4") as HTMLElement).focus();
    });
    await flush();
    expect(text(q("auto-rounded-4-tip"))).toContain("brought down to the ₹11,560 limit");
    // a phone's card has the Rounded figure under its own label
    expect(text(q("auto-card-4"))).toContain("Rounded₹11,500capped at limit");
    expect(q("auto-card-rounded-line-4")).toBeNull();
  });

  it("a request that rounds to ₹0 can only be rejected: Keep is off with the reason, Reject stays", async () => {
    atStage(rounded());
    await mount();
    await openTab("Requests");
    const keep = q("auto-keep-6") as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    expect(keep.getAttribute("aria-label")).toBe("Devi Priya's request rounds to ₹0: it can only be rejected");
    expect((q("auto-hr-reject-6") as HTMLButtonElement).disabled).toBe(false);
    // the others keep their rounded amount
    expect((q("auto-keep-4") as HTMLButtonElement).disabled).toBe(false);
    await click(q("auto-keep-4"));
    expect(writes).toEqual([["PATCH", "/api/settlement-automation/items/4", { action: "keep" }]]);
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Karthik Raja's request goes to the MD at the rounded ₹11,500." }),
    );
  });

  it("kept as asked means the rounded amount: the Approved column and the status say so", async () => {
    const b = rounded();
    b.items[3] = { ...b.items[3], hr: { action: "approve", amount: null, remark: "" }, review: "approved" };
    atStage(b);
    await mount();
    await openTab("Requests");
    expect(text(cell(4, "approved"))).toBe("₹11,500kept · rounded");
    expect(text(q("auto-hr-view-4"))).toBe("HRKept · rounded");
    // not reviewed yet: nothing proposed
    expect(text(cell(3, "approved"))).toBe("—");
  });

  it("Reduce: requested, limit and rounded in the dialog; the ceiling is the rounded amount", async () => {
    atStage(rounded());
    await mount();
    await openTab("Requests");
    await click(q("auto-reduce-4"));
    expect(text(q("hr-proposal-fact-requested"))).toBe("₹15,000");
    expect(text(q("hr-proposal-fact-limit"))).toBe("₹11,560");
    expect(text(q("hr-proposal-fact-rounded"))).toBe("₹11,500");
    expect(text(q("hr-proposal-fact-steps"))).toBe(
      "₹15,000 asked → brought down to the ₹11,560 limit → rounded to the nearest ₹500 = ₹11,500",
    );
    expect(text(q("hr-proposal-dialog"))).toContain("Less than the rounded ₹11,500.");
    await type(q("hr-proposal-amount"), "11500");
    await type(q("hr-proposal-remark"), "Second advance this year");
    await click(q("hr-proposal-confirm"));
    expect(text(q("hr-proposal-amount-problem"))).toBe("A reduced amount must be less than the rounded ₹11,500.");
    expect(writes).toEqual([]);
    await type(q("hr-proposal-amount"), "11000");
    await click(q("hr-proposal-confirm"));
    expect(writes).toEqual([
      [
        "PATCH",
        "/api/settlement-automation/items/4",
        { hrNote: "Second advance this year", action: "reduce", amount: 11000 },
      ],
    ]);
  });

  it("the batch's rounded total beside the requested total; bulk Keep warns about a request that rounds to ₹0", async () => {
    atStage(rounded());
    await mount();
    await openTab("Summary");
    expect(text(q("auto-amount-requested"))).toContain("₹63,000");
    expect(text(q("auto-amount-requested"))).toContain("Rounded total ₹59,500");
    await openTab("Requests");
    await click(q("auto-select-4"));
    await click(q("auto-select-6"));
    await click(q("auto-bulk-approve"));
    expect(text(q("auto-bulk-dialog"))).toContain("a Salary Advance at its rounded amount");
    expect(text(q("auto-bulk-zero"))).toBe(
      "One of them rounds to ₹0 and can only be rejected: untick it or propose to reject it.",
    );
  });

  it("a Term Loan is not rounded: no Rounded column, no line under the ask, no rounded total", async () => {
    const b = batchAt("hr_review", { advanceType: "term" });
    atStage(b);
    await mount(TERM_LOAN);
    await openTab("Requests");
    const heads = [...q("auto-requests-table")!.querySelectorAll("th")].map((th) => text(th));
    expect(heads).not.toContain("Rounded");
    expect(document.querySelector('[data-testid^="auto-rounded-"]')).toBeNull();
    await openTab("Summary");
    expect(text(q("auto-amount-requested"))).not.toContain("Rounded total");
  });
});

describe("the leave calendar (round 5)", () => {
  it("the Leave column opens the request's leave calendar", async () => {
    atStage(batchAt("hr_final"));
    await mount();
    await openTab("Requests");
    await click(q("auto-leave-3"));
    expect(h.fetch).toHaveBeenCalledWith("/api/advances/103/leave-calendar");
    expect(text(q("leave-calendar-dialog"))).toContain("Meena Iyer: leave calendar");
    expect(q("leave-calendar-2026-11-03")?.getAttribute("data-kind")).toBe("absent");
  });
});

describe("MD Direct to Auditor (round 5)", () => {
  const direct = (stage: Parameters<typeof batchAt>[0], over: Partial<SettlementBatch> = {}) => {
    const b = batchAt(stage, { finalizedVia: "md", finalizedBy: "MD Office", ...over });
    b.tracker = b.tracker.map((s) =>
      s.key === "hr_final" ? { ...s, state: "skipped", detail: "Finalized directly by the MD", at: null, by: null } : s,
    );
    return b;
  };

  it("HR Final Settlement shows as skipped; after a failed MD send HR's Send to Auditor works as before", async () => {
    atStage(direct("auditor_send"));
    await mount();
    expect(q("tracker-step-hr_final")?.getAttribute("data-state")).toBe("skipped");
    expect(text(q("tracker-detail-hr_final"))).toBe("Finalized directly by the MD");
    expect(text(q("auto-md-direct-failed"))).toContain("the e-mail to the auditor did not go");
    expect(text(q("auto-finalized"))).toContain("Finalized by the MD (direct to auditor)");
    expect(q("auto-send-auditor")).not.toBeNull();
    await openTab("Requests");
    expect(text(q("auto-final-view-1"))).toBe("FinalApproved ₹6,000by the MD");
  });

  it("the completed batch says it was finalized by the MD", async () => {
    atStage(
      direct("completed", {
        accounts: { sentAt: "2026-11-26T05:00:00Z", sentBy: "Priya HR", recipients: [], sentVia: "hr" },
      }),
    );
    await mount();
    expect(text(q("auto-finalized"))).toContain("Finalized by the MD (direct to auditor)");
    expect(q("auto-md-direct-failed")).toBeNull();
    await openTab("Summary");
    expect(text(q("auto-amount-final"))).toContain("finalized by the MD (direct to auditor)");
  });
});

// ───────────────────── re-approval cycles (owner 2026-11-27): review order, Rework, answers, resubmissions ─────────

/** HR Rework (Auditor Changes): the auditor cut Asha to ₹5,000 ("Two absent days") and rejected Ravi; both wait for HR's
 *  answer; Meena (rejected in HR's final settlement) was not flagged. */
function auditorChangesBatch(over: Partial<SettlementBatch> = {}): SettlementBatch {
  const b = batchAt("auditor_changes", {
    tracker: trackerFor("auditor_changes", "Answer the auditor, then resubmit.", { auditorChanged: true }),
    ...over,
  });
  b.items[0] = {
    ...withAuditor(b.items[0], { action: "reduce", amount: 5000, remark: "Two absent days" }),
    rework: "auditor",
  };
  b.items[1] = { ...withAuditor(b.items[1], { action: "reject", remark: "Loan already running" }), rework: "auditor" };
  b.auditor = {
    ...b.auditor,
    outcome: "changes",
    submittedAt: "2026-11-25T06:00:00Z",
    submittedNote: "Please check",
    changes: 2,
    remarks: 2,
  };
  b.counts = { ...b.counts, rework: 2 };
  b.amounts = { ...b.amounts, payable: 5000 };
  return { ...b, ...over };
}

/** The rows of the Requests table and its group dividers, in the order drawn. */
const tableOrder = () =>
  [...q("auto-requests-table")!.querySelectorAll('[data-testid^="auto-row-"], [data-testid^="auto-group-"]')].map((r) =>
    r.getAttribute("data-testid"),
  );

describe("the Requests table is ordered by review (owner 2026-11-27): waiting on top, then approved, then rejected", () => {
  it("groups the rows under quiet dividers with the stage's own words, and flags the reviewer's changes", async () => {
    const b = batchAt("hr_review");
    b.items[1] = { ...b.items[1], hr: { action: "reject", amount: null, remark: "No" }, hrNote: "No" };
    b.items[2] = { ...b.items[2], hr: { action: "approve", amount: null, remark: "" } };
    atStage(b);
    await mount(`${SALARY_ADVANCE}?view=requests`);
    expect(tableOrder()).toEqual([
      "auto-group-pending",
      "auto-row-1",
      "auto-group-approved",
      "auto-row-3",
      "auto-group-rejected",
      "auto-row-2",
    ]);
    expect(text(q("auto-group-pending"))).toBe("Waiting for your review1");
    expect(text(q("auto-group-approved"))).toBe("Approved1");
    expect(text(q("auto-group-rejected"))).toBe("Rejected1");
    // the phone cards keep the same order
    expect(
      [...q("auto-requests-cards")!.querySelectorAll("[data-group], [data-testid^='auto-card-'][data-review]")].map(
        (el) => el.getAttribute("data-group") ?? el.getAttribute("data-testid"),
      ),
    ).toEqual(["pending", "auto-card-1", "approved", "auto-card-3", "rejected", "auto-card-2"]);
    // Rework on the reviewed ones only; Keep as asked is pressed on the one kept
    expect(q("auto-rework-1")).toBeNull();
    expect(q("auto-rework-2")).not.toBeNull();
    expect(q("auto-keep-3")?.getAttribute("aria-pressed")).toBe("true");
    expect((q("auto-keep-3") as HTMLButtonElement).disabled).toBe(true);
  });

  it("takes the server's `review` as it is (the table never second-guesses it)", async () => {
    const b = batchAt("hr_final");
    b.items[0] = { ...b.items[0], review: "pending" };
    b.items[2] = { ...b.items[2], review: "approved" };
    atStage(b);
    await mount(`${SALARY_ADVANCE}?view=requests`);
    expect(tableOrder()).toEqual([
      "auto-group-pending",
      "auto-row-1",
      "auto-group-approved",
      "auto-row-2",
      "auto-row-3",
    ]);
    expect(text(q("auto-group-pending"))).toBe("Waiting for your final decision1");
  });
});

describe("Rework: reopen a decision before the stage is completed", () => {
  it("HR Final Settlement: Rework clears the decision, the row moves back to the top and glows there", async () => {
    atStage(batchAt("hr_final"));
    await mount(`${SALARY_ADVANCE}?view=requests`);
    expect(tableOrder()[0]).toBe("auto-group-approved"); // every request has its final decision (the MD's)
    const reopened = batchAt("hr_final");
    reopened.items[1] = { ...reopened.items[1], final: { ...reopened.items[1].final, decision: null, amount: null } };
    nextWrite = reopened;
    await click(q("auto-rework-2"));
    expect(writes).toEqual([["POST", "/api/settlement-automation/items/2/rework", {}]]);
    expect(tableOrder().slice(0, 2)).toEqual(["auto-group-pending", "auto-row-2"]);
    expect(q("auto-row-2")?.getAttribute("data-flash")).toBe("true");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Reopened for rework" }));
  });

  it("says why when the server refuses it", async () => {
    atStage(batchAt("hr_final"));
    await mount(`${SALARY_ADVANCE}?view=requests`);
    nextWrite = refusal(400, { error: "The batch is not at a stage HR decides.", code: "stage" });
    await click(q("auto-rework-1"));
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "The request could not be reopened",
        description: "The batch is not at a stage HR decides.",
        variant: "destructive",
      }),
    );
  });
});

describe("HR Rework (MD Changes): answer the MD, then resubmit", () => {
  it("shows the MD's instructions, the answers still due, and why Resubmit is not open yet", async () => {
    atStage(batchAt("md_changes"));
    await mount();
    expect(text(q("auto-stage-title"))).toBe("HR Rework (MD Changes)");
    expect(q("auto-stage-panel")?.getAttribute("data-stage")).toBe("md_changes");
    expect(text(q("auto-md-return-note"))).toBe("The MD's instructionsRecheck Ravi's loan and Meena's leave");
    expect(text(q("auto-md-changes"))).toContain("Managing Director");
    expect(text(q("auto-rework-progress"))).toBe("0 of 2 requests answered · 2 still wait for you");
    expect((q("auto-resubmit-md") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q("auto-resubmit-md-blocked"))).toBe(
      "2 requests still wait for your answer: accept the MD's decision, keep yours or change it first.",
    );
    expect(q("tracker-step-md_changes")?.getAttribute("data-state")).toBe("current");
    // the way to the answers
    await click(q("auto-open-requests"));
    expect(window.location.search).toContain("view=requests");
    expect(q("auto-view-requests")).not.toBeNull();
  });

  it("lists the flagged requests on top with the MD's decision and remark beside HR's proposal", async () => {
    atStage(batchAt("md_changes"));
    await mount(`${SALARY_ADVANCE}?view=requests`);
    expect(tableOrder()).toEqual([
      "auto-group-pending",
      "auto-row-2",
      "auto-row-3",
      "auto-group-approved",
      "auto-row-1",
    ]);
    expect(text(q("auto-group-pending"))).toBe("Waiting for your answer to the MD2");
    expect(text(q("auto-flag-2"))).toBe("MD changed this");
    expect(text(q("auto-hr-view-2"))).toBe("HRKeep as asked");
    expect(text(q("auto-md-view-2"))).toBe("MDApproved ₹25,000“Reduce”"); // the MD's own remark under it
    expect(text(q("auto-reviewer-remark-3"))).toBe("“Too many leaves”");
    // what HR sends back is HR's own proposal (the Approved column), the MD's figure is in the Status beside it
    expect(text(q("auto-row-2")?.querySelector('[data-column="approved"]') ?? null)).toContain("₹30,000");
    // waiting rows: Accept the MD's decision / Keep mine, then Reduce / Reject / Remark; answered rows: Rework
    expect(q("auto-accept-2")).not.toBeNull();
    expect(q("auto-keep-own-2")).not.toBeNull();
    expect(q("auto-reduce-2")).not.toBeNull();
    expect(q("auto-rework-2")).toBeNull();
    expect(q("auto-accept-1")).toBeNull();
    expect(q("auto-rework-1")).not.toBeNull();
    // the hover labels say what each one does (Rework in violet)
    expect(q("auto-rework-1")?.className).toContain("hover:text-violet-700");
  });

  it("Accept the MD's decision, Keep mine, and a change of HR's own proposal answer the MD", async () => {
    atStage(batchAt("md_changes"));
    await mount(`${SALARY_ADVANCE}?view=requests`);
    const answered = batchAt("md_changes");
    answered.items[1] = {
      ...answered.items[1],
      rework: null,
      mdChanged: false,
      hr: { action: "reduce", amount: 25000, remark: "Reduce" },
    };
    nextWrite = answered;
    await click(q("auto-accept-2"));
    expect(writes).toEqual([["POST", "/api/settlement-automation/items/2/resolve", { how: "accept" }]]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "MD's decision accepted" }));
    // Ravi moved to the answered ones and glows there
    expect(tableOrder()).toEqual([
      "auto-group-pending",
      "auto-row-3",
      "auto-group-approved",
      "auto-row-1",
      "auto-row-2",
    ]);
    expect(q("auto-row-2")?.getAttribute("data-flash")).toBe("true");

    await click(q("auto-keep-own-3"));
    expect(writes[1]).toEqual(["POST", "/api/settlement-automation/items/3/resolve", { how: "keep" }]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Your proposal kept" }));

    // a change of HR's own proposal is an answer too: the dialog shows the MD's decision beside it
    await click(q("auto-reduce-3"));
    expect(text(q("hr-proposal-md"))).toBe('The MD rejected it: "Too many leaves"');
    await type(q("hr-proposal-amount"), "3000");
    await type(q("hr-proposal-remark"), "Half, for the leave");
    await click(q("hr-proposal-confirm"));
    expect(writes[2]).toEqual([
      "PATCH",
      "/api/settlement-automation/items/3",
      { hrNote: "Half, for the leave", action: "reduce", amount: 3000 },
    ]);
  });

  it("answers several at once (resolve-bulk) and names the ones left out", async () => {
    atStage(batchAt("md_changes"));
    await mount(`${SALARY_ADVANCE}?view=requests`);
    expect(q("auto-bulk-approve")).toBeNull(); // a rework stage answers, it does not approve
    await click(q("auto-select-2"));
    await click(q("auto-select-3"));
    nextWrite = {
      ...batchAt("md_changes"),
      skipped: [{ id: 3, reason: "The MD has not decided this request: there is nothing to accept." }],
    } as SettlementBatch;
    await click(q("auto-bulk-accept"));
    expect(text(q("auto-answer-dialog"))).toContain("Accept the MD's decision on 2 requests?");
    await click(q("auto-answer-dialog-confirm"));
    expect(writes).toEqual([
      ["POST", "/api/settlement-automation/batches/7/resolve-bulk", { itemIds: [2, 3], how: "accept" }],
    ]);
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "MD's decision accepted on 1 request",
        description: "Left out: Meena Iyer: The MD has not decided this request: there is nothing to accept.",
      }),
    );
    expect(q("auto-answer-dialog")).toBeNull();

    await click(q("auto-select-2"));
    await click(q("auto-bulk-keep"));
    await click(q("auto-answer-dialog-confirm"));
    expect(writes[1]).toEqual([
      "POST",
      "/api/settlement-automation/batches/7/resolve-bulk",
      { itemIds: [2], how: "keep" },
    ]);
  });

  it("Resubmit to the MD: the note goes with it, the MD reviews round 2; a refusal shows the server's words", async () => {
    const answered = batchAt("md_changes", {
      actions: actionsFor("md_changes", true, false, true),
      counts: { ...batchAt("md_changes").counts, rework: 0 },
    });
    answered.items = answered.items.map((i) => ({ ...i, rework: null }));
    atStage(answered);
    await mount();
    expect((q("auto-resubmit-md") as HTMLButtonElement).disabled).toBe(false);
    expect(q("auto-resubmit-md-blocked")).toBeNull();

    nextWrite = refusal(400, { error: "1 request(s) still need your answer to the MD.", code: "rework_open" });
    await click(q("auto-resubmit-md"));
    await click(q("resubmit-md-dialog-confirm"));
    expect(text(q("resubmit-md-dialog-error"))).toBe("1 request(s) still need your answer to the MD.");

    const round2 = batchAt("md_review", {
      mdRound: 2,
      tracker: trackerFor("md_review", "MD: review HR's revised settlement (round 2).", { mdCycles: 1, mdRound: 2 }),
      history: [
        { at: "2026-11-24T05:00:00Z", by: "Priya HR", action: "md_resubmitted", note: "Kept Ravi's amount", round: 2 },
      ],
    });
    nextWrite = round2;
    await type(q("resubmit-md-dialog-note"), "Kept Ravi's amount");
    await click(q("resubmit-md-dialog-confirm"));
    expect(writes[1]).toEqual([
      "POST",
      "/api/settlement-automation/batches/7/resubmit-md",
      { note: "Kept Ravi's amount" },
    ]);
    expect(q("resubmit-md-dialog")).toBeNull();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Resubmitted to the MD" }));
    expect(q("auto-stage-panel")?.getAttribute("data-stage")).toBe("md_review");
    expect(text(q("auto-md-round"))).toBe("Round 2 — the MD is reviewing the revised settlement.");
    expect(text(q("auto-waiting-md"))).toContain("Your note with the revised settlement: Kept Ravi's amount");
    expect(text(q("tracker-step-md_review"))).toContain("round 2");
    expect(q("tracker-step-md_changes")?.getAttribute("data-cycles")).toBe("1");
  });

  it("a click on the HR Rework (MD Changes) stage lists the flagged requests and the answers due", async () => {
    atStage(batchAt("md_changes"));
    await mount();
    await click(q("tracker-open-md_changes"));
    expect(q("auto-focus-panel")?.getAttribute("data-kind")).toBe("md_changes");
    expect(focusRows()).toEqual(["auto-focus-row-2", "auto-focus-row-3"]);
    expect(text(q("auto-focus-row-2"))).toContain("Waiting for your answer");
    expect(text(q("auto-focus-row-3"))).toContain("“Too many leaves”");
  });
});

describe("HR Rework (Auditor Changes): answer the auditor, then resubmit and send in one step", () => {
  it("Accept the auditor's change and Keep HR's settlement answer the auditor; Change final uses the final dialog", async () => {
    atStage(auditorChangesBatch());
    await mount(`${SALARY_ADVANCE}?view=requests`);
    expect(text(q("auto-group-pending"))).toBe("Waiting for your answer to the auditor2");
    await click(q("auto-accept-1"));
    expect(writes).toEqual([["POST", "/api/settlement-automation/items/1/resolve", { how: "accept" }]]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Auditor's change accepted" }));
    await click(q("auto-keep-own-2"));
    expect(writes[1]).toEqual(["POST", "/api/settlement-automation/items/2/resolve", { how: "keep" }]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Your settlement kept" }));
    await click(q("auto-final-1"));
    expect(text(q("final-auditor"))).toBe('The auditor: Reduced ₹6,000 -> ₹5,000: "Two absent days"');
    await type(q("final-amount"), "5500");
    await type(q("final-remark"), "Met halfway");
    await click(q("final-confirm"));
    expect(writes[2]).toEqual([
      "PATCH",
      "/api/settlement-automation/items/1/final",
      { decision: "approved", amount: 5500, startMonth: 12, startYear: 2026, remark: "Met halfway" },
    ]);
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("The auditor sees it when you resubmit") }),
    );
  });

  it("Resubmit to the auditor: resubmit, build the revised report from the revised settlement, then send it", async () => {
    const answered = auditorChangesBatch({ actions: actionsFor("auditor_changes", true, false, true) });
    answered.items = answered.items.map((i) => ({ ...i, rework: null }));
    answered.counts = { ...answered.counts, rework: 0 };
    atStage(answered);
    await mount();
    expect((q("auto-resubmit-auditor") as HTMLButtonElement).disabled).toBe(false);
    const revised = batchAt("auditor_send", {
      auditorRound: 2,
      tracker: trackerFor("auditor_send", "HR: send the revised settlement to the auditor (round 2).", {
        auditorCycles: 1,
        auditorRound: 2,
      }),
    });
    const sent = batchAt("auditor_review", {
      auditorRound: 2,
      tracker: trackerFor("auditor_review", "Auditor: review.", { auditorCycles: 1, auditorRound: 2 }),
    });
    nextWrite = revised;
    laterWrites = [sent];
    await click(q("auto-resubmit-auditor"));
    expect(text(q("resubmit-auditor-dialog"))).toContain(
      "Nothing goes to Accounts until the auditor approves the revised settlement.",
    );
    await type(q("resubmit-auditor-dialog-note"), "Accepted the cut on Asha");
    await click(q("resubmit-auditor-dialog-confirm"));
    expect(writes.map(([verb, url]) => [verb, url])).toEqual([
      ["POST", "/api/settlement-automation/batches/7/resubmit-auditor"],
      ["POST", "/api/settlement-automation/batches/7/send-auditor"],
    ]);
    expect(writes[0][2]).toEqual({ note: "Accepted the cut on Asha" });
    // the report is built from the revised settlement the server answered (round 2), not the page's old one
    expect(h.auditorFiles).toHaveBeenCalledTimes(1);
    expect(h.auditorFiles.mock.calls[0][0].auditorRound).toBe(2);
    expect(((writes[1][2] as FormData).get("pdf") as File).name).toBe("Settlement_November_2026_Batch_1_Final.pdf");
    expect(q("resubmit-auditor-dialog")).toBeNull();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Revised settlement sent to the auditor (round 2)" }),
    );
    expect(q("auto-stage-panel")?.getAttribute("data-stage")).toBe("auditor_review");
    expect(text(q("auto-auditor-round"))).toBe("Round 2 — the auditor is reviewing the revised settlement.");
  });

  it("when only the e-mail fails the batch waits at Send to Auditor, which says why and sends the revised one", async () => {
    const answered = auditorChangesBatch({ actions: actionsFor("auditor_changes", true, false, true) });
    answered.items = answered.items.map((i) => ({ ...i, rework: null }));
    atStage(answered);
    await mount();
    nextWrite = batchAt("auditor_send", { auditorRound: 2 });
    laterWrites = [refusal(502, { error: "Not sent: SMTP timeout", code: "email_failed" })];
    await click(q("auto-resubmit-auditor"));
    await click(q("resubmit-auditor-dialog-confirm"));
    expect(q("resubmit-auditor-dialog")).toBeNull();
    expect(q("auto-stage-panel")?.getAttribute("data-stage")).toBe("auditor_send");
    expect(q("auto-send-error")?.getAttribute("data-code")).toBe("email_failed");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Resubmitted, but not sent to the auditor yet", variant: "destructive" }),
    );
    expect(text(q("auto-auditor-round"))).toContain("Send the revised settlement (round 2)");
    expect(text(q("auto-send-auditor"))).toBe("Send the revised settlement (round 2)");
  });

  it("a refused resubmission keeps the dialog open with the server's words and sends nothing", async () => {
    const answered = auditorChangesBatch({ actions: actionsFor("auditor_changes", true, false, true) });
    atStage(answered);
    await mount();
    nextWrite = refusal(400, { error: "2 request(s) still need your answer to the auditor.", code: "rework_open" });
    await click(q("auto-resubmit-auditor"));
    await click(q("resubmit-auditor-dialog-confirm"));
    expect(text(q("resubmit-auditor-dialog-error"))).toBe("2 request(s) still need your answer to the auditor.");
    expect(h.auditorFiles).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });

  it("answers several at once: Keep HR's settlement on the ticked ones", async () => {
    atStage(auditorChangesBatch());
    await mount(`${SALARY_ADVANCE}?view=requests`);
    await click(q("auto-select-1"));
    await click(q("auto-select-2"));
    await click(q("auto-bulk-keep"));
    expect(text(q("auto-answer-dialog"))).toContain("Keep your own on 2 requests?");
    await click(q("auto-answer-dialog-confirm"));
    expect(writes).toEqual([
      ["POST", "/api/settlement-automation/batches/7/resolve-bulk", { itemIds: [1, 2], how: "keep" }],
    ]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Your own kept on 2 requests" }));
  });

  it("confirming the auditor's review by hand is refused while the auditor has changes in the portal", async () => {
    atStage(batchAt("auditor_review"));
    await mount();
    nextWrite = refusal(409, {
      error:
        "The auditor marked changes in the review portal: wait for their answer (the settlement then comes back to HR for rework).",
      code: "auditor_changes_open",
    });
    const before = monthReads;
    await click(q("auto-proceed"));
    await click(q("proceed-dialog-confirm"));
    expect(text(q("proceed-dialog-error"))).toContain("The auditor marked changes in the review portal");
    expect(monthReads).toBeGreaterThan(before);
  });
});

describe("the history in the tracker's words (2026-11-27)", () => {
  it("names the returns for rework and the resubmissions with their round", async () => {
    atStage(
      batchAt("md_review", {
        mdRound: 2,
        history: [
          { at: "2026-11-22T05:30:00Z", by: "Priya HR", action: "forwarded", note: "", count: 3 },
          {
            at: "2026-11-23T05:00:00Z",
            by: "Managing Director",
            action: "md_returned",
            note: "Recheck",
            round: 1,
            changes: 2,
            remarks: 1,
          },
          { at: "2026-11-24T05:00:00Z", by: "Priya HR", action: "md_resubmitted", note: "", round: 2, count: 2 },
        ],
      }),
    );
    await mount();
    await openTab("History");
    const history = text(q("auto-history"));
    expect(history).toContain("HR resubmitted it to the MD (round 2)");
    expect(history).toContain("MD returned it to HR for rework (round 1)");
    expect(history).toContain("2 changes · 1 remark");
    expect(history.indexOf("HR resubmitted")).toBeLessThan(history.indexOf("MD returned"));
    expect(q("auto-history")?.querySelector('[data-tone="rework"]')).not.toBeNull();
  });
});
