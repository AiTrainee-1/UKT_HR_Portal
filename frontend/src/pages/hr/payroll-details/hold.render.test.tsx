import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  click,
  installBrowserStubs,
  installWorld,
  must,
  openLoaded,
  q,
  text,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// Hold / Unhold beside Mark as Cleared on a STAFF payroll's details page (owner 2026-11-10), and the month's Payroll Done
// lock: once a month is finalized neither Hold nor Mark as Cleared can be pressed, and the page says why.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "tok", user: null }) }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  world = installWorld(h.fetch);
});

afterEach(() => {
  unmountPage();
  vi.restoreAllMocks();
});

const holdButton = () => must("pd-hold") as HTMLButtonElement;
const ready = () => waitFor(() => !!q("pd-hold") && !holdButton().disabled, "the Hold button");

describe("Hold / Unhold on the details page", () => {
  it("sits beside Mark as Cleared and holds the salary", async () => {
    await openLoaded("/hr/payroll/details/101");
    await ready();
    const actions = must("pd-actions");
    const names = [...actions.querySelectorAll("button")].map((b) => text(b));
    expect(names.indexOf("Hold")).toBe(names.indexOf("Mark as Cleared") + 1);
    click(holdButton());
    await waitFor(() => world.holds.length === 1, "the hold request");
    expect(world.holds).toEqual([{ id: 101, hold: true }]);
    await waitFor(() => text(q("pd-hold")) === "Unhold", "the button to turn into Unhold");
    expect(text(must("pd-on-hold"))).toBe("On hold");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("is on hold") }));
  });

  it("an employee on hold shows Unhold, which takes the hold off", async () => {
    world.flags.set(101, { onHold: true });
    await openLoaded("/hr/payroll/details/101");
    await ready();
    expect(text(holdButton())).toBe("Unhold");
    click(holdButton());
    await waitFor(() => world.holds.length === 1, "the unhold request");
    expect(world.holds).toEqual([{ id: 101, hold: false }]);
    await waitFor(() => text(q("pd-hold")) === "Hold", "the button to turn back into Hold");
  });

  it("a new joiner not in the payroll yet has no Hold, and says so", async () => {
    world.flags.set(101, { newJoinerParked: true });
    await openLoaded("/hr/payroll/details/101");
    await waitFor(() => !!q("pd-new-joiner"), "the new joiner chip");
    expect(q("pd-hold")).toBeNull();
    expect(text(must("pd-new-joiner"))).toBe("New joiner: not in the payroll yet");
  });

  it("is off, with the reason, when the login cannot change holds", async () => {
    world.month.canHold = false;
    await openLoaded("/hr/payroll/details/101");
    await waitFor(() => !!q("pd-hold") && (holdButton().parentElement?.title ?? "").includes("rights"), "the reason");
    expect(holdButton().disabled).toBe(true);
    expect(holdButton().parentElement!.title).toContain("payroll edit rights");
  });

  it("is not offered on a production payroll", async () => {
    await openLoaded("/hr/production-payroll/details/301");
    expect(q("pd-hold")).toBeNull();
    expect(world.requests().some((r) => r.startsWith("/api/payroll/month-status"))).toBe(false);
  });
});

describe("a finalized month (Payroll Done)", () => {
  it("locks Hold and Mark as Cleared and says why", async () => {
    world.month.locked = true;
    await openLoaded("/hr/payroll/details/101");
    await waitFor(() => !!q("pd-locked"), "the lock chip");
    expect(text(must("pd-locked"))).toBe("Month finalized");
    expect(holdButton().disabled).toBe(true);
    expect(holdButton().parentElement!.title).toContain("finalized (Payroll Done)");
    const markCleared = must("pd-mark-paid") as HTMLButtonElement;
    expect(markCleared.disabled).toBe(true);
    expect(markCleared.parentElement!.title).toContain("finalized");
    click(holdButton());
    expect(world.holds).toEqual([]);
  });

  it("an employee paid separately shows that, and no Hold", async () => {
    world.month.locked = true;
    world.flags.set(101, { releasedFrom: "hold", paymentStatus: "paid", paymentPaidAt: "2026-11-12T06:30:00Z" });
    await openLoaded("/hr/payroll/details/101");
    await waitFor(() => !!q("pd-paid"), "the paid chip");
    expect(text(must("pd-paid"))).toBe("Paid 12 Nov 2026");
    expect(q("pd-hold")).toBeNull();
  });
});
