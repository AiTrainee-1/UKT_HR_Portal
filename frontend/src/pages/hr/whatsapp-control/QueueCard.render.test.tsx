import { afterEach, describe, expect, it } from "vitest";
import { renderMdPage, type RenderedPage } from "@/pages/md/testing/renderMdPage";
import OverviewTab from "./OverviewTab";
import QueueCard from "./QueueCard";

// Today's queue on the WhatsApp Control Overview: what waits, what went out against the limits, why sending is held
// (engine OFF, paused, quiet hours), and Clear queue behind a confirmation.

const QUEUE = {
  engineEnabled: true,
  paused: false,
  pausedReason: "",
  inQuietHours: false,
  queued: 12,
  sentToday: 170,
  sentLastHour: 20,
  failedToday: 1,
  expiredToday: 2,
  skippedToday: 3,
  nextSendAt: new Date(Date.now() + 30_000).toISOString(),
  limits: { minGapSeconds: 30, maxPerHour: 60, maxPerDay: 200, maxPerEmployeePerDay: 3 },
};

function queueServer(initial: Record<string, unknown> = QUEUE) {
  let state = { ...initial };
  const clears: string[] = [];
  return {
    clears,
    fixtures: {
      "/api/whatsapp-control/queue": () => state,
      "/api/whatsapp-control/queue/clear": (_p: URLSearchParams, init?: RequestInit) => {
        clears.push(init?.method ?? "GET");
        const cleared = Number(state.queued);
        state = { ...state, queued: 0, nextSendAt: null };
        return { cleared };
      },
    },
  };
}

let page: RenderedPage | undefined;
afterEach(() => {
  page?.unmount();
  page = undefined;
});

const el = (selector: string) => document.body.querySelector<HTMLElement>(selector);

describe("Today's queue card", () => {
  it("shows what waits and today's sending against the limits", async () => {
    page = await renderMdPage(() => <QueueCard />, queueServer().fixtures, { path: "/hr/whatsapp-control" });
    expect(el('[data-testid="wa-queue-queued"]')!.textContent).toContain("12");
    const day = el('[data-testid="wa-queue-sent-today"]')!;
    expect(day.textContent).toContain("170");
    expect(day.textContent).toContain("/ 200");
    expect(day.dataset.level).toBe("near");
    const hour = el('[data-testid="wa-queue-sent-hour"]')!;
    expect(hour.textContent).toContain("20");
    expect(hour.textContent).toContain("/ 60");
    expect(hour.dataset.level).toBe("ok");
    expect(el('[data-testid="wa-queue-failed"]')!.textContent).toContain("1");
    expect(el('[data-testid="wa-queue-expired"]')!.textContent).toContain("2");
    expect(el('[data-testid="wa-queue-skipped"]')!.textContent).toContain("3");
    expect(el('[data-testid="wa-queue-next"]')!.textContent).toContain("at least 30 s apart");
    expect(page.text()).toContain("At most 3 automatic messages per employee per day.");
    // Nothing is held: no banner.
    for (const banner of ["wa-queue-engine-off", "wa-queue-paused", "wa-queue-quiet"]) {
      expect(el(`[data-testid="${banner}"]`)).toBeNull();
    }
  });

  it("says plainly when the engine is OFF, sending is paused (with the reason) or it is quiet hours", async () => {
    const held = {
      ...QUEUE,
      engineEnabled: false,
      paused: true,
      pausedReason: "WhatsApp restricted the number; sending resumes at 14:00.",
      inQuietHours: true,
    };
    page = await renderMdPage(() => <QueueCard />, queueServer(held).fixtures, { path: "/hr/whatsapp-control" });
    expect(el('[data-testid="wa-queue-engine-off"]')!.textContent).toContain("engine is OFF");
    expect(el('[data-testid="wa-queue-paused"]')!.textContent).toContain(
      "WhatsApp restricted the number; sending resumes at 14:00.",
    );
    expect(el('[data-testid="wa-queue-quiet"]')!.textContent).toContain("Quiet hours");
    expect(el('[data-testid="wa-queue-next"]')!.textContent).toContain("the engine is OFF");
  });

  it("clears the queue only after HR confirms, then refreshes", async () => {
    const server = queueServer();
    page = await renderMdPage(() => <QueueCard />, server.fixtures, { path: "/hr/whatsapp-control" });
    await page.click('[data-testid="wa-clear-queue"]');
    expect(server.clears).toEqual([]);
    expect(el('[data-testid="wa-clear-queue-confirm"]')!.textContent).toContain(
      "The 12 messages waiting will not be sent",
    );

    await page.click('[data-testid="wa-clear-queue-confirm-confirm"]');
    expect(server.clears).toEqual(["POST"]);
    expect(el('[data-testid="wa-queue-queued"]')!.textContent).toContain("0");
    expect(el('[data-testid="wa-clear-queue"]')!.hasAttribute("disabled")).toBe(true);
    expect(page.requests().filter((r) => r === "/api/whatsapp-control/queue").length).toBeGreaterThanOrEqual(2);
  });

  it("can't clear an empty queue", async () => {
    page = await renderMdPage(() => <QueueCard />, queueServer({ ...QUEUE, queued: 0, nextSendAt: null }).fixtures, {
      path: "/hr/whatsapp-control",
    });
    expect(el('[data-testid="wa-clear-queue"]')!.hasAttribute("disabled")).toBe(true);
    expect(el('[data-testid="wa-queue-next"]')!.textContent).toContain("nothing waiting");
  });

  it("says nothing more goes today when messages wait but the server has no next send time", async () => {
    const full = { ...QUEUE, sentToday: 200, nextSendAt: null };
    page = await renderMdPage(() => <QueueCard />, queueServer(full).fixtures, { path: "/hr/whatsapp-control" });
    expect(el('[data-testid="wa-queue-next"]')!.textContent).toContain("nothing more goes out today");
    expect(el('[data-testid="wa-queue-sent-today"]')!.dataset.level).toBe("full");
    expect(el('[data-testid="wa-clear-queue"]')!.hasAttribute("disabled")).toBe(false);
  });

  it("says so, without breaking the page, when the server has no queue to show", async () => {
    page = await renderMdPage(
      () => <QueueCard />,
      { "/api/whatsapp-control/queue": { status: 404, body: { error: "Not found" } } },
      { path: "/hr/whatsapp-control" },
    );
    expect(el('[data-testid="wa-queue-card"]')!.textContent).toContain("isn't available");
  });
});

const counts = { pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, total: 0, accepted: 0 };

describe("the Overview tab", () => {
  it("shows today's queue above today's and this month's numbers", async () => {
    page = await renderMdPage(
      () => <OverviewTab onOpenCategory={() => {}} onOpenFailures={() => {}} onOpenConfig={() => {}} />,
      {
        ...queueServer().fixtures,
        "/api/whatsapp-control/overview": {
          days: 30,
          config: { configured: true },
          totals: counts,
          today: counts,
          thisMonth: counts,
          categories: [{ key: "otp", label: "OTP & Login" }],
          relatedModules: [],
          byCategory: { otp: counts },
          byType: [],
          daily: [],
          recentFailures: [],
          stalePending: 0,
        },
      },
      { path: "/hr/whatsapp-control" },
    );
    const card = el('[data-testid="wa-queue-card"]')!;
    const today = el('[data-testid="period-today"]')!;
    expect(card.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(page.text()).toContain("Today's queue");
  });
});
