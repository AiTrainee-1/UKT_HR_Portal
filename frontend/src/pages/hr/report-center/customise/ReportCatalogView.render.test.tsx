// The Report Center catalog (/hr/reports): category chips that narrow to one category (and "All"), the search and the
// category kept in the address (?q= / ?cat=), and the Customise section: "Create custom report" for editors, one tile per
// saved report with Open / Edit / Duplicate / Delete (delete confirmed in place).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportCatalog } from "@/lib/report-center";
import { _resetPrefsCache } from "@/lib/report-prefs";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { ReportCatalogView } from "../ReportCatalogView";
import { catalogFixture, savedItem } from "./test-fixtures";
import { customServer, Where, whereOf } from "./test-server";

let page: RenderedPage | undefined;

beforeEach(() => {
  localStorage.clear();
  _resetPrefsCache();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  page?.unmount();
  page = undefined;
  document.body.innerHTML = "";
});

const open = (server: ReturnType<typeof customServer>, catalog: ReportCatalog, path = "/hr/reports") =>
  renderMdPage(
    function CatalogPage() {
      return (
        <>
          <ReportCatalogView catalog={catalog} />
          <Where />
        </>
      );
    },
    server.fixtures,
    { path },
  );

/** The ids of the category sections on screen, in order. */
const sections = () =>
  Array.from(page!.container.querySelectorAll<HTMLElement>('section[id^="cat-"]')).map((s) => s.id.replace("cat-", ""));
const hrefs = () => Array.from(page!.container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
const pressed = (id: string) =>
  page!.container.querySelector(`[data-testid="report-chip-${id}"]`)?.getAttribute("aria-pressed");

const MPR = savedItem();
const PUNCH_LIST = savedItem({
  id: 8,
  reportId: "custom-8",
  name: "Gate punches",
  description: "",
  dataset: "punches",
  datasetLabel: "Punches",
  fields: ["emp.code"],
  hiddenFields: 1,
  canEdit: false,
  canDelete: false,
  updatedBy: null,
  updatedAt: null,
  createdBy: "Ravi",
  createdAt: "2026-11-02",
});

describe("category chips and the search", () => {
  it("shows every category in the server's order, with All chosen", async () => {
    const server = customServer({ saved: [MPR] });
    page = await open(server, catalogFixture({ saved: [MPR] }));
    expect(sections()).toEqual(["hr", "attendance", "payroll", "customise"]);
    expect(pressed("all")).toBe("true");
    expect(pressed("attendance")).toBe("false");
    // the chips keep their #cat- anchors (the Clean theme styles them by it)
    expect(hrefs()).toContain("#cat-attendance");
  });

  it("narrows to one category with a chip and back to all, keeping it in the address", async () => {
    const server = customServer({ saved: [MPR] });
    page = await open(server, catalogFixture({ saved: [MPR] }));
    await page.click('[data-testid="report-chip-attendance"]');
    expect(sections()).toEqual(["attendance"]);
    expect(pressed("attendance")).toBe("true");
    expect(pressed("all")).toBe("false");
    expect(whereOf(page)).toBe("/hr/reports?cat=attendance");
    expect(page.text()).toContain("Late Detection Report");
    expect(page.text()).not.toContain("Salary Statement");

    await page.click('[data-testid="report-chip-attendance"]'); // again: back to all
    expect(sections()).toEqual(["hr", "attendance", "payroll", "customise"]);
    expect(whereOf(page)).toBe("/hr/reports");

    await page.click('[data-testid="report-chip-customise"]');
    expect(sections()).toEqual(["customise"]);
    await page.click('[data-testid="report-chip-all"]');
    expect(whereOf(page)).toBe("/hr/reports");
  });

  it("keeps the search in the address and searches within the chosen category", async () => {
    const server = customServer({ saved: [MPR] });
    page = await open(server, catalogFixture({ saved: [MPR] }));
    await page.type('[data-testid="report-search"]', "salary");
    expect(whereOf(page)).toBe("/hr/reports?q=salary");
    expect(sections()).toEqual(["payroll"]);
    expect(page.container.querySelector('[data-testid="report-match-count"]')?.textContent).toContain(
      "1 of 5 reports match",
    );

    await page.click('[data-testid="report-chip-attendance"]');
    expect(whereOf(page)).toBe("/hr/reports?q=salary&cat=attendance");
    expect(page.container.querySelector('[data-testid="report-no-match"]')).not.toBeNull();
    expect(page.text()).toContain("in Attendance");

    await page.type('[data-testid="report-search"]', "");
    expect(whereOf(page)).toBe("/hr/reports?cat=attendance");
  });

  it("restores the search and the category from the address (Back from a report)", async () => {
    const server = customServer({ saved: [MPR] });
    page = await open(server, catalogFixture({ saved: [MPR] }), "/hr/reports?q=late&cat=attendance");
    expect(page.container.querySelector<HTMLInputElement>('[data-testid="report-search"]')!.value).toBe("late");
    expect(pressed("attendance")).toBe("true");
    expect(sections()).toEqual(["attendance"]);
    expect(hrefs()).toContain("/hr/reports?report=late-detection");
    expect(hrefs()).not.toContain("/hr/reports?report=leave-report");
  });

  it("ignores a category the catalog does not have", async () => {
    const server = customServer();
    page = await open(server, catalogFixture(), "/hr/reports?cat=gate");
    expect(pressed("all")).toBe("true");
    expect(sections()).toEqual(["hr", "attendance", "payroll", "customise"]);
  });
});

describe("the Customise section", () => {
  it("offers Create and lists every saved report with its details and actions", async () => {
    const server = customServer({ saved: [MPR, PUNCH_LIST] });
    page = await open(server, catalogFixture({ saved: [MPR, PUNCH_LIST] }));
    const section = page.container.querySelector('[data-testid="customise-section"]')!;
    expect(section.querySelector('[data-testid="customise-create"]')?.getAttribute("href")).toBe(
      "/hr/reports/customise/new",
    );

    const mpr = section.querySelector('[data-testid="saved-report-7"]')!;
    expect(mpr.textContent).toContain("Monthly Employee Performance Report");
    expect(mpr.textContent).toContain("Employees with period figures");
    expect(mpr.textContent).toContain("5 fields");
    expect(mpr.textContent).toContain("Updated by Priya · 19 Nov 2026");
    const links = Array.from(mpr.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toContain("/hr/reports?report=custom-7");
    expect(links).toContain("/hr/reports/customise/7/edit");
    expect(mpr.querySelector('[data-testid="duplicate-7"]')).not.toBeNull();
    expect(mpr.querySelector('[data-testid="delete-7"]')).not.toBeNull();

    // a report this login may only open
    const punches = section.querySelector('[data-testid="saved-report-8"]')!;
    expect(punches.textContent).toContain("2 fields"); // one it shows, one this role may not see
    expect(punches.textContent).toContain("Created by Ravi · 2 Nov 2026");
    expect(punches.querySelector('[data-testid="edit-8"]')).toBeNull();
    expect(punches.querySelector('[data-testid="duplicate-8"]')).toBeNull();
    expect(punches.querySelector('[data-testid="delete-8"]')).toBeNull();
    expect(Array.from(punches.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toContain(
      "/hr/reports?report=custom-8",
    );
  });

  it("asks in place before deleting, and deletes only on Delete", async () => {
    const server = customServer({ saved: [MPR, PUNCH_LIST] });
    const confirmSpy = vi.spyOn(window, "confirm");
    page = await open(server, catalogFixture({ saved: [MPR, PUNCH_LIST] }));

    await page.click('[data-testid="delete-7"]');
    const confirm = page.container.querySelector('[data-testid="delete-confirm-7"]')!;
    expect(confirm.textContent).toContain("Delete this report for everyone? This can’t be undone.");
    expect(server.to("/api/reports/custom/saved/7", "DELETE")).toHaveLength(0);
    expect(confirmSpy).not.toHaveBeenCalled();

    // Cancel puts the actions back
    const cancel = Array.from(confirm.querySelectorAll("button")).find((b) => b.textContent === "Cancel")!;
    expect(document.activeElement).toBe(cancel);
    await page.click('[data-testid="delete-confirm-7"] button');
    expect(page.container.querySelector('[data-testid="delete-confirm-7"]')).toBeNull();
    expect(server.to("/api/reports/custom/saved/7", "DELETE")).toHaveLength(0);

    await page.click('[data-testid="delete-7"]');
    await page.click('[data-testid="delete-yes-7"]');
    expect(server.to("/api/reports/custom/saved/7", "DELETE")).toHaveLength(1);
    expect(page.container.querySelector('[data-testid="saved-report-7"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="saved-report-8"]')).not.toBeNull();
    confirmSpy.mockRestore();
  });

  it("duplicates a report into a new tile", async () => {
    const server = customServer({ saved: [MPR] });
    page = await open(server, catalogFixture({ saved: [MPR] }));
    await page.click('[data-testid="duplicate-7"]');
    expect(server.to("/api/reports/custom/saved/7/duplicate", "POST")).toHaveLength(1);
    const copy = page.container.querySelector('[data-testid="saved-report-41"]');
    expect(copy?.textContent).toContain("Monthly Employee Performance Report (copy)");
  });

  it("is read-only for a view-only role: no Create, no Edit / Duplicate / Delete", async () => {
    const readOnly = savedItem({ canEdit: false, canDelete: false });
    const server = customServer({ permissions: { reports: "view" }, saved: [readOnly] });
    page = await open(server, catalogFixture({ saved: [readOnly] }));
    expect(page.container.querySelector('[data-testid="customise-create"]')).toBeNull();
    const tile = page.container.querySelector('[data-testid="saved-report-7"]')!;
    expect(tile.querySelector('[data-testid="edit-7"]')).toBeNull();
    expect(tile.querySelector('[data-testid="delete-7"]')).toBeNull();
    expect(hrefs().some((h) => h.startsWith("/hr/reports/customise"))).toBe(false);
  });

  it("shows the section with nothing saved yet", async () => {
    const editor = customServer({ saved: [] });
    page = await open(editor, catalogFixture({ saved: [] }));
    expect(page.container.querySelector('[data-testid="customise-create"]')).not.toBeNull();
    expect(page.text()).toContain("No saved reports yet. Create one");
    page.unmount();

    const viewer = customServer({ permissions: { reports: "view" }, saved: [] });
    page = await open(viewer, catalogFixture({ saved: [] }));
    expect(sections()).toContain("customise");
    expect(page.text()).toContain("Someone with edit access to Customise can build them.");
  });

  it("finds saved reports by name and data source; Create stays out of search results", async () => {
    const server = customServer({ saved: [MPR, PUNCH_LIST] });
    page = await open(server, catalogFixture({ saved: [MPR, PUNCH_LIST] }));
    await page.type('[data-testid="report-search"]', "punches");
    expect(page.container.querySelector('[data-testid="saved-report-8"]')).not.toBeNull();
    expect(page.container.querySelector('[data-testid="saved-report-7"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="customise-create"]')).toBeNull();
    await page.type('[data-testid="report-search"]', "salary");
    expect(page.container.querySelector('[data-testid="customise-section"]')).toBeNull();
  });

  it("falls back to the catalog's entries when the saved list cannot be loaded", async () => {
    const server = customServer({ saved: [MPR] });
    // an older server without the builder: the list is not there
    server.fixtures["/api/reports/custom/saved"] = { status: 404, body: { error: "not_found" } };
    page = await open(server, catalogFixture({ saved: [MPR] }));
    expect(page.container.querySelector('[data-testid="customise-failed"]')).not.toBeNull();
    expect(hrefs()).toContain("/hr/reports?report=custom-7");
    expect(page.text()).toContain("Monthly Employee Performance Report");
  });

  it("does not ask for saved reports when the role has no Customise", async () => {
    const server = customServer({ customise: false });
    page = await open(server, catalogFixture({ customise: false }));
    expect(page.container.querySelector('[data-testid="customise-section"]')).toBeNull();
    expect(server.to("/api/reports/custom/saved")).toHaveLength(0);
    expect(page.requests().some((r) => r.startsWith("/api/reports/custom"))).toBe(false);
  });
});
