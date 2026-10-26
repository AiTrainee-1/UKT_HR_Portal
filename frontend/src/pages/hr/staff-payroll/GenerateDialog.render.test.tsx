import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { GenerateDialog } from "./GenerateDialog";

// "Generate Staff Payroll" in jsdom, with a fake server behind customFetch: what it says about PF, ESI and TDS (they follow
// the Co Emp / TDS lists and the rules in Settings -> PF & ESI, not a switch on the Payroll tab) and what it reads to say it.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  trigger: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/PayrollGenerationContext", () => ({
  usePayrollGeneration: () => ({ triggerGenerate: h.trigger, isGenerating: false }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

const RULE = { id: "r", label: "Below 25,000", basis: "basic", minAmount: 0, maxAmount: 25000, ratePercent: 12 };

const world = {
  rules: {} as unknown,
  rulesStatus: 200,
};

let root: Root | null = null;
let host: HTMLElement | null = null;
const requested: string[] = [];

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

beforeEach(() => {
  vi.clearAllMocks();
  requested.length = 0;
  world.rulesStatus = 200;
  world.rules = {
    scope: { branchId: null, branchName: null, isOverride: false },
    canEdit: true,
    staff: { pfRules: [RULE], esiRules: [{ ...RULE, id: "e", ratePercent: 0.75 }] },
    production: { pfRules: [], esiRules: [] },
    branches: [],
  };
  h.fetch.mockImplementation(async (url: string) => {
    requested.push(url);
    const path = url.split("?")[0];
    if (path === "/api/payroll") return [];
    if (path === "/api/payroll-settings") {
      return {
        companyName: "UK Textiles",
        attendanceMode: "strict",
        lateFreeAllowance: 3,
        lateDeductionSlabs: [{ fromLates: 4, deductionShifts: 0.5 }],
        permissionMonthlyCap: 2,
      };
    }
    if (path === "/api/pf-esi-settings") {
      if (world.rulesStatus !== 200) {
        throw new ApiError(new Response(null, { status: world.rulesStatus }), null, { method: "GET", url });
      }
      return JSON.parse(JSON.stringify(world.rules));
    }
    throw new Error(`unexpected request ${url}`);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

async function open() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(GenerateDialog, { initialMonth: 10, initialYear: 2026, onClose: vi.fn(), onStarted: vi.fn() }),
      ),
    ),
  );
  for (let i = 0; i < 200; i++) {
    const rules = q("staff-generate-statutory");
    if (rules && !q("staff-generate-statutory-loading") && q("staff-generate-statutory-note")) break;
    await settle(5);
  }
  await settle(10);
}

describe("what Generate Staff Payroll says about PF, ESI and TDS", () => {
  it("says PF and ESI follow the Co Emp list and TDS its own list, and counts the rules set for Staff", async () => {
    await open();
    expect(text(q("staff-generate-statutory"))).toBe("PF: 1 rule · ESI: 1 rule");
    expect(q("staff-generate-statutory")!.dataset.state).toBe("set");
    const note = text(q("staff-generate-statutory-note"));
    expect(note).toContain("PF and ESI are deducted only from Co Emp employees");
    expect(note).toContain("Settings → PF & ESI");
    expect(note).toContain("Employees on the TDS list have TDS deducted at their own percentage instead");
    expect(note).toContain("Everyone else has neither");
    expect(q("staff-generate-statutory-note-none")).toBeNull();
    expect(q("staff-generate-statutory-note")!.querySelector('a[href="/hr/settings?tab=pf_esi"]')).not.toBeNull();
    expect(q("staff-generate-statutory-note")!.querySelector('a[href="/hr/employees"]')).not.toBeNull();
  });

  it("no longer describes the old switch: nothing about a PF / ESI master switch or flat rates", async () => {
    await open();
    const dialog = text(q("staff-generate-dialog"));
    expect(dialog).not.toContain("PF / ESI off");
    expect(dialog).not.toMatch(/PF \d+%/);
    expect(dialog).toContain("Prices late arrivals and half days with the rules in Settings (below).");
    expect(dialog).not.toContain("half days, PF and ESI");
  });

  it("warns when no PF or ESI rule is set for Staff (read from the rules, not guessed)", async () => {
    world.rules = { ...(world.rules as object), staff: { pfRules: [], esiRules: [] } };
    await open();
    expect(text(q("staff-generate-statutory"))).toBe("No PF or ESI rules are set for Staff");
    expect(q("staff-generate-statutory")!.dataset.state).toBe("none");
    expect(text(q("staff-generate-statutory-note-none"))).toContain(
      "nobody will have PF or ESI deducted until rules are added",
    );
  });

  it("says nothing about the rules when this login cannot read them", async () => {
    world.rulesStatus = 403;
    await open();
    expect(q("staff-generate-statutory")!.dataset.state).toBe("unknown");
    expect(text(q("staff-generate-statutory"))).toBe("PF / ESI: Co Emp employees only");
    expect(q("staff-generate-statutory-note-none")).toBeNull();
    // the rest of the dialog is unharmed
    expect(text(q("staff-generate-rules"))).toContain("Strict attendance (4 punches)");
  });

  it("asks for the rules once, for this screen, and reads nothing else about PF or ESI", async () => {
    await open();
    expect(requested.filter((r) => r === "/api/pf-esi-settings")).toHaveLength(1);
    expect(requested.some((r) => r.includes("/api/payroll-settings"))).toBe(true);
  });
});
