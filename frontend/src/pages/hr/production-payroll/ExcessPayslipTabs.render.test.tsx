import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { PREVIOUS_WEEK, excessEntry } from "./fixtures";
import {
  click,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  params,
  press,
  q,
  settle,
  tab,
  text,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// The Excess tab, the Payslip tab and the Payroll tab's Not included view of a Production Payroll cycle page in jsdom
// (owner 2026-11-20: "the same payroll update as Staff Payroll"), with a fake server behind customFetch. Each is the
// shared Staff Payroll component scoped to the page's cycle and pay period: the requests name the cycle and the period,
// the writes carry them, the page keeps its amber, and an Excess change reloads the period's payroll.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn(), downloadBlob: vi.fn() }));

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
    triggerGenerateProduction: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("@/lib/exportUtils", async (original) => ({
  ...(await original<typeof import("@/lib/exportUtils")>()),
  downloadBlob: h.downloadBlob,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.unstubAllGlobals();
});

const WEEKLY = "/hr/production-payroll/weekly";
const EXCESS = `${WEEKLY}?tab=salary`;
const PAYSLIP = `${WEEKLY}?tab=payslip`;
const NOT_INCLUDED = `${WEEKLY}?view=not_included`;
const PERIOD_QUERY = "cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08";

/** Types into an input or a textarea the way React sees it. */
function typeText(el: HTMLElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const type = async (id: string, value: string) => {
  typeText(must(id), value);
  await settle();
};

async function openExcess(url = EXCESS) {
  mountPage(url);
  await waitFor(() => !!q("excess-summary"), "the Excess tab");
}

/** Asha (on the payroll of the week) with a 200 Excess and a 50 Detection. */
const withAshaEntries = () => {
  world.excess = [
    excessEntry(1, 1, { amount: 200 }),
    excessEntry(2, 1, { kind: "detection", amount: 50, remark: "Damaged cloth on the loom" }),
  ];
};

// ── the Excess tab ────────────────────────────────────────────────────────────

describe("the Excess tab", () => {
  it("is the old Salary tab: the same tab in the address, named Excess", async () => {
    await openExcess();
    expect(tab("Excess").getAttribute("aria-selected")).toBe("true");
    expect(tab("Salary")).toBeUndefined();
    expect(params()).toEqual({ tab: "salary" });
  });

  it("asks for this cycle and pay period, and shows its figures in the page's amber", async () => {
    withAshaEntries();
    await openExcess();
    expect(world.requests()).toContain(`/api/production-payroll-excess/period?${PERIOD_QUERY}`);
    expect(q("excess-tab")!.dataset.kind).toBe("production");
    expect(text(q("excess-title"))).toBe("Excess & Detection · Weekly 2 Feb - 8 Feb 2026");
    expect(text(q("excess-kpi-excess-value"))).toBe("₹200");
    expect(text(q("excess-kpi-detection-value"))).toBe("₹50");
    expect(text(q("excess-kpi-net-value"))).toBe("+₹150");
    expect(text(q("excess-kpi-entries"))).toContain("Active this period");
    // earned = the period's gross (shifts x rate) before and after
    expect(text(q("excess-row-earned-PC-W1"))).toBe("Earned ₹3,500 → ₹3,650");
    expect(text(q("excess-row-state-PC-W1"))).toBe("In payroll");
    expect(must("excess-add-open").className).toContain("bg-amber-600");
    expect(must("excess-add-open").className).not.toContain("indigo");
  });

  it("follows the pay period in the address", async () => {
    withAshaEntries();
    await openExcess(`${EXCESS}&period=${PREVIOUS_WEEK.periodStart}_${PREVIOUS_WEEK.periodEnd}`);
    expect(world.requests()).toContain(
      "/api/production-payroll-excess/period?cycle=weekly&periodStart=2026-01-26&periodEnd=2026-02-01",
    );
    // nothing was generated for that week, and nothing was added to it
    expect(text(q("excess-not-generated-note"))).toContain("Weekly 26 Jan - 1 Feb 2026 is not generated yet");
    expect(text(q("excess-empty"))).toContain("No excess or detection for Weekly 26 Jan - 1 Feb 2026");
  });

  it("adds an excess with its mandatory remark, for the cycle and period, and a worker without a rate cannot be picked", async () => {
    await openExcess();
    click(must("excess-add-open"));
    await waitFor(() => !!q("excess-option-3"), "the picker");
    expect((must("excess-option-3") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q("excess-option-3"))).toContain("No salary per shift on the profile");
    expect(text(q("excess-picker"))).toContain("3 production employees");
    click(must("excess-add-save"));
    await settle();
    expect(text(q("excess-remark-error"))).toBe("A remark is required.");
    expect(world.writes).toEqual([]);
    await type("excess-amount", "300");
    await type("excess-remark", "Extra loom cleaning on Sunday");
    click(must("excess-option-1"));
    click(must("excess-add-save"));
    await waitFor(() => world.writes.length === 1, "the add");
    expect(world.writes[0]).toEqual({
      method: "POST",
      url: "/api/production-payroll-excess/entries",
      body: {
        cycle: "weekly",
        periodStart: "2026-02-02",
        periodEnd: "2026-02-08",
        kind: "excess",
        amount: 300,
        remark: "Extra loom cleaning on Sunday",
        employeeIds: [1],
      },
    });
    expect(h.toast).toHaveBeenCalledWith({
      title: "Excess of ₹300 added for Asha Worker",
      description: "1 payroll updated at once: earned salary and NET.",
    });
    await waitFor(() => text(q("excess-kpi-excess-value")) === "₹300", "the figures to reload");
    expect(text(q("excess-row-netpay-PC-W1"))).toBe("NET pay ₹3,300");
  });

  it("reloads the period's payroll after a change, so the Payroll tab shows the new NET", async () => {
    mountPage(`${WEEKLY}?layout=table`);
    await waitFor(() => text(q("payroll-record-row-11")).includes("₹3,000"), "the payroll");
    click(tab("Excess"));
    await waitFor(() => !!q("excess-summary"), "the Excess tab");
    click(must("excess-add-open"));
    await waitFor(() => !!q("excess-option-1"), "the picker");
    await type("excess-amount", "300");
    await type("excess-remark", "Extra loom cleaning on Sunday");
    click(must("excess-option-1"));
    click(must("excess-add-save"));
    await waitFor(() => world.writes.length === 1, "the add");
    await waitFor(() => !q("excess-add-dialog"), "the dialog to close");
    click(tab("Payroll"));
    await waitFor(() => text(q("payroll-record-row-11")).includes("₹3,300"), "the new NET on the Payroll tab");
  });

  it("changes and removes an entry, each with a reason, on the production endpoints", async () => {
    withAshaEntries();
    await openExcess();
    click(must("excess-row-toggle-PC-W1"));
    click(must("excess-entry-change-1"));
    await waitFor(() => !!q("excess-change-dialog"), "the change dialog");
    await type("excess-change-amount", "250");
    await type("excess-change-reason", "Corrected after the supervisor's count");
    click(must("excess-change-save"));
    await waitFor(() => world.writes.length === 1, "the change");
    expect(world.writes[0]).toEqual({
      method: "PATCH",
      url: "/api/production-payroll-excess/entries/1",
      body: { amount: 250, remark: "Corrected after the supervisor's count" },
    });
    await waitFor(() => !q("excess-change-dialog"), "the dialog to close");
    await waitFor(() => text(q("excess-kpi-excess-value")) === "₹250", "the new figure");

    click(must("excess-entry-remove-2"));
    await waitFor(() => !!q("excess-remove-dialog"), "the remove dialog");
    click(must("excess-remove-save"));
    await settle();
    expect(text(q("excess-remove-reason-error"))).toBe("A reason is required.");
    await type("excess-remove-reason", "The cloth was not damaged");
    click(must("excess-remove-save"));
    await waitFor(() => world.writes.length === 2, "the removal");
    expect(world.writes[1]).toEqual({
      method: "POST",
      url: "/api/production-payroll-excess/remove",
      body: { entryIds: [2], remark: "The cloth was not damaged" },
    });
    await waitFor(() => text(q("excess-kpi-detection-value")) === "₹0", "the detection to go");
  });

  it("a period finalized with Payroll Done is locked: no add, no change, no remove", async () => {
    withAshaEntries();
    world.workflow = { state: "finalized", locked: true };
    await openExcess();
    expect(text(q("excess-locked-note"))).toContain("Weekly 2 Feb - 8 Feb 2026 is finalized (Payroll Done)");
    expect((must("excess-add-open") as HTMLButtonElement).disabled).toBe(true);
    expect(q("excess-pick-PC-W1")).toBeNull();
    click(must("excess-row-toggle-PC-W1"));
    expect(q("excess-entry-remark-1")).not.toBeNull();
    expect(q("excess-entry-change-1")).toBeNull();
    expect(q("excess-entry-remove-1")).toBeNull();
  });

  it("a View-only tab can look but not add, change or remove", async () => {
    withAshaEntries();
    await openExcess();
    lockMutatingControls(document.body);
    expect((must("excess-add-open") as HTMLButtonElement).disabled).toBe(true);
    click(must("excess-row-toggle-PC-W1"));
    lockMutatingControls(document.body);
    expect((must("excess-entry-remove-1") as HTMLButtonElement).disabled).toBe(true);
    expect((must("excess-export") as HTMLButtonElement).disabled).toBe(false);
    expect((must("excess-row-toggle-PC-W1") as HTMLButtonElement).disabled).toBe(false);
  });

  it("the History view asks for this cycle: the period, or every period of the cycle", async () => {
    withAshaEntries();
    world.excessHistory = [
      {
        id: 1,
        entryId: 1,
        employeeId: 1,
        code: "PC-W1",
        name: "Asha Worker",
        department: "Weaving",
        cycle: "weekly",
        periodStart: "2026-02-02",
        periodEnd: "2026-02-08",
        kind: "excess",
        action: "added",
        source: "manual",
        previousAmount: null,
        newAmount: 200,
        remark: "Festival incentive approved by MD",
        by: "HR",
        at: "2026-02-09T11:00:00+05:30",
        payrollNetBefore: 3000,
        payrollNetAfter: 3200,
      },
    ];
    await openExcess();
    click(must("excess-view-history"));
    await waitFor(() => !!q("excess-history-row-1"), "the history");
    expect(world.requests()).toContain(`/api/production-payroll-excess/history?${PERIOD_QUERY}&page=1&pageSize=50`);
    expect(text(q("excess-history-row-1"))).toContain("New ₹200");
    press(must("excess-history-month"), "Enter");
    const every = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => text(o) === "Every Weekly period",
    )!;
    press(every, "Enter");
    await waitFor(
      () => world.requests().includes("/api/production-payroll-excess/history?cycle=weekly&page=1&pageSize=50"),
      "every period of the cycle",
    );
    await waitFor(() => text(q("excess-history-row-1")).includes("for 2 Feb - 8 Feb 2026"), "the period of the line");
  });
});

// ── the Payslip tab ───────────────────────────────────────────────────────────

describe("the Payslip tab", () => {
  it("lists the period's payslips with the production columns", async () => {
    withAshaEntries();
    mountPage(PAYSLIP);
    await waitFor(() => !!q("ps-row-11"), "the payslips");
    expect(world.requests()).toContain(`/api/payslips/production?${PERIOD_QUERY}`);
    expect(q("pcp-payslip-tab")!.dataset.kind).toBe("production");
    expect(text(q("ps-heading"))).toBe("Weekly 2 Feb - 8 Feb 2026 · 1 payslip");
    expect(text(q("ps-row-11"))).toContain("Asha Worker");
    expect(text(q("ps-row-11-rate"))).toBe("₹500");
    expect(text(q("ps-row-11-shifts"))).toBe("7");
    expect(text(q("ps-row-11-days"))).toBe("7");
    expect(text(q("ps-row-11-excess"))).toBe("+₹200");
    expect(text(q("ps-row-11-detection"))).toBe("−₹50");
    // each figure is labelled on a phone (the label is hidden from md up, where the header names the column)
    expect(text(q("ps-row-11"))).toContain("Rate / shift₹500");
    expect(text(q("ps-row-11-net"))).toBe("₹3,000");
    expect(text(q("ps-kpi-excess-value"))).toBe("₹200");
    // only the period's payroll: Bala (not generated) and Esha (no rate) have no payslip
    expect(q("ps-row-12")).toBeNull();
    // the period is the page's: the picker is shown
    expect(text(q("pcp-period"))).toBe("2 Feb - 8 Feb 2026 Next due");
  });

  it("opens a payslip's breakdown: the rate, the shifts and the lines the PDF prints", async () => {
    withAshaEntries();
    mountPage(PAYSLIP);
    await waitFor(() => !!q("ps-row-11-open"), "the payslips");
    click(must("ps-row-11-open"));
    await waitFor(() => !!q("ps-sheet"), "the sheet");
    const sheet = text(q("ps-sheet"));
    expect(sheet).toContain("Rate per shift₹500.00");
    expect(sheet).not.toContain("Monthly salary");
    expect(text(q("ps-sheet-day-shifts"))).toBe("7");
    expect(text(q("ps-sheet-day-daysWorked"))).toBe("7");
    expect(text(q("ps-sheet-day-absent"))).toBe("0");
    expect(text(q("ps-sheet-earnings"))).toContain("Excess (added by HR)₹200.00");
    expect(text(q("ps-sheet-earnings"))).toContain("Detection (taken off by HR)−₹50.00");
    expect(text(q("ps-sheet-earnings-total"))).toBe("₹3,650.00");
    click(must("ps-sheet-open-payroll"));
    expect(window.location.pathname).toBe("/hr/production-payroll/details/11");
  });

  it("downloads one PDF of the payslips picked, for this period", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(new Blob(["%PDF-1.4"]), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="Payslips-Weekly-02-Feb-2026.pdf"',
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    mountPage(PAYSLIP);
    await waitFor(() => !!q("ps-row-11-pick"), "the payslips");
    click(must("ps-row-11-pick"));
    expect(text(q("ps-picked-count"))).toBe("1 picked");
    click(must("ps-download-picked"));
    await waitFor(() => h.downloadBlob.mock.calls.length === 1, "the download");
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/api/payslips/production/pdf?${PERIOD_QUERY}&ids=11&layout=single`,
    );
    expect(h.downloadBlob.mock.calls[0][1]).toBe("Payslips-Weekly-02-Feb-2026.pdf");
    expect(h.toast).toHaveBeenCalledWith({
      title: "Payslip downloaded",
      description: "Payslips-Weekly-02-Feb-2026.pdf",
    });
  });

  it("says to generate first for a period without a payroll, and goes to the Payroll tab", async () => {
    mountPage(`${PAYSLIP}&period=${PREVIOUS_WEEK.periodStart}_${PREVIOUS_WEEK.periodEnd}`);
    await waitFor(() => !!q("ps-empty"), "the note");
    expect(text(q("ps-empty"))).toContain("No payroll for Weekly 26 Jan - 1 Feb 2026 yet: generate the payroll first");
    click(must("ps-open-payroll-tab"));
    await waitFor(() => !!q("pcp-payroll-tab"), "the Payroll tab");
    expect(params().tab).toBeUndefined();
  });

  it("says Finalized for a period locked by Payroll Done", async () => {
    world.workflow = { state: "finalized", locked: true };
    mountPage(PAYSLIP);
    await waitFor(() => !!q("ps-row-11"), "the payslips");
    expect(text(q("pcp-payslip-tab"))).toContain("Finalized: locked");
  });
});

// ── the Not included view ─────────────────────────────────────────────────────

describe("the Not included view of the Payroll tab", () => {
  it("lists the production employees not in the period's payroll, with the reason, Production first", async () => {
    mountPage(NOT_INCLUDED);
    await waitFor(() => !!q("ni-row-2"), "the list");
    expect(world.requests()).toContain(`/api/payroll/production/not-included?${PERIOD_QUERY}`);
    expect(q("not-included-view")!.dataset.kind).toBe("production");
    expect(text(q("ni-category"))).toBe("Production");
    // Bala would be paid, Esha has no rate, Banu is on another cycle; Siva is staff (not listed by default)
    expect(text(q("ni-row-2-reason"))).toContain("Would be paid");
    expect(q("ni-row-3")!.dataset.reason).toBe("no_salary");
    expect(text(q("ni-row-3"))).toContain("No rate per shift");
    expect(q("ni-row-91")!.dataset.reason).toBe("other_cycle");
    expect(q("ni-row-90")).toBeNull();
    expect(text(q("ni-count"))).toBe("3 production employees not in the payroll");
    expect(text(q("view-not_included-count"))).toBe("3");
    // the payroll exists and Bala is not in it: generate again
    expect(text(q("ni-generate-again"))).toContain("1 worker would be paid but is not in the payroll.");
  });

  it("the Staff chip shows the staff employees, and the category follows it", async () => {
    mountPage(NOT_INCLUDED);
    await waitFor(() => !!q("ni-reason-chip-staff"), "the chips");
    click(must("ni-reason-chip-staff"));
    await waitFor(() => !!q("ni-row-90"), "the staff employee");
    expect(params()).toMatchObject({ view: "not_included", nicat: "staff", nireason: "staff" });
    expect(q("ni-row-2")).toBeNull();
    click(must("ni-clear"));
    await waitFor(() => !!q("ni-row-2"), "the production list again");
    expect(params()).toEqual({ view: "not_included" });
  });

  it("opens the Generate dialog from the banner", async () => {
    mountPage(NOT_INCLUDED);
    await waitFor(() => !!q("ni-generate-again-button"), "the banner");
    click(must("ni-generate-again-button"));
    await waitFor(() => !!q("pcp-generate-dialog"), "the Generate dialog");
  });

  it("has no Generate button on a period finalized with Payroll Done", async () => {
    world.workflow = { state: "finalized", locked: true };
    mountPage(NOT_INCLUDED);
    await waitFor(() => !!q("ni-generate-again"), "the banner");
    expect(q("ni-generate-again-button")).toBeNull();
  });
});
