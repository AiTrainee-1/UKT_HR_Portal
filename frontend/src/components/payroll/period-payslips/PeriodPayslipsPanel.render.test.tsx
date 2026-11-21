import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayrollScope, StaffPayslipRow, StaffPayslips } from "@/lib/api-client/custom-hooks";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { PeriodPayslipsPanel } from "./PeriodPayslipsPanel";

// The Payslip tab of Staff Payroll in jsdom (owner 2026-11-20), with a fake server behind customFetch: only the month's
// payroll employees, the staff columns (paid days), the search and status filters, a payslip's full breakdown, and what
// a View-only role may still do. The production scope (rate, shifts, days worked) is on the cycle page's render tests.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: null }),
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

const slip = (payrollId: number, over: Partial<StaffPayslipRow> = {}): StaffPayslipRow => ({
  payrollId,
  slipId: payrollId + 100,
  employeeId: payrollId,
  code: `300${payrollId}`,
  name: `Employee ${payrollId}`,
  department: "ACCOUNTS",
  designation: "ACCOUNTANT",
  unit: "HO",
  joinDate: "2025-04-21",
  bankAccountMasked: "XXXX1234",
  pfNumber: null,
  esiNumber: null,
  status: "pending",
  paymentStatus: "unpaid",
  fixedSalary: 26000,
  companyDays: 27,
  paidDays: 25.5,
  present: 23.5,
  cl: 0,
  hd: 2,
  lop: 1.5,
  earned: 24555.56,
  ot: 0,
  excess: 2000,
  detection: 500,
  eSalary: 26055.56,
  pf: 0,
  esi: 0,
  tds: 0,
  advance: 0,
  others: 0,
  totalDeduction: 0,
  net: 26056,
  earnings: [
    { label: "Basic salary", amount: 13000 },
    { label: "Excess (added by HR)", amount: 2000 },
    { label: "Detection (taken off by HR)", amount: -500 },
  ],
  deductions: [{ label: "PF", amount: 0 }],
  hasSlip: true,
  ...over,
});

let answer: StaffPayslips;

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/hr/payroll?tab=payslip");
  answer = {
    month: 11,
    year: 2026,
    periodLabel: "November 2026",
    locked: false,
    summary: { employees: 2, earned: 49111.12, excess: 2000, detection: 500, deductions: 0, net: 52112 },
    rows: [slip(20, { name: "SURYA M" }), slip(21, { name: "KAVYA R", status: "paid", excess: 0, slipId: null })],
  };
  h.fetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/payslips/staff?")) return JSON.parse(JSON.stringify(answer));
    throw new Error(`unexpected ${url}`);
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

/** The panel with its filters in a small piece of state, the way the page keeps them in its address. */
function Harness({ scope }: { scope: PayrollScope }) {
  const [url, setUrl] = useState<Record<string, string>>({});
  return createElement(PeriodPayslipsPanel, {
    scope,
    url,
    setUrl: (patch: Record<string, string>) => setUrl((u) => ({ ...u, ...patch })),
  });
}

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Harness, { scope: { kind: "staff", month: 11, year: 2026 } }),
      ),
    ),
  );
  await waitFor(() => !!q("ps-list") || !!q("ps-empty"), "the payslips");
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]`);
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
function typeInto(el: HTMLElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the staff Payslip tab", () => {
  it("lists the month's payroll employees with the staff columns and the month's figures", async () => {
    await mount();
    expect(h.fetch).toHaveBeenCalledWith("/api/payslips/staff?month=11&year=2026");
    expect(q("staff-payslips-tab")!.dataset.kind).toBe("staff");
    expect(text(q("ps-heading"))).toBe("November 2026 · 2 payslips");
    expect(text(q("ps-row-20-days"))).toBe("25.5 of 27");
    expect(text(q("ps-row-20-excess"))).toBe("+₹2,000");
    expect(text(q("ps-row-20-detection"))).toBe("−₹500");
    expect(text(q("ps-row-21-excess"))).toBe("—");
    expect(q("ps-row-20-rate")).toBeNull();
    expect(text(q("ps-kpi-net-value"))).toBe("₹52,112");
    expect(text(q("ps-footer-net"))).toBe("₹52,112");
  });

  it("searches and filters by status, and the totals follow the list", async () => {
    await mount();
    typeInto(must("ps-search"), "kavya");
    await waitFor(() => !q("ps-row-20"), "the search");
    expect(q("ps-row-21")).not.toBeNull();
    expect(text(q("ps-count"))).toBe("1 of 2 payslips match");
    expect(text(q("ps-footer-net"))).toBe("₹26,056");
    typeInto(must("ps-search"), "nobody");
    await waitFor(() => !!q("ps-empty-filters"), "the empty note");
    click(must("ps-clear"));
    await waitFor(() => !!q("ps-row-20"), "every payslip again");
  });

  it("opens a payslip's breakdown: the days, the lines the PDF prints and the NET", async () => {
    await mount();
    click(must("ps-row-20-open"));
    await waitFor(() => !!q("ps-sheet"), "the sheet");
    expect(text(q("ps-sheet"))).toContain("Monthly salary₹26,000.00");
    expect(text(q("ps-sheet-day-paidDays"))).toBe("25.50");
    expect(text(q("ps-sheet-day-companyDays"))).toBe("27");
    expect(text(q("ps-sheet-earnings"))).toContain("Detection (taken off by HR)−₹500.00");
    expect(text(q("ps-sheet-earnings-total"))).toBe("₹26,055.56");
    expect(text(q("ps-sheet-net"))).toContain("₹26,056.00");
  });

  it("cannot email or WhatsApp a payroll with no saved slip, and says why", async () => {
    await mount();
    const email = must("ps-row-21-email") as HTMLButtonElement;
    expect(email.disabled).toBe(true);
    expect(email.title).toBe("No payslip was saved for this payroll: generate the payroll again to make one.");
    expect((must("ps-row-20-email") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a View-only role may still read, pick and download, but not send", async () => {
    await mount();
    lockMutatingControls(document.body);
    expect((must("ps-row-20-email") as HTMLButtonElement).disabled).toBe(true);
    expect((must("ps-row-20-whatsapp") as HTMLButtonElement).disabled).toBe(true);
    expect((must("ps-row-20-download") as HTMLButtonElement).disabled).toBe(false);
    expect((must("ps-row-20-preview") as HTMLButtonElement).disabled).toBe(false);
    click(must("ps-row-20-pick"));
    expect(text(q("ps-picked-count"))).toBe("1 picked");
    expect((must("ps-download-picked") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says to generate first when the month has no payroll", async () => {
    answer = { ...answer, rows: [], summary: { ...answer.summary, employees: 0 } };
    await mount();
    expect(text(q("ps-empty"))).toContain("No payroll for November 2026 yet: generate the payroll first");
    expect(q("ps-open-payroll-tab")).not.toBeNull();
  });
});
