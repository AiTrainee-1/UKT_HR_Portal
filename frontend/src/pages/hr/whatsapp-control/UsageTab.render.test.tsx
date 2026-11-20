import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMdPage, type Fixtures, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import WhatsAppControl from "../WhatsAppControl";
import { monthLabel, monthOf, shiftMonth } from "./logic";
import { ADMIN, pageFixtures, usageFixture } from "./test-fixtures";

// Usage & Cost: one month at a time, this month first: the cost so far and the projected month with and without GST
// against the budget, messages per day by Meta pricing category (also as a table for a screen reader), the category and
// message-type breakdowns with the rates used, and Meta's own figures when Meta answered.

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const current = monthOf(new Date());

const open = async (extra: Fixtures = {}) => {
  page = await renderMdPage(
    WhatsAppControl,
    { ...pageFixtures(), "/api/auth/me": ADMIN, ...extra },
    { path: "/hr/whatsapp-control?tab=usage" },
  );
  return page;
};

const el = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const usageCalls = () => page!.requests().filter((r) => r.startsWith("/api/whatsapp-control/usage"));

describe("Usage & Cost", () => {
  it("asks for this month and shows the cost so far and the projection, with and without GST, against the budget", async () => {
    await open();
    expect(usageCalls()).toEqual([`/api/whatsapp-control/usage?month=${current}`]);
    expect(el('[data-testid="wa-usage-month"]')!.textContent).toContain(monthLabel(current));
    expect(el('[data-testid="wa-usage-next"]')!.hasAttribute("disabled")).toBe(true);
    const soFar = el('[data-testid="wa-usage-so-far"]')!.textContent!;
    expect(soFar).toContain("Cost so far");
    expect(soFar).toContain("₹5.29");
    expect(soFar).toContain("₹6.24 with 18% GST");
    const projected = el('[data-testid="wa-usage-projected"]')!.textContent!;
    expect(projected).toContain("Projected month");
    expect(projected).toContain("₹79.35");
    expect(projected).toContain("₹93.63 with 18% GST");
    expect(el('[data-testid="wa-usage-budget"]')!.textContent).toContain("8.8%");
    expect(el('[data-testid="wa-usage-billable"]')!.textContent).toContain("46");
  });

  it("breaks the month down by pricing category with the rate used, and by message type, costliest first", async () => {
    await open();
    const utility = el('[data-testid="wa-usage-cat-utility"]')!.textContent!;
    expect(utility).toContain("Utility");
    expect(utility).toContain("34");
    expect(utility).toContain("₹0.115");
    expect(utility).toContain("₹3.45");
    expect(el('[data-testid="wa-usage-cat-marketing"]')!.textContent).toContain("₹0.8631");
    const total = el('[data-testid="wa-usage-cat-total"]')!.textContent!;
    expect(total).toContain("50");
    expect(total).toContain("₹5.29");
    const types = Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid^="wa-usage-type-"]')).map(
      (r) => r.dataset.testid,
    );
    expect(types).toEqual(["wa-usage-type-salary_slip", "wa-usage-type-otp_login", "wa-usage-type-late_alert"]);
    expect(el('[data-testid="wa-usage-note"]')!.textContent).toContain("Utility ₹0.115");
  });

  it("draws the days by category, with the same numbers as a table, and a legend", async () => {
    await open();
    const firstRow = el('[data-testid="wa-usage-table"] tbody tr')!;
    expect(Array.from(firstRow.querySelectorAll("td")).map((td) => td.textContent)).toEqual([
      `${current}-01`,
      "6",
      "14",
      "0",
      "0",
      "1",
    ]);
    expect(el('[data-testid="wa-usage-legend"]')!.textContent).toBe("AuthenticationUtilityMarketingService");
  });

  it("says when Meta's own figures are unavailable, and compares them with the estimate when they are there", async () => {
    await open();
    expect(el('[data-testid="wa-usage-meta-unavailable"]')!.textContent).toContain(
      "Meta's pricing analytics did not answer",
    );
    page!.unmount();
    const withMeta = usageFixture(current);
    withMeta.meta = {
      available: true,
      cost: 5.4,
      volume: 46,
      lastSyncedAt: "2026-11-20T08:00:00+05:30",
      error: null,
    } as never;
    await open({ "/api/whatsapp-control/usage": withMeta });
    expect(el('[data-testid="wa-usage-meta-cost"]')!.textContent).toBe("₹5.40");
    expect(el('[data-testid="wa-usage-meta"]')!.textContent).toContain("₹0.11 more than the estimate");
  });

  it("goes back a month, labels it as a finished month, and comes back to this month", async () => {
    await open({
      "/api/whatsapp-control/usage": (params) => {
        const month = params.get("month") ?? current;
        const u = usageFixture(month);
        u.cost.isCurrentMonth = month === current;
        return u;
      },
    });
    await page!.click('[data-testid="wa-usage-prev"]');
    const previous = shiftMonth(current, -1);
    expect(usageCalls()).toContain(`/api/whatsapp-control/usage?month=${previous}`);
    expect(el('[data-testid="wa-usage-month"]')!.textContent).toContain(monthLabel(previous));
    expect(el('[data-testid="wa-usage-so-far"]')!.textContent).toContain("Month's cost");
    expect(el('[data-testid="wa-usage-projected"]')!.textContent).toContain("Month total");
    expect(el('[data-testid="wa-usage-next"]')!.hasAttribute("disabled")).toBe(false);
    const thisMonth = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "This month")!;
    expect(thisMonth).toBeTruthy();
  });

  it("shows an error when the usage can't be read", async () => {
    await open({ "/api/whatsapp-control/usage": { status: 500, body: { error: "Usage is not ready" } } });
    expect(el('[data-testid="wa-usage-error"]')!.textContent).toContain("Usage is not ready");
  });
});
