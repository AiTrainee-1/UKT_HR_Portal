import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ACCENT } from "./accent";

// The day panel's attendance-edit section: it names the employee's Department Head, or says plainly that there is none.

const h = vi.hoisted(() => ({ ctx: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }), toast: vi.fn() }));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  useAttendanceEditContext: h.ctx,
  useSubmitAttendanceEdit: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { DayAttendanceEdit } from "./DayAttendanceEdit";

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const base = {
  employee: { id: 7, code: "E7", name: "Asha Kumar" },
  date: "2026-09-11",
  day: { date: "2026-09-11", firstPunch: "09:00:00", lastPunch: "13:00:00", isLate: false, earlyLeave: false },
  future: false,
  pipeline: { steps: [], path: "HR > HOD > HR" },
  types: [
    {
      key: "half_day",
      label: "Half Day",
      group: "Attendance",
      shifts: "0.50",
      worked: true,
      shiftChoices: [],
      description: "Half a day",
    },
  ],
  punches: [
    { id: 1, time: "09:00:00", type: "IN", source: "device", sourceLabel: "Biometric", device: "SN1", recordedAt: "" },
    { id: 2, time: "13:00:00", type: "OUT", source: "device", sourceLabel: "Biometric", device: "SN1", recordedAt: "" },
  ],
  canEdit: true,
  requests: [],
};

function show(hod: unknown) {
  h.ctx.mockReturnValue({ isLoading: false, isError: false, data: { ...base, hod } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<DayAttendanceEdit employeeId={7} date="2026-09-11" accent={ACCENT.staff} />));
  return host;
}

describe("DayAttendanceEdit", () => {
  it("names the assigned Department Head and shows every punch with the gap between them", () => {
    const el = show({ name: "Joshy G", code: "E55", canApprove: true });
    expect(el.querySelector('[data-testid="pd-day-edit-hod"]')?.textContent).toContain("Joshy G");
    expect(el.querySelector('[data-testid="pd-day-edit-hod"]')?.textContent).toContain("E55");
    expect(el.querySelector('[data-testid="pd-day-edit-no-hod"]')).toBeNull();
    expect(el.querySelectorAll('[data-testid="pd-day-punch"]')).toHaveLength(2);
    expect(el.textContent).toContain("4h 00m later");
  });

  it("says plainly that no Department Head is assigned and blocks sending", () => {
    const el = show(null);
    expect(el.querySelector('[data-testid="pd-day-edit-no-hod"]')?.textContent).toContain(
      "No Department Head assigned",
    );
    act(() => (el.querySelector('[data-testid="pd-day-edit-open"]') as HTMLButtonElement).click());
    act(() => (el.querySelector('[data-testid="pd-edit-type-half_day"]') as HTMLButtonElement).click());
    expect((el.querySelector('[data-testid="pd-day-edit-send"]') as HTMLButtonElement).disabled).toBe(true);
    expect(el.textContent).toContain("Assign a Department Head to send this.");
  });
});
