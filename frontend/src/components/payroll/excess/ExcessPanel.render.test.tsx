import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { ExcessEntry, PayrollExcessData, PayrollScope } from "@/lib/api-client/custom-hooks";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { ExcessPanel } from "./ExcessPanel";

// The Excess tab of Staff Payroll in jsdom, with a fake server behind customFetch (owner 2026-11-20): the month's
// summary and breakdown, add / change / remove each with its mandatory remark (the server gets exactly the contract's
// bodies), the refused employees, a month locked by Payroll Done, a View-only role, and the server's own sentence when it
// says no. The production scope (one pay period of a cycle) is covered on the cycle page's own render tests.

type User = { role: string; permissions?: Record<string, string> } | null;

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn(), user: null as User }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user }),
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
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

// ── the fake server ───────────────────────────────────────────────────────────

const entry = (id: number, over: Partial<ExcessEntry> = {}): ExcessEntry => ({
  id,
  employeeId: 12,
  kind: "excess",
  amount: 2000,
  remark: "Festival incentive approved by MD",
  source: "manual",
  createdBy: "Admin",
  createdAt: "2026-11-20T12:01:00+05:30",
  updatedBy: "Admin",
  updatedAt: "2026-11-20T12:01:00+05:30",
  ...over,
});

function month(over: Partial<PayrollExcessData> = {}): PayrollExcessData {
  return {
    month: 11,
    year: 2026,
    periodLabel: "November 2026",
    locked: false,
    lockedMessage: null,
    payrollGenerated: true,
    canEdit: true,
    summary: { employees: 1, entries: 2, excessTotal: 2000, detectionTotal: 500, net: 1500 },
    departments: [
      {
        departmentId: 3,
        department: "ACCOUNTS",
        unit: "HO",
        employees: 1,
        excessTotal: 2000,
        detectionTotal: 500,
        net: 1500,
        rows: [
          {
            employeeId: 12,
            code: "30020",
            name: "SURYA M",
            designation: "ACCOUNTANT",
            department: "ACCOUNTS",
            excess: 2000,
            detection: 500,
            net: 1500,
            payrollId: 881,
            inPayroll: true,
            earnedSalary: 15000,
            earnedWithExcess: 16500,
            netPay: 15800,
            entries: [
              entry(52, { kind: "detection", amount: 500, remark: "Bills submitted late" }),
              entry(51, { updatedAt: "2026-11-20T12:05:00+05:30" }),
            ],
          },
        ],
      },
    ],
    employeeOptions: [
      {
        id: 12,
        code: "30020",
        name: "SURYA M",
        department: "ACCOUNTS",
        designation: "ACCOUNTANT",
        eligible: true,
        reason: null,
      },
      {
        id: 13,
        code: "30021",
        name: "KAVYA R",
        department: "ACCOUNTS",
        designation: "CLERK",
        eligible: true,
        reason: null,
      },
      {
        id: 14,
        code: "30022",
        name: "RAVI K",
        department: "STORES",
        designation: "HELPER",
        eligible: false,
        reason: "Inactive employee",
      },
    ],
    ...over,
  };
}

type Write = { method: string; url: string; body: Record<string, unknown> };
let server: {
  month: PayrollExcessData;
  writes: Write[];
  gets: string[];
  /** The next write's answer, when a test wants a particular one. */
  answer: ((w: Write) => unknown) | null;
};

const apiError = (status: number, body: unknown) =>
  new ApiError(new Response(null, { status, statusText: "Conflict" }), body, { method: "POST", url: "/x" });

beforeEach(() => {
  vi.clearAllMocks();
  h.user = null;
  window.history.replaceState(null, "", "/hr/payroll?tab=salary");
  server = { month: month(), writes: [], gets: [], answer: null };
  h.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      server.gets.push(url);
      const path = url.split("?")[0];
      if (path === "/api/payroll-excess/month") return JSON.parse(JSON.stringify(server.month));
      if (path === "/api/payroll-excess/history")
        return {
          items: [
            {
              id: 9,
              entryId: 51,
              employeeId: 12,
              code: "30020",
              name: "SURYA M",
              department: "ACCOUNTS",
              month: 11,
              year: 2026,
              kind: "excess",
              action: "changed",
              source: "manual",
              previousAmount: 1500,
              newAmount: 2000,
              remark: "Corrected after MD approval",
              by: "Admin",
              at: "2026-11-20T12:05:00+05:30",
              payrollNetBefore: 15300,
              payrollNetAfter: 15800,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 50,
        };
      if (path === "/api/departments") return [{ id: 3, name: "ACCOUNTS", category: "staff" }];
      throw new Error(`unexpected GET ${url}`);
    }
    const write = { method, url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    server.writes.push(write);
    if (server.answer) return server.answer(write);
    if (url === "/api/payroll-excess/entries")
      return { created: [entry(60, { employeeId: 13 })], refused: [], payrollUpdated: 1 };
    if (url.startsWith("/api/payroll-excess/entries/"))
      return { entry: entry(51, { amount: 2500 }), payrollUpdated: true };
    if (url === "/api/payroll-excess/remove") return { removed: 2, payrollUpdated: 1 };
    throw new Error(`unexpected ${method} ${url}`);
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

const STAFF: PayrollScope = { kind: "staff", month: 11, year: 2026 };

async function mount(scope: PayrollScope = STAFF) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(ExcessPanel, { scope }))));
  await waitFor(() => !!q("excess-summary") || !!q("excess-error"), "the month");
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body).slice(0, 300)}`);
  return el;
};
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null | undefined) =>
  act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
async function waitFor(check: () => boolean, what: string, timeoutMs = 3000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs)
      throw new Error(`timed out waiting for ${what}: ${text(document.body).slice(0, 300)}`);
    await settle(5);
  }
}
/** Types into an input or a textarea the way React sees it. */
function typeInto(el: HTMLElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const disabled = (id: string) => (must(id) as HTMLButtonElement).disabled;

// ── the month ─────────────────────────────────────────────────────────────────

describe("the month", () => {
  it("asks for the page's month and shows its summary, departments and rows", async () => {
    await mount();
    expect(server.gets).toContain("/api/payroll-excess/month?month=11&year=2026");
    expect(text(q("excess-title"))).toBe("Excess & Detection · November 2026");
    expect(q("excess-tab")!.dataset.kind).toBe("staff");
    expect(text(q("excess-kpi-excess-value"))).toBe("₹2,000");
    expect(text(q("excess-kpi-detection-value"))).toBe("₹500");
    expect(text(q("excess-kpi-net-value"))).toBe("+₹1,500");
    expect(text(q("excess-kpi-employees"))).toContain("1 in payroll");
    expect(text(q("excess-dept-3"))).toContain("ACCOUNTS");
    expect(text(q("excess-row-earned-30020"))).toBe("Earned ₹15,000 → ₹16,500");
    expect(text(q("excess-row-netpay-30020"))).toBe("NET pay ₹15,800");
    expect(text(q("excess-row-state-30020"))).toBe("In payroll");
    // the page's indigo
    expect(must("excess-add-open").className).toContain("bg-indigo-600");
  });

  it("shows every entry with its remark, and who changed it", async () => {
    await mount();
    expect(q("excess-entries-30020")).toBeNull();
    click(must("excess-row-toggle-30020"));
    expect(text(q("excess-entry-remark-51"))).toBe("Festival incentive approved by MD");
    expect(text(q("excess-entry-51"))).toContain("changed by Admin");
    expect(text(q("excess-entry-52"))).toContain("−₹500");
    expect(text(q("excess-entry-52"))).not.toContain("changed by");
  });

  it("says when the payroll is not generated yet, and when there is nothing for the month", async () => {
    server.month = month({
      payrollGenerated: false,
      departments: [],
      summary: { employees: 0, entries: 0, excessTotal: 0, detectionTotal: 0, net: 0 },
    });
    await mount();
    expect(text(q("excess-not-generated-note"))).toContain("The payroll for November 2026 is not generated yet");
    expect(text(q("excess-empty"))).toContain("No excess or detection for November 2026");
    expect(q("excess-empty-add")).not.toBeNull();
  });

  it("says so, with Try again, when the month cannot be loaded", async () => {
    h.fetch.mockImplementationOnce(async () => {
      throw apiError(500, { error: "The payroll server is busy." });
    });
    await mount();
    expect(text(q("excess-error"))).toContain("The payroll server is busy.");
    click(must("excess-retry"));
    await waitFor(() => !!q("excess-summary") && !!q("excess-dept-3"), "the month after Try again");
  });
});

// ── add ───────────────────────────────────────────────────────────────────────

describe("adding an excess or a detection", () => {
  it("wants an amount, a remark and an employee before anything is sent", async () => {
    await mount();
    click(must("excess-add-open"));
    await waitFor(() => !!q("excess-add-dialog"), "the dialog");
    click(must("excess-add-save"));
    await settle();
    expect(text(q("excess-amount-error"))).toBe("Enter an amount.");
    expect(text(q("excess-remark-error"))).toBe("A remark is required.");
    expect(text(q("excess-picker-error"))).toBe("Pick at least one employee.");
    typeInto(must("excess-remark"), "ok");
    expect(text(q("excess-remark-error"))).toBe("Write at least 3 characters.");
    expect(server.writes).toEqual([]);
  });

  it("never lets an ineligible employee be picked, and says why", async () => {
    await mount();
    click(must("excess-add-open"));
    await waitFor(() => !!q("excess-option-14"), "the picker");
    expect(disabled("excess-option-14")).toBe(true);
    expect(text(q("excess-option-14"))).toContain("Inactive employee");
    click(must("excess-option-14"));
    expect(text(q("excess-picked-count"))).toBe("None picked");
  });

  it("sends the month, the kind, the amount, the remark and the employees, then reloads the month", async () => {
    await mount();
    const before = server.gets.filter((u) => u.startsWith("/api/payroll-excess/month")).length;
    click(must("excess-add-open"));
    await waitFor(() => !!q("excess-add-dialog"), "the dialog");
    click(must("excess-kind-detection"));
    typeInto(must("excess-amount"), "₹1,250");
    typeInto(must("excess-remark"), "  Damaged goods recovered  ");
    click(must("excess-option-13"));
    expect(text(q("excess-add-summary"))).toBe("Takes ₹1,250 off KAVYA R's earned salary.");
    expect(text(q("excess-add-save"))).toContain("Add ₹1,250 detection to 1 employee");
    click(must("excess-add-save"));
    await waitFor(() => server.writes.length === 1, "the add");
    expect(server.writes[0]).toEqual({
      method: "POST",
      url: "/api/payroll-excess/entries",
      body: {
        month: 11,
        year: 2026,
        kind: "detection",
        amount: 1250,
        remark: "Damaged goods recovered",
        employeeIds: [13],
      },
    });
    await waitFor(() => !q("excess-add-dialog"), "the dialog to close");
    expect(h.toast).toHaveBeenCalledWith({
      title: "Detection of ₹1,250 added for KAVYA R",
      description: "1 payroll updated at once: earned salary and NET.",
    });
    await waitFor(
      () => server.gets.filter((u) => u.startsWith("/api/payroll-excess/month")).length > before,
      "the month to reload",
    );
  });

  it("adds the same amount to several employees picked in the breakdown", async () => {
    server.month = month({
      departments: [
        {
          ...month().departments[0],
          rows: [
            month().departments[0].rows[0],
            {
              ...month().departments[0].rows[0],
              employeeId: 13,
              code: "30021",
              name: "KAVYA R",
              entries: [entry(70, { employeeId: 13 })],
            },
          ],
        },
      ],
    });
    await mount();
    click(must("excess-dept-pick-3"));
    expect(text(q("excess-picked-employees"))).toBe("2 employees picked");
    click(must("excess-bulk-add"));
    await waitFor(() => !!q("excess-add-dialog"), "the dialog");
    expect(text(q("excess-picked-count"))).toBe("2 employees picked");
    typeInto(must("excess-amount"), "500");
    typeInto(must("excess-remark"), "Diwali bonus for the team");
    expect(text(q("excess-add-summary"))).toBe("Adds ₹500 to each of 2 employees (₹1,000 in all).");
    click(must("excess-add-save"));
    await waitFor(() => server.writes.length === 1, "the add");
    expect(server.writes[0].body).toMatchObject({ kind: "excess", amount: 500, employeeIds: [12, 13] });
    // the bulk add is done: nobody is picked any more
    await waitFor(() => !q("excess-selection-bar"), "the selection to go");
  });

  it("lists the employees the server refused, with its reason", async () => {
    server.answer = () => ({
      created: [],
      refused: [{ employeeId: 13, code: "30021", name: "KAVYA R", reason: "Joined after November 2026" }],
      payrollUpdated: 0,
    });
    await mount();
    click(must("excess-add-open"));
    await waitFor(() => !!q("excess-add-dialog"), "the dialog");
    typeInto(must("excess-amount"), "100");
    typeInto(must("excess-remark"), "Night shift allowance");
    click(must("excess-option-13"));
    click(must("excess-add-save"));
    await waitFor(() => !!q("excess-refused"), "the refused list");
    expect(text(q("excess-add-dialog"))).toContain("Nothing added: 1 employee refused");
    expect(text(q("excess-refused-13"))).toContain("Joined after November 2026");
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("shows the server's own sentence when it says no", async () => {
    server.answer = () => {
      throw apiError(409, { error: "November 2026 is finalized (Payroll Done): no excess or detection can be added." });
    };
    await mount();
    click(must("excess-add-open"));
    await waitFor(() => !!q("excess-add-dialog"), "the dialog");
    typeInto(must("excess-amount"), "100");
    typeInto(must("excess-remark"), "Night shift allowance");
    click(must("excess-option-12"));
    click(must("excess-add-save"));
    await waitFor(() => h.toast.mock.calls.length === 1, "the toast");
    expect(h.toast).toHaveBeenCalledWith({
      title: "Could not add the excess",
      description: "November 2026 is finalized (Payroll Done): no excess or detection can be added.",
      variant: "destructive",
    });
    expect(q("excess-add-dialog")).not.toBeNull();
  });
});

// ── change and remove ─────────────────────────────────────────────────────────

describe("changing and removing", () => {
  it("changes an amount only with a reason, and to a different amount", async () => {
    await mount();
    click(must("excess-row-toggle-30020"));
    click(must("excess-entry-change-51"));
    await waitFor(() => !!q("excess-change-dialog"), "the dialog");
    click(must("excess-change-save"));
    await settle();
    expect(text(q("excess-change-amount-error"))).toBe("This is the amount now: enter a different one.");
    expect(text(q("excess-change-reason-error"))).toBe("A reason is required.");
    typeInto(must("excess-change-amount"), "2500");
    expect(text(q("excess-change-preview"))).toBe("₹2,000 → ₹2,500 (+₹500)");
    typeInto(must("excess-change-reason"), "Corrected after MD approval");
    click(must("excess-change-save"));
    await waitFor(() => server.writes.length === 1, "the change");
    expect(server.writes[0]).toEqual({
      method: "PATCH",
      url: "/api/payroll-excess/entries/51",
      body: { amount: 2500, remark: "Corrected after MD approval" },
    });
    await waitFor(() => !q("excess-change-dialog"), "the dialog to close");
    expect(h.toast).toHaveBeenCalledWith({
      title: "SURYA M's excess changed to ₹2,500",
      description: "The payroll is updated at once: earned salary and NET.",
    });
  });

  it("removes the entries picked, with one mandatory reason for all", async () => {
    await mount();
    click(must("excess-row-toggle-30020"));
    click(must("excess-entry-pick-51"));
    click(must("excess-entry-pick-52"));
    expect(text(q("excess-picked-entries"))).toBe("2 entries picked");
    click(must("excess-bulk-remove"));
    await waitFor(() => !!q("excess-remove-dialog"), "the dialog");
    expect(text(q("excess-remove-totals"))).toContain("Excess taken back: ₹2,000");
    expect(text(q("excess-remove-totals"))).toContain("Detection given back: ₹500");
    click(must("excess-remove-save"));
    await settle();
    expect(text(q("excess-remove-reason-error"))).toBe("A reason is required.");
    expect(server.writes).toEqual([]);
    typeInto(must("excess-remove-reason"), "Added by mistake");
    click(must("excess-remove-save"));
    await waitFor(() => server.writes.length === 1, "the removal");
    expect(server.writes[0]).toEqual({
      method: "POST",
      url: "/api/payroll-excess/remove",
      body: { entryIds: [52, 51], remark: "Added by mistake" },
    });
    await waitFor(() => !q("excess-remove-dialog"), "the dialog to close");
    expect(h.toast).toHaveBeenCalledWith({
      title: "2 entries removed",
      description: "1 payroll updated at once: earned salary and NET.",
    });
  });

  it("removes one entry from its own button", async () => {
    await mount();
    click(must("excess-row-toggle-30020"));
    click(must("excess-entry-remove-52"));
    await waitFor(() => !!q("excess-remove-dialog"), "the dialog");
    expect(text(q("excess-remove-dialog"))).toContain("Remove this entry");
    typeInto(must("excess-remove-reason"), "Bills were on time");
    click(must("excess-remove-save"));
    await waitFor(() => server.writes.length === 1, "the removal");
    expect(server.writes[0].body).toEqual({ entryIds: [52], remark: "Bills were on time" });
  });
});

// ── locked and view only ──────────────────────────────────────────────────────

describe("what cannot be changed", () => {
  it("a month finalized with Payroll Done is locked: the server's sentence, no add, no pick, no change", async () => {
    server.month = month({
      locked: true,
      lockedMessage: "November 2026 was finalized on 30 Nov by Admin: nothing can change.",
    });
    await mount();
    expect(text(q("excess-locked-note"))).toBe("November 2026 was finalized on 30 Nov by Admin: nothing can change.");
    expect(disabled("excess-add-open")).toBe(true);
    expect(q("excess-dept-pick-3")).toBeNull();
    expect(q("excess-pick-30020")).toBeNull();
    click(must("excess-row-toggle-30020"));
    expect(q("excess-entry-remark-51")).not.toBeNull();
    expect(q("excess-entry-change-51")).toBeNull();
    expect(q("excess-entry-remove-51")).toBeNull();
    expect(q("excess-entry-pick-51")).toBeNull();
    expect(q("excess-row-add-30020")).toBeNull();
  });

  it("a View-only role sees every figure and entry but has nothing to change with", async () => {
    h.user = { role: "hr", permissions: { salary: "view" } };
    await mount();
    expect(text(q("excess-kpi-net-value"))).toBe("+₹1,500");
    expect(q("excess-add-open")).toBeNull();
    expect(q("excess-dept-pick-3")).toBeNull();
    click(must("excess-row-toggle-30020"));
    expect(text(q("excess-entry-remark-51"))).toBe("Festival incentive approved by MD");
    expect(q("excess-entry-change-51")).toBeNull();
    expect(q("excess-entry-remove-51")).toBeNull();
    // the export only reads: it stays usable when the page is locked for a View-only role
    lockMutatingControls(document.body);
    expect(disabled("excess-export")).toBe(false);
  });

  it("the server's own edit right counts too (canEdit false)", async () => {
    server.month = month({ canEdit: false });
    await mount();
    expect(q("excess-add-open")).toBeNull();
    expect(q("excess-pick-30020")).toBeNull();
  });
});

// ── history ───────────────────────────────────────────────────────────────────

describe("the history", () => {
  it("asks for the month's changes and shows who did what, and why", async () => {
    await mount();
    click(must("excess-view-history"));
    await waitFor(() => !!q("excess-history-row-9"), "the history");
    expect(server.gets).toContain("/api/payroll-excess/history?month=11&year=2026&page=1&pageSize=50");
    const line = text(q("excess-history-row-9"));
    expect(line).toContain("SURYA M");
    expect(line).toContain("Changed");
    expect(line).toContain("₹1,500 → ₹2,000");
    expect(line).toContain("Corrected after MD approval");
    expect(line).toContain("₹15,300 → ₹15,800");
    expect(text(q("excess-history-count"))).toBe("1 change in November 2026");
    expect(new URLSearchParams(window.location.search).get("exview")).toBe("history");
  });
});
