import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import MdPayroll from "../MdPayroll";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import {
  EMPTY_FIXTURES,
  EXCEPTION_ROWS,
  FIXTURES,
  exceptionsFixture,
  noAttentionFixture,
  noBridgeFixture,
  noExceptionsFixture,
  noPayrollSummary,
  statusFixture,
  summaryFixture,
} from "./fixtures";
import type { PayrollStatus } from "./types";

// jsdom has no layout, so recharts' ResponsiveContainer measures 0 x 0 and says so on every chart: that is not news here
// (charts.test.tsx renders the charts at a real size). Every other warning still gets through.
beforeAll(() => {
  const quiet =
    (original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      if (!String(args[0]).includes("of chart should be greater than 0")) original(...args);
    };
  vi.spyOn(console, "warn").mockImplementation(quiet(console.warn.bind(console)));
  vi.spyOn(console, "error").mockImplementation(quiet(console.error.bind(console)));
});
afterAll(() => vi.restoreAllMocks());

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = (over: Fixtures = {}) => renderMdPage(MdPayroll, { ...FIXTURES, ...over }, { path: "/md/payroll" });

const by = (testId: string) => page!.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const textOf = (testId: string) => by(testId)?.textContent ?? "";
const requestsTo = (endpoint: string) => page!.requests().filter((r) => r.startsWith(`/api/md/payroll/${endpoint}`));

/** Click a pill tab by its text (they are role=tab buttons without an id). */
async function clickTab(label: string) {
  const tab = [...page!.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
    t.textContent?.includes(label),
  );
  if (!tab) throw new Error(`no tab "${label}"`);
  tab.setAttribute("data-click-target", "1");
  await page!.click('[data-click-target="1"]');
  tab.removeAttribute("data-click-target");
}

describe("Payroll Analysis page", () => {
  it("opens on the latest closed month and says where it stands", async () => {
    page = await open();
    expect(page.text()).toContain("Payroll Analysis");
    expect(textOf("md-payroll-status-month")).toBe("Sep 2026");
    expect(textOf("md-payroll-status-banner")).toContain("Part paid");
    expect(textOf("md-payroll-status-detail")).toBe("6 of 8 slips are not marked paid (₹63,145 net pay).");
    // no month is sent: the server picks the latest closed one, and the page shows which it chose
    expect(requestsTo("summary")[0]).not.toContain("month=");
  });

  it("shows the headline figures, each against last month", async () => {
    page = await open();
    expect(textOf("md-payroll-kpi-gross-value")).toBe("₹1.1 L");
    expect(textOf("md-payroll-kpi-gross")).toContain("includes ₹1,000 overtime");
    expect(textOf("md-payroll-kpi-gross")).toContain("-17.8%");
    expect(textOf("md-payroll-kpi-deductions-value")).toBe("₹2,195");
    expect(textOf("md-payroll-kpi-people-value")).toBe("7");
    expect(textOf("md-payroll-kpi-people")).toContain("5 staff · 2 production");
    expect(textOf("md-payroll-kpi-per-head-value")).toBe("₹15,798");
    expect(textOf("md-payroll-kpi-overtime-value")).toBe("₹1,000");
    expect(textOf("md-payroll-kpi-overtime")).toContain("0.9% of gross pay");
    expect(textOf("md-payroll-kpi-payable-value")).toBe("₹63,145");
    expect(textOf("md-payroll-kpi-payable")).toContain("6 of 8 slips not marked paid");
    // cost falling is good news: green chip on the gross pay card
    expect(by("md-payroll-kpi-gross")!.querySelector(".bg-green-100")).not.toBeNull();
  });

  it("puts what needs attention first, most serious first", async () => {
    page = await open();
    const items = [...page.container.querySelectorAll('[data-testid="md-payroll-attention"] [data-severity]')];
    expect(items.map((i) => i.getAttribute("data-severity"))).toEqual(["warning", "warning", "good"]);
    expect(textOf("md-payroll-attention")).toContain("6 of 8 slips for Sep 2026 are not marked paid");
    expect(textOf("md-payroll-attention")).toContain("Mainly left payroll (-₹40,000)");
    expect(textOf("md-payroll-attention")).not.toContain("Payroll Analysis"); // no link to the page it is on
  });

  it("explains the change as steps with their exact amounts, and the steps add up", async () => {
    page = await open();
    expect(textOf("md-payroll-bridge-headline")).toBe(
      "Gross pay fell by ₹23,912.31 (17.8%) from Aug 2026 to Sep 2026. The biggest step is left payroll (-₹40,000.00).",
    );
    expect(textOf("md-payroll-bridge-amount-joined")).toBe("+₹15,000.00");
    expect(textOf("md-payroll-bridge-amount-left")).toBe("-₹40,000.00");
    expect(textOf("md-payroll-bridge-amount-rate")).toBe("+₹2,480.00");
    expect(textOf("md-payroll-bridge-amount-overtime")).toBe("+₹1,000.00");
    expect(textOf("md-payroll-bridge-amount-attendance")).toBe("-₹1,392.31");
    expect(textOf("md-payroll-bridge-amount-oneoffs")).toBe("₹0.00");
    expect(textOf("md-payroll-bridge-amount-other")).toBe("-₹1,000.00");
    expect(textOf("md-payroll-bridge-total")).toBe("-₹23,912.31");
    expect(textOf("md-payroll-bridge-step-attendance")).toContain("3 people");
    expect(textOf("md-payroll-bridge-step-joined")).toContain("1 person");
    expect(by("md-payroll-bridge-reconciles")).not.toBeNull();
    expect(by("md-payroll-waterfall-chart")).not.toBeNull();
    expect(by("md-payroll-waterfall-axis-note")?.textContent).toContain("not zero");
    expect(textOf("md-payroll-bridge")).toContain("have no saved calculation breakdown"); // the data note is shown, not hidden
  });

  it("warns when a whole kind of payroll has not been generated, so the cost is not mistaken for a saving", async () => {
    const note =
      "No production slips exist for Sep 2026, although Aug 2026 had 2 people on production payroll (₹20,500): that payroll has probably not been generated yet, so the cost is understated.";
    page = await open({
      "/api/md/payroll/summary": {
        ...summaryFixture,
        typeGaps: [{ type: "production", headcount: 2, grossPay: 20500 }],
        notes: [note],
      },
    });
    const banners = [...page.container.querySelectorAll('[data-testid="md-note"]')].map((n) => n.textContent);
    expect(banners.some((b) => b?.includes("No production slips exist for Sep 2026"))).toBe(true);
  });

  it("says plainly when there is nothing to compare", async () => {
    page = await open({ "/api/md/payroll/bridge": noBridgeFixture });
    expect(by("md-payroll-bridge-unavailable")).not.toBeNull();
    expect(textOf("md-payroll-bridge-unavailable")).toContain("no payroll for Jul 2026");
    expect(by("md-payroll-bridge-steps")).toBeNull();
  });

  it("ranks departments, and switches to units and staff vs production", async () => {
    page = await open();
    const table = textOf("md-payroll-dept-table");
    expect(table).toContain("Stitching");
    expect(table).toContain("Unit 1");
    expect(table).toContain("₹59,788");
    expect(table).toContain("₹19,929"); // per head
    expect(textOf("md-payroll-dept-bars")).toContain("3 people · ₹19,929 per head");
    expect(table).toContain("-52%"); // Accounts against last month
    await clickTab("Units");
    expect(textOf("md-payroll-dept-table")).toContain("Unit 2");
    await clickTab("Staff vs production");
    expect(textOf("md-payroll-dept-table")).toContain("Production");
    expect(textOf("md-payroll-dept-table")).toContain("—"); // production has no loss-of-pay days: a dash, not 0
  });

  it("breaks the money into earnings and deductions with last month beside them", async () => {
    page = await open();
    expect(textOf("md-payroll-components-earnings-basic")).toContain("₹69,934");
    expect(textOf("md-payroll-components-earnings-overtime")).toContain("₹1,000");
    expect(textOf("md-payroll-components-deductions-pf")).toContain("₹1,560");
    expect(textOf("md-payroll-components-deductions-advance")).toContain("-100%");
    expect(textOf("md-payroll-components-net")).toContain("₹1,08,393");
    expect(textOf("md-payroll-components-payable")).toContain("₹63,145");
    expect(textOf("md-payroll-components-bonus")).toContain("₹8,000 not yet marked paid");
    expect(textOf("md-payroll-components")).toContain("Income tax (TDS) and arrears are not recorded");
  });

  it("shows how pay is spread without naming anyone", async () => {
    page = await open();
    expect(textOf("md-payroll-distribution-stats")).toContain("₹15,000");
    expect(by("md-payroll-distribution-chart")).not.toBeNull();
    expect(textOf("md-payroll-designation-bars")).toContain("Operator");
    expect(textOf("md-payroll-distribution")).not.toContain("Kala");
    await clickTab("Production");
    expect(by("md-payroll-distribution-chart")).not.toBeNull();
  });

  it("shows advances outstanding, their ageing and what the notes say", async () => {
    page = await open();
    expect(textOf("md-payroll-advances-outstanding")).toContain("₹30,000");
    expect(textOf("md-payroll-advances-outstanding")).toContain("3 advances · 3 people");
    expect(textOf("md-payroll-advances-net")).toContain("+₹7,000");
    expect(textOf("md-payroll-advances-overdue")).toContain("₹18,000");
    expect(textOf("md-payroll-advances-left")).toContain("1 person: recover in final settlement");
    expect(textOf("md-payroll-advances-ageing")).toContain("Over a year");
    expect(textOf("md-payroll-advances")).toContain("payroll was probably regenerated");
  });

  it("lists the exceptions with who and why, and grows ten at a time", async () => {
    const fourteen = [
      ...EXCEPTION_ROWS,
      ...EXCEPTION_ROWS.slice(0, 4).map((r) => ({ ...r, employeeId: r.employeeId + 100 })),
    ];
    page = await open({
      "/api/md/payroll/exceptions": (p: URLSearchParams) =>
        exceptionsFixture(Number(p.get("limit")), p.get("kind"), fourteen),
    });
    expect(requestsTo("exceptions")[0]).toContain("limit=10");
    expect(textOf("md-payroll-exceptions-count")).toBe("Showing 10 of 14");
    const first = page.container.querySelector('[data-testid="md-payroll-exception-negative-net"]')!.textContent!;
    expect(first).toContain("Kala Test");
    expect(first).toContain("K8");
    expect(first).toContain("Deductions of ₹15,000.00 exceed gross pay of ₹12,000.00.");
    expect(first).toContain("-₹3,000"); // negative net pay is shown, in red
    await page.click('[data-testid="md-payroll-exceptions-more"]');
    expect(requestsTo("exceptions").some((r) => r.includes("limit=14"))).toBe(true);
    expect(textOf("md-payroll-exceptions-count")).toBe("Showing 14 of 14");
    expect(by("md-payroll-exceptions-more")).toBeNull();
  });

  it("filters the exceptions by kind", async () => {
    page = await open();
    await clickTab("Large change on last month");
    expect(requestsTo("exceptions").some((r) => r.includes("kind=pay-swing"))).toBe(true);
    expect(textOf("md-payroll-exceptions-count")).toBe("Showing 4 of 4");
  });

  it("says so when the month has no exceptions", async () => {
    page = await open({
      "/api/md/payroll/exceptions": noExceptionsFixture,
      "/api/md/payroll/attention": noAttentionFixture,
    });
    expect(textOf("md-payroll-exceptions-none")).toContain("No exceptions found");
    expect(by("insights-empty")).not.toBeNull();
  });

  it("opens another month from the status strip", async () => {
    const august = { ...summaryFixture, month: "2026-08", monthLabel: "Aug 2026", status: statusFixture.months[9] };
    page = await open({
      "/api/md/payroll/summary": (p: URLSearchParams) => (p.get("month") === "2026-08" ? august : summaryFixture),
    });
    expect(by("md-payroll-status-2026-09")!.getAttribute("aria-current")).toBe("date");
    await page.click('[data-testid="md-payroll-status-2026-08"]');
    expect(requestsTo("summary").some((r) => r.includes("month=2026-08"))).toBe(true);
    expect(requestsTo("bridge").some((r) => r.includes("month=2026-08"))).toBe(true);
    expect(textOf("md-payroll-status-month")).toBe("Aug 2026");
    expect(textOf("md-payroll-status-banner")).toContain("Paid");
  });

  it("shows one chip per month with its state, and leaves months without payroll unclickable", async () => {
    page = await open();
    const chips = page.container.querySelectorAll('[data-testid="md-payroll-status-chips"] button');
    expect(chips).toHaveLength(12);
    expect(by("md-payroll-status-2026-09")!.getAttribute("data-state")).toBe("part_paid");
    expect(textOf("md-payroll-status-2026-09")).toContain("₹63,145 unpaid");
    expect(textOf("md-payroll-status-2026-09")).toContain("1 provisional");
    expect((by("md-payroll-status-2026-07") as HTMLButtonElement).disabled).toBe(true);
    expect((by("md-payroll-status-2026-10") as HTMLButtonElement).disabled).toBe(true); // this month: nothing generated yet
  });

  it("explains a month with no payroll instead of showing zeros, and finds the way back", async () => {
    const missing: PayrollStatus = {
      ...statusFixture,
      months: statusFixture.months.map((m) => (m.month === "2026-10" ? { ...m, state: "not_generated" as const } : m)),
    };
    page = await open({
      "/api/md/payroll/status": missing,
      "/api/md/payroll/summary": (p: URLSearchParams) =>
        p.get("month") === "2026-10" ? noPayrollSummary("2026-10", "Oct 2026") : summaryFixture,
    });
    await page.click('[data-testid="md-payroll-status-2026-10"]');
    expect(textOf("md-payroll-month-empty")).toContain("No payroll for Oct 2026");
    expect(textOf("md-payroll-month-empty")).toContain("payroll has not been generated for it");
    expect(by("md-payroll-kpis")).toBeNull(); // no strip of zeros
    expect(textOf("md-payroll-status-banner")).toContain("Not generated");
    await page.click('[data-testid="md-payroll-go-latest"]');
    expect(textOf("md-payroll-status-month")).toBe("Sep 2026");
    expect(by("md-payroll-kpis")).not.toBeNull();
  });

  it("shows a clear 'no payroll processed yet' for a company with no slips", async () => {
    page = await open(EMPTY_FIXTURES);
    expect(textOf("md-payroll-empty")).toContain("No payroll has been processed yet");
    expect(by("md-payroll-kpis")).toBeNull();
    expect(by("md-payroll-bridge")).toBeNull();
    expect(page.text()).not.toContain("₹0");
  });

  it("keeps working when one card's data fails, and says which", async () => {
    page = await open({ "/api/md/payroll/advances": { status: 400, body: { error: "advances could not be read" } } });
    expect(textOf("md-payroll-advances")).toContain("This could not be loaded.");
    expect(textOf("md-payroll-advances")).toContain("advances could not be read");
    expect(textOf("md-payroll-bridge-total")).toBe("-₹23,912.31"); // the rest of the page is untouched
    expect(textOf("md-payroll-kpi-gross-value")).toBe("₹1.1 L");
  });

  it("shows an error with a retry when the month's summary fails", async () => {
    page = await open({ "/api/md/payroll/summary": { status: 400, body: { error: "'abc' is not a month" } } });
    expect(page.container.querySelector('[data-testid="md-error"]')?.textContent).toContain("'abc' is not a month");
  });

  it("gives every card an Ask AI with a specific question and a way to see how it is calculated", async () => {
    page = await open();
    const questions = [...page.container.querySelectorAll('[data-testid="ask-ai"]')].map((b) =>
      b.getAttribute("title"),
    );
    expect(questions).toContain("Why did payroll fall in Sep 2026 compared with Aug 2026?");
    expect(questions).toContain("What needs my attention in payroll for Sep 2026?");
    expect(questions).toContain("How has payroll cost moved over the last 12 months, and is overtime rising?");
    expect(questions).toContain("Explain the payroll exceptions in Sep 2026 and who is involved.");
    for (const card of [
      "attention",
      "trend",
      "bridge",
      "departments",
      "distribution",
      "components",
      "advances",
      "exceptions",
      "status-strip",
    ]) {
      const section = by(`md-payroll-${card}`)!;
      expect(section.querySelector('[data-testid="ask-ai"]'), `Ask AI on ${card}`).not.toBeNull();
      expect(section.querySelector('[data-testid="provenance-button"]'), `provenance on ${card}`).not.toBeNull();
    }
    for (const kpi of ["gross", "net", "deductions", "employer", "people", "per-head", "overtime", "payable"]) {
      expect(by(`md-payroll-kpi-${kpi}`)!.querySelector('[data-testid="provenance-button"]'), kpi).not.toBeNull();
    }
  });

  it("opens the explanation of the bridge", async () => {
    page = await open();
    await page.click('[data-testid="md-payroll-bridge"] [data-testid="provenance-button"]');
    const popover = document.body.textContent ?? "";
    expect(popover).toContain("How is this calculated?");
    expect(popover).toContain("Cost bridge");
  });

  it("tells the assistant what is on screen", async () => {
    page = await open();
    const context = getAssistantState().context;
    expect(context?.page).toBe("payroll");
    expect(context?.title).toBe("Payroll Analysis");
    expect(context?.filters).toMatchObject({ Month: "Sep 2026", "Payroll status": "Part paid" });
    expect(context?.summary).toMatchObject({ "Gross pay": "₹1.1 L", "People paid": "7", "Cost per head": "₹15,798" });
    page.unmount();
    page = undefined;
    expect(getAssistantState().context).toBeNull();
  });

  it("asks every endpoint of the page, with no unit or department filter when everyone is selected", async () => {
    page = await open();
    const all = page.requests();
    for (const endpoint of [
      "summary",
      "attention",
      "trend",
      "bridge",
      "departments",
      "components",
      "distribution",
      "advances",
      "exceptions",
      "status",
    ]) {
      expect(requestsTo(endpoint).length, endpoint).toBeGreaterThan(0);
    }
    expect(all.filter((r) => r.startsWith("/api/md/payroll")).every((r) => !r.includes("branch="))).toBe(true); // everyone
  });
});
