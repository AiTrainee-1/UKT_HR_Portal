// The report builder (/hr/reports/customise/new and /<id>/edit), rendered with a fake server: picking a data source and
// fields, reordering (buttons and drag), removing, filters, the live preview's requests, saving (new and existing), the
// view-only role, and the unsaved-changes guard.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Switch } from "wouter";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import { CustomReportBuilder } from "./CustomReportBuilder";
import CustomReportBuilderPage from "./CustomReportBuilderPage";
import { customServer, fire, Where, whereOf } from "./test-server";
import { savedItem } from "./test-fixtures";

let page: RenderedPage | undefined;

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  page?.unmount();
  page = undefined;
  document.body.innerHTML = "";
});

/** The tests' today: 19 November 2026 (the fixtures' default range, 1 - 19 Nov, is "This month"). */
const TODAY = new Date(2026, 10, 19);

const builder = (editId: number | null) =>
  function BuilderPage() {
    return (
      <>
        <CustomReportBuilder editId={editId} previewDelay={0} today={TODAY} />
        <Where />
      </>
    );
  };

const open = (server: ReturnType<typeof customServer>, editId: number | null = null) =>
  renderMdPage(builder(editId), server.fixtures, {
    path: editId ? `/hr/reports/customise/${editId}/edit` : "/hr/reports/customise/new",
  });

/** The chosen fields, in order, as the list shows them. */
const chosen = () =>
  Array.from(page!.container.querySelectorAll<HTMLElement>('[data-testid^="chosen-"]'))
    .map((li) => li.dataset.testid ?? "")
    .filter((id) => id !== "chosen-empty")
    .map((id) => id.replace("chosen-", ""));

const lastPreview = (server: ReturnType<typeof customServer>) => {
  const calls = server.to("/api/reports/custom/preview");
  return calls[calls.length - 1]?.params;
};

const button = (label: string) => `button[aria-label="${label}"]`;

describe("building a new report", () => {
  it("starts with the data sources and no preview", async () => {
    const server = customServer();
    page = await open(server);
    expect(page.text()).toContain("Create a custom report");
    expect(page.text()).toContain("Employees with period figures");
    expect(page.text()).toContain("One row per punch");
    expect(page.text()).toContain("Choose a data source to start.");
    expect(server.to("/api/reports/custom/preview")).toHaveLength(0);
    // nothing to save yet, so nothing to lose
    expect(page.container.querySelector('[data-testid="custom-save"]')).toBeNull();
  });

  it("takes the data source's default fields and previews them with its default filters", async () => {
    const server = customServer();
    page = await open(server);
    await page.click('[data-testid="dataset-employees"]');
    expect(page.container.querySelector('[data-testid="dataset-employees"]')?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(chosen()).toEqual(["emp.code", "emp.name"]);
    const q = lastPreview(server)!;
    expect(q.get("dataset")).toBe("employees");
    expect(q.get("fields")).toBe("emp.code,emp.name");
    expect(q.get("dateFrom")).toBe("2026-11-01");
    expect(q.get("dateTo")).toBe("2026-11-19");
    expect(q.get("employeeStatus")).toBe("active");
    // the preview table (the Report Center's own) shows the answer
    expect(page.text()).toContain("Worker 1");
    expect(page.text()).toContain("Attendance from the stored day records.");
  });

  it("adds, reorders with the buttons and by drag, and removes fields - the preview follows", async () => {
    const server = customServer();
    page = await open(server);
    await page.click('[data-testid="dataset-employees"]');

    await page.click('[data-testid="field-att.late_count"]');
    expect(chosen()).toEqual(["emp.code", "emp.name", "att.late_count"]);
    expect(lastPreview(server)!.get("fields")).toBe("emp.code,emp.name,att.late_count");

    await page.click(button("Move Late count up"));
    expect(chosen()).toEqual(["emp.code", "att.late_count", "emp.name"]);
    expect(page.text()).toContain("Late count moved to position 2 of 3.");
    // the first row cannot go further up, the last further down
    expect(page.container.querySelector<HTMLButtonElement>(button("Move Employee code up"))!.disabled).toBe(true);
    expect(page.container.querySelector<HTMLButtonElement>(button("Move Name down"))!.disabled).toBe(true);

    await page.click(button("Move Employee code down"));
    expect(chosen()).toEqual(["att.late_count", "emp.code", "emp.name"]);

    // drag Name onto the first row
    await fire(page, '[data-testid="chosen-emp.name"]', "dragstart");
    await fire(page, '[data-testid="chosen-att.late_count"]', "dragover");
    await fire(page, '[data-testid="chosen-att.late_count"]', "drop");
    expect(chosen()).toEqual(["emp.name", "att.late_count", "emp.code"]);
    expect(lastPreview(server)!.get("fields")).toBe("emp.name,att.late_count,emp.code");

    await page.click(button("Remove Late count"));
    expect(chosen()).toEqual(["emp.name", "emp.code"]);
    // unticking in the list removes it too
    await page.click('[data-testid="field-emp.code"]');
    expect(chosen()).toEqual(["emp.name"]);
    expect(lastPreview(server)!.get("fields")).toBe("emp.name");

    await page.click(button("Remove Name"));
    expect(chosen()).toEqual([]);
    expect(page.text()).toContain("Pick at least one field to see the preview.");
  });

  it("adds a whole section and finds fields by search", async () => {
    const server = customServer();
    page = await open(server);
    await page.click('[data-testid="dataset-employees"]');
    await page.click('[data-testid="section-toggle-attendance"]');
    expect(chosen()).toEqual(["emp.code", "emp.name", "att.present_days", "att.late_count", "att.ot_hours"]);
    expect(page.container.querySelector('[data-testid="section-toggle-attendance"]')?.textContent).toBe("Remove all");
    await page.click('[data-testid="section-toggle-attendance"]');
    expect(chosen()).toEqual(["emp.code", "emp.name"]);

    await page.type('[data-testid="field-search"]', "deductions");
    expect(page.container.querySelector('[data-testid="section-payroll"]')).not.toBeNull();
    expect(page.container.querySelector('[data-testid="section-personal"]')).toBeNull();
    await page.type('[data-testid="field-search"]', "zzz");
    expect(page.text()).toContain("No field matches “zzz”.");
  });

  it("sends the filters and the sort to the preview, and blocks it on a bad range", async () => {
    const server = customServer();
    page = await open(server);
    await page.click('[data-testid="dataset-employees"]');
    await page.type('input[aria-label="Name contains"]', "Asha");
    expect(lastPreview(server)!.get("nameLike")).toBe("Asha");

    const sortKey = page.container.querySelector<HTMLSelectElement>('[data-testid="sort-key"]')!;
    await fireChange(sortKey, "emp.name");
    expect(lastPreview(server)!.get("sort")).toBe("emp.name:asc");
    await fireChange(page.container.querySelector<HTMLSelectElement>('[data-testid="sort-dir"]')!, "desc");
    expect(lastPreview(server)!.get("sort")).toBe("emp.name:desc");
    // removing the sorted field drops the sort
    await page.click(button("Remove Name"));
    expect(lastPreview(server)!.has("sort")).toBe(false);

    const before = server.to("/api/reports/custom/preview").length;
    await page.type('input[aria-label="From date"]', "2026-11-25");
    expect(page.text()).toContain("Fix the filters to see the preview: The From date is after the To date.");
    expect(server.to("/api/reports/custom/preview")).toHaveLength(before);
  });

  it("shows a forbidden field's refusal in the preview", async () => {
    const server = customServer({
      preview: { status: 400, body: { error: "field_forbidden", message: "Net pay needs Payroll access." } },
    });
    page = await open(server);
    await page.click('[data-testid="dataset-employees"]');
    expect(page.container.querySelector('[data-testid="preview-forbidden"]')?.textContent).toContain(
      "Net pay needs Payroll access.",
    );
  });

  it("says how to fix a refused preview without pointing at a Show report button it does not have", async () => {
    const server = customServer({
      preview: {
        status: 400,
        body: { error: "invalid_filter", message: "Date range is too wide (max 62 days)", field: "dateTo" },
      },
    });
    page = await open(server);
    await page.click('[data-testid="dataset-employees"]');
    const error = page.container.querySelector('[data-testid="report-error"]')!;
    expect(error.textContent).toContain("Date range is too wide");
    expect(error.textContent).toContain("Change the fields or filters; the preview updates by itself.");
    expect(error.textContent).not.toContain("Show report");
  });

  it("asks before switching to another data source once fields were changed", async () => {
    const server = customServer();
    page = await open(server);
    await page.click('[data-testid="dataset-employees"]');
    // untouched defaults: switches straight away
    await page.click('[data-testid="dataset-punches"]');
    expect(chosen()).toEqual(["emp.code", "punch.time"]);
    await page.click('[data-testid="dataset-employees"]');
    await page.click('[data-testid="field-pay.net"]');
    await page.click('[data-testid="dataset-punches"]');
    expect(page.container.querySelector('[data-testid="dataset-switch-confirm"]')).not.toBeNull();
    expect(chosen()).toEqual(["emp.code", "emp.name", "pay.net"]);
    await page.click('[data-testid="dataset-switch-yes"]');
    expect(chosen()).toEqual(["emp.code", "punch.time"]);
  });

  it("needs a name, then saves and offers to open the report", async () => {
    const server = customServer();
    page = await open(server);
    await page.click('[data-testid="dataset-employees"]');
    await page.click('[data-testid="field-att.late_count"]');
    await page.click('[data-testid="custom-save"]');
    expect(page.container.querySelector('[data-testid="problem-name"]')?.textContent).toBe("Give the report a name.");
    expect(server.to("/api/reports/custom/saved", "POST")).toHaveLength(0);

    await page.type('[data-testid="custom-name"]', "  Monthly Employee Performance Report ");
    await page.type('[data-testid="custom-description"]', "For the monthly review");
    expect(page.text()).toContain("Unsaved changes");
    await page.click('[data-testid="custom-save"]');

    const [post] = server.to("/api/reports/custom/saved", "POST");
    expect(post.body).toEqual({
      name: "Monthly Employee Performance Report",
      description: "For the monthly review",
      dataset: "employees",
      fields: ["emp.code", "emp.name", "att.late_count"],
      // the dates are left out: the report opens on the current month each time
      filters: { employeeStatus: "active" },
      sort: [],
    });
    expect(whereOf(page)).toBe("/hr/reports/customise/41/edit");
    expect(page.text()).toContain("All changes saved");
    expect(page.text()).toContain("Edit custom report");
    const openLink = page.container.querySelector('[data-testid="custom-open"]');
    expect(openLink?.getAttribute("href")).toBe("/hr/reports?report=custom-41");

    // a second save changes the same report
    await page.type('[data-testid="custom-name"]', "Monthly performance");
    await page.click('[data-testid="custom-save"]');
    expect(server.to("/api/reports/custom/saved", "POST")).toHaveLength(1);
    const [put] = server.to("/api/reports/custom/saved/41", "PUT");
    expect(put.body?.name).toBe("Monthly performance");
  });

  it("saves exactly the dates on screen when asked", async () => {
    const server = customServer();
    page = await open(server);
    await page.click('[data-testid="dataset-employees"]');
    expect(page.container.querySelector<HTMLInputElement>('[data-testid="dates-default"]')!.checked).toBe(true);
    expect(page.text()).toContain("Today that is 1 Nov 2026 - 19 Nov 2026.");
    await page.click('[data-testid="dates-fixed"]');
    expect(page.text()).toContain("Exactly 1 Nov 2026 - 19 Nov 2026");
    await page.type('[data-testid="custom-name"]', "November list");
    await page.click('[data-testid="custom-save"]');
    const [post] = server.to("/api/reports/custom/saved", "POST");
    expect(post.body?.filters).toEqual({ dateFrom: "2026-11-01", dateTo: "2026-11-19", employeeStatus: "active" });
  });

  it("saves a quick range as a period counted from the day the report is opened", async () => {
    const server = customServer();
    page = await open(server);
    await page.click('[data-testid="dataset-employees"]');
    await page.type('input[aria-label="From date"]', "2026-11-02");
    // not a quick range: the relative choice waits for one
    expect(page.container.querySelector<HTMLInputElement>('[data-testid="dates-relative"]')!.disabled).toBe(true);
    await page.type('input[aria-label="From date"]', "2026-10-01");
    await page.type('input[aria-label="To date"]', "2026-10-31");
    await page.click('[data-testid="dates-relative"]');
    expect(page.text()).toContain("Last month, counted from the day it is opened");
    await page.type('[data-testid="custom-name"]', "Last month's list");
    await page.click('[data-testid="custom-save"]');
    const [post] = server.to("/api/reports/custom/saved", "POST");
    expect(post.body?.filters).toEqual({ dateRange: "lastMonth", employeeStatus: "active" });
  });

  it("shows the server's reason when a save is refused", async () => {
    const server = customServer({
      save: { status: 400, body: { error: "field_forbidden", message: "You cannot use the field Net pay." } },
    });
    page = await open(server);
    await page.click('[data-testid="dataset-employees"]');
    await page.type('[data-testid="custom-name"]', "Pay list");
    await page.click('[data-testid="custom-save"]');
    expect(page.container.querySelector('[data-testid="save-error"]')?.textContent).toBe(
      "You cannot use the field Net pay.",
    );
    expect(whereOf(page)).toBe("/hr/reports/customise/new");
  });
});

describe("editing a saved report", () => {
  it("opens it as saved, drops a field its source no longer has, notes hidden ones, and saves with PUT", async () => {
    const server = customServer({
      saved: [
        savedItem({
          fields: ["emp.code", "pay.gone", "att.late_count"],
          // two more fields this role may not see (the server leaves them out of `fields` and keeps them on a save)
          hiddenFields: 2,
          filters: { departmentIds: "3" },
        }),
      ],
    });
    page = await open(server, 7);
    expect(page.text()).toContain("Edit custom report");
    expect(chosen()).toEqual(["emp.code", "att.late_count"]);
    expect(page.text()).toContain("pay.gone");
    expect(page.text()).toContain("no longer offered by its data source");
    expect(page.text()).toContain("This report also has 2 fields your role cannot see.");
    expect(page.container.querySelector<HTMLInputElement>('[data-testid="custom-name"]')!.value).toBe(
      "Monthly Employee Performance Report",
    );
    const q = lastPreview(server)!;
    expect(q.get("fields")).toBe("emp.code,att.late_count");
    expect(q.get("departmentIds")).toBe("3");
    expect(q.get("sort")).toBe("emp.code:asc");
    // as loaded it is the saved report (the server leaves the field out of a run too), so it can be opened
    expect(page.container.querySelector('[data-testid="custom-open"]')).not.toBeNull();

    await page.click(button("Move Late count up"));
    expect(page.text()).toContain("Unsaved changes");
    expect(page.container.querySelector('[data-testid="custom-open"]')).toBeNull();
    await page.click('[data-testid="custom-save"]');
    const [put] = server.to("/api/reports/custom/saved/7", "PUT");
    expect(put.body).toMatchObject({
      fields: ["att.late_count", "emp.code"],
      filters: { departmentIds: "3", employeeStatus: "active" },
      sort: [{ key: "emp.code", dir: "asc" }],
    });
    expect(page.container.querySelector('[data-testid="custom-open"]')?.getAttribute("href")).toBe(
      "/hr/reports?report=custom-7",
    );
  });

  it("says so when the report does not exist", async () => {
    const server = customServer({ saved: [] });
    page = await open(server, 8);
    expect(page.text()).toContain("Report not found");
  });

  it("lets a view-only role preview but not save", async () => {
    const server = customServer({ permissions: { reports: "view" }, saved: [savedItem({ canEdit: false })] });
    page = await open(server, 7);
    expect(page.text()).toContain("View only");
    expect(page.container.querySelector('[data-testid="custom-save"]')).toBeNull();
    expect(lastPreview(server)!.get("dataset")).toBe("employees");
    // no guard either: there is nothing a view-only role could lose
    await page.click('[data-testid="field-emp.gender"]');
    await page.click('a[href="/hr/reports?cat=customise"]');
    expect(document.body.querySelector('[data-testid="unsaved-dialog"]')).toBeNull();
    expect(whereOf(page)).toBe("/hr/reports?cat=customise");
  });
});

describe("unsaved changes", () => {
  it("asks before following a link away, and stays or leaves as told", async () => {
    const server = customServer({ saved: [savedItem()] });
    page = await open(server, 7);
    await page.click('[data-testid="field-emp.gender"]');
    await page.click('a[href="/hr/reports?cat=customise"]');
    expect(document.body.querySelector('[data-testid="unsaved-dialog"]')?.textContent).toContain(
      "Leave without saving?",
    );
    expect(whereOf(page)).toBe("/hr/reports/customise/7/edit");

    await page.click('[data-testid="unsaved-stay"]');
    expect(document.body.querySelector('[data-testid="unsaved-dialog"]')).toBeNull();
    expect(whereOf(page)).toBe("/hr/reports/customise/7/edit");
    expect(chosen()).toContain("emp.gender");

    await page.click('a[href="/hr/reports"]'); // the breadcrumb
    await page.click('[data-testid="unsaved-leave"]');
    expect(whereOf(page)).toBe("/hr/reports");
  });

  it("holds the browser's Back as well: asks, stays, or goes back for real", async () => {
    const server = customServer({ saved: [savedItem()] });
    page = await open(server, 7);
    const guarded = () => (window.history.state as Record<string, unknown> | null)?.ukUnsavedGuard === true;
    const back = async () => {
      await act(async () => {
        window.history.back();
        await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
      });
      await page!.settle();
    };
    expect(guarded()).toBe(false);
    await page.click('[data-testid="field-emp.gender"]');
    // an extra entry of this same page sits on top while there are changes
    expect(guarded()).toBe(true);

    // Back takes it off: the guard puts it back and asks
    await back();
    expect(document.body.querySelector('[data-testid="unsaved-dialog"]')?.textContent).toContain(
      "Leave without saving?",
    );
    expect(guarded()).toBe(true);
    await page.click('[data-testid="unsaved-stay"]');
    expect(document.body.querySelector('[data-testid="unsaved-dialog"]')).toBeNull();
    expect(chosen()).toContain("emp.gender");
    expect(whereOf(page)).toBe("/hr/reports/customise/7/edit");

    // Back again and leave: back past the extra entry, to where Back was going
    await back();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    await page.click('[data-testid="unsaved-leave"]');
    expect(go).toHaveBeenCalledWith(-2);
    go.mockRestore();
  });

  it("takes its extra history entry off again once the changes are saved", async () => {
    const server = customServer({ saved: [savedItem()] });
    page = await open(server, 7);
    await page.click('[data-testid="field-emp.gender"]');
    const guarded = () => (window.history.state as Record<string, unknown> | null)?.ukUnsavedGuard === true;
    expect(guarded()).toBe(true);
    await act(async () => {
      const off = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
      page!.container.querySelector<HTMLButtonElement>('[data-testid="custom-save"]')!.click();
      await off;
    });
    await page.settle();
    expect(page.text()).toContain("All changes saved");
    expect(guarded()).toBe(false);
  });

  it("asks the browser before the tab closes, only while there are changes", async () => {
    const server = customServer({ saved: [savedItem()] });
    page = await open(server, 7);
    const unload = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await page.click('[data-testid="field-emp.gender"]');
    expect(unload()).toBe(true);
    await page.click('[data-testid="custom-save"]');
    expect(unload()).toBe(false);
    // saved: links are not held any more
    await page.click('a[href="/hr/reports?cat=customise"]');
    expect(document.body.querySelector('[data-testid="unsaved-dialog"]')).toBeNull();
    expect(whereOf(page)).toBe("/hr/reports?cat=customise");
  });
});

/** A native <select> change, the way React notices it. */
async function fireChange(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page!.settle();
}

describe("the builder's page and its two addresses", () => {
  /** What the HR portal's shell asks for besides the builder (sidebar badges). */
  const HR_SHELL = Object.fromEntries(
    [
      "/api/leave-requests",
      "/api/permissions",
      "/api/recruitment/resignations",
      "/api/advances",
      "/api/on-duty-sessions",
      "/api/on-duty-punch-verifications",
      "/api/outpass-requests",
      "/api/notifications",
    ].map((path) => [path, []]),
  );

  function Routes() {
    return (
      <>
        <Switch>
          <Route path="/hr/reports/customise/new">
            <CustomReportBuilderPage />
          </Route>
          <Route path="/hr/reports/customise/:id/edit">
            <CustomReportBuilderPage />
          </Route>
        </Switch>
        <Where />
      </>
    );
  }

  it("keeps what is on screen when a new report moves to its own address after saving", async () => {
    const server = customServer();
    page = await renderMdPage(Routes, { ...HR_SHELL, ...server.fixtures }, { path: "/hr/reports/customise/new" });
    await page.click('[data-testid="dataset-employees"]');
    // a date range that is not saved with the report (dates are left out by default)
    await page.type('input[aria-label="From date"]', "2026-11-05");
    await page.type('[data-testid="custom-name"]', "Kept on screen");
    await page.click('[data-testid="custom-save"]');
    expect(whereOf(page)).toBe("/hr/reports/customise/41/edit");
    expect(page.text()).toContain("Edit custom report");
    // the same builder: still the user's range, not the saved report re-read from the server
    expect(page.container.querySelector<HTMLInputElement>('input[aria-label="From date"]')!.value).toBe("2026-11-05");
    expect(page.text()).toContain("All changes saved");
    expect(page.container.querySelector('[data-testid="custom-open"]')?.getAttribute("href")).toBe(
      "/hr/reports?report=custom-41",
    );
  });

  it("says so for an address that is not a report id", async () => {
    const server = customServer();
    page = await renderMdPage(Routes, { ...HR_SHELL, ...server.fixtures }, { path: "/hr/reports/customise/abc/edit" });
    expect(page.text()).toContain("This custom report does not exist");
  });
});
