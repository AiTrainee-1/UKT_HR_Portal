import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductionShifts } from "@/lib/api-client/custom-hooks";
import ProductionShiftsPanel, { ProductionAssignmentsView } from "./ProductionShiftsPanel";

// The Production shifts of Manage Shifts (owner 2026-11-16): the Settings groups appear as the default shifts with their
// detection timings and Earned Shift tables (edited in Settings), and special shifts are made, changed and assigned here.

const h = vi.hoisted(() => ({ fetch: vi.fn(), user: { current: null as Record<string, unknown> | null } }));

vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user.current }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => {} }) }));

const rule = (id: number, outTime: string, shiftValue: number, outNextDay = false) => ({
  id,
  label: "",
  outTime,
  outNextDay,
  shiftValue,
  enabled: true,
});

const DATA: ProductionShifts = {
  enabled: true,
  effectiveFrom: "2026-01-15",
  graceMinutes: 5,
  minCredit: 0,
  roundingStep: 0.01,
  fullDayValue: 1,
  breaks: [{ id: 1, label: "Lunch", startTime: "12:45", endTime: "13:30", enabled: true }],
  defaults: [
    {
      id: 1,
      label: "Day shift",
      kind: "day",
      appliesOn: "mon_sat",
      startTime: "08:30",
      firstPunchFrom: "06:00",
      firstPunchTo: "16:59",
      mainOutTime: "20:00",
      mainOutNextDay: false,
      enabled: true,
      rules: [rule(1, "10:30", 0.25), rule(2, "17:45", 1), rule(3, "05:30", 3, true)],
    },
    {
      id: 2,
      label: "Night shift",
      kind: "night",
      appliesOn: "mon_sat",
      startTime: "21:00",
      firstPunchFrom: "17:00",
      firstPunchTo: "05:59",
      mainOutTime: "06:30",
      mainOutNextDay: true,
      enabled: true,
      rules: [rule(4, "05:30", 1.5, true)],
    },
  ],
  special: [
    {
      id: 9,
      label: "Early loading",
      kind: "custom",
      appliesOn: "mon_sat",
      startTime: "06:00",
      firstPunchFrom: "06:00",
      firstPunchTo: "06:00",
      mainOutTime: "14:00",
      mainOutNextDay: false,
      enabled: true,
      rules: [rule(5, "14:00", 1)],
      activeCount: 1,
      everAssigned: true,
      assignments: [
        {
          id: 31,
          groupId: 9,
          employeeId: 7,
          employeeCode: "P-7",
          employeeName: "Kavi Worker",
          department: "Loading",
          effectiveFrom: "2026-11-01",
          effectiveTo: null,
          note: "",
          state: "active",
        },
        {
          id: 32,
          groupId: 9,
          employeeId: 8,
          employeeCode: "P-8",
          employeeName: "Mani Worker",
          department: "Loading",
          effectiveFrom: "2026-11-30",
          effectiveTo: null,
          note: "",
          state: "upcoming",
        },
      ],
    },
  ],
  roster: { production: 114, onSpecialToday: 1 },
  today: "2026-11-16",
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
const type = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root!.render(createElement(QueryClientProvider, { client }, node)));
}

beforeEach(() => {
  h.user.current = { role: "hr", isSuperAdmin: true, employeeId: null, permissions: {} };
  h.fetch.mockReset();
  h.fetch.mockImplementation(() => Promise.resolve(DATA));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

describe("the default production shifts come from Settings", () => {
  it("shows each Settings group with its detection timings and Earned Shift table, edited in Settings", async () => {
    mount(createElement(ProductionShiftsPanel));
    await settle();
    expect(h.fetch.mock.calls[0][0]).toBe("/api/shifts/production");
    expect(text(q("production-default-1-name"))).toBe("Day shift");
    const day = text(q("production-default-1-detections"));
    expect(day).toContain("On time until08:35");
    expect(day).toContain("Early out before19:55");
    expect(day).toContain("06:00 – 16:59");
    expect(day).toContain("Up to 3.00 shifts");
    expect(text(q("production-default-1-ladder"))).toContain("05:30 next day3.00");
    expect(text(q("production-default-2-detections"))).toContain("Early out before06:25 next day");
    expect(text(q("production-default-1"))).toContain("Default · from Settings");
    expect(text(q("production-default-1"))).toContain("Every production worker, except 1 on a special shift today");
    expect(q("production-shifts-settings-link")?.getAttribute("href")).toBe("/hr/settings?tab=production_shifts");
    expect(text(q("production-breaks"))).toContain("Lunch 12:45–13:30");
    // nothing on a default card can be edited here
    expect(q("special-edit-1")).toBeNull();
  });
});

describe("special shifts", () => {
  it("lists who is on them without a click: End for a running assignment, Remove for every one", async () => {
    mount(createElement(ProductionShiftsPanel));
    await settle();
    expect(text(q("production-special-9"))).toContain("Special");
    expect(text(q("production-special-9-detections"))).toContain("Only the workers put on it");
    expect(q("special-assignments-9-end-31")).not.toBeNull();
    expect(q("special-assignments-9-remove-31")).not.toBeNull();
    expect(q("special-assignments-9-end-32")).toBeNull(); // not started: nothing to end
    expect(q("special-assignments-9-remove-32")).not.toBeNull();
    // folded away on request
    act(() => q("special-people-9")!.click());
    expect(q("special-assignments-9")).toBeNull();
  });

  it("removes a worker who has started only after the confirmation, which says what happens to their days", async () => {
    mount(createElement(ProductionShiftsPanel));
    await settle();
    act(() => q("special-assignments-9-remove-31")!.click());
    expect(text(q("special-remove-dialog"))).toContain(
      "Their days from 01-11-2026 to 16-11-2026 are then worked out again",
    );
    expect(h.fetch.mock.calls.filter((c) => String(c[0]).includes("special-assignments/31"))).toEqual([]);
    act(() => q("special-remove-confirm")!.click());
    await settle();
    const call = h.fetch.mock.calls.find((c) => String(c[0]).includes("special-assignments/31"));
    expect(call![0]).toBe("/api/shifts/production/special-assignments/31?force=1");
    expect(call![1].method).toBe("DELETE");
  });

  it("removes a worker who has not started at once", async () => {
    mount(createElement(ProductionShiftsPanel));
    await settle();
    act(() => q("special-assignments-9-remove-32")!.click());
    await settle();
    expect(q("special-remove-dialog")).toBeNull();
    expect(h.fetch.mock.calls.some((c) => c[0] === "/api/shifts/production/special-assignments/32")).toBe(true);
  });

  it("deletes a special shift that had workers once confirmed, taking them off it", async () => {
    mount(createElement(ProductionShiftsPanel));
    await settle();
    act(() => q("special-delete-9")!.click());
    expect(text(q("special-delete-dialog"))).toContain("2 assignments go with it");
    act(() => q("special-delete-confirm")!.click());
    await settle();
    const call = h.fetch.mock.calls.find((c) => String(c[0]).startsWith("/api/shifts/production/special/9"));
    expect(call![0]).toBe("/api/shifts/production/special/9?force=1");
    expect(call![1].method).toBe("DELETE");
  });

  it("makes a new one with its own Earned Shift table, values sent as numbers", async () => {
    mount(createElement(ProductionShiftsPanel));
    await settle();
    act(() => q("production-special-new")!.click());
    type(q("special-name") as HTMLInputElement, "Late loading");
    type(q("special-start") as HTMLInputElement, "10:00");
    type(q("special-out") as HTMLInputElement, "18:00");
    type(q("special-row-0-time") as HTMLInputElement, "18:00");
    type(q("special-row-0-value") as HTMLInputElement, "1.25");
    h.fetch.mockImplementation((url: string) =>
      Promise.resolve(url === "/api/shifts/production/special" ? DATA : DATA),
    );
    act(() => q("special-save")!.click());
    await settle();
    const call = h.fetch.mock.calls.find((c) => c[0] === "/api/shifts/production/special");
    expect(call).toBeTruthy();
    expect(call![1].method).toBe("POST");
    expect(JSON.parse(call![1].body)).toEqual({
      label: "Late loading",
      appliesOn: "mon_sat",
      startTime: "10:00",
      mainOutTime: "18:00",
      mainOutNextDay: false,
      enabled: true,
      rules: [{ label: "", outTime: "18:00", outNextDay: false, shiftValue: 1.25, enabled: true }],
    });
  });

  it("says what to fix before asking the server", async () => {
    mount(createElement(ProductionShiftsPanel));
    await settle();
    act(() => q("production-special-new")!.click());
    act(() => q("special-save")!.click());
    expect(text(q("special-error"))).toBe("Give the special shift a name.");
    expect(h.fetch.mock.calls.filter((c) => c[0] === "/api/shifts/production/special")).toEqual([]);
  });

  it("a role without the special shifts feature sees them but cannot change them", async () => {
    h.user.current = {
      role: "hr",
      isSuperAdmin: false,
      employeeId: null,
      permissions: { shifts: "edit", "shifts.production_special": "hidden" },
    };
    mount(createElement(ProductionShiftsPanel));
    await settle();
    expect(q("production-special-9")).not.toBeNull();
    expect(q("production-special-new")).toBeNull();
    expect(q("special-edit-9")).toBeNull();
    expect(q("special-assign-9")).toBeNull();
  });
});

describe("the Assignments tab (Production)", () => {
  it("lists the special-shift assignments and says everyone else is on the Settings shifts", async () => {
    mount(createElement(ProductionAssignmentsView));
    await settle();
    expect(text(q("production-assignments-view"))).toContain(
      "All 114 production workers are on the default production shifts",
    );
    expect(text(q("production-assignments-row-31"))).toContain("Early loading");
    expect(text(q("production-assignments-row-32"))).toContain("Starts later");
  });
});
