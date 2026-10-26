import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayrollBreakdown, PayrollBreakdownResponse } from "@/lib/api-client/custom-hooks";
import { BreakdownDrawer } from "./BreakdownDrawer";

// The salary Breakdown dialog of a payroll record in jsdom, with a fake server behind customFetch: what its Deductions say
// about PF, ESI and TDS. A payroll generated before the PF / ESI redesign keeps its fixed wording; a new one names the
// rate and the base payroll stored, and a TDS line appears only for an employee on the TDS list.

const h = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  // the dialog has no description of its own (long-standing): that warning is not news here, every other one gets through
  for (const level of ["warn", "error"] as const) {
    const report = console[level].bind(console);
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes("Missing `Description`")) report(...args);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

type Deductions = PayrollBreakdown["deductions"];

function staff(deductions: Partial<Deductions>): PayrollBreakdownResponse {
  return {
    payrollId: 1,
    employee: { id: 1, code: "E1", name: "Asha Kumar", employmentType: "staff", salary: 30000 },
    month: 10,
    year: 2026,
    salaryMode: "monthly",
    status: "pending",
    summary: { grossSalary: 30000, deductions: 3000, bonus: 0, netSalary: 27000 },
    breakdown: {
      type: "staff",
      days: [],
      summary: { totalWorkingDays: 26, presentDays: 26, effectivePaidDays: 26 },
      earnings: {
        monthlySalary: 30000,
        dailyRate: 1153.85,
        basic: 15000,
        hra: 6000,
        allowances: 9000,
        grossSalary: 30000,
      },
      deductions: { advances: 0, advanceDetails: [], total: 3000, ...deductions },
      netSalary: 27000,
    },
  };
}

function production(deductions: Partial<Deductions>): PayrollBreakdownResponse {
  return {
    payrollId: 1,
    employee: { id: 2, code: "P1", name: "Bala Worker", employmentType: "production", salary: 0 },
    month: 10,
    year: 2026,
    salaryMode: "shift",
    status: "pending",
    summary: { grossSalary: 3500, deductions: 500, bonus: 0, netSalary: 3000 },
    breakdown: {
      type: "production",
      salaryPerShift: 500,
      dateFrom: "2026-10-05",
      dateTo: "2026-10-11",
      days: [],
      summary: { daysWorked: 7, daysAbsent: 0, totalShifts: 7 },
      earnings: { totalShifts: 7, salaryPerShift: 500, grossSalary: 3500 },
      deductions: { advances: 0, advanceDetails: [], total: 500, ...deductions },
      netSalary: 3000,
    },
  };
}

async function open(answer: PayrollBreakdownResponse) {
  h.fetch.mockResolvedValue(JSON.parse(JSON.stringify(answer)));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(BreakdownDrawer, { payrollId: 1, onClose: vi.fn() }),
      ),
    ),
  );
  for (let i = 0; i < 100 && !document.body.textContent?.includes("Deductions"); i++) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
  }
}

const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
const tds = () => document.body.querySelector<HTMLElement>('[data-testid="breakdown-tds"]');

const STATUTORY = {
  category: "co_emp" as const,
  pfWages: 12500,
  pfRule: {
    id: "a",
    label: "PF below 25,000",
    basis: "basic",
    minAmount: 0,
    maxAmount: 25000,
    ratePercent: 12,
    amountTested: 10000,
  },
  esiRule: null,
};

describe("a staff payroll", () => {
  it("generated before the redesign keeps its fixed wording, and has no TDS line", async () => {
    await open(staff({ pf: 1800, pfRate: 12, esi: 225, esiRate: 0.75 }));
    expect(text()).toContain("PF (12% of Basic)");
    expect(text()).toContain("ESI (0.75% of Gross)");
    expect(text()).toContain("- ₹1,800");
    expect(tds()).toBeNull();
    expect(text()).not.toContain("TDS");
  });

  it("generated after it names the rate and the base payroll stored", async () => {
    await open(staff({ pf: 1500, pfRate: 12, statutory: STATUTORY }));
    expect(text()).toContain("PF (12% of ₹12,500.00)");
    expect(text()).not.toContain("PF (12% of Basic)");
    expect(text()).toContain("- ₹1,500");
    expect(text()).not.toContain("ESI"); // no ESI rule matched: no ESI line
    expect(tds()).toBeNull();
  });

  it("of a TDS employee shows TDS with its percentage and no PF or ESI", async () => {
    await open(
      staff({
        tds: 3000,
        tdsPercent: 10,
        statutory: { category: "tds", tds: { percent: 10, base: 30000, amount: 3000 } },
      }),
    );
    expect(text()).toContain("TDS (10%) of gross");
    expect(tds()!.textContent).toContain("- ₹3,000");
    expect(text()).not.toContain("PF (");
    expect(text()).not.toContain("ESI (");
  });

  it("takes the percentage from the statutory block when the deductions do not carry it", async () => {
    await open(staff({ tds: 1250, statutory: { category: "tds", tds: { percent: 12.5, base: 10000, amount: 1250 } } }));
    expect(tds()!.textContent).toContain("TDS (12.5%) of gross");
  });
});

describe("a production payroll", () => {
  it("generated before the redesign keeps the PF / EF wording and the salary-band rule", async () => {
    await open(
      production({
        pf: 420,
        pfRate: 12,
        esi: 35,
        esiRate: 1,
        pfEfRule: { label: "Band 1", pfRate: 12, efRate: 1 },
      }),
    );
    expect(text()).toContain("rule: Band 1");
    expect(text()).toContain("PF (12%)");
    expect(text()).toContain("EF (1%)");
    expect(tds()).toBeNull();
  });

  it("generated after it says ESI (never EF), with the base, and shows TDS only for a TDS employee", async () => {
    await open(
      production({ pf: 210, pfRate: 12, esi: 13.13, esiRate: 0.75, statutory: { ...STATUTORY, pfWages: 1750 } }),
    );
    expect(text()).toContain("PF (12% of ₹1,750.00)");
    expect(text()).toContain("ESI (0.75% of ₹1,750.00)");
    expect(text()).not.toContain("EF (");
    expect(tds()).toBeNull();
  });

  it("of a TDS employee has a Deductions block with just the TDS", async () => {
    await open(
      production({
        tds: 350,
        tdsPercent: 10,
        statutory: { category: "tds", tds: { percent: 10, base: 3500, amount: 350 } },
      }),
    );
    expect(text()).toContain("TDS (10%) of gross");
    expect(tds()!.textContent).toContain("- ₹350");
    expect(text()).not.toContain("PF (");
  });
});
