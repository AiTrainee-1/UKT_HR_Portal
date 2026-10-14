import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isMutatingControl, lockMutatingControls } from "@/lib/view-only-lock";
import { PRODUCTION_SKIPPED, manySkipped } from "./fixtures";
import { SkippedPanel, type SkippedPanelProps } from "./SkippedPanel";
import { SKIP_GUIDE } from "./skipped-logic";
import type { SkippedItem } from "./skipped-types";

// The Skipped Employees panel in jsdom: the banner, the reason cards with their suggested fixes, the table with its
// search and category filter, Re-check, the export, the loading / empty / error states and the view-only lock.

const h = vi.hoisted(() => ({
  settings: vi.fn(),
  recheck: vi.fn(),
  excel: vi.fn(),
  csv: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/components/payroll/kit/export-table", () => ({ exportTableToExcel: h.excel, exportTableToCsv: h.csv }));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  usePayrollSettings: () => h.settings(),
}));

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

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  h.settings.mockReturnValue({ data: { companyName: "UK Textiles Test" } });
  h.excel.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

const PERIOD = "2 Feb - 8 Feb 2026";

const props = (over: Partial<SkippedPanelProps> = {}): SkippedPanelProps => ({
  skipped: PRODUCTION_SKIPPED,
  totalChecked: 42,
  periodLabel: PERIOD,
  kind: "production",
  accent: "amber",
  onRecheck: h.recheck,
  ...over,
});

function mount(over: Partial<SkippedPanelProps> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(SkippedPanel, props(over))));
  return host;
}
const rerender = (over: Partial<SkippedPanelProps> = {}) =>
  act(() => root!.render(createElement(SkippedPanel, props(over))));

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the panel shows: ${text(document.body).slice(0, 600)}`);
  return el;
};
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
const typeInto = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const dataRows = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid^="skipped-row-"]')];
const names = () => dataRows().map((r) => text(r.querySelector("td")));
const pickOption = (trigger: HTMLElement, label: string | RegExp) => {
  press(trigger, "ArrowDown");
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
    typeof label === "string" ? text(o) === label : label.test(text(o)),
  );
  if (!option) throw new Error(`no option ${label}`);
  click(option);
};
const openExport = () => press(must("skipped-export"), "Enter");

const STAFF: SkippedItem[] = [
  {
    employeeId: 21,
    employeeCode: "PC-S9",
    name: "Divya Nair",
    reason: "No Salary Amount set on this employee's profile",
    department: "Accounts",
  },
  {
    employeeId: 22,
    employeeCode: "PC-S10",
    name: "Esha Roy",
    reason:
      "No working days found in 10/2026 for this employee's shift (check Holidays and Saturday-off configuration)",
    department: "Admin",
  },
];

describe("the Skipped Employees panel while it loads and when it cannot", () => {
  it("shows skeletons while the check runs, and no banner", () => {
    mount({ loading: true, skipped: undefined });
    expect(q("skipped-loading")).not.toBeNull();
    expect(q("skeleton-rows")).not.toBeNull();
    expect(q("skipped-banner")).toBeNull();
    expect(q("skipped-table")).toBeNull();
  });

  it("shows skeletons too when it has neither a result nor an error yet", () => {
    mount({ skipped: undefined });
    expect(q("skipped-loading")).not.toBeNull();
    expect(q("skipped-error")).toBeNull();
  });

  it("says the check failed, with the server's reason, and Retry runs it again", () => {
    mount({ skipped: undefined, error: new Error("HTTP 500 Internal Server Error: boom") });
    const error = must("skipped-error");
    expect(text(error)).toContain("Could not load who is skipped");
    expect(text(error)).toContain("boom");
    expect(text(error)).not.toContain("HTTP 500");
    click([...error.querySelectorAll("button")].find((b) => text(b) === "Retry")!);
    expect(h.recheck).toHaveBeenCalledTimes(1);
  });

  it("says a permission error is one, and keeps the usual line for a dead network", () => {
    mount({ skipped: undefined, error: new Error("HTTP 403 Forbidden") });
    expect(text(must("skipped-error"))).toContain("You do not have permission to view this.");
    act(() => root!.unmount());
    host!.remove();
    mount({ skipped: undefined, error: new TypeError("Failed to fetch") });
    expect(text(must("skipped-error"))).toContain("Check your connection, then try again.");
  });

  it("shows Retry busy while it retries", () => {
    mount({ skipped: undefined, error: "failed", rechecking: true });
    const retry = [...must("skipped-error").querySelectorAll("button")].find((b) => text(b) === "Retry")!;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector(".animate-spin")).not.toBeNull();
  });

  it("keeps the earlier result on screen when a re-check fails, and says so", () => {
    mount({ error: new Error("HTTP 502 Bad Gateway: upstream down") });
    expect(text(must("skipped-stale"))).toBe(
      "The last check could not be refreshed (upstream down). This is the earlier result.",
    );
    expect(dataRows()).toHaveLength(6);
    expect(q("skipped-error")).toBeNull();
    // with nothing to add the sentence is plain
    rerender({ error: new TypeError("Failed to fetch") });
    expect(text(must("skipped-stale"))).toBe("The last check could not be refreshed. This is the earlier result.");
  });
});

describe("the banner", () => {
  it("says nobody is skipped, in green, and still offers a re-check", () => {
    mount({ skipped: [] });
    const banner = must("skipped-banner");
    expect(banner.dataset.tone).toBe("success");
    expect(text(must("skipped-banner-title"))).toBe("Nobody is skipped");
    expect(text(must("skipped-banner-hint"))).toBe("All 42 employees can be paid for 2 Feb - 8 Feb 2026.");
    expect(q("skipped-cards")).toBeNull();
    expect(q("skipped-table")).toBeNull();
    expect(q("skipped-recheck")).not.toBeNull();
  });

  it("says how many of those checked are skipped, and that they are not paid until it is fixed", () => {
    mount();
    expect(must("skipped-banner").dataset.tone).toBe("danger");
    expect(text(must("skipped-banner-title"))).toBe("6 of 42 employees were skipped");
    expect(text(must("skipped-banner-hint"))).toBe(
      "No payroll is generated for them for 2 Feb - 8 Feb 2026, so they are not paid until each reason below is fixed.",
    );
  });

  it("is a calm note when the only employees skipped are already paid", () => {
    mount({ skipped: [PRODUCTION_SKIPPED[4]], totalChecked: 10 });
    expect(must("skipped-banner").dataset.tone).toBe("info");
    expect(text(must("skipped-banner-title"))).toBe("1 of 10 employees was skipped");
  });

  it("copes without a total", () => {
    mount({ skipped: STAFF, totalChecked: undefined, kind: "staff", periodLabel: "October 2026" });
    expect(text(must("skipped-banner-title"))).toBe("2 employees were skipped");
  });
});

describe("Re-check", () => {
  it("runs the check again", () => {
    mount();
    click(must("skipped-recheck"));
    expect(h.recheck).toHaveBeenCalledTimes(1);
  });

  it("shows a spinner and cannot be pressed twice while it runs, and says the list is being refreshed", () => {
    mount({ rechecking: true });
    const button = must("skipped-recheck") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    expect(must("skipped-panel").getAttribute("aria-busy")).toBe("true");
    rerender({ rechecking: false });
    expect((must("skipped-recheck") as HTMLButtonElement).disabled).toBe(false);
    expect(must("skipped-recheck").querySelector(".animate-spin")).toBeNull();
    expect(must("skipped-panel").getAttribute("aria-busy")).toBeNull();
  });

  it("is off when the page gave no way to check again", () => {
    mount({ onRecheck: undefined });
    expect((must("skipped-recheck") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the reasons", () => {
  it("are cards, the biggest first, each with a count, the general advice and a link to the page that helps", () => {
    mount();
    const cards = [...must("skipped-cards").children] as HTMLElement[];
    expect(cards.map((c) => c.dataset.testid)).toEqual([
      "skipped-card-no_rate",
      "skipped-card-wrong_cycle",
      "skipped-card-overlap",
      "skipped-card-already_paid",
      "skipped-card-other",
    ]);
    const rate = must("skipped-card-no_rate");
    expect(text(rate.querySelector('[data-testid="skipped-card-count"]'))).toBe("2");
    expect(text(rate)).toContain("No salary per shift");
    expect(text(rate)).toContain("2 employees");
    expect(text(rate.querySelector('[data-testid="skipped-card-fix"]'))).toBe(SKIP_GUIDE.no_rate.fix);
    const link = rate.querySelector('[data-testid="skipped-card-link"]');
    expect(link?.getAttribute("href")).toBe("/hr/employees/productionEmployee");
    expect(text(link)).toBe("Open Production Employees");
    // nothing to fix for an employee who is already paid, so no link
    expect(must("skipped-card-already_paid").querySelector("a")).toBeNull();
    expect(text(must("skipped-card-already_paid"))).toContain("1 employee");
  });

  it("send no working days to the shift and to the holidays", () => {
    mount({ skipped: STAFF, kind: "staff" });
    const card = must("skipped-card-no_working_days");
    expect([...card.querySelectorAll("a")].map((a) => [a.getAttribute("href"), text(a)])).toEqual([
      ["/hr/shifts", "Open Manage Shifts"],
      ["/hr/leave?tab=holidays", "Holidays"],
    ]);
    expect(must("skipped-card-no_salary").querySelector("a")?.getAttribute("href")).toBe("/hr/employees");
  });

  it("can be clicked to show only that reason's employees, and clicked again to show all", () => {
    mount();
    expect(dataRows()).toHaveLength(6);
    click(must("skipped-card-overlap-filter"));
    expect(names()).toEqual(["Selvi Rani"]);
    expect(must("skipped-card-overlap-filter").getAttribute("aria-pressed")).toBe("true");
    expect(must("skipped-card-overlap").dataset.selected).toBe("true");
    expect(text(must("skipped-reset"))).toBe("Reset1");
    click(must("skipped-card-overlap-filter"));
    expect(dataRows()).toHaveLength(6);
    expect(must("skipped-card-overlap").dataset.selected).toBeUndefined();
    expect(q("skipped-reset")).toBeNull();
  });
});

describe("the table", () => {
  it("lists each skipped employee with their code, department, the reason in the engine's words and how to fix it", () => {
    mount();
    expect(names()).toEqual(["Mani Selvam", "Ravi Kumar", "Kumar Raj", "Selvi Rani", "Lakshmi Devi", "Mystery Worker"]);
    const row = must("skipped-row-PW-2");
    expect(row.dataset.category).toBe("no_rate");
    const cells = [...row.querySelectorAll("td")].map(text);
    expect(cells[0]).toBe("Mani Selvam");
    expect(cells[1]).toBe("PW-2");
    expect(cells[2]).toBe("Weaving");
    expect(cells[3]).toContain("No Salary Per Shift set on this employee's profile");
    expect(cells[3]).toContain("No salary per shift"); // the category chip
    expect(cells[4]).toContain("Enter the salary per shift on the employee's profile");
    const link = row.querySelector('[data-testid="skipped-fix-link"]');
    expect(link?.getAttribute("href")).toBe("/hr/employees/42/edit");
    expect(text(link)).toBe("Open profile");
  });

  it("says which cycle an employee is on and what to do", () => {
    mount();
    const row = must("skipped-row-PW-4");
    expect(text(row.querySelector('[data-testid="skipped-fix"]'))).toContain("They are on BiWeekly, not Weekly");
    expect(row.querySelector('[data-testid="skipped-fix-link"]')?.getAttribute("href")).toBe(
      "/hr/employees/productionEmployee",
    );
  });

  it("says nothing to fix for an employee already paid, and gives an unknown reason a way to the employee", () => {
    mount();
    const paid = must("skipped-row-PW-5");
    expect(text(paid.querySelector('[data-testid="skipped-fix"]'))).toMatch(/^Nothing to fix/);
    expect(paid.querySelector("a")).toBeNull();
    const mystery = must("skipped-row-PW-6");
    expect(text(mystery.querySelector('[data-testid="skipped-reason"]'))).toBe("division by zero");
    expect(text(mystery)).toContain("Other");
    expect(mystery.querySelector('[data-testid="skipped-fix-link"]')?.getAttribute("href")).toBe("/hr/employees/46");
  });

  it("sends no working days to the shift and the holidays, for that employee", () => {
    mount({ skipped: STAFF, kind: "staff" });
    const row = must("skipped-row-PC-S10");
    expect(text(row.querySelector('[data-testid="skipped-fix"]'))).toContain("October 2026");
    expect([...row.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "/hr/shifts",
      "/hr/leave?tab=holidays",
    ]);
    expect(must("skipped-row-PC-S9").querySelector("a")?.getAttribute("href")).toBe("/hr/employees/21/edit");
  });

  it("has a Department column only when some employee has one", () => {
    mount();
    const headers = () => [...document.body.querySelectorAll("th")].map(text);
    expect(headers()).toEqual(["Employee", "Code", "Department", "Reason", "How to fix"]);
    rerender({ skipped: PRODUCTION_SKIPPED.map((s) => ({ ...s, department: undefined })) });
    expect(headers()).toEqual(["Employee", "Code", "Reason", "How to fix"]);
  });

  it("shows a dash for a missing code or department", () => {
    mount({
      skipped: [
        { employeeId: 5, employeeCode: "", name: "No Code", reason: "Not an active employee.", department: "Weaving" },
        { employeeId: 6, employeeCode: "X1", name: "No Dept", reason: "Not an active employee." },
      ],
    });
    const rows = dataRows();
    expect([...rows[0].querySelectorAll("td")].map(text).slice(0, 3)).toEqual(["No Code", "—", "Weaving"]);
    expect([...rows[1].querySelectorAll("td")].map(text).slice(0, 3)).toEqual(["No Dept", "X1", "—"]);
    expect(rows[0].dataset.testid).toBe("skipped-row-5"); // no code: the id names the row
  });

  it("lists an employee once however many times they come", () => {
    mount({ skipped: [...PRODUCTION_SKIPPED, ...PRODUCTION_SKIPPED] });
    expect(dataRows()).toHaveLength(6);
  });
});

describe("the filters", () => {
  it("search finds employees by name, code, department or reason, and Reset clears it", () => {
    mount();
    expect(text(must("skipped-table-card").querySelector("h3"))).toBe("Skipped Employees");
    expect(text(must("skipped-showing"))).toBe("6 employees");
    typeInto(must("skipped-search") as HTMLInputElement, "selv");
    expect(names()).toEqual(["Mani Selvam", "Selvi Rani"]);
    expect(text(must("skipped-showing"))).toBe("2 of 6 employees");
    expect(text(must("skipped-reset"))).toBe("Reset1");
    typeInto(must("skipped-search") as HTMLInputElement, "pw-5");
    expect(names()).toEqual(["Lakshmi Devi"]);
    typeInto(must("skipped-search") as HTMLInputElement, "biweekly");
    expect(names()).toEqual(["Kumar Raj"]);
    click(must("skipped-reset"));
    expect(dataRows()).toHaveLength(6);
    expect((must("skipped-search") as HTMLInputElement).value).toBe("");
  });

  it("the reason select keeps one category", () => {
    mount();
    pickOption(must("skipped-category"), /^Overlaps another payslip \(1\)$/);
    expect(names()).toEqual(["Selvi Rani"]);
    pickOption(must("skipped-category"), "All reasons");
    expect(dataRows()).toHaveLength(6);
  });

  it("search and category combine", () => {
    mount();
    click(must("skipped-card-no_rate-filter"));
    typeInto(must("skipped-search") as HTMLInputElement, "ravi");
    expect(names()).toEqual(["Ravi Kumar"]);
    expect(text(must("skipped-reset"))).toBe("Reset2");
  });

  it("says nothing matches, with a Reset", () => {
    mount();
    typeInto(must("skipped-search") as HTMLInputElement, "zzz");
    expect(dataRows()).toHaveLength(0);
    expect(text(must("skipped-no-match"))).toContain("Nothing matches these filters");
    expect(q("skipped-table")).toBeNull();
    expect(q("skipped-cards")).not.toBeNull(); // the reasons stay
    click([...must("skipped-no-match").querySelectorAll("button")].find((b) => text(b) === "Reset filters")!);
    expect(dataRows()).toHaveLength(6);
  });
});

describe("pages", () => {
  it("shows 25 to a page and goes back to page 1 when a filter changes", () => {
    mount({ skipped: manySkipped(60), totalChecked: 200 });
    expect(dataRows()).toHaveLength(25);
    expect(document.body.querySelector('[aria-label="Page 3"]')).not.toBeNull();
    click(document.body.querySelector('[aria-label="Page 3"]'));
    expect(dataRows()).toHaveLength(10);
    expect(names()[0]).toBe("Skipped 051");
    typeInto(must("skipped-search") as HTMLInputElement, "skipped");
    expect(dataRows()).toHaveLength(25);
    expect(names()[0]).toBe("Skipped 001");
  });

  it("has no page bar for a short list", () => {
    mount();
    expect(document.body.querySelector('[data-slot="page-info"]')).toBeNull();
  });
});

describe("the export", () => {
  it("offers Excel and CSV", () => {
    mount();
    openExport();
    expect(text(must("skipped-export-excel"))).toContain("Excel (.xlsx)");
    expect(text(must("skipped-export-excel"))).toContain("6 employees, with reasons and how to fix");
    expect(text(must("skipped-export-csv"))).toContain("6 employees, plain text");
  });

  it("writes every skipped employee with the reason and the fix", async () => {
    mount();
    openExport();
    click(must("skipped-export-csv"));
    await settle();
    expect(h.csv).toHaveBeenCalledTimes(1);
    const arg = h.csv.mock.calls[0][0];
    expect(arg.filename).toBe("Production_Skipped_Employees_2_Feb_8_Feb_2026");
    expect(arg.rows.map((r: { name: string }) => r.name)).toEqual([
      "Mani Selvam",
      "Ravi Kumar",
      "Kumar Raj",
      "Selvi Rani",
      "Lakshmi Devi",
      "Mystery Worker",
    ]);
    expect(arg.columns.map((c: { label: string }) => c.label)).toEqual([
      "Employee code",
      "Employee",
      "Department",
      "Reason",
      "Category",
      "How to fix",
    ]);
  });

  it("writes the Excel sheet with the company, the period and a title", async () => {
    mount();
    openExport();
    click(must("skipped-export-excel"));
    await settle();
    expect(h.excel).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "Production_Skipped_Employees_2_Feb_8_Feb_2026",
        sheetName: "Skipped employees",
        company: "UK Textiles Test",
        subtitle: "Production Payroll · 2 Feb - 8 Feb 2026",
        title: "Skipped employees",
      }),
    );
  });

  it("writes only what the filters keep, across all pages, and says it was filtered", async () => {
    mount({ skipped: manySkipped(60) });
    typeInto(must("skipped-search") as HTMLInputElement, "skipped 05");
    expect(dataRows()).toHaveLength(11); // 005 and 050 to 059
    openExport();
    expect(text(must("skipped-export-csv"))).toContain("11 employees, filtered");
    click(must("skipped-export-excel"));
    await settle();
    expect(h.excel.mock.calls[0][0].rows).toHaveLength(11);
    expect(h.excel.mock.calls[0][0].subtitle).toBe("Production Payroll · 2 Feb - 8 Feb 2026 · Filtered");
  });

  it("writes the whole list when it is not filtered, though only a page is shown", async () => {
    mount({ skipped: manySkipped(60) });
    expect(dataRows()).toHaveLength(25);
    openExport();
    click(must("skipped-export-csv"));
    await settle();
    expect(h.csv.mock.calls[0][0].rows).toHaveLength(60);
  });

  it("names a staff file after the month", async () => {
    mount({ skipped: STAFF, kind: "staff", periodLabel: "October 2026" });
    openExport();
    click(must("skipped-export-excel"));
    await settle();
    expect(h.excel).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "Staff_Skipped_Employees_October_2026",
        subtitle: "Staff Payroll · October 2026",
      }),
    );
  });

  it("has nothing to export when nothing matches", () => {
    mount();
    typeInto(must("skipped-search") as HTMLInputElement, "zzz");
    openExport();
    expect(must("skipped-export-excel").getAttribute("aria-disabled")).toBe("true");
    expect(must("skipped-export-csv").getAttribute("aria-disabled")).toBe("true");
  });

  it("falls back to a company name, and reports a failed write", async () => {
    h.settings.mockReturnValue({ data: undefined });
    h.excel.mockRejectedValueOnce(new Error("disk full"));
    mount();
    openExport();
    click(must("skipped-export-excel"));
    await settle();
    expect(h.excel.mock.calls[0][0].company).toBe("UK Textiles");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not export Excel (.xlsx)", variant: "destructive" }),
    );
  });
});

describe("a View Only role", () => {
  it("can still re-check, filter and export: the panel only reads", () => {
    mount();
    const stray = document.createElement("button");
    stray.textContent = "Export";
    document.body.append(stray);
    lockMutatingControls(document.body);
    expect(stray.disabled).toBe(true);
    const trigger = must("skipped-export") as HTMLButtonElement;
    expect(isMutatingControl(trigger)).toBe(false);
    for (const button of document.body.querySelectorAll<HTMLButtonElement>('[data-testid="skipped-panel"] button')) {
      expect(button.disabled, `${text(button)} is locked`).toBe(false);
    }
    expect(trigger.closest("[data-view-safe]")).not.toBeNull();
  });

  it("is not locked by an employee or a reason that sounds like an action", () => {
    mount({
      skipped: [
        {
          employeeId: 1,
          employeeCode: "B1",
          name: "Run Block",
          reason: "Unable to run payroll: delete the duplicate",
          department: "Block Printing",
        },
      ],
    });
    const filter = must("skipped-card-other-filter") as HTMLButtonElement;
    lockMutatingControls(document.body);
    expect(filter.disabled).toBe(false);
    expect((must("skipped-recheck") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the look", () => {
  it("labels its controls", () => {
    mount();
    expect(document.body.querySelector('[role="search"]')?.getAttribute("aria-label")).toBe("Filter skipped employees");
    expect(must("skipped-search").getAttribute("aria-label")).toBe("Search skipped employees");
    expect(must("skipped-category").getAttribute("aria-label")).toBe("Filter by reason");
    expect(must("skipped-card-no_rate-filter").getAttribute("aria-pressed")).toBe("false");
  });

  it("is one element a page can place anywhere", () => {
    const el = mount();
    expect(el.firstElementChild?.getAttribute("data-testid")).toBe("skipped-panel");
  });

  it("outlines a selected card in the page's accent", () => {
    mount({ accent: "amber" });
    click(must("skipped-card-no_rate-filter"));
    expect(must("skipped-card-no_rate").style.boxShadow).toBe("0 0 0 2px #d97706");
    act(() => root!.unmount());
    host!.remove();
    mount({ accent: "indigo" });
    click(must("skipped-card-no_rate-filter"));
    expect(must("skipped-card-no_rate").style.boxShadow).toBe("0 0 0 2px #4f46e5");
  });
});
