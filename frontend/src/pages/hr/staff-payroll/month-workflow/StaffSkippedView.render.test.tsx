import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayrollMonthSkipped, PayrollMonthStatus } from "@/lib/api-client/custom-hooks";
import { monthStatus, run } from "./fixtures";
import { StaffSkippedView } from "./StaffSkippedView";

// Skipped Employees of a staff month in jsdom (owner 2026-11-10): the four groups, Unhold and Add to payroll before
// Payroll Done, Release & pay (with a one-person bank file) after it, and the section's own two exports (the main
// payroll's statement and bank file, for the skipped employees only).

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn(), bank: vi.fn(), report: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("@/lib/payrollExcelExport", async (original) => ({
  ...(await original<typeof import("@/lib/payrollExcelExport")>()),
  exportPayrollToExcel: h.bank,
}));
vi.mock("@/lib/report-download", () => ({ downloadReportFile: h.report }));

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

let root: Root | null = null;
let host: HTMLElement | null = null;
const posts: { url: string; body: unknown }[] = [];

const HELD = run({ id: 11, employeeId: 111, employeeName: "Hari Held", employeeCode: "H1", onHold: true });
const NEW = run({ id: 12, employeeId: 112, employeeName: "Nila New", employeeCode: "N1", newJoinerParked: true });
const PAID = run({
  id: 13,
  employeeId: 113,
  employeeName: "Pooja Paid",
  employeeCode: "P1",
  releasedFrom: "hold",
  paymentStatus: "paid",
  paymentPaidAt: "2026-11-20T05:00:00Z",
});
const LISTS: PayrollMonthSkipped = {
  month: 10,
  year: 2026,
  locked: false,
  onHold: [HELD],
  newJoiners: [NEW],
  paidSeparately: [],
};
const NOT_GENERATED = [
  { employeeId: 9, employeeCode: "X9", name: "Divya Nair", reason: "No Salary Amount set on this employee's profile" },
];

beforeEach(() => {
  vi.clearAllMocks();
  posts.length = 0;
  h.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/payroll-settings") return { companyName: "UK Textiles Test" };
    posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/release-and-pay"))
      return {
        ...HELD,
        onHold: false,
        releasedFrom: "hold",
        paymentStatus: "paid",
        paymentPaidAt: "2026-11-21T05:00:00Z",
      };
    return HELD;
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

function mount(status: PayrollMonthStatus, lists: PayrollMonthSkipped = LISTS) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(StaffSkippedView, {
          month: 10,
          year: 2026,
          periodLabel: "October 2026",
          status,
          lists,
          notGenerated: NOT_GENERATED,
          totalChecked: 40,
        }),
      ),
    ),
  );
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const LOCKED = monthStatus({
  state: "finalized",
  locked: true,
  finalizedAt: "2026-11-10T07:48:00Z",
  can: { finalize: false, markPaid: true, hold: false, addToPayroll: false, releaseAndPay: true },
});

describe("the groups", () => {
  it("lists not generated, on hold and new joiners, each employee once, with a count each", () => {
    mount(monthStatus());
    expect(text(q("skipped-chip-not_generated"))).toBe("Not generated: 1");
    expect(text(q("skipped-chip-on_hold"))).toBe("On hold: 1");
    expect(text(q("skipped-chip-new_joiner"))).toBe("New joiners: 1");
    expect(text(q("skipped-chip-paid_separately"))).toBe("Paid separately: 0");
    expect(text(q("skipped-on_hold-row-H1"))).toContain("Hari Held");
    expect(text(q("skipped-on_hold-row-H1"))).toContain("₹23,000");
    expect(text(q("skipped-new_joiner-row-N1"))).toContain("New joiner");
    expect(q("skipped-row-X9")).not.toBeNull(); // the engine's own skip list, as before
    expect(q("skipped-group-paid_separately")).toBeNull(); // nobody paid separately: no empty group
    expect(q("skipped-locked-note")).toBeNull();
  });
});

describe("before Payroll Done", () => {
  it("Unhold takes the hold off", async () => {
    mount(monthStatus());
    expect(q("skipped-release-11")).toBeNull();
    click(q("skipped-unhold-11"));
    await settle();
    expect(posts).toEqual([{ url: "/api/payroll/11/hold", body: { hold: false } }]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Hari Held's salary is no longer on hold" }));
  });

  it("Add to payroll brings a new joiner in", async () => {
    mount(monthStatus());
    click(q("skipped-add-12"));
    await settle();
    expect(posts).toEqual([{ url: "/api/payroll/12/add-to-payroll", body: {} }]);
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Nila New added to the October 2026 payroll" }),
    );
  });

  it("both are off for a login that cannot change them", () => {
    mount(
      monthStatus({
        can: { finalize: false, markPaid: false, hold: false, addToPayroll: false, releaseAndPay: false },
      }),
    );
    expect((q("skipped-unhold-11") as HTMLButtonElement).disabled).toBe(true);
    expect((q("skipped-add-12") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("after Payroll Done", () => {
  it("offers only Release & pay, asks first, then offers a bank file of just that person", async () => {
    mount(LOCKED);
    expect(text(q("skipped-locked-note"))).toContain("October 2026 is finalized");
    expect(q("skipped-unhold-11")).toBeNull();
    expect(q("skipped-add-12")).toBeNull();
    click(q("skipped-release-11"));
    expect(text(q("skipped-release-dialog"))).toContain("Hari Held leaves On hold, is marked Paid today");
    click(q("skipped-release-yes"));
    await settle();
    await settle();
    expect(posts).toEqual([{ url: "/api/payroll/11/release-and-pay", body: {} }]);
    click(q("skipped-release-bankfile"));
    expect(h.bank).toHaveBeenCalledTimes(1);
    const [rows, sheet, month] = h.bank.mock.calls[0];
    expect(rows.map((r: { id: number }) => r.id)).toEqual([11]);
    expect(sheet).toBe("Staff Hari_Held");
    expect(month).toBe("October 2026");
  });

  it("Cancel releases nobody", () => {
    mount(LOCKED);
    click(q("skipped-release-12"));
    click(q("skipped-release-cancel"));
    expect(posts).toEqual([]);
  });

  it("a unit login cannot release and pay", () => {
    mount({ ...LOCKED, wholeCompany: false, can: { ...LOCKED.can, releaseAndPay: false } });
    expect((q("skipped-release-11") as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists those paid separately, each with their own bank file", () => {
    mount(LOCKED, { ...LISTS, locked: true, onHold: [], paidSeparately: [PAID] });
    expect(text(q("skipped-paid_separately-row-P1"))).toContain("released and paid separately on 20 Nov 2026");
    click(q("skipped-bankfile-13"));
    expect(h.bank.mock.calls[0][0].map((r: { id: number }) => r.id)).toEqual([13]);
  });
});

describe("the section's own exports: the main payroll's two, for the skipped employees only", () => {
  it("Export offers the Salary Payroll Statement as Excel and PDF: the Report Center's own, section=skipped", async () => {
    mount(monthStatus());
    press(q("skipped-section-export")!, "Enter");
    await settle();
    expect(text(q("skipped-section-export-statement-xlsx"))).toContain("Salary Payroll Statement (Excel)");
    expect(text(q("skipped-section-export-statement-pdf"))).toContain("Salary Payroll Statement (PDF)");
    click(q("skipped-section-export-statement-xlsx"));
    await settle();
    expect(h.report).toHaveBeenCalledTimes(1);
    const args = h.report.mock.calls[0][0];
    expect([args.reportId, args.format, args.query.toString()]).toEqual([
      "hr-salary-statement",
      "xlsx",
      "period=2026-10&section=skipped",
    ]);
    press(q("skipped-section-export")!, "Enter");
    await settle();
    click(q("skipped-section-export-statement-pdf"));
    await settle();
    expect(h.report.mock.calls[1][0].format).toBe("pdf");
  });

  it("Export bank file pays only the held and new employees, in the month's bank format, marked as the skipped list", () => {
    mount(monthStatus());
    click(q("skipped-section-bank"));
    expect(h.bank).toHaveBeenCalledTimes(1);
    const [rows, sheet, month, section] = h.bank.mock.calls[0];
    expect(rows.map((r: { employeeCode: string }) => r.employeeCode)).toEqual(["H1", "N1"]);
    expect([sheet, month, section]).toEqual(["Staff Skipped", "October_2026", "skipped"]);
  });

  it("never offers someone already paid, and is off when nobody is waiting", () => {
    mount(LOCKED, { ...LISTS, locked: true, onHold: [], newJoiners: [], paidSeparately: [PAID] });
    expect((q("skipped-section-bank") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says the employees with no payroll yet are in neither file", () => {
    mount(monthStatus());
    expect(text(q("skipped-section-export-note"))).toBe(
      "1 employee with no payroll yet (Not generated) is not in these files: there are no figures for them.",
    );
    // the old list export of the Not generated table is gone: the section has only these two
    expect(q("skipped-export")).toBeNull();
  });
});
