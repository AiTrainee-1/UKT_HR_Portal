import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import MdEmployees from "../MdEmployees";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import {
  attrition,
  composition,
  directory,
  emptyAttrition,
  emptyComposition,
  emptyDirectory,
  emptyInsights,
  emptyMilestones,
  emptyMovement,
  emptySummary,
  insights,
  milestones,
  movementMonthly,
  profile,
  summary,
} from "./testing/fixtures";

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const PATH = "/md/employees";

const data: Fixtures = {
  "/api/md/employees/summary": summary,
  "/api/md/employees/composition": composition,
  "/api/md/employees/movement": movementMonthly,
  "/api/md/employees/attrition": attrition,
  "/api/md/employees/milestones": milestones,
  "/api/md/employees/insights": insights,
  "/api/md/employees/directory": (params: URLSearchParams) =>
    params.get("q")
      ? {
          ...directory,
          rows: directory.rows.filter((r) => r.name.toLowerCase().includes(params.get("q")!)),
          total: 1,
          pages: 1,
        }
      : directory,
  "/api/md/employees/employee/1": profile,
};

const empty: Fixtures = {
  "/api/md/employees/summary": emptySummary,
  "/api/md/employees/composition": emptyComposition,
  "/api/md/employees/movement": emptyMovement,
  "/api/md/employees/attrition": emptyAttrition,
  "/api/md/employees/milestones": emptyMilestones,
  "/api/md/employees/insights": emptyInsights,
  "/api/md/employees/directory": emptyDirectory,
};

const bodyText = () => document.body.textContent ?? "";

/** Click the tab (a PillTabs button) with this label. */
async function clickTab(p: RenderedPage, label: string) {
  const tab = Array.from(p.container.querySelectorAll<HTMLElement>('[role="tab"]')).find((el) =>
    el.textContent?.trim().startsWith(label),
  );
  if (!tab)
    throw new Error(
      `No tab "${label}". Tabs: ${Array.from(p.container.querySelectorAll('[role="tab"]'))
        .map((e) => e.textContent)
        .join(" | ")}`,
    );
  await act(async () => tab.click());
  await p.settle();
}

describe("MdEmployees", () => {
  it("answers 'what is the shape of my workforce and how is it moving' on one page", async () => {
    page = await renderMdPage(MdEmployees, data, { path: PATH });
    const text = page.text();
    expect(text).toContain("Employees");
    // the eight headline figures
    expect(page.container.querySelector('[data-testid="md-employees-kpi-headcount-value"]')?.textContent).toBe("1,240");
    expect(page.container.querySelector('[data-testid="md-employees-kpi-joiners-value"]')?.textContent).toBe("165");
    expect(page.container.querySelector('[data-testid="md-employees-kpi-leavers-value"]')?.textContent).toBe("177");
    expect(page.container.querySelector('[data-testid="md-employees-kpi-net-value"]')?.textContent).toBe("-12");
    expect(page.container.querySelector('[data-testid="md-employees-kpi-attrition-value"]')?.textContent).toBe("14.2%");
    expect(page.container.querySelector('[data-testid="md-employees-kpi-tenure-value"]')?.textContent).toBe("3.4 yrs");
    expect(page.container.querySelector('[data-testid="md-employees-kpi-early-value"]')?.textContent).toBe("14");
    expect(page.container.querySelector('[data-testid="md-employees-kpi-people-value"]')?.textContent).toBe("38%");
    expect(text).toContain("Staff 310 · Production 930");
    expect(text).toContain("Of an average 1,246 people");
    // exceptions first
    expect(text).toContain("Needs your attention");
    expect(text).toContain("Stitching (Unit 1) attrition is 21.4%, against 14.2% across the company");
    expect(text).toContain("Worth a word of thanks.");
    // composition
    for (const title of [
      "Staff and production",
      "By unit",
      "By department",
      "Length of service",
      "Age",
      "By designation",
      "Planned vs actual staff",
    ]) {
      expect(text).toContain(title);
    }
    expect(text).toContain("Stitching (Unit 1)");
    expect(text).toContain("60 of 70");
    expect(text).toContain("10 short · 86% filled");
    // movement and attrition
    expect(text).toContain("Joiners, leavers and headcount");
    expect(text).toContain("Headcount before today is rebuilt from join and exit dates");
    expect(text).toContain("Attrition by group");
    expect(text).toContain("Stitching (Unit 1) · hot-spot");
    expect(text).toContain("How long people stayed");
    expect(text).toContain("Why people leave");
    expect(text).toContain("Better pay or opportunity");
    expect(text).toContain("Left within 90 days of joining");
    expect(text).toContain("Jaya Lakshmi");
    // the human side and the directory
    expect(text).toContain("Moments to mark");
    expect(text).toContain("Arun Kumar");
    expect(text).toContain("7 years");
    expect(text).toContain("People directory");
    expect(text).toContain("Anita Raman");
    expect(text).toContain("Showing 1-10 of 23");
  });

  it("shows how every figure is made, and the data caveats", async () => {
    page = await renderMdPage(MdEmployees, data, { path: PATH });
    expect(page.container.querySelectorAll('[data-testid="provenance-button"]').length).toBeGreaterThan(10);
    expect(page.container.querySelectorAll('[data-testid="ask-ai"]').length).toBeGreaterThan(8);
    expect(page.text()).toContain("12 people have a missing or unusable join date"); // the note, once
    expect(page.container.querySelectorAll('[data-testid="md-note"]').length).toBe(1);
    expect(page.text()).toContain("3 of the 177 leavers have only an approximate exit date.");
  });

  it("asks the six analytics endpoints and the directory, all for the same period and scope", async () => {
    page = await renderMdPage(MdEmployees, data, { path: PATH });
    const asked = page.requests();
    for (const path of ["summary", "movement", "attrition", "insights"]) {
      expect(asked).toContain(
        `/api/md/employees/${path}?period=last_12_months${path === "attrition" ? "&limit=10" : ""}`,
      );
    }
    expect(asked).toContain("/api/md/employees/composition");
    expect(asked).toContain("/api/md/employees/milestones");
    expect(asked.some((r) => r.startsWith("/api/md/employees/directory?page=1&pageSize=10"))).toBe(true);
  });

  it("asks again for another period without blanking the page", async () => {
    page = await renderMdPage(MdEmployees, data, { path: PATH });
    await clickTab(page, "Last 90 days");
    expect(page.requests()).toContain("/api/md/employees/summary?period=last_90_days");
    expect(page.requests()).toContain("/api/md/employees/movement?period=last_90_days");
    // the period does not apply to who works here today
    expect(page.requests().filter((r) => r.startsWith("/api/md/employees/composition"))).toEqual([
      "/api/md/employees/composition",
    ]);
    expect(page.text()).toContain("1,240");
  });

  it("switches attrition between department, unit and staff/production", async () => {
    page = await renderMdPage(MdEmployees, data, { path: PATH });
    const bars = () => page!.container.querySelector('[data-testid="md-employees-attrition-bars"]')?.textContent ?? "";
    expect(bars()).toContain("Stitching (Unit 1) · hot-spot");
    expect(bars()).toContain("90 left · average 420 people");
    await clickTab(page, "Unit");
    expect(bars()).toContain("Head Office");
    expect(bars()).not.toContain("hot-spot");
    await clickTab(page, "Staff / production");
    expect(bars()).toContain("Production");
    expect(bars()).toContain("16%");
  });

  it("lists every department only when asked", async () => {
    page = await renderMdPage(
      MdEmployees,
      {
        ...data,
        "/api/md/employees/composition": (params: URLSearchParams) => ({
          ...composition,
          departmentsTotal: params.get("limit") === "25" ? 4 : 8,
        }),
      },
      { path: PATH },
    );
    expect(page.text()).toContain("Showing the 4 biggest of 8 departments.");
    await page.click('[data-testid="md-employees-departments-more"]');
    expect(page.requests()).toContain("/api/md/employees/composition?limit=25");
    expect(page.container.querySelector('[data-testid="md-employees-departments-more"]')).toBeNull();
  });

  it("lists more departments only when asked", async () => {
    page = await renderMdPage(
      MdEmployees,
      {
        ...data,
        "/api/md/employees/attrition": (params: URLSearchParams) => ({
          ...attrition,
          departmentsWithLeavers: params.get("limit") === "25" ? 3 : 13,
          departmentsTotal: 20,
        }),
      },
      { path: PATH },
    );
    expect(page.text()).toContain("7 other departments had no leavers."); // 20 in all, 13 with leavers
    await page.click('[data-testid="md-employees-attrition-more"]');
    expect(page.requests().some((r) => r.startsWith("/api/md/employees/attrition") && r.includes("limit=25"))).toBe(
      true,
    );
    expect(page.container.querySelector('[data-testid="md-employees-attrition-more"]')).toBeNull();
  });

  it("says so when one person cannot be loaded", async () => {
    page = await renderMdPage(
      MdEmployees,
      {
        ...data,
        "/api/md/employees/employee/1": { status: 404, body: { error: "There is no employee with that id." } },
      },
      { path: PATH },
    );
    await page.click('[data-testid="row-1"]');
    expect(bodyText()).toContain("This could not be loaded.");
    expect(bodyText()).toContain("There is no employee with that id.");
  });

  it("opens a person's story from the directory, read-only, and without pay", async () => {
    page = await renderMdPage(MdEmployees, data, { path: PATH });
    expect(document.body.querySelector('[data-testid="md-employees-profile"]')).toBeNull();
    await page.click('[data-testid="row-1"]');
    expect(page.requests()).toContain("/api/md/employees/employee/1");
    const text = bodyText();
    expect(text).toContain("Anita Raman");
    expect(text).toContain("A1 · Accountant");
    expect(text).toContain("6y 11m");
    expect(text).toContain("Reports to");
    expect(text).toContain("Attendance, 90 days");
    expect(text).toContain("72.7%");
    expect(text).toContain("Only 16% of these days have an attendance record");
    expect(text).toContain("Their story here");
    expect(text).toContain("Joined the company");
    expect(text).toContain("Increment given");
    expect(text).toContain("7.8%");
    expect(text).toContain("Casual Leave");
    expect(text).toContain("4 of 6 required documents");
    expect(text).toContain("Missing: Bank Passbook");
    expect(text).not.toMatch(/salary|₹/i);
  });

  it("searches the directory after the typing pauses", async () => {
    page = await renderMdPage(MdEmployees, data, { path: PATH });
    await page.type('[data-testid="md-employees-search"]', "anita");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    await page.settle();
    expect(page.requests().some((r) => r.includes("/directory?") && r.includes("q=anita"))).toBe(true);
    expect(page.container.querySelector('[data-testid="md-employees-count"]')?.textContent).toContain(
      "Showing 1-1 of 1",
    );
    expect(page.container.querySelector('[data-testid="md-employees-clear"]')).not.toBeNull();
  });

  it("filters the directory to people who have left", async () => {
    page = await renderMdPage(MdEmployees, data, { path: PATH });
    await clickTab(page, "Left");
    expect(page.requests().some((r) => r.includes("/directory?") && r.includes("status=inactive"))).toBe(true);
  });

  it("says plainly when a part cannot be loaded, and still shows the rest", async () => {
    // a 4xx: the hook never retries it (a 5xx is retried once, a second later), so the answer is immediate
    page = await renderMdPage(
      MdEmployees,
      { ...data, "/api/md/employees/summary": { status: 400, body: { error: "The summary is unavailable." } } },
      { path: PATH },
    );
    const banner = page.container.querySelector('[data-testid="md-error"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("This could not be loaded.");
    expect(banner!.textContent).toContain("Summary: The summary is unavailable.");
    expect(page.text()).toContain("Staff and production"); // the other cards are unaffected
    expect(page.text()).toContain("People directory");
  });

  it("never claims all is well when the exceptions could not even be loaded", async () => {
    const refused = { status: 400, body: { error: "No." } };
    page = await renderMdPage(
      MdEmployees,
      {
        ...data,
        "/api/md/employees/insights": refused,
        "/api/md/employees/movement": refused,
        "/api/md/employees/attrition": refused,
        "/api/md/employees/milestones": refused,
        "/api/md/employees/composition": refused,
        "/api/md/employees/summary": refused,
      },
      { path: PATH },
    );
    expect(page.text()).not.toContain("Nothing in the workforce needs your attention");
    expect(page.text()).not.toContain("Nobody left in this period");
    expect(page.container.querySelectorAll('[data-testid="md-employees-unavailable"]').length).toBe(5);
    expect(page.container.querySelector('[data-testid="md-error"]')?.textContent).toContain("Summary: No.");
    // the tiles stop pulsing: dashes, not a loader
    expect(page.container.querySelector('[data-testid="md-employees-kpi-headcount-value"]')?.textContent).toBe("—");
    expect(page.text()).toContain("People directory"); // the directory has its own query and still works
  });

  it("explains an empty company instead of showing zeros and blank charts", async () => {
    page = await renderMdPage(MdEmployees, empty, { path: PATH });
    const text = page.text();
    expect(text).toContain("Nothing in the workforce needs your attention for this period.");
    expect(text).toContain("Nobody is on the rolls for these filters");
    expect(text).toContain("Nothing to chart yet");
    expect(text).toContain("Nobody left in this period");
    expect(text).toContain("No one completes 5 or more years in the next 30 days.");
    expect(text).toContain("No one matches");
    // "no data" is a dash, never 0%
    expect(page.container.querySelector('[data-testid="md-employees-kpi-attrition-value"]')?.textContent).toBe("—");
    expect(page.container.querySelector('[data-testid="md-employees-kpi-tenure-value"]')?.textContent).toBe("—");
    expect(page.container.querySelector('[data-testid="md-employees-kpi-headcount-value"]')?.textContent).toBe("0");
  });

  it("tells the MD when no staffing plan is set", async () => {
    page = await renderMdPage(
      MdEmployees,
      {
        ...data,
        "/api/md/employees/composition": {
          ...composition,
          staffing: { ...composition.staffing, rows: [], planned: false },
          notes: emptyComposition.notes,
        },
      },
      { path: PATH },
    );
    expect(page.text()).toContain("No planned staff is set");
    expect(page.text()).toContain("No required headcount is set for these departments");
  });
});
