import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeriodCoverage } from "@/lib/api-client/custom-hooks";
import { ESHA, payroll, person } from "./fixtures";
import {
  click,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  q,
  text,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// The Generate Payroll dialog of a cycle page after pay-cycle changes (owner 2026-11-06): it lists who is paid for part of
// the period only (or gets catch-up days) with exactly which days, and says a Cleared payslip stays Cleared on Generate
// again. The rest of the dialog is covered in PayrollTab.render.test.tsx.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  trigger: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: null }),
}));
vi.mock("@/contexts/PayrollGenerationContext", () => ({
  usePayrollGeneration: () => ({
    isGenerating: false,
    showPipeline: false,
    progress: undefined,
    lastResult: null,
    triggerGenerate: vi.fn(),
    triggerGenerateProduction: h.trigger,
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  h.trigger.mockResolvedValue(null);
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
});

const partOfTheWeek: PeriodCoverage = {
  periodStart: "2026-02-02",
  periodEnd: "2026-02-08",
  periodDays: 7,
  payDays: 4,
  catchUpDays: 0,
  paidDays: 4,
  payRanges: [{ from: "2026-02-05", to: "2026-02-08" }],
  alreadyPaid: [
    {
      from: "2026-02-02",
      to: "2026-02-04",
      payrollId: 90,
      cycle: "monthly",
      kind: "production",
      label: "Monthly",
      status: "paid",
      periodStart: "2026-01-05",
      periodEnd: "2026-02-04",
    },
  ],
  catchUp: [],
  legacyGap: null,
  partial: true,
  refused: false,
  note: null,
};

async function openDialog() {
  mountPage("/hr/production-payroll/weekly");
  await waitFor(() => !!q("pcp-generate-open") && !(q("pcp-generate-open") as HTMLButtonElement).disabled, "Generate");
  click(must("pcp-generate-open"));
  return must("pcp-generate-dialog");
}

describe("the Generate Payroll dialog after pay-cycle changes", () => {
  it("lists who is paid for part of the period, with which days, and says a Cleared payslip stays Cleared", async () => {
    world.people = [
      person(1, "Asha Worker", "PC-W1", { payroll: payroll(11, 1, "Asha Worker", "PC-W1", { status: "paid" }) }),
      person(2, "Bala Worker", "PC-W2", { coverage: partOfTheWeek }),
      ESHA,
    ];
    const dialog = await openDialog();
    expect(text(q("pcp-generate-partial"))).toContain(
      "1 employee changed pay cycle: only the days no other payroll paid are computed",
    );
    expect(text(q("pcp-generate-partial-PC-W2"))).toBe(
      "Bala Worker PC-W2 - Pays 5–8 Feb only · 2–4 Feb already paid on Monthly",
    );
    expect(text(q("pcp-generate-existing"))).toContain(
      "the payslip marked Cleared stays Cleared (only the figures are worked out again)",
    );
    expect(text(dialog)).toContain("no day is ever paid twice");
    expect(text(dialog)).toContain("every day of the period is already paid on another payslip");
  });

  it("says nothing about pay-cycle changes when nobody changed cycle", async () => {
    const dialog = await openDialog();
    expect(q("pcp-generate-partial")).toBeNull();
    expect(text(q("pcp-generate-existing"))).toContain("(a payslip marked Cleared stays Cleared)");
    expect(text(dialog)).toContain("Generate Weekly Payroll");
  });
});
