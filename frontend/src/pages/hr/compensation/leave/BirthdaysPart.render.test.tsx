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
  q,
  settle,
  tab,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "../harness";
import { compBlock, compUse, malaEntitlement } from "../fixtures";
import { choose, lastQuery, rowKeys } from "./leave-test-utils";

// Compensation Leave C in jsdom: birthdays by attendance. A birthday is a normal working day: absent or on leave = an
// automatic paid birthday leave; worked (present, or even half a day) = 1.00 day of Birthday Compensation to place on days
// of the birthday month (owner 2026-11-25), by the employee or here by HR ("Choose date for employee"), each placement
// going to the Department Head, then HR; an off day gives nothing. The list shows what each birthday gave and where its
// compensation was placed, with its filters and figures; How it works says so. The year of birth never shows.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  // the signed-in login (null: not an HR role, so every right): a test sets an HR role with its permissions
  user: { current: null as { role: "hr"; employeeId: null; permissions: Record<string, string> } | null },
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

const BIRTHDAYS = "/hr/compensation/compensation-leave/birthdays/list";
const HOW = "/hr/compensation/compensation-leave/birthdays/how";
const API = "/api/compensation/birthdays";
const COMP_API = "/api/compensation/birthday-compensation";
const USES_API = `${COMP_API}/uses`;

const ready = () => rowKeys("birthday-table").length > 0;

async function openBirthdays(url = BIRTHDAYS) {
  mountPage(url);
  await waitFor(ready, "the birthdays");
}

const birthdayRequests = () => world.requests().filter((r) => r.startsWith(API));
const asked = () => lastQuery(world.requests(), API)!;
const rowCodes = () =>
  [...document.body.querySelectorAll('[data-testid="birthday-table"] [data-testid^="birthday-row-"]')].map((r) =>
    r.getAttribute("data-testid"),
  );
const button = (id: string) => must(id) as HTMLButtonElement;

describe("today", () => {
  it("lists who has a birthday today, what it gave, the attendance and the punches", async () => {
    await openBirthdays();
    expect(birthdayRequests()).toEqual([`${API}?period=today&date=2026-10-14`]);
    expect(rowCodes()).toEqual(["birthday-row-E31"]);
    const row = text(document.querySelector('[data-testid="birthday-table"] tbody tr'));
    expect(row).toContain("Mala Iyer");
    expect(row).toContain("14 Oct 2026");
    expect(row).toContain("Wednesday");
    expect(row).toContain("Present");
    expect(row).toContain("10:40 - 16:00 · 1 shift");
    expect(text(q("birthday-outcome-E31"))).toBe("Worked: birthday compensation to place");
    expect(q("birthday-row-E31")!.getAttribute("data-outcome")).toBe("comp_to_place");
    expect(text(q("birthday-placement-E31"))).toBe("0.00 of 1.00 day placed · 1.00 day to place by 31 Oct");
    expect(text(q("birthday-place-button-E31"))).toBe("Choose date for employee");
    // the birthday credit is gone: nothing says "claim"
    expect(text(q("birthday-table"))).not.toMatch(/credit to claim|claim for employee/i);
  });

  it("counts the birthdays by what they gave", async () => {
    await openBirthdays();
    expect(text(q("birthday-kpi-count-value"))).toBe("1");
    expect(text(q("birthday-kpi-leave-value"))).toBe("0");
    expect(text(q("birthday-kpi-to-place-value"))).toBe("1");
    expect(text(q("birthday-kpi-placed-value"))).toBe("0");
    expect(text(q("birthday-kpi-lapsed-value"))).toBe("0");
    expect(text(q("birthday-kpi-upcoming-value"))).toBe("0");
    expect(q("birthday-kpi-claimable")).toBeNull();
  });
});

describe("how it works", () => {
  it("says a worked birthday gives 1.00 day to place in the birthday month, decided by the HOD then HR", async () => {
    await openBirthdays();
    expect(nestedLabels("birthday-nested")).toEqual(["Who has a birthday (1)", "How it works"]);
    expect(q("birthday-how")).toBeNull();
    click(nestedTab("birthday-nested", "how"));
    await waitFor(() => !!q("birthday-how"), "How it works");
    expect(window.location.pathname).toBe(HOW);
    expect(q("birthday-table")).toBeNull();
    expect(q("birthday-kpis")).toBeNull();
    const how = text(q("birthday-how"));
    expect(how).toContain("A birthday is a normal working day.");
    expect(how).toContain(
      "Absent (no punch) or on approved leave (casual leave included): an automatic paid birthday leave of 1 shift",
    );
    expect(how).toContain("No leave or casual-leave balance is used");
    expect(how).toContain(
      "Worked (present, or even half a day): 1.00 day of birthday compensation to place on working days of the birthday month",
    );
    expect(how).toContain("a full day or a first and a second half (the two halves can go on two different dates)");
    expect(how).toContain("Absent, On Leave or Half Day (then the missed half or a full day)");
    expect(how).toContain("Choose date for employee");
    expect(how).toContain("Each choice goes to the Department Head, then HR");
    expect(how).toContain("paid like Casual Leave");
    expect(how).toContain("What is not placed by the last day of the birthday month lapses");
    expect(how).toContain("New birthday credit claims are no longer possible");
    expect(how).toContain("A Sunday, a declared holiday or an off Saturday gives no birthday benefit");
    expect(how).not.toContain("credit to claim");
    expect(how).not.toContain("compensation balance");
    expect(text(q("birthday-claims-from"))).toBe("1 Oct 2026");
    expect(how).toContain("Earlier birthdays keep the old rule");
    expect(how).toContain("The year of birth is never shown here.");
    expect(how).not.toContain("Automatic: HR does nothing");
  });

  it("never shows a year of birth", async () => {
    await openBirthdays(`${BIRTHDAYS}?bperiod=month`);
    expect(text(q("birthdays-part"))).not.toMatch(/\b(19|20)\d\d-\d\d-\d\d\b/);
    expect([...text(q("birthday-table")).matchAll(/\b(19\d\d|20\d\d)\b/g)].every((m) => m[1] === "2026")).toBe(true);
  });

  it("does not name a start date when the server sends none", async () => {
    world.on.set(`GET ${API}`, (_call, qs) => ({
      period: qs.get("period"),
      date: qs.get("date"),
      from: "2026-10-14",
      to: "2026-10-14",
      enabled: { master: true, birthday: true, effectiveFrom: null },
      count: 0,
      benefitCount: 0,
      results: [],
    }));
    mountPage(HOW);
    await waitFor(() => !!q("birthday-how"), "How it works");
    expect(q("birthday-claims-from")).toBeNull();
  });
});

describe("the period", () => {
  it("shows the week: paid leave, an older credit claim, compensation placed and to place, an off day", async () => {
    await openBirthdays();
    click(tab("Week"));
    expect(params()).toMatchObject({ bperiod: "week" });
    await waitFor(() => rowCodes().length === 5, "the week");
    expect(birthdayRequests().at(-1)).toBe(`${API}?period=week&date=2026-10-14`);
    expect(text(q("birthday-kpi-count"))).toContain("12 Oct - 18 Oct 2026");
    expect(text(q("birthday-kpi-leave-value"))).toBe("1");
    expect(text(q("birthday-kpi-to-place-value"))).toBe("1");
    expect(text(q("birthday-kpi-placed-value"))).toBe("1");

    expect(text(q("birthday-outcome-E32"))).toBe("Paid birthday leave");
    // a birthday credit claimed before the change stays readable, with its claim
    expect(text(q("birthday-outcome-E34"))).toBe("Birthday credit claim: waiting for HOD");
    expect(must("birthday-claim-E34").getAttribute("href")).toBe(
      "/hr/compensation/compensation-leave/holiday-work/claims?hmonth=all&hemp=34&hclaim=3006",
    );
    expect(q("birthday-placement-E34")).toBeNull();
    expect(q("birthday-place-button-E34")).toBeNull();
    expect(q("birthday-place-button-E32")).toBeNull();
    // all of Kavya's is placed: where and how far each part got
    expect(text(q("birthday-outcome-E36"))).toBe("Birthday compensation placed");
    expect(text(q("birthday-placement-E36"))).toContain("1.00 of 1.00 day placed");
    expect(text(q("birthday-use-41"))).toContain("7 Oct · first half");
    expect(text(q("birthday-use-41"))).toContain("Approved: first half paid on 7 Oct");
    expect(text(q("birthday-use-42"))).toContain("20 Oct · second half");
    expect(text(q("birthday-use-42"))).toContain("Approved by the Department Head, waiting for HR");
    expect(q("birthday-place-button-E36")).toBeNull();
    expect(text(q("birthday-view-button-E36"))).toBe("See placements");
    expect(text(q("birthday-outcome-E33"))).toBe("Off day: no benefit");
    expect(text(q("birthday-reason-E33"))).toBe("18 Oct 2026 is a Sunday: it is already a day off.");
  });

  it("shows the month, with the birthdays still to come", async () => {
    await openBirthdays(`${BIRTHDAYS}?bperiod=month`);
    expect(birthdayRequests().at(-1)).toBe(`${API}?period=month&date=2026-10-14`);
    expect(text(q("birthday-outcome-E35"))).toBe("Upcoming");
    expect(text(q("birthday-kpi-upcoming-value"))).toBe("1");
  });

  it("says what lapsed when the birthday month ended with some of it never placed", async () => {
    world.on.set(`GET ${API}`, (_call, qs) => ({
      period: qs.get("period"),
      date: qs.get("date"),
      from: "2026-10-14",
      to: "2026-10-14",
      enabled: { master: true, birthday: true, effectiveFrom: "2026-10-01", claimsFrom: "2026-10-01" },
      count: 1,
      benefitCount: 1,
      summary: { byOutcome: { comp_lapsed: 1 } },
      results: [
        {
          employeeId: 37,
          employeeCode: "E37",
          employeeName: "Anil Joseph",
          department: "Sales",
          departmentId: 1,
          designation: null,
          branch: "Head Office",
          branchId: 2,
          employmentType: "staff",
          birthday: "2026-10-14",
          weekday: "Wednesday",
          benefits: true,
          reason: null,
          attendanceStatus: "present",
          applied: false,
          compensationKind: null,
          firstPunch: "09:00",
          lastPunch: "18:00",
          shiftsEarned: 1,
          outcome: "comp_lapsed",
          outcomeLabel: "Birthday Compensation lapsed",
          canPlace: false,
          birthdayCompensation: compBlock({
            state: "lapsed",
            label: "0.50 day lapsed",
            held: 0,
            used: 0.5,
            available: 0,
            lapsed: 0.5,
            windowOpen: false,
            uses: [
              {
                id: 61,
                useDate: "2026-10-05",
                portion: "second_half",
                portionLabel: "Second half",
                days: 0.5,
                status: "approved",
                statusKey: "approved",
                statusLabel: "Approved: second half paid on 5 Oct",
              },
            ],
          }),
        },
      ],
    }));
    await openBirthdays();
    expect(text(q("birthday-outcome-E37"))).toBe("Birthday compensation lapsed");
    expect(text(q("birthday-placement-E37"))).toContain("0.50 of 1.00 day placed · 0.50 day lapsed on 31 Oct");
    expect(text(q("birthday-kpi-lapsed-value"))).toBe("1");
    expect(q("birthday-place-button-E37")).toBeNull();
    expect(text(q("birthday-view-button-E37"))).toBe("See placements");
  });

  it("steps to the next and the previous period, and back to today", async () => {
    await openBirthdays(`${BIRTHDAYS}?bperiod=week`);
    click(must("birthday-period-next"));
    expect(params().bdate).toBe("2026-10-21");
    await waitFor(() => birthdayRequests().at(-1) === `${API}?period=week&date=2026-10-21`, "next week");
    click(must("birthday-period-prev"));
    click(must("birthday-period-prev"));
    expect(params().bdate).toBe("2026-10-07");
    click(must("birthday-period-today"));
    expect(params().bdate).toBeUndefined();
    expect(button("birthday-period-today").disabled).toBe(true);
  });

  it("says there is no birthday, and where to look", async () => {
    world.on.set(`GET ${API}`, (_call, qs) => ({
      period: qs.get("period"),
      date: qs.get("date"),
      from: "2026-10-14",
      to: "2026-10-14",
      enabled: { master: true, birthday: true, effectiveFrom: null },
      count: 0,
      benefitCount: 0,
      results: [],
    }));
    mountPage(BIRTHDAYS);
    await waitFor(() => text(q("birthday-table")).includes("No birthday today"), "the empty state");
  });
});

describe("the filters", () => {
  it("filter by department, branch, name and outcome: each one asks the server", async () => {
    await openBirthdays(`${BIRTHDAYS}?bperiod=week`);
    choose("birthday-dept", "1");
    await waitFor(() => asked().get("departmentId") === "1", "the department");
    choose("birthday-branch", "2");
    await waitFor(() => asked().get("branchId") === "2", "the branch");
    typeInto(must("birthday-search") as HTMLInputElement, "priya");
    await waitFor(() => asked().get("q") === "priya", "the search");
    await waitFor(() => rowCodes().join() === "birthday-row-E34", "Priya");
    choose("birthday-outcome", "credit_pending");
    await waitFor(() => asked().get("outcome") === "credit_pending", "the outcome");
    expect(params()).toMatchObject({ bdept: "1", bbranch: "2", bq: "priya", boutcome: "credit_pending" });
    click(must("birthday-clear"));
    await waitFor(() => rowCodes().length === 5, "every birthday of the week");
  });

  it("offers the new outcomes in the filter, never a credit to claim", async () => {
    await openBirthdays();
    const options = [...(must("birthday-outcome") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(expect.arrayContaining(["comp_to_place", "comp_placed", "comp_lapsed", "credit_pending"]));
    expect(options).not.toContain("credit_claimable");
    choose("birthday-outcome", "comp_to_place");
    await waitFor(() => asked().get("outcome") === "comp_to_place", "the outcome");
  });

  it("filter by a tile, and the tiles keep counting every outcome", async () => {
    await openBirthdays(`${BIRTHDAYS}?bperiod=week`);
    click(must("birthday-kpi-leave"));
    expect(params().boutcome).toBe("paid_leave");
    await waitFor(() => rowCodes().join() === "birthday-row-E32", "the paid leave");
    expect(text(q("birthday-kpi-to-place-value"))).toBe("1");
    expect(must("birthday-kpi-leave").getAttribute("aria-pressed")).toBe("true");
    click(must("birthday-kpi-placed"));
    expect(params().boutcome).toBe("comp_placed");
    await waitFor(() => rowCodes().join() === "birthday-row-E36", "the placed one");
  });
});

// ── Choose date for employee ──

const dialogOpen = () => !!q("bc-calendar");

async function openChooser() {
  await openBirthdays();
  click(must("birthday-place-button-E31"));
  await waitFor(dialogOpen, "the birthday month");
}

const day = (date: string) => must(`bc-day-${date}`) as HTMLButtonElement;
const portion = (key: string) => must(`bc-portion-${key}`) as HTMLButtonElement;

describe("choosing a date for an employee", () => {
  it("loads the employee's birthday month: the balance, the days that can be picked and the ones that cannot", async () => {
    await openChooser();
    expect(lastQuery(world.requests(), COMP_API)?.toString()).toBe("employeeId=31&year=2026");
    const dialog = text(q("bc-dialog"));
    expect(dialog).toContain("Choose date for Mala Iyer");
    expect(dialog).toContain("worked on their birthday, Wed, 14 Oct 2026: 1.00 day of birthday compensation");
    expect(dialog).toContain("working days of October 2026");
    expect(text(q("bc-left"))).toBe("1.00");
    expect(text(q("bc-balance"))).toContain("of 1.00 day left to place");
    // every day of the month, Monday first (1 Oct 2026 is a Thursday: three blank cells before it)
    expect(must("bc-calendar").querySelectorAll('[data-testid^="bc-day-"]')).toHaveLength(31);
    expect(day("2026-10-01").getAttribute("data-selectable")).toBe("true"); // absent
    expect(day("2026-10-07").getAttribute("data-selectable")).toBe("true"); // on leave
    expect(day("2026-10-20").getAttribute("data-selectable")).toBe("true"); // still to come
    for (const refused of ["2026-10-02", "2026-10-04", "2026-10-06", "2026-10-09", "2026-10-14"]) {
      expect(day(refused).getAttribute("data-selectable"), refused).toBe("false");
      expect(day(refused).getAttribute("aria-disabled"), refused).toBe("true");
    }
    expect(text(q("bc-approval-path"))).toBe("Approval: Employee or HR → HOD → HR.");
    // nothing picked yet: Send waits
    expect(button("bc-send").disabled).toBe(true);
    expect(text(q("bc-footer-note"))).toBe("Pick a day and the part of it to place.");
  });

  it("says why a greyed-out day cannot be chosen when it is pressed", async () => {
    await openChooser();
    click(day("2026-10-04"));
    expect(text(q("bc-day-reason"))).toBe("A Sunday is already a day off: choose a working day.");
    click(day("2026-10-14"));
    expect(text(q("bc-day-reason"))).toBe("The birthday itself cannot be chosen: choose another day of October 2026.");
    click(day("2026-10-06"));
    expect(text(q("bc-day-reason"))).toContain(
      "was present this day (a full day worked): there is nothing to make up.",
    );
    expect(day("2026-10-06").getAttribute("aria-pressed")).toBeNull();
    expect(q("bc-portions")).toBeNull();
    expect(button("bc-send").disabled).toBe(true);
  });

  it("offers only the parts a day takes: the missed half of a half day, or a full day", async () => {
    await openChooser();
    click(day("2026-10-05"));
    expect(day("2026-10-05").getAttribute("aria-pressed")).toBe("true");
    // the morning was worked: the second half is picked for her, the first half cannot be
    expect(portion("second_half").getAttribute("aria-checked")).toBe("true");
    expect(portion("first_half").disabled).toBe(true);
    expect(portion("first_half").title).toBe("Only full day or second half can be placed on this day.");
    expect(portion("full").disabled).toBe(false);
    expect(text(q("bc-day-info"))).toContain("On Monday 5 Oct 2026 only a second half or full day can be placed.");
    expect(text(q("bc-day-info"))).toContain("The morning was worked: the second half covers the rest of the day.");
    expect(text(q("bc-portion-second_half"))).toContain("14:00-18:00");
    expect(day("2026-10-05").getAttribute("data-portion")).toBe("second_half");
  });

  it("sends the day, the part and the reason to the Department Head, and closes", async () => {
    await openChooser();
    click(day("2026-10-20"));
    expect(portion("full").getAttribute("aria-checked")).toBe("true");
    click(portion("first_half"));
    expect(portion("first_half").getAttribute("aria-checked")).toBe("true");
    expect(text(q("bc-left-after"))).toBe("0.50");
    expect(text(q("bc-footer-note"))).toBe(
      "Tue, 20 Oct 2026, first half (0.50 day): it waits for the Department Head, then HR. HR's approval pays it like Casual Leave.",
    );
    typeInto(must("bc-reason") as HTMLTextAreaElement, "  Asked at the desk  ");
    expect(button("bc-send").disabled).toBe(false);
    expect(text(q("bc-send"))).toBe("Send to the Department Head");
    click(must("bc-send"));
    await waitFor(() => bodiesOf(world, "POST", USES_API).length === 1, "the request");
    expect(bodiesOf(world, "POST", USES_API)[0]).toEqual({
      employeeId: 31,
      useDate: "2026-10-20",
      portion: "first_half",
      reason: "Asked at the desk",
    });
    await waitFor(() => !q("bc-dialog"), "the dialog to close");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Birthday compensation placed",
        description: "Mala Iyer: Tue, 20 Oct 2026, first half (0.50 day). It waits for the Department Head, then HR.",
      }),
    );
  });

  it("sends no reason when none is given (it is optional)", async () => {
    await openChooser();
    click(day("2026-10-01"));
    click(must("bc-send"));
    await waitFor(() => bodiesOf(world, "POST", USES_API).length === 1, "the request");
    expect(bodiesOf(world, "POST", USES_API)[0]).toEqual({ employeeId: 31, useDate: "2026-10-01", portion: "full" });
  });

  it("a second press on the picked day puts it back", async () => {
    await openChooser();
    click(day("2026-10-20"));
    click(day("2026-10-20"));
    expect(day("2026-10-20").getAttribute("aria-pressed")).toBe("false");
    expect(q("bc-portions")).toBeNull();
    expect(button("bc-send").disabled).toBe(true);
  });

  it("shows the server's sentence when it refuses, and stays open", async () => {
    world.on.set(`POST ${USES_API}`, () =>
      apiError(409, {
        error: "The first half of Tuesday 20 Oct 2026 is already placed.",
        code: "already_placed",
      }),
    );
    await openChooser();
    click(day("2026-10-20"));
    click(portion("first_half"));
    click(must("bc-send"));
    await waitFor(() => !!q("bc-error"), "the refusal");
    expect(text(q("bc-error"))).toBe("The first half of Tuesday 20 Oct 2026 is already placed.");
    expect(q("bc-dialog")).not.toBeNull();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("with half of it waiting, offers only halves and lists what was placed, which HR can withdraw", async () => {
    const placedHalf = compUse(77, { useDate: "2026-10-16", portion: "first_half", reason: "Family function" });
    world.birthdayComp[31] = malaEntitlement({
      days: { total: 1, held: 0.5, used: 0, available: 0.5, lapsed: 0 },
      uses: [placedHalf],
      eligibleDates: malaEntitlement().eligibleDates.map((d) =>
        d.date === "2026-10-16"
          ? {
              ...d,
              portions: ["second_half"],
              suggested: "second_half",
              placed: [{ id: 77, portion: "first_half", status: "pending" }],
            }
          : // a day HR set by hand takes a full day only
            d.date === "2026-10-21"
            ? { ...d, portions: ["full"], manual: true }
            : d,
      ),
    });
    await openChooser();
    expect(text(q("bc-left"))).toBe("0.50");
    expect(text(q("bc-balance-parts"))).toContain("0.50 waiting");
    expect(text(day("2026-10-16"))).toContain("½ BC");
    click(day("2026-10-20"));
    // a full day no longer fits: the first half is picked instead
    expect(portion("full").disabled).toBe(true);
    expect(portion("full").title).toBe("Only 0.50 day is left to place: choose a first or second half.");
    expect(portion("first_half").getAttribute("aria-checked")).toBe("true");
    // a day that takes a full day only cannot be picked with half a day left
    expect(day("2026-10-21").getAttribute("data-selectable")).toBe("false");
    click(day("2026-10-21"));
    expect(text(q("bc-day-reason"))).toBe("Only 0.50 day is left to place, and this day takes a full day only.");

    const use = text(q("bc-use-77"));
    expect(use).toContain("Fri, 16 Oct 2026 · First half (0.50 day)");
    expect(use).toContain("Waiting for the Department Head");
    expect(use).toContain("Placed by HR (Meena)");
    expect(use).toContain("Family function");
    click(must("bc-use-withdraw-77"));
    click(must("bc-use-withdraw-confirm-77"));
    await waitFor(() => world.writes.some((w) => w.method === "DELETE"), "the withdrawal");
    expect(world.writes.filter((w) => w.method === "DELETE").map((w) => w.url)).toEqual([`${USES_API}/77`]);
    await waitFor(() => text(q("bc-use-status-77")) === "Withdrawn", "the use withdrawn");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Birthday compensation withdrawn" }));
    expect(q("bc-use-withdraw-77")).toBeNull();
  });

  it("says why nothing can be placed when the server says so, with no calendar and no Send", async () => {
    world.birthdayComp[31] = malaEntitlement({
      canPlace: false,
      placeMessage: "Mala Iyer has no Department Head who may approve compensation, so nothing can be placed.",
    });
    await openBirthdays();
    click(must("birthday-place-button-E31"));
    await waitFor(() => !!q("bc-cannot-place"), "the notice");
    expect(text(q("bc-cannot-place"))).toBe(
      "Mala Iyer has no Department Head who may approve compensation, so nothing can be placed.",
    );
    expect(q("bc-calendar")).toBeNull();
    expect(q("bc-send")).toBeNull();
  });

  it("is greyed out, naming the right, for a role that can only view Birthdays", async () => {
    h.user.current = {
      role: "hr",
      employeeId: null,
      permissions: { compensation: "edit", "compensation.leave.birthdays": "view" },
    };
    await openBirthdays();
    expect(button("birthday-place-button-E31").disabled).toBe(true);
    expect(button("birthday-place-button-E31").title).toBe("Needs Edit on Compensation > Leave > Birthdays");
    click(must("birthday-place-button-E31"));
    await settle();
    expect(q("bc-dialog")).toBeNull();
    expect(world.requests().some((r) => r.startsWith(COMP_API))).toBe(false);
  });

  it("is locked for a View Only role", async () => {
    await openBirthdays();
    lockMutatingControls(document.body);
    await settle();
    expect(button("birthday-place-button-E31").disabled).toBe(true);
    expect((must("birthday-outcome") as HTMLSelectElement).disabled).toBe(false);
  });
});

describe("seeing where it was placed", () => {
  it("lists every placement with its status, and sends a use waiting for HR to Requests", async () => {
    world.birthdayComp[36] = malaEntitlement({
      employeeId: 36,
      employeeName: "Kavya Rao",
      birthday: "2026-10-12",
      state: "placed",
      message: "All of the 1.00 day of Birthday Compensation is placed.",
      canPlace: false,
      days: { total: 1, held: 0.5, used: 0.5, available: 0, lapsed: 0 },
      eligibleDates: [],
      uses: [
        compUse(41, {
          employeeId: 36,
          useDate: "2026-10-07",
          status: "approved",
          statusKey: "approved",
          statusLabel: "Approved: first half paid on 7 Oct",
          raisedByRole: "employee",
          requestedBy: "Kavya Rao",
          canWithdraw: false,
          reviewedBy: "Meena",
          reviewComment: "Fine",
        }),
        compUse(42, {
          employeeId: 36,
          useDate: "2026-10-20",
          portion: "second_half",
          portionLabel: "Second half",
          statusKey: "pending_hr",
          statusLabel: "Approved by the Department Head, waiting for HR",
          raisedByRole: "employee",
          requestedBy: "Kavya Rao",
          canWithdraw: false,
        }),
      ],
    });
    await openBirthdays(`${BIRTHDAYS}?bperiod=week`);
    click(must("birthday-view-button-E36"));
    await waitFor(() => !!q("bc-uses"), "the placements");
    expect(lastQuery(world.requests(), COMP_API)?.toString()).toBe("employeeId=36&year=2026");
    expect(text(q("bc-dialog"))).toContain("Birthday compensation of Kavya Rao");
    expect(text(q("bc-message"))).toBe("All of the 1.00 day of Birthday Compensation is placed.");
    expect(q("bc-calendar")).toBeNull();
    expect(text(q("bc-use-41"))).toContain("Approved: first half paid on 7 Oct");
    expect(text(q("bc-use-41"))).toContain("Placed by Employee (app)");
    expect(text(q("bc-use-41"))).toContain("Meena: “Fine”");
    expect(q("bc-use-decide-41")).toBeNull();
    expect(must("bc-use-decide-42").getAttribute("href")).toBe("/hr/requests?kind=birthday_compensation&focus=42");
    // the employee's own placements are not HR's to withdraw
    expect(q("bc-use-withdraw-41")).toBeNull();
    expect(q("bc-use-withdraw-42")).toBeNull();
  });
});

describe("loading and errors", () => {
  it("shows the shape of the list while the birthdays are on their way", async () => {
    const release = world.hold(API);
    mountPage(BIRTHDAYS);
    await waitFor(() => !!q("birthday-list"), "the card");
    expect(must("birthday-table").getAttribute("aria-busy")).toBe("true");
    release();
    await waitFor(ready, "the list");
  });

  it("shows an error with a Retry", async () => {
    world.failing.set(API, { status: 500 });
    mountPage(BIRTHDAYS);
    await waitFor(() => text(q("birthday-table")).includes("Could not load the birthdays"), "the error");
    world.failing.clear();
    click([...must("birthday-table").querySelectorAll("button")].find((b) => text(b) === "Try again"));
    await waitFor(ready, "the list");
  });

  it("says when the birthday month could not be read", async () => {
    await openBirthdays();
    world.failing.set(COMP_API, { status: 500 });
    click(must("birthday-place-button-E31"));
    await waitFor(() => !!q("bc-load-error"), "the error");
    expect(text(q("bc-load-error"))).toContain("Could not read the birthday month.");
    world.failing.clear();
    click([...must("bc-dialog").querySelectorAll("button")].find((b) => text(b) === "Try again"));
    await waitFor(dialogOpen, "the birthday month");
  });
});

describe("what is switched off", () => {
  it("says birthday leave is off in Settings and keeps the list readable", async () => {
    world.birthdayEnabled = false;
    await openBirthdays();
    const notice = must("birthday-off");
    expect(text(notice)).toContain("Birthday leave is switched off");
    expect(text(notice)).toContain("no paid birthday leave and no new birthday compensation");
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/settings?tab=compensation#birthday-enabled");
    expect(rowCodes()).toEqual(["birthday-row-E31"]);
  });

  it("adds no notice of its own while the master switch is off (the page has one)", async () => {
    world.settings.compensationFeatureEnabled = false;
    world.on.set(`GET ${API}`, (_call, qs) => ({
      period: qs.get("period"),
      date: qs.get("date"),
      from: "2026-10-14",
      to: "2026-10-14",
      enabled: { master: false, birthday: false, effectiveFrom: null },
      count: 0,
      benefitCount: 0,
      results: [],
    }));
    mountPage(BIRTHDAYS);
    await waitFor(() => !!q("compensation-features-off"), "the master notice");
    expect(q("birthday-off")).toBeNull();
  });
});
