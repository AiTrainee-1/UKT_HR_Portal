import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAssistant, getAssistantState } from "@/lib/md/assistant-store";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ toast, useToast: () => ({ toast }) }));

import { ME, overview, trends } from "../dashboard/fixtures";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import MdDashboardHome from "./index";

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
  closeAssistant();
  toast.mockClear();
});

const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const leave = (id: number, name: string, days: number, over: Record<string, unknown> = {}) => ({
  id,
  employeeId: id,
  employeeName: name,
  type: "casual",
  startDate: "2026-10-12",
  endDate: "2026-10-13",
  reason: "Family function",
  status: "pending",
  createdAt: daysAgo(days),
  ...over,
});

const data = (extra: Fixtures = {}): Fixtures => ({
  "/api/md/me": { ...ME, pages: [] },
  "/api/md/dashboard/overview": overview,
  "/api/md/dashboard/trends": trends,
  "/api/leave-requests": [
    leave(1, "Asha Kumar", 1),
    leave(2, "Ravi Nair", 5),
    leave(3, "Waits on the HOD first", 9, {
      approval: {
        workflow: "leave",
        label: "Leave",
        enabled: true,
        steps: [],
        currentStep: 0,
        waitingFor: ["hod"],
        canAct: { hr: false, hod: true },
        canReject: { hr: false, hod: true },
      },
    }),
    leave(4, "Already decided", 12, { status: "approved" }),
  ],
  "/api/permissions": [
    {
      id: 10,
      employeeId: 10,
      employeeName: "Meena Dev",
      employeeCode: "E10",
      date: "2026-10-09",
      permissionTime: "09:30",
      reason: "Doctor",
      status: "pending",
      typeKey: "late_in",
      createdAt: daysAgo(3),
    },
  ],
  "/api/outpass-requests": [],
  "/api/advances": [{ id: 1, status: "pending" }],
  "/api/recruitment/resignations": [{ id: 1, status: "pending" }],
  "/api/on-duty-sessions": [],
  "/api/on-duty-punch-verifications": [],
  ...extra,
});

const byTestId = (p: RenderedPage, id: string) => p.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const textOf = (p: RenderedPage, id: string) => byTestId(p, id)?.textContent ?? "";

describe("the MD's dashboard", () => {
  it("opens with the greeting, what wants the MD, an Ask bar, the pulse tiles and today by unit", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    expect(textOf(page, "md-page-title")).toBe("Dashboard");
    expect(textOf(page, "md-home-greeting")).toContain("Murugan");
    expect(textOf(page, "md-home-pulse")).toMatch(/4 requests waiting/);
    expect(textOf(page, "md-home-pulse")).toMatch(/thing/);
    expect(byTestId(page, "md-home-ask-input")).not.toBeNull();
    expect(page.container.querySelectorAll('[data-testid="md-home-suggestions"] button').length).toBe(4);
    expect(textOf(page, "kpi-employees.headcount-value")).toBe("1,240");
    expect(textOf(page, "kpi-attendance-today-value")).toBe("90.3%");
    expect(byTestId(page, "md-home-company-ring")).not.toBeNull();
    expect(page.text()).toContain("Today at the factory");
    expect(page.text()).toContain("Needs your attention");
  });

  it("lists every pending request, oldest first, and says who each is waiting for", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    const items = [...page.container.querySelectorAll<HTMLElement>('[data-testid^="md-request-"]')]
      .map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => !id.endsWith("-waiting-for"));
    // the HOD-first leave (9 days), Ravi's leave (5), Meena's permission (3), Asha's leave (1); not the decided one
    expect(items).toEqual([
      "md-request-leave-3",
      "md-request-leave-2",
      "md-request-permission-10",
      "md-request-leave-1",
    ]);
    expect(textOf(page, "md-home-requests-summary")).toContain("4");
    expect(textOf(page, "md-request-leave-3-waiting-for")).toBe("Waiting for Department Head");
    expect(textOf(page, "md-request-leave-2-waiting-for")).toBe("Waiting for HR");
    // the other kinds of waiting work are counted, with a way to their page
    expect(byTestId(page, "md-also-advances")?.getAttribute("href")).toBe("/md/requests");
    expect(byTestId(page, "md-also-resignations")?.getAttribute("href")).toBe("/md/recruitment");
    expect(byTestId(page, "md-home-open-requests")?.getAttribute("href")).toBe("/md/requests");
  });

  it("only shows the requests: there is no way to approve, reject or change one from here", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    const card = byTestId(page, "md-home-requests")!;
    expect(card.querySelectorAll('[data-testid^="md-approve-"], [data-testid^="md-reject-"]').length).toBe(0);
    const labels = [...card.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim().toLowerCase());
    expect(labels.filter((l) => /approve|reject|decline|accept/.test(l))).toEqual([]);
    expect(card.textContent).toContain("HR and the Department Heads decide");
  });

  it("opens the assistant with what is typed in the Ask bar, and with a suggestion", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    await page.type('[data-testid="md-home-ask-input"]', "why is absenteeism up?");
    await page.click('[data-testid="md-home-ask-send"]');
    await act(async () => {});
    expect(getAssistantState().open).toBe(true);
    expect(getAssistantState().prompt?.text).toBe("why is absenteeism up?");
    await page.click('[data-testid="md-home-suggestions"] button');
    expect(getAssistantState().prompt?.text).toBeTruthy();
  });

  it("shows what only the Admin may open, locked, and says so when one is pressed", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    for (const id of ["run-payroll", "salary-slips", "user-management", "account-management", "settings"]) {
      expect(byTestId(page, `md-admin-${id}`), id).not.toBeNull();
    }
    await page.click('[data-testid="md-admin-user-management"]');
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Available only to the Admin",
        description: expect.stringContaining("User Management"),
      }),
    );
  });

  it("never links into the HR portal: every link goes to a page of the MD portal", async () => {
    page = await renderMdPage(MdDashboardHome, data(), { path: "/md/dashboard" });
    const hrefs = [...page.container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(10);
    expect(hrefs.filter((h) => h.startsWith("/hr") || (h.startsWith("http") && !h.includes("localhost")))).toEqual([]);
    expect(hrefs.filter((h) => !h.startsWith("/md"))).toEqual([]);
  });

  it("says so, in place, when the requests cannot be read, and the rest of the page still works", async () => {
    page = await renderMdPage(
      MdDashboardHome,
      data({ "/api/leave-requests": { status: 400, body: { error: "no" } } }),
      { path: "/md/dashboard" },
    );
    expect(byTestId(page, "md-home-requests")).not.toBeNull();
    expect(textOf(page, "kpi-employees.headcount-value")).toBe("1,240");
  });
});
