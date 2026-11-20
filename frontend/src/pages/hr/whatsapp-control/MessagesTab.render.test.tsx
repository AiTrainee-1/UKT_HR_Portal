import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import MessagesTab from "./MessagesTab";

// The Messages tab: the queue's statuses and Meta's delivery ones can be filtered on and read as badges with a plain
// explanation, each row carries WhatsApp's ticks, the Meta template it went out as and what Meta charges it as; a skipped
// message shows the rule that held it back. The tab reads only the messages (no overview, which another tab guards).

const message = (id: number, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  employeeId: 7,
  employeeCode: "E007",
  employeeName: "Asha Kumar",
  phone: "919000000001",
  documentType: "late_alert",
  typeLabel: "Late alert",
  category: "attendance",
  categoryLabel: "Attendance",
  relatedModule: "",
  relatedLabel: "Attendance",
  status,
  error: "",
  messageText: "Hello Asha",
  providerMessageId: "",
  referenceId: null,
  sentBy: null,
  automatic: true,
  createdAt: "2026-11-06T09:00:00+05:30",
  updatedAt: "2026-11-06T09:00:00+05:30",
  kind: "automatic",
  sentAt: null,
  expiresAt: "2026-11-06T23:59:59+05:30",
  attempts: 0,
  ...extra,
});

const MESSAGES = [
  message(1, "queued"),
  message(2, "sending"),
  message(3, "expired", { error: "Not sent by the end of its day." }),
  message(4, "skipped", { error: "No approved Meta template (hrms_late_alert)." }),
  message(5, "sent", { kind: "code", sentAt: "2026-11-06T09:00:05+05:30", attempts: 1, templateName: "hrms_otp" }),
  message(6, "read", {
    templateName: "hrms_late_alert",
    pricingCategory: "utility",
    billable: true,
    providerMessageId: "wamid.HBgM",
    sentAt: "2026-11-06T09:01:00+05:30",
    deliveredAt: "2026-11-06T09:01:04+05:30",
    readAt: "2026-11-06T09:30:00+05:30",
  }),
  message(7, "delivered", { template: "hrms_absent_alert", category: "utility" }),
  message(8, "failed", { error: "131026: not a WhatsApp number", templateName: "hrms_late_alert" }),
];

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const open = async () => {
  page = await renderMdPage(
    () => <MessagesTab />,
    {
      "/api/whatsapp-control/messages": (params) => {
        const status = params.get("status");
        const items = status ? MESSAGES.filter((m) => m.status === status) : MESSAGES;
        return { items, total: items.length, page: 1, pageSize: 25 };
      },
    },
    { path: "/hr/whatsapp-control?tab=messages" },
  );
  return page;
};

const el = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const rows = () => Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="whatsapp-message-row"]'));
const tabs = () => Array.from(page!.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const statusTab = (label: string) => tabs().find((t) => t.textContent?.startsWith(label))!;

async function clickEl(target: HTMLElement) {
  await act(async () => target.click());
  await page!.settle();
}

describe("WhatsApp Control messages", () => {
  it("offers the queue's and Meta's statuses in the filter, and asks only for the messages", async () => {
    await open();
    const labels = tabs().map((t) => t.querySelector(".ptab-label")?.textContent);
    expect(labels).toEqual(["All", "Queued", "Sending", "Sent", "Delivered", "Read", "Failed", "Expired", "Skipped"]);
    expect(
      page!.requests().every((r) => r.startsWith("/api/whatsapp-control/messages") || r.startsWith("/api/auth/me")),
    ).toBe(true);
  });

  it("shows every status as a badge with its plain explanation, and WhatsApp's ticks", async () => {
    await open();
    expect(rows()).toHaveLength(8);
    const badge = (status: string) => el(`[data-testid="whatsapp-message-row"] [data-status="${status}"]`)!;
    expect(badge("queued").textContent).toBe("Queued");
    expect(badge("queued").title).toBe("Waiting its turn in the sending queue.");
    expect(badge("expired").title).toBe("Too late to be useful, so it was never sent.");
    expect(badge("skipped").title).toContain("no approved template");
    const ticks = Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="wa-ticks"]')).map(
      (t) => t.dataset.ticks,
    );
    // queued / sending / expired / skipped carry none
    expect(ticks).toEqual(["sent", "read", "delivered", "failed"]);
    const kinds = Array.from(document.body.querySelectorAll('[data-testid="whatsapp-message-kind"]')).map(
      (k) => k.textContent,
    );
    expect(kinds).toContain("Code");
  });

  it("shows the Meta template and the pricing category, under either name the server uses", async () => {
    await open();
    const templates = Array.from(document.body.querySelectorAll('[data-testid="whatsapp-message-template"]')).map(
      (t) => t.textContent,
    );
    expect(templates).toEqual(["hrms_otp", "hrms_late_alert", "hrms_absent_alert", "hrms_late_alert"]);
    const pricing = Array.from(document.body.querySelectorAll('[data-testid="whatsapp-message-pricing"]')).map(
      (t) => t.textContent,
    );
    // the read one is utility and billable (₹), the delivered one sent its category as `category`
    expect(pricing[5]).toBe("Utility₹");
    expect(pricing[6]).toBe("Utility");
    expect(pricing[0]).toBe("—");
  });

  it("filters to Skipped, explains it, and shows the rule that held each message back", async () => {
    await open();
    await clickEl(statusTab("Skipped"));
    expect(page!.requests().some((r) => r.includes("status=skipped"))).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(el('[data-testid="whatsapp-status-help"]')!.textContent).toContain("Held back by a rule");
    const reason = Array.from(rows()[0].querySelectorAll("p")).find(
      (p) => p.textContent === "No approved Meta template (hrms_late_alert).",
    )!;
    expect(reason.className).toContain("text-orange-700");
    expect(reason.className).not.toContain("text-red-700");
  });

  it("opens a skipped message with the reason labelled as such", async () => {
    await open();
    await clickEl(rows()[3]);
    const dialog = el('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Skipped because");
    expect(dialog.textContent).toContain("No approved Meta template (hrms_late_alert).");
    expect(dialog.textContent).not.toContain("Failure reason");
  });

  it("shows when a queued message expires, and a read one's template, charge, ticks' times and Meta id", async () => {
    await open();
    await clickEl(rows()[0]);
    expect(el('[role="dialog"]')!.textContent).toContain("Expires");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await page!.settle();
    await clickEl(rows()[5]);
    const dialog = el('[data-testid="wa-message-detail"]')!;
    const labels = Array.from(dialog.querySelectorAll("span")).map((s) => s.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(["Template", "Charged as", "Sent", "Delivered", "Read", "Meta message id"]),
    );
    expect(dialog.textContent).toContain("hrms_late_alert");
    expect(dialog.textContent).toContain("Utility · billable");
    expect(dialog.textContent).toContain("wamid.HBgM");
    expect(dialog.textContent).not.toContain("Expires");
  });
});
