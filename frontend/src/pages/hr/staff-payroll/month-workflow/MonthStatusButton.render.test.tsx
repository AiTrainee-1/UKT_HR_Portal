import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayrollMonthStatus } from "@/lib/api-client/custom-hooks";
import { monthStatus } from "./fixtures";
import { FINALIZE_QUESTION } from "./logic";
import { MonthStatusButton } from "./MonthStatusButton";

// The Staff Payroll month's button in jsdom (owner 2026-11-10): Payroll Done and its Yes / Cancel popup, Payment Pending
// with its live timer and Mark as Paid, Paid with the date, and what a unit login may not press.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const posts: { url: string; body: unknown }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  posts.length = 0;
  h.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/payroll/month-paid") return { ...monthStatus({ state: "paid" }), employeesPaid: 118 };
    return monthStatus({ state: "finalized" });
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  vi.useRealTimers();
});

function mount(status: PayrollMonthStatus | undefined) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(MonthStatusButton, { status }))));
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe("Payroll Done", () => {
  it("asks the owner's question and finalizes on Yes", async () => {
    mount(
      monthStatus({ counts: { ...monthStatus().counts, notCleared: 2, onHold: 1, newJoiners: 1 }, monthEnded: true }),
    );
    const button = q("month-status-button") as HTMLButtonElement;
    expect(text(button)).toBe("Payroll Done");
    expect(button.dataset.state).toBe("open");
    click(button);
    expect(text(q("month-finalize-question"))).toBe(FINALIZE_QUESTION);
    expect(text(q("month-finalize-warnings"))).toContain("2 employees in the payroll are not Cleared yet.");
    expect(text(q("month-finalize-warnings"))).toContain("1 salary is on hold");
    expect(text(q("month-finalize-summary"))).toContain(
      "120 employees in the payroll, 1 on hold, 1 new joiner not added",
    );
    click(q("month-finalize-yes"));
    await settle();
    await settle();
    expect(posts).toEqual([{ url: "/api/payroll/month-finalize", body: { month: 10, year: 2026 } }]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "October 2026 payroll is finalized" }));
    expect(q("month-finalize-dialog")).toBeNull();
  });

  it("Cancel finalizes nothing", () => {
    mount(monthStatus());
    click(q("month-status-button"));
    click(q("month-finalize-cancel"));
    expect(posts).toEqual([]);
  });

  it("is off for a unit login, with the reason", () => {
    mount(
      monthStatus({
        wholeCompany: false,
        can: { finalize: false, markPaid: false, hold: true, addToPayroll: true, releaseAndPay: false },
      }),
    );
    const button = q("month-status-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement!.title).toContain("Only a whole-company login");
  });

  it("waits while the status loads", () => {
    mount(undefined);
    expect((q("month-status-loading") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Payment Pending", () => {
  const pending = (over: Partial<PayrollMonthStatus> = {}) =>
    monthStatus({
      state: "finalized",
      locked: true,
      finalizedAt: new Date(Date.now() - (2 * 1440 + 3 * 60 + 5) * 60000).toISOString(),
      finalizedBy: "Meena",
      can: { finalize: false, markPaid: true, hold: false, addToPayroll: false, releaseAndPay: true },
      ...over,
    });

  it("shows a live timer on the button and in its popup", () => {
    mount(pending());
    const button = q("month-status-button")!;
    expect(button.dataset.state).toBe("finalized");
    expect(text(button)).toBe("Payment Pending2d 3h 5m");
    click(button);
    expect(text(q("month-payment-timer"))).toContain("2 days 3 h 5 min");
    expect(text(q("month-payment-summary"))).toContain("by Meena");
    expect(q("month-timeline")).not.toBeNull();
  });

  it("the timer moves on by itself", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    mount(pending({ finalizedAt: "2026-11-12T09:00:00Z" }));
    expect(text(q("month-status-detail"))).toBe("1h 0m");
    act(() => {
      vi.setSystemTime(new Date("2026-11-12T10:30:00Z"));
      vi.advanceTimersByTime(30_000);
    });
    expect(text(q("month-status-detail"))).toBe("1h 30m");
  });

  it("Mark as Paid asks first, then marks the month paid", async () => {
    mount(pending());
    click(q("month-status-button"));
    click(q("month-mark-paid"));
    expect(text(q("month-paid-question"))).toContain("Every employee in the payroll will be marked Paid");
    expect(text(q("month-paid-count"))).toBe("120 employees will be marked Paid.");
    click(q("month-paid-yes"));
    await settle();
    await settle();
    expect(posts).toEqual([{ url: "/api/payroll/month-paid", body: { month: 10, year: 2026 } }]);
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "118 employees marked Paid and told on their phone." }),
    );
  });

  it("a unit login sees the timer but cannot mark paid", () => {
    mount(
      pending({
        wholeCompany: false,
        can: { finalize: false, markPaid: false, hold: false, addToPayroll: false, releaseAndPay: false },
      }),
    );
    click(q("month-status-button"));
    expect((q("month-mark-paid") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q("month-paid-blocked"))).toContain("Only a whole-company login");
  });
});

describe("Paid", () => {
  it("shows the paid date and how long it took, and the timeline", () => {
    mount(
      monthStatus({
        state: "paid",
        locked: true,
        finalizedAt: "2026-11-10T07:48:00Z",
        paidAt: "2026-11-13T09:00:00Z",
        paidBy: "Admin",
        daysToPay: 3,
        can: { finalize: false, markPaid: false, hold: false, addToPayroll: false, releaseAndPay: true },
      }),
    );
    const button = q("month-status-button")!;
    expect(button.dataset.state).toBe("paid");
    expect(text(q("month-status-detail"))).toBe("13 Nov 2026 · 3 days after finalizing");
    click(button);
    expect(text(q("month-payment-summary"))).toContain("by Admin, 3 days after finalizing");
    expect(q("month-mark-paid")).toBeNull();
    expect(q("month-step-paid")!.dataset.done).toBe("true");
  });
});
