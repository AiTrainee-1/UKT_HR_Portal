import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { getAssistantState, setAssistantContext } from "@/lib/md/assistant-store";
import MdAttendance from "../MdAttendance";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import { EMPTY_SUMMARY, LIVE, SUMMARY, attendanceFixtures, emptyFixtures } from "./fixtures";

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
  setAssistantContext(null);
});

const render = (fixtures: Fixtures = attendanceFixtures()) =>
  renderMdPage(MdAttendance, fixtures, { path: "/md/attendance" });

const byTestId = (id: string, within?: Element | null) =>
  (within ?? page!.container).querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function clickByText(selector: string, text: string) {
  const el = Array.from(page!.container.querySelectorAll<HTMLElement>(selector)).find((e) =>
    e.textContent?.includes(text),
  );
  if (!el) throw new Error(`No ${selector} contains "${text}"`);
  await act(async () => {
    el.click();
  });
  await page!.settle();
}

const asked = (prefix: string) => page!.requests().filter((r) => r.startsWith(prefix));

describe("MdAttendance: a normal day", () => {
  it("shows the six headline figures with the change against the previous period", async () => {
    page = await render();
    expect(page.text()).toContain("Attendance Analytics");
    const value = (key: string) => byTestId(`md-attendance-kpi-${key}-value`)?.textContent;
    expect(value("attendancePct")).toBe("75.9%");
    expect(value("absenteeismPct")).toBe("17.2%");
    expect(value("latePct")).toBe("17.4%");
    expect(value("overtimeHours")).toBe("6.5 h");
    expect(value("halfDays")).toBe("2");
    expect(value("missingPunches")).toBe("2");
    expect(byTestId("md-attendance-kpi-attendancePct")?.textContent).toContain("-13.7 pts");
    expect(byTestId("md-attendance-kpi-absenteeismPct")?.textContent).toContain("+8.9 pts");
    expect(byTestId("md-attendance-kpi-absenteeismPct")?.textContent).toContain("was 8.3% before");
    expect(byTestId("md-attendance-kpi-latePct")?.textContent).toContain("35m late on average");
  });

  it("puts what needs attention first, with the severity and a question for the assistant", async () => {
    page = await render();
    const card = byTestId("md-attendance-attention");
    expect(card?.textContent).toContain("Needs your attention");
    expect(card?.textContent).toContain("1 employee has been absent 3+ days in a row without explanation");
    expect(byTestId("insight-attendance.long-absence")?.getAttribute("data-severity")).toBe("warning");
    expect(card?.querySelectorAll('[data-testid="ask-ai"]').length).toBeGreaterThanOrEqual(3); // one per finding and a general one
  });

  it("charts the trend and the weekday pattern", async () => {
    page = await render();
    expect(byTestId("md-attendance-trend")?.textContent).toContain("One point per working day");
    expect(byTestId("md-attendance-weekday")?.textContent).toContain("Mondays are no worse than other days");
    expect(byTestId("md-attendance-weekday-bars")?.textContent).toContain("40%"); // Wednesday's absence
    await clickByText('[data-testid="md-attendance-weekday"] button[role="tab"]', "Week by week");
    expect(byTestId("md-attendance-week-grid")?.textContent).toContain("07 Sep");
  });

  it("ranks the departments, and a click narrows the whole page to one", async () => {
    page = await render();
    const table = byTestId("md-attendance-department-table");
    expect(table?.textContent).toContain("Stitching");
    expect(table?.textContent).toContain("61.1%");
    expect(table?.textContent).toContain("below the company"); // 14.8 points under the company
    expect(table?.textContent).toContain("-22.2 pts");
    await act(async () => {
      table?.querySelector<HTMLElement>('[data-testid="row-Stitching"]')?.click();
    });
    await page.settle();
    expect(asked("/api/md/attendance/summary").some((r) => r.includes("department=Stitching"))).toBe(true);
    expect(asked("/api/md/attendance/exceptions").some((r) => r.includes("department=Stitching"))).toBe(true);
    expect(asked("/api/md/attendance/day").some((r) => r.includes("department=Stitching"))).toBe(true);
  });

  it("switches the ranking to units and to staff against production", async () => {
    page = await render();
    await clickByText('[data-testid="md-attendance-departments"] button[role="tab"]', "Units");
    expect(byTestId("md-attendance-department-table")?.textContent).toContain("Head Office");
    await clickByText('[data-testid="md-attendance-departments"] button[role="tab"]', "Staff and production");
    expect(byTestId("md-attendance-department-table")?.textContent).toContain("Production");
  });

  it("shows the department-by-day grid", async () => {
    page = await render();
    const grid = byTestId("md-attendance-day-grid");
    expect(grid?.textContent).toContain("Stitching");
    expect(grid?.textContent).toContain("17"); // Stitching on the 9th: 16.7 %
    expect(byTestId("md-attendance-heatmap")?.textContent).toContain("07 Sep – 09 Sep");
  });

  it("lists the people behind the numbers and opens on the first list with someone in it", async () => {
    page = await render();
    const table = byTestId("md-attendance-exceptions-chronicAbsentees");
    expect(table?.textContent).toContain("Bala Raj");
    expect(table?.textContent).toContain("T002 · Stitching · Unit A");
    expect(table?.textContent).toContain("3 of 6");
    expect(table?.textContent).toContain("50%");
    expect(byTestId("md-attendance-exceptions")?.textContent).toContain("3 or more unplanned absence days");
    await clickByText('[data-testid="md-attendance-exceptions"] button[role="tab"]', "Long absences");
    expect(byTestId("md-attendance-exceptions-longAbsences")?.textContent).toContain("08 Sep – 10 Sep");
    expect(byTestId("md-attendance-exceptions-longAbsences")?.textContent).toContain("Back at work");
    await clickByText('[data-testid="md-attendance-exceptions"] button[role="tab"]', "Late-comers");
    expect(byTestId("md-attendance-exceptions-habitualLate-empty")?.textContent).toContain("Nobody here");
    await clickByText('[data-testid="md-attendance-exceptions"] button[role="tab"]', "Missing punches");
    expect(byTestId("md-attendance-exceptions-missingPunches")?.textContent).toContain("Asha Kumar");
  });

  it("shows overtime and leave", async () => {
    page = await render();
    expect(byTestId("md-attendance-overtime-total")?.textContent).toBe("6.5 h");
    expect(byTestId("md-attendance-overtime")?.textContent).toContain("3.5% of scheduled hours");
    expect(byTestId("md-attendance-overtime-decisions")?.textContent).toContain("Pay: 1 day · 2.0 h");
    expect(byTestId("md-attendance-overtime-people")?.textContent).toContain("Asha Kumar");
    expect(byTestId("md-attendance-leave-total")?.textContent).toBe("3.5 days");
    expect(byTestId("md-attendance-leave")?.textContent).toContain("Sick Leave");
    expect(byTestId("md-attendance-leave-pending")?.textContent).toContain("oldest 20 days");
  });

  it("shows one day and asks for yesterday until another is chosen", async () => {
    page = await render();
    expect(asked("/api/md/attendance/day")[0]).toContain("date=yesterday");
    expect(byTestId("md-attendance-day-totals")?.textContent).toContain("3 of 5 in (50%)");
    expect(byTestId("md-attendance-day-units")?.textContent).toContain("Unit A");
    await clickByText('[data-testid="md-attendance-day"] button[role="tab"]', "Today");
    expect(asked("/api/md/attendance/day").some((r) => r.includes("date=today"))).toBe(true);
  });

  it("changing the period asks everything again for the new period", async () => {
    page = await render();
    await clickByText('[data-testid="period-bar"] button[role="tab"]', "Last 7 days");
    for (const path of ["summary", "trend", "weekday", "departments", "heatmap", "exceptions", "overtime", "leave"]) {
      expect(
        asked(`/api/md/attendance/${path}`).some((r) => r.includes("period=last_7_days")),
        path,
      ).toBe(true);
    }
  });

  it("every card explains itself and offers a specific question", async () => {
    page = await render();
    expect(page.container.querySelectorAll('[data-testid="provenance-button"]').length).toBeGreaterThanOrEqual(8);
    expect(page.container.querySelectorAll('[data-testid="ask-ai"]').length).toBeGreaterThanOrEqual(12);
    await act(async () => {
      byTestId("md-attendance-kpi-attendancePct")?.querySelector<HTMLElement>('[data-testid="ask-ai"]')?.click();
    });
    expect(getAssistantState().prompt?.text).toContain("Attendance is 75.9% (was 89.6% before)");
  });

  it("tells the assistant what it shows", async () => {
    page = await render();
    const context = getAssistantState().context;
    expect(context?.page).toBe("attendance");
    expect(context?.filters?.Scope).toBe("All units · all departments · staff and production");
    expect(context?.summary).toMatchObject({ Attendance: "75.9%", Absenteeism: "17.2%", "Overtime hours": "6.5 h" });
  });
});

describe("MdAttendance: partial data and today", () => {
  const partial = {
    ...SUMMARY,
    coverage: {
      expectedDays: 29,
      recordedDays: 26,
      missingDays: 3,
      coveragePct: 89.7,
      partial: true,
      worstDays: [{ date: "2026-09-08", expected: 5, recorded: 4, coveragePct: 80 }],
    },
    notes: [
      "Today is still running and is left out of the figures.",
      "Attendance day records exist for 89.7% of scheduled days (26 of 29 employee-days).",
    ],
  };

  it("says how much of the period has records, once, and names the dates to open first", async () => {
    page = await render(attendanceFixtures({ "/api/md/attendance/summary": partial }));
    const note = byTestId("md-attendance-coverage");
    expect(note?.textContent).toContain("89.7% of scheduled days have an attendance record (26 of 29 employee-days)");
    expect(note?.textContent).toContain("08 Sep (80%)");
    const banners = Array.from(page.container.querySelectorAll('[data-testid="md-note"]')).map(
      (n) => n.textContent ?? "",
    );
    expect(banners).toHaveLength(2); // the "today" note at the top and the coverage note at the foot, not coverage twice
    expect(banners.filter((b) => b.includes("89.7%"))).toHaveLength(1);
  });

  it("shows who is in so far today, as a provisional count", async () => {
    page = await render(attendanceFixtures({ "/api/md/attendance/summary": { ...SUMMARY, live: LIVE } }));
    const today = byTestId("md-attendance-today");
    expect(today?.textContent).toContain("Today so far");
    expect(today?.textContent).toContain("Provisional");
    expect(byTestId("md-attendance-today-sentence")?.textContent).toContain(
      "228 of 262 in so far (87%) · 14 on leave · 20 not in yet",
    );
    expect(byTestId("md-attendance-today-sentence")?.textContent).toContain("Most not in yet: Unit 1 (20)");
    expect(byTestId("md-attendance-kpis")).not.toBeNull(); // the rates are still there, for complete days
  });

  it("a period that is only today has a live count and no rates", async () => {
    const todayOnly = {
      ...SUMMARY,
      measured: null,
      previous: null,
      metrics: {},
      counts: {},
      coverage: null,
      live: LIVE,
    };
    page = await render(attendanceFixtures({ "/api/md/attendance/summary": todayOnly }));
    expect(byTestId("md-attendance-today")).not.toBeNull();
    expect(byTestId("md-attendance-today-only")?.textContent).toContain("Today is still running");
    expect(byTestId("md-attendance-kpis")).toBeNull();
  });

  it("a weekly off today says so instead of showing zeros", async () => {
    const off = { ...LIVE, isWorkingDay: false, expected: 0, present: 0, absent: 0, leave: 0, attendancePct: null };
    page = await render(attendanceFixtures({ "/api/md/attendance/summary": { ...SUMMARY, live: off } }));
    expect(byTestId("md-attendance-today-off")?.textContent).toContain("Nobody is scheduled to work today");
  });
});

describe("MdAttendance: failures and nothing to show", () => {
  it("one card failing does not take the page down", async () => {
    page = await render(
      attendanceFixtures({
        "/api/md/attendance/exceptions": { status: 400, body: { error: "That list could not be worked out." } },
      }),
    );
    expect(byTestId("md-attendance-attention")?.textContent).toContain("That list could not be worked out.");
    expect(byTestId("md-attendance-exceptions")?.textContent).toContain("This could not be loaded.");
    expect(byTestId("md-attendance-kpi-attendancePct-value")?.textContent).toBe("75.9%"); // the rest is intact
    expect(byTestId("md-attendance-department-table")?.textContent).toContain("Stitching");
  });

  it("a failed summary says so at the top of the page", async () => {
    page = await render(
      attendanceFixtures({ "/api/md/attendance/summary": { status: 400, body: { error: "Unknown period 'x'." } } }),
    );
    expect(byTestId("md-error")?.textContent).toContain("Unknown period 'x'.");
    expect(byTestId("md-attendance-kpi-attendancePct-value")?.textContent).toBe("—");
  });

  it("an empty database is honest everywhere: no zeros, no crash", async () => {
    page = await render(emptyFixtures());
    for (const key of ["attendancePct", "absenteeismPct", "latePct", "overtimeHours", "halfDays", "missingPunches"]) {
      expect(byTestId(`md-attendance-kpi-${key}-value`)?.textContent, key).toBe("—");
    }
    expect(page.text()).toContain("No attendance day records exist for these days");
    expect(byTestId("insights-empty")?.textContent).toContain("Nothing needs your attention in this period.");
    expect(byTestId("md-attendance-trend-empty")?.textContent).toContain("Nothing to chart yet");
    expect(byTestId("md-attendance-weekday")?.textContent).toContain("No scheduled days with a record yet.");
    expect(byTestId("md-attendance-heatmap-empty")?.textContent).toContain("No days to show");
    expect(byTestId("md-attendance-departments-empty")?.textContent).toContain("No departments to rank");
    expect(byTestId("md-attendance-exceptions-chronicAbsentees-empty")?.textContent).toContain("Nobody here");
    expect(byTestId("md-attendance-overtime-empty")?.textContent).toContain("Overtime detection is switched off");
    expect(byTestId("md-attendance-leave-empty")?.textContent).toContain("No approved leave");
    expect(byTestId("md-attendance-day-empty")?.textContent).toContain("Nobody was scheduled");
    expect(byTestId("md-attendance-coverage")).toBeNull(); // nothing was scheduled: nothing to cover
    expect(EMPTY_SUMMARY.metrics.attendancePct?.value).toBeNull();
  });
});
