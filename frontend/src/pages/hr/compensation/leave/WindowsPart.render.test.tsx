import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lockMutatingControls } from "@/lib/view-only-lock";
import {
  apiError,
  bodiesOf,
  click,
  freezeClock,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  pickOption,
  q,
  settle,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "../harness";

// Compensation Leave A in jsdom: announcing a late-in or an early-out for a date, the list of announcements with who announced
// each and how many staff it covers, deleting a future one, and the notices for what is switched off.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as { branchId?: number | null } | null },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "t", user: h.user.current }) }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  h.user.current = null;
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
});

const WINDOWS = "/api/compensation/windows";

async function openWindows() {
  mountPage("/hr/compensation?tab=leave");
  await waitFor(() => !!q("windows-upcoming"), "the announcements");
}

const input = (id: string) => must(id) as HTMLInputElement;
const button = (id: string) => must(id) as HTMLButtonElement;
const rowIds = (id: string) => [...must(id).querySelectorAll("tbody tr")].map((r) => r.getAttribute("data-testid"));

describe("Compensation Leave opens on A", () => {
  it("has the three parts as tabs, A first", async () => {
    await openWindows();
    const parts = [...document.body.querySelectorAll('[role="tab"]')].map(text);
    expect(parts.some((t) => t.startsWith("A. Announce late-in / early-out"))).toBe(true);
    expect(parts.some((t) => t.startsWith("B. Work on Sundays and company holidays"))).toBe(true);
    expect(parts.some((t) => t.startsWith("C. Birthdays"))).toBe(true);
  });

  it("explains what an announcement does", async () => {
    await openWindows();
    const explain = text(q("windows-explain"));
    expect(explain).toContain("everyone covered may arrive up to the time");
    expect(explain).toContain("The shift's start and its grace do not apply");
    expect(explain).toContain("everyone covered may leave from the time");
    expect(explain).toContain("a day nobody attended is still absent");
  });
});

describe("the list of announcements", () => {
  it("separates today and upcoming from earlier, with who announced and how many staff it covers", async () => {
    await openWindows();
    expect(rowIds("windows-upcoming")).toEqual(["window-row-901"]);
    expect(rowIds("windows-earlier")).toEqual(["window-row-900", "window-row-899"]);
    const upcoming = text(q("window-row-901"));
    expect(upcoming).toContain("Tue, 20 Oct 2026");
    expect(upcoming).toContain("Late-in");
    expect(upcoming).toContain("Arrive up to 10:30 AM");
    expect(upcoming).toContain("Heavy rain");
    expect(upcoming).toContain("214 staff");
    expect(upcoming).toContain("all staff");
    expect(upcoming).toContain("Meena");
    const earlyOut = text(q("window-row-900"));
    expect(earlyOut).toContain("Early-out");
    expect(earlyOut).toContain("Leave from 4:00 PM");
  });

  it("still lists an older Compensation Day, named as such, and never offers to delete it", async () => {
    await openWindows();
    const older = text(q("window-row-899"));
    expect(older).toContain("Compensation Day (older kind)");
    expect(older).toContain("Whole day exempt from Late / Permission");
    expect(q("window-delete-899")).toBeNull();
  });

  it("offers Delete only on a future date", async () => {
    await openWindows();
    expect(q("window-delete-901")).not.toBeNull();
    expect(q("window-delete-900")).toBeNull();
  });

  it("says which department or branch an announcement covers", async () => {
    world.windows[0] = {
      ...world.windows[0],
      allStaff: false,
      department: "Cutting",
      departmentId: 3,
      branch: "Head Office",
      branchId: 2,
      covers: 40,
    };
    await openWindows();
    expect(text(q("window-row-901"))).toContain("40 staff");
    expect(text(q("window-row-901"))).toContain("Cutting staff of Head Office");
  });

  it("is an invitation to announce when there is none yet", async () => {
    world.windows = [];
    mountPage("/hr/compensation?tab=leave");
    await waitFor(() => !!q("windows-empty"), "the empty state");
    expect(text(q("windows-empty"))).toContain("No announcement yet");
  });

  it("shows rows' shape while loading, and an error with a Retry", async () => {
    const release = world.hold(WINDOWS);
    mountPage("/hr/compensation?tab=leave");
    await waitFor(() => !!q("windows-list"), "the list");
    expect(q("skeleton-rows")).not.toBeNull();
    release();
    await waitFor(() => !!q("windows-upcoming"), "the rows");
    unmountPage();

    world.failing.set(WINDOWS, { status: 500 });
    mountPage("/hr/compensation?tab=leave");
    await waitFor(() => !!q("windows-error"), "the error");
    expect(text(q("windows-error"))).toContain("Could not load the announcements");
    world.failing.clear();
    click([...must("windows-error").querySelectorAll("button")].find((b) => text(b) === "Retry"));
    await waitFor(() => !!q("windows-upcoming"), "the rows");
  });
});

describe("announcing", () => {
  it("starts today, as a late-in, with the date limited to today and 180 days ahead", async () => {
    await openWindows();
    expect(input("window-date").value).toBe("2026-10-14");
    expect(input("window-date").min).toBe("2026-10-14");
    expect(input("window-date").max).toBe("2027-04-12");
    expect(must("window-kind-late_in").getAttribute("aria-checked")).toBe("true");
    expect(must("window-kind-early_out").getAttribute("aria-checked")).toBe("false");
    expect(button("window-submit").disabled).toBe(false);
    expect(text(button("window-submit"))).toBe("Add announcement");
  });

  it("says what is missing instead of sending an incomplete announcement", async () => {
    await openWindows();
    click(must("window-submit"));
    await settle();
    const form = text(q("windows-form"));
    expect(form).toContain("Enter the latest arrival time.");
    expect(form).toContain("Give a reason");
    expect(bodiesOf(world, "POST", WINDOWS)).toEqual([]);
    typeInto(input("window-time"), "10:30");
    expect(text(q("windows-form"))).not.toContain("Enter the latest arrival time.");
  });

  it("explains what it will do as the form is filled, and sends it", async () => {
    await openWindows();
    typeInto(input("window-date"), "2026-10-20");
    typeInto(input("window-time"), "10:30");
    typeInto(must("window-reason") as unknown as HTMLInputElement, "Heavy rain");
    expect(text(q("window-summary"))).toContain("On Tue, 20 Oct 2026, all staff may arrive up to 10:30 AM.");
    expect(text(q("window-summary"))).toContain("nobody arriving by 10:30 AM is marked Late");
    click(must("window-submit"));
    await waitFor(() => bodiesOf(world, "POST", WINDOWS).length === 1, "the request");
    expect(bodiesOf(world, "POST", WINDOWS)[0]).toEqual({
      date: "2026-10-20",
      kind: "late_in",
      time: "10:30",
      reason: "Heavy rain",
      branchId: null,
      departmentId: null,
    });
    // the new announcement is in the list, and the form is ready for the next one
    await waitFor(() => !!q("window-row-950"), "the new row");
    expect(text(q("window-row-950"))).toContain("Arrive up to 10:30 AM");
    expect(input("window-time").value).toBe("");
    expect((must("window-reason") as unknown as HTMLTextAreaElement).value).toBe("");
    expect(input("window-date").value).toBe("2026-10-20");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Announcement added" }));
  });

  it("announces an early-out with its own time label", async () => {
    await openWindows();
    click(must("window-kind-early_out"));
    expect(must("window-kind-early_out").getAttribute("aria-checked")).toBe("true");
    expect(text(q("windows-form"))).toContain("Earliest leaving time");
    typeInto(input("window-time"), "16:00");
    typeInto(must("window-reason") as unknown as HTMLInputElement, "Transport strike");
    expect(text(q("window-summary"))).toContain("may leave from 4:00 PM");
    click(must("window-submit"));
    await waitFor(() => bodiesOf(world, "POST", WINDOWS).length === 1, "the request");
    expect(bodiesOf(world, "POST", WINDOWS)[0]).toMatchObject({ kind: "early_out", time: "16:00" });
  });

  it("can be limited to a department, and a branch", async () => {
    await openWindows();
    pickOption(must("window-dept"), "Cutting");
    pickOption(must("window-branch"), "Unit 2");
    typeInto(input("window-time"), "10:30");
    typeInto(must("window-reason") as unknown as HTMLInputElement, "Power cut");
    expect(text(q("window-summary"))).toContain("Cutting staff of Unit 2 may arrive");
    click(must("window-submit"));
    await waitFor(() => bodiesOf(world, "POST", WINDOWS).length === 1, "the request");
    expect(bodiesOf(world, "POST", WINDOWS)[0]).toMatchObject({ departmentId: 3, branchId: 5 });
  });

  it("does not offer a branch to a login that sees one branch only", async () => {
    h.user.current = { branchId: 2 };
    await openWindows();
    expect(q("window-branch")).toBeNull();
    expect(q("window-dept")).not.toBeNull();
    expect(world.requests().some((r) => r.startsWith("/api/branches"))).toBe(false);
  });

  it("shows the server's own sentence when it refuses, and adds nothing", async () => {
    world.on.set(`POST ${WINDOWS}`, () =>
      apiError(400, {
        error:
          "A late-in window is already announced for 20 Oct 2026 (10:30, by Meena) and it covers 214 of the same people.",
      }),
    );
    await openWindows();
    typeInto(input("window-date"), "2026-10-20");
    typeInto(input("window-time"), "11:00");
    typeInto(must("window-reason") as unknown as HTMLInputElement, "Again");
    click(must("window-submit"));
    await waitFor(() => !!q("window-error"), "the refusal");
    expect(text(q("window-error"))).toContain("already announced for 20 Oct 2026");
    expect(q("window-row-950")).toBeNull();
    // what was typed is still there to correct
    expect(input("window-time").value).toBe("11:00");
  });
});

describe("deleting", () => {
  it("asks first, then deletes the future announcement", async () => {
    await openWindows();
    click(must("window-delete-901"));
    await waitFor(() => !!q("window-delete-dialog"), "the confirmation");
    expect(text(q("window-delete-dialog"))).toContain("staff will be judged by their normal shifts again on that day");
    expect(bodiesOf(world, "DELETE", `${WINDOWS}/901`)).toEqual([]);
    click(must("window-delete-confirm"));
    await waitFor(() => world.writes.some((w) => w.method === "DELETE" && w.url === `${WINDOWS}/901`), "the request");
    await waitFor(() => !q("window-row-901"), "the row to go");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Announcement deleted" }));
  });

  it("keeps the announcement when the question is answered No", async () => {
    await openWindows();
    click(must("window-delete-901"));
    await waitFor(() => !!q("window-delete-dialog"), "the confirmation");
    click([...must("window-delete-dialog").querySelectorAll("button")].find((b) => text(b) === "Keep it"));
    await waitFor(() => !q("window-delete-dialog"), "the dialog to close");
    expect(world.writes).toEqual([]);
    expect(q("window-row-901")).not.toBeNull();
  });

  it("says so when the server refuses (a date that has come)", async () => {
    world.on.set(`DELETE ${WINDOWS}/901`, () =>
      apiError(400, { error: "Cannot remove a window for today or a past date: it has already been acted on." }),
    );
    await openWindows();
    click(must("window-delete-901"));
    await waitFor(() => !!q("window-delete-dialog"), "the confirmation");
    click(must("window-delete-confirm"));
    await waitFor(() => h.toast.mock.calls.length > 0, "the toast");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not delete it",
        description: expect.stringContaining("already been acted on"),
      }),
    );
    expect(q("window-row-901")).not.toBeNull();
  });
});

describe("what is switched off", () => {
  it("says late-in / early-out is off in Settings, pauses announcing and deleting, and keeps the list readable", async () => {
    world.windowsEnabled = false;
    await openWindows();
    const notice = must("windows-off");
    expect(text(notice)).toContain("Company-announced late-in / early-out is switched off");
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/settings?tab=compensation#windows-enabled");
    expect(button("window-submit").disabled).toBe(true);
    expect(button("window-submit").title).toMatch(/switched off in Settings → Compensation/);
    expect(button("window-delete-901").disabled).toBe(true);
    expect(text(q("windows-upcoming"))).toContain("Heavy rain");
  });

  it("pauses it while the master switch is off, with that reason on the buttons", async () => {
    world.settings.compensationFeatureEnabled = false;
    await openWindows();
    await waitFor(() => button("window-submit").disabled, "the pause");
    expect(button("window-submit").title).toMatch(/switched off in Settings → Payroll/);
    expect(button("window-delete-901").title).toMatch(/Settings → Payroll/);
    // the master switch has its own notice at the top of the page: this part adds none
    expect(q("windows-off")).toBeNull();
  });

  it("locks Add announcement and Delete for a View Only role", async () => {
    await openWindows();
    lockMutatingControls(document.body);
    await settle();
    expect(button("window-submit").disabled).toBe(true);
    expect(button("window-delete-901").disabled).toBe(true);
  });
});
