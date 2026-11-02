import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCENT } from "./accent";
import { clBalance, hrEdit, productionOptions, staffOptions } from "./edit-fixtures";

// The day panel's attendance-edit section: it names the employee's Department Head, or says plainly that there is none;
// and its form draws the server's option catalogue (Worked / Compensation / Not worked, then Permission, Late, Casual Leave,
// On-Duty), greys out what cannot be chosen with the server's reason, and sends each option's own payload.

const h = vi.hoisted(() => ({ ctx: vi.fn(), submit: vi.fn(), toast: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  useAttendanceEditContext: h.ctx,
  useSubmitAttendanceEdit: () => ({ mutateAsync: h.submit, isPending: false }),
}));

import { DayAttendanceEdit } from "./DayAttendanceEdit";

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  h.submit.mockReset();
  h.submit.mockResolvedValue({ ok: true, pendingApproval: true, request: { id: 41 } });
  h.toast.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const base = {
  employee: { id: 7, code: "E7", name: "Asha Kumar", employmentType: "staff" },
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

const HOD = { name: "Joshy G", code: "E55", canApprove: true };

function show(hod: unknown, extra: Record<string, unknown> = {}) {
  h.ctx.mockReturnValue({ isLoading: false, isError: false, data: { ...base, hod, ...extra } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<DayAttendanceEdit employeeId={7} date="2026-09-11" accent={ACCENT.staff} />));
  return host;
}

const q = (el: Element, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => (el as HTMLElement).click());
const type = (el: Element | null, value: string) =>
  act(() => {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

/** Opens the form on the full catalogue (a staff day). */
function openForm(extra: Record<string, unknown> = {}) {
  const el = show(HOD, { options: staffOptions(), clBalance: clBalance(), ...extra });
  click(q(el, "pd-day-edit-open"));
  return el;
}

describe("DayAttendanceEdit", () => {
  it("names the assigned Department Head and shows every punch with the gap between them", () => {
    const el = show(HOD);
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

describe("the Edit Attendance options", () => {
  it("keeps the three groups and adds Permission, Late, Casual Leave and On-Duty, in that order", () => {
    const el = openForm();
    const groups = [...el.querySelectorAll('[role="group"][data-testid^="pd-edit-group-"]')];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Worked",
      "Compensation",
      "Not worked",
      "Permission",
      "Late",
      "Casual Leave",
      "On-Duty",
    ]);
    // the first three read as they always did
    expect(text(q(el, "pd-edit-group-worked"))).toContain("How much of the day was worked");
    expect(text(q(el, "pd-edit-type-half_day"))).toContain("0.50 shift");
    // the newer four sit together under them
    expect(q(el, "pd-edit-more-options")!.querySelectorAll('[role="group"]')).toHaveLength(4);
    expect(text(q(el, "pd-edit-group-permission"))).toContain(
      "Counts as an approved permission (uses the monthly allowance)",
    );
    expect(
      [...q(el, "pd-edit-group-permission")!.querySelectorAll("button")].map((b) => text(b.querySelector("span"))),
    ).toEqual(["Morning Late-In", "Evening Early-Out", "Middle One-Hour"]);
    expect(text(q(el, "pd-edit-group-late"))).toContain("Mark as Late");
    expect(text(q(el, "pd-edit-group-late"))).toContain("Unmark Late");
  });

  it("greys out what cannot be chosen for the day and says why", () => {
    const el = openForm();
    const taken = q(el, "pd-edit-type-permission-morning_late_in") as HTMLButtonElement;
    expect(taken.disabled).toBe(true);
    expect(text(q(el, "pd-edit-type-permission-morning_late_in-reason"))).toBe(
      "02 Nov 2026 already has an approved Morning Late-In permission.",
    );
    expect((q(el, "pd-edit-type-late-mark") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q(el, "pd-edit-type-late-mark"))).toContain("02 Nov 2026 is already marked Late.");
    expect((q(el, "pd-edit-type-late-unmark") as HTMLButtonElement).disabled).toBe(false);
    expect((q(el, "pd-edit-type-casual_leave-full") as HTMLButtonElement).disabled).toBe(true);
    // clicking a greyed-out tile chooses nothing
    click(taken);
    expect(q(el, "pd-day-edit-details")).toBeNull();
  });

  it("shows the employee's Casual Leave balance, and what a portion would use of it", () => {
    const el = openForm({ clBalance: clBalance({ used: 1, pending: 0, remaining: 11 }) });
    expect(text(q(el, "pd-edit-cl-balance"))).toBe("11 of 12 left in 2026");
    click(q(el, "pd-edit-type-casual_leave-first_half"));
    expect(text(q(el, "pd-day-edit-details"))).toContain("Casual Leave · First half");
    expect(text(q(el, "pd-edit-cl-use"))).toBe("Uses 0.5 day of the balance: 11 of 12 left now, 10.5 once approved.");
  });

  it("says once that a production employee has no Permission or Casual Leave", () => {
    const el = show(HOD, { options: productionOptions(), clBalance: null });
    click(q(el, "pd-day-edit-open"));
    expect(text(q(el, "pd-edit-group-note-permission"))).toBe(
      "Permission applies to staff only: production attendance has no permissions.",
    );
    expect(text(q(el, "pd-edit-group-note-casual_leave"))).toBe("Casual Leave is available only for staff employees.");
    expect(q(el, "pd-edit-cl-balance")).toBeNull();
    const permissionTiles = [...q(el, "pd-edit-group-permission")!.querySelectorAll("button")];
    expect(permissionTiles.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(q(el, "pd-edit-type-permission-evening_early_out-reason")).toBeNull(); // said once, above
  });

  it("sends a permission as its type and choice, then refreshes and closes", async () => {
    const el = openForm();
    click(q(el, "pd-edit-type-permission-evening_early_out"));
    expect(text(q(el, "pd-day-edit-details"))).toContain("Permission · Evening Early-Out");
    expect(text(q(el, "pd-edit-permission-note"))).toContain("monthly permission allowance");
    // no punch times for a permission: the engine decides the day once it is approved
    expect(q(el, "pd-edit-first-in")).toBeNull();
    const send = q(el, "pd-day-edit-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(text(q(el, "pd-day-edit-hint"))).toBe("Write the reason to send it.");
    type(q(el, "pd-edit-reason"), "Bank work, told the supervisor");
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(h.submit).toHaveBeenCalledWith({
      employeeId: 7,
      date: "2026-09-11",
      type: "permission",
      note: "Bank work, told the supervisor",
      choice: "evening_early_out",
    });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Sent for approval" }));
    expect(h.toast.mock.calls[0][0].description).toContain("Permission · Evening Early-Out");
    expect(h.toast.mock.calls[0][0].description).toContain("goes to Joshy G first, then to HR");
    expect(q(el, "pd-day-edit-form")).toBeNull();
  });

  it("sends Unmark Late, a Casual Leave half and On-Duty with its destination", async () => {
    const el = openForm();
    click(q(el, "pd-edit-type-late-unmark"));
    type(q(el, "pd-edit-reason"), "Device clock was 20 minutes fast");
    await act(async () => (q(el, "pd-day-edit-send") as HTMLButtonElement).click());
    expect(h.submit).toHaveBeenLastCalledWith({
      employeeId: 7,
      date: "2026-09-11",
      type: "late",
      note: "Device clock was 20 minutes fast",
      choice: "unmark",
    });

    click(q(el, "pd-day-edit-open"));
    click(q(el, "pd-edit-type-casual_leave-second_half"));
    type(q(el, "pd-edit-reason"), "Asked by phone");
    await act(async () => (q(el, "pd-day-edit-send") as HTMLButtonElement).click());
    expect(h.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "casual_leave", choice: "second_half", note: "Asked by phone" }),
    );

    click(q(el, "pd-day-edit-open"));
    click(q(el, "pd-edit-type-on_duty"));
    type(q(el, "pd-edit-destination"), "Erode mill");
    type(q(el, "pd-edit-reason"), "Machine trial at the mill");
    await act(async () => (q(el, "pd-day-edit-send") as HTMLButtonElement).click());
    expect(h.submit).toHaveBeenLastCalledWith({
      employeeId: 7,
      date: "2026-09-11",
      type: "on_duty",
      note: "Machine trial at the mill",
      destination: "Erode mill",
    });
  });

  it("still sends an old type exactly as before", async () => {
    const el = openForm();
    click(q(el, "pd-edit-type-half_day"));
    expect(q(el, "pd-edit-first-in")).not.toBeNull(); // a worked type keeps its punch times
    type(q(el, "pd-edit-reason"), "Left at lunch");
    await act(async () => (q(el, "pd-day-edit-send") as HTMLButtonElement).click());
    expect(h.submit).toHaveBeenCalledWith({
      employeeId: 7,
      date: "2026-09-11",
      type: "half_day",
      note: "Left at lunch",
      shifts: undefined,
      firstPunch: "09:00:00",
      lastPunch: "13:00:00",
      isLate: false,
      isEarlyOut: false,
    });
  });

  it("shows the server's own sentence when it refuses, and keeps the form open", async () => {
    h.submit.mockRejectedValueOnce(
      Object.assign(new Error("HTTP 400 Bad Request: 11 Sep 2026 is not marked Late."), {
        data: { error: "11 Sep 2026 is not marked Late, so there is no Late mark to take away." },
      }),
    );
    const el = openForm();
    click(q(el, "pd-edit-type-late-unmark"));
    type(q(el, "pd-edit-reason"), "Wrongly marked");
    await act(async () => (q(el, "pd-day-edit-send") as HTMLButtonElement).click());
    expect(text(q(el, "pd-day-edit-error"))).toBe(
      "11 Sep 2026 is not marked Late, so there is no Late mark to take away.",
    );
    expect(q(el, "pd-day-edit-error")!.getAttribute("role")).toBe("alert");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not send",
        description: "11 Sep 2026 is not marked Late, so there is no Late mark to take away.",
        variant: "destructive",
      }),
    );
    expect(q(el, "pd-day-edit-form")).not.toBeNull();
    // choosing again clears it
    click(q(el, "pd-edit-type-on_duty"));
    expect(q(el, "pd-day-edit-error")).toBeNull();
  });

  it("shows where the day's last HR edit stands at the top of the form", () => {
    const el = openForm({ hrEdit: hrEdit() });
    const line = q(el, "pd-day-edit-hr-stage");
    expect(text(line)).toContain("This day's last HR edit: Half Day");
    expect(text(line)).toContain("Waiting for Department Head (Suresh Raj)");
    // it comes before the options
    const form = q(el, "pd-day-edit-form")!;
    const order = [...form.querySelectorAll('[data-testid="pd-day-edit-hr-stage"], [role="group"]')];
    expect(order[0].getAttribute("data-testid")).toBe("pd-day-edit-hr-stage");
  });
});
