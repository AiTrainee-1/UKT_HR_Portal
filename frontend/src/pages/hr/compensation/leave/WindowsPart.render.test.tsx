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
  nestedLabels,
  nestedTab,
  params,
  pickOption,
  q,
  settle,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "../harness";
import { windowOf } from "../fixtures";
import { choose, lastQuery, rowKeys, rowOf } from "./leave-test-utils";

// Compensation Leave A in jsdom: announcing a late-in or an early-out for a date (the Announce nested subtab), the list of
// announcements (the Announcements nested subtab): one month at a time with its figures, filtered by kind, when,
// department, branch and the reason / who announced, a page at a time from the server; deleting one of ANY date with a
// confirmation that says the day's attendance is checked again and that a locked payroll month refuses it; and the notices
// for what is switched off.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as { branchId?: number | null } | null },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user.current }),
}));
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

const ANNOUNCE = "/hr/compensation/compensation-leave/announcements/announce";
const LIST = "/hr/compensation/compensation-leave/announcements/list";

/** The Announce nested subtab: the form and what an announcement does. */
async function openForm() {
  mountPage(ANNOUNCE);
  // (the strip counts the announcements once they have come, which is when the form knows whether it may announce)
  await waitFor(
    () => !!q("windows-form") && /\(\d+\)/.test(nestedLabels("windows-nested")[1] ?? ""),
    "the announce form",
  );
}

/** The Announcements nested subtab: the list (October 2026 unless the address says otherwise). */
async function openWindows(url = LIST) {
  mountPage(url);
  await waitFor(() => rowKeys("windows-table").length > 0, "the announcements");
}

/** Opens the other nested subtab from the strip. */
async function switchTo(value: "announce" | "list", ready: () => boolean) {
  click(nestedTab("windows-nested", value));
  await waitFor(ready, `the ${value} subtab`);
}
const listReady = () => rowKeys("windows-table").length > 0;
const formReady = () => !!q("windows-form");

const input = (id: string) => must(id) as HTMLInputElement;
const button = (id: string) => must(id) as HTMLButtonElement;
const asked = () => lastQuery(world.requests(), WINDOWS)!;

describe("Compensation Leave opens on A", () => {
  it("has the three parts as tabs, A first", async () => {
    await openForm();
    const parts = [...document.body.querySelectorAll('[role="tab"]')].map(text);
    expect(parts.some((t) => t.startsWith("A. Announce late-in / early-out"))).toBe(true);
    expect(parts.some((t) => t.startsWith("B. Sunday & holiday work"))).toBe(true);
    expect(parts.some((t) => t.startsWith("C. Birthdays"))).toBe(true);
  });

  it("shows one section at a time: Announce (the form and what it does) and Announcements (the month's list, counted)", async () => {
    await openForm();
    // October 2026 has two of the three announcements (the third is in September)
    expect(nestedLabels("windows-nested")).toEqual(["Announce", "Announcements (2)"]);
    expect(nestedTab("windows-nested", "announce").getAttribute("aria-selected")).toBe("true");
    expect(q("windows-form")).not.toBeNull();
    expect(q("windows-explain")).not.toBeNull();
    // the list is not on this subtab, so it is not drawn (nor asked for twice: one request serves the count and the list)
    expect(q("windows-list")).toBeNull();
    await switchTo("list", listReady);
    expect(window.location.pathname).toBe(LIST);
    expect(nestedTab("windows-nested", "list").getAttribute("aria-selected")).toBe("true");
    expect(q("windows-form")).toBeNull();
    expect(q("windows-explain")).toBeNull();
    expect(world.requests().filter((r) => r.startsWith(WINDOWS))).toHaveLength(1);
    await switchTo("announce", formReady);
    expect(window.location.pathname).toBe(ANNOUNCE);
    expect(world.requests().filter((r) => r.startsWith(WINDOWS))).toHaveLength(1);
  });

  it("explains what an announcement does, and that any of them can be deleted", async () => {
    await openForm();
    const explain = text(q("windows-explain"));
    expect(explain).toContain("everyone covered may arrive up to the time");
    expect(explain).toContain("The shift's start and its grace do not apply");
    expect(explain).toContain("everyone covered may leave from the time");
    expect(explain).toContain("a day nobody attended is still absent");
    expect(explain).toContain("Any announcement can be deleted");
    expect(explain).toContain("Payroll Done refuses it");
  });
});

describe("the list of announcements", () => {
  it("opens on the current month, every kind, the first page", async () => {
    await openWindows();
    const sent = asked();
    expect(sent.get("month")).toBe("10");
    expect(sent.get("year")).toBe("2026");
    expect(sent.get("kind")).toBe("all");
    expect(sent.get("page")).toBe("1");
    expect(sent.get("pageSize")).toBe("25");
    expect(sent.get("status")).toBeNull();
    expect((must("windows-month-month") as HTMLSelectElement).value).toBe("10");
    expect((must("windows-month-year") as HTMLSelectElement).value).toBe("2026");
    expect(rowKeys("windows-table")).toEqual(["901", "900"]);
  });

  it("shows each one with when, what, why, how many staff it covers and who announced it", async () => {
    await openWindows();
    const upcoming = text(rowOf("windows-table", 901));
    expect(upcoming).toContain("Tue, 20 Oct 2026");
    expect(upcoming).toContain("Upcoming");
    expect(upcoming).toContain("Late-in");
    expect(upcoming).toContain("Arrive up to 10:30 AM");
    expect(upcoming).toContain("Heavy rain");
    expect(upcoming).toContain("214 staff");
    expect(upcoming).toContain("all staff");
    expect(upcoming).toContain("Meena");
    const earlyOut = text(rowOf("windows-table", 900));
    expect(earlyOut).toContain("Past");
    expect(earlyOut).toContain("Early-out");
    expect(earlyOut).toContain("Leave from 4:00 PM");
  });

  it("counts the month's announcements by kind and by when, and a tile filters", async () => {
    await openWindows();
    expect(text(q("windows-kpi-total-value"))).toBe("2");
    expect(text(q("windows-kpi-late-value"))).toBe("1");
    expect(text(q("windows-kpi-early-value"))).toBe("1");
    expect(text(q("windows-kpi-upcoming-value"))).toBe("1");
    click(must("windows-kpi-late"));
    expect(params().wkind).toBe("late_in");
    await waitFor(() => asked().get("kind") === "late_in", "the kind filter");
    await waitFor(() => rowKeys("windows-table").join() === "901", "the late-in only");
    expect(must("windows-kpi-late").getAttribute("aria-pressed")).toBe("true");
  });

  it("steps to the previous month, where an older Compensation Day is named as such and cannot be deleted", async () => {
    await openWindows();
    click(must("windows-month-prev"));
    expect(params()).toMatchObject({ wmonth: "9", wyear: "2026" });
    await waitFor(() => rowKeys("windows-table").join() === "899", "September");
    expect(asked().get("month")).toBe("9");
    const older = text(rowOf("windows-table", 899));
    expect(older).toContain("Compensation Day (older kind)");
    expect(older).toContain("Whole day exempt from Late / Permission");
    expect(q("window-delete-899")).toBeNull();
    click(must("windows-month-next"));
    // (October is already in the cache: it is shown again without asking)
    await waitFor(() => rowKeys("windows-table").join() === "901,900", "back to October");
    expect(params()).toMatchObject({ wmonth: "10", wyear: "2026" });
  });

  it("picks a month and a year from the selects", async () => {
    await openWindows();
    choose("windows-month-month", "9");
    await waitFor(() => asked().get("month") === "9", "the month");
    choose("windows-month-year", "2025");
    await waitFor(() => asked().get("year") === "2025", "the year");
    expect(params()).toMatchObject({ wmonth: "9", wyear: "2025" });
  });

  it("filters by kind, when, department, branch and the reason or who announced, each one asking the server", async () => {
    await openWindows();
    choose("windows-kind", "early_out");
    await waitFor(() => asked().get("kind") === "early_out", "the kind");
    choose("windows-status", "past");
    await waitFor(() => asked().get("status") === "past", "when");
    choose("windows-dept", "3");
    await waitFor(() => asked().get("departmentId") === "3", "the department");
    choose("windows-branch", "5");
    await waitFor(() => asked().get("branchId") === "5", "the branch");
    typeInto(must("windows-search") as HTMLInputElement, "strike");
    await waitFor(() => asked().get("q") === "strike", "the search");
    expect(params()).toMatchObject({ wkind: "early_out", wstatus: "past", wdept: "3", wbranch: "5", wq: "strike" });
    // Clear filters puts every one of them back (the first answer, from the cache), the month stays
    click(must("windows-clear"));
    await waitFor(() => rowKeys("windows-table").join() === "901,900", "every filter cleared");
    expect(params()).toEqual({});
  });

  it("asks a page at a time, and a filter goes back to the first page", async () => {
    world.windows = Array.from({ length: 30 }, (_, i) =>
      windowOf(700 + i, { date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}` }),
    );
    await openWindows();
    expect(rowKeys("windows-table")).toHaveLength(25);
    click(
      [...must("windows-table").querySelectorAll("button")].find((b) =>
        /next/i.test(`${b.getAttribute("aria-label")} ${text(b)}`),
      ),
    );
    await waitFor(() => asked().get("page") === "2", "page 2");
    expect(params().wpage).toBe("2");
    await waitFor(() => rowKeys("windows-table").length === 5, "the last five");
    choose("windows-kind", "late_in");
    await waitFor(() => asked().get("page") === "1", "back to page 1");
    expect(params().wpage).toBeUndefined();
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
    expect(text(rowOf("windows-table", 901))).toContain("40 staff");
    expect(text(rowOf("windows-table", 901))).toContain("Cutting staff of Head Office");
  });

  it("says there is none for the month, and what to do", async () => {
    world.windows = [];
    mountPage(LIST);
    await waitFor(() => text(q("windows-table")).includes("No announcement in October 2026"), "the empty state");
    expect(text(q("windows-table"))).toContain("announce a late-in or early-out in the Announce tab");
  });

  it("shows rows' shape while loading, and an error with a Retry", async () => {
    const release = world.hold(WINDOWS);
    mountPage(LIST);
    await waitFor(() => !!q("windows-list"), "the list");
    expect(must("windows-table").getAttribute("aria-busy")).toBe("true");
    release();
    await waitFor(listReady, "the rows");
    unmountPage();

    world.failing.set(WINDOWS, { status: 500 });
    mountPage(LIST);
    await waitFor(() => text(q("windows-table")).includes("Could not load the announcements"), "the error");
    world.failing.clear();
    click([...must("windows-table").querySelectorAll("button")].find((b) => text(b) === "Try again"));
    await waitFor(listReady, "the rows");
  });
});

describe("announcing", () => {
  it("starts today, as a late-in, with the date limited to the current month, past days included", async () => {
    await openForm();
    expect(input("window-date").value).toBe("2026-10-14");
    expect(input("window-date").min).toBe("2026-10-01");
    expect(input("window-date").max).toBe("2026-10-31");
    expect(text(q("windows-form"))).toContain("Any day of October 2026 (1 to 31 October), past or upcoming.");
    expect(must("window-kind-late_in").getAttribute("aria-checked")).toBe("true");
    expect(must("window-kind-early_out").getAttribute("aria-checked")).toBe("false");
    expect(button("window-submit").disabled).toBe(false);
    expect(text(button("window-submit"))).toBe("Add announcement");
  });

  it("says what is missing instead of sending an incomplete announcement", async () => {
    await openForm();
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
    await openForm();
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
    // the form is ready for the next one (it stays on Announce: HR often adds a late-in and an early-out in a row) ...
    await waitFor(() => input("window-time").value === "", "the form to be cleared");
    expect((must("window-reason") as unknown as HTMLTextAreaElement).value).toBe("");
    expect(input("window-date").value).toBe("2026-10-20");
    expect(window.location.pathname).toBe(ANNOUNCE);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Announcement added" }));
    // ... and the new announcement is in the list, whose tab now counts it
    await waitFor(() => nestedLabels("windows-nested")[1] === "Announcements (3)", "the count to follow");
    await switchTo("list", listReady);
    await waitFor(() => !!rowOf("windows-table", 950), "the new row");
    expect(text(rowOf("windows-table", 950))).toContain("Arrive up to 10:30 AM");
  });

  it("announces an early-out with its own time label", async () => {
    await openForm();
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
    await openForm();
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
    await openForm();
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
    await openForm();
    typeInto(input("window-date"), "2026-10-20");
    typeInto(input("window-time"), "11:00");
    typeInto(must("window-reason") as unknown as HTMLInputElement, "Again");
    click(must("window-submit"));
    await waitFor(() => !!q("window-error"), "the refusal");
    expect(text(q("window-error"))).toContain("already announced for 20 Oct 2026");
    expect(nestedLabels("windows-nested")[1]).toBe("Announcements (2)");
    // what was typed is still there to correct
    expect(input("window-time").value).toBe("11:00");
  });
});

describe("deleting", () => {
  it("is offered on every announcement, past ones included", async () => {
    await openWindows();
    expect(q("window-delete-901")).not.toBeNull(); // upcoming
    expect(q("window-delete-900")).not.toBeNull(); // past
  });

  it("asks first, saying the day's attendance is checked again and a locked payroll month refuses it, then deletes", async () => {
    await openWindows();
    click(must("window-delete-900"));
    await waitFor(() => !!q("window-delete-dialog"), "the confirmation");
    const dialog = text(q("window-delete-dialog"));
    expect(dialog).toContain("Early-out on Sat, 10 Oct 2026, covering 214 staff");
    expect(dialog).toContain("That day's attendance is checked again for every staff member it covered");
    expect(dialog).toContain("a day HR edited by hand stays as it is");
    expect(dialog).toContain("The staff it covered are told it was cancelled");
    expect(dialog).toContain("If that day's payroll month is locked or marked Payroll Done, the delete is refused");
    expect(bodiesOf(world, "DELETE", `${WINDOWS}/900`)).toEqual([]);
    click(must("window-delete-confirm"));
    await waitFor(() => world.writes.some((w) => w.method === "DELETE" && w.url === `${WINDOWS}/900`), "the request");
    await waitFor(() => !rowOf("windows-table", 900), "the row to go");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Announcement deleted",
        description: "The attendance of Sat, 10 Oct 2026 is checked again for the staff it covered.",
      }),
    );
  });

  it("says a day still to come has no attendance to check yet", async () => {
    await openWindows();
    click(must("window-delete-901"));
    await waitFor(() => !!q("window-delete-dialog"), "the confirmation");
    expect(text(q("window-delete-effects"))).toContain("The day has not come yet");
    click(must("window-delete-confirm"));
    await waitFor(() => !q("window-delete-dialog"), "the dialog to close");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Announcement deleted", description: undefined }),
    );
  });

  it("keeps the announcement when the question is answered No", async () => {
    await openWindows();
    click(must("window-delete-901"));
    await waitFor(() => !!q("window-delete-dialog"), "the confirmation");
    click([...must("window-delete-dialog").querySelectorAll("button")].find((b) => text(b) === "Keep it"));
    await waitFor(() => !q("window-delete-dialog"), "the dialog to close");
    expect(world.writes).toEqual([]);
    expect(rowOf("windows-table", 901)).not.toBeNull();
  });

  it("shows the server's own sentence in the dialog when it refuses (a locked payroll month), and keeps the row", async () => {
    world.on.set(`DELETE ${WINDOWS}/900`, () =>
      apiError(409, {
        error: "October 2026 payroll is locked (Payroll Done), so the attendance of 10 Oct 2026 cannot change.",
      }),
    );
    await openWindows();
    click(must("window-delete-900"));
    await waitFor(() => !!q("window-delete-dialog"), "the confirmation");
    click(must("window-delete-confirm"));
    await waitFor(() => !!q("window-delete-error"), "the refusal");
    expect(text(q("window-delete-error"))).toContain("October 2026 payroll is locked (Payroll Done)");
    expect(q("window-delete-dialog")).not.toBeNull();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not delete it", description: expect.stringContaining("is locked") }),
    );
    expect(rowOf("windows-table", 900)).not.toBeNull();
  });
});

describe("what is switched off", () => {
  it("says late-in / early-out is off in Settings, pauses announcing and deleting, and keeps the list readable", async () => {
    world.windowsEnabled = false;
    await openForm();
    const notice = must("windows-off");
    expect(text(notice)).toContain("Company-announced late-in / early-out is switched off");
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/settings?tab=compensation#windows-enabled");
    expect(button("window-submit").disabled).toBe(true);
    expect(button("window-submit").title).toMatch(/switched off in Settings → Compensation/);
    // the notice stays above the nested subtabs, so it is there on the list too
    await switchTo("list", listReady);
    expect(q("windows-off")).not.toBeNull();
    expect(button("window-delete-901").disabled).toBe(true);
    expect(text(rowOf("windows-table", 901))).toContain("Heavy rain");
  });

  it("pauses it while the master switch is off, with that reason on the buttons", async () => {
    world.settings.compensationFeatureEnabled = false;
    await openForm();
    await waitFor(() => button("window-submit").disabled, "the pause");
    expect(button("window-submit").title).toMatch(/switched off in Settings → Payroll/);
    await switchTo("list", listReady);
    expect(button("window-delete-901").title).toMatch(/Settings → Payroll/);
    // the master switch has its own notice at the top of the page: this part adds none
    expect(q("windows-off")).toBeNull();
  });

  it("locks Add announcement and Delete for a View Only role, and leaves the filters alone", async () => {
    await openForm();
    lockMutatingControls(document.body);
    await settle();
    expect(button("window-submit").disabled).toBe(true);
    await switchTo("list", listReady);
    lockMutatingControls(document.body);
    await settle();
    expect(button("window-delete-901").disabled).toBe(true);
    expect(button("windows-month-prev").disabled).toBe(false);
    expect((must("windows-kind") as HTMLSelectElement).disabled).toBe(false);
    expect(button("windows-kpi-late").disabled).toBe(false);
  });
});
