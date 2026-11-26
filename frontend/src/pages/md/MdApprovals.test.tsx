import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ toast, useToast: () => ({ toast }) }));

import MdLayout from "@/components/md/MdLayout";
import { preloadMdShell } from "@/components/md/shell/loader";
import { HODS, PENDING, hod, item } from "./approvals/fixtures";
import type { HodRequestsResponse } from "./approvals/types";
import MdApprovals from "./MdApprovals";
import { renderMdPage, type Fixtures, type RenderedPage } from "./testing/renderMdPage";

let page: RenderedPage | undefined;
// the MD shell is a lazy chunk (components/md/shell/loader.ts): have it in before the first page renders
beforeAll(() => preloadMdShell(), 60_000);
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
    await page.click('[data-testid="md-approvals-kind-permission"]');
    expect(all(page, '[data-testid="md-approvals-list"] > li')).toHaveLength(1);
    await page.click('[data-testid="md-nav-approvals-hods"] a[href="/md/approvals/8"]');
    expect(byTestId(page, "md-approvals-panel")?.getAttribute("data-hod")).toBe("8");
    expect(byTestId(page, "md-approvals-kind-all")?.getAttribute("aria-checked")).toBe("true");
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
      i < 20
        ? item({ key: `leave-${i + 1}`, id: i + 1 })
        : item({
            key: `resignation-${i + 1}`,
            id: i + 1,
            kind: "resignation",
            kindLabel: "Resignation",
            group: "other",
          }),
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
    await page.click('[data-testid="md-approvals-kind-leave"]');
    expect(range()).toBe("Showing 1–10 of 20");
    await page.click('[data-testid="md-approvals-kind-resignation"]');
    expect(rows()).toHaveLength(3);
    expect(byTestId(page, "md-approvals-page-prev")).toBeNull(); // one page: no page buttons
  });

  it("filters by type, and asks the server for the history when the status changes", async () => {
    page = await renderMdPage(MdApprovals, data(), { path: "/md/approvals/5" });
    await page.click('[data-testid="md-approvals-kind-permission"]');
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
    await page.type(`${card} [data-testid="md-approval-comment"]`, "Clash with the audit");
    await page.click(`${card} [data-testid="md-approval-send"]`);
    expect(byTestId(page, "md-approval-error")?.textContent).toContain("switched off in User Management");
    expect(byTestId(page, "md-approval-confirm")).not.toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it("approves with no comment at all: nothing but the decision is sent", async () => {
    const posted: unknown[] = [];
    page = await renderMdPage(
      MdApprovals,
      data({
        "/api/md/approvals/hods/5/decide": (_params, init) => {
          posted.push(JSON.parse(String(init?.body)));
          return { decision: "approved", actor: "Test MD", item: null };
        },
      }),
      { path: "/md/approvals/5" },
    );
    const card = '[data-testid="md-approval-leave-14"]';
    await page.click(`${card} [data-testid="md-approval-approve"]`);
    expect(byTestId(page, "md-approval-confirm")?.textContent).toContain("Comment (optional, the employee sees it)");
    await page.click(`${card} [data-testid="md-approval-send"]`);
    expect(posted).toEqual([{ kind: "leave", id: 14, decision: "approved" }]);
    expect(byTestId(page, "md-approval-problem")).toBeNull();
  });

  it("a rejection needs the reason: without one nothing is sent, with one it goes as the comment", async () => {
    const posted: unknown[] = [];
    page = await renderMdPage(
      MdApprovals,
      data({
        "/api/md/approvals/hods/5/decide": (_params, init) => {
          posted.push(JSON.parse(String(init?.body)));
          return { decision: "rejected", actor: "Test MD (MD, for Sandhya Krishnan)", item: null };
        },
      }),
      { path: "/md/approvals/5" },
    );
    const card = '[data-testid="md-approval-leave-14"]';
    await page.click(`${card} [data-testid="md-approval-reject"]`);
    expect(byTestId(page, "md-approval-confirm")?.textContent).toContain(
      "Reason for rejecting (required, the employee sees it)",
    );
    await page.click(`${card} [data-testid="md-approval-send"]`);
    expect(posted).toEqual([]);
    expect(byTestId(page, "md-approval-problem")?.textContent).toBe(
      "Write the reason for rejecting (at least 3 characters).",
    );
    expect(byTestId(page, "md-approval-confirm")).not.toBeNull();
    await page.type(`${card} [data-testid="md-approval-comment"]`, " ok ");
    await page.click(`${card} [data-testid="md-approval-send"]`);
    expect(posted).toEqual([]); // two letters are not a reason
    await page.type(`${card} [data-testid="md-approval-comment"]`, "  Clash   with the audit ");
    await page.click(`${card} [data-testid="md-approval-send"]`);
    expect(posted).toEqual([{ kind: "leave", id: 14, decision: "rejected", comment: "Clash with the audit" }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Rejected: Surya M's leave" }));
  });

  it("shows when the employee submitted the request, to the second", async () => {
    const at = "2026-11-11T09:52:00";
    const body = {
      ...PENDING,
      items: [item({ submittedAt: at })],
      counts: { leave: 1, permission: 0, other: 0, total: 1 },
    };
    page = await renderMdPage(MdApprovals, data({ "/api/md/approvals/hods/5": body }), { path: "/md/approvals/5" });
    const card = byTestId(page, "md-approval-leave-14")!;
    expect(card.querySelector('[data-testid="md-approval-submitted"]')?.textContent).toMatch(
      /^Submitted 11 Nov 2026, 9:52:00 am( · .+)?$/,
    );
    expect(card.textContent).toContain("12 Nov 2026 – 13 Nov 2026"); // the dates asked for
    expect(card.textContent).toContain("Fever"); // the employee's reason
  });

  it("opens on an overview: what waits now, what came in, how it was decided, by type and over six months", async () => {
    const decided = item({
      key: "leave-20",
      id: 20,
      state: "rejected",
      status: "rejected",
      statusLabel: "Rejected",
      canApprove: false,
      canReject: false,
      steps: [
        {
          label: null,
          roles: ["hod"],
          state: "rejected",
          by: "Test MD (MD, for Sandhya Krishnan)",
          at: "2026-11-12T10:00:00",
          comment: "Clash with the audit",
        },
      ],
    });
    page = await renderMdPage(
      MdApprovals,
      data({
        "/api/md/approvals/hods/5": (params) =>
          params.get("status") === "all"
            ? { ...PENDING, status: "all", items: [...PENDING.items, decided], counts: { ...PENDING.counts, total: 4 } }
            : { ...PENDING, status: params.get("status") ?? "pending" },
      }),
      { path: "/md/approvals/5" },
    );
    expect(page.requests()).toContain("/api/md/approvals/hods/5?status=all");
    expect(byTestId(page, "md-approvals-kpi-waiting-value")?.textContent).toBe("3");
    expect(byTestId(page, "md-approvals-kpi-received-value")?.textContent).toBe("4");
    expect(byTestId(page, "md-approvals-kpi-rate-value")?.textContent).toBe("0%");
    expect(byTestId(page, "md-approvals-summary")?.textContent).toContain("4 requests reached Sandhya");
    expect(byTestId(page, "md-approvals-by-kind")?.textContent).toContain("Resignation");
    // a type in the chart narrows the list to it; a status figure switches the list's status
    await page.click('[data-testid="md-approvals-by-kind"] [data-testid="bar-permission"] button');
    expect(all(page, '[data-testid="md-approvals-list"] > li')).toHaveLength(1);
    await page.click('[data-testid="md-approvals-kpi-rate"]');
    expect(page.requests()).toContain("/api/md/approvals/hods/5?status=approved");
  });

  it("keeps the filters in the address: month, type and search narrow the list", async () => {
    page = await renderMdPage(MdApprovals, data(), { path: "/md/approvals/5?kind=leave&q=surya" });
    expect(all(page, '[data-testid="md-approvals-list"] > li')).toHaveLength(1);
    expect(byTestId(page, "md-approvals-kind-leave")?.getAttribute("aria-checked")).toBe("true");
    expect((byTestId(page, "md-approvals-search") as HTMLInputElement).value).toBe("surya");
    await page.type('[data-testid="md-approvals-search"]', "nobody");
    expect(page.text()).toContain("No request matches these filters");
  });

  it("a month shows only the requests for that month", async () => {
    page = await renderMdPage(MdApprovals, data(), { path: "/md/approvals/5?month=2026-10" });
    expect(all(page, '[data-testid="md-approvals-list"] > li')).toHaveLength(0);
    expect(page.text()).toContain("No request matches these filters");
    await page.click('[data-testid="md-approvals-all-months"]');
    expect(all(page, '[data-testid="md-approvals-list"] > li')).toHaveLength(3);
  });

  it("every card says the request date, the date(s) it is for and the reason; Details opens it in full", async () => {
    page = await renderMdPage(MdApprovals, data(), { path: "/md/approvals/5" });
    const card = byTestId(page, "md-approval-resignation-3")!;
    expect(card.querySelector('[data-testid="md-approval-facts"]')?.textContent).toContain("Last working day");
    expect(card.querySelector('[data-testid="md-approval-requested"]')?.textContent).toBe("10 Dec 2026");
    expect(card.textContent).toContain("Moving away");
    await page.click('[data-testid="md-approval-resignation-3"] [data-testid="md-approval-details"]');
    const sheet = document.body.querySelector('[data-testid="md-approval-details-sheet"]');
    expect(sheet?.textContent).toContain("Request date");
    expect(sheet?.textContent).toContain("Submitted at");
    expect(sheet?.querySelector('[data-testid="md-approval-details-reason"]')?.textContent).toBe("Moving away");
  });

  it("a rejected request shows who rejected it and the reason", async () => {
    const rejected = item({
      state: "rejected",
      status: "rejected",
      statusLabel: "Rejected",
      canApprove: false,
      canReject: false,
      steps: [
        {
          label: null,
          roles: ["hod"],
          state: "rejected",
          by: "Sandhya Krishnan",
          at: "2026-11-12T10:00:00",
          comment: "Short staffed",
        },
      ],
    });
    page = await renderMdPage(
      MdApprovals,
      data({ "/api/md/approvals/hods/5": { ...PENDING, status: "rejected", items: [rejected] } }),
      { path: "/md/approvals/5?status=rejected" },
    );
    expect(byTestId(page, "md-approvals-status-rejected")?.getAttribute("aria-checked")).toBe("true");
    expect(byTestId(page, "md-approval-decision")?.textContent).toBe(
      "Rejected by Sandhya Krishnan · reason: “Short staffed”",
    );
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

  it("lists Birthday compensation in Other, filters by it and decides it with its kind", async () => {
    const birthday = item({
      key: "birthday_compensation-9",
      kind: "birthday_compensation",
      kindLabel: "Birthday Compensation",
      group: "other",
      id: 9,
      title: "Birthday Compensation",
      from: "2026-11-20",
      to: null,
      detail: "first half (birthday 2026-11-12)",
      requested: { from: "2026-11-20", to: null, note: "first half", label: "Placed on" },
      reason: "Family function",
    });
    const posted: unknown[] = [];
    page = await renderMdPage(
      MdApprovals,
      data({
        "/api/md/approvals/hods/5": (params) => ({
          ...PENDING,
          status: params.get("status") ?? "pending",
          items: [...PENDING.items, birthday],
          counts: { leave: 1, permission: 1, other: 2, total: 4 },
        }),
        "/api/md/approvals/hods/5/decide": (_params, init) => {
          posted.push(JSON.parse(String(init?.body)));
          return {
            decision: "approved",
            actor: "Test MD (MD, for Sandhya Krishnan)",
            item: { ...birthday, statusLabel: "Waiting for HR", canApprove: false, canReject: false },
          };
        },
      }),
      { path: "/md/approvals/5" },
    );
    const card = '[data-testid="md-approval-birthday_compensation-9"]';
    expect(page.container.querySelector(card)?.textContent).toContain("Birthday compensation");
    expect(page.container.querySelector(card)?.getAttribute("aria-label")).toBe(
      "Birthday compensation request from Surya M",
    );
    expect(page.container.querySelector(`${card} [data-testid="md-approval-requested"]`)?.textContent).toContain(
      "first half",
    );
    await page.click('[data-testid="md-approvals-kind-birthday_compensation"]');
    expect(all(page, '[data-testid="md-approvals-list"] > li')).toHaveLength(1);
    await page.click(`${card} [data-testid="md-approval-approve"]`);
    await page.click(`${card} [data-testid="md-approval-send"]`);
    expect(posted).toEqual([{ kind: "birthday_compensation", id: 9, decision: "approved" }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Approved: Surya M's birthday compensation" }));
  });

  it("moves an old link to a head who is no longer listed onto the first head", async () => {
    page = await renderMdPage(MdApprovals, data({ "/api/md/approvals/hods": { ...HODS, hods: [hod()] } }), {
      path: "/md/approvals/8",
    });
    expect(byTestId(page, "md-approvals-panel")?.getAttribute("data-hod")).toBe("5");
    expect(page.requests().some((r) => r.startsWith("/api/md/approvals/hods/8"))).toBe(false);
  });
});
