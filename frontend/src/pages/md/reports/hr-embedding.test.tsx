// The MD portal embeds the HR Report Center (its nav rail, workspace and links take an optional base path). These tests
// pin that the HR portal's own Reports page is exactly what it was: same links, same buttons, same colours.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetPrefsCache } from "@/lib/report-prefs";
import HrReports from "@/pages/hr/Reports";
import { reportHref } from "@/pages/hr/report-center/ReportCatalogView";
import { categoryStyle } from "@/pages/hr/report-center/report-icons";
import { renderMdPage, type Fixtures, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { catalogFixture, employeeMasterRun } from "./test-fixtures";

let page: RenderedPage | undefined;

beforeEach(() => {
  localStorage.clear();
  _resetPrefsCache();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  page?.unmount();
  page = undefined;
});

const none: unknown[] = [];
/** What the HR portal's shell asks for besides the reports (sidebar badges), and who is signed in: a plain admin. */
const HR_SHELL: Fixtures = {
  "/api/auth/me": { role: "hr", employeeId: null, name: "HR Admin", isMd: false, isSuperAdmin: true, permissions: {} },
  "/api/leave-requests": none,
  "/api/permissions": none,
  "/api/recruitment/resignations": none,
  "/api/advances": none,
  "/api/on-duty-sessions": none,
  "/api/on-duty-punch-verifications": none,
  "/api/outpass-requests": none,
  "/api/notifications": none,
};

const open = (path: string) =>
  renderMdPage(
    HrReports,
    {
      ...HR_SHELL,
      "/api/reports/catalog": catalogFixture({ executive: false }),
      "/api/reports/run/employee-master": employeeMasterRun(),
    },
    { path },
  );

const hrefs = () => Array.from(page!.container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");

describe("the HR portal's Reports page", () => {
  it("lists the catalog with its links under /hr/reports", async () => {
    page = await open("/hr/reports");
    expect(page.text()).toContain("Payroll & Salary");
    expect(hrefs()).toContain("/hr/reports?report=salary-register");
    expect(hrefs().some((h) => h.startsWith("/md/"))).toBe(false);
    expect(page.text()).not.toContain("Executive");
  });

  it("opens a report with the same workspace, links and buttons as before", async () => {
    page = await open("/hr/reports?report=employee-master&run=1");
    expect(page.text()).toContain("Asha Kumar");

    const rail = page.container.querySelector('nav[aria-label="Reports"]')!;
    const railLinks = Array.from(rail.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
    expect(railLinks).toContain("/hr/reports"); // "All reports"
    expect(railLinks).toContain("/hr/reports?report=salary-register");
    expect(railLinks.some((h) => h.startsWith("/md/"))).toBe(false);
    expect(hrefs()).toContain("/hr/reports"); // the breadcrumb

    expect(page.container.querySelector('[data-testid="report-download-pdf"]')).not.toBeNull();
    expect(page.container.querySelector('[data-testid="report-download-xlsx"]')).not.toBeNull();
    // Print is the MD portal's addition: the HR page has no such button and no print sheet
    expect(page.container.querySelector('[data-testid="report-print"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="report-print-sheet"]')).toBeNull();
  });

  it("links a report that is not in the catalog back to /hr/reports", async () => {
    page = await open("/hr/reports?report=nope");
    const back = Array.from(page.container.querySelectorAll("a")).find((a) => a.textContent === "Browse all reports");
    expect(back?.getAttribute("href")).toBe("/hr/reports");
  });
});

describe("the shared helpers", () => {
  it("point at /hr/reports unless told otherwise", () => {
    expect(reportHref("salary-register")).toBe("/hr/reports?report=salary-register");
    expect(reportHref("salary-register", "/md/reports")).toBe("/md/reports?report=salary-register");
    expect(reportHref("a b&c")).toBe("/hr/reports?report=a%20b%26c");
  });

  it("colour the executive category gold and every other category as before", () => {
    expect(categoryStyle("md").dot).toContain("#e0a83a");
    expect(categoryStyle("payroll").dot).toBe("bg-emerald-500");
    expect(categoryStyle("hr").dot).toBe("bg-teal-500");
    expect(categoryStyle("no-such-category")).toBe(categoryStyle("admin")); // the fallback is unchanged
  });
});
