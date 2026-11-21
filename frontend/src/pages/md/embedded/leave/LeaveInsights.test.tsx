import { cloneElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import { renderMdPage, type Fixtures, type RenderedPage } from "../../testing/renderMdPage";
import * as fx from "./fixtures";
import LeaveInsights, { Strip } from "./index";

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 800, height: 240 }),
  };
});

vi.setConfig({ testTimeout: 30_000 });

let page: RenderedPage | undefined;
beforeEach(() => window.history.replaceState(null, "", "/md/leave"));
afterEach(() => {
  page?.unmount();
  page = undefined;
  window.history.replaceState(null, "", "/");
});

const BASE = "/api/md/leave";
const FIXTURES: Fixtures = {
  [`${BASE}/summary`]: fx.summary,
  [`${BASE}/briefing`]: fx.briefing,
  [`${BASE}/attention`]: fx.attention,
  [`${BASE}/trend`]: fx.trend,
  [`${BASE}/groups`]: fx.groups,
  [`${BASE}/today`]: fx.today,
  [`${BASE}/balances`]: fx.balances,
  [`${BASE}/permissions`]: fx.permissions,
  [`${BASE}/approvals`]: fx.approvals,
  [`${BASE}/list`]: fx.list,
};
const EMPTY: Fixtures = {
  [`${BASE}/summary`]: fx.emptySummary,
  [`${BASE}/briefing`]: fx.emptyBriefing,
  [`${BASE}/attention`]: fx.emptyAttention,
  [`${BASE}/trend`]: fx.emptyTrend,
  [`${BASE}/groups`]: fx.emptyGroups,
  [`${BASE}/today`]: fx.today,
  [`${BASE}/balances`]: fx.emptyBalances,
  [`${BASE}/permissions`]: fx.emptyPermissions,
  [`${BASE}/approvals`]: fx.emptyApprovals,
  [`${BASE}/list`]: fx.list,
};

const text = (selector: string) =>
  (page?.container.querySelector(selector) ?? document.body.querySelector(selector))?.textContent ?? null;

async function open(fixtures: Fixtures = FIXTURES) {
  page = await renderMdPage(LeaveInsights, fixtures, { path: "/md/leave" });
  return page;
}

describe("Leave & Holiday insights", () => {
  it("leads with the briefing, the figures and what needs attention", async () => {
    await open();
    expect(text('[data-testid="md-leave-sentence-permissions"]')).toContain(
      "2 of the approved went beyond the monthly cap",
    );
    expect(text('[data-testid="md-leave-kpi-days-value"]')).toBe("6");
    expect(text('[data-testid="md-leave-kpi-rate-value"]')).toBe("30%");
    expect(text('[data-testid="md-leave-kpi-rejected-value"]')).toBe("33.3%");
    expect(text('[data-testid="md-leave-kpi-waiting-value"]')).toBe("1");
    expect(text('[data-testid="md-leave-kpi-permissions-value"]')).toBe("2");
    expect(text('[data-testid="md-leave-attention"]')).toContain("1 leave request has waited 8 days");
    expect(text('[data-testid="md-leave-momentum"]')).toContain("Leave is rising");
    expect(text('[data-testid="md-leave-casual-line"]')).toContain("2.5 days used (5.2% of the year's days)");
    expect(text('[data-testid="md-leave-permissions-line"]')).toContain(
      "2 approved beyond the cap (66.7% of the approved)",
    );
    expect(text('[data-testid="md-leave-out-today"]')).toContain("1 person is on leave today");
    expect(text('[data-testid="md-leave-notes"]')).toContain("production employees are not counted");
  });

  it("asks for the running month and the year of Casual Leave, and follows the month picker", async () => {
    const p = await open();
    expect(p.requests().some((r) => r.startsWith(`${BASE}/summary?period=this_month`))).toBe(true);
    expect(p.requests().some((r) => r.startsWith(`${BASE}/balances`) && /year=\d{4}/.test(r))).toBe(true);
    await p.click('[data-testid="month-prev"]');
    const last =
      p
        .requests()
        .filter((r) => r.startsWith(`${BASE}/groups`))
        .pop() ?? "";
    expect(last).toMatch(/month=\d{4}-\d{2}/);
    // leave does not apply to production, so the staff / production choice is not offered
    expect(p.container.querySelector('[data-testid="scope-type"]')).toBeNull();
  });

  it("opens the rejected requests with the approver's reason", async () => {
    const p = await open();
    await p.click('[data-testid="md-leave-kpi-rejected"]');
    expect(
      p
        .requests()
        .some((r) => r.includes("/leave/list?") && r.includes("what=requests") && r.includes("status=rejected")),
    ).toBe(true);
    await p.click('[data-testid="md-leave-item-leave-5"] button');
    const detail = text('[data-testid="md-leave-item-leave-5-detail"]') ?? "";
    expect(detail).toContain("Busy month");
    expect(detail).toContain("Priya");
  });

  it("drills from Casual Leave, a group, a day and a permission type", async () => {
    const p = await open();
    await p.click('[data-testid="md-leave-casual-carry"]');
    expect(
      p
        .requests()
        .some((r) => r.includes("/leave/list?") && r.includes("what=cl") && r.includes("filter=carry_forward")),
    ).toBe(true);
    await p.click('[data-testid="md-leave-item-cl-11"] button');
    expect(text('[data-testid="md-leave-item-cl-11-detail"]')).toContain("28 Sep 2026");
    await p.click('[data-testid="md-leave-day-2026-11-16"]');
    expect(p.requests().some((r) => r.includes("what=out") && r.includes("day=2026-11-16"))).toBe(true);
    await p.click('[data-testid="bar-evening_early_out"] button');
    expect(p.requests().some((r) => r.includes("what=permissions") && r.includes("leaveType=Evening+Early-Out"))).toBe(
      true,
    );
  });

  it("groups leave by the reason employees pick", async () => {
    const p = await open();
    await p.click('[data-testid="md-leave-group-tabs"] button:nth-child(2)');
    expect(p.requests().some((r) => r.startsWith(`${BASE}/groups`) && r.includes("by=reason"))).toBe(true);
    expect(text('[data-testid="md-leave-group-rows"]')).toContain("Sick Leave");
  });

  it("tells the assistant what is on screen", async () => {
    await open();
    const context = getAssistantState().context;
    expect(context?.page).toBe("leave");
    expect(context?.summary?.["Leave days"]).toBe("6 days");
    expect(context?.summary?.["Permissions over the cap"]).toBe("2");
  });

  it("says when there is nothing, and survives a failed card", async () => {
    const p = await open({ ...EMPTY, [`${BASE}/permissions`]: { status: 400, body: { error: "Permissions broke" } } });
    expect(text('[data-testid="md-leave-trend-empty"]')).toContain("No approved leave");
    expect(text('[data-testid="md-leave-groups-empty"]')).toContain("No approved leave");
    expect(text('[data-testid="md-leave-casual-empty"]')).toContain("Casual Leave is for staff");
    expect(text('[data-testid="md-leave-approvals-empty"]')).toContain("Nobody applied");
    expect(p.text()).toContain("Permissions broke");
  });
});

describe("Leave & Holiday strip", () => {
  it("shows who is out, what waits and the top exception", async () => {
    page = await renderMdPage(
      Strip,
      {
        "/api/md/brief/leave": {
          page: "leave",
          title: "Leave & Holiday",
          domain: "leave",
          kpis: [
            { id: "leave.out-today", label: "On leave today", value: 1, format: "number" },
            { id: "leave.pending", label: "Leave requests waiting", value: 1, format: "number" },
          ],
          insights: fx.attention.items,
          provenance: [],
          notes: [],
        },
      },
      { path: "/md/leave" },
    );
    expect(text('[data-testid="strip-kpi-leave.out-today"]')).toContain("1");
    expect(text('[data-testid="strip-kpi-leave.pending"]')).toContain("Leave requests waiting");
    expect(text('[data-testid="md-leave-strip-insights"]')).toContain("1 leave request has waited 8 days");
  });
});
