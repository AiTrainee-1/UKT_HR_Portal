import { act, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isMutatingControl } from "@/lib/view-only-lock";
import { noBreakdownDetails, staffDetails } from "./fixtures";
import {
  all,
  apiError,
  click,
  here,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  openLoaded,
  press,
  q,
  scrolledTo,
  settle,
  text,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// The details page of one payroll in jsdom, with a fake server behind customFetch: what it shows while loading, when
// the payroll is missing or the server fails, the header, the dashboard figures, how the salary was worked out, the
// section bar, and what the buttons do (Back, Previous / Next, Mark as paid, the payslip, Export).

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  mutateAsync: vi.fn(),
  preview: vi.fn(),
  download: vi.fn(),
  workbook: vi.fn(),
  csv: vi.fn(),
  excel: vi.fn(),
}));

// The shell's <main> is what scrolls on the real page: a scroll container here lets the tests see where the page is.
vi.mock("@/components/HrLayout", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ children }: { children: ReactNode }) =>
      createElement("main", { "data-testid": "shell", style: { overflowY: "auto" } }, children),
  };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "tok", user: null }) }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  useUpdatePayrollRecord: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
  previewDocumentPdf: h.preview,
  downloadDocumentPdf: h.download,
}));
vi.mock("@/components/payroll/kit/export-table", () => ({ exportTableToExcel: h.excel, exportTableToCsv: h.csv }));
vi.mock("./workbook", () => ({ exportDetailsWorkbook: h.workbook }));

let world: World;
let scroll: ReturnType<typeof vi.fn>;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  world = installWorld(h.fetch);
  h.mutateAsync.mockReset();
  h.mutateAsync.mockResolvedValue({});
  h.preview.mockResolvedValue(undefined);
  h.download.mockResolvedValue(undefined);
  scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll as unknown as Element["scrollIntoView"];
});

afterEach(() => {
  unmountPage();
  vi.restoreAllMocks();
});

const STAFF = "/hr/payroll/details/101";
const FROM_LIST = { fromPayroll: true };
const openStaff = (suffix = "", state: unknown = FROM_LIST) => openLoaded(`${STAFF}${suffix}`, state);

/** Opens a Radix dropdown from its trigger (the keyboard way, which jsdom handles). */
const openMenu = (testId: string) => press(must(testId), "Enter");

describe("loading", () => {
  it("shows the shape of the page, with the payroll loader, until the payroll arrives", async () => {
    const release = world.hold("staff", 101);
    mountPage(STAFF, FROM_LIST);
    await settle(20);
    expect(q("pd-skeleton")).not.toBeNull();
    expect(q("pd-body")).toBeNull();
    expect(q("payroll-loader")).not.toBeNull();
    expect(text(q("payroll-loader"))).toContain("Loading the payroll");
    // the header, the six dashboard tiles (each already labelled) and the section bar are drawn as placeholders
    expect(text(q("pd-skeleton-kpis"))).toContain("Net payable");
    expect(q("pd-skeleton-kpis")!.children).toHaveLength(6);
    expect(text(q("pd-back"))).toBe("Back to Payroll");
    // Back works before anything has loaded
    release();
    await waitFor(() => !!q("pd-body"), "the payroll");
    expect(q("pd-skeleton")).toBeNull();
    expect(text(q("pd-employee-name"))).toBe("Meena Subramanian");
  });

  it("asks for this payroll's details, and only those (plus the company name for the files)", async () => {
    await openStaff();
    expect(world.requests()).toContain("/api/payroll/101/details");
    expect(world.requests().filter((r) => r.includes("/details"))).toEqual(["/api/payroll/101/details"]);
  });
});

describe("a payroll that cannot be shown", () => {
  it("says it was not found, or is not for this login, when the server says 404, and Back goes to the list", async () => {
    world.staff.set(404, apiError(404));
    mountPage("/hr/payroll/details/404", null);
    await waitFor(() => !!q("pd-not-found"), "the not-found state");
    expect(text(q("pd-not-found"))).toContain("This payroll was not found, or you do not have access to it");
    expect(q("pd-skeleton")).toBeNull();
    expect(h.fetch.mock.calls.filter((c) => String(c[0]).includes("/404/details"))).toHaveLength(1); // not retried
    click(q("pd-not-found-back"));
    expect(here()).toBe("/hr/payroll");
  });

  it("says the same for a payroll the role may not open (403)", async () => {
    world.staff.set(55, apiError(403));
    mountPage("/hr/payroll/details/55", null);
    await waitFor(() => !!q("pd-not-found"), "the not-found state");
    expect(q("pd-error")).toBeNull();
  });

  it("an address that is not a payroll id is not even asked for", async () => {
    mountPage("/hr/payroll/details/abc", null);
    await waitFor(() => !!q("pd-not-found"), "the not-found state");
    expect(h.fetch.mock.calls.some((c) => String(c[0]).includes("/details"))).toBe(false);
  });

  it("the production page says it as Production Payroll and goes back to that list", async () => {
    mountPage("/hr/production-payroll/details/9999", null);
    await waitFor(() => !!q("pd-not-found"), "the not-found state");
    expect(text(q("pd-not-found-back"))).toBe("Back to Production Payroll");
    click(q("pd-not-found-back"));
    expect(here()).toBe("/hr/production-payroll");
  });

  it("any other failure says what happened and Retry asks again", async () => {
    world.staff.set(101, new Error("The database is busy"));
    mountPage(STAFF, FROM_LIST);
    await waitFor(() => !!q("pd-error"), "the error state");
    expect(text(q("pd-error"))).toContain("Could not load this payroll");
    expect(text(q("pd-error"))).toContain("The database is busy");
    expect(q("pd-not-found")).toBeNull();
    world.staff.set(101, staffDetails());
    click(q("pd-retry"));
    await waitFor(() => !!q("pd-body"), "the payroll after Retry");
    expect(q("pd-error")).toBeNull();
    expect(text(q("pd-employee-name"))).toBe("Meena Subramanian");
  });

  it("when a refresh fails the payroll stays on screen with a way to try again", async () => {
    await openStaff();
    world.staff.set(101, new Error("Network down"));
    click(q("pd-refresh"));
    await waitFor(() => !!q("pd-stale"), "the stale notice");
    expect(text(q("pd-stale"))).toContain("Could not refresh this payroll");
    expect(text(q("pd-employee-name"))).toBe("Meena Subramanian"); // still there
    world.staff.set(101, staffDetails());
    click(q("pd-stale")!.querySelector("button"));
    await waitFor(() => !q("pd-stale"), "the notice to go");
  });
});

describe("the header", () => {
  it("names the employee, what they are, which payroll this is and when it was computed", async () => {
    await openStaff();
    expect(text(q("pd-employee-name"))).toBe("Meena Subramanian");
    expect(text(q("pd-employee-code"))).toBe("UKT-0142");
    const chips = text(q("pd-chips"));
    for (const expected of ["Accounts", "Senior Accountant", "Staff", "Head Office", "October 2026", "Pending"]) {
      expect(chips, expected).toContain(expected);
    }
    expect(text(q("pd-status"))).toBe("Pending");
    const computed = text(q("pd-computed"));
    expect(computed).toMatch(/Last computed \d{1,2} Oct 2026, \d\d:\d\d/);
    expect(computed).toContain("ago)");
    expect(computed).toMatch(/first generated \d{1,2} Oct 2026, \d\d:\d\d/);
    expect(computed).toContain("payslip SLP-2026-10-0142");
    expect(text(q("pd-back"))).toBe("Back to Payroll · October 2026");
    expect(must("pd-settings-link").getAttribute("href")).toBe("/hr/settings?tab=payroll");
  });

  it("marks a payroll that is paid, and an employee who has left", async () => {
    world.staff.set(
      101,
      staffDetails({ status: "paid", employee: { ...staffDetails().employee, status: "inactive" } }),
    );
    await openStaff();
    expect(text(q("pd-status"))).toBe("Paid");
    expect(text(q("pd-chips"))).toContain("Inactive employee");
    expect(q("pd-mark-paid")).toBeNull();
  });
});

describe("the dashboard", () => {
  it("gross, deductions, net payable, days worked, issues and rules, each with what explains it", async () => {
    await openStaff();
    expect(text(q("pd-kpi-gross"))).toContain("₹26,663");
    expect(text(q("pd-kpi-gross"))).toContain("of a ₹29,500 monthly salary");
    expect(text(q("pd-kpi-deductions"))).toContain("₹3,167");
    expect(text(q("pd-kpi-deductions"))).toContain("11.9% of gross");
    expect(text(q("pd-kpi-net-value"))).toBe("₹23,496");
    expect(text(q("pd-kpi-net"))).toContain("To be paid");
    expect(text(q("pd-kpi-days"))).toContain("Days worked");
    expect(text(q("pd-kpi-days-value"))).toBe("23.5 / 26");
    expect(text(q("pd-kpi-days"))).toContain("21 present · 2 paid leave · 1 half · 2 LOP");
    expect(text(q("pd-kpi-issues-value"))).toBe("11");
    expect(text(q("pd-kpi-issues"))).toContain("1 critical · 8 warnings · 2 info");
    expect(text(q("pd-kpi-rules-value"))).toBe("15");
    expect(text(q("pd-kpi-rules"))).toContain("1 changed since generated");
  });

  it("a clean payroll says so on the Issues tile, and an unchanged one on the Rules tile", async () => {
    mountPage("/hr/payroll/details/102", null);
    await waitFor(() => !!q("pd-body"), "the clean payroll");
    expect(text(q("pd-kpi-issues-value"))).toBe("0");
    expect(text(q("pd-kpi-issues"))).toContain("Nothing to flag: this payroll is clean");
    expect(text(q("pd-kpi-rules"))).toContain("applied as configured");
    expect(q("pd-nav-issues-count")).toBeNull();
    expect(q("pd-nav-rules-changed")).toBeNull();
  });

  it("draws gross -> deductions -> net as one bar, in numbers too", async () => {
    await openStaff();
    const bridge = text(q("pd-net-bridge"));
    expect(bridge).toContain("From gross to net");
    expect(bridge).toContain("₹26,663.46");
    expect(bridge).toContain("₹3,167.23");
    expect(bridge).toContain("₹23,496.23");
    expect(q("pd-net-bridge-bar")!.getAttribute("aria-label")).toBe(
      "Gross ₹26,663.46, deductions ₹3,167.23, net payable ₹23,496.23",
    );
    expect(parseFloat(q("pd-bridge-net")!.style.width)).toBeCloseTo(88.12, 1);
    expect(parseFloat(q("pd-bridge-deductions")!.style.width)).toBeCloseTo(11.88, 1);
  });

  it("the Issues and Rules tiles take the reader to those sections", async () => {
    await openStaff();
    click(q("pd-kpi-issues"));
    click(q("pd-kpi-rules"));
    expect(scrolledTo(scroll)).toEqual(["pd-issues", "pd-rules"]);
  });
});

describe("how this salary was worked out", () => {
  it("shows the arithmetic, the stored lines with their notes, and the net payable", async () => {
    await openStaff();
    const formula = text(q("pd-formula"));
    expect(formula).toContain("Monthly salary₹29,500");
    expect(formula).toContain("Working days26");
    expect(formula).toContain("Daily rate₹1,134.62");
    expect(formula).toContain("Paid days23.5");
    expect(formula).toContain("Salary earned₹26,663.46");

    const earned = must("pd-line-earned");
    expect(earned.dataset.kind).toBe("earning");
    expect(text(earned)).toContain("₹1,134.62 x 23.5 paid days (21 present + 0.5 half day + 2 paid leave)");
    expect(text(earned)).toContain("₹26,663.46");
    expect(must("pd-line-monthly_salary").dataset.kind).toBe("info");
    expect(text(q("pd-line-monthly_salary"))).toContain("not added");
    expect(must("pd-line-gross").dataset.kind).toBe("subtotal");

    const pf = must("pd-line-pf");
    expect(pf.dataset.kind).toBe("deduction");
    expect(text(pf)).toContain("₹1,599.92");
    expect(text(pf)).toContain("12% of basic ₹13,332.69");
    expect(pf.querySelector("p:last-child")!.className).toContain("text-red-700");
    expect(text(q("pd-deductions"))).toContain("Total deductions");

    expect(text(q("pd-net-amount"))).toBe("₹23,496.23");
    expect(text(q("pd-net-callout"))).toContain("Gross ₹26,663.46 - deductions ₹3,167.23");
  });

  it("a line points at its rule only when the payroll has that rule", async () => {
    await openStaff();
    expect(q("pd-line-rule-pf")).not.toBeNull(); // pf_rate is among the rules
    expect(q("pd-line-rule-late")).not.toBeNull(); // late_slabs is
    expect(q("pd-line-rule-advance")).toBeNull(); // no rule key
    click(q("pd-line-rule-pf"));
    await settle(10);
    // it jumps to the rules and brings that one rule into view
    expect(scrolledTo(scroll)).toContain("pd-rules");
    expect(scrolledTo(scroll)).toContain("pf_rate");
    expect(must("pd-rule-pf_rate").className).toContain("ring-2");
  });

  it("with no lines stored it says so instead of leaving a blank", async () => {
    world.staff.set(101, staffDetails({ earnings: [], deductions: [] }));
    await openStaff();
    expect(text(q("pd-earnings"))).toContain("No earnings lines were stored for this payroll.");
    expect(text(q("pd-deductions"))).toContain("No deductions on this payroll.");
  });
});

describe("the section bar", () => {
  it("lists the seven sections, marks the one being read, and shows what needs a look", async () => {
    await openStaff();
    const buttons = [...must("pd-nav").querySelectorAll("button")];
    expect(buttons.map(text)).toEqual([
      "Overview",
      "Rules",
      "Issues11",
      "Attendance",
      "Pay & deductions",
      "Employee",
      "History",
    ]);
    expect(must("pd-nav-overview").getAttribute("aria-current")).toBe("location");
    expect(must("pd-nav-issues-count").className).toContain("bg-red-500"); // there is a critical issue
    expect(must("pd-nav-rules-changed").title).toBe("1 rule changed since this payroll was generated");
    expect(must("pd-nav").getAttribute("aria-label")).toBe("Payroll sections");
    expect(text(q("pd-nav-bar"))).toContain("Meena Subramanian · UKT-0142");
  });

  it("every section is on the page at once, each with the id the bar scrolls to", async () => {
    await openStaff();
    for (const id of ["overview", "rules", "issues", "attendance", "pay", "employee", "history"]) {
      expect(document.getElementById(`pd-${id}`), id).not.toBeNull();
      expect(q(`pd-section-${id}`)?.id).toBe(`pd-${id}`);
    }
  });

  it("pressing a section scrolls to it and marks it", async () => {
    await openStaff();
    click(q("pd-nav-attendance"));
    expect(scrolledTo(scroll)).toEqual(["pd-attendance"]);
    expect(must("pd-nav-attendance").getAttribute("aria-current")).toBe("location");
    expect(must("pd-nav-overview").getAttribute("aria-current")).toBeNull();
    click(q("pd-nav-history"));
    expect(scrolledTo(scroll)).toEqual(["pd-attendance", "pd-history"]);
    expect(must("pd-nav-history").getAttribute("aria-current")).toBe("location");
  });

  it("?section=issues opens the page scrolled to the issues, once", async () => {
    await openStaff("?section=issues");
    await waitFor(() => scrolledTo(scroll).includes("pd-issues"), "the scroll to Issues");
    await settle(30);
    expect(scrolledTo(scroll).filter((id) => id === "pd-issues")).toHaveLength(1);
    expect(must("pd-nav-issues").getAttribute("aria-current")).toBe("location");
  });

  it("?section=days is the attendance section, and an unknown section is ignored", async () => {
    await openStaff("?section=days");
    await waitFor(() => scrolledTo(scroll).includes("pd-attendance"), "the scroll to Attendance");
    unmountPage();
    scroll.mockClear();
    await openStaff("?section=nonsense");
    await settle(30);
    expect(scrolledTo(scroll)).toEqual([]);
  });
});

describe("Back", () => {
  it("returns to the list exactly as it was when the list opened this page", async () => {
    await openStaff("", FROM_LIST);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    click(q("pd-back"));
    expect(back).toHaveBeenCalledTimes(1);
    expect(here()).toBe(STAFF); // it asked the browser to go back; it did not navigate by itself
  });

  it("goes to the list of the payroll's own period when there is no history behind it (a pasted link)", async () => {
    await openStaff("", null);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    click(q("pd-back"));
    expect(back).not.toHaveBeenCalled();
    expect(here()).toBe("/hr/payroll?month=10&year=2026");
  });

  it("the production page goes back to its cycle and period", async () => {
    mountPage("/hr/production-payroll/details/301", null);
    await waitFor(() => !!q("pd-body"), "the production payroll");
    expect(text(q("pd-back"))).toBe("Back to Production Payroll · Weekly");
    click(q("pd-back"));
    expect(here()).toBe("/hr/production-payroll/weekly?period=2026-10-05_2026-10-11");
  });
});

describe("Previous and Next", () => {
  it("say where this payroll is among the period's, and are off at the ends", async () => {
    await openStaff();
    expect(text(q("pd-position"))).toBe("3 of 42");
    expect(must("pd-prev").hasAttribute("disabled")).toBe(false);
    expect(must("pd-next").hasAttribute("disabled")).toBe(false);
    expect(must("pd-prev").getAttribute("aria-label")).toBe("Previous payroll");
    expect(must("pd-next").getAttribute("aria-label")).toBe("Next payroll");
    unmountPage();
    mountPage("/hr/payroll/details/103", null);
    await waitFor(() => !!q("pd-body"), "the last payroll");
    expect(must("pd-next").hasAttribute("disabled")).toBe(true);
    expect(must("pd-prev").hasAttribute("disabled")).toBe(false);
  });

  it("Next replaces the entry, so Back still leaves for the list in one step", async () => {
    await openStaff();
    const entries = window.history.length;
    click(q("pd-next"));
    expect(here()).toBe("/hr/payroll/details/102");
    expect(window.history.length).toBe(entries);
    expect(window.history.state).toEqual(FROM_LIST); // still "opened from the list"
    await waitFor(() => text(q("pd-employee-name")) === "Arun Prasad", "the next payroll");
    expect(text(q("pd-position"))).toBe("4 of 42");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    click(q("pd-back"));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("while the next payroll loads the old one stays, dimmed, with a spinner chip, and cannot be acted on", async () => {
    await openStaff();
    const release = world.hold("staff", 102);
    click(q("pd-next"));
    await waitFor(() => !!q("pd-switching"), "the spinner chip");
    expect(text(q("pd-switching"))).toContain("Loading the payroll");
    expect(text(q("pd-employee-name"))).toBe("Meena Subramanian");
    expect(must("pd-body").dataset.switching).toBe("true");
    expect(must("pd-body").className).toContain("opacity-60");
    expect(must("pd-body").hasAttribute("inert")).toBe(true);
    expect(must("pd-next").hasAttribute("disabled")).toBe(true);
    expect(must("pd-mark-paid").hasAttribute("disabled")).toBe(true);
    expect(q("pd-skeleton")).toBeNull(); // never a blank page in between
    release();
    await waitFor(() => !q("pd-switching"), "the chip to go");
    expect(text(q("pd-employee-name"))).toBe("Arun Prasad");
    expect(must("pd-body").dataset.switching).toBe("false");
    expect(must("pd-body").hasAttribute("inert")).toBe(false);
  });

  it("give the keyboard focus back to the button that was pressed once the next payroll is in", async () => {
    await openStaff();
    const release = world.hold("staff", 102);
    must("pd-next").focus();
    click(q("pd-next"));
    await waitFor(() => !!q("pd-switching"), "the spinner chip");
    // a page that is inert drops the focus (a real browser does this when the pressed button goes inert)
    const sink = document.createElement("button");
    document.body.append(sink);
    sink.focus();
    sink.remove();
    expect(document.activeElement).toBe(document.body);
    release();
    await waitFor(() => text(q("pd-employee-name")) === "Arun Prasad", "the next payroll");
    await waitFor(() => document.activeElement === q("pd-next"), "the focus to come back");
    expect(document.activeElement).toBe(must("pd-next"));
  });

  it("start the next payroll at its top, not where the last one was scrolled to", async () => {
    await openStaff();
    const shell = must("shell");
    Object.defineProperty(shell, "scrollTop", { value: 640, writable: true, configurable: true });
    click(q("pd-next"));
    await waitFor(() => text(q("pd-employee-name")) === "Arun Prasad", "the next payroll");
    expect(shell.scrollTop).toBe(0);
  });

  it("an earlier payroll of another period opens at its top too, and a first visit is left where the shell puts it", async () => {
    const base = staffDetails();
    world.staff.set(
      90,
      staffDetails({
        payrollId: 90,
        period: { ...base.period, label: "September 2026", month: 9, start: "2026-09-01", end: "2026-09-30" },
        context: { ...base.context, month: 9 },
      }),
    );
    await openStaff();
    const shell = must("shell");
    Object.defineProperty(shell, "scrollTop", { value: 900, writable: true, configurable: true });
    expect(shell.scrollTop).toBe(900); // nothing scrolled it on the first visit
    act(() => {
      must("pd-history-90")
        .querySelector("a")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => text(q("pd-back")) === "Back to Payroll · September 2026", "the September payroll");
    expect(shell.scrollTop).toBe(0);
  });

  it("with a section in the address the new payroll goes to that section instead of the top", async () => {
    await openStaff("?section=issues");
    await waitFor(() => scrolledTo(scroll).includes("pd-issues"), "the first scroll to Issues");
    const shell = must("shell");
    Object.defineProperty(shell, "scrollTop", { value: 640, writable: true, configurable: true });
    click(q("pd-next"));
    await waitFor(() => text(q("pd-employee-name")) === "Arun Prasad", "the next payroll");
    await waitFor(() => scrolledTo(scroll).filter((id) => id === "pd-issues").length === 2, "the second scroll");
    expect(shell.scrollTop).toBe(640); // not sent to the top
  });

  it("keep the section the address names, so a reviewer can go through the Issues of everyone", async () => {
    await openStaff("?section=issues");
    click(q("pd-next"));
    expect(here()).toBe("/hr/payroll/details/102?section=issues");
    await waitFor(() => text(q("pd-employee-name")) === "Arun Prasad", "the next payroll");
  });

  it("a payroll that cannot be opened ends in the not-found page, not a stuck spinner", async () => {
    await openStaff();
    world.staff.delete(102);
    click(q("pd-next"));
    await waitFor(() => !!q("pd-not-found"), "the not-found state");
    expect(q("pd-switching")).toBeNull();
  });
});

describe("Mark as paid", () => {
  it("is offered while the payroll is pending, as a normal button the view-only lock can disable", async () => {
    await openStaff();
    const button = must("pd-mark-paid") as HTMLButtonElement;
    expect(text(button)).toBe("Mark as paid");
    expect(isMutatingControl(button)).toBe(true);
  });

  it("marks it paid, says so, and refreshes every payroll query, which updates the page", async () => {
    h.mutateAsync.mockImplementation(async () => {
      world.staff.set(101, staffDetails({ status: "paid" }));
      return {};
    });
    const { client } = await openStaff();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    click(q("pd-mark-paid"));
    await waitFor(() => !q("pd-mark-paid"), "the payroll to show as paid");
    expect(h.mutateAsync).toHaveBeenCalledWith({ id: 101, data: { status: "paid" } });
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Meena Subramanian's salary marked as paid" }),
    );
    expect(text(q("pd-status"))).toBe("Paid");
    expect(text(q("pd-kpi-net"))).toContain("Paid");
    const predicate = invalidate.mock.calls[0][0]!.predicate!;
    expect(predicate({ queryKey: ["/api/payroll/insights/details", "staff", 101] } as never)).toBe(true);
    expect(predicate({ queryKey: ["/api/payroll", { month: 10, year: 2026 }] } as never)).toBe(true);
    expect(predicate({ queryKey: ["/api/payroll/production", "weekly"] } as never)).toBe(true);
    expect(predicate({ queryKey: ["/api/salary-slips"] } as never)).toBe(false);
    expect(predicate({ queryKey: ["/api/employees"] } as never)).toBe(false);
  });

  it("when the server refuses it says so, and the button is there to try again", async () => {
    h.mutateAsync.mockRejectedValue(new Error("HTTP 403 Forbidden: view-only"));
    await openStaff();
    click(q("pd-mark-paid"));
    await waitFor(() => h.toast.mock.calls.length > 0, "the failure toast");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to update status",
        description: "HTTP 403 Forbidden: view-only",
        variant: "destructive",
      }),
    );
    await waitFor(() => !must("pd-mark-paid").hasAttribute("disabled"), "the button to come back");
    expect(text(q("pd-status"))).toBe("Pending");
  });
});

describe("the payslip", () => {
  it("opens or downloads the stored payslip's PDF with the signed-in token", async () => {
    await openStaff();
    openMenu("pd-payslip-menu");
    click(q("pd-payslip-view"));
    await settle(10);
    expect(h.preview).toHaveBeenCalledTimes(1);
    expect(h.preview.mock.calls[0][0]).toBe("/api/salary-slips/7001/pdf");
    expect(h.preview.mock.calls[0][1]()).toBe("tok");
    openMenu("pd-payslip-menu");
    click(q("pd-payslip-download"));
    await settle(10);
    expect(h.download).toHaveBeenCalledTimes(1);
    expect(h.download.mock.calls[0][0]).toBe("/api/salary-slips/7001/pdf");
  });

  it("says a PDF could not be made", async () => {
    h.preview.mockRejectedValue(new Error("Failed to generate PDF"));
    await openStaff();
    openMenu("pd-payslip-menu");
    click(q("pd-payslip-view"));
    await waitFor(() => h.toast.mock.calls.length > 0, "the failure toast");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to generate PDF", variant: "destructive" }),
    );
  });

  it("is switched off, with the reason on hover, when no payslip was stored", async () => {
    mountPage("/hr/payroll/details/103", null);
    await waitFor(() => !!q("pd-body"), "the payroll");
    expect(must("pd-payslip-menu").hasAttribute("disabled")).toBe(true);
    expect(must("pd-payslip-menu").getAttribute("aria-label")).toBe("Payslip (not available)");
    expect(must("pd-payslip-unavailable").title).toBe("No payslip was stored for this payroll yet");
    expect(text(q("pd-computed"))).not.toContain("payslip SLP");
  });
});

describe("Export", () => {
  it("offers the details workbook, the issues in Excel and CSV, and print", async () => {
    await openStaff();
    openMenu("export-menu");
    expect(all("export-menu-workbook")).toHaveLength(1);
    expect(text(q("export-menu-workbook"))).toContain("Details workbook (Excel)");
    expect(text(q("export-menu-issues-xlsx"))).toContain("Issues (Excel)");
    expect(text(q("export-menu-issues-csv"))).toContain("Issues (CSV)");
    expect(text(q("export-menu-issues-csv"))).toContain("All 11 issues");
    expect(text(q("export-menu-print"))).toContain("Print this page");
  });

  it("builds the workbook for this payroll under the company's name", async () => {
    await openStaff();
    await waitFor(() => text(q("pd-print-header")).includes("UK Textiles Ltd"), "the company name");
    openMenu("export-menu");
    click(q("export-menu-workbook"));
    await waitFor(() => h.workbook.mock.calls.length > 0, "the workbook to be built");
    expect(h.workbook.mock.calls[0][0]).toMatchObject({ payrollId: 101, employee: { name: "Meena Subramanian" } });
    expect(h.workbook.mock.calls[0][1]).toBe("UK Textiles Ltd");
  });

  it("exports every issue as CSV", async () => {
    await openStaff();
    openMenu("export-menu");
    click(q("export-menu-issues-csv"));
    await waitFor(() => h.csv.mock.calls.length > 0, "the CSV");
    expect(h.csv.mock.calls[0][0].rows).toHaveLength(11);
    expect(h.csv.mock.calls[0][0].filename).toBe("Payroll_Issues_Meena_Subramanian_October_2026");
  });

  it("prints the page", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    await openStaff();
    openMenu("export-menu");
    click(q("export-menu-print"));
    await settle(10);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("brings its own print stylesheet: the sidebar and phone bar are hidden, the sections flow", async () => {
    await openStaff();
    const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    expect(css).toContain("@media print");
    expect(css).toContain("aside");
    expect(css).toContain("break-inside: avoid");
    expect(text(q("pd-print-header"))).toContain("Meena Subramanian (UKT-0142) · October 2026");
    expect(must("pd-print-header").className).toContain("print:block");
    expect(must("pd-nav-bar").className).toContain("print:hidden");
    expect(must("pd-actions").className).toContain("print:hidden");
  });

  it("is not locked for a View Only role: the lock's only target on this page is Mark as paid", async () => {
    await openStaff();
    openMenu("export-menu");
    const locked = [...document.body.querySelectorAll("button")].filter((b) => isMutatingControl(b));
    expect(locked.map((b) => b.dataset.testid)).toEqual(["pd-mark-paid"]);
    expect(isMutatingControl(must("export-menu") as HTMLButtonElement)).toBe(false);
    expect(isMutatingControl(must("pd-issues-export") as HTMLButtonElement)).toBe(false);
  });
});

describe("a payroll with no day-by-day breakdown behind it", () => {
  it("says why its days, rules and issues are missing, in the server's own words, instead of calling it clean", async () => {
    mountPage("/hr/payroll/details/105", null);
    await waitFor(() => !!q("pd-body"), "the payroll");
    const notice = text(q("pd-degraded"));
    expect(notice).toContain("Some details are not available for this payroll");
    expect(notice).toContain("No day-by-day breakdown is stored for this payroll (it has no salary slip)");
    // each missing section says so; none of them claims the payroll is clean
    expect(text(q("pd-issues-unavailable"))).toContain("Issues cannot be detected for this payroll");
    expect(q("pd-issues-clean")).toBeNull();
    expect(text(q("pd-kpi-issues-value"))).toBe("—");
    expect(text(q("pd-kpi-issues"))).toContain("No breakdown to check");
    expect(text(q("pd-kpi-rules-value"))).toBe("—");
    expect(text(q("pd-kpi-rules"))).toContain("None stored");
    expect(text(q("pd-rules-empty"))).toContain("No rules were stored with this payroll");
    expect(text(q("pd-attendance-empty"))).toContain("No day records were stored for this payroll");
    // what the payroll does have is still there: the money, and the summary counts
    expect(text(q("pd-kpi-net"))).toContain("₹23,496");
    expect(text(q("pd-kpi-days-value"))).toBe("22 / 26");
    // the notes are in the notice, not repeated as an HR adjustment
    expect(q("pd-adjustment-note")).toBeNull();
  });

  it("an older session-based production payroll says so, and is marked as one", async () => {
    mountPage("/hr/production-payroll/details/304", null);
    await waitFor(() => !!q("pd-body"), "the payroll");
    expect(text(q("pd-degraded"))).toContain("older session-based production engine");
    expect(text(q("pd-chips"))).toContain("Legacy session payroll");
    expect(q("pd-issues-clean")).toBeNull();
    expect(text(q("pd-position"))).toBe("1 of 1");
  });

  it("a payroll with its breakdown, even a clean one, shows no such notice", async () => {
    await openStaff();
    expect(q("pd-degraded")).toBeNull();
    unmountPage();
    mountPage("/hr/payroll/details/102", null);
    await waitFor(() => !!q("pd-body"), "the clean payroll");
    expect(q("pd-degraded")).toBeNull();
    expect(q("pd-issues-clean")).not.toBeNull();
  });

  it("falls back to its own sentence when the server sent no notes", async () => {
    world.staff.set(105, noBreakdownDetails({ notes: null }));
    mountPage("/hr/payroll/details/105", null);
    await waitFor(() => !!q("pd-body"), "the payroll");
    expect(text(q("pd-degraded"))).toContain("No day-by-day breakdown is stored for this payroll");
  });
});

describe("the notes on a payroll", () => {
  it("keep the line breaks HR typed", async () => {
    world.staff.set(101, staffDetails({ notes: "Festival bonus approved\nPaid with the October salary" }));
    await openStaff();
    const note = must("pd-adjustment-note");
    expect(note.className).toContain("whitespace-pre-line");
    expect(note.textContent).toBe("Festival bonus approved\nPaid with the October salary");
  });
});

describe("a Production payroll", () => {
  const openProduction = () => openLoaded("/hr/production-payroll/details/301", FROM_LIST);

  it("is the same page in amber: its own kind, labels, figures and links", async () => {
    await openProduction();
    expect(must("payroll-details-page").dataset.kind).toBe("production");
    expect(text(q("pd-employee-name"))).toBe("Ravi Kumar");
    expect(text(q("pd-chips"))).toContain("Weekly cycle");
    expect(text(q("pd-chips"))).toContain("5 Oct - 11 Oct 2026");
    expect(text(q("pd-back"))).toBe("Back to Production Payroll · Weekly");
    expect(must("pd-settings-link").getAttribute("href")).toBe("/hr/settings?tab=production_payroll");
    expect(must("pd-header-bar").className).toContain("bg-amber-500");
    expect(must("pd-nav-overview").className).toContain("bg-amber-600");
    expect(text(q("pd-kpi-days"))).toContain("Shifts");
    expect(text(q("pd-kpi-days-value"))).toBe("4.5");
    expect(text(q("pd-kpi-days"))).toContain("5 days worked · 1 absent");
    expect(text(q("pd-kpi-gross"))).toContain("at ₹650 a shift");
  });

  it("shows shifts x rate, and has no Previous payroll when it is the first", async () => {
    await openProduction();
    const formula = text(q("pd-formula"));
    expect(formula).toContain("Shifts earned4.5");
    expect(formula).toContain("Rate per shift₹650");
    expect(formula).toContain("Gross₹2,925.00");
    expect(text(q("pd-position"))).toBe("1 of 18");
    expect(must("pd-prev").hasAttribute("disabled")).toBe(true);
    expect(must("pd-next").hasAttribute("disabled")).toBe(false);
  });

  it("asks the production endpoint, and Mark as paid is the same update", async () => {
    await openProduction();
    expect(world.requests()).toContain("/api/payroll/production/301/details");
    click(q("pd-mark-paid"));
    await settle(10);
    expect(h.mutateAsync).toHaveBeenCalledWith({ id: 301, data: { status: "paid" } });
  });

  it("the staff page refuses a production-only address with the production kind unaffected", async () => {
    mountPage("/hr/payroll/details/301", null);
    await waitFor(() => !!q("pd-not-found"), "the not-found state");
    expect(world.requests()).toContain("/api/payroll/301/details");
  });
});
