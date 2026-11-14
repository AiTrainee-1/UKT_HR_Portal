import { afterEach, describe, expect, it, vi } from "vitest";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ toast, useToast: () => ({ toast }) }));

import MdLayout from "@/components/md/MdLayout";
import { HODS, PENDING, hod, item } from "./approvals/fixtures";
import type { HodRequestsResponse } from "./approvals/types";
import MdApprovals from "./MdApprovals";
import { renderMdPage, type Fixtures, type RenderedPage } from "./testing/renderMdPage";

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
  toast.mockClear();
  localStorage.removeItem("md-nav-hods-open");
});

/** Any other MD page: only the shell (and so the sidebar) matters here. */
function OtherPage() {
  return (
    <MdLayout>
      <p>Another page</p>
    </MdLayout>
  );
}

const byTestId = (p: RenderedPage, id: string) => p.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (p: RenderedPage, selector: string) => [...p.container.querySelectorAll<HTMLElement>(selector)];

const RAVI_EMPTY: HodRequestsResponse = {
  hod: HODS.hods[1],
  status: "pending",
  items: [],
  counts: { leave: 0, permission: 0, other: 0, total: 0 },
};

function data(extra: Fixtures = {}): Fixtures {
  return {
    "/api/md/approvals/hods": HODS,
    "/api/md/approvals/hods/5": (params) => ({ ...PENDING, status: params.get("status") ?? "pending" }),
    "/api/md/approvals/hods/8": RAVI_EMPTY,
    ...extra,
  };
}

describe("HOD Approvals", () => {
  it("shows the first Department Head with what waits for them, and no row of head tabs (the sidebar picks the head)", async () => {
    page = await renderMdPage(MdApprovals, data(), { path: "/md/approvals" });
    const main = byTestId(page, "md-approvals-page")!;
    expect(main.querySelectorAll('[role="tab"], [role="tablist"]')).toHaveLength(0);
    expect(byTestId(page, "md-approvals-panel")?.getAttribute("data-hod")).toBe("5");
    expect(byTestId(page, "md-approvals-panel")?.getAttribute("aria-label")).toBe("HOD – Sandhya Krishnan");
    expect(byTestId(page, "md-approvals-hod-waiting")?.textContent).toBe("3");
    expect(all(page, '[data-testid="md-approvals-list"] > li')).toHaveLength(3);
  });

  it("starts another head (picked in the sidebar) on every type of request again", async () => {
    page = await renderMdPage(MdApprovals, data(), { path: "/md/approvals/5" });
    await page.click('[data-testid="md-approvals-group-permission"]');
    expect(all(page, '[data-testid="md-approvals-list"] > li')).toHaveLength(1);
    await page.click('[data-testid="md-nav-approvals-hods"] a[href="/md/approvals/8"]');
    expect(byTestId(page, "md-approvals-panel")?.getAttribute("data-hod")).toBe("8");
    expect(byTestId(page, "md-approvals-group-all")?.getAttribute("aria-checked")).toBe("true");
  });

  it("shows the sidebar's sub-menu with the heads, each with their count, linking to their pages", async () => {
    page = await renderMdPage(MdApprovals, data(), { path: "/md/approvals/8" });
    const links = all(page, '[data-testid="md-nav-approvals-hods"] a');
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/md/approvals/5", "/md/approvals/8"]);
    // every head shows how many requests wait for them, a 0 too
    expect(links.map((a) => a.textContent)).toEqual(["HOD – Sandhya Krishnan3", "HOD – Ravi Kumar0"]);
    expect(links[1].querySelector(".md-shell-count-zero")?.textContent).toBe("0");
    expect(links[1].getAttribute("aria-current")).toBe("location");
    // the address picked Ravi, whose list is empty, and his switched-off kind is explained
    expect(byTestId(page, "md-approvals-panel")?.getAttribute("data-hod")).toBe("8");
    expect(page.text()).toContain("Nothing is waiting for this Department Head right now.");
    expect(byTestId(page, "md-approvals-rights-off")?.textContent).toContain("missing punch");
  });

  it("shows the heads in the sidebar on this page and hides them elsewhere; the row carries the total", async () => {
    page = await renderMdPage(MdApprovals, data(), { path: "/md/approvals" });
    const row = () => byTestId(page!, "md-nav-approvals");
    const group = () => byTestId(page!, "md-nav-approvals-group");
    expect(row()?.tagName).toBe("BUTTON");
    expect(row()?.getAttribute("aria-expanded")).toBe("true");
    expect(group()?.getAttribute("data-open")).toBe("true");
    expect(byTestId(page, "md-nav-approvals-waiting")?.textContent).toBe("3");
    page.unmount();

    page = await renderMdPage(OtherPage, data(), { path: "/md/employees" });
    expect(row()?.getAttribute("aria-expanded")).toBe("false");
    expect(group()?.getAttribute("data-open")).toBe("false");
    expect(byTestId(page, "md-nav-approvals-waiting")?.textContent).toBe("3");
  });

  it("opens and closes the heads from the row, like the HR portal's groups, and remembers the choice", async () => {
    page = await renderMdPage(OtherPage, data(), { path: "/md/employees" });
    await page.click('[data-testid="md-nav-approvals"]');
    expect(byTestId(page, "md-nav-approvals-group")?.getAttribute("data-open")).toBe("true");
    expect(byTestId(page, "md-nav-approvals-chevron")?.getAttribute("class")).toContain("rotate-90");
    expect(page.text()).toContain("Another page"); // the row only opens the list; the page stays where it was
    page.unmount();
    // another page mounts a new sidebar: still open
    page = await renderMdPage(OtherPage, data(), { path: "/md/branches" });
    expect(byTestId(page, "md-nav-approvals-group")?.getAttribute("data-open")).toBe("true");
    // closed on the HOD Approvals page itself, it stays closed there too
    page.unmount();
    page = await renderMdPage(MdApprovals, data(), { path: "/md/approvals" });
    await page.click('[data-testid="md-nav-approvals"]');
    expect(byTestId(page, "md-nav-approvals-group")?.getAttribute("data-open")).toBe("false");
    expect(byTestId(page, "md-nav-approvals-chevron")?.getAttribute("class")).not.toContain("rotate-90");
    page.unmount();
    page = await renderMdPage(MdApprovals, data(), { path: "/md/approvals/8" });
    expect(byTestId(page, "md-nav-approvals-group")?.getAttribute("data-open")).toBe("false");
  });

  it("is a plain link to the page while the MD department has no head", async () => {
    page = await renderMdPage(OtherPage, data({ "/api/md/approvals/hods": { hods: [], mdDepartments: [] } }), {
      path: "/md/employees",
    });
    expect(byTestId(page, "md-nav-approvals")?.getAttribute("href")).toBe("/md/approvals");
    expect(byTestId(page, "md-nav-approvals-chevron")).toBeNull();
    expect(byTestId(page, "md-nav-approvals-group")).toBeNull();
  });

  it("shows 10 requests a page and the rest through the pages", async () => {
    const many = Array.from({ length: 23 }, (_, i) =>
      item({ key: `leave-${i + 1}`, id: i + 1, group: i < 20 ? "leave" : "other" }),
    );
    const body = { ...PENDING, items: many, counts: { leave: 20, permission: 0, other: 3, total: 23 } };
    page = await renderMdPage(MdApprovals, data({ "/api/md/approvals/hods/5": body }), { path: "/md/approvals/5" });
    const rows = () => all(page!, '[data-testid="md-approvals-list"] > li');
    const range = () => byTestId(page!, "md-approvals-pagination")?.querySelector("p")?.textContent;
    expect(rows()).toHaveLength(10);
    expect(range()).toBe("Showing 1–10 of 23");
    expect(byTestId(page, "md-approvals-page-prev")?.hasAttribute("disabled")).toBe(true);
    await page.click('[data-testid="md-approvals-page-3"]');
    expect(rows()).toHaveLength(3);
    expect(range()).toBe("Showing 21–23 of 23");
    expect(byTestId(page, "md-approvals-page-3")?.getAttribute("aria-current")).toBe("page");
    expect(byTestId(page, "md-approvals-page-next")?.hasAttribute("disabled")).toBe(true);
    await page.click('[data-testid="md-approvals-page-prev"]');
    expect(range()).toBe("Showing 11–20 of 23");
    // another type starts again at page 1
    await page.click('[data-testid="md-approvals-group-leave"]');
    expect(range()).toBe("Showing 1–10 of 20");
    await page.click('[data-testid="md-approvals-group-other"]');
    expect(rows()).toHaveLength(3);
    expect(byTestId(page, "md-approvals-page-prev")).toBeNull(); // one page: no page buttons
  });

  it("filters by type, and asks the server for the history when the status changes", async () => {
    page = await renderMdPage(MdApprovals, data(), { path: "/md/approvals/5" });
    await page.click('[data-testid="md-approvals-group-permission"]');
    expect(all(page, '[data-testid="md-approvals-list"] > li')).toHaveLength(1);
    expect(byTestId(page, "md-approval-permission-48")).not.toBeNull();
    await page.click('[data-testid="md-approvals-status-approved"]');
    expect(page.requests()).toContain("/api/md/approvals/hods/5?status=approved");
  });

  it("approves after a confirm step, sending the kind, id, decision and comment", async () => {
    const posted: unknown[] = [];
    page = await renderMdPage(
      MdApprovals,
      data({
        "/api/md/approvals/hods/5/decide": (_params, init) => {
          posted.push(JSON.parse(String(init?.body)));
          return {
            decision: "approved",
            actor: "Test MD (MD, for Sandhya Krishnan)",
            item: item({ state: "pending", statusLabel: "Waiting for HR", canApprove: false, canReject: false }),
          };
        },
      }),
      { path: "/md/approvals/5" },
    );
    const card = '[data-testid="md-approval-leave-14"]';
    await page.click(`${card} [data-testid="md-approval-approve"]`);
    expect(byTestId(page, "md-approval-confirm")?.textContent).toContain("for Sandhya Krishnan");
    await page.type(`${card} [data-testid="md-approval-comment"]`, "Get well soon");
    await page.click(`${card} [data-testid="md-approval-send"]`);
    expect(posted).toEqual([{ kind: "leave", id: 14, decision: "approved", comment: "Get well soon" }]);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Approved: Surya M's leave",
        description: "Recorded as Test MD (MD, for Sandhya Krishnan). It now waits for HR.",
      }),
    );
  });

  it("keeps the confirm step open with the server's reason when a decision is refused", async () => {
    page = await renderMdPage(
      MdApprovals,
      data({
        "/api/md/approvals/hods/5/decide": {
          status: 403,
          body: {
            error: "Sandhya Krishnan's 'approve leave' right is switched off in User Management.",
            code: "hod_right_off",
          },
        },
      }),
      { path: "/md/approvals/5" },
    );
    const card = '[data-testid="md-approval-leave-14"]';
    await page.click(`${card} [data-testid="md-approval-reject"]`);
    await page.click(`${card} [data-testid="md-approval-send"]`);
    expect(byTestId(page, "md-approval-error")?.textContent).toContain("switched off in User Management");
    expect(byTestId(page, "md-approval-confirm")).not.toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it("warns before approving a resignation that may deactivate the employee", async () => {
    page = await renderMdPage(MdApprovals, data(), { path: "/md/approvals/5" });
    const card = '[data-testid="md-approval-resignation-3"]';
    await page.click(`${card} [data-testid="md-approval-approve"]`);
    expect(byTestId(page, "md-approval-confirm")?.textContent).toMatch(/inactive straight away/);
  });

  it("explains how to add a head when the MD department has none", async () => {
    page = await renderMdPage(MdApprovals, data({ "/api/md/approvals/hods": { hods: [], mdDepartments: [] } }), {
      path: "/md/approvals",
    });
    const empty = byTestId(page, "md-approvals-empty")?.textContent ?? "";
    expect(empty).toContain("No Department Head in the MD department yet");
    expect(empty).toContain("User Management");
    expect(empty).toContain("create it in HR → Departments");
  });

  it("moves an old link to a head who is no longer listed onto the first head", async () => {
    page = await renderMdPage(MdApprovals, data({ "/api/md/approvals/hods": { ...HODS, hods: [hod()] } }), {
      path: "/md/approvals/8",
    });
    expect(byTestId(page, "md-approvals-panel")?.getAttribute("data-hod")).toBe("5");
    expect(page.requests().some((r) => r.startsWith("/api/md/approvals/hods/8"))).toBe(false);
  });
});
