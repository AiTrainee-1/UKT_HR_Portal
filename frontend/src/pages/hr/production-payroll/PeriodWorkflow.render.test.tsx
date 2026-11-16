import { act, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MovedOutRow, NewJoinerRow } from "@/lib/api-client/custom-hooks";
import { payroll, person, WEEK } from "./fixtures";
import {
  click,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  q,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// The period workflow on a Production Payroll cycle page (owner 2026-11-16): the period's status chip, Payroll Done (and
// why it is refused), the lock it leaves, Mark as Paid with the day the wages were paid, New Joiners (workers who joined
// during the period or moved here from another cycle, kept out until added), the Moved out view, the payment column and
// the bank file of the period's whole payroll.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  trigger: vi.fn(),
  toast: vi.fn(),
  download: vi.fn(),
  bank: vi.fn(),
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
vi.mock("@/lib/report-download", () => ({ downloadReportFile: h.download }));
vi.mock("@/lib/payrollExcelExport", () => ({ exportPayrollToExcel: h.bank }));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
});

const WEEKLY = "/hr/production-payroll/weekly";

async function openPayroll(url = WEEKLY) {
  mountPage(url);
  await waitFor(() => !!q("view-records-count") && !!q("pcp-period-status"), "the Payroll tab");
}

const finalized = {
  state: "finalized" as const,
  stateLabel: "Payroll Done",
  locked: true,
  finalizedAt: "2026-02-10T10:00:00+05:30",
  finalizedBy: "Priya",
};

const movedIn = (over: Partial<NewJoinerRow> = {}): NewJoinerRow => ({
  ...payroll(21, 4, "Devi Worker", "PC-M1", { newJoinerParked: true, parkedReason: "transfer", finalSalary: 1500 }),
  parked: true,
  parkedReason: "transfer",
  joinedOn: null,
  move: {
    id: 9,
    fromCycle: "monthly",
    fromLabel: "Monthly",
    cameFrom: "monthly",
    cameFromLabel: "Monthly",
    toCycle: "weekly",
    toLabel: "Weekly",
    changedAt: "2026-02-04T09:00:00+05:30",
    changedOn: "2026-02-04",
    changedBy: "Priya",
    reason: "Moved to the weekly line",
    lastPaidThrough: "2026-02-04",
    paysFrom: "2026-02-05",
    paidPeriods: 1,
    paidNet: 14000,
  },
  days: {
    periodDays: 7,
    eligibleDays: 4,
    excludedDays: 3,
    catchUpDays: 0,
    alreadyPaid: [
      {
        from: "2026-02-02",
        to: "2026-02-04",
        payrollId: 5,
        cycle: "monthly",
        kind: "production",
        label: "Monthly",
        status: "pending",
        periodStart: "2026-01-08",
        periodEnd: "2026-02-04",
      },
    ],
    catchUp: [],
    shifts: 4,
  },
  ...over,
});

describe("the period's status", () => {
  it("shows where the period stands beside the cycle's name and in the period picker", async () => {
    await openPayroll();
    await waitFor(() => !!q("pcp-header-state"), "the header chip");
    expect(must("pcp-header-state").dataset.state).toBe("generated");
    expect(text(q("pcp-header-state"))).toBe("Generated");
    expect(must("pcp-period-state").dataset.state).toBe("generated");
    expect(text(q("pcp-timeline-strip"))).toContain("Payroll Done");
  });

  it("Payroll Done asks the owner's question, then locks the period: no Generate, no Mark as Cleared", async () => {
    await openPayroll(`${WEEKLY}?layout=table`);
    await waitFor(() => !!q("payroll-record-markpaid-11"), "Mark as Cleared");
    click(must("pcp-period-status"));
    expect(text(must("pcp-finalize-question"))).toContain("permanently locked for this period");
    expect(text(q("pcp-finalize-summary"))).toContain("1 worker in the payroll");
    click(must("pcp-finalize-yes"));
    await waitFor(() => world.writes.length === 1, "the request");
    expect(world.writes[0]).toMatchObject({
      method: "POST",
      url: "/api/payroll/production/period-finalize",
      body: { cycle: "weekly", ...WEEK },
    });
    await waitFor(() => must("pcp-period-status").dataset.state === "finalized", "Payment Pending");
    expect(text(q("pcp-period-status"))).toContain("Payment Pending");
    expect(q("pcp-period-locked")).not.toBeNull();
    expect((must("pcp-generate-open") as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => !q("payroll-record-markpaid-11"), "Mark as Cleared to go");
  });

  it("Payroll Done cannot be pressed while someone waits in New Joiners, and says why", async () => {
    world.workflow = {
      finalizeBlockers: ["1 worker is still waiting in New Joiners. Add them to the payroll first."],
      can: { finalize: false, markPaid: false, addToPayroll: true, adjust: true, markCleared: true, generate: true },
    };
    await openPayroll();
    const button = must("pcp-period-status") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement!.getAttribute("title")).toContain("waiting in New Joiners");
  });

  it("Mark as Paid takes the day the wages were paid, refusing a day in the future", async () => {
    world.workflow = {
      ...finalized,
      can: { finalize: false, markPaid: true, addToPayroll: false, adjust: false, markCleared: false, generate: false },
    };
    await openPayroll();
    expect(text(q("pcp-period-status"))).toContain("Payment Pending");
    click(must("pcp-period-status"));
    expect(q("pcp-payment-timer")).not.toBeNull();
    click(must("pcp-mark-paid"));
    const day = must("pcp-paid-on") as HTMLInputElement;
    typeInto(day, "2999-01-01");
    await waitFor(() => !!q("pcp-paid-on-problem"), "the problem");
    expect(text(q("pcp-paid-on-problem"))).toContain("cannot be in the future");
    expect((must("pcp-paid-yes") as HTMLButtonElement).disabled).toBe(true);
    typeInto(day, "2026-02-09");
    await waitFor(() => !q("pcp-paid-on-problem"), "a good day");
    click(must("pcp-paid-yes"));
    await waitFor(() => world.writes.length === 1, "the request");
    expect(world.writes[0]).toMatchObject({
      url: "/api/payroll/production/period-paid",
      body: { cycle: "weekly", ...WEEK, paidOn: "2026-02-09" },
    });
    await waitFor(() => must("pcp-period-status").dataset.state === "paid", "Paid");
    expect(text(q("pcp-period-status-detail"))).toContain("9 Feb 2026");
  });
});

describe("New Joiners", () => {
  it("lists a worker who moved here, with the move and the days, and adds them to the payroll", async () => {
    world.newJoiners = { waiting: [movedIn()], waitingNet: 1500 };
    await openPayroll();
    await waitFor(() => !!q("pcp-new-joiners"), "the section");
    expect(text(q("pcp-nj-waiting-count"))).toBe("1");
    expect(text(q("pcp-nj-reason-PC-M1"))).toBe("Moved from Monthly → Weekly on 4 Feb 2026");
    expect(text(q("pcp-nj-days-PC-M1"))).toContain("4 days of 7 in the period");
    expect(text(q("pcp-nj-days-PC-M1"))).toContain("3 days already paid on Monthly, left out");
    click(must("pcp-nj-add-PC-M1"));
    await waitFor(() => world.writes.length === 1, "the request");
    expect(world.writes[0]).toMatchObject({
      url: "/api/payroll/production/new-joiners/add",
      body: { payrollIds: [21] },
    });
    await waitFor(() => !q("pcp-nj-waiting-count"), "nobody waiting");
    expect(text(q("pcp-new-joiners"))).toContain("Already added (1)");
  });

  it("names a new joiner by the day they joined, and adds everyone at once", async () => {
    const joiner: NewJoinerRow = {
      ...movedIn(),
      id: 22,
      employeeId: 5,
      employeeName: "Gita Worker",
      employeeCode: "PC-N2",
      parkedReason: "new_joiner",
      joinedOn: "2026-02-05",
      move: null,
      days: { ...movedIn().days, eligibleDays: 7, excludedDays: 0, alreadyPaid: [] },
    };
    world.newJoiners = { waiting: [movedIn(), joiner], waitingNet: 3000 };
    await openPayroll();
    await waitFor(() => !!q("pcp-nj-add-all"), "Add all");
    expect(text(q("pcp-nj-reason-PC-N2"))).toBe("Joined on 5 Feb 2026");
    expect(text(q("pcp-nj-days-PC-N2"))).toBe("7 eligible days");
    click(must("pcp-nj-add-all"));
    await waitFor(() => world.writes.length === 1, "the request");
    expect(world.writes[0].body).toMatchObject({ cycle: "weekly", ...WEEK, all: true });
  });

  it("is not shown while the period has nobody new", async () => {
    await openPayroll();
    expect(q("pcp-new-joiners")).toBeNull();
  });
});

describe("Moved out", () => {
  const out = (over: Partial<MovedOutRow> = {}): MovedOutRow => ({
    ...movedIn().move!,
    fromCycle: "weekly",
    fromLabel: "Weekly",
    toCycle: "biweekly",
    toLabel: "BiWeekly",
    paidPeriods: 6,
    paidNet: 21000,
    lastPaidThrough: "2026-02-08",
    employeeId: 7,
    employeeCode: "PC-X1",
    name: "Hari Worker",
    departmentName: "Weaving",
    employeeStatus: "active",
    currentCycle: "biweekly",
    generationsSince: 0,
    hidden: false,
    lastPayroll: { ...WEEK, payrollId: 31, status: "pending", paymentStatus: "not_paid", net: 3500 },
    ...over,
  });

  it("lists who moved to another cycle, what this cycle paid them, and shows older moves on request", async () => {
    world.movedOut = { moves: [out()], olderCount: 2 };
    await openPayroll(`${WEEKLY}?view=moved`);
    await waitFor(() => !!q("pcp-moved-row-PC-X1"), "the row");
    const row = text(q("pcp-moved-row-PC-X1"));
    expect(row).toContain("Moved to BiWeekly on 4 Feb 2026 by Priya");
    expect(row).toContain("Paid here up to 8 Feb 2026: 6 pay periods, ₹21,000 net");
    expect(row).toContain("Reason: Moved to the weekly line");
    click(must("pcp-moved-older"));
    await waitFor(
      () => world.requests().includes("/api/payroll/production/moved-out?cycle=weekly&older=1"),
      "the older moves",
    );
  });
});

describe("the records and the bank file", () => {
  it("say whether each payslip is paid", async () => {
    await openPayroll(`${WEEKLY}?layout=table`);
    await waitFor(() => !!q("payroll-record-payment-11"), "the payment cell");
    expect(text(q("payroll-record-payment-11"))).toBe("Not paid");
  });

  it("the bank file pays the period's whole payroll whatever the filters show, never a worker in New Joiners", async () => {
    world.people = [
      world.people[0],
      person(2, "Bala Worker", "PC-W2", {
        payroll: payroll(12, 2, "Bala Worker", "PC-W2", { newJoinerParked: true }),
      }),
      world.people[2],
    ];
    // a filter that shows nobody: the bank file still pays everyone in the period's payroll
    await openPayroll(`${WEEKLY}?status=paid`);
    click(must("pcp-export-bank"));
    expect(h.bank).toHaveBeenCalledTimes(1);
    expect(h.bank.mock.calls[0][0].map((r: { id: number }) => r.id)).toEqual([11]);
  });
});

const typeText = (el: HTMLTextAreaElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("Unlock (owner 2026-11-16)", () => {
  it("a finalized, unpaid period unlocks with a reason and is Generated again", async () => {
    world.workflow = {
      ...finalized,
      can: {
        finalize: false,
        markPaid: true,
        addToPayroll: false,
        adjust: false,
        markCleared: false,
        generate: false,
        unlock: true,
      },
    };
    await openPayroll();
    click(must("pcp-period-status"));
    click(must("unlock-open"));
    expect((must("unlock-yes") as HTMLButtonElement).disabled).toBe(true); // a reason first
    typeText(must("unlock-reason") as HTMLTextAreaElement, "Attendance corrected for two workers");
    click(must("unlock-yes"));
    await waitFor(() => world.writes.length === 1, "the request");
    expect(world.writes[0]).toMatchObject({
      url: "/api/payroll/production/period-unlock",
      body: { cycle: "weekly", ...WEEK, reason: "Attendance corrected for two workers" },
    });
    await waitFor(() => must("pcp-period-status").dataset.state === "generated", "Payroll Done again");
  });

  it("a paid period says it is locked for good, with nothing to press", async () => {
    world.workflow = {
      state: "paid",
      locked: true,
      finalizedAt: "2026-02-10T10:00:00+05:30",
      paidAt: "2026-02-11T10:00:00+05:30",
      paidOn: "2026-02-11",
      unlockBlocked: "Paid: locked for good. Once a pay period is paid its payroll can never be changed or unlocked.",
      can: {
        finalize: false,
        markPaid: false,
        addToPayroll: false,
        adjust: false,
        markCleared: false,
        generate: false,
      },
    };
    await openPayroll();
    click(must("pcp-period-status"));
    expect(text(q("unlock-blocked"))).toContain("Paid: locked for good");
    expect(q("unlock-open")).toBeNull();
  });
});
