import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAssistant, getAssistantState, setAssistantContext } from "@/lib/md/assistant-store";
import { _resetPrefsCache } from "@/lib/report-prefs";
import { renderMdPage, type Fixtures, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import MdReports from "../MdReports";
import { REPORTS, catalogFixture, emptyRun, employeeMasterRun, meta, simpleRun } from "./test-fixtures";

let page: RenderedPage | undefined;

beforeEach(() => {
  localStorage.clear();
  _resetPrefsCache();
  Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout: the workspace scrolls itself into view
});

afterEach(() => {
  page?.unmount();
  page = undefined;
  closeAssistant();
  setAssistantContext(null);
  vi.restoreAllMocks();
});

const RUN = "/api/reports/run/employee-master";

function open(path: string, extra: Fixtures = {}, catalog = catalogFixture()) {
  return renderMdPage(MdReports, { "/api/reports/catalog": catalog, [RUN]: employeeMasterRun(), ...extra }, { path });
}

const q = (selector: string) => page!.container.querySelector<HTMLElement>(selector);
const hrefs = () => Array.from(page!.container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
const text = (selector: string) => q(selector)?.textContent ?? "";

describe("the library", () => {
  it("opens on the executive shelf and the reports grouped by category", async () => {
    page = await open("/md/reports");

    expect(text('[data-testid="md-page-title"]')).toBe("Reports");
    expect(text('[data-testid="md-executive-shelf"]')).toContain("Daily Brief");
    for (const name of ["Payroll & Salary", "Attendance", "Gate & Visitors", "Employees"]) {
      expect(text('[data-testid="md-report-library"]')).toContain(name);
    }
    for (const title of [
      "Salary Register",
      "PF Statement",
      "Daily Attendance",
      "Visitor Register",
      "Employee Master",
    ]) {
      expect(text('[data-testid="md-report-library"]')).toContain(title);
    }
    // the two late-coming views are one card
    expect(text('[data-testid="md-report-library"]')).toContain("Late Coming Detail");
    expect(text('[data-testid="md-report-library"]')).toContain("2 views: Detail · Counts");
    // the executive report is on the shelf, not repeated in the library
    expect(q('[data-testid="md-report-library"] [data-testid="report-card-md-daily-brief"]')).toBeNull();
    expect(q('[data-testid="md-category-md"]')).toBeNull();
  });

  it("keeps every link inside the MD portal", async () => {
    page = await open("/md/reports");
    const reportLinks = hrefs().filter((h) => h.includes("report="));
    expect(reportLinks.length).toBeGreaterThanOrEqual(7);
    expect(reportLinks.every((h) => h.startsWith("/md/reports?report="))).toBe(true);
    expect(hrefs().some((h) => h.startsWith("/hr/"))).toBe(false);
    expect(q('a[href="/md/reports?report=md-daily-brief"]')?.textContent).toContain("Open report");
  });

  it("says the executive reports are being prepared when there are none yet", async () => {
    page = await open("/md/reports", {}, catalogFixture({ executive: false }));
    expect(text('[data-testid="md-executive-empty"]')).toContain("Executive reports are being prepared");
    expect(q('[data-testid="md-executive-shelf"] a')).toBeNull();
    expect(text('[data-testid="md-report-library"]')).toContain("Salary Register"); // the library is still all there
  });

  it("searches across title, description and category", async () => {
    page = await open("/md/reports");
    const library = () => text('[data-testid="md-report-library"]');

    await page.type('[data-testid="md-report-search"]', "gate"); // only the category name says "gate"
    expect(text('[data-testid="md-report-count"]')).toBe("1 of 7 reports match “gate”.");
    expect(library()).toContain("Visitor Register");
    expect(library()).toContain("Gate & Visitors"); // results name their category
    expect(library()).not.toContain("Salary Register");

    await page.type('[data-testid="md-report-search"]', "minutes late"); // only a description says it
    expect(library()).toContain("Late Coming Detail");
    expect(library()).not.toContain("Visitor Register");

    await page.type('[data-testid="md-report-search"]', "overtime by department");
    expect(text('[data-testid="md-report-no-match"]')).toContain("No report matches “overtime by department”");

    await page.click('button[aria-label="Clear search"]');
    expect(q('[data-testid="md-report-count"]')).toBeNull();
    expect(library()).toContain("Salary Register");
  });

  it("narrows to one category with a chip, and back", async () => {
    page = await open("/md/reports");
    await page.click('[data-testid="md-chip-attendance"]');
    expect(q('[data-testid="md-chip-attendance"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(text('[data-testid="md-report-library"]')).toContain("Daily Attendance");
    expect(text('[data-testid="md-report-library"]')).not.toContain("Salary Register");

    await page.click('[data-testid="md-chip-attendance"]');
    expect(text('[data-testid="md-report-library"]')).toContain("Salary Register");
  });

  it("shows the first few of a long category and the rest on 'Show all'", async () => {
    const many = Array.from({ length: 8 }, (_, i) => meta(`extra-${i}`, "employees", { title: `Extra Report ${i}` }));
    page = await open("/md/reports", {}, { ...catalogFixture(), reports: [...REPORTS, ...many] });
    const employees = () =>
      page!.container.querySelectorAll('[data-testid="md-category-employees"] [data-testid^="report-card-"]');
    expect(employees()).toHaveLength(6); // Employee Master + 5 of the extras
    expect(text('[data-testid="md-more-employees"]')).toContain("Show all 9");

    await page.click('[data-testid="md-more-employees"]');
    expect(employees()).toHaveLength(9);
    expect(text('[data-testid="md-more-employees"]')).toContain("Show fewer");
  });

  it("lists recently opened and starred reports from this browser, skipping ones the catalog no longer has", async () => {
    localStorage.setItem(
      "hr_reports_recent",
      JSON.stringify(["visitor-register", "removed-report", "late-coming-counts"]),
    );
    localStorage.setItem("hr_reports_favorites", JSON.stringify(["pf-statement"]));
    _resetPrefsCache();
    page = await open("/md/reports");

    expect(
      Array.from(q('[data-testid="md-recent"]')!.querySelectorAll("a")).map((a) => a.getAttribute("href")),
    ).toEqual([
      "/md/reports?report=visitor-register",
      "/md/reports?report=late-coming-counts", // the exact view that was opened
    ]);
    expect(text('[data-testid="md-recent"]')).toContain("Late Coming Summary");
    expect(text('[data-testid="md-starred"]')).toContain("PF Statement");
  });

  it("shows no 'Recently opened' strip for a first visit", async () => {
    page = await open("/md/reports");
    expect(q('[data-testid="md-your-reports"]')).toBeNull();
  });

  it("stars a report from its card", async () => {
    page = await open("/md/reports");
    await page.click('[data-testid="report-card-salary-register"] button[aria-label="Star this report"]');
    expect(text('[data-testid="md-starred"]')).toContain("Salary Register");
    expect(JSON.parse(localStorage.getItem("hr_reports_favorites") ?? "[]")).toEqual(["salary-register"]);

    await page.click('[data-testid="report-card-salary-register"] button[aria-label="Unstar this report"]');
    expect(q('[data-testid="md-starred"]')).toBeNull();
  });
});

describe("the assistant", () => {
  it("opens with the example question from the Ask AI entry", async () => {
    page = await open("/md/reports");
    await page.click('[data-testid="md-reports-ask-ai"] [data-testid="ask-ai"]');
    const { open: isOpen, prompt } = getAssistantState();
    expect(isOpen).toBe(true);
    expect(prompt?.text).toBe("Which report shows overtime by department?");
  });

  it("is told what the library holds", async () => {
    page = await open("/md/reports");
    const context = getAssistantState().context;
    expect(context?.page).toBe("reports");
    expect(context?.summary?.["Reports in the library"]).toBe(7);
    expect(context?.summary?.["Executive reports"]).toBe(1);
    expect(context?.summary?.["Gate & Visitors"]).toBe("Visitor Register");
  });

  it("is told which report is open, with its filters and figures but not its rows", async () => {
    page = await open("/md/reports?report=employee-master&run=1");
    const context = getAssistantState().context;
    expect(context?.title).toBe("Reports: Employee Master");
    expect(context?.filters?.["Employee status"]).toBe("Active");
    expect(context?.summary?.["Employees"]).toBe("3");
    expect(JSON.stringify(context)).not.toContain("Asha");
  });

  it("can be asked about the open report", async () => {
    page = await open("/md/reports?report=employee-master&run=1");
    await page.click('[data-testid="ask-ai"][title^="Explain the"]');
    expect(getAssistantState().prompt?.text).toBe(
      'Explain the "Employee Master" report (Employee status: Active): what stands out, and what should I look at first?',
    );
  });
});

describe("an open report", () => {
  it("embeds the Report Center's workspace, with every link pointing at /md/reports", async () => {
    page = await open("/md/reports?report=employee-master&run=1");

    expect(text('[data-testid="md-page-title"]')).toBe("Reports");
    expect(page.text()).toContain("Employee Master");
    for (const word of ["Asha Kumar", "Ravi Nair", "Meena Nosalary", "Salaries are monthly gross."]) {
      expect(page.text()).toContain(word);
    }
    expect(text('[data-testid="report-summary"]')).toContain("Salary bill");
    expect(text('[data-testid="report-summary"]')).toContain("₹55,000.00");
    expect(text('[data-testid="report-applied-filters"]')).toContain("Employee status");
    // print and export are all in one place, and obvious
    for (const label of ["Print", "Download PDF", "Download Excel"]) expect(page.text()).toContain(label);

    const rail = q('nav[aria-label="Reports"]')!;
    const railLinks = Array.from(rail.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
    expect(railLinks.length).toBeGreaterThan(5);
    expect(railLinks.every((h) => h === "/md/reports" || h.startsWith("/md/reports?report="))).toBe(true);
    expect(q('a[href="/md/reports"]')).not.toBeNull(); // the breadcrumb and "All reports"
    expect(hrefs().some((h) => h.startsWith("/hr/"))).toBe(false);
    expect(page.requests()).toContain(`${RUN}?employeeStatus=active`);
  });

  it("lists the executive reports first in the rail beside an open report", async () => {
    page = await open("/md/reports?report=employee-master&run=1");
    const rail = text('nav[aria-label="Reports"]');
    expect(rail.indexOf("Executive (MD)")).toBeGreaterThanOrEqual(0);
    expect(rail.indexOf("Executive (MD)")).toBeLessThan(rail.indexOf("Payroll & Salary"));
    expect(rail).toContain("Daily Brief");
  });

  it("runs straight away when the link carries no filters", async () => {
    page = await open("/md/reports?report=employee-master");
    expect(page.text()).toContain("Asha Kumar");
    expect(page.requests().filter((r) => r.startsWith(RUN))).toEqual([`${RUN}?employeeStatus=active`]);
  });

  it("switches between the views of one report without leaving the MD portal", async () => {
    page = await open("/md/reports?report=late-coming-detail&run=1", {
      "/api/reports/run/late-coming-detail": simpleRun("late-coming-detail", "Late Coming Detail", "attendance"),
      "/api/reports/run/late-coming-counts": simpleRun("late-coming-counts", "Late Coming Summary", "attendance"),
    });
    expect(page.text()).toContain("Late Coming Detail");
    await page.click('[role="tablist"] [role="tab"]:last-child');
    expect(page.requests().some((r) => r.startsWith("/api/reports/run/late-coming-counts"))).toBe(true);
    expect(page.text()).toContain("Late Coming Summary");
    expect(hrefs().some((h) => h.startsWith("/hr/"))).toBe(false);
  });

  it("explains a report that is not in the catalog and links back to the library", async () => {
    page = await open("/md/reports?report=nope");
    expect(page.text()).toContain("This report is not available");
    const back = Array.from(page.container.querySelectorAll("a")).find((a) => a.textContent === "Browse all reports");
    expect(back?.getAttribute("href")).toBe("/md/reports");
    expect(page.requests().some((r) => r.includes("/api/reports/run/"))).toBe(false);
  });

  it("shows what is wrong with the filters, in the report's own words", async () => {
    page = await open("/md/reports?report=employee-master&run=1", {
      [RUN]: { status: 400, body: { error: "invalid_filter", message: "Choose a month." } },
    });
    expect(page.text()).toContain("Check the filters");
    expect(page.text()).toContain("Choose a month.");
    expect(q('[data-testid="report-print"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("says plainly when a report has no rows, and does not offer to print nothing", async () => {
    page = await open("/md/reports?report=employee-master&run=1", { [RUN]: emptyRun() });
    expect(page.text()).toContain("No records for these filters");
    expect(q('[data-testid="report-print"]')?.hasAttribute("disabled")).toBe(true);
    expect(q('[data-testid="report-download-pdf"]')?.hasAttribute("disabled")).toBe(true);
  });
});

describe("printing", () => {
  const sheet = () => q('[data-testid="report-print-sheet"]');

  it("prints a clean sheet with every row, then gives the screen back", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    page = await open("/md/reports?report=employee-master&run=1", { [RUN]: employeeMasterRun({}, 120) });
    expect(sheet()).toBeNull(); // nothing is built until the browser prints
    expect(q('[data-testid="md-report-screen"]')?.className).not.toContain("print:hidden");

    await page.click('[data-testid="report-print"]');
    expect(print).toHaveBeenCalledTimes(1);

    const s = sheet()!;
    expect(s).not.toBeNull();
    const rows = s.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(121); // all 120 rows (the screen pages them 50 at a time) and the grand total, once
    expect(rows[120].textContent).toContain("Total");
    expect(s.querySelector("tfoot")).toBeNull(); // a footer group would repeat the total on every printed page
    expect(page.container.querySelectorAll('[data-testid="md-report-screen"] tbody tr').length).toBeLessThanOrEqual(50);
    const bill = 24000 + 31000 + 117 * 10000;
    for (const word of [
      "UKTextiles",
      "Employee Master",
      "Employees",
      "Salary bill",
      "Asha Kumar",
      "Worker 120",
      "Notes",
    ]) {
      expect(s.textContent).toContain(word);
    }
    expect(s.textContent).toContain(`₹${bill.toLocaleString("en-IN")}.00`);
    expect(s.textContent).toContain("Generated 05-Oct-2026 10:42");
    expect(text('[data-testid="report-print-filters"]')).toContain("Employee status: Active");
    expect(s.querySelector("style")?.textContent).toContain("A4 landscape");
    expect(s.className).toContain("print:block");
    expect(q('[data-testid="md-report-screen"]')?.className).toContain("print:hidden"); // the screen steps aside

    await act(async () => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(sheet()).toBeNull();
    expect(q('[data-testid="md-report-screen"]')?.className).not.toContain("print:hidden");
  });

  it("builds the same sheet for Ctrl+P, not only for the button", async () => {
    page = await open("/md/reports?report=employee-master&run=1");
    await act(async () => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    expect(sheet()?.querySelectorAll("tbody tr")).toHaveLength(4); // 3 rows and the total
    await act(async () => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(sheet()).toBeNull();
  });

  it("prints a portrait or landscape page as the report's PDF does", async () => {
    const portrait = catalogFixture();
    portrait.reports = portrait.reports.map((r) => (r.id === "employee-master" ? { ...r, landscape: false } : r));
    page = await open("/md/reports?report=employee-master&run=1", {}, portrait);
    await act(async () => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    expect(sheet()?.querySelector("style")?.textContent).toContain("A4 portrait");
  });

  it("prints the screen as it is when there is no result to put on a sheet", async () => {
    page = await open("/md/reports?report=employee-master&run=1", { [RUN]: emptyRun() });
    await act(async () => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    expect(sheet()).toBeNull();
    expect(q('[data-testid="md-report-screen"]')?.className).not.toContain("print:hidden");
  });
});

describe("scrolling", () => {
  /** What each scrollIntoView call so far was made on (data-testid, or null for the workspace's own box). */
  const scrolledTo = () =>
    vi
      .mocked(Element.prototype.scrollIntoView)
      .mock.contexts.map((el) => (el as HTMLElement).getAttribute("data-testid"));

  it("brings the whole page, title row first, into view when a report opens", async () => {
    page = await open("/md/reports?report=employee-master&run=1");
    // the workspace scrolls to its own top (no test id); the page then scrolls to its header, which is what stays
    expect(scrolledTo()).toContain(null);
    expect(scrolledTo().at(-1)).toBe("md-report-screen");
  });

  it("opens the library at its top when coming back from a report, but not on a first visit", async () => {
    page = await open("/md/reports", {
      "/api/reports/run/salary-register": simpleRun("salary-register", "Salary Register", "payroll"),
    });
    expect(scrolledTo()).not.toContain("md-reports-home");

    await page.click('a[href="/md/reports?report=salary-register"]');
    expect(text('[data-testid="md-report-screen"]')).toContain("Salary Register");
    expect(scrolledTo()).not.toContain("md-reports-home");

    await page.click('nav[aria-label="Reports"] a[href="/md/reports"]'); // "All reports"
    expect(q('[data-testid="md-reports-home"]')).not.toBeNull();
    expect(scrolledTo()).toContain("md-reports-home");
  });
});

describe("when the catalog does not load", () => {
  it("explains it and offers a retry that recovers", async () => {
    let calls = 0;
    page = await renderMdPage(
      MdReports,
      {
        "/api/reports/catalog": () =>
          ++calls === 1 ? { status: 403, body: { error: "permission_denied" } } : catalogFixture(),
      },
      { path: "/md/reports" },
    );
    expect(text('[data-testid="md-error"]')).toContain("cannot open the Report Center");
    expect(text('[data-testid="md-page-title"]')).toBe("Reports");

    await page.click('[data-testid="md-error"] button');
    expect(q('[data-testid="md-error"]')).toBeNull();
    expect(page.text()).toContain("Salary Register");
  });
});
