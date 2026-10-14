import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SalarySlipItem } from "@/lib/api-client/custom-hooks";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { PayslipsPanel, type PayslipsPanelProps } from "./PayslipsPanel";
import { REGISTER_COLUMNS } from "./payslips-logic";

// The payslips panel in jsdom with its hooks and contexts faked: loaders, errors and empty states, the month's figures,
// the search / department / "not yet emailed" filters, each slip's four actions with their spinners, the bulk actions
// (always the whole month, whatever is filtered), the register export, and what the view-only lock may touch.

const h = vi.hoisted(() => ({
  slips: vi.fn(),
  emailSlip: vi.fn(),
  whatsappSlip: vi.fn(),
  preview: vi.fn(),
  download: vi.fn(),
  toast: vi.fn(),
  refetch: vi.fn(),
  bulk: vi.fn(),
  whatsappBulk: vi.fn(),
  triggerEmail: vi.fn(),
  triggerDownload: vi.fn(),
  triggerWhatsApp: vi.fn(),
  excel: vi.fn(),
  csv: vi.fn(),
  settings: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "tok-123", user: null }) }));
vi.mock("@/contexts/SalarySlipBulkContext", () => ({ useSalarySlipBulk: () => h.bulk() }));
vi.mock("@/contexts/WhatsAppBulkContext", () => ({ useWhatsAppBulk: () => h.whatsappBulk() }));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  useListSalarySlips: (params: unknown) => h.slips(params),
  useEmailSalarySlip: () => ({ mutateAsync: h.emailSlip }),
  useWhatsAppSalarySlip: () => ({ mutateAsync: h.whatsappSlip }),
  usePayrollSettings: () => ({ data: h.settings() }),
  previewDocumentPdf: h.preview,
  downloadDocumentPdf: h.download,
}));
vi.mock("@/components/payroll/kit/export-table", () => ({ exportTableToExcel: h.excel, exportTableToCsv: h.csv }));

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

const idleBulk = (over = {}) => ({
  isRunning: false,
  kind: null,
  showPipeline: false,
  progress: undefined,
  lastEmailResult: null,
  triggerBulkDownload: h.triggerDownload,
  triggerBulkEmail: h.triggerEmail,
  dismiss: vi.fn(),
  ...over,
});
const idleWhatsApp = (over = {}) => ({
  isRunning: false,
  showPipeline: false,
  progress: undefined,
  lastResult: null,
  triggerBulkWhatsApp: h.triggerWhatsApp,
  dismiss: vi.fn(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.bulk.mockReturnValue(idleBulk());
  h.whatsappBulk.mockReturnValue(idleWhatsApp());
  h.triggerEmail.mockResolvedValue(null);
  h.triggerDownload.mockResolvedValue(undefined);
  h.triggerWhatsApp.mockResolvedValue(null);
  h.emailSlip.mockResolvedValue({ ok: true, sentTo: "asha@example.com" });
  h.whatsappSlip.mockResolvedValue({ ok: true, sentTo: "+91 98765 43210" });
  h.preview.mockResolvedValue(undefined);
  h.download.mockResolvedValue(undefined);
  h.excel.mockResolvedValue(undefined);
  h.settings.mockReturnValue({ companyName: "UK Textiles Pvt Ltd" });
  h.refetch.mockResolvedValue(undefined);
  serve(SLIPS);
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const slip = (id: number, name: string, code: string, over: Partial<SalarySlipItem> = {}): SalarySlipItem =>
  ({
    id,
    employeeId: id * 10,
    employeeCode: code,
    employeeName: name,
    departmentName: "Weaving",
    designationTitle: "Operator",
    month: 10,
    year: 2026,
    slipNumber: `SLP-2026-10-${code}`,
    grossSalary: 30000,
    totalDeductions: 1500,
    netSalary: 28500,
    emailedAt: null,
    ...over,
  }) as SalarySlipItem;

const SLIPS: SalarySlipItem[] = [
  slip(1, "Asha Kumar", "E001", { emailedAt: "2026-10-12T09:30:00+05:30" }),
  slip(2, "Ravi Nair", "E002", {
    departmentName: "Stitching",
    grossSalary: 20000,
    totalDeductions: 0,
    netSalary: 20000,
  }),
  slip(3, "Meena Das", "E003", { departmentName: null, designationTitle: null }),
  slip(4, "Bala Worker", "PC-W2", { departmentName: "Stitching", emailedAt: "2026-10-13T08:00:00+05:30" }),
];
// gross 1,10,000 · deductions 4,500 · net 1,05,500 · 4 employees · 2 not yet emailed

function serve(rows: SalarySlipItem[] | undefined, over: Record<string, unknown> = {}) {
  h.slips.mockReturnValue({
    data: rows,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: h.refetch,
    ...over,
  });
}

function mount(props: Partial<PayslipsPanelProps> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(createElement(PayslipsPanel, { kind: "staff", accent: "indigo", month: 10, year: 2026, ...props })),
  );
  return host;
}
const unmount = () => {
  act(() => root!.unmount());
  host!.remove();
};

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the panel shows: ${text(host)}`);
  return el;
};
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
const typeInto = (input: HTMLElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const pick = (select: HTMLElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const choose = (testId: string, optionText: string) => {
  press(must(testId), "ArrowDown");
  const option = [...document.body.querySelectorAll('[role="option"]')].find((o) => text(o) === optionText);
  if (!option) throw new Error(`no option "${optionText}"`);
  click(option);
};
const rows = () => [...document.body.querySelectorAll('[data-testid^="sp-slip-row-"]')];
const rowNames = () => rows().map((r) => text(r.querySelector("p.font-bold")));
const lastParams = () => h.slips.mock.calls.at(-1)?.[0] as Record<string, unknown>;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("while the slips load", () => {
  it("shows a skeleton in every figure and skeleton rows, and nothing to press", () => {
    serve(undefined, { isLoading: true });
    mount();
    for (const tile of ["employees", "gross", "deductions", "net"]) {
      expect(must(`sp-slip-kpi-${tile}`).querySelector('[data-slot="skeleton"]'), tile).not.toBeNull();
      expect(q(`sp-slip-kpi-${tile}-value`), tile).toBeNull();
    }
    expect(q("skeleton-rows")).not.toBeNull();
    expect(rows()).toHaveLength(0);
    expect((must("sp-bulk-email") as HTMLButtonElement).disabled).toBe(true);
    expect((must("sp-bulk-download") as HTMLButtonElement).disabled).toBe(true);
    expect((must("sp-export") as HTMLButtonElement).disabled).toBe(true);
    expect(text(must("sp-bulk-bar"))).toContain("Bulk Send (0)");
  });
});

describe("when the slips cannot be loaded", () => {
  it("says so with the reason, and Retry asks again", () => {
    serve(undefined, { isError: true, error: { data: { error: "The server is busy" }, message: "HTTP 503" } });
    mount();
    const error = must("sp-slips-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(text(error)).toContain("Could not load the payslips.");
    expect(text(error)).toContain("The server is busy");
    click(must("sp-slips-retry"));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it("Retry spins and waits while it asks", () => {
    serve(undefined, { isError: true, error: new Error("offline"), isFetching: true });
    mount();
    const retry = must("sp-slips-retry") as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("svg.animate-spin")).not.toBeNull();
  });

  it("keeps showing the slips it has when a refresh fails", () => {
    serve(SLIPS, { isError: true, error: new Error("offline") });
    mount();
    expect(q("sp-slips-error")).toBeNull();
    expect(rows()).toHaveLength(4);
  });
});

describe("when there are no payslips", () => {
  it("staff: says to generate payroll for the month first", () => {
    serve([]);
    mount();
    const empty = must("sp-slips-empty");
    expect(text(empty)).toContain("No staff payslips for October 2026");
    expect(text(empty)).toContain("Generate payroll for this month first");
    expect((must("sp-export") as HTMLButtonElement).disabled).toBe(true);
    expect((must("sp-bulk-email") as HTMLButtonElement).disabled).toBe(true);
  });

  it("production: names the cycle and says which month a slip belongs to", () => {
    serve([]);
    mount({ kind: "production", cycle: "weekly", accent: "amber" });
    const empty = must("pcp-slips-empty");
    expect(text(empty)).toContain("No Weekly payslips for October 2026");
    expect(text(empty)).toContain("belongs to the month its pay period ends in");
  });
});

describe("the month's figures and the list", () => {
  it("adds up the whole month", () => {
    mount();
    expect(text(must("sp-slip-kpi-employees-value"))).toBe("4");
    expect(text(must("sp-slip-kpi-employees"))).toContain("October 2026");
    expect(text(must("sp-slip-kpi-gross-value"))).toBe("₹1,10,000");
    expect(text(must("sp-slip-kpi-deductions-value"))).toBe("₹4,500");
    expect(text(must("sp-slip-kpi-deductions"))).toContain("4% of gross");
    expect(text(must("sp-slip-kpi-net-value"))).toBe("₹1,05,500");
  });

  it("a slip row says who, which period, whether it was emailed, and the net", () => {
    mount();
    const asha = must("sp-slip-row-1");
    expect(text(asha.querySelector("p.font-bold"))).toBe("Asha Kumar");
    expect(text(asha)).toContain("E001 · Operator · Weaving");
    expect(text(asha)).toContain("October 2026");
    expect(text(asha)).toContain("₹28,500.00");
    expect(text(asha)).toContain("net salary");
    // emailed on the viewer's own calendar day, with the exact time on hover
    expect(text(asha)).toMatch(/Emailed \d{1,2} [A-Z][a-z]{2} 2026/);
    expect(asha.querySelector("[title]")?.getAttribute("title")).toMatch(/^\d{1,2} [A-Z][a-z]{2} 2026, \d{2}:\d{2}$/);
    expect(text(must("sp-slip-row-2"))).toContain("Not emailed");
    expect(text(must("sp-slip-row-3"))).toContain("E003");
    expect(text(must("sp-slip-row-3"))).not.toContain("·"); // no designation or department
  });

  it("a footer counts the slips and their net", () => {
    mount();
    expect(text(must("sp-slips-footer"))).toContain("4 payslips");
    expect(text(must("sp-slips-footer"))).toContain("Total net ₹1,05,500.00");
  });

  it("a production slip shows its cycle and the dates of its period", () => {
    serve([
      slip(9, "Chitra Worker", "PC-B1", {
        payCycle: "biweekly",
        periodStart: "2026-02-02",
        periodEnd: "2026-02-15",
        month: 2,
      }),
    ]);
    mount({ kind: "production", cycle: "biweekly", accent: "amber", month: 2, year: 2026 });
    const row = must("pcp-slip-row-9");
    expect(text(row)).toContain("BiWeekly");
    expect(text(row)).toContain("2 Feb - 15 Feb 2026");
  });

  it("dims the list while a refresh runs, and keeps it", () => {
    serve(SLIPS, { isFetching: true });
    mount();
    expect(must("sp-slips-list").className).toContain("opacity-60");
    expect(rows()).toHaveLength(4);
    expect(q("skeleton-rows")).toBeNull();
  });
});

describe("what it asks the server for", () => {
  it("staff: the month of staff slips, with no pay cycle", () => {
    mount();
    expect(lastParams()).toEqual({ month: 10, year: 2026, employmentType: "staff" });
  });

  it("production: the month of one cycle's slips", () => {
    mount({ kind: "production", cycle: "weekly", accent: "amber" });
    expect(lastParams()).toEqual({ month: 10, year: 2026, employmentType: "production", payCycle: "weekly" });
  });

  it("production with no cycle given asks for every production slip", () => {
    mount({ kind: "production", accent: "amber" });
    expect(lastParams()).toEqual({ month: 10, year: 2026, employmentType: "production" });
  });
});

describe("the test ids", () => {
  it("keep the names the end-to-end tests look for", () => {
    mount({ kind: "production", cycle: "weekly", accent: "amber" });
    expect(q("pcp-payslip-tab")).not.toBeNull();
    expect(q("pcp-slip-row-1")).not.toBeNull();
    unmount();
    mount();
    expect(q("sp-payslip-tab")).not.toBeNull();
  });

  it("follow a prefix the page gives", () => {
    mount({ testIdPrefix: "custom" });
    expect(q("custom-payslip-tab")).not.toBeNull();
    expect(q("custom-slip-row-1")).not.toBeNull();
    expect(q("custom-bulk-bar")).not.toBeNull();
  });

  it("the Month and Year are found by their labels, each by exactly one control", () => {
    mount();
    const labelled = (word: string) =>
      [...document.body.querySelectorAll("[aria-label]")].filter((el) =>
        (el.getAttribute("aria-label") ?? "").toLowerCase().includes(word),
      );
    expect(labelled("month")).toHaveLength(1);
    expect(labelled("month")[0].tagName).toBe("SELECT");
    expect(labelled("year")).toHaveLength(1);
    expect(labelled("year")[0].tagName).toBe("INPUT");
    // and visibly labelled too
    expect(document.body.querySelector('label[for="' + labelled("month")[0].id + '"]')?.textContent).toBe("Month");
  });
});

describe("the month and the year", () => {
  it("on its own it starts on this month and keeps what is picked", () => {
    const now = new Date();
    mount({ month: undefined, year: undefined });
    expect(lastParams()).toMatchObject({ month: now.getMonth() + 1, year: now.getFullYear() });
    pick(must("sp-slips-month"), "2");
    expect(lastParams()).toMatchObject({ month: 2, year: now.getFullYear() });
    expect((must("sp-slips-month") as HTMLSelectElement).value).toBe("2");
  });

  it("lists the months by name, so a test can pick one by its label", () => {
    mount();
    const options = [...must("sp-slips-month").querySelectorAll("option")];
    expect(options.map(text)).toEqual([
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ]);
    expect(options[1].value).toBe("2");
  });

  it("the year is asked of the server only once it is a whole year", () => {
    mount({ month: undefined, year: undefined });
    const calls = h.slips.mock.calls.length;
    typeInto(must("sp-slips-year"), "2");
    typeInto(must("sp-slips-year"), "202");
    expect(lastParams().year).toBe(new Date().getFullYear());
    expect((must("sp-slips-year") as HTMLInputElement).value).toBe("202"); // what is typed stays
    typeInto(must("sp-slips-year"), "2027");
    expect(lastParams().year).toBe(2027);
    expect(h.slips.mock.calls.length).toBeGreaterThan(calls);
    // a year that cannot be right is not asked either
    typeInto(must("sp-slips-year"), "1850");
    expect(lastParams().year).toBe(2027);
  });

  it("controlled by the page: the page's month shows and a change is reported, not applied", () => {
    const onPeriodChange = vi.fn();
    mount({ month: 2, year: 2026, onPeriodChange });
    expect((must("sp-slips-month") as HTMLSelectElement).value).toBe("2");
    expect((must("sp-slips-year") as HTMLInputElement).value).toBe("2026");
    expect(text(must("sp-slip-kpi-employees"))).toContain("February 2026");
    pick(must("sp-slips-month"), "3");
    expect(onPeriodChange).toHaveBeenLastCalledWith(3, 2026);
    expect((must("sp-slips-month") as HTMLSelectElement).value).toBe("2"); // until the page passes the new one
    typeInto(must("sp-slips-year"), "2027");
    expect(onPeriodChange).toHaveBeenLastCalledWith(2, 2027);
  });

  it("follows the page when it moves the month", () => {
    const render = (month: number, year: number) =>
      act(() => root!.render(createElement(PayslipsPanel, { kind: "staff", accent: "indigo", month, year })));
    mount({ month: 2, year: 2026 });
    render(5, 2027);
    expect((must("sp-slips-month") as HTMLSelectElement).value).toBe("5");
    expect((must("sp-slips-year") as HTMLInputElement).value).toBe("2027");
    expect(lastParams()).toMatchObject({ month: 5, year: 2027 });
  });
});

describe("the filters", () => {
  it("search by name or code, every word, any case", () => {
    mount();
    typeInto(must("sp-slips-search"), "RAVI");
    expect(rowNames()).toEqual(["Ravi Nair"]);
    typeInto(must("sp-slips-search"), "e00");
    expect(rowNames()).toEqual(["Asha Kumar", "Ravi Nair", "Meena Das"]);
    typeInto(must("sp-slips-search"), "pc-w2 bala");
    expect(rowNames()).toEqual(["Bala Worker"]);
  });

  it("says how many match, and the footer follows the list", () => {
    mount();
    typeInto(must("sp-slips-search"), "ravi");
    expect(text(must("sp-slips-count"))).toBe("1 of 4 payslips match");
    expect(text(must("sp-slips-footer"))).toContain("1 of 4 payslips");
    expect(text(must("sp-slips-footer"))).toContain("Total net ₹20,000.00");
    // the month's figures describe the whole month, not the search
    expect(text(must("sp-slip-kpi-net-value"))).toBe("₹1,05,500");
  });

  it("by department", () => {
    mount();
    choose("sp-slips-dept", "Stitching");
    expect(rowNames()).toEqual(["Ravi Nair", "Bala Worker"]);
    choose("sp-slips-dept", "No department");
    expect(rowNames()).toEqual(["Meena Das"]);
    choose("sp-slips-dept", "All departments");
    expect(rows()).toHaveLength(4);
  });

  it("lists the departments of the month, 'No department' last", () => {
    mount();
    press(must("sp-slips-dept"), "ArrowDown");
    expect([...document.body.querySelectorAll('[role="option"]')].map(text)).toEqual([
      "All departments",
      "Stitching",
      "Weaving",
      "No department",
    ]);
  });

  it("'Not yet emailed' leaves the slips that were never sent, and counts them", () => {
    mount();
    expect(text(must("sp-slips-not-emailed"))).toContain("2");
    expect(must("sp-slips-not-emailed").getAttribute("aria-pressed")).toBe("false");
    click(must("sp-slips-not-emailed"));
    expect(must("sp-slips-not-emailed").getAttribute("aria-pressed")).toBe("true");
    expect(rowNames()).toEqual(["Ravi Nair", "Meena Das"]);
    click(must("sp-slips-not-emailed"));
    expect(rows()).toHaveLength(4);
  });

  it("the three together", () => {
    mount();
    choose("sp-slips-dept", "Stitching");
    click(must("sp-slips-not-emailed"));
    typeInto(must("sp-slips-search"), "ravi");
    expect(rowNames()).toEqual(["Ravi Nair"]);
    expect(text(must("sp-slips-count"))).toBe("1 of 4 payslips match");
  });

  it("when nothing matches it says so and offers to clear the filters", () => {
    mount();
    typeInto(must("sp-slips-search"), "zzzz");
    const empty = must("sp-slips-empty");
    expect(text(empty)).toContain("No payslip matches these filters");
    expect(rows()).toHaveLength(0);
    click([...empty.querySelectorAll("button")].find((b) => text(b) === "Clear filters")!);
    expect(rows()).toHaveLength(4);
    expect((must("sp-slips-search") as HTMLInputElement).value).toBe("");
  });

  it("'Clear filters' puts the three back", () => {
    mount();
    choose("sp-slips-dept", "Weaving");
    click(must("sp-slips-not-emailed"));
    typeInto(must("sp-slips-search"), "m");
    click(must("sp-slips-clear"));
    expect(rows()).toHaveLength(4);
    expect(q("sp-slips-clear")).toBeNull();
    expect(must("sp-slips-not-emailed").getAttribute("aria-pressed")).toBe("false");
  });

  it("a department that the next month does not have is dropped instead of leaving an invisible filter", () => {
    const render = (month: number) =>
      act(() => root!.render(createElement(PayslipsPanel, { kind: "staff", accent: "indigo", month, year: 2026 })));
    mount();
    choose("sp-slips-dept", "Stitching");
    expect(rows()).toHaveLength(2);
    serve([slip(7, "Nila", "E007")]); // November: only Weaving
    render(11);
    expect(rowNames()).toEqual(["Nila"]);
    expect(text(must("sp-slips-dept"))).toBe("All departments");
  });
});

describe("paging", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    slip(100 + i, `Worker ${String(i + 1).padStart(2, "0")}`, `W${i + 1}`),
  );

  it("shows 25 slips a page and the rest on the next", () => {
    serve(many);
    mount();
    expect(rows()).toHaveLength(25);
    click(document.body.querySelector('[aria-label="Page 2"]'));
    expect(rows()).toHaveLength(5);
    expect(rowNames()[0]).toBe("Worker 26");
  });

  it("goes back to the first page when a filter changes", () => {
    serve(many);
    mount();
    click(document.body.querySelector('[aria-label="Page 2"]'));
    typeInto(must("sp-slips-search"), "worker");
    expect(rows()).toHaveLength(25);
    expect(rowNames()[0]).toBe("Worker 01");
  });

  it("has no pager for a short month", () => {
    mount();
    expect(document.body.querySelector('[aria-label="Page 1"]')).toBeNull();
  });
});

describe("one slip's actions", () => {
  it("View PDF opens the preview with the user's token, and spins while it runs", async () => {
    const pending = deferred<void>();
    h.preview.mockReturnValue(pending.promise);
    mount();
    click(must("sp-slip-1-view"));
    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(h.preview.mock.calls[0][0]).toBe("/api/salary-slips/1/pdf");
    expect(h.preview.mock.calls[0][1]()).toBe("tok-123");
    expect(must("sp-slip-1-view").querySelector("svg.animate-spin")).not.toBeNull();
    // while a PDF is being made no other PDF button is pressed
    expect((must("sp-slip-2-view") as HTMLButtonElement).disabled).toBe(true);
    expect((must("sp-slip-2-download") as HTMLButtonElement).disabled).toBe(true);
    expect((must("sp-slip-2-email") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => pending.resolve());
    expect(must("sp-slip-1-view").querySelector("svg.animate-spin")).toBeNull();
    expect((must("sp-slip-2-view") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Download PDF downloads it", async () => {
    mount();
    click(must("sp-slip-3-download"));
    await settle();
    expect(h.download).toHaveBeenCalledTimes(1);
    expect(h.download.mock.calls[0][0]).toBe("/api/salary-slips/3/pdf");
    expect(h.preview).not.toHaveBeenCalled();
  });

  it("a PDF that cannot be made says so", async () => {
    h.download.mockRejectedValue(new Error("boom"));
    mount();
    click(must("sp-slip-1-download"));
    await settle();
    expect(h.toast).toHaveBeenCalledWith({ title: "Failed to generate PDF", variant: "destructive" });
    expect((must("sp-slip-1-download") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Email sends that slip, says where it went, refreshes the list, and spins meanwhile", async () => {
    const pending = deferred<{ ok: boolean; sentTo: string }>();
    h.emailSlip.mockReturnValue(pending.promise);
    mount();
    click(must("sp-slip-2-email"));
    expect(h.emailSlip).toHaveBeenCalledWith({ id: 2 });
    expect(must("sp-slip-2-email").querySelector("svg.animate-spin")).not.toBeNull();
    expect((must("sp-slip-1-email") as HTMLButtonElement).disabled).toBe(true); // one at a time
    await act(async () => pending.resolve({ ok: true, sentTo: "ravi@example.com" }));
    expect(h.toast).toHaveBeenCalledWith({
      title: "Email sent to Ravi Nair",
      description: "Salary slip delivered to ravi@example.com",
    });
    expect(h.refetch).toHaveBeenCalledTimes(1);
    expect((must("sp-slip-1-email") as HTMLButtonElement).disabled).toBe(false);
  });

  it("an email that fails gives the server's reason, and does not refresh", async () => {
    h.emailSlip.mockRejectedValue({ data: { error: "No email address on file for Ravi Nair" }, message: "HTTP 400" });
    mount();
    click(must("sp-slip-2-email"));
    await settle();
    expect(h.toast).toHaveBeenCalledWith({
      title: "Failed to send email",
      description: "No email address on file for Ravi Nair",
      variant: "destructive",
    });
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it("WhatsApp sends that slip and says where it went", async () => {
    mount();
    click(must("sp-slip-1-whatsapp"));
    await settle();
    expect(h.whatsappSlip).toHaveBeenCalledWith(1);
    expect(h.toast).toHaveBeenCalledWith({
      title: "WhatsApp sent to Asha Kumar",
      description: "Salary slip delivered to +91 98765 43210",
    });
  });

  it("a WhatsApp that fails gives the reason", async () => {
    h.whatsappSlip.mockRejectedValue(new Error("HTTP 400 Bad Request: No phone number"));
    mount();
    click(must("sp-slip-1-whatsapp"));
    await settle();
    expect(h.toast).toHaveBeenCalledWith({
      title: "Failed to send via WhatsApp",
      description: "HTTP 400 Bad Request: No phone number",
      variant: "destructive",
    });
  });

  it("each button names the employee for assistive technology", () => {
    mount();
    expect(must("sp-slip-1-view").getAttribute("aria-label")).toBe("View the payslip PDF of Asha Kumar");
    expect(must("sp-slip-1-download").getAttribute("aria-label")).toBe("Download the payslip PDF of Asha Kumar");
    expect(must("sp-slip-1-email").getAttribute("aria-label")).toBe("Send the payslip of Asha Kumar by email");
    expect(must("sp-slip-1-whatsapp").getAttribute("aria-label")).toBe("Send the payslip of Asha Kumar on WhatsApp");
    // and show the words where there is room for them
    expect(text(must("sp-slip-1-view"))).toBe("View PDF");
    expect(text(must("sp-slip-1-whatsapp"))).toBe("WhatsApp");
  });
});

describe("the bulk actions", () => {
  it("send, WhatsApp and download the month, and name how many slips that is", async () => {
    mount();
    expect(text(must("sp-bulk-email"))).toBe("Bulk Send (4)");
    expect(text(must("sp-bulk-whatsapp"))).toBe("Bulk WhatsApp (4)");
    expect(text(must("sp-bulk-download"))).toBe("Bulk Download All (4)");
    click(must("sp-bulk-email"));
    await settle();
    expect(h.triggerEmail).toHaveBeenCalledWith({ month: 10, year: 2026, employmentType: "staff" });
    click(must("sp-bulk-whatsapp"));
    expect(h.triggerWhatsApp).toHaveBeenCalledWith({ month: 10, year: 2026, employmentType: "staff" });
    click(must("sp-bulk-download"));
    expect(h.triggerDownload).toHaveBeenCalledWith({ month: 10, year: 2026, employmentType: "staff" });
  });

  it("a production page's bulk actions carry its cycle", () => {
    mount({ kind: "production", cycle: "biweekly", accent: "amber" });
    click(must("pcp-bulk-whatsapp"));
    expect(h.triggerWhatsApp).toHaveBeenCalledWith({
      month: 10,
      year: 2026,
      employmentType: "production",
      payCycle: "biweekly",
    });
    click(must("pcp-bulk-download"));
    expect(h.triggerDownload).toHaveBeenCalledWith({
      month: 10,
      year: 2026,
      employmentType: "production",
      payCycle: "biweekly",
    });
  });

  it("always cover the whole month, never only the slips a filter leaves, and say so", () => {
    mount();
    typeInto(must("sp-slips-search"), "ravi");
    expect(rows()).toHaveLength(1);
    expect(text(must("sp-bulk-email"))).toBe("Bulk Send (4)");
    expect(text(must("sp-bulk-bar"))).toContain("every staff payslip of this period, not only the ones listed");
    click(must("sp-bulk-download"));
    expect(h.triggerDownload).toHaveBeenCalledWith({ month: 10, year: 2026, employmentType: "staff" });
  });

  it("a bulk email refreshes the list when it is done, so the 'Emailed' chips are current", async () => {
    const pending = deferred<null>();
    h.triggerEmail.mockReturnValue(pending.promise);
    mount();
    click(must("sp-bulk-email"));
    expect(h.refetch).not.toHaveBeenCalled();
    await act(async () => pending.resolve(null));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it("while an email or PDF run is going the email and download buttons wait and the right one spins", () => {
    h.bulk.mockReturnValue(idleBulk({ isRunning: true, kind: "email", progress: { kind: "email" } }));
    mount();
    expect((must("sp-bulk-email") as HTMLButtonElement).disabled).toBe(true);
    expect((must("sp-bulk-download") as HTMLButtonElement).disabled).toBe(true);
    expect(must("sp-bulk-email").querySelector("svg.animate-spin")).not.toBeNull();
    expect(must("sp-bulk-download").querySelector("svg.animate-spin")).toBeNull();
    expect((must("sp-bulk-whatsapp") as HTMLButtonElement).disabled).toBe(false);
    unmount();
    h.bulk.mockReturnValue(idleBulk({ isRunning: true, kind: "pdf", progress: { kind: "pdf" } }));
    mount();
    expect(must("sp-bulk-download").querySelector("svg.animate-spin")).not.toBeNull();
    expect(must("sp-bulk-email").querySelector("svg.animate-spin")).toBeNull();
  });

  it("while WhatsApp is sending only its button waits", () => {
    h.whatsappBulk.mockReturnValue(idleWhatsApp({ isRunning: true }));
    mount();
    expect((must("sp-bulk-whatsapp") as HTMLButtonElement).disabled).toBe(true);
    expect(must("sp-bulk-whatsapp").querySelector("svg.animate-spin")).not.toBeNull();
    expect((must("sp-bulk-email") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the progress of a bulk run under the bar", () => {
    h.bulk.mockReturnValue(
      idleBulk({
        isRunning: true,
        showPipeline: true,
        kind: "email",
        progress: {
          stage: "running",
          kind: "email",
          total: 10,
          completed: 4,
          succeeded: 4,
          failed: 0,
          currentEmployee: null,
        },
      }),
    );
    mount();
    expect(text(host)).toContain("Emailing salary slips");
    expect(text(host)).toContain("4 / 10 slips processed");
  });

  it("the bar is sticky, so the buttons stay in reach down a long list", () => {
    mount();
    expect(must("sp-bulk-bar").className).toContain("sticky");
    expect(must("sp-bulk-bar").className).toContain("top-0");
  });

  it("every button waits while there is nothing to send", () => {
    serve([]);
    mount();
    for (const id of ["sp-bulk-email", "sp-bulk-whatsapp", "sp-bulk-download"]) {
      expect((must(id) as HTMLButtonElement).disabled, id).toBe(true);
    }
  });
});

describe("the Payslip register", () => {
  const openExport = () => press(must("sp-export"), "Enter");

  it("offers Excel and CSV", () => {
    mount();
    openExport();
    expect(text(must("sp-export-excel"))).toContain("Payslip register (Excel)");
    expect(text(must("sp-export-excel"))).toContain("4 payslips as listed");
    expect(text(must("sp-export-csv"))).toContain("Payslip register (CSV)");
  });

  it("Excel writes the slips listed, with the columns of the register, named for the month", async () => {
    mount();
    openExport();
    click(must("sp-export-excel"));
    await settle();
    expect(h.excel).toHaveBeenCalledTimes(1);
    const args = h.excel.mock.calls[0][0];
    expect(args.rows.map((s: SalarySlipItem) => s.id)).toEqual([1, 2, 3, 4]);
    expect(args.columns).toBe(REGISTER_COLUMNS);
    expect(args.filename).toBe("Payslip_register_Staff_October_2026");
    expect(args.sheetName).toBe("Payslips");
    expect(args.company).toBe("UK Textiles Pvt Ltd");
    expect(args.subtitle).toBe("Staff - October 2026");
    expect(args.title).toBe("Payslip register");
    expect(h.csv).not.toHaveBeenCalled();
  });

  it("CSV writes the same register as plain text", async () => {
    mount();
    openExport();
    click(must("sp-export-csv"));
    await settle();
    expect(h.csv).toHaveBeenCalledTimes(1);
    expect(h.csv.mock.calls[0][0].filename).toBe("Payslip_register_Staff_October_2026");
    expect(h.csv.mock.calls[0][0].rows).toHaveLength(4);
    expect(h.excel).not.toHaveBeenCalled();
  });

  it("exports what is listed: a search narrows it", async () => {
    mount();
    typeInto(must("sp-slips-search"), "ravi");
    openExport();
    expect(text(must("sp-export-excel"))).toContain("1 payslip as listed");
    click(must("sp-export-csv"));
    await settle();
    expect(h.csv.mock.calls[0][0].rows.map((s: SalarySlipItem) => s.id)).toEqual([2]);
  });

  it("a production register is named after its cycle", async () => {
    mount({ kind: "production", cycle: "weekly", accent: "amber", month: 2, year: 2026 });
    press(must("pcp-export"), "Enter");
    click(must("pcp-export-excel"));
    await settle();
    const args = h.excel.mock.calls[0][0];
    expect(args.filename).toBe("Payslip_register_Weekly_February_2026");
    expect(args.subtitle).toBe("Production - Weekly - February 2026");
  });

  it("falls back to the portal's name when the settings have none", async () => {
    h.settings.mockReturnValue(undefined);
    mount();
    openExport();
    click(must("sp-export-excel"));
    await settle();
    expect(h.excel.mock.calls[0][0].company).toBe("UKTextiles");
  });

  it("a failure to build the file is reported, not lost", async () => {
    h.excel.mockRejectedValue(new Error("no memory"));
    mount();
    openExport();
    click(must("sp-export-excel"));
    await settle();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not export Payslip register (Excel)" }),
    );
  });

  it("is off when there is nothing to export, and its items wait when the search leaves nothing", () => {
    mount();
    typeInto(must("sp-slips-search"), "zzzz");
    openExport();
    expect(must("sp-export-excel").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("view only", () => {
  it("a View Only role can still look, search, export, view and download; sending stays locked", () => {
    mount();
    lockMutatingControls(document.body);
    // reading stays open
    for (const id of [
      "sp-export",
      "sp-slip-1-view",
      "sp-slip-1-download",
      "sp-bulk-download",
      "sp-slips-not-emailed",
    ]) {
      expect((must(id) as HTMLButtonElement).disabled, id).toBe(false);
    }
    // sending is locked
    for (const id of ["sp-bulk-email", "sp-bulk-whatsapp", "sp-slip-1-email", "sp-slip-1-whatsapp"]) {
      expect((must(id) as HTMLButtonElement).disabled, id).toBe(true);
    }
  });

  it("the export menu's items stay usable too", () => {
    mount();
    press(must("sp-export"), "Enter");
    lockMutatingControls(document.body);
    expect(must("sp-export-excel").getAttribute("aria-disabled")).not.toBe("true");
    expect(must("sp-export").closest("[data-view-safe]")).not.toBeNull();
  });
});
