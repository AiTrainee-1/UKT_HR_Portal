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

// Compensation Leave B in jsdom: raising a claim for Sunday / holiday work (pick a date, tick who worked, choose shifts, give
// a reason), following the claims through the Department Head's approval, withdrawing a pending one, and the notices for what
// is switched off. HR cannot approve: the page says the Department Head does, in Approvals.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "t", user: null }) }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
});

const CLAIMS = "/api/compensation/holiday-work";
const HOLIDAY = "/hr/compensation/compensation-leave/holiday-work";
const RAISE = `${HOLIDAY}/raise`;
const CLAIMS_PATH = `${HOLIDAY}/claims`;

/** The Claims nested subtab: the stat cards, the filters and the list. */
async function openHoliday(url = CLAIMS_PATH) {
  mountPage(url);
  await waitFor(() => !!q("claims-table"), "the claims");
}

/** The Raise a claim nested subtab (the claims are asked for above the tabs: the form knows whether it may raise once they are in). */
async function openRaise(url = RAISE) {
  mountPage(url);
  await waitFor(() => !!q("claim-form") && /\(\d+\)/.test(nestedLabels("holiday-nested")[1] ?? ""), "the claim form");
}

/** Opens Raise with Sunday 11 October chosen and waits for the people who worked. */
async function openSunday() {
  await openRaise(`${RAISE}?hdate=2026-10-11`);
  await waitFor(() => !!q("claim-table"), "the people who worked");
}

/** Opens another nested subtab from the strip. */
async function switchTo(value: string, ready: string) {
  click(nestedTab("holiday-nested", value));
  await waitFor(() => !!q(ready), `the ${value} subtab`);
}

const input = (id: string) => must(id) as HTMLInputElement;
const button = (id: string) => must(id) as HTMLButtonElement;
const area = (id: string) => must(id) as unknown as HTMLTextAreaElement;
// (the table is gone for a moment while another status is on its way)
const claimIds = () =>
  [...(q("claims-table")?.querySelectorAll("tbody tr") ?? [])].map((r) => r.getAttribute("data-testid"));

describe("the nested subtabs", () => {
  it("are Raise a claim, Claims (with its count), Compensation balance and the Earlier Alternative-Day credits, one section each", async () => {
    await openRaise();
    await waitFor(() => /\(\d+\)/.test(nestedLabels("holiday-nested")[3] ?? ""), "the credits count");
    expect(nestedLabels("holiday-nested")).toEqual([
      "Raise a claim",
      "Claims (3)",
      "Compensation balance",
      "Earlier Alternative-Day credits (2)",
    ]);
    expect(nestedTab("holiday-nested", "raise").getAttribute("aria-selected")).toBe("true");
    // only the open section is drawn: Raise has the form and nothing of the other three
    expect(q("claim-form")).not.toBeNull();
    for (const other of ["claim-list", "balance-part", "credits-card"]) expect(q(other), other).toBeNull();

    await switchTo("claims", "claims-table");
    expect(window.location.pathname).toBe(CLAIMS_PATH);
    expect(q("claim-form")).toBeNull();
    expect(q("claim-kpis")).not.toBeNull();
    expect(q("claim-status")).not.toBeNull();
    expect(q("balance-part")).toBeNull();

    await switchTo("balance", "balance-table");
    expect(window.location.pathname).toBe(`${HOLIDAY}/balance`);
    expect(q("claim-list")).toBeNull();
    expect(q("balance-kpis")).not.toBeNull();
    expect(q("balance-search")).not.toBeNull();
    expect(q("credits-card")).toBeNull();

    await switchTo("credits", "credits-card");
    expect(window.location.pathname).toBe(`${HOLIDAY}/credits`);
    expect(q("balance-part")).toBeNull();
  });

  it("do not ask the server again for what they share: the claims once, the credits once", async () => {
    await openRaise();
    await waitFor(() => /\(\d+\)/.test(nestedLabels("holiday-nested")[3] ?? ""), "the credits count");
    await switchTo("claims", "claims-table");
    await switchTo("credits", "credits-card");
    await switchTo("claims", "claims-table");
    const asked = (path: string) => world.requests().filter((r) => r.split("?")[0] === path).length;
    expect(asked(CLAIMS)).toBe(1);
    expect(asked("/api/compensation/credits")).toBe(1);
  });

  it("keep the filters of the page when they switch", async () => {
    await openRaise(`${RAISE}?hstatus=pending&hmonth=10&hdate=2026-10-11`);
    await switchTo("claims", "claims-table");
    expect(params()).toEqual({ hstatus: "pending", hmonth: "10", hdate: "2026-10-11" });
  });

  it("keep a claim that is half filled in while HR looks at the Claims or the balance", async () => {
    await openSunday();
    click(must("claim-select-E21"));
    click(must("claim-shifts-E21-1"));
    typeInto(area("claim-reason"), "Dispatch rush");
    await switchTo("balance", "balance-table");
    await switchTo("raise", "claim-table");
    expect(button("claim-select-E21").getAttribute("data-state")).toBe("checked");
    expect(must("claim-shifts-E21-1").getAttribute("aria-checked")).toBe("true");
    expect(area("claim-reason").value).toBe("Dispatch rush");
  });

  it("shows the switched-off notices above the nested subtabs, so every section has them", async () => {
    world.holidayEnabled = { master: true, holidayWork: false, workflow: true, canRaise: false };
    await openRaise();
    expect(q("holiday-off")).not.toBeNull();
    await switchTo("claims", "claims-table");
    expect(q("holiday-off")).not.toBeNull();
  });
});

describe("how it works", () => {
  it("says only HR raises a claim, the Department Head approves it in Approvals, and then the shifts go to the balance", async () => {
    await openRaise();
    const how = text(q("holiday-how"));
    expect(how).toContain("only HR raises a claim here");
    expect(how).toContain("The Department Head approves it in Approvals");
    expect(how).toContain("HR cannot approve it");
    expect(how).toContain("the shifts are added to the employee's compensation balance");
    expect(how).toContain("A rejected claim credits nothing");
  });

  it("offers no approve or reject on a claim: HR only follows it", async () => {
    await openHoliday();
    const buttons = [...must("claims-table").querySelectorAll("button")].map((b) => text(b));
    expect(buttons.filter((b) => /approve|reject/i.test(b))).toEqual([]);
  });
});

describe("raising a claim", () => {
  it("asks for the date first", async () => {
    await openRaise();
    expect(text(q("claim-no-date"))).toContain("Choose the date of the work");
    expect(q("claim-table")).toBeNull();
    expect(input("claim-date").max).toBe("2026-10-14");
  });

  it("starts the date at the last Sunday, and lists who worked with their punches", async () => {
    await openRaise();
    click(must("claim-last-sunday"));
    expect(params().hdate).toBe("2026-10-11");
    await waitFor(() => !!q("claim-table"), "the people who worked");
    expect(world.requests().some((r) => r === "/api/compensation/holiday-work/eligible?date=2026-10-11")).toBe(true);
    expect(text(q("claim-day"))).toContain("Sun, 11 Oct 2026");
    expect(text(q("claim-day"))).toContain("3 worked, 2 can be claimed for");
    expect(text(q("claim-punches-E21"))).toBe("09:00 - 17:30 (8 h 30 min, 2 punches)");
    expect(text(q("claim-punches-E22"))).toBe("10:00 - 14:00 (4 h 00 min, 4 punches)");
  });

  it("explains why somebody who worked cannot be claimed for, and does not let them be ticked", async () => {
    await openSunday();
    expect(text(q("claim-reason-E23"))).toContain("already has a claim for 11 Oct 2026 that is pending");
    expect(button("claim-select-E23").disabled).toBe(true);
    expect(button("claim-select-E21").disabled).toBe(false);
    expect(q("claim-shifts-E23-0.5")).toBeNull();
  });

  it("says a weekday is not a Sunday or a holiday, and lists nobody", async () => {
    await openRaise(`${RAISE}?hdate=2026-10-13`);
    await waitFor(() => !!q("claim-not-claimable"), "the message");
    expect(text(q("claim-not-claimable"))).toContain("neither a Sunday nor a declared holiday");
    expect(q("claim-table")).toBeNull();
    expect(q("claim-submit")).toBeNull();
  });

  it("follows the date typed in", async () => {
    await openRaise();
    typeInto(input("claim-date"), "2026-10-13");
    await waitFor(() => !!q("claim-not-claimable"), "the message");
    expect(params().hdate).toBe("2026-10-13");
  });

  it("shows an error with a Retry when who worked cannot be read", async () => {
    world.failing.set(`${CLAIMS}/eligible`, { status: 500 });
    await openRaise(`${RAISE}?hdate=2026-10-11`);
    await waitFor(() => !!q("claim-eligible-error"), "the error");
    expect(text(q("claim-eligible-error"))).toContain("Could not load who worked that day");
    world.failing.clear();
    click([...must("claim-eligible-error").querySelectorAll("button")].find((b) => text(b) === "Retry"));
    await waitFor(() => !!q("claim-table"), "the people who worked");
  });

  it("needs somebody ticked, shifts for each, and a reason before it is sent", async () => {
    await openSunday();
    // nobody ticked: the shifts of every row are greyed out and the button has nothing to send
    expect(button("claim-submit").disabled).toBe(true);
    expect(button("claim-shifts-E21-0.5").disabled).toBe(true);
    click(must("claim-select-E21"));
    expect(button("claim-shifts-E21-0.5").disabled).toBe(false);
    expect(text(button("claim-submit"))).toBe("Submit 1 claim for HOD approval");
    // no shifts chosen yet
    click(must("claim-submit"));
    await settle();
    expect(text(q("claim-first-problem"))).toBe("Choose the shifts for every ticked employee.");
    click(must("claim-shifts-E21-1"));
    click(must("claim-submit"));
    await settle();
    expect(text(q("claim-first-problem"))).toMatch(/Give a reason/);
    expect(bodiesOf(world, "POST", CLAIMS)).toEqual([]);
  });

  it("sends one item per ticked employee with their own shifts, and the reason", async () => {
    await openSunday();
    click(must("claim-select-E21"));
    click(must("claim-select-E22"));
    click(must("claim-bulk-0.5")); // the same shifts for everybody ticked
    expect(must("claim-shifts-E21-0.5").getAttribute("aria-checked")).toBe("true");
    expect(must("claim-shifts-E22-0.5").getAttribute("aria-checked")).toBe("true");
    click(must("claim-shifts-E22-1")); // then one of them differently
    typeInto(area("claim-reason"), "Dispatch rush");
    expect(text(button("claim-submit"))).toBe("Submit 2 claims for HOD approval");
    click(must("claim-submit"));
    await waitFor(() => bodiesOf(world, "POST", CLAIMS).length === 1, "the request");
    expect(bodiesOf(world, "POST", CLAIMS)[0]).toEqual({
      workDate: "2026-10-11",
      reason: "Dispatch rush",
      items: [
        { employeeId: 21, shifts: 0.5 },
        { employeeId: 22, shifts: 1 },
      ],
    });
  });

  it("opens Claims on the month of the work and every status after raising, so the new claims are on screen", async () => {
    await openRaise(`${RAISE}?hdate=2026-10-11&hmonth=9&hstatus=approved`);
    await waitFor(() => !!q("claim-table"), "the people who worked");
    click(must("claim-select-E21"));
    click(must("claim-shifts-E21-1"));
    typeInto(area("claim-reason"), "Dispatch rush");
    click(must("claim-submit"));
    await waitFor(() => bodiesOf(world, "POST", CLAIMS).length === 1, "the request");
    await waitFor(() => params().hmonth === "10", "the list to move to October");
    // the raise switched to the Claims nested subtab, with the date of the work kept in the address
    expect(window.location.pathname).toBe(CLAIMS_PATH);
    expect(nestedTab("holiday-nested", "claims").getAttribute("aria-selected")).toBe("true");
    expect(q("claim-form")).toBeNull();
    expect(params().hstatus).toBeUndefined();
    expect(params().hdate).toBe("2026-10-11");
    await waitFor(() => !!q("claim-row-3100"), "the new claim in the list");
    expect(text(q("claim-row-3100"))).toContain("Fara Khan");
    expect(text(q("claim-row-3100"))).toContain("Waiting for HOD");
  });

  it("clears the form after a claim is raised, and shows on Claims who nobody can decide for yet", async () => {
    world.on.set(`POST ${CLAIMS}`, () => ({
      created: 1,
      claims: [],
      warnings: ["Fara Khan has no Department Head assigned, so nobody can approve this claim yet (HOD Assignment)."],
    }));
    await openSunday();
    click(must("claim-select-E21"));
    click(must("claim-shifts-E21-1"));
    typeInto(area("claim-reason"), "Dispatch rush");
    click(must("claim-submit"));
    await waitFor(() => !!q("claim-warnings"), "the warning");
    // the warning is on the Claims subtab, where HR lands
    expect(window.location.pathname).toBe(CLAIMS_PATH);
    expect(text(q("claim-warnings"))).toContain("Fara Khan has no Department Head assigned");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Raised 1 claim for the Department Head" }));
    click(must("claim-warnings-dismiss"));
    expect(q("claim-warnings")).toBeNull();
    // back on Raise, the form is empty for the next claim
    await switchTo("raise", "claim-table");
    expect(area("claim-reason").value).toBe("");
    expect(button("claim-select-E21").getAttribute("data-state")).toBe("unchecked");
  });

  it("is all or nothing: one person who cannot be claimed for is named, and nothing is raised", async () => {
    world.on.set(`POST ${CLAIMS}`, () =>
      apiError(400, {
        error:
          "1 of 2 employees cannot be claimed for. Nothing was raised: Gopal Das has no punches or attendance on 11 Oct 2026.",
        problems: [
          {
            employeeId: 22,
            error: "Gopal Das has no punches or attendance on 11 Oct 2026, so there is no work on record to claim for.",
          },
        ],
      }),
    );
    await openSunday();
    click(must("claim-select-E21"));
    click(must("claim-select-E22"));
    click(must("claim-bulk-1"));
    typeInto(area("claim-reason"), "Dispatch rush");
    click(must("claim-submit"));
    await waitFor(() => !!q("claim-error"), "the error");
    expect(text(q("claim-error"))).toContain("Nothing was raised");
    expect(text(q("claim-problem-E22"))).toContain("no work on record to claim for");
    expect(q("claim-problem-E21")).toBeNull();
    // the form is kept, so the person can be unticked and the rest sent again
    expect(area("claim-reason").value).toBe("Dispatch rush");
    expect(button("claim-select-E21").getAttribute("data-state")).toBe("checked");
  });

  it("ticks everybody who can be claimed for at once, and clears the ticks again", async () => {
    await openSunday();
    click(must("claim-select-all"));
    expect(button("claim-select-E21").getAttribute("data-state")).toBe("checked");
    expect(button("claim-select-E22").getAttribute("data-state")).toBe("checked");
    expect(button("claim-select-E23").getAttribute("data-state")).toBe("unchecked");
    expect(text(button("claim-submit"))).toBe("Submit 2 claims for HOD approval");
    click(must("claim-select-all"));
    expect(text(button("claim-submit"))).toBe("Submit claim for HOD approval");
  });
});

describe("the claims", () => {
  it("count the waiting, approved and rejected claims with their shifts", async () => {
    await openHoliday();
    expect(text(q("claim-kpi-pending-value"))).toBe("1");
    expect(text(q("claim-kpi-pending"))).toContain("0.50 shifts");
    expect(text(q("claim-kpi-approved-value"))).toBe("1");
    expect(text(q("claim-kpi-approved"))).toContain("1 shifts added to balances");
    expect(text(q("claim-kpi-rejected-value"))).toBe("1");
  });

  it("show where each stands in the approval, who decided and what happened to the shifts", async () => {
    await openHoliday();
    expect(claimIds()).toEqual(["claim-row-3001", "claim-row-3002", "claim-row-3003"]);
    const pending = text(q("claim-row-3001"));
    expect(pending).toContain("Hari Om");
    expect(pending).toContain("11 Oct 2026");
    expect(pending).toContain("Sunday");
    expect(pending).toContain("0.50 shifts");
    expect(pending).toContain("Dispatch rush");
    expect(pending).toContain("Waiting for HOD");
    expect(text(q("claim-hod-3001"))).toBe("HOD: Suresh Raj");
    expect(q("claim-decision-3001")).toBeNull();

    const approved = text(q("claim-row-3002"));
    expect(approved).toContain("Approved");
    expect(text(q("claim-decision-3002"))).toBe("Approved by Suresh Raj, 12 Oct 2026");
    expect(approved).toContain("Added to the balance");

    const rejected = text(q("claim-row-3003"));
    expect(rejected).toContain("Rejected");
    expect(text(q("claim-decision-3003"))).toBe("Rejected by Suresh Raj, 12 Oct 2026");
    expect(rejected).toContain("Not authorised");
  });

  it("show the approval path of each claim, from HR to the Department Head", async () => {
    await openHoliday();
    const trail = must("claim-row-3001").querySelector('[data-testid="approval-trail"]')!;
    expect(text(trail)).toContain("HR");
    expect(text(trail)).toContain("HOD");
    expect(text(trail)).toContain("Pending");
  });

  it("say when the employee has no Department Head to decide", async () => {
    world.claims[0] = { ...world.claims[0], hodName: null };
    await openHoliday();
    expect(text(q("claim-hod-3001"))).toBe("No Department Head assigned");
  });

  it("filter by status, asking the server and keeping it in the address", async () => {
    await openHoliday();
    pickOption(must("claim-status"), "Approved");
    expect(params().hstatus).toBe("approved");
    await waitFor(() => claimIds().length === 1, "the filtered claims");
    expect(claimIds()).toEqual(["claim-row-3002"]);
    expect(world.requests().some((r) => r.includes("status=approved"))).toBe(true);
    pickOption(must("claim-status"), "Every status");
    await waitFor(() => claimIds().length === 3, "every claim");
    expect(params().hstatus).toBeUndefined();
  });

  it("filter by the month of the work", async () => {
    await openHoliday();
    pickOption(must("claim-month"), "September");
    expect(params().hmonth).toBe("9");
    await waitFor(() => world.requests().some((r) => r.includes("month=9&year=2026")), "the request");
  });

  it("can list every month at once, so a claim still waiting from an earlier month is found", async () => {
    await openHoliday();
    pickOption(must("claim-month"), "All months");
    expect(params().hmonth).toBe("all");
    await waitFor(() => world.requests().some((r) => r.includes("/holiday-work?anyMonth=1")), "the request");
    const asked = new URLSearchParams(
      world
        .requests()
        .filter((r) => r.startsWith(`${CLAIMS}?`))
        .at(-1)!
        .split("?")[1],
    );
    expect(asked.get("anyMonth")).toBe("1");
    expect(asked.get("month")).toBeNull();
    expect(asked.get("year")).toBeNull();
    await waitFor(() => claimIds().length === 3, "the claims");
    // the year does not apply to every month
    expect((must("claim-year") as HTMLButtonElement).disabled).toBe(true);
    // and back to a month
    pickOption(must("claim-month"), "October");
    expect(params().hmonth).toBe("10");
  });

  it("say there are none for a month, and how to get one", async () => {
    world.claims = [];
    mountPage(CLAIMS_PATH);
    await waitFor(() => !!q("claims-empty"), "the empty state");
    expect(text(q("claims-empty"))).toContain("No claim for this month and status");
  });

  it("show an error with a Retry when they cannot be read", async () => {
    world.failing.set(CLAIMS, { status: 500 });
    mountPage(CLAIMS_PATH);
    await waitFor(() => !!q("claims-error"), "the error");
    expect(text(q("claims-error"))).toContain("Could not load the claims");
    world.failing.clear();
    click([...must("claims-error").querySelectorAll("button")].find((b) => text(b) === "Retry"));
    await waitFor(() => !!q("claims-table"), "the claims");
  });
});

describe("withdrawing a claim", () => {
  it("is offered only on a claim still waiting for the Department Head", async () => {
    await openHoliday();
    expect(q("claim-withdraw-3001")).not.toBeNull();
    expect(q("claim-withdraw-3002")).toBeNull();
    expect(q("claim-withdraw-3003")).toBeNull();
  });

  it("asks first, then removes the claim", async () => {
    await openHoliday();
    click(must("claim-withdraw-3001"));
    await waitFor(() => !!q("claim-withdraw-dialog"), "the confirmation");
    expect(text(q("claim-withdraw-dialog"))).toContain("Hari Om, 11 Oct 2026, 0.50 shifts");
    expect(text(q("claim-withdraw-dialog"))).toContain("nothing is credited");
    click(must("claim-withdraw-confirm"));
    await waitFor(() => world.writes.some((w) => w.method === "DELETE" && w.url === `${CLAIMS}/3001`), "the request");
    await waitFor(() => !q("claim-row-3001"), "the row to go");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Claim withdrawn" }));
  });

  it("keeps the claim when the question is answered No", async () => {
    await openHoliday();
    click(must("claim-withdraw-3001"));
    await waitFor(() => !!q("claim-withdraw-dialog"), "the confirmation");
    click([...must("claim-withdraw-dialog").querySelectorAll("button")].find((b) => text(b) === "Keep the claim"));
    await waitFor(() => !q("claim-withdraw-dialog"), "the dialog to close");
    expect(world.writes).toEqual([]);
  });

  it("says so when the server refuses (the Department Head decided meanwhile)", async () => {
    world.on.set(`DELETE ${CLAIMS}/3001`, () =>
      apiError(400, {
        error:
          "This claim is already approved: only a claim that is still waiting for the Department Head can be withdrawn.",
      }),
    );
    await openHoliday();
    click(must("claim-withdraw-3001"));
    await waitFor(() => !!q("claim-withdraw-dialog"), "the confirmation");
    click(must("claim-withdraw-confirm"));
    await waitFor(() => h.toast.mock.calls.length > 0, "the toast");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not withdraw it",
        description: expect.stringContaining("already approved"),
      }),
    );
  });
});

describe("what is switched off", () => {
  it("says work on Sundays and holidays is off in Settings, pauses raising and withdrawing, and keeps everything readable", async () => {
    world.holidayEnabled = { master: true, holidayWork: false, workflow: true, canRaise: false };
    await openSunday();
    const notice = must("holiday-off");
    expect(text(notice)).toContain("Work on Sundays and company holidays is switched off");
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/settings?tab=compensation#holiday-work-enabled");
    click(must("claim-select-E21"));
    expect(button("claim-submit").disabled).toBe(true);
    expect(button("claim-submit").title).toMatch(/switched off in Settings → Compensation/);
    await switchTo("claims", "claims-table");
    expect(button("claim-withdraw-3001").disabled).toBe(true);
    expect(claimIds()).toHaveLength(3);
  });

  it("says the approval itself is off, with a link to where to switch it on", async () => {
    world.holidayEnabled = { master: true, holidayWork: true, workflow: false, canRaise: false };
    await openSunday();
    const notice = must("holiday-workflow-off");
    expect(text(notice)).toContain("The approval for Sunday / holiday work is switched off");
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/user-management?tab=approvals");
    expect(q("holiday-off")).toBeNull();
    click(must("claim-select-E21"));
    expect(button("claim-submit").disabled).toBe(true);
    expect(button("claim-submit").title).toMatch(/approval is switched off in User Management/);
    // a claim already waiting can still be withdrawn
    await switchTo("claims", "claims-table");
    expect(button("claim-withdraw-3001").disabled).toBe(false);
  });

  it("pauses raising and withdrawing while the master switch is off", async () => {
    world.settings.compensationFeatureEnabled = false;
    await openSunday();
    await waitFor(() => !!q("compensation-features-off"), "the master notice");
    click(must("claim-select-E21"));
    expect(button("claim-submit").disabled).toBe(true);
    expect(button("claim-submit").title).toMatch(/Settings → Payroll/);
    await switchTo("claims", "claims-table");
    expect(button("claim-withdraw-3001").disabled).toBe(true);
    expect(q("holiday-off")).toBeNull();
  });

  it("locks Submit and Withdraw for a View Only role, and leaves Last Sunday and the filters alone", async () => {
    await openSunday();
    click(must("claim-select-E21"));
    lockMutatingControls(document.body);
    await settle();
    expect(button("claim-submit").disabled).toBe(true);
    expect(button("claim-last-sunday").disabled).toBe(false);
    await switchTo("claims", "claims-table");
    lockMutatingControls(document.body);
    await settle();
    expect(button("claim-withdraw-3001").disabled).toBe(true);
    expect((must("claim-status") as HTMLButtonElement).disabled).toBe(false);
  });
});
