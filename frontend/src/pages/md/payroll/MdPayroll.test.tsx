// The MD Payroll page (/md/payroll) as a whole: its title row, its three tabs, what it asks the server for, and what it
// tells the assistant. The tabs themselves are tested in payroll-dashboard/PayrollDashboard.test.tsx.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getAssistantState } from "@/lib/md/assistant-store";
import type { RenderedPage } from "../testing/renderMdPage";
import { by, lastRequest, openPayroll, quietCharts, textOf, url } from "../payroll-dashboard/testing";

beforeAll(quietCharts);
afterAll(() => vi.restoreAllMocks());

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const context = () => getAssistantState().context;

describe("Payroll page", () => {
  it("has the portal's title row and opens on the Monthly tab", async () => {
    page = await openPayroll();
    expect(textOf(page, "md-page-title")).toBe("Payroll");
    expect(textOf(page, "md-page-header")).toContain("What the company spends on salaries");
    expect(by(page, "md-live")).not.toBeNull();
    expect(by(page, "md-refresh")).not.toBeNull();
    expect(by(page, "md-payroll")?.dataset.view).toBe("monthly");
    expect(
      [...page.container.querySelectorAll('[data-testid="md-pay-tabs"] [role="tab"]')].map((t) => t.textContent),
    ).toEqual(["Monthly", "Departments", "Employees"]);
    expect(by(page, "md-pay-monthly")).not.toBeNull();
  });

  it("asks only the new payroll endpoints, and the unit and department list for the filters", async () => {
    page = await openPayroll();
    const payroll = page.requests().filter((r) => r.startsWith("/api/md/payroll/"));
    expect(payroll.every((r) => r.startsWith("/api/md/payroll/monthly"))).toBe(true);
    expect(page.requests().some((r) => r.startsWith("/api/md/org"))).toBe(true);
    // the other tabs ask nothing until they are opened
    expect(lastRequest(page, "department-breakdown")).toBeUndefined();
    expect(lastRequest(page, "people")).toBeUndefined();
  });

  it("opens a tab, a filter and an employee straight from a link", async () => {
    page = await openPayroll("/md/payroll?view=departments&month=2026-08&type=staff");
    expect(by(page, "md-pay-tab-departments")?.getAttribute("aria-selected")).toBe("true");
    const req = lastRequest(page, "department-breakdown")!;
    expect([req.get("month"), req.get("type")]).toEqual(["2026-08", "staff"]);
    page.unmount();

    page = await openPayroll("/md/payroll?employee=104");
    expect(by(page, "md-payroll")?.dataset.view).toBe("employee");
    expect(textOf(page, "md-pay-profile-name")).toBe("Deepak Kumar");
    expect(url(page)).toBe("/md/payroll?employee=104");
  });

  it("tells the assistant what the MD is looking at, view by view", async () => {
    page = await openPayroll();
    expect(context()).toMatchObject({
      page: "payroll",
      title: "Payroll",
      filters: { View: "Monthly", Month: "Oct 2026", Scope: "All units · all departments · staff and production" },
      summary: {
        "Company cost": "₹5.7 L",
        "Net paid": "₹4.9 L",
        "CL days": "5",
        "Payroll status": "Payment pending",
        "Company cost against the month before": "₹5.7 L (-2.9% on the month before)",
      },
    });

    await page.click('[data-testid="md-pay-tab-departments"]');
    expect(context()?.filters?.View).toBe("Departments");
    expect(context()?.summary).toMatchObject({ Departments: 5, "Largest department": "Cutting: ₹1.6 L (29.1%)" });

    await page.click('[data-testid="md-pay-tab-employees"]');
    expect(context()?.filters?.View).toBe("Employees");
    expect(context()?.summary).toMatchObject({ Employees: "29", "Net paid": "₹4.9 L" });

    await page.click('[data-testid="row-101"]');
    expect(context()?.filters).toMatchObject({
      View: "One employee's salary history",
      Employee: "Anitha Raman (STF001)",
    });
    expect(context()?.summary).toMatchObject({
      "Monthly salary today": "₹32,000",
      "Months of history": 14,
      "Casual leave": "3.5 days, ₹4,308",
    });
  });

  it("names the unit in the assistant's scope", async () => {
    page = await openPayroll("/md/payroll?branch=2&type=staff");
    expect(context()?.filters?.Scope).toBe("Head Office · all departments · staff only");
  });

  it("clears what it told the assistant when the MD leaves", async () => {
    page = await openPayroll();
    expect(context()).not.toBeNull();
    page.unmount();
    page = undefined;
    expect(context()).toBeNull();
  });
});
