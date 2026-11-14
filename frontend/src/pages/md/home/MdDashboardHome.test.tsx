import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAssistant, getAssistantState } from "@/lib/md/assistant-store";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ toast, useToast: () => ({ toast }) }));

import { ME, overview } from "../dashboard/fixtures";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import { HOME } from "./home-fixtures";
import MdDashboardHome from "./index";

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
  closeAssistant();
  toast.mockClear();
});

const pending = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  employeeId: id,
  status: "pending",
  ...over,
});

const data = (extra: Fixtures = {}): Fixtures => ({
  "/api/md/me": {
    ...ME,
    pages: [
      { id: "dashboard", title: "Dashboard", path: "/md/dashboard", summary: "This page" },
      { id: "payroll", title: "Payroll Analysis", path: "/md/payroll", summary: "Cost and what changed" },
      { id: "employees", title: "Employees", path: "/md/employees", summary: "The employee list" },
    ],
  },
  "/api/md/dashboard/overview": overview,
  "/api/md/dashboard/home": HOME,
  "/api/leave-requests": [pending(1), pending(2), pending(3, { status: "approved" })],
  "/api/permissions": [pending(10)],
  "/api/outpass-requests": [pending(20, { source: "manual" }), pending(21, { source: "gate" })],
  ...extra,
});

const byTestId = (p: RenderedPage, id: string) => p.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const textOf = (p: RenderedPage, id: string) => byTestId(p, id)?.textContent ?? "";
const valueOf = (p: RenderedPage, id: string) => byTestId(p, id)?.getAttribute("data-value");

describe("the MD's dashboard", () => {
  it("keeps the welcome card: the greeting, what is waiting, the Ask bar and four suggestions", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    expect(textOf(page, "md-home-greeting")).toContain("Murugan");
    expect(byTestId(page, "md-home-greeting")?.tagName).toBe("H1");
    // 2 leaves + 1 permission + 1 outpass somebody asked for (the gate's own one and the decided leave are not waiting)
    expect(textOf(page, "md-home-pulse")).toMatch(/4 requests waiting/);
    expect(byTestId(page, "md-home-ask-input")).not.toBeNull();
    expect(page.container.querySelectorAll('[data-testid="md-home-suggestions"] button').length).toBe(4);
  });

  it("shows the three overviews and Explore under it, in that order, and nothing of the old dashboard", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    const order = [
      "md-home-header",
      "md-home-employees",
      "md-home-attendance",
      "md-home-payroll",
      "md-dashboard-explore",
    ];
    const found = [...page.container.querySelectorAll<HTMLElement>("[data-testid]")]
      .map((el) => el.getAttribute("data-testid"))
      .filter((id): id is string => !!id && order.includes(id));
    expect(found).toEqual(order);
    for (const gone of ["md-dashboard-kpis", "md-home-units", "md-home-requests", "md-home-tools"]) {
      expect(byTestId(page, gone), gone).toBeNull();
    }
  });

  it("counts the employees: total, staff, production, and every unit's staff and production", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    expect(valueOf(page, "md-home-total-value")).toBe("256");
    expect(valueOf(page, "md-home-staff-value")).toBe("142");
    expect(valueOf(page, "md-home-production-value")).toBe("114");
    expect(textOf(page, "md-home-staff")).toContain("55.5% of all employees");
    const rows = [...byTestId(page, "md-home-units-table")!.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].slice(0, 4).map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ["Unit1", "11", "114", "125"],
      ["Head Office", "119", "0", "119"],
      ["No unit", "12", "0", "12"],
    ]);
    // men and women among staff, production and everyone (the space under the ring)
    // ...as three donuts: each says its split in words for a screen reader, and lists the counts under it
    const donut = (group: string) =>
      byTestId(page!, `md-home-gender-${group}`)?.querySelector('[role="img"]')?.getAttribute("aria-label");
    expect(donut("staff")).toBe("Staff: 123 men, 19 women");
    expect(donut("production")).toBe("Production: 46 men, 68 women");
    expect(donut("everyone")).toBe("Everyone: 169 men, 87 women");
    expect(textOf(page, "md-home-gender-staff")).toContain("123 86.6%");
    expect(textOf(page, "md-home-gender-production")).toContain("68 59.6%");
    expect(textOf(page, "md-home-gender")).not.toContain("Not recorded");
    // every unit's share of the company, and a total row that adds up
    expect(textOf(page, "md-home-units-table")).toContain("48.8%");
    const total = [...byTestId(page, "md-home-units-total")!.querySelectorAll("td")]
      .slice(0, 4)
      .map((td) => td.textContent);
    expect(total).toEqual(["All units", "142", "114", "256"]);
  });

  it("counts today: Present, Absent with the people on leave in it, and CL, for everyone, staff or production", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    expect(valueOf(page, "md-home-present-value")).toBe("82");
    expect(valueOf(page, "md-home-absent-value")).toBe("170");
    expect(valueOf(page, "md-home-cl-value")).toBe("4");
    expect(textOf(page, "md-home-absent")).toContain("Includes 6 on approved leave");
    expect(textOf(page, "md-home-attendance")).toContain("as of 5:26 pm");

    await page.click('[data-testid="md-home-att-view-production"]');
    expect(valueOf(page, "md-home-present-value")).toBe("0");
    expect(valueOf(page, "md-home-absent-value")).toBe("114");
    expect(valueOf(page, "md-home-cl-value")).toBe("0");
    expect(byTestId(page, "md-home-att-view-production")?.getAttribute("aria-checked")).toBe("true");
    expect(textOf(page, "md-home-att-units-list")).toContain("Unit1");
    expect(textOf(page, "md-home-att-units-list")).not.toContain("Head Office");
    expect(textOf(page, "md-home-att-units-total")).toContain("114");

    await page.click('[data-testid="md-home-att-view-all"]');
    // today by unit is a table with headings, on leave and the share present, and a total row
    const heads = [...byTestId(page, "md-home-att-units-list")!.querySelectorAll("thead th")].map(
      (th) => th.textContent,
    );
    expect(heads).toEqual(["Unit", "Due", "Present", "CL", "Absent", "On leave", "Present today"]);
    const hoRow = [...byTestId(page, "md-home-att-units-list")!.querySelectorAll("tbody tr")].find((tr) =>
      tr.textContent?.startsWith("Head Office"),
    )!;
    expect([...hoRow.querySelectorAll("td")].slice(0, 6).map((td) => td.textContent)).toEqual([
      "Head Office",
      "119",
      "78",
      "4",
      "37",
      "6",
    ]);
    expect(
      [...byTestId(page, "md-home-att-units-total")!.querySelectorAll("td")].slice(0, 6).map((td) => td.textContent),
    ).toEqual(["All units", "256", "82", "4", "170", "6"]);

    await page.click('[data-testid="md-home-att-view-staff"]');
    expect(valueOf(page, "md-home-present-value")).toBe("82");
    expect(valueOf(page, "md-home-cl-value")).toBe("4");
  });

  it("sets the current month beside the previous one, with the change, in gross or net", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    expect(textOf(page, "md-home-pay-current")).toContain("November 2026");
    expect(textOf(page, "md-home-pay-current")).toContain("In progress");
    expect(textOf(page, "md-home-pay-current")).toContain("still running");
    expect(valueOf(page, "md-home-pay-current-value")).toBe("951730.61");
    expect(textOf(page, "md-home-pay-previous")).toContain("October 2026");
    expect(valueOf(page, "md-home-pay-previous-value")).toBe("4528710.09");
    expect(textOf(page, "md-home-pay-change")).toContain("-79");

    await page.click('[data-testid="md-home-pay-measure-net"]');
    expect(valueOf(page, "md-home-pay-current-value")).toBe("945102");
    expect(valueOf(page, "md-home-pay-previous-value")).toBe("4509593.37");
  });

  it("says so in place when the figures cannot be read, and the welcome card still works", async () => {
    page = await renderMdPage(
      MdDashboardHome,
      data({ "/api/md/dashboard/home": { status: 400, body: { error: "x" } } }),
      {
        path: "/md/dashboard",
      },
    );
    expect(textOf(page, "md-home-employees")).toContain("could not be read");
    expect(textOf(page, "md-home-payroll")).toContain("Retry");
    expect(byTestId(page, "md-home-ask-input")).not.toBeNull();
  });

  it("opens the assistant with what is typed in the Ask bar", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    await page.type('[data-testid="md-home-ask-input"]', "why is absenteeism up?");
    await page.click('[data-testid="md-home-ask-send"]');
    await act(async () => {});
    expect(getAssistantState().open).toBe(true);
    expect(getAssistantState().prompt?.text).toBe("why is absenteeism up?");
  });

  it("never links into the HR portal: every link goes to a page of the MD portal", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    const hrefs = [...page.container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((h) => !h.startsWith("/md"))).toEqual([]);
  });
});
