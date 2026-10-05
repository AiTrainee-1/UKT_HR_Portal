import { cloneElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import MdRecruitment from "../MdRecruitment";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import { EMPTY_FIXTURES, FIXTURES, POSITIONS } from "./testing-fixtures";
import type { OpenPosition } from "./types";

// jsdom has no layout, so recharts' ResponsiveContainer measures 0 x 0 and draws nothing (and warns). Charts are slow in
// jsdom, so they are replaced by a placeholder, except in the one test that sets a size and reads the real chart.
const chartBox = vi.hoisted(() => ({ size: 0 }));
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      chartBox.size ? (
        <div style={{ width: chartBox.size, height: 300 }}>
          {cloneElement(children, { width: chartBox.size, height: 300 } as object)}
        </div>
      ) : (
        <div data-chart-placeholder="" />
      ),
  };
});

let page: RenderedPage | undefined;

afterEach(() => {
  page?.unmount();
  page = undefined;
  chartBox.size = 0;
});

const render = (fixtures: Fixtures = FIXTURES) => renderMdPage(MdRecruitment, fixtures, { path: "/md/recruitment" });
const text = (selector: string) => page?.container.querySelector(selector)?.textContent ?? "";
const all = (selector: string) => Array.from(page?.container.querySelectorAll(selector) ?? []);

// The page mounts the whole portal shell and eight charts and tables in jsdom: give each test room on a busy machine.
describe("the Recruitment page", { timeout: 30_000 }, () => {
  it("shows the headline strip with each figure beside what it is compared with", async () => {
    page = await render();
    expect(text('[data-testid="md-page-title"]')).toBe("Recruitment");
    expect(text('[data-testid="md-recruitment-kpi-open"]')).toContain("Open positions");
    expect(text('[data-testid="md-recruitment-kpi-open-value"]')).toBe("4");
    expect(text('[data-testid="md-recruitment-kpi-open"]')).toContain("5 vacancies against plan");
    expect(text('[data-testid="md-recruitment-kpi-open"]')).toContain("2 open too long");
    expect(text('[data-testid="md-recruitment-kpi-age-value"]')).toBe("49 days");
    expect(text('[data-testid="md-recruitment-kpi-age"]')).toContain("Oldest 82 days");
    expect(text('[data-testid="md-recruitment-kpi-pipeline-value"]')).toBe("11");
    expect(text('[data-testid="md-recruitment-kpi-pipeline"]')).toContain("5 job board · 6 resumes");
    expect(text('[data-testid="md-recruitment-kpi-interviews-value"]')).toBe("1");
    expect(text('[data-testid="md-recruitment-kpi-interviews"]')).toContain("2 held in the period");
    // joiners up 100% on the period before is good news; leavers up 300% is bad: the chip text says how much
    expect(text('[data-testid="md-recruitment-kpi-joined"]')).toContain("+100%");
    expect(text('[data-testid="md-recruitment-kpi-joined"]')).toContain("2 staff · 2 production");
    expect(text('[data-testid="md-recruitment-kpi-left"]')).toContain("+300%");
    expect(text('[data-testid="md-recruitment-kpi-left"]')).toContain("2 resigned · 2 other exits");
    expect(text('[data-testid="md-recruitment-kpi-pending-value"]')).toBe("3");
    expect(text('[data-testid="md-recruitment-kpi-pending"]')).toContain("Oldest waiting 10 days");
    expect(text('[data-testid="md-recruitment-kpi-pending"]')).toContain("1 serving notice");
    expect(text('[data-testid="md-recruitment-kpi-attrition-value"]')).toBe("8%");
    expect(text('[data-testid="md-recruitment-kpi-attrition"]')).toContain("+6 pts");
    expect(text('[data-testid="md-recruitment-kpi-attrition"]')).toContain("About 97% a year");
  });

  it("puts the exceptions first, with a way to ask why", async () => {
    page = await render();
    const items = all('[data-testid="md-recruitment-attention"] [data-testid^="insight-recruitment."]');
    expect(items.map((i) => i.getAttribute("data-severity"))).toEqual(["warning", "warning", "good"]);
    expect(items.every((i) => i.querySelector("a") === null)).toBe(true); // no link back to this very page
    expect(text('[data-testid="md-recruitment-attention"]')).toContain(
      "2 open positions have been open for more than 45 days",
    );
    expect(text('[data-testid="md-recruitment-attention"]')).toContain("Department head (2), HR (1)");
    await page.click(
      '[data-testid="md-recruitment-attention"] [data-testid="insight-recruitment.stale-positions"] [data-testid="ask-ai"]',
    );
    expect(getAssistantState().prompt?.text).toBe(
      "Which positions have been open too long, and what is holding them up?",
    );
  });

  it("draws the funnel with the conversion and the drop-off at every step", async () => {
    page = await render();
    const counts = ["applied", "screened", "shortlisted", "interviewed", "offered", "joined"].map((id) =>
      text(`[data-testid="funnel-count-${id}"]`),
    );
    expect(counts).toEqual(["13", "10", "7", "5", "1", "4"]);
    expect(text('[data-testid="funnel-step-screened"]')).toContain("76.9% of applied");
    expect(text('[data-testid="funnel-step-screened"]')).toContain("3 dropped (23.1%)");
    expect(text('[data-testid="funnel-step-offered"]')).toContain("33.3% of interviewed (job board)");
    // joined comes from the employee records and says so, rather than posing as a share of those offered
    expect(text('[data-testid="funnel-step-joined"]')).toContain("not a share of those offered");
    expect(text('[data-testid="md-recruitment-funnel-department-table"]')).toContain("Stitching (Unit 1)");
  });

  it("switches the funnel to one pipeline and says what that pipeline cannot answer", async () => {
    page = await render();
    await page.click('[data-testid="md-recruitment-funnel-view"] button:nth-child(2)'); // Job board
    expect(text('[data-testid="funnel-count-applied"]')).toBe("6");
    expect(text('[data-testid="funnel-step-offered"]')).toContain("33.3% of interviewed");
    expect(text('[data-testid="funnel-step-joined"]')).toContain("Not recorded for this view");
    await page.click('[data-testid="md-recruitment-funnel-view"] button:nth-child(3)'); // Resume screening
    expect(text('[data-testid="funnel-count-applied"]')).toBe("7");
    expect(text('[data-testid="funnel-step-offered"]')).toContain("Not recorded for this view");
    expect(text('[data-testid="funnel-step-offered"]')).toContain("no final selection");
  });

  it("lists open positions oldest first with the stale ones flagged, and is honest about time to fill", async () => {
    page = await render();
    const rows = all('[data-testid="md-recruitment-positions-table"] tbody tr');
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain("Accountant");
    expect(rows[0].textContent).toContain("82 days");
    expect(rows[0].textContent).toContain("Stale");
    expect(rows[3].textContent).toContain("Cutting Master");
    expect(
      all('[data-testid="md-recruitment-positions-table"] tbody tr').filter((r) => r.textContent?.includes("Stale")),
    ).toHaveLength(2);
    expect(rows[1].textContent).toContain("Stitching (Unit 1) · Unit 1");
    expect(rows[2].textContent).toContain("No department"); // the Driver posting has none
    expect(text('[data-testid="md-recruitment-time-to-fill-note"]')).toContain(
      "does not record when a position is filled",
    );
  });

  it("shows only the first few positions and offers more", async () => {
    const many: OpenPosition[] = Array.from({ length: 9 }, (_, i) => ({
      ...POSITIONS.positions[1],
      id: 100 + i,
      title: `Role ${i}`,
      daysOpen: 90 - i,
    }));
    page = await render({
      ...FIXTURES,
      "/api/md/recruitment/positions": {
        ...POSITIONS,
        positions: many,
        positionsShown: 9,
        summary: { ...POSITIONS.summary, open: 9 },
      },
    });
    expect(all('[data-testid="md-recruitment-positions-table"] tbody tr')).toHaveLength(6);
    await page.click('[data-testid="md-recruitment-positions-table"] [data-testid="show-more"]');
    expect(all('[data-testid="md-recruitment-positions-table"] tbody tr')).toHaveLength(9);
  });

  it("ranks the staffing gap by department and leaves out the fully staffed ones", async () => {
    page = await render();
    const bars = all('[data-testid="md-recruitment-gap-list"] li').map((li) => li.textContent);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toContain("Stitching (Unit 1)");
    expect(bars[0]).toContain("4 short");
    expect(bars[0]).toContain("2 of 6 filled (33%)");
    expect(bars[1]).toContain("Cutting");
    expect(text('[data-testid="md-recruitment-gap"]')).toContain(
      "2 of 4 planned departments are at or above their plan",
    );
    expect(text('[data-testid="md-recruitment-gap"]')).toContain("5 vacancies against a plan of 50 staff");
  });

  it("keeps a long staffing-gap list short and expands on request", async () => {
    const departments = Array.from({ length: 10 }, (_, i) => ({
      departmentId: 200 + i,
      department: `Department ${i}`,
      unit: "Unit 1",
      required: 20,
      current: 10 + i,
      vacancy: 10 - i,
      surplus: 0,
      fillPct: (10 + i) * 5,
      openJobs: 0,
      shortlisted: 0,
    }));
    page = await render({
      ...FIXTURES,
      "/api/md/recruitment/positions": {
        ...POSITIONS,
        headcountGap: { ...POSITIONS.headcountGap, departments, departmentsTotal: 10, departmentsWithGap: 10 },
      },
    });
    expect(all('[data-testid="md-recruitment-gap-list"] li')).toHaveLength(8);
    expect(text('[data-testid="md-recruitment-gap-list"] li')).toContain("Department 0"); // the biggest gap first
    await page.click('[data-testid="md-recruitment-gap"] [data-testid="show-more-bars"]');
    expect(all('[data-testid="md-recruitment-gap-list"] li')).toHaveLength(10);
  });

  it("shows who is waiting on whom, who is serving notice and who is about to leave", async () => {
    page = await render();
    const rows = all('[data-testid="md-recruitment-pending-table"] tbody tr').map((r) => r.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Anil Test");
    expect(rows[0]).toContain("waiting 10 days");
    expect(rows[0]).toContain("Department head");
    expect(rows[1]).toContain("HR"); // Anita: the department head has approved
    expect(rows[2]).toContain("Not given"); // Ajay named no last working day
    expect(text('[data-testid="md-recruitment-on-notice"]')).toContain("Leena Test");
    expect(text('[data-testid="md-recruitment-on-notice"]')).toContain("15 days left");
    expect(text('[data-testid="md-recruitment-outlook-30"]')).toContain("2");
    expect(text('[data-testid="md-recruitment-outlook-30"]')).toContain("1 serving notice · 1 waiting for a decision");
    expect(text('[data-testid="md-recruitment-outlook-60"]')).toContain("3");
    expect(text('[data-testid="md-recruitment-outlook"]')).toContain("1 waiting request has no last working day");
  });

  it("counts reasons by group and never quotes what an employee wrote", async () => {
    page = await render();
    const legend = text('[data-testid="md-recruitment-reasons-donut"]');
    for (const label of ["Family or personal", "Pay or a better job offer", "Health or medical", "Not stated"]) {
      expect(legend).toContain(label);
    }
    expect(text('[data-testid="md-recruitment-reasons"]')).toContain("a guide, not an exact count");
    expect(text('[data-testid="md-recruitment-reasons"]')).toContain("Average time to decide: 5.5 days");
    const byDept = all('[data-testid="md-recruitment-resignations-departments"] li').map((li) => li.textContent);
    expect(byDept[0]).toContain("Stitching (Unit 1)");
    expect(byDept[0]).toContain("1 approved · 1 waiting · 1 rejected");
  });

  it("charts joiners against leavers and says who joined and who left early", async () => {
    chartBox.size = 800; // draw the real chart in this one
    page = await render();
    expect(text('[data-testid="md-recruitment-trend"]')).toContain(
      "Hiring outpaced exits by 2 over the last 12 months.",
    );
    const chart = text('[data-testid="md-recruitment-trend"] [data-testid="trend-chart"]');
    for (const series of ["Joined", "Left", "Vacancies against plan"]) expect(chart).toContain(series); // the legend
    expect(chart).toContain("Sep");
    expect(chart).toContain("Oct");
    expect(
      page.container.querySelectorAll('[data-testid="md-recruitment-trend"] .recharts-bar-rectangle').length,
    ).toBeGreaterThan(0);
    const joined = all('[data-testid="md-recruitment-joiners-table"] tbody tr').map((r) => r.textContent ?? "");
    expect(joined).toHaveLength(4);
    expect(joined[0]).toContain("Arun Test");
    expect(joined[0]).toContain("6 documents missing");
    expect(joined[1]).toContain("Documents complete");
    expect(joined[2]).toContain("Has left");
    expect(text('[data-testid="md-recruitment-joiners"]')).toContain("2 people still owe documents");
    expect(text('[data-testid="md-recruitment-early-headline"]')).toBe(
      "2 of 4 leavers left within 90 days of joining (50%).",
    );
    const early = all('[data-testid="md-recruitment-early-table"] tbody tr').map((r) => r.textContent ?? "");
    expect(early[0]).toContain("Jeeva Test");
    expect(early[0]).toContain("about 22 days");
  });

  it("explains every card, in the words the assistant quotes", async () => {
    page = await render();
    const buttons = all('[data-testid="provenance-button"]');
    expect(buttons.length).toBeGreaterThanOrEqual(12);
    await page.click('[data-testid="md-recruitment-kpi-open"] [data-testid="provenance-button"]');
    expect(document.body.textContent).toContain("How open positions is worked out.");
    expect(all('[data-testid="ask-ai"]').length).toBeGreaterThanOrEqual(9); // every card asks
  });

  it("asks for every endpoint with the chosen period, and again when the period changes", async () => {
    page = await render();
    const first = page.requests();
    for (const name of ["summary", "attention", "funnel", "sources", "resignations", "joiners"]) {
      expect(first.some((r) => r.startsWith(`/api/md/recruitment/${name}?`) && r.includes("period=last_90_days"))).toBe(
        true,
      );
    }
    // positions and the trend are snapshots: they take the part of the company, not the period
    expect(
      first
        .filter((r) => r.startsWith("/api/md/recruitment/positions") || r.startsWith("/api/md/recruitment/trend"))
        .every((r) => !r.includes("period=")),
    ).toBe(true);
    await page.click('[data-testid="period-bar"] [role="tablist"] button:nth-child(1)'); // Last 30 days
    expect(
      page.requests().some((r) => r.startsWith("/api/md/recruitment/summary?") && r.includes("period=last_30_days")),
    ).toBe(true);
    expect(text('[data-testid="md-recruitment-kpi-open-value"]')).toBe("4"); // the old numbers stay on screen meanwhile
  });

  it("tells the assistant what the MD is looking at", async () => {
    page = await render();
    const context = getAssistantState().context;
    expect(context?.page).toBe("recruitment");
    expect(context?.filters).toMatchObject({
      Period: "Last 90 days",
      Scope: "All units · all departments · staff and production",
    });
    expect(context?.summary).toMatchObject({
      "Open positions": 4,
      "Vacancies against plan": 5,
      "Positions open too long": 2,
      Attrition: "8%",
    });
  });

  it("shows a failed section as an error with a retry and keeps the rest of the page", async () => {
    page = await render({
      ...FIXTURES,
      "/api/md/recruitment/positions": { status: 400, body: { error: "That is not a department." } },
    });
    expect(text('[data-testid="md-recruitment-positions"]')).toContain("This could not be loaded.");
    expect(text('[data-testid="md-recruitment-positions"]')).toContain("That is not a department.");
    expect(text('[data-testid="md-recruitment-gap"]')).toContain("This could not be loaded.");
    expect(page.container.querySelector('[data-testid="md-recruitment-positions"] button')).not.toBeNull(); // Retry
    expect(text('[data-testid="md-recruitment-kpi-pipeline-value"]')).toBe("11"); // everything else still shows
    expect(text('[data-testid="md-recruitment-funnel"]')).toContain("Applied");
  });

  it("shows a failed headline as one error, not eight broken cards", async () => {
    page = await render({
      ...FIXTURES,
      "/api/md/recruitment/summary": { status: 400, body: { error: "Unknown period 'x'." } },
    });
    expect(all('[data-testid="md-error"]').some((e) => e.textContent?.includes("Unknown period 'x'."))).toBe(true);
    expect(text('[data-testid="md-recruitment-kpi-open-value"]')).toBe("—");
  });

  it("says why a section is empty instead of showing blank cards", async () => {
    page = await render(EMPTY_FIXTURES);
    expect(text('[data-testid="md-recruitment-attention"]')).toContain(
      "Nothing in recruitment needs your attention right now.",
    );
    expect(text('[data-testid="md-recruitment-funnel"]')).toContain("No candidates in this period");
    expect(text('[data-testid="md-recruitment-sources"]')).toContain("No candidates in this period.");
    expect(text('[data-testid="md-recruitment-positions"]')).toContain("No open positions");
    expect(text('[data-testid="md-recruitment-gap"]')).toContain("No staffing plan set");
    expect(text('[data-testid="md-recruitment-pending"]')).toContain("No resignations waiting");
    expect(text('[data-testid="md-recruitment-reasons"]')).toContain("No resignations raised in this period");
    expect(text('[data-testid="md-recruitment-outlook-30"]')).toContain("Nobody is due to leave");
    expect(text('[data-testid="md-recruitment-joiners"]')).toContain("Nobody joined in this period");
    expect(text('[data-testid="md-recruitment-early"]')).toContain("Nobody left in this period");
    expect(text('[data-testid="md-recruitment-trend"]')).toContain("No joiners or leavers in the last 12 months");
    // no data is a dash, never a 0% or a 0-day average
    expect(text('[data-testid="md-recruitment-kpi-age-value"]')).toBe("—");
    expect(text('[data-testid="md-recruitment-kpi-attrition-value"]')).toBe("—");
    expect(text('[data-testid="md-recruitment-kpi-attrition"]')).toContain("No headcount to measure against");
    // the caveat about the missing plan is shown once, as a note
    expect(all('[data-testid="md-note"]')).toHaveLength(1);
    expect(all('[data-testid="md-note"]')[0].textContent).toContain("No required headcount has been set");
  });

  it("does not crash on a staff-or-production choice that has no plan", async () => {
    const production = {
      ...POSITIONS,
      headcountGap: {
        ...POSITIONS.headcountGap,
        applicable: false,
        required: null,
        current: null,
        vacancies: null,
        surplus: null,
        departmentsWithGap: null,
        departments: [],
        departmentsTotal: 0,
      },
      notes: ["The staffing plan covers staff only, so it is not shown for production."],
    };
    page = await render({ ...FIXTURES, "/api/md/recruitment/positions": production });
    expect(text('[data-testid="md-recruitment-gap"]')).toContain("No staffing plan for production");
    expect(
      all('[data-testid="md-note"]')
        .map((n) => n.textContent)
        .join(" "),
    ).toContain("covers staff only");
  });
});
