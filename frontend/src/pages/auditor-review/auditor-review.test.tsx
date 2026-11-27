import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { BankFileLine } from "@/lib/bankFile";
import type { PortalData } from "./api";
import AuditorReview from "./AuditorReview";
import { LEAVE_CALENDAR, TIMECARD, portalData, recount, termPortalData } from "./fixtures";

// The Auditor Review Portal (owner 2026-11-27, redesigned the same day) against a small fake server (the browser's fetch
// is replaced): the link's states (valid, not valid, replaced, expired, answered), one row of three tabs each with its
// own section, the Overview's columns (a Term Loan batch in the Term Loan columns), choosing requests (Select All, the
// search) and the bulk approve / reject, the auditor's changes on one request (reduce, reject, remark, undo) with the
// checks and the server's words, the leave calendar, the time card, and the three answers: the bank file built here
// from the approved settlement as paid, the Accounts addresses, forwarding to HR, forwarding changes, and read-only once
// submitted.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  bank: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/bankFile", () => ({ buildBankFileWorkbook: h.bank }));

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

const TOKEN = "Zk3x9-portal-token-for-the-auditor-0123456789";
const BASE = `/api/auditor-review/${TOKEN}`;

const refusal = (status: number, data: unknown) =>
  new ApiError(new Response(null, { status, statusText: "Refused" }), data, { method: "GET", url: BASE });

/** The fake server's state. */
let portal: PortalData;
let reads = 0;
let readRefusal: ApiError | null = null;
/** Every write: [method, url, body]. */
let writes: [string, string, unknown][] = [];
let nextRefusal: ApiError | null = null;
let submitWarning: string | null = null;

function server(url: string, options?: { method?: string; body?: unknown }) {
  const verb = options?.method ?? "GET";
  if (url === BASE && verb === "GET") {
    reads += 1;
    if (readRefusal) return Promise.reject(readRefusal);
    return Promise.resolve(JSON.parse(JSON.stringify(portal)));
  }
  if (url === `${BASE}/timecard/1`) return Promise.resolve(JSON.parse(JSON.stringify(TIMECARD)));
  if (url === `${BASE}/leave/2`) return Promise.resolve(JSON.parse(JSON.stringify(LEAVE_CALENDAR)));
  if (url === `${BASE}/bulk` && verb === "POST") {
    const body = JSON.parse(String(options?.body ?? "{}")) as { itemIds: number[]; action: string; remark: string };
    writes.push([verb, url, body]);
    if (nextRefusal) {
      const r = nextRefusal;
      nextRefusal = null;
      return Promise.reject(r);
    }
    // service.auditor_bulk: approve clears a change (a remark replaces the old one when given); reject = one reason,
    // only on what HR approved
    portal = recount({
      ...portal,
      items: portal.items.map((i) => {
        if (!body.itemIds.includes(i.id)) return i;
        if (body.action === "reject")
          return i.final.decision === "approved"
            ? { ...i, auditor: { action: "reject", amount: null, remark: body.remark, at: "2026-11-26T05:00:00Z" } }
            : i;
        return {
          ...i,
          auditor: { action: null, amount: null, remark: body.remark || i.auditor.remark, at: "2026-11-26T05:00:00Z" },
        };
      }),
    });
    return Promise.resolve(JSON.parse(JSON.stringify(portal)));
  }
  const item = new RegExp(`^${BASE}/items/(\\d+)$`).exec(url);
  if (item && verb === "PATCH") {
    const body = JSON.parse(String(options?.body ?? "{}")) as { action: string; amount?: number; remark: string };
    writes.push([verb, url, body]);
    if (nextRefusal) {
      const r = nextRefusal;
      nextRefusal = null;
      return Promise.reject(r);
    }
    portal = recount({
      ...portal,
      items: portal.items.map((i) =>
        i.id === Number(item[1])
          ? {
              ...i,
              auditor: {
                action: (body.action || null) as "reduce" | "reject" | null,
                amount: body.action === "reduce" ? (body.amount ?? null) : null,
                remark: body.remark,
                at: "2026-11-26T05:00:00Z",
              },
            }
          : i,
      ),
    });
    return Promise.resolve(JSON.parse(JSON.stringify(portal)));
  }
  if (url === `${BASE}/submit` && verb === "POST") {
    const form = options?.body as FormData;
    writes.push([verb, url, form]);
    if (nextRefusal) {
      const r = nextRefusal;
      nextRefusal = null;
      return Promise.reject(r);
    }
    portal = {
      ...portal,
      canReview: false,
      link: { ...portal.link, submittedAt: "2026-11-26T06:00:00Z", decision: form.get("decision") as never },
    };
    return Promise.resolve({ ...JSON.parse(JSON.stringify(portal)), warning: submitWarning });
  }
  return Promise.resolve({});
}

/** The browser's fetch as the portal calls it, answered by `server` (a refusal becomes the error response). */
async function fetchServer(url: string, init?: RequestInit): Promise<Response> {
  try {
    const data = await server(url, { method: init?.method, body: init?.body ?? undefined });
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    if (err instanceof ApiError) return new Response(JSON.stringify(err.data), { status: err.status });
    throw err;
  }
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  portal = portalData();
  reads = 0;
  readRefusal = null;
  writes = [];
  nextRefusal = null;
  submitWarning = null;
  // the portal calls the browser's fetch itself (no Authorization header): the fake server answers it
  h.fetch.mockImplementation(fetchServer);
  vi.stubGlobal("fetch", h.fetch);
  h.bank.mockResolvedValue({ xlsx: { writeBuffer: async () => new Uint8Array([1, 2, 3]).buffer } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.removeItem("uk_textile_token");
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(search = "") {
  window.history.replaceState(null, "", `/auditor-review/${TOKEN}${search}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(AuditorReview))));
  await flush();
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
async function choose(el: Element | null, value: string) {
  expect(el, "select to choose in").not.toBeNull();
  await act(async () => {
    const select = el as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}
const heads = () => [...document.querySelectorAll('[data-testid="portal-items-table"] thead th')].map(text);
const cell = (id: number, col: string) =>
  text(document.querySelector(`[data-testid="portal-row-${id}"] [data-col="${col}"]`));
async function openTab(label: string) {
  const tab = [...document.querySelectorAll('[role="tab"]')].find((b) => text(b).startsWith(label)) ?? null;
  await click(tab);
}

describe("the link", () => {
  it("opens the settlement under review: the company, the batch, the month, who finalized it and until when", async () => {
    await mount();
    expect(reads).toBe(1);
    expect(text(q("portal-company"))).toBe("UK Textiles");
    expect(text(q("portal-title"))).toBe("Salary Advance · Batch 1");
    expect(text(q("portal-period"))).toBe("November 2026 · 3 requests");
    expect(text(q("portal-finalized"))).toContain("by Priya HR");
    expect(text(q("portal-valid-until"))).toContain("2026");
    expect(text(q("portal-status"))).toBe("Awaiting your review");
  });

  it("sends no Authorization header and no cookies, even with an HR session in the same browser", async () => {
    window.localStorage.setItem("uk_textile_token", "hr-session-token");
    await mount();
    await click(q("portal-remark-1"));
    await type(q("portal-change-remark"), "Checked");
    await click(q("portal-change-save"));
    expect(h.fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of h.fetch.mock.calls as [string, RequestInit][]) {
      const headers = new Headers(init.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(init.credentials).toBe("omit");
    }
  });

  it.each([
    [404, "link_invalid", "invalid", "This review link is not valid"],
    [410, "link_revoked", "revoked", "This review link is no longer in use"],
    [410, "link_expired", "expired", "This review link has expired"],
  ] as const)("says clearly when the server answers %s %s", async (status, code, kind, title) => {
    readRefusal = refusal(status, { error: `The server says ${code}.`, code });
    await mount();
    expect(q("portal-problem")?.getAttribute("data-kind")).toBe(kind);
    expect(text(q("portal-problem-title"))).toBe(title);
    expect(text(q("portal-problem-text"))).toBe(
      kind === "invalid"
        ? "Check that the whole address from the e-mail was opened, or ask HR to send the review link again."
        : `The server says ${code}.`,
    );
    expect(q("portal-tabs")).toBeNull();
    expect(q("portal-retry")).toBeNull();
  });

  it("offers to try again when the server cannot be reached", async () => {
    readRefusal = null;
    h.fetch.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    await mount();
    expect(q("portal-problem")?.getAttribute("data-kind")).toBe("unavailable");
    await click(q("portal-retry"));
    expect(q("portal-title")).not.toBeNull();
  });
});

describe("one row of three tabs, each with its own section only", () => {
  it("Overview, Attendance & Time Card, Approval", async () => {
    await mount();
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    const tabs = [...document.querySelectorAll('[role="tab"]')].map(text);
    expect(tabs).toHaveLength(3);
    ["Overview", "Attendance & Time Card", "Approval"].forEach((label, i) =>
      expect(tabs[i].startsWith(label)).toBe(true),
    );
    expect(q("portal-overview")).not.toBeNull();
    expect(q("portal-attendance")).toBeNull();
    expect(q("portal-approval")).toBeNull();
    await openTab("Attendance");
    expect(q("portal-attendance")).not.toBeNull();
    expect(q("portal-overview")).toBeNull();
    expect(window.location.search).toBe("?tab=attendance");
    await openTab("Approval");
    expect(q("portal-approval")).not.toBeNull();
    expect(q("portal-attendance")).toBeNull();
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
  });
});

describe("Overview: the requests and the auditor's changes", () => {
  it("lists a Salary Advance batch in the report's columns with the leave check, and HR's totals", async () => {
    await mount();
    // the HRMS table look (owner 2026-11-27): one Employee column with the code and department under the name,
    // sentence-case headings
    expect(heads()).toEqual([
      "", // Select All
      "Employee",
      "Fixed salary",
      "Working days",
      "Earned",
      "Requested",
      "Eligible limit",
      "HR approved",
      "Leave",
      "After audit",
      "Remarks",
      "Actions",
    ]);
    expect(text(q("portal-row-1"))).toContain("S101");
    expect(document.querySelector('[data-testid="portal-items-table"] thead th')?.className).not.toMatch(
      /uppercase|tracking-/,
    );
    expect(cell(1, "limit")).toBe("₹8,000");
    expect(cell(1, "workingDays")).toBe("16");
    expect(text(q("portal-hr-1"))).toBe("₹6,000");
    expect(text(q("portal-after-1"))).toBe("₹6,000");
    expect(text(q("portal-hr-3"))).toBe("Rejected by HR");
    expect(text(q("portal-after-3"))).toBe("Not paid");
    expect(q("portal-leave-2")?.getAttribute("data-flag")).toBe("warning");
    expect(q("portal-leave-3")?.getAttribute("data-flag")).toBe("critical");
    expect(text(q("portal-total-requests-value"))).toBe("3");
    expect(text(q("portal-total-hr-value"))).toBe("₹13,500.4");
    expect(text(q("portal-total-after-value"))).toBe("₹13,500.4");
    expect(text(q("portal-total-rejected"))).toContain("1 by HR · 0 by you");
    expect(text(q("portal-total-changes-value"))).toBe("0");
    expect(text(q("portal-totals-row"))).toContain("Total · 3 requests");
    // a request HR rejected can only get a remark, and cannot be chosen for the bulk actions
    expect(q("portal-reduce-3")).toBeNull();
    expect(q("portal-reject-3")).toBeNull();
    expect(q("portal-remark-3")).not.toBeNull();
    expect((q("portal-select-3") as HTMLInputElement).disabled).toBe(true);
  });

  it("lists a Term Loan batch in the Term Loan columns, never the Salary Advance ones", async () => {
    portal = termPortalData();
    await mount();
    expect(q("portal-items-table")?.getAttribute("data-type")).toBe("term");
    expect(heads()).toEqual([
      "",
      "Employee",
      "Fixed salary",
      "Eligible limit",
      "Requested",
      "HR approved",
      "Months",
      "Monthly EMI",
      "First EMI",
      "Leave",
      "After audit",
      "Remarks",
      "Actions",
    ]);
    expect(heads()).not.toContain("Working days");
    expect(heads()).not.toContain("Earned");
    // Kavin: the loan's own limit, not 50 % of the salary earned (₹6,370)
    expect(cell(1, "fixedSalary")).toBe("₹26,000");
    expect(cell(1, "termLimit")).toBe("₹26,000");
    expect(text(q("portal-items-table"))).not.toContain("₹6,370");
    expect(cell(1, "requested")).toBe("₹24,000");
    expect(cell(1, "hr")).toBe("₹20,000");
    expect(cell(1, "months")).toBe("6");
    expect(cell(1, "emi")).toBe("₹3,334last ₹3,330");
    expect(cell(1, "firstEmi")).toBe("Dec 2026");
    // Lakshmi: the request's own months and first month (HR kept them)
    expect(cell(2, "months")).toBe("4");
    expect(cell(2, "emi")).toBe("₹2,500");
    expect(cell(2, "firstEmi")).toBe("Jan 2027");
    // Gopal: rejected by HR, so no schedule
    expect(cell(3, "hr")).toBe("Rejected by HR");
    expect(cell(3, "emi")).toBe("—");
    expect(cell(3, "firstEmi")).toBe("—");
    // the phone cards read the same figures
    const card = text(q("portal-card-1"));
    expect(card).toContain("Eligible limit₹26,000");
    expect(card).toContain("Monthly EMI₹3,334");
    expect(card).not.toContain("Working days");
    // a reduced loan shows its new EMI (₹15,000 over 6 months)
    await click(q("portal-reduce-1"));
    expect(text(q("portal-change-facts"))).toContain("Eligible limit₹26,000");
    await type(q("portal-change-amount"), "15000");
    expect(text(q("portal-change-preview"))).toContain("New EMI: ₹2,500 a month over 6 months");
    await type(q("portal-change-remark"), "Within two months of salary");
    await click(q("portal-change-save"));
    expect(text(q("portal-after-1"))).toContain("₹15,000");
    expect(text(q("portal-after-1"))).toContain("new EMI ₹2,500");
  });

  it("Select All chooses every request HR approved; Approve selected sends one bulk approval", async () => {
    portal = recount({
      ...portal,
      items: portal.items.map((i) =>
        i.id === 2 ? { ...i, auditor: { action: "reduce", amount: 7000, remark: "Leave days", at: null } } : i,
      ),
    });
    await mount();
    expect(q("portal-bulk-bar")).toBeNull();
    await click(q("portal-select-all"));
    expect((q("portal-select-1") as HTMLInputElement).checked).toBe(true);
    expect((q("portal-select-2") as HTMLInputElement).checked).toBe(true);
    expect((q("portal-select-3") as HTMLInputElement).checked).toBe(false); // rejected by HR
    expect((q("portal-select-all") as HTMLInputElement).checked).toBe(true);
    expect(q("portal-row-1")?.getAttribute("data-selected")).toBe("true");
    expect(text(q("portal-bulk-count"))).toBe("2 selected · HR approved ₹13,500.4");
    await click(q("portal-bulk-approve"));
    expect(text(q("portal-bulk-dialog"))).toContain("Approve 2 requests?");
    expect(text(q("portal-bulk-list"))).toContain("Asha Kumar");
    expect(text(q("portal-bulk-dialog"))).toContain("1 of them you had changed");
    expect(writes).toEqual([]);
    await click(q("portal-bulk-submit"));
    expect(writes).toEqual([["POST", `${BASE}/bulk`, { itemIds: [1, 2], action: "approve", remark: "" }]]);
    expect(q("portal-bulk-dialog")).toBeNull();
    expect(q("portal-bulk-bar")).toBeNull(); // the selection is cleared
    expect(q("portal-row-2")?.getAttribute("data-status")).toBe("approved");
    expect(text(q("portal-total-after-value"))).toBe("₹13,500.4");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 requests approved" }));
    expect(reads).toBe(1); // the reply replaced the portal
  });

  it("Reject selected needs one reason for all and sends it with the chosen requests only", async () => {
    await mount();
    await click(q("portal-select-1"));
    expect((q("portal-select-all") as HTMLInputElement).indeterminate).toBe(true);
    await click(q("portal-select-2"));
    await click(q("portal-select-1")); // changed my mind about Asha
    expect(text(q("portal-bulk-count"))).toContain("1 selected");
    await click(q("portal-bulk-reject"));
    expect(text(q("portal-bulk-dialog"))).toContain("Reject 1 request?");
    await click(q("portal-bulk-submit"));
    expect(text(document.getElementById("portal-bulk-remark-error"))).toBe(
      "Write the reason for rejecting (at least 3 characters).",
    );
    expect(writes).toEqual([]);
    await type(q("portal-bulk-remark"), "  Advances on   hold ");
    await click(q("portal-bulk-submit"));
    expect(writes).toEqual([["POST", `${BASE}/bulk`, { itemIds: [2], action: "reject", remark: "Advances on hold" }]]);
    expect(q("portal-row-2")?.getAttribute("data-status")).toBe("rejected_by_auditor");
    expect(q("portal-row-1")?.getAttribute("data-status")).toBe("approved");
    expect(text(q("portal-remark-text-2"))).toBe("Advances on hold");
    expect(text(q("portal-total-changes-value"))).toBe("1");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "1 request rejected" }));
  });

  it("acts only on the requests the search shows, and shows the server's refusal in the dialog", async () => {
    await mount();
    await click(q("portal-select-1")); // Asha chosen first ...
    await type(q("portal-search"), "ravi"); // ... then hidden by the search
    expect(q("portal-row-1")).toBeNull();
    expect(text(q("portal-showing"))).toContain("Showing 1 of 3 requests");
    expect(q("portal-bulk-bar")).toBeNull(); // nothing shown is chosen
    await click(q("portal-select-all"));
    expect(text(q("portal-bulk-count"))).toContain("1 selected");
    await click(q("portal-bulk-approve"));
    nextRefusal = refusal(409, {
      error: "Some of the chosen requests are not in this batch any more. Reload the list.",
      code: "changed",
    });
    await click(q("portal-bulk-submit"));
    expect(writes.at(-1)).toEqual(["POST", `${BASE}/bulk`, { itemIds: [2], action: "approve", remark: "" }]);
    expect(text(q("portal-bulk-error"))).toBe(
      "Some of the chosen requests are not in this batch any more. Reload the list.",
    );
    expect(reads).toBe(2); // a conflict reads the portal again
    await click(q("portal-bulk-cancel"));
    // the filter
    await type(q("portal-search"), "");
    await choose(q("portal-filter"), "rejected");
    expect(q("portal-row-3")).not.toBeNull();
    expect(q("portal-row-1")).toBeNull();
    await choose(q("portal-filter"), "changed");
    expect(q("portal-empty")).not.toBeNull();
  });

  it("the Leave count opens the employee's leave calendar with the leave days in red", async () => {
    window.localStorage.setItem("uk_textile_token", "hr-session-token");
    await mount();
    expect(q("leave-calendar-dialog")).toBeNull();
    await click(q("portal-leave-btn-2"));
    expect(h.fetch.mock.calls.some(([u]) => u === `${BASE}/leave/2`)).toBe(true);
    expect(q("leave-calendar-dialog")).not.toBeNull();
    expect(text(q("leave-calendar-dialog"))).toContain("Ravi Shankar (S102)");
    expect(text(q("leave-calendar-dialog"))).toContain("3 days");
    expect(q("leave-calendar-2026-11-03")?.getAttribute("data-kind")).toBe("absent");
    expect(q("leave-calendar-2026-11-10")?.getAttribute("data-kind")).toBe("on_leave");
    expect(q("leave-calendar-2026-11-17")?.getAttribute("data-kind")).toBe("half_day_leave");
    expect(q("leave-calendar-2026-11-14")?.getAttribute("data-kind")).toBe("holiday");
    expect(q("leave-calendar-2026-11-03")?.className).toContain("bg-red-500");
    // the public calls never carry the HR session
    for (const [, init] of h.fetch.mock.calls as [string, RequestInit][]) {
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(init.credentials).toBe("omit");
    }
  });

  it("Reduce needs a smaller amount and a remark; the change is highlighted with the original struck through", async () => {
    await mount();
    await click(q("portal-reduce-1"));
    expect(text(q("portal-change-title"))).toBe("Reduce the approved amount");
    expect(text(q("portal-change-facts"))).toBe("Requested₹8,000HR approved₹6,000Limit₹8,000");
    await type(q("portal-change-amount"), "6000");
    await click(q("portal-change-save"));
    expect(text(document.getElementById("portal-change-amount-error"))).toBe(
      "A reduced amount must be less than the approved ₹6,000.",
    );
    expect(text(document.getElementById("portal-change-remark-error"))).toBe(
      "Write a remark for the reduced amount (at least 3 characters).",
    );
    expect(writes).toEqual([]);
    await type(q("portal-change-amount"), "4500");
    await type(q("portal-change-remark"), "  Two  absent days ");
    await click(q("portal-change-save"));
    expect(writes).toEqual([
      ["PATCH", `${BASE}/items/1`, { action: "reduce", amount: 4500, remark: "Two absent days" }],
    ]);
    expect(q("portal-change-dialog")).toBeNull();
    expect(q("portal-row-1")?.getAttribute("data-status")).toBe("reduced");
    // highlighted from -> to: HR's amount struck through, the reduced one, and by how much
    expect(q("portal-after-1")?.querySelector(".line-through")?.textContent).toBe("₹6,000");
    expect(text(q("portal-after-1"))).toContain("₹4,500");
    expect(text(q("portal-after-1"))).toContain("−₹1,500");
    expect(text(q("portal-remark-text-1"))).toBe("Two absent days");
    expect(text(q("portal-total-after-value"))).toBe("₹12,000.4");
    expect(text(q("portal-total-changes-value"))).toBe("1");
    expect(reads).toBe(1); // the reply replaced the portal: no read again
  });

  it("Reject needs the reason; Undo puts the request back as HR finalized it", async () => {
    await mount();
    await click(q("portal-reject-2"));
    await click(q("portal-change-save"));
    expect(text(document.getElementById("portal-change-remark-error"))).toBe(
      "Write the reason for rejecting (at least 3 characters).",
    );
    await type(q("portal-change-remark"), "Loan already running");
    await click(q("portal-change-save"));
    expect(writes.at(-1)).toEqual(["PATCH", `${BASE}/items/2`, { action: "reject", remark: "Loan already running" }]);
    expect(q("portal-row-2")?.getAttribute("data-status")).toBe("rejected_by_auditor");
    expect(text(q("portal-after-2"))).toContain("Rejected by you");
    expect(text(q("portal-total-rejected"))).toContain("1 by HR · 1 by you");
    await click(q("portal-undo-2"));
    expect(writes.at(-1)).toEqual(["PATCH", `${BASE}/items/2`, { action: "", remark: "" }]);
    expect(q("portal-row-2")?.getAttribute("data-status")).toBe("approved");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Change undone" }));
  });

  it("a remark alone keeps the reduced amount; the server's refusal shows in the dialog", async () => {
    portal = recount({
      ...portal,
      items: portal.items.map((i) =>
        i.id === 1 ? { ...i, auditor: { action: "reduce", amount: 5000, remark: "First note", at: null } } : i,
      ),
    });
    await mount();
    await click(q("portal-remark-1"));
    expect((q("portal-change-remark") as HTMLTextAreaElement).value).toBe("First note");
    await type(q("portal-change-remark"), "Checked the time card");
    nextRefusal = refusal(400, { error: "A reduced amount must be less than the approved ₹6,000.00.", code: "amount" });
    await click(q("portal-change-save"));
    expect(writes.at(-1)).toEqual([
      "PATCH",
      `${BASE}/items/1`,
      { action: "reduce", amount: 5000, remark: "Checked the time card" },
    ]);
    expect(text(q("portal-change-error"))).toBe("A reduced amount must be less than the approved ₹6,000.00.");
    expect(q("portal-change-dialog")).not.toBeNull();
  });

  it("reads the portal again when the server says the review is no longer open", async () => {
    await mount();
    await click(q("portal-remark-3"));
    await type(q("portal-change-remark"), "Agree");
    nextRefusal = refusal(409, { error: "Your review of this settlement was already submitted.", code: "submitted" });
    portal = {
      ...portal,
      canReview: false,
      link: { ...portal.link, submittedAt: "2026-11-26T06:00:00Z", decision: "approved_forward_hr" },
    };
    await click(q("portal-change-save"));
    expect(reads).toBe(2);
    expect(q("portal-submitted")).not.toBeNull();
  });
});

describe("Attendance & Time Card", () => {
  it("lists the employees' 1st-20th figures and opens a time card with every day and the month's counts", async () => {
    await mount("?tab=attendance");
    expect(text(q("portal-att-row-1"))).toContain("Asha Kumar");
    expect(text(q("portal-att-row-1"))).toContain("₹16,000");
    expect(q("portal-att-leave-2")?.getAttribute("data-flag")).toBe("warning");
    await click(q("portal-timecard-1"));
    expect(h.fetch.mock.calls.some(([u]) => u === `${BASE}/timecard/1`)).toBe(true);
    expect(text(q("timecard-shift"))).toBe("General (09:00-18:00)");
    expect(text(q("timecard-summary"))).toContain("Present20");
    expect(text(q("timecard-summary"))).toContain("Shifts earned21.50");
    expect(text(q("timecard-day-2026-11-01"))).toContain("Sunday");
    expect(text(q("timecard-day-2026-11-02"))).toContain("Late");
    expect(text(q("timecard-day-2026-11-02"))).toContain("09:12");
    expect(text(q("timecard-day-2026-11-03"))).toContain("Absent");
    expect(text(q("timecard-day-2026-11-14"))).toContain("Deepavali");
    expect(text(q("timecard-day-2026-11-24"))).toContain("Half Day");
    expect(text(q("timecard-day-2026-11-24"))).toContain("Early out");
    expect(text(q("timecard-earned"))).toContain("Earned in 1st–20th November 2026");
  });
});

describe("Approval: the answer", () => {
  it("without changes: Approve & Send to Accounts builds the bank file from the approved settlement and sends it", async () => {
    submitWarning = null;
    await mount("?tab=approval");
    expect(text(q("portal-no-changes"))).toBe("No changes: the settlement stands as HR finalized it.");
    expect(text(q("portal-accounts"))).toContain("accounts@uktextiles.in");
    expect(text(q("portal-accounts"))).toContain("CCmd@uktextiles.in");
    expect(text(q("portal-bank-summary"))).toBe("2 payments, ₹13,501");
    expect(text(q("portal-bank-missing"))).toContain("Ravi Shankar (S102)");
    // all three outcomes are shown; forwarding changes is closed without changes, and says why
    expect(q("portal-option-send")?.getAttribute("data-open")).toBe("true");
    expect(q("portal-option-forward")?.getAttribute("data-open")).toBe("true");
    expect(q("portal-option-changes")?.getAttribute("data-open")).toBe("false");
    expect((q("portal-decide-changes_forward_hr") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q("portal-closed-changes_forward_hr"))).toBe("You made no changes: approve the settlement instead.");
    await type(q("portal-note"), "All in order");
    await click(q("portal-decide-approved_send_accounts"));
    expect(text(q("portal-confirm"))).toContain("goes to accounts@uktextiles.in (CC md@uktextiles.in)");
    expect(writes).toEqual([]);
    await click(q("portal-confirm-submit"));
    expect(h.bank).toHaveBeenCalledTimes(1);
    const [lines, sheet] = h.bank.mock.calls[0] as [BankFileLine[], string];
    expect(lines).toEqual([
      {
        employeeCode: "S101",
        employeeName: "Asha Kumar",
        bankAccount: "50001",
        bankIfsc: "HDFC0001234",
        bankName: "HDFC Bank",
        amount: 6000,
      },
      { employeeCode: "S102", employeeName: "Ravi Shankar", bankAccount: "", bankIfsc: "", bankName: "", amount: 7501 },
    ]);
    expect(sheet).toBe("Nov 2026 Batch 1");
    const [verb, url, form] = writes[0] as [string, string, FormData];
    expect([verb, url]).toEqual(["POST", `${BASE}/submit`]);
    expect(form.get("decision")).toBe("approved_send_accounts");
    expect(form.get("note")).toBe("All in order");
    expect((form.get("bank") as File).name).toBe("Loan_Advance_Bank_File_Salary_Advance_November_2026_Batch_1.xlsx");
    // read-only now
    expect(text(q("portal-submitted"))).toContain("Approved and sent to Accounts");
    expect(text(q("portal-status"))).toBe("Review submitted");
    expect(q("portal-submit")).toBeNull();
    expect(q("portal-approval-done")).not.toBeNull();
    await openTab("Overview");
    expect(q("portal-reduce-1")).toBeNull();
    expect(q("portal-remark-1")).toBeNull();
    expect(q("portal-select-all")).toBeNull();
    expect(q("portal-select-1")).toBeNull();
  });

  it("the bank file pays the auditor's reduced amount, and leaves out a request the auditor rejected", async () => {
    // a reduce and a reject make it a change: send-to-Accounts is for an approval without changes, so check the rows
    const { bankLines } = await import("./logic");
    const changed = recount({
      ...portal,
      items: portal.items.map((i) =>
        i.id === 1
          ? { ...i, auditor: { action: "reduce", amount: 4500.2, remark: "x y z", at: null } }
          : i.id === 2
            ? { ...i, auditor: { action: "reject", amount: null, remark: "x y z", at: null } }
            : i,
      ),
    });
    expect(bankLines(changed).map((l) => [l.employeeCode, l.amount])).toEqual([["S101", 4501]]);
  });

  it("shows the warning when the approval was saved but the e-mail to Accounts did not go", async () => {
    submitWarning = "Your approval was saved, but the e-mail to Accounts did not go (SMTP timeout). HR will send it.";
    await mount("?tab=approval");
    await click(q("portal-decide-approved_send_accounts"));
    await click(q("portal-confirm-submit"));
    expect(text(q("portal-warning"))).toContain("HR will send it.");
  });

  it("Approve & Forward to HR sends no bank file", async () => {
    await mount("?tab=approval");
    await click(q("portal-decide-approved_forward_hr"));
    await click(q("portal-confirm-submit"));
    expect(h.bank).not.toHaveBeenCalled();
    const form = writes[0][2] as FormData;
    expect(form.get("decision")).toBe("approved_forward_hr");
    expect(form.get("bank")).toBeNull();
    expect(text(q("portal-submitted"))).toContain("Approved and forwarded to HR");
  });

  it("cannot send to Accounts without an Accounts address, or with nothing approved, and says why", async () => {
    portal = portalData({ accounts: { to: [], cc: [] } });
    await mount("?tab=approval");
    expect((q("portal-decide-approved_send_accounts") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q("portal-send-blocked"))).toBe(
      "No Accounts e-mail address is set in the HRMS. Approve and forward to HR instead.",
    );
    expect((q("portal-decide-approved_forward_hr") as HTMLButtonElement).disabled).toBe(false);
    act(() => root!.unmount());
    host!.remove();
    const base = portalData();
    portal = recount({
      ...base,
      items: base.items.map((i) => ({ ...i, final: { ...i.final, decision: "rejected", amount: null } })),
    });
    await mount("?tab=approval");
    expect(text(q("portal-send-blocked"))).toBe("Nothing is approved, so there is no bank file for Accounts.");
  });

  it("with changes: only Forward changes to HR, listing every change from → to", async () => {
    portal = recount({
      ...portal,
      items: portal.items.map((i) =>
        i.id === 1
          ? { ...i, auditor: { action: "reduce", amount: 4500, remark: "Two absent days", at: null } }
          : i.id === 3
            ? { ...i, auditor: { action: null, amount: null, remark: "Agree with HR", at: null } }
            : i,
      ),
    });
    await mount("?tab=approval");
    expect(text(q("portal-mod-1"))).toContain("Reduced ₹6,000 → ₹4,500");
    expect(text(q("portal-mod-1"))).toContain("Two absent days");
    expect(text(q("portal-mod-3"))).toContain("Remark only");
    expect(text(q("portal-approval-after-value"))).toBe("₹12,000.4");
    expect((q("portal-decide-approved_send_accounts") as HTMLButtonElement).disabled).toBe(true);
    expect((q("portal-decide-approved_forward_hr") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q("portal-send-blocked"))).toBe("You changed the settlement: forward the changes to HR.");
    expect(text(q("portal-closed-approved_forward_hr"))).toBe("You changed the settlement: forward the changes to HR.");
    expect(q("portal-option-changes")?.getAttribute("data-open")).toBe("true");
    await click(q("portal-decide-changes_forward_hr"));
    nextRefusal = refusal(400, { error: "You made no change: approve the settlement instead.", code: "no_changes" });
    await click(q("portal-confirm-submit"));
    expect(text(q("portal-confirm-error"))).toBe("You made no change: approve the settlement instead.");
    await click(q("portal-confirm-submit"));
    expect((writes.at(-1)![2] as FormData).get("decision")).toBe("changes_forward_hr");
    expect(text(q("portal-submitted"))).toContain("Changes forwarded to HR");
  });

  it("opens read-only on a review already submitted", async () => {
    portal = portalData({
      canReview: false,
      link: { expiresAt: "2026-12-01T05:30:00Z", submittedAt: "2026-11-25T10:00:00Z", decision: "approved_forward_hr" },
    });
    await mount();
    expect(text(q("portal-submitted"))).toContain("Approved and forwarded to HR");
    expect(q("portal-reduce-1")).toBeNull();
    expect(q("portal-select-all")).toBeNull();
    expect(q("portal-guide")).toBeNull();
    await openTab("Approval");
    expect(q("portal-submit")).toBeNull();
    expect(text(q("portal-approval-done"))).toContain("Nothing more is needed from you.");
  });
});
