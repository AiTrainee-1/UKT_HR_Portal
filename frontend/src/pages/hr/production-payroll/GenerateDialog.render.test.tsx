import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftPayslip, PeriodCoverage } from "@/lib/api-client/custom-hooks";
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
      "1 payslip is marked Cleared: only the figures are worked out again, it stays Cleared.",
    );
    expect(text(dialog)).toContain("no day is ever paid twice");
    expect(text(dialog)).toContain("every day of the period is already paid on another payslip");
  });

  it("says nothing about pay-cycle changes when nobody changed cycle", async () => {
    const dialog = await openDialog();
    expect(q("pcp-generate-partial")).toBeNull();
    expect(text(q("pcp-generate-existing"))).toContain("Also work out again the 1 payslip already made");
    expect(text(dialog)).toContain("Generate Weekly Payroll");
  });

  it("never offers to work out again a salary already marked Paid, and warns that Adjust figures are replaced", async () => {
    world.people = [
      person(1, "Asha Worker", "PC-W1", { payroll: payroll(11, 1, "Asha Worker", "PC-W1", { paymentStatus: "paid" }) }),
      person(2, "Bala Worker", "PC-W2", { payroll: payroll(12, 2, "Bala Worker", "PC-W2", { bonus: 500 }) }),
      ESHA,
    ];
    await openDialog();
    // Bala only: Asha's salary is paid and is never changed
    expect(text(q("pcp-generate-again-count"))).toBe("1 payslip");
    expect(text(q("pcp-generate-paid-left"))).toBe("1 salary is already marked Paid and is never changed.");
    expect(text(q("pcp-generate-adjusted"))).toContain("1 payslip has a bonus added with Adjust");
    // unticked: nothing left to do (nobody is without a payslip), so it cannot be confirmed
    click(must("pcp-generate-again"));
    expect(q("pcp-generate-adjusted")).toBeNull();
    expect((must("pcp-generate-confirm") as HTMLButtonElement).disabled).toBe(true);
  });
});

const draft = (
  id: number,
  start: string,
  end: string,
  label: string,
  over: Partial<DraftPayslip> = {},
): DraftPayslip => ({
  payrollId: id,
  cycle: "biweekly",
  label: "BiWeekly",
  periodStart: start,
  periodEnd: end,
  periodLabel: label,
  status: "pending",
  cleared: false,
  net: 7000,
  ...over,
});

describe("draft payslips of other periods (owner 2026-11-16: a Generated payslip is a draft)", () => {
  const oldGrid = [
    draft(80, "2026-01-26", "2026-02-08", "26 Jan – 8 Feb 2026"),
    draft(81, "2026-02-09", "2026-02-22", "9 Feb – 22 Feb 2026", { cleared: true, status: "paid" }),
  ];

  it("replaces them by default, grouped by period, and sends the flag", async () => {
    world.people = [
      person(1, "Asha Worker", "PC-W1", { payroll: payroll(11, 1, "Asha Worker", "PC-W1"), drafts: [oldGrid[0]] }),
      person(2, "Bala Worker", "PC-W2", { drafts: oldGrid }),
      ESHA,
    ];
    await openDialog();
    const box = must("pcp-generate-drafts");
    expect(text(box)).toContain("Replace the overlapping draft payslips: 2 workers will be worked out for this period");
    expect(text(q("pcp-generate-draft-group-2026-01-26"))).toBe("26 Jan – 8 Feb 2026 (BiWeekly): 2 workers");
    expect(text(q("pcp-generate-draft-group-2026-02-09"))).toBe(
      "9 Feb – 22 Feb 2026 (BiWeekly): 1 worker, 1 marked Cleared",
    );
    expect(text(box)).toContain("Finalized or paid payslips are never replaced");
    expect((must("pcp-generate-replace") as HTMLInputElement).checked).toBe(true);
    expect(text(q("pcp-generate-confirm"))).toBe("Generate 1 · work out 1 again · 2 replace drafts");
    click(must("pcp-generate-confirm"));
    expect(h.trigger).toHaveBeenCalledWith({
      cycle: "weekly",
      periodStart: "2026-02-02",
      periodEnd: "2026-02-08",
      regenerate: true,
      replaceDrafts: true,
    });
  });

  it("leaves those workers out when unticked", async () => {
    world.people = [person(2, "Bala Worker", "PC-W2", { drafts: oldGrid }), ESHA];
    await openDialog();
    click(must("pcp-generate-replace"));
    expect(text(q("pcp-generate-drafts"))).toContain("these workers are left out of this run");
    expect(text(q("pcp-generate-ready"))).toBe("0 employees");
    expect((must("pcp-generate-confirm") as HTMLButtonElement).disabled).toBe(true);
  });
});
