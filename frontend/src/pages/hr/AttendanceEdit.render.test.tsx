import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clBalance, hrEdit, staffOptions } from "./payroll-details/edit-fixtures";

// The Attendance Edit page (the pencil on a day in Employee Attendance Search): the 11 attendance types as before, plus
// the newer options the payroll details panel has (Permission, Late, Casual Leave, On-Duty), each sending its own payload.

const h = vi.hoisted(() => ({ ctx: vi.fn(), submit: vi.fn(), toast: vi.fn(), navigate: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  useAttendanceEditContext: h.ctx,
  useSubmitAttendanceEdit: () => ({ mutateAsync: h.submit, isPending: false }),
}));
vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
  useLocation: () => ["/hr/attendance/edit/7/2026-11-02", h.navigate],
  useParams: () => ({ employeeId: "7", date: "2026-11-02" }),
  useSearch: () => "",
}));

import AttendanceEdit from "./AttendanceEdit";

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  h.submit.mockReset();
  h.submit.mockResolvedValue({ ok: true, pendingApproval: true, request: { id: 41 } });
  h.toast.mockReset();
  h.navigate.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const base = {
  employee: { id: 7, code: "E7", name: "Asha Kumar", employmentType: "staff", department: "Cutting", designation: null },
  date: "2026-11-02",
  day: {
    date: "2026-11-02",
    day: "Monday",
    status: "present",
    source: "auto",
    shiftsEarned: "1.00",
    firstPunch: "09:00:00",
    lastPunch: "18:00:00",
    isLate: false,
    earlyLeave: false,
  },
  future: false,
  hod: { name: "Joshy G", code: "E55", canApprove: true },
  pipeline: { steps: [], path: "HOD > HR" },
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
  punches: [],
  canEdit: true,
  requests: [],
  options: staffOptions(),
  clBalance: clBalance({ used: 0, pending: 0, remaining: 12 }),
};

function show(extra: Record<string, unknown> = {}) {
  h.ctx.mockReturnValue({ isLoading: false, isError: false, data: { ...base, ...extra } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<AttendanceEdit />));
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

describe("the Attendance Edit page", () => {
  it("shows the 11 types as before and the four newer options under them", () => {
    const el = show();
    expect(q(el, "edit-type-half_day")).not.toBeNull();
    const groups = [...q(el, "edit-more-options")!.querySelectorAll('[role="group"]')];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Permission", "Late", "Casual Leave", "On-Duty"]);
    expect(text(q(el, "pd-edit-cl-balance"))).toBe("12 of 12 left in 2026");
  });

  it("still sends an old type exactly as before", async () => {
    const el = show();
    click(q(el, "edit-type-half_day"));
    expect(text(q(el, "edit-details"))).toContain("Half Day");
    expect(q(el, "edit-first-in")).not.toBeNull(); // a worked type takes the punch times
    type(q(el, "edit-reason"), "Left at lunch, told HR");
    await act(async () => (q(el, "edit-send") as HTMLButtonElement).click());
    expect(h.submit).toHaveBeenCalledWith({
      employeeId: 7,
      date: "2026-11-02",
      type: "half_day",
      note: "Left at lunch, told HR",
      shifts: undefined,
      firstPunch: "09:00:00",
      lastPunch: "18:00:00",
      isLate: false,
      isEarlyOut: false,
    });
    expect(h.navigate).toHaveBeenCalledWith("/hr/attendance/staff");
  });

  it("sends a Casual Leave half with its choice, and says what it uses of the balance", async () => {
    const el = show();
    click(q(el, "pd-edit-type-casual_leave-second_half"));
    expect(text(q(el, "edit-details"))).toContain("Casual Leave · Second half");
    expect(text(q(el, "edit-cl-use"))).toBe("Uses 0.5 day of the balance: 12 of 12 left now, 11.5 once approved.");
    expect(q(el, "edit-first-in")).toBeNull(); // no punch times for the newer options
    type(q(el, "edit-reason"), "Hospital visit");
    await act(async () => (q(el, "edit-send") as HTMLButtonElement).click());
    expect(h.submit).toHaveBeenCalledWith({
      employeeId: 7,
      date: "2026-11-02",
      type: "casual_leave",
      note: "Hospital visit",
      choice: "second_half",
    });
  });

  it("sends On-Duty with where the employee was", async () => {
    const el = show();
    click(q(el, "pd-edit-type-on_duty"));
    type(q(el, "edit-destination"), "Buyer visit, Tiruppur");
    type(q(el, "edit-reason"), "Sent by the GM");
    await act(async () => (q(el, "edit-send") as HTMLButtonElement).click());
    expect(h.submit).toHaveBeenCalledWith({
      employeeId: 7,
      date: "2026-11-02",
      type: "on_duty",
      note: "Sent by the GM",
      destination: "Buyer visit, Tiruppur",
    });
  });

  it("keeps the page open and shows the server's sentence when it refuses", async () => {
    h.submit.mockRejectedValue(Object.assign(new Error("HTTP 400"), { data: { error: "No Casual Leave left in 2026." } }));
    const el = show();
    click(q(el, "pd-edit-type-casual_leave-first_half"));
    type(q(el, "edit-reason"), "Family function");
    await act(async () => (q(el, "edit-send") as HTMLButtonElement).click());
    expect(text(q(el, "edit-error"))).toBe("No Casual Leave left in 2026.");
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("does not let a greyed-out option be sent, and shows where the day's last HR edit stands", () => {
    const el = show({ hrEdit: hrEdit() });
    expect(el.textContent).toContain(hrEdit().stageLabel);
    const taken = q(el, "pd-edit-type-permission-morning_late_in") as HTMLButtonElement;
    expect(taken.disabled).toBe(true);
    click(taken);
    expect(q(el, "edit-details")).toBeNull();
    expect((q(el, "edit-send") as HTMLButtonElement).disabled).toBe(true);
  });
});
