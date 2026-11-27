import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ toast, useToast: () => ({ toast }) }));

import { monthLabel, parseMonthKey, shiftMonth } from "@/components/md/kit/MonthPicker";
import { preloadMdShell } from "@/components/md/shell/loader";
import MdSettlement from "../MdSettlement";
import { renderMdPage, type Fixtures, type RenderedPage } from "../testing/renderMdPage";
import { advance, batch, fakeServer, fourItems, item } from "./fixtures";
import { istMonthKey, periodLabel } from "./logic";
import type { SettlementBatch, SettlementItem } from "./types";

let page: RenderedPage | undefined;
beforeAll(() => preloadMdShell(), 60_000);
afterEach(() => {
  page?.unmount();
  page = undefined;
  toast.mockClear();
});

// the page opens on this month in India: the batches are put in it
const NOW = istMonthKey();
const { month: M, year: Y } = parseMonthKey(NOW);
const PREVIOUS = shiftMonth(NOW, -1);

const el = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const text = (selector: string) => (el(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
const row = (id: number) => `[data-testid="md-settlement-table"] [data-testid="md-settlement-row-${id}"]`;
const inRow = (id: number, testId: string) => `${row(id)} [data-testid="${testId}"]`;
const dialog = (testId: string) => `[data-testid="md-settlement-dialog"] [data-testid="${testId}"]`;
const decided = (it: SettlementItem, decision: "approved" | "rejected", amount: number | null, remark = "") => ({
  ...it,
  md: { decision, amount, remark, decidedAt: "2026-11-25T05:00:00+00:00" },
});

async function open(batches: SettlementBatch[], extra: Fixtures = {}, path = "/md/loan-advance") {
  const server = fakeServer(batches);
  page = await renderMdPage(MdSettlement, { ...server.fixtures, ...extra }, { path });
  return server;
}

/** Choose an option of a dropdown (a native select), then let the page settle. */
async function choose(selector: string, value: string) {
  await act(async () => {
    const select = el(selector) as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page!.settle();
}

const tab = (view: string) => `[data-testid="md-settlement-tab-${view}"]`;
const selectedTab = () =>
  [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (t) => t.getAttribute("aria-selected") === "true",
  )?.dataset.testid;

describe("the layout: one row of tabs, dropdowns for the batch and the filter", () => {
  it("has exactly one tab row (Requests, Overview, History), each tab showing only its own section", async () => {
    await open([batch({ month: M, year: Y })]);
    const lists = document.body.querySelectorAll('[role="tablist"]');
    expect(lists).toHaveLength(1);
    expect([...lists[0].querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
      "Requests4",
      "Overview",
      "History1",
    ]);
    expect(selectedTab()).toBe("md-settlement-tab-requests");
    expect(el('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("md-settlement-tab-requests");
    expect(el('[data-testid="md-settlement-view-requests"]')).not.toBeNull();
    expect(el('[data-testid="md-settlement-view-overview"]')).toBeNull();
    expect(el('[data-testid="md-settlement-tracker"]')).toBeNull();

    await page!.click(tab("overview"));
    expect(selectedTab()).toBe("md-settlement-tab-overview");
    expect(el('[data-testid="md-settlement-view-overview"]')).not.toBeNull();
    expect(el('[data-testid="md-settlement-view-requests"]')).toBeNull();
    expect(el('[data-testid="md-settlement-bar"]')).toBeNull(); // the Review bar belongs to Requests

    await page!.click(tab("history"));
    expect(text('[data-testid="md-settlement-history"]')).toContain("HR forwarded the batch to you");
    expect(text('[data-testid="md-settlement-history"]')).toContain("Priya (HR)");
    expect(text('[data-testid="md-settlement-history"]')).toContain("4 requests");
    expect(document.body.querySelectorAll('[role="tablist"]')).toHaveLength(1);
  });

  it("keeps the tab in the address", async () => {
    await open([batch({ month: M, year: Y })], {}, "/md/loan-advance?view=overview");
    expect(selectedTab()).toBe("md-settlement-tab-overview");
    expect(el('[data-testid="md-settlement-tracker"]')).not.toBeNull();
    page!.unmount();
    await open([batch({ month: M, year: Y })], {}, "/md/loan-advance?view=nonsense");
    expect(selectedTab()).toBe("md-settlement-tab-requests");
  });

  it("picks the batch and the requests to show from dropdowns, not tabs", async () => {
    await open([batch({ month: M, year: Y })]);
    const batchSelect = el('[data-testid="md-settlement-batch-select"]');
    expect(batchSelect?.tagName).toBe("SELECT");
    expect(batchSelect?.closest('[data-testid="md-page-header"]')).not.toBeNull(); // beside the month picker
    expect([...(batchSelect as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      "Batch 1 · Waiting for you · 4 requests",
    ]);
    const filter = el('[data-testid="md-settlement-filter"]') as HTMLSelectElement;
    expect(filter.tagName).toBe("SELECT");
    expect(filter.closest('[role="tablist"]')).toBeNull();
    expect([...filter.options].map((o) => o.text)).toEqual([
      "All requests (4)",
      "To decide (4)",
      "Decided (0)",
      "Leave alerts (2)",
    ]);
    await choose('[data-testid="md-settlement-filter"]', "leave");
    expect(document.body.querySelectorAll('[data-testid="md-settlement-table"] tbody tr')).toHaveLength(2);
    expect(el(row(12))).not.toBeNull();
    expect(el(row(13))).not.toBeNull();
  });
});

describe("the batch waiting for the MD", () => {
  it("shows the tracker, the numbers and HR's note on the Overview tab", async () => {
    await open([batch({ month: M, year: Y })]);
    await page!.click(tab("overview"));
    expect(text('[data-testid="md-page-title"]')).toBe("Loan & Advance");
    expect(text('[data-testid="md-settlement-batch-title"]')).toBe(`Salary Advance · Batch 1 · ${periodLabel(M, Y)}`);
    expect(text('[data-testid="md-settlement-stage"]')).toBe("Waiting for your decision");

    // the tracker: received and HR Review done (with who), MD Review is the current step, the rest still to come
    expect(el('[data-testid="md-settlement-step-received"]')?.dataset.state).toBe("done");
    expect(text('[data-testid="md-settlement-step-hr_review"]')).toContain("by Priya (HR)");
    expect(el('[data-testid="md-settlement-step-md_review"]')?.getAttribute("aria-current")).toBe("step");
    expect(el('[data-testid="md-settlement-step-completed"]')?.dataset.state).toBe("pending");
    expect(document.body.querySelectorAll('[data-testid="md-settlement-tracker"] > li')).toHaveLength(9);

    // the headline numbers
    expect(text('[data-testid="md-settlement-kpi-requests-value"]')).toBe("4");
    expect(text('[data-testid="md-settlement-kpi-decided-value"]')).toBe("0/4");
    expect(text('[data-testid="md-settlement-kpi-leave-value"]')).toBe("2");
    expect(text('[data-testid="md-settlement-kpi-requests"]')).toContain("₹73,000 asked");
    expect(text('[data-testid="md-settlement-hr-message"]')).toContain("Please look at Bala's request first.");
    expect(text('[data-testid="md-settlement-hr-message"]')).toContain("Priya (HR)");
  });

  it("lists every request with its figures and its leave check on the Requests tab", async () => {
    await open([batch({ month: M, year: Y })]);
    expect(text('[data-testid="md-settlement-stage"]')).toBe("Waiting for your decision");
    // the requests: salary figures, purpose, HR's note on the request, the leave chips (in words)
    expect(text(row(11))).toContain("Anita Rao");
    expect(text(inRow(11, "md-settlement-limit"))).toContain("₹10,200");
    expect(text(inRow(11, "md-settlement-limit"))).toContain("fixed ₹30,000");
    expect(text(inRow(11, "md-settlement-purpose"))).toContain("Family function");
    expect(text(inRow(11, "md-settlement-hr-proposal"))).toContain("Regular attendance");
    expect(el(inRow(12, "md-settlement-leave"))?.dataset.tone).toBe("warning");
    expect(text(inRow(12, "md-settlement-leave"))).toBe("Leave warning: 3 days leave");
    expect(el(inRow(12, "md-settlement-leave"))?.getAttribute("title")).toContain("exactly 3 days");
    expect(el(inRow(13, "md-settlement-leave"))?.dataset.tone).toBe("critical");
    expect(text(inRow(13, "md-settlement-leave"))).toBe("Frequent leave: 4.5 days leave");
    expect(text(inRow(14, "md-settlement-leave"))).toContain("Not checked");
    expect(el(inRow(12, "md-settlement-over-limit"))).not.toBeNull();
    expect(el(inRow(11, "md-settlement-over-limit"))).toBeNull();
    expect(text(row(13))).toContain("Over 10 months · EMI ₹5,000");

    // the phone's cards carry the same requests
    expect(document.body.querySelectorAll('[data-testid="md-settlement-cards"] > li')).toHaveLength(4);
    // the sidebar's badge: the requests waiting for the MD
    expect(text('[data-testid="md-nav-settlement-waiting"]')).toBe("4");
    expect(el('[data-testid="md-nav-settlement"]')?.getAttribute("aria-current")).toBe("page");
  });

  it("approves a request at once for the full amount, and undoes it", async () => {
    const server = await open([batch({ month: M, year: Y })]);
    await page!.click(inRow(11, "md-settlement-approve"));
    expect(server.calls.at(-1)).toEqual({ path: "/api/md/settlement/items/11", body: { decision: "approved" } });
    expect(text(inRow(11, "md-settlement-decision"))).toBe("Approved ₹10,000");
    expect(text('[data-testid="md-settlement-progress"]')).toContain("1 of 4 decided");
    expect(text(tab("requests"))).toBe("Requests4");
    expect(toast).toHaveBeenCalledWith({ title: "Approved: Anita Rao, ₹10,000" });

    await page!.click(inRow(11, "md-settlement-undo"));
    expect(server.calls.at(-1)?.body).toEqual({ decision: "" });
    expect(el(inRow(11, "md-settlement-decision"))).toBeNull();
    expect(el(inRow(11, "md-settlement-approve"))).not.toBeNull();
  });

  it("reduces only to less than the amount asked, with a remark, before anything is sent", async () => {
    const server = await open([batch({ month: M, year: Y })]);
    await page!.click(inRow(12, "md-settlement-reduce"));
    expect(el('[data-testid="md-settlement-dialog"]')).not.toBeNull();
    expect(el(dialog("md-settlement-mode-reduce"))?.getAttribute("aria-checked")).toBe("true");

    await page!.click(dialog("md-settlement-save"));
    expect(text(dialog("md-settlement-amount-problem"))).toBe("Enter the reduced amount.");
    expect(text(dialog("md-settlement-remark-problem"))).toMatch(/remark for the reduced amount/);
    expect(server.calls).toHaveLength(0);

    await page!.type(dialog("md-settlement-amount"), "8000"); // the full amount is not a reduction
    await page!.type(dialog("md-settlement-remark"), "ok");
    await page!.click(dialog("md-settlement-save"));
    expect(text(dialog("md-settlement-amount-problem"))).toMatch(/less than the ₹8,000 asked for/);
    expect(text(dialog("md-settlement-remark-problem"))).toMatch(/at least 3 characters/);
    expect(server.calls).toHaveLength(0);

    // the 50% limit is one click away
    await page!.click(dialog("md-settlement-use-limit"));
    expect((el(dialog("md-settlement-amount")) as HTMLInputElement).value).toBe("6000");
    await page!.type(dialog("md-settlement-remark"), "Only the 50% limit");
    await page!.click(dialog("md-settlement-save"));
    expect(server.calls).toEqual([
      {
        path: "/api/md/settlement/items/12",
        body: { decision: "approved", amount: 6000, remark: "Only the 50% limit" },
      },
    ]);
    expect(el('[data-testid="md-settlement-dialog"]')).toBeNull();
    expect(text(inRow(12, "md-settlement-decision"))).toBe("Reduced ₹8,000 → ₹6,000");
    expect(text(inRow(12, "md-settlement-remark"))).toContain("Only the 50% limit");
  });

  it("rejects only with a reason, and shows the server's refusal on the field it is about", async () => {
    const refusal = { status: 400, body: { error: "Write the reason for rejecting (server).", code: "remark" } };
    const server = await open([batch({ month: M, year: Y })], { "/api/md/settlement/items/13": refusal });
    await page!.click(inRow(13, "md-settlement-reject"));
    await page!.click(dialog("md-settlement-save"));
    expect(text(dialog("md-settlement-remark-problem"))).toMatch(/reason for rejecting/);
    expect(page!.requests().some((r) => r.startsWith("/api/md/settlement/items/13"))).toBe(false);

    await page!.type(dialog("md-settlement-remark"), "Frequent leave this month");
    await page!.click(dialog("md-settlement-save"));
    expect(page!.requests().filter((r) => r.startsWith("/api/md/settlement/items/13"))).toHaveLength(1);
    expect(text(dialog("md-settlement-remark-problem"))).toBe("Write the reason for rejecting (server).");
    expect(el('[data-testid="md-settlement-dialog"]')).not.toBeNull(); // still open, nothing was saved
    expect(server.calls).toHaveLength(0);
  });

  it("keeps Confirm & Proceed off until every request is decided, then sends the instructions and turns read-only", async () => {
    const server = await open([batch({ month: M, year: Y })]);
    await page!.click('[data-testid="md-settlement-review-open"]');
    expect((el('[data-testid="md-settlement-confirm-hr-mode"]') as HTMLButtonElement).disabled).toBe(true);
    expect((el('[data-testid="md-settlement-confirm-direct"]') as HTMLButtonElement).disabled).toBe(true);
    expect(text('[data-testid="md-settlement-confirm-reason"]')).toBe(
      "Decide every request first: 4 requests still need your decision.",
    );
    expect(text('[data-testid="md-settlement-review-undecided"]')).toContain("4");
    await page!.click('[data-testid="md-settlement-review"] button.md-btn-ghost');

    // approve all remaining: every open request at the full amount, after a confirm step that names the leave alerts
    await page!.click('[data-testid="md-settlement-bulk"]');
    expect(text('[data-testid="md-settlement-bulk-warnings"]')).toContain("2 of them have a leave warning");
    expect(text('[data-testid="md-settlement-bulk-warnings"]')).toContain("1 of them asks for more than the limit");
    await page!.click('[data-testid="md-settlement-bulk-send"]');
    expect(server.calls.map((c) => [c.path, c.body])).toEqual([
      ["/api/md/settlement/batches/1/bulk", { itemIds: [11, 12, 13, 14], decision: "approved" }],
    ]);
    expect(text('[data-testid="md-settlement-progress"]')).toContain("4 of 4 decided");

    await page!.type('[data-testid="md-settlement-note"]', "Pay with this month's salary");
    // the instructions survive a look at another tab
    await page!.click(tab("overview"));
    expect(text('[data-testid="md-settlement-kpi-decided-value"]')).toBe("4/4");
    await page!.click(tab("requests"));
    expect((el('[data-testid="md-settlement-note"]') as HTMLTextAreaElement).value).toBe(
      "Pay with this month's salary",
    );
    await page!.click('[data-testid="md-settlement-review-open"]');
    expect((el('[data-testid="md-settlement-confirm-hr-mode"]') as HTMLButtonElement).disabled).toBe(false);
    expect(text('[data-testid="md-settlement-option-hr"]')).toContain("HR checks your decisions");
    expect(text('[data-testid="md-settlement-option-direct"]')).toContain("HR Final Settlement is skipped");
    expect(text('[data-testid="md-settlement-review-approved-total"]')).toBe("₹73,000");
    expect((el('[data-testid="md-settlement-review-note"]') as HTMLTextAreaElement).value).toBe(
      "Pay with this month's salary",
    );
    await page!.click('[data-testid="md-settlement-confirm-hr-mode"]');
    expect(server.calls.at(-1)).toEqual({
      path: "/api/md/settlement/batches/1/confirm",
      body: { note: "Pay with this month's salary", mode: "hr" },
    });

    // read-only: no buttons left; Overview says it went back to HR with the instructions; History has the step
    expect(text('[data-testid="md-settlement-stage"]')).toBe("HR Final Settlement");
    expect(el('[data-testid="md-settlement-actions"]')).toBeNull();
    expect(el('[data-testid="md-settlement-bar"]')).toBeNull();
    expect(el('[data-testid="md-settlement-review"]')).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Sent back to HR" }));
    await page!.click(tab("overview"));
    expect(text('[data-testid="md-settlement-sent-back"]')).toContain("Sent back to HR");
    expect(text('[data-testid="md-settlement-sent-back"]')).toContain("Pay with this month's salary");
    expect(el('[data-testid="md-settlement-step-md_review"]')?.dataset.state).toBe("done");
    await page!.click(tab("history"));
    expect(text('[data-testid="md-settlement-history"]')).toContain("You confirmed and sent it back to HR");
    expect(text('[data-testid="md-settlement-history"]')).toContain("4 approved · 0 rejected");
  });

  it("marks the requests the server still finds open when Confirm & Proceed is refused", async () => {
    const [a, b, c, d] = fourItems();
    const all = [
      decided(a, "approved", 10000),
      decided(b, "approved", 8000),
      decided(c, "rejected", null, "Not now"),
      decided(d, "approved", 5000),
    ];
    const server = fakeServer([batch({ month: M, year: Y, items: all })]);
    const refuseOnce = () => {
      // another tab cleared Dinesh's decision just before the confirm
      server.set(1, (x) => ({ ...x, items: x.items.map((i) => (i.id === 14 ? fourItems()[3] : i)) }));
      return {
        status: 400,
        body: {
          error: "1 request(s) still need your decision before you can confirm.",
          code: "undecided",
          undecided: [14],
        },
      };
    };
    page = await renderMdPage(
      MdSettlement,
      { ...server.fixtures, "/api/md/settlement/batches/1/confirm": refuseOnce },
      { path: "/md/loan-advance" },
    );
    await page!.click('[data-testid="md-settlement-review-open"]');
    await page!.click('[data-testid="md-settlement-confirm-hr-mode"]');
    expect(text('[data-testid="md-settlement-confirm-error"]')).toContain("1 request(s) still need your decision");
    // the page reloads the batch: Dinesh is open again, marked, and the button is off again
    expect(el(row(14))?.dataset.flagged).toBe("true");
    expect(text(inRow(14, "md-settlement-needs-decision"))).toBe("Needs your decision");
    expect(el(row(11))?.dataset.flagged).toBeUndefined();
    expect(text('[data-testid="md-settlement-review-group-undecided"]')).toContain("Dinesh Kumar");
    expect((el('[data-testid="md-settlement-confirm-hr-mode"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

/** Settle until `ready` holds (the finalized report is built in the browser, which takes longer than one settle). */
async function until(ready: () => boolean, rounds = 120) {
  for (let i = 0; i < rounds && !ready(); i++) await page!.settle();
  expect(ready()).toBe(true);
}

describe("round 5: bulk decisions, HR's proposals, the leave calendar, Forward to HR or Direct to Auditor", () => {
  const fromHr = (it: SettlementItem, md: Partial<SettlementItem["md"]>, hr: SettlementItem["hr"]) => ({
    ...it,
    hr,
    md: { decision: null, amount: null, remark: "", decidedAt: null, fromHr: true, ...md },
  });

  it("ticks all on screen and approves them at once; who was left out is said in a toast", async () => {
    const [a, b, c, d] = fourItems();
    // Bala: HR proposed 6,000 without a remark and the MD cleared it: a bulk approve without a remark leaves him out
    const items = [a, { ...b, hr: { action: "reduce" as const, amount: 6000, remark: "" } }, c, d];
    const server = await open([batch({ month: M, year: Y, items })]);
    expect(el('[data-testid="md-settlement-bulk-bar"]')).toBeNull();
    await page!.click('[data-testid="md-settlement-table"] [data-testid="md-settlement-select-all"]');
    expect(text('[data-testid="md-settlement-bulk-bar"]')).toContain("4 requests ticked");
    await page!.click('[data-testid="md-settlement-bulk-bar"] [data-testid="md-settlement-bulk-approve"]');
    expect(text('[data-testid="md-settlement-bulk-dialog"]')).toContain("Approve 4 requests?");
    await page!.click('[data-testid="md-settlement-bulk-send"]');
    expect(server.calls).toEqual([
      { path: "/api/md/settlement/batches/1/bulk", body: { itemIds: [11, 12, 13, 14], decision: "approved" } },
    ]);
    expect(toast).toHaveBeenCalledWith({
      title: "Approved 3 requests, 1 request left out",
      description: "Bala Murugan: A reduced amount needs a remark.",
    });
    // the one left out stays ticked, the others are decided
    expect(text('[data-testid="md-settlement-bulk-bar"]')).toContain("1 request ticked");
    expect(text(inRow(11, "md-settlement-decision"))).toBe("Approved ₹10,000");
    expect(el(inRow(12, "md-settlement-approve"))).not.toBeNull();
  });

  it("rejects the ticked requests only with one reason for all", async () => {
    const server = await open([batch({ month: M, year: Y })]);
    await page!.click(inRow(12, "md-settlement-select"));
    await page!.click(inRow(13, "md-settlement-select"));
    await page!.click('[data-testid="md-settlement-bulk-reject"]');
    await page!.click('[data-testid="md-settlement-bulk-send"]');
    expect(text('[data-testid="md-settlement-bulk-problem"]')).toMatch(/reason for rejecting/);
    expect(server.calls).toHaveLength(0);
    await page!.type('[data-testid="md-settlement-bulk-remark"]', "Too much leave this month");
    await page!.click('[data-testid="md-settlement-bulk-send"]');
    expect(server.calls).toEqual([
      {
        path: "/api/md/settlement/batches/1/bulk",
        body: { itemIds: [12, 13], decision: "rejected", remark: "Too much leave this month" },
      },
    ]);
    expect(text(inRow(12, "md-settlement-decision"))).toBe("Rejected");
    expect(toast).toHaveBeenCalledWith({ title: "Rejected 2 requests" });
    // select all is for the list on screen: the "Leave alerts" choice ticks only those two
    await choose('[data-testid="md-settlement-filter"]', "leave");
    await page!.click('[data-testid="md-settlement-table"] [data-testid="md-settlement-select-all"]');
    expect(text('[data-testid="md-settlement-bulk-bar"]')).toContain("2 requests ticked");
  });

  it("shows HR's proposals, and marks a pre-filled decision until the MD confirms it", async () => {
    const [a, b, c, d] = fourItems();
    const items = [
      a,
      fromHr(
        b,
        { decision: "approved", amount: 6000, remark: "Only the limit" },
        { action: "reduce", amount: 6000, remark: "Only the limit" },
      ),
      fromHr(
        c,
        { decision: "rejected", remark: "Too much leave" },
        { action: "reject", amount: null, remark: "Too much leave" },
      ),
      d,
    ];
    const server = await open([batch({ month: M, year: Y, items })]);
    expect(text(inRow(12, "md-settlement-hr-proposal"))).toBe("HR proposes ₹6,000“Only the limit”");
    expect(text(inRow(13, "md-settlement-hr-proposal"))).toContain("HR proposes reject");
    expect(text(inRow(11, "md-settlement-hr-proposal"))).toContain("No change proposed");
    expect(text(inRow(12, "md-settlement-decision"))).toBe("Reduced ₹8,000 → ₹6,000");
    expect(text(inRow(12, "md-settlement-from-hr"))).toBe("From HR — not yet confirmed by you");
    expect(text(inRow(12, "md-settlement-status"))).toBe("HR's proposal — confirm it");
    expect(text('[data-testid="md-settlement-progress"]')).toContain("2 from HR");

    await page!.click(inRow(12, "md-settlement-confirm-hr"));
    expect(server.calls).toEqual([
      { path: "/api/md/settlement/items/12", body: { decision: "approved", amount: 6000, remark: "Only the limit" } },
    ]);
    expect(el(inRow(12, "md-settlement-from-hr"))).toBeNull();
    expect(text(inRow(12, "md-settlement-status"))).toBe("Decided by you");
    expect(text(inRow(13, "md-settlement-from-hr"))).toBe("From HR — not yet confirmed by you");
  });

  it("opens a request's leave calendar from its leave count", async () => {
    await open([batch({ month: M, year: Y })]);
    await page!.click(inRow(12, "md-settlement-leave"));
    expect(page!.requests()).toContain("/api/md/settlement/items/12/leave-calendar");
    expect(el('[data-testid="leave-calendar-dialog"]')).not.toBeNull();
    expect(text('[data-testid="leave-calendar-dialog"]')).toContain("Bala Murugan · leave");
    expect(text('[data-testid="leave-calendar-dialog"]')).toContain("2.5 days");
  });

  it("Direct to Auditor builds the finalized report from the MD's decisions and sends it with the note", async () => {
    const [a, b, c, d] = fourItems();
    const all = [
      decided(a, "approved", 10000),
      decided(b, "approved", 6000, "Only the limit"),
      decided(c, "rejected", null, "Not now"),
      decided(d, "approved", 5000),
    ];
    const server = await open([batch({ month: M, year: Y, items: all })]);
    await page!.type('[data-testid="md-settlement-note"]', "Pay with this month's salary");
    await page!.click('[data-testid="md-settlement-review-open"]');
    expect((el('[data-testid="md-settlement-confirm-direct"]') as HTMLButtonElement).disabled).toBe(false);
    await page!.click('[data-testid="md-settlement-confirm-direct"]');
    await until(() => server.calls.some((c) => c.path.endsWith("/confirm")));
    const stem = `Loan_Advance_Salary_Advance_${periodLabel(M, Y).replace(" ", "_")}_Batch_1_Final`;
    expect(server.calls.at(-1)).toEqual({
      path: "/api/md/settlement/batches/1/confirm",
      body: {
        note: "Pay with this month's salary",
        mode: "direct",
        pdf: { name: `${stem}.pdf`, type: "application/pdf", size: expect.any(Number) },
        xlsx: {
          name: `${stem}.xlsx`,
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: expect.any(Number),
        },
      },
    });
    await until(() => !!el('[data-testid="md-settlement-direct-state"]'));
    expect(text('[data-testid="md-settlement-direct-state"]')).toContain("Finalized by you and sent to the auditor");
    expect(text('[data-testid="md-settlement-direct-state"]')).toContain("Pay with this month's salary");
    expect(el('[data-testid="md-settlement-actions"]')).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Finalized and sent to the auditor" }));
    // the tracker: HR Final Settlement skipped, "Finalized directly by the MD"
    await page!.click(tab("overview"));
    expect(el('[data-testid="md-settlement-step-hr_final"]')?.dataset.state).toBe("skipped");
    expect(text('[data-testid="md-settlement-step-detail-hr_final"]')).toBe("Finalized directly by the MD");
    expect(el('[data-testid="md-settlement-step-auditor_review"]')?.dataset.state).toBe("current");
    expect(el('[data-testid="md-settlement-sent-back"]')).toBeNull();
  });

  it("says when the settlement is finalized but the auditor e-mail failed", async () => {
    const [a, b, c, d] = fourItems();
    const all = [
      decided(a, "approved", 10000),
      decided(b, "approved", 8000),
      decided(c, "rejected", null, "No"),
      decided(d, "approved", 5000),
    ];
    const server = fakeServer([batch({ month: M, year: Y, items: all })], { auditorFails: true });
    page = await renderMdPage(MdSettlement, server.fixtures, { path: "/md/loan-advance" });
    await page.click('[data-testid="md-settlement-review-open"]');
    await page.click('[data-testid="md-settlement-confirm-direct"]');
    await until(() => !!el('[data-testid="md-settlement-direct-state"]'));
    expect(text('[data-testid="md-settlement-direct-state"]')).toContain(
      "Finalized by you — not sent to the auditor yet",
    );
    expect(text('[data-testid="md-settlement-direct-state"]')).toContain("could not be sent to the auditor");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Finalized — not sent to the auditor", variant: "destructive" }),
    );
    expect(text('[data-testid="md-settlement-stage"]')).toBe("Send to Auditor");
  });
});

describe("Salary Advance and Term Loan", () => {
  const term = (extra: Partial<SettlementBatch> = {}) =>
    batch({
      id: 9,
      advanceType: "term",
      month: M,
      year: Y,
      hrNote: "Term loans of the month",
      items: [item(31, advance(31, { employeeName: "Farook Ali", advanceType: "term", typeLabel: "Term Loan" }))],
      ...extra,
    });

  it("picks the type from a dropdown beside the month and the batch, with each type's waiting count", async () => {
    await open([batch({ month: M, year: Y }), term()]);
    const select = el('[data-testid="md-settlement-type-select"]') as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.closest('[data-testid="md-page-header"]')).not.toBeNull();
    expect([...select.options].map((o) => [o.value, o.text])).toEqual([
      ["general", "Salary Advance · 4 waiting"],
      ["term", "Term Loan · 1 waiting"],
    ]);
    // Salary Advance first when both wait; the page writes the type it chose into the address
    expect(select.value).toBe("general");
    expect(page!.requests()).toContain(`/api/md/settlement/month?month=${M}&year=${Y}&type=general`);
    expect(text('[data-testid="md-settlement-view-requests"]')).toContain("Salary Advance · Batch 1");
    // the other type of the month waits too: the banner says so
    expect(text('[data-testid="md-settlement-waiting-banner"]')).toContain(
      `Term Loan · Batch 1 waiting in ${periodLabel(M, Y)} (1 request)`,
    );

    await choose('[data-testid="md-settlement-type-select"]', "term");
    expect(page!.requests()).toContain(`/api/md/settlement/month?month=${M}&year=${Y}&type=term`);
    expect(el('[data-testid="md-settlement-batch"]')?.dataset.batch).toBe("9");
    expect(text('[data-testid="md-settlement-view-requests"]')).toContain("Term Loan · Batch 1");
    expect(text(row(31))).toContain("Farook Ali");
    expect(text('[data-testid="md-settlement-waiting-banner"]')).toContain("Salary Advance · Batch 1 waiting");
    // still one tab row, and the batch is still a dropdown
    expect(document.body.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(el('[data-testid="md-settlement-batch-select"]')?.tagName).toBe("SELECT");
    // the sidebar's badge counts both types
    expect(text('[data-testid="md-nav-settlement-waiting"]')).toBe("5");
  });

  it("keeps the type in the address, and opens on the type waiting for the MD when it names none", async () => {
    await open([batch({ month: M, year: Y }), term()], {}, "/md/loan-advance?type=term");
    expect((el('[data-testid="md-settlement-type-select"]') as HTMLSelectElement).value).toBe("term");
    expect(el('[data-testid="md-settlement-batch"]')?.dataset.batch).toBe("9");
    expect(page!.requests().some((r) => r.includes("type=general"))).toBe(false);
    page!.unmount();

    // the HRMS's own words work too
    await open([batch({ month: M, year: Y }), term()], {}, "/md/loan-advance?type=salary-advance");
    expect((el('[data-testid="md-settlement-type-select"]') as HTMLSelectElement).value).toBe("general");
    page!.unmount();

    // only a Term Loan batch waits: the page opens on Term Loan
    await open([batch({ month: M, year: Y, stage: "hr_final", stageLabel: "HR Final Settlement" }), term()]);
    expect((el('[data-testid="md-settlement-type-select"]') as HTMLSelectElement).value).toBe("term");
    expect(page!.requests().filter((r) => r.startsWith("/api/md/settlement/month"))).toEqual([
      `/api/md/settlement/month?month=${M}&year=${Y}&type=term`,
    ]);
    expect(
      [...(el('[data-testid="md-settlement-type-select"]') as HTMLSelectElement).options].map((o) => o.text),
    ).toEqual(["Salary Advance", "Term Loan · 1 waiting"]);
  });

  it("says which type is empty", async () => {
    await open([batch({ month: M, year: Y })], {}, "/md/loan-advance?type=term");
    expect(text('[data-testid="md-settlement-empty"]')).toContain(
      `No Term Loan requests forwarded to you for ${monthLabel(NOW)}`,
    );
    expect(text('[data-testid="md-settlement-waiting-banner"]')).toContain("Salary Advance · Batch 1 waiting");
    await page!.click(`[data-testid="md-settlement-open-general-${NOW}"]`);
    expect((el('[data-testid="md-settlement-type-select"]') as HTMLSelectElement).value).toBe("general");
    expect(el('[data-testid="md-settlement-batch"]')?.dataset.batch).toBe("1");
  });
});

describe("months and other states", () => {
  it("points to a batch waiting in another month and opens it", async () => {
    await open([batch({ id: 5, month: parseMonthKey(PREVIOUS).month, year: parseMonthKey(PREVIOUS).year })]);
    expect(text('[data-testid="md-settlement-empty"]')).toContain(
      `No Salary Advance requests forwarded to you for ${monthLabel(NOW)}`,
    );
    const { month, year } = parseMonthKey(PREVIOUS);
    expect(text('[data-testid="md-settlement-waiting-banner"]')).toContain(
      `Salary Advance · Batch 1 waiting in ${periodLabel(month, year)} (4 requests)`,
    );
    await page!.click(`[data-testid="md-settlement-open-general-${PREVIOUS}"]`);
    expect(page!.requests()).toContain(`/api/md/settlement/month?month=${month}&year=${year}&type=general`);
    expect(el('[data-testid="md-settlement-batch"]')?.dataset.batch).toBe("5");
    expect(el('[data-testid="md-settlement-waiting-banner"]')).toBeNull(); // nothing waits elsewhere now
  });

  it("switches between the month's batches and notes a batch still at HR Review", async () => {
    const sent = batch({ id: 1, month: M, year: Y, stage: "hr_final", stageLabel: "HR Final Settlement" });
    const waiting = batch({
      id: 2,
      number: 2,
      label: "Batch 2",
      month: M,
      year: Y,
      items: [item(21, advance(21, { employeeName: "Esha Nair" }))],
    });
    const server = fakeServer([sent, waiting], { extra: { waitingForHr: true } });
    page = await renderMdPage(MdSettlement, server.fixtures, { path: "/md/loan-advance" });
    // the batch waiting for the MD comes first
    expect(el('[data-testid="md-settlement-batch"]')?.dataset.batch).toBe("2");
    expect(text('[data-testid="md-note"]')).toContain("HR is still reviewing more Salary Advance requests");
    const options = [...(el('[data-testid="md-settlement-batch-select"]') as HTMLSelectElement).options];
    expect(options.map((o) => [o.value, o.text])).toEqual([
      ["1", "Batch 1 · HR Final Settlement · 4 requests"],
      ["2", "Batch 2 · Waiting for you · 1 request"],
    ]);
    // the open tab stays when the batch changes
    await page.click(tab("overview"));
    await choose('[data-testid="md-settlement-batch-select"]', "1");
    expect(el('[data-testid="md-settlement-batch"]')?.dataset.batch).toBe("1");
    expect(selectedTab()).toBe("md-settlement-tab-overview");
    expect(text('[data-testid="md-settlement-stage"]')).toBe("HR Final Settlement");
    await page.click(tab("requests"));
    expect(el('[data-testid="md-settlement-actions"]')).toBeNull();
  });

  it("after HR finalized, shows HR's final decision beside the MD's, read-only", async () => {
    const [a, b] = fourItems();
    const items = [
      {
        ...decided(a, "approved", 10000),
        final: {
          decision: "approved" as const,
          amount: 10000,
          startMonth: 12,
          startYear: 2026,
          remark: "",
          changedFromMd: false,
        },
      },
      {
        ...decided(b, "approved", 8000),
        final: {
          decision: "approved" as const,
          amount: 6000,
          startMonth: 1,
          startYear: 2027,
          remark: "Within the limit",
          changedFromMd: true,
        },
      },
    ];
    await open([
      batch({
        month: M,
        year: Y,
        items,
        stage: "auditor_send",
        stageLabel: "Send to Auditor",
        mdConfirmedAt: "2026-11-25T06:00:00+00:00",
        mdConfirmedBy: "Test MD (MD)",
        mdNote: "Go ahead",
        finalizedAt: "2026-11-26T06:00:00+00:00",
        finalizedBy: "Priya (HR)",
      }),
    ]);
    expect(text(inRow(11, "md-settlement-status"))).toBe("Final ₹10,000");
    expect(text(inRow(12, "md-settlement-status"))).toBe("Final ₹6,000");
    expect(text(inRow(12, "md-settlement-final-changed"))).toContain("HR changed your decision: “Within the limit”");
    expect(text(row(11))).toContain("First deduction Dec 2026");
    expect(el('[data-testid="md-settlement-actions"]')).toBeNull();
    await page!.click(tab("overview"));
    expect(text('[data-testid="md-settlement-sent-back"]')).toContain("HR finalized it");
    expect(text('[data-testid="md-settlement-kpi-amount-value"]')).toBe("₹16,000");
  });

  it("explains a month with nothing forwarded while the Normal Method is on (and shows no tabs)", async () => {
    const server = fakeServer([], { extra: { method: "normal" } });
    page = await renderMdPage(MdSettlement, server.fixtures, { path: "/md/loan-advance" });
    expect(text('[data-testid="md-note"]')).toContain("Normal Method");
    expect(text('[data-testid="md-settlement-empty"]')).toContain("When HR forwards a batch");
    expect(document.body.querySelectorAll('[role="tablist"]')).toHaveLength(0);
    expect(el('[data-testid="md-settlement-batch-select"]')).toBeNull();
    expect(el('[data-testid="md-nav-settlement-waiting"]')).toBeNull(); // no badge when nothing waits
  });
});
