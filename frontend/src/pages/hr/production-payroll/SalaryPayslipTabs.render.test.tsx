import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SalaryStatement } from "@/lib/api-client/custom-hooks";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { balaPaid, payroll, person } from "./fixtures";
import {
  click,
  here,
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
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// The Salary and Payslip tabs of a Production Payroll cycle page in jsdom, with a fake server behind customFetch: the
// period's Production Salary Statement (its columns, totals, export menu and row actions) and the cycle's payslips for a
// month, each with what the address keeps and what a View Only role may touch.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  xlsx: vi.fn(),
  pdf: vi.fn(),
  print: vi.fn(),
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "t", user: null }) }));
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
vi.mock("@/contexts/SalarySlipBulkContext", () => ({
  useSalarySlipBulk: () => ({
    isRunning: false,
    kind: null,
    showPipeline: false,
    progress: undefined,
    lastEmailResult: null,
    triggerBulkDownload: vi.fn(),
    triggerBulkEmail: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/contexts/WhatsAppBulkContext", () => ({
  useWhatsAppBulk: () => ({
    isRunning: false,
    showPipeline: false,
    progress: undefined,
    lastResult: null,
    triggerBulkWhatsApp: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("@/components/payroll/statement/export-statement-xlsx", () => ({ downloadStatementXlsx: h.xlsx }));
vi.mock("@/components/payroll/statement/export-statement-pdf", () => ({ downloadStatementPdf: h.pdf }));
vi.mock("@/components/payroll/statement/print-statement", () => ({ printStatement: h.print }));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  h.xlsx.mockResolvedValue(undefined);
  h.pdf.mockResolvedValue(undefined);
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
});

const SALARY = "/hr/production-payroll/weekly?tab=salary";
const PAYSLIP = "/hr/production-payroll/weekly?tab=payslip&month=2&year=2026";

/** Opens the Salary tab and waits for the statement. */
async function openSalary(url = SALARY) {
  mountPage(url);
  await waitFor(() => !!q("statement-table") || !!q("pcp-salary-empty"), "the Salary tab");
}

const rowIds = () =>
  [...document.body.querySelectorAll('[data-testid^="statement-row-"]')].map((r) =>
    Number(r.getAttribute("data-testid")!.replace("statement-row-", "")),
  );

describe("the Salary Statement", () => {
  it("is the period's production statement: the letterhead, the shift columns, the rows and the totals", async () => {
    world.people = [world.people[0], balaPaid(), world.people[2]];
    await openSalary();
    expect(text(q("statement-title"))).toBe("Production Salary Statement From 02-02-2026 To 08-02-2026");
    expect(text(q("statement-company"))).toBe("UKTextiles");
    const heads = text(q("statement-head-labels"));
    for (const label of ["SNO", "ID NO", "Name", "Rate / shift", "Shifts", "E salary", "ESI / EF", "NET", "Remarks"]) {
      expect(heads).toContain(label);
    }
    // the staff statement's day columns are not here
    for (const label of ["Present", "LOP", "PTRL", "Others Allow"]) expect(heads).not.toContain(label);
    expect(rowIds()).toEqual([11, 12]);
    expect(text(q("statement-row-11"))).toContain("PC-W1");
    expect(text(q("statement-row-11"))).toContain("Asha Worker");
    expect(text(q("statement-row-11"))).toContain("500.00");
    expect(text(q("statement-band-4"))).toContain("WEAVING");
    expect(text(q("statement-total"))).toContain("GRAND TOTAL");
    expect(text(q("statement-total"))).toContain("5,800.00");
    expect(text(q("statement-chip-employees"))).toBe("2 employees");
    expect(text(q("statement-chip-paid"))).toBe("1 cleared");
    expect(text(q("statement-chip-pending"))).toBe("1 pending");
    expect(text(q("statement-chips"))).toContain("Weekly");
  });

  it("asks the server for this cycle and period, and takes the amber accent of Production Payroll", async () => {
    await openSalary();
    expect(world.requests()).toContain(
      "/api/payroll/production/salary-statement?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08",
    );
    expect(must("statement-total").querySelector("td")!.className).toContain("bg-amber-600");
  });

  it("follows the pay period in the address", async () => {
    await openSalary(`${SALARY}&period=2026-01-26_2026-02-01`);
    // nothing was generated for that week
    expect(text(q("pcp-salary-empty"))).toContain("No payroll to show for 26 Jan - 1 Feb 2026");
    expect(q("statement-table")).toBeNull();
  });

  it("shows the skeleton of the paper while the statement loads", async () => {
    const release = world.hold("/api/payroll/production/salary-statement");
    mountPage(SALARY);
    await waitFor(() => !!q("statement-skeleton"), "the skeleton");
    expect(q("statement-table")).toBeNull();
    release();
    await waitFor(() => !!q("statement-table"), "the statement");
    expect(q("statement-skeleton")).toBeNull();
  });

  it("an error is a message with Retry, and Retry brings the statement", async () => {
    world.failing.set("/api/payroll/production/salary-statement", 500);
    mountPage(SALARY);
    await waitFor(() => !!q("statement-error"), "the error");
    world.failing.delete("/api/payroll/production/salary-statement");
    click(must("statement-retry"));
    await waitFor(() => !!q("statement-table"), "the statement");
    expect(q("statement-error")).toBeNull();
  });

  it("an empty period says to generate first, and the button goes to the Payroll tab", async () => {
    world.people = [];
    await openSalary();
    expect(text(q("pcp-salary-empty"))).toContain("No payroll to show for 2 Feb - 8 Feb 2026");
    expect(text(q("pcp-salary-empty"))).toContain("Generate the payroll first");
    click(must("pcp-salary-open-payroll"));
    expect(params().tab).toBeUndefined();
    await waitFor(() => !!q("pcp-payroll-tab"), "the Payroll tab");
    expect(q("pcp-salary-tab")).toBeNull();
  });

  it("keeps the toolbar in the address: search, department, status and Scroll / Pages", async () => {
    world.people = [world.people[0], balaPaid(), world.people[2]];
    await openSalary();
    typeInto(must("statement-search") as HTMLInputElement, "bala");
    expect(params()).toEqual({ tab: "salary", sq: "bala" });
    expect(rowIds()).toEqual([12]);
    typeInto(must("statement-search") as HTMLInputElement, "");
    press(must("statement-status"), "Enter");
    const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
    press(options[2], "Enter"); // Pending
    expect(params().sstatus).toBe("pending");
    expect(rowIds()).toEqual([11]);
    click(tab("Pages"));
    expect(params().sview).toBe("pages");
    expect(q("statement-pages")).not.toBeNull();
  });

  it("opens on the statement the address describes, as after Back from a details page", async () => {
    world.people = [world.people[0], balaPaid(), world.people[2]];
    await openSalary(`${SALARY}&sq=asha&sview=scroll`);
    expect((must("statement-search") as HTMLInputElement).value).toBe("asha");
    expect(rowIds()).toEqual([11]);
  });

  it("opens a payroll's details from the name, with the history Back needs", async () => {
    await openSalary();
    click(must("statement-details-11"));
    expect(here()).toBe("/hr/production-payroll/details/11");
    expect(window.history.state).toEqual({ fromPayroll: true });
  });
});

describe("the Export menu of the statement", () => {
  const openMenu = async () => {
    press(must("statement-export"), "Enter");
    await waitFor(() => !!q("statement-export-xlsx"), "the menu");
  };

  it("lists Excel, PDF and Print, and says what it exports", async () => {
    await openSalary();
    await openMenu();
    expect(text(q("statement-export-xlsx"))).toContain("Excel statement");
    expect(text(q("statement-export-pdf"))).toContain("PDF statement");
    expect(text(q("statement-export-print"))).toContain("Print");
    expect(text(document.body.querySelector('[role="menu"]'))).toContain("Exports all 1 employee");
  });

  it("hands the production statement to the exports", async () => {
    await openSalary();
    await openMenu();
    click(must("statement-export-xlsx"));
    await waitFor(() => h.xlsx.mock.calls.length === 1, "the Excel export");
    const sent = h.xlsx.mock.calls[0][0] as SalaryStatement;
    expect(sent.kind).toBe("production");
    expect(sent.title).toBe("Production Salary Statement From 02-02-2026 To 08-02-2026");
    expect(sent.columns.map((c) => c.key)).toContain("rate");
    expect(sent.groups[0].rows.map((r) => r.payrollId)).toEqual([11]);
    await settle(10);
  });
});

describe("the row actions of the statement", () => {
  it("adjusts a payslip's bonus and deductions, and the statement follows", async () => {
    await openSalary();
    click(must("pcp-salary-adjust-11"));
    const dialog = must("adjust-payroll-dialog");
    expect(text(dialog)).toContain("Asha Worker");
    expect(text(dialog)).toContain("2 Feb - 8 Feb 2026");
    typeInto(dialog.querySelector('input[name="bonus"]') as HTMLInputElement, "100");
    await waitFor(() => text(q("adjust-net-preview")).includes("3,100.00"), "the net preview");
    click([...dialog.querySelectorAll("button")].find((b) => text(b).includes("Apply Changes")));
    await waitFor(() => world.writes.length === 1, "the update");
    expect(world.writes[0]).toMatchObject({
      method: "PATCH",
      url: "/api/payroll/11",
      body: { bonus: 100, deductions: 500 },
    });
    expect(h.toast).toHaveBeenCalledWith({ title: "Adjustment applied successfully" });
    // the statement is reloaded with the new figures
    await waitFor(() => text(q("statement-row-11")).includes("3,100.00"), "the new net");
    await waitFor(() => !q("adjust-payroll-dialog"), "the dialog to close");
  });

  it("tells the adjuster that the deductions of a TDS employee include the TDS, and nobody else's do", async () => {
    await openSalary();
    click(must("pcp-salary-adjust-11"));
    expect(q("adjust-tds-note")).toBeNull();
    expect(text(must("adjust-payroll-dialog"))).toContain("PF and ESI for a Co Emp employee, TDS for a TDS employee");
    unmountPage();
    // Asha is on the TDS list now: 10% of her 3,500 earned gross is TDS, part of her 350 deductions
    world = installWorld(h.fetch, {
      people: [
        person(1, "Asha Worker", "PC-W1", {
          payroll: payroll(11, 1, "Asha Worker", "PC-W1", {
            deductions: 350,
            tdsDeduction: 350,
            tdsPercent: 10,
            finalSalary: 3150,
          }),
        }),
      ],
    });
    await openSalary();
    click(must("pcp-salary-adjust-11"));
    expect(text(must("adjust-tds-note"))).toBe(
      "This payslip includes TDS (10%): ₹350.00. Keep it in the figure if it is still to be deducted.",
    );
  });

  it("marks a pending payslip paid with Pay, and the button goes", async () => {
    await openSalary();
    expect(text(q("pcp-salary-pay-11"))).toBe("Mark as Cleared");
    click(must("pcp-salary-pay-11"));
    await waitFor(() => world.writes.length === 1, "the update");
    expect(world.writes[0]).toMatchObject({ method: "PATCH", url: "/api/payroll/11", body: { status: "paid" } });
    await waitFor(() => !q("pcp-salary-pay-11"), "the button to go");
    expect(text(q("statement-chip-paid"))).toBe("1 cleared");
  });

  it("offers Pay only while a payslip is pending, and Adjust always", async () => {
    world.people = [balaPaid()];
    await openSalary();
    expect(q("pcp-salary-pay-12")).toBeNull();
    expect(q("pcp-salary-adjust-12")).not.toBeNull();
  });

  it("a View Only role can search, export and open details, but not adjust or pay", async () => {
    await openSalary();
    lockMutatingControls(document.body);
    expect((must("pcp-salary-adjust-11") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pcp-salary-pay-11") as HTMLButtonElement).disabled).toBe(true);
    expect((must("statement-export") as HTMLButtonElement).disabled).toBe(false);
    expect((must("statement-details-11") as HTMLButtonElement).disabled).toBe(false);
    expect((must("statement-refresh") as HTMLButtonElement).disabled).toBe(false);
    typeInto(must("statement-search") as HTMLInputElement, "asha");
    expect(rowIds()).toEqual([11]);
  });
});

describe("the Payslip tab", () => {
  it("lists the cycle's payslips for the month in the address, with the register and the bulk actions", async () => {
    mountPage(PAYSLIP);
    await waitFor(() => !!q("pcp-slip-row-1"), "the payslips");
    expect(text(q("pcp-slip-row-1"))).toContain("Asha Worker");
    expect(text(q("pcp-slip-row-1"))).toContain("PC-W1");
    expect(text(q("pcp-slip-row-1"))).toContain("₹3,000.00");
    expect(q("pcp-payslip-tab")!.getAttribute("data-kind")).toBe("production");
    expect(text(q("pcp-slip-kpi-employees"))).toContain("1");
    expect(text(q("pcp-slip-kpi-net-value"))).toBe("₹3,000");
    expect(q("pcp-export")).not.toBeNull();
    expect(text(q("pcp-bulk-bar"))).toContain("Weekly");
    expect(world.requests()).toContain("/api/salary-slips?month=2&year=2026&employmentType=production&payCycle=weekly");
  });

  it("says there are no payslips for a month without any, and which cycle it is looking at", async () => {
    mountPage("/hr/production-payroll/weekly?tab=payslip&month=3&year=2026");
    await waitFor(() => !!q("pcp-slips-empty"), "the note");
    expect(text(q("pcp-slips-empty"))).toContain("No Weekly payslips for March 2026");
  });

  it("opens on this month when the address names none", async () => {
    mountPage("/hr/production-payroll/weekly?tab=payslip");
    await waitFor(() => !!q("pcp-slips-month"), "the Payslip tab");
    const now = new Date();
    expect((must("pcp-slips-month") as HTMLSelectElement).value).toBe(String(now.getMonth() + 1));
    expect((must("pcp-slips-year") as HTMLInputElement).value).toBe(String(now.getFullYear()));
  });

  it("has no pay period to pick: the Payslip tab is by month", async () => {
    mountPage(PAYSLIP);
    await waitFor(() => !!q("pcp-slip-row-1"), "the payslips");
    expect(q("pcp-period")).toBeNull();
    expect(q("pcp-period-bar")).toBeNull();
  });
});
