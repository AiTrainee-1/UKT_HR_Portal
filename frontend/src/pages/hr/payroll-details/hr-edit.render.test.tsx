import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayrollDay } from "@/lib/api-client/custom-hooks";
import { hrEdit } from "./edit-fixtures";
import { staffDetails } from "./fixtures";
import {
  all,
  click,
  installBrowserStubs,
  installWorld,
  must,
  openLoaded,
  press,
  q,
  text,
  unmountPage,
  waitFor,
  type World,
} from "./harness";
import { dayKind } from "./logic";

// The "!" on every day HR edited (owner 2026-11-02), on the payroll details calendar: amber while it waits, green once
// applied, rose when rejected; a click (or Enter / Space: it is a real button) says what was changed and where the approval
// stands. The day's own colour does not change.

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

const WAITING = hrEdit();
const APPLIED = hrEdit({
  requestId: 42,
  status: "applied",
  stageLabel: "Applied - approved by Suresh Raj (Department Head) and Meena (HR) on 02 Nov 2026",
  from: { label: "Present", shifts: 1 },
  to: { label: "Permission · Morning Late-In", shifts: null },
  option: "permission",
  type: "permission",
  typeLabel: "Permission · Morning Late-In",
  decidedBy: "Meena",
  decidedAt: "2026-11-02T08:00:00Z",
});
const REJECTED = hrEdit({
  requestId: 43,
  status: "rejected",
  stageLabel: "Rejected by Suresh Raj (Department Head) on 02 Nov 2026: The employee was at the desk",
  to: { label: "Absent", shifts: 0 },
  option: "not_worked",
  type: "absent",
  typeLabel: "Absent",
  comment: "The employee was at the desk",
  decidedBy: "Suresh Raj",
  decidedAt: "2026-11-02T07:00:00Z",
});
const SUNDAY = hrEdit({
  requestId: 44,
  status: "waiting_hr",
  stageLabel: "Waiting for HR (Department Head Suresh Raj approved on 02 Nov 2026)",
  from: { label: "Holiday", shifts: 0 },
  to: { label: "Sunday Compensation", shifts: 1 },
  option: "compensation",
  type: "sunday_compensation",
  typeLabel: "Sunday Compensation",
});

/** Payroll 101 with HR edits on two listed days and on two Sundays (one nobody worked, one worked). */
function withEdits() {
  const base = staffDetails();
  const edits: Record<string, PayrollDay["hrEdit"]> = {
    "2026-10-06": WAITING,
    "2026-10-07": APPLIED,
    "2026-10-08": REJECTED,
  };
  world.staff.set(
    101,
    staffDetails({
      days: base.days.map((d) => (edits[d.date] ? { ...d, hrEdit: edits[d.date] } : d)),
      offDays: [
        { date: "2026-10-04", kind: "weekly_off", name: null, attendance: null, hrEdit: SUNDAY },
        {
          date: "2026-10-11",
          kind: "weekly_off",
          name: null,
          hrEdit: hrEdit({ requestId: 45, status: "applied", stageLabel: "Applied", typeLabel: "Present" }),
          attendance: {
            date: "2026-10-11",
            day: "Sunday",
            status: "present",
            firstIn: "09:00",
            lastOut: "17:30",
            shifts: 1,
            flags: [],
            marks: [],
            note: null,
            isSunday: true,
            hrEdit: hrEdit({ requestId: 45, status: "applied", stageLabel: "Applied", typeLabel: "Present" }),
          },
        },
      ],
    }),
  );
  return base;
}

const openStaff = () => openLoaded("/hr/payroll/details/101", { fromPayroll: true });
const badge = (date: string) => q(`pd-hr-edit-${date}`);
const popover = () => document.body.querySelector<HTMLElement>('[data-testid="pd-hr-edit-popover"]');

describe("the ! on a day HR edited", () => {
  it("marks every edited day (listed days, Sundays, worked Sundays) and no other", async () => {
    withEdits();
    await openStaff();
    expect(all("pd-day-2026-10-06")).toHaveLength(1);
    const marked = [...document.body.querySelectorAll('[data-testid^="pd-hr-edit-2026-"]')].map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(marked.sort()).toEqual([
      "pd-hr-edit-2026-10-04",
      "pd-hr-edit-2026-10-06",
      "pd-hr-edit-2026-10-07",
      "pd-hr-edit-2026-10-08",
      "pd-hr-edit-2026-10-11",
    ]);
    expect(badge("2026-10-05")).toBeNull();
    // a real button beside the day's own button, never inside it
    const b = badge("2026-10-06")!;
    expect(b.tagName).toBe("BUTTON");
    expect(b.getAttribute("type")).toBe("button");
    expect(b.closest('[data-testid="pd-day-2026-10-06"]')).toBeNull();
    expect(b.getAttribute("aria-label")).toBe("HR edit: Half Day. Waiting for Department Head (Suresh Raj)");
    expect(b.getAttribute("aria-haspopup")).toBe("dialog");
    // it only reads, so a View Only role can open it
    expect(b.closest("[data-view-safe]")).not.toBeNull();
  });

  it("is amber while it waits, green once applied, rose when rejected", async () => {
    withEdits();
    await openStaff();
    expect(badge("2026-10-06")!.dataset.status).toBe("waiting_hod");
    expect(badge("2026-10-06")!.className).toContain("bg-amber-500");
    expect(badge("2026-10-04")!.className).toContain("bg-amber-500"); // waiting for HR
    expect(badge("2026-10-07")!.className).toContain("bg-emerald-600");
    expect(badge("2026-10-08")!.className).toContain("bg-rose-600");
    expect(text(q("pd-hr-edit-legend"))).toContain("Edited by HR: 5 days");
  });

  it("leaves the day's own colour as it was", async () => {
    const base = withEdits();
    await openStaff();
    for (const date of ["2026-10-06", "2026-10-07", "2026-10-08"]) {
      const day = base.days.find((d) => d.date === date)!;
      expect(must(`pd-day-${date}`).dataset.kind).toBe(dayKind(day));
      expect(must(`pd-day-${date}`).className).not.toMatch(/amber-500|emerald-600|rose-600/);
    }
    expect(must("pd-day-2026-10-04").dataset.kind).toBe("weekoff");
    expect(must("pd-day-2026-10-11").dataset.kind).toBe("sunday_worked");
    expect(must("pd-day-2026-10-06").getAttribute("aria-label")).toContain("edited by HR (waiting for approval)");
  });

  it("opens what was changed and where the approval stands, without choosing the day", async () => {
    withEdits();
    await openStaff();
    expect(popover()).toBeNull();
    click(badge("2026-10-06"));
    await waitFor(() => !!popover(), "the popover to open");
    const box = popover()!;
    expect(box.closest("[data-view-safe]")).not.toBeNull();
    expect(text(box.querySelector('[data-testid="pd-hr-edit-type"]'))).toBe("Half Day");
    // the arrow is a picture; a screen reader hears "to"
    expect(text(box.querySelector('[data-testid="pd-hr-edit-change"]'))).toBe(
      "Present (1 shift) to Half Day (0.5 shifts)",
    );
    expect(box.querySelector('[data-testid="pd-hr-edit-change"]')!.getAttribute("title")).toBe(
      "Present (1 shift) → Half Day (0.5 shifts)",
    );
    expect(text(box.querySelector('[data-testid="pd-hr-edit-stage"]'))).toBe(
      "Waiting for Department Head (Suresh Raj)",
    );
    expect(text(box.querySelector('[data-testid="pd-hr-edit-reason"]'))).toBe("Left at lunch for a family function");
    expect(text(box.querySelector('[data-testid="pd-hr-edit-raised"]'))).toMatch(
      /^Meena \(HR\) · 2 Nov 2026, \d\d:\d\d$/,
    );
    expect(box.querySelector('[data-testid="pd-hr-edit-decided"]')).toBeNull(); // nobody has decided yet
    expect(badge("2026-10-06")!.getAttribute("aria-expanded")).toBe("true");
    // the day itself was not chosen
    expect(q("pd-day-panel")).toBeNull();
    // Escape closes it
    press(document.activeElement ?? box, "Escape");
    await waitFor(() => !popover(), "the popover to close");
  });

  it("names who decided, and their comment, once it is decided", async () => {
    withEdits();
    await openStaff();
    click(badge("2026-10-08"));
    await waitFor(() => !!popover(), "the popover to open");
    const box = popover()!;
    expect(text(box.querySelector('[data-testid="pd-hr-edit-stage"]'))).toContain("Rejected by Suresh Raj");
    expect(text(box.querySelector('[data-testid="pd-hr-edit-decided"]'))).toMatch(/^Suresh Raj · 2 Nov 2026/);
    expect(text(box)).toContain("Rejected by");
    expect(text(box.querySelector('[data-testid="pd-hr-edit-comment"]'))).toBe("Comment: The employee was at the desk");
    expect(text(box.querySelector('[data-testid="pd-hr-edit-change"]'))).toBe("Present (1 shift) to Absent");
  });

  it("works on a Sunday nobody worked, and the chosen day's panel spells the edit out", async () => {
    withEdits();
    await openStaff();
    click(badge("2026-10-04"));
    await waitFor(() => !!popover(), "the popover to open");
    expect(text(popover())).toContain("Sunday Compensation");
    expect(text(popover()!.querySelector('[data-testid="pd-hr-edit-change"]'))).toBe(
      "Holiday to Sunday Compensation (1 shift)",
    );
    expect(text(popover())).toContain("Waiting for HR (Department Head Suresh Raj approved on 02 Nov 2026)");
    press(document.activeElement ?? popover()!, "Escape");
    await waitFor(() => !popover(), "the popover to close");

    click(must("pd-day-2026-10-07"));
    const panel = must("pd-day-hr-edit");
    expect(text(panel)).toContain("Permission · Morning Late-In");
    expect(text(panel)).toContain("Applied - approved by Suresh Raj (Department Head) and Meena (HR) on 02 Nov 2026");
    expect(text(panel)).toMatch(/Decided by\s*Meena · 2 Nov 2026/);
  });

  it("shows the ! beside the status in the table too", async () => {
    withEdits();
    await openStaff();
    click(must("pd-view-table"));
    await waitFor(() => !!q("pd-days-table"), "the table");
    const row = must("pd-row-2026-10-07");
    expect(row.querySelector('[data-testid="pd-hr-edit-2026-10-07"]')).not.toBeNull();
    expect(must("pd-row-2026-10-05").querySelector('[data-testid^="pd-hr-edit-"]')).toBeNull();
  });

  it("shows no ! and no key when HR edited nothing", async () => {
    await openStaff();
    expect(document.body.querySelector('[data-testid^="pd-hr-edit-2026-"]')).toBeNull();
    expect(q("pd-hr-edit-legend")).toBeNull();
  });
});
