import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import MessagesTab from "./MessagesTab";

// The Messages tab and the sending queue: the queue's statuses (Queued, Sending, Expired, Skipped) can be filtered on and
// read as badges with a plain explanation; a skipped message shows the rule that held it back, and the kind is tagged.

const counts = { pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, total: 0, accepted: 0 };
const OVERVIEW = {
  days: 30,
  config: { configured: true },
  totals: counts,
  today: counts,
  thisMonth: counts,
  categories: [{ key: "attendance", label: "Attendance" }],
  relatedModules: [],
  byCategory: { attendance: counts },
  byType: [],
  daily: [],
  recentFailures: [],
  stalePending: 0,
};

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
  message(4, "skipped", { error: "Asha has No WhatsApp on." }),
  message(5, "sent", { kind: "code", sentAt: "2026-11-06T09:00:05+05:30", attempts: 1 }),
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
      "/api/whatsapp-control/overview": OVERVIEW,
      "/api/whatsapp-control/messages": (params) => {
        const status = params.get("status");
        const items = status ? MESSAGES.filter((m) => m.status === status) : MESSAGES;
        return { items, total: items.length, page: 1, pageSize: 25 };
      },
    },
    { path: "/hr/whatsapp-control" },
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

describe("WhatsApp Control messages and the sending queue", () => {
  it("offers the queue's statuses in the filter", async () => {
    await open();
    const labels = tabs().map((t) => t.querySelector(".ptab-label")?.textContent);
    expect(labels).toEqual([
      "All",
      "Queued",
      "Sending",
      "Pending",
      "Sent",
      "Delivered",
      "Read",
      "Failed",
      "Expired",
      "Skipped",
    ]);
  });

  it("shows every queue status as a badge with its plain explanation", async () => {
    await open();
    expect(rows()).toHaveLength(5);
    const badge = (status: string) => el(`[data-testid="whatsapp-message-row"] [data-status="${status}"]`)!;
    expect(badge("queued").textContent).toBe("Queued");
    expect(badge("queued").title).toBe("Waiting its turn in the sending queue.");
    expect(badge("sending").textContent).toBe("Sending");
    expect(badge("expired").title).toBe("Too late to be useful, so it was never sent.");
    expect(badge("skipped").title).toBe("Blocked by a rule, so it was never sent.");
    // The kind is tagged quietly.
    const kinds = Array.from(document.body.querySelectorAll('[data-testid="whatsapp-message-kind"]')).map(
      (k) => k.textContent,
    );
    expect(kinds).toEqual(["Auto", "Auto", "Auto", "Auto", "Code"]);
  });

  it("filters to Skipped, explains it, and shows the rule that held each message back", async () => {
    await open();
    await clickEl(statusTab("Skipped"));
    expect(page!.requests().some((r) => r.includes("status=skipped"))).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(el('[data-testid="whatsapp-status-help"]')!.textContent).toContain(
      "Blocked by a rule, so it was never sent.",
    );
    const reason = Array.from(rows()[0].querySelectorAll("p")).find(
      (p) => p.textContent === "Asha has No WhatsApp on.",
    )!;
    expect(reason.className).toContain("text-orange-700");
    expect(reason.className).not.toContain("text-red-700");
  });

  it("opens a skipped message with the reason labelled as such", async () => {
    await open();
    await clickEl(rows()[3]);
    const dialog = el('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Skipped because");
    expect(dialog.textContent).toContain("Asha has No WhatsApp on.");
    expect(dialog.textContent).not.toContain("Failure reason");
    expect(dialog.textContent).toContain("Blocked by a rule, so it was never sent.");
  });

  it("shows when a queued message expires, and when a sent one went out", async () => {
    await open();
    await clickEl(rows()[0]);
    expect(el('[role="dialog"]')!.textContent).toContain("Expires");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await page!.settle();
    await clickEl(rows()[4]);
    const dialog = el('[role="dialog"]')!;
    const rowLabels = Array.from(dialog.querySelectorAll("span")).map((s) => s.textContent);
    expect(rowLabels).toContain("Sent");
    expect(rowLabels).toContain("Attempts");
    expect(dialog.textContent).toContain("A one-time login code");
    expect(dialog.textContent).not.toContain("Expires");
  });
});
