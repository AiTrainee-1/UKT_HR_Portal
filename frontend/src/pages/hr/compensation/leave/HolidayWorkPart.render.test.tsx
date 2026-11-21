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
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "../harness";
import { choose, lastQuery, rowKeys, rowOf } from "./leave-test-utils";

// Compensation Leave B in jsdom: the one compensation claim workflow. Raise: the Sundays and holidays of the month week by
// week with how many worked (the previous Sunday open by default), then who worked the day picked, ticked and raised for
// the Department Head. Claims: every kind of claim with its filters, the figures by status and by kind, the drawer with the
// approval trail, what the claim is based on and what it put on the balance (with links), and Withdraw. HR never approves.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: null }),
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
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
});

const RAISE_API = "/api/compensation/holiday-work";
const SUNDAY_DATE = "2026-10-11";
const CLAIMS_API = "/api/compensation/claims";
const MONTH_API = "/api/compensation/holiday-work/month";
const HOLIDAY = "/hr/compensation/compensation-leave/holiday-work";
const RAISE = `${HOLIDAY}/raise`;
const CLAIMS_PATH = `${HOLIDAY}/claims`;

const claimsReady = () => rowKeys("claims-table").length > 0;

/** The Claims nested subtab: the tiles, the filters and the list. */
async function openClaims(url = CLAIMS_PATH) {
  mountPage(url);
  await waitFor(claimsReady, "the claims");
}

/** The Raise nested subtab with its month strip (and, by default, the previous Sunday's people). */
async function openRaise(url = RAISE) {
  mountPage(url);
  await waitFor(() => !!q("claim-form") && !!q("hw-week"), "the month strip");
}

/** Raise on Sunday 11 October (the default day), waiting for the people who worked. */
async function openSunday(url = RAISE) {
  await openRaise(url);
  await waitFor(() => !!q("claim-table"), "the people who worked");
}

async function switchTo(value: string, ready: () => boolean) {
  click(nestedTab("holiday-nested", value));
  await waitFor(ready, `the ${value} subtab`);
}

const button = (id: string) => must(id) as HTMLButtonElement;
const area = (id: string) => must(id) as unknown as HTMLTextAreaElement;
const claimsAsked = () => lastQuery(world.requests(), CLAIMS_API)!;
const asked = (path: string) => world.requests().filter((r) => r.split("?")[0] === path).length;

describe("the nested subtabs", () => {
  it("are Raise a claim, Claims (with its count), Balance and Credits, one section each", async () => {
    await openRaise();
    await waitFor(() => /\(\d+\)/.test(nestedLabels("holiday-nested")[1] ?? ""), "the claims count");
    // October 2026 has seven claims of every kind
    expect(nestedLabels("holiday-nested")).toEqual(["Raise a claim", "Claims (7)", "Balance", "Credits"]);
    expect(nestedTab("holiday-nested", "raise").getAttribute("aria-selected")).toBe("true");
    expect(q("claim-form")).not.toBeNull();
    for (const other of ["claim-list", "balance-part", "credits-part"]) expect(q(other), other).toBeNull();

    await switchTo("claims", claimsReady);
    expect(window.location.pathname).toBe(CLAIMS_PATH);
    expect(q("claim-form")).toBeNull();
    expect(q("claim-kpis")).not.toBeNull();
    expect(q("claim-status")).not.toBeNull();

    await switchTo("balance", () => rowKeys("balance-table").length > 0);
    expect(window.location.pathname).toBe(`${HOLIDAY}/balance`);
    expect(q("claim-list")).toBeNull();

    await switchTo("credits", () => rowKeys("ledger-table").length > 0);
    expect(window.location.pathname).toBe(`${HOLIDAY}/credits`);
    expect(q("credits-card")).not.toBeNull(); // the earlier Alternative-Day credits are a section of Credits
    expect(q("balance-part")).toBeNull();
  });

  it("do not ask the server again for what they share: the claims once, the ledger once", async () => {
    await openRaise();
    await switchTo("claims", claimsReady);
    await switchTo("credits", () => rowKeys("ledger-table").length > 0);
    await switchTo("claims", claimsReady);
    await switchTo("credits", () => rowKeys("ledger-table").length > 0);
    expect(asked(CLAIMS_API)).toBe(1);
    expect(asked("/api/compensation/ledger")).toBe(1);
    expect(asked("/api/compensation/credits")).toBe(1);
  });

  it("keep the filters of the page when they switch", async () => {
    await openRaise(`${RAISE}?hstatus=pending&hmonth=10&hdate=2026-10-11`);
    await switchTo("claims", claimsReady);
    expect(params()).toEqual({ hstatus: "pending", hmonth: "10", hdate: "2026-10-11" });
  });

  it("keep a claim that is half filled in while HR looks at the Claims or the balance", async () => {
    await openSunday();
    click(must("claim-select-E21"));
    click(must("claim-shifts-E21-1"));
    typeInto(area("claim-reason"), "Dispatch rush");
    await switchTo("balance", () => rowKeys("balance-table").length > 0);
    await switchTo("raise", () => !!q("claim-table"));
    expect(button("claim-select-E21").getAttribute("data-state")).toBe("checked");
    expect(must("claim-shifts-E21-1").getAttribute("aria-checked")).toBe("true");
    expect(area("claim-reason").value).toBe("Dispatch rush");
  });

  it("shows the switched-off notices above the nested subtabs, so every section has them", async () => {
    world.holidayEnabled = { master: true, holidayWork: false, workflow: true, canRaise: false };
    await openRaise();
    await waitFor(() => !!q("holiday-off"), "the notice");
    await switchTo("claims", claimsReady);
    expect(q("holiday-off")).not.toBeNull();
  });
});

describe("how it works", () => {
  it("says employees claim from their apps, HR can raise on their behalf, and every claim goes to the Department Head", async () => {
    await openRaise();
    const how = text(q("holiday-how"));
    expect(how).toContain("employees can now claim a Sunday or holiday they worked themselves");
    expect(how).toContain("in the mobile app or the Employee Web App");
    expect(how).toContain("HR can raise it here on their behalf");
    expect(how).toContain("Every claim goes to the employee's Department Head");
    expect(how).toContain("HR cannot approve it");
    expect(how).toContain("the shifts are added to the employee's compensation balance");
    expect(how).toContain("A rejected claim credits nothing");
    expect(how).not.toContain("only HR raises");
  });

  it("offers no approve or reject on a claim: HR only follows it", async () => {
    await openClaims();
    const buttons = [...must("claims-table").querySelectorAll("button")].map((b) => text(b));
    expect(buttons.filter((b) => /approve|reject/i.test(b))).toEqual([]);
  });
});

describe("the month strip of Raise", () => {
  it("shows the month's Sundays and holidays week by week, with how many worked and the claims made", async () => {
    await openRaise();
    expect(world.requests()).toContain(`${MONTH_API}?month=10&year=2026`);
    expect(text(q("hw-strip-month"))).toBe("October 2026");
    expect(
      [...document.body.querySelectorAll('[data-testid="hw-week"]')].map((w) => text(w.querySelector("p"))),
    ).toEqual(["Week 1", "Week 2", "Week 3", "Week 4"]);
    expect(text(q("hw-strip-summary"))).toBe(
      "4 Sundays and 1 holiday · 6 worked · 3 still to claim · 1 waiting for HOD",
    );
    expect(text(q("hw-day-2026-10-02"))).toContain("Gandhi Jayanti");
    expect(text(q("hw-day-2026-10-11-worked"))).toBe("3 worked · 2 to claim");
    expect(text(q("hw-day-2026-10-11-claims"))).toBe("1 waiting · 1 approved");
    expect(text(q("hw-day-2026-10-04-claims"))).toBe("1 approved");
    // a Sunday still to come cannot be picked
    expect(button("hw-day-2026-10-18").disabled).toBe(true);
    expect(text(q("hw-day-2026-10-18"))).toContain("Not come yet");
  });

  it("opens on the previous Sunday by default and lists who worked it, without writing the day to the address", async () => {
    await openSunday();
    expect(must("hw-day-2026-10-11").getAttribute("aria-pressed")).toBe("true");
    expect(must("hw-day-2026-10-04").getAttribute("aria-pressed")).toBe("false");
    expect(world.requests()).toContain(`${RAISE_API}/eligible?date=2026-10-11`);
    expect(params().hdate).toBeUndefined();
    expect(text(q("claim-day"))).toContain("Sun, 11 Oct 2026");
    expect(text(q("claim-day"))).toContain("3 worked, 2 can be claimed for");
    expect(text(q("claim-punches-E21"))).toBe("09:00 - 17:30 (8 h 30 min, 2 punches)");
    expect(text(q("claim-punches-E22"))).toBe("10:00 - 14:00 (4 h 00 min, 4 punches)");
  });

  it("opens another day when it is clicked", async () => {
    await openSunday();
    click(must("hw-day-2026-10-04"));
    expect(params().hdate).toBe("2026-10-04");
    await waitFor(() => !!q("claim-person-E27"), "who worked on the 4th");
    expect(must("hw-day-2026-10-04").getAttribute("aria-pressed")).toBe("true");
    expect(q("claim-person-E21")).toBeNull();
  });

  it("moves to the previous and the next month, with nothing picked in another month", async () => {
    await openSunday();
    click(must("hw-strip-prev"));
    expect(params()).toMatchObject({ rmonth: "9", ryear: "2026" });
    await waitFor(() => text(q("hw-strip-month")) === "September 2026" && !!q("hw-day-2026-09-20"), "September");
    expect(world.requests()).toContain(`${MONTH_API}?month=9&year=2026`);
    expect(q("claim-no-date")).not.toBeNull();
    expect(text(q("claim-no-date"))).toContain("Pick a Sunday or a holiday in the strip");
    click(must("hw-day-2026-09-20"));
    expect(params().hdate).toBe("2026-09-20");
    click(must("hw-strip-today"));
    await waitFor(() => text(q("hw-strip-month")) === "October 2026", "back to this month");
    expect(params().rmonth).toBeUndefined();
    expect(params().hdate).toBeUndefined();
    expect(must("hw-day-2026-10-11").getAttribute("aria-pressed")).toBe("true");
  });

  it("jumps back to the last Sunday from another month", async () => {
    await openRaise(`${RAISE}?rmonth=9&ryear=2026`);
    expect(q("claim-no-date")).not.toBeNull();
    click(must("claim-last-sunday"));
    expect(params()).toEqual({ hdate: "2026-10-11" });
    await waitFor(() => !!q("claim-table"), "the people who worked");
  });

  it("filters the strip and who worked by department, branch and name", async () => {
    await openSunday();
    choose("raise-dept", "1");
    await waitFor(() => !!q("claim-filtered-out"), "nobody of Sales");
    expect(lastQuery(world.requests(), MONTH_API)!.get("departmentId")).toBe("1");
    choose("raise-dept", "");
    await waitFor(() => !!q("claim-table"), "everyone again");
    choose("raise-branch", "2");
    await waitFor(() => lastQuery(world.requests(), MONTH_API)!.get("branchId") === "2", "the branch");
    typeInto(must("raise-search") as HTMLInputElement, "fara");
    await waitFor(() => !q("claim-person-E22"), "the search");
    expect(q("claim-person-E21")).not.toBeNull();
    expect(text(q("claim-day"))).toContain("1 shown with the filters");
  });

  it("shows an error with a Retry when the month cannot be read", async () => {
    world.failing.set(MONTH_API, { status: 500 });
    mountPage(RAISE);
    await waitFor(() => !!q("hw-strip-error"), "the error");
    expect(text(q("hw-strip-error"))).toContain("Could not load the Sundays and holidays of the month");
    world.failing.clear();
    click([...must("hw-strip-error").querySelectorAll("button")].find((b) => text(b) === "Retry"));
    await waitFor(() => !!q("hw-week"), "the strip");
  });
});

describe("raising a claim", () => {
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

  it("shows an error with a Retry when who worked cannot be read", async () => {
    world.failing.set(`${RAISE_API}/eligible`, { status: 500 });
    await openRaise(`${RAISE}?hdate=2026-10-11`);
    await waitFor(() => !!q("claim-eligible-error"), "the error");
    expect(text(q("claim-eligible-error"))).toContain("Could not load who worked that day");
    world.failing.clear();
    click([...must("claim-eligible-error").querySelectorAll("button")].find((b) => text(b) === "Retry"));
    await waitFor(() => !!q("claim-table"), "the people who worked");
  });

  it("needs somebody ticked, shifts for each, and a reason before it is sent", async () => {
    await openSunday();
    expect(button("claim-submit").disabled).toBe(true);
    expect(button("claim-shifts-E21-0.5").disabled).toBe(true);
    click(must("claim-select-E21"));
    expect(button("claim-shifts-E21-0.5").disabled).toBe(false);
    expect(text(button("claim-submit"))).toBe("Submit 1 claim for HOD approval");
    click(must("claim-submit"));
    await settle();
    expect(text(q("claim-first-problem"))).toBe("Choose the shifts for every ticked employee.");
    click(must("claim-shifts-E21-1"));
    click(must("claim-submit"));
    await settle();
    expect(text(q("claim-first-problem"))).toMatch(/Give a reason/);
    expect(bodiesOf(world, "POST", RAISE_API)).toEqual([]);
  });

  it("sends one item per ticked employee with their own shifts, and the reason, for the day picked", async () => {
    await openSunday();
    click(must("claim-select-E21"));
    click(must("claim-select-E22"));
    click(must("claim-bulk-0.5"));
    expect(must("claim-shifts-E21-0.5").getAttribute("aria-checked")).toBe("true");
    expect(must("claim-shifts-E22-0.5").getAttribute("aria-checked")).toBe("true");
    click(must("claim-shifts-E22-1"));
    typeInto(area("claim-reason"), "Dispatch rush");
    expect(text(button("claim-submit"))).toBe("Submit 2 claims for HOD approval");
    click(must("claim-submit"));
    await waitFor(() => bodiesOf(world, "POST", RAISE_API).length === 1, "the request");
    expect(bodiesOf(world, "POST", RAISE_API)[0]).toEqual({
      workDate: "2026-10-11",
      reason: "Dispatch rush",
      items: [
        { employeeId: 21, shifts: 0.5 },
        { employeeId: 22, shifts: 1 },
      ],
    });
  });

  it("opens Claims on the month of the work, every kind and status, after raising, so the new claims are on screen", async () => {
    await openSunday(`${RAISE}?hmonth=9&hstatus=approved&hkind=birthday`);
    click(must("claim-select-E21"));
    click(must("claim-shifts-E21-1"));
    typeInto(area("claim-reason"), "Dispatch rush");
    click(must("claim-submit"));
    await waitFor(() => bodiesOf(world, "POST", RAISE_API).length === 1, "the request");
    await waitFor(() => params().hmonth === "10", "the list to move to October");
    expect(window.location.pathname).toBe(CLAIMS_PATH);
    expect(nestedTab("holiday-nested", "claims").getAttribute("aria-selected")).toBe("true");
    expect(params().hstatus).toBeUndefined();
    expect(params().hkind).toBeUndefined();
    expect(params().hdate).toBe("2026-10-11");
    await waitFor(() => !!rowOf("claims-table", 3100), "the new claim in the list");
    expect(text(rowOf("claims-table", 3100))).toContain("Fara Khan");
    expect(text(rowOf("claims-table", 3100))).toContain("Waiting for HOD");
  });

  it("clears the form after a claim is raised, and shows on Claims who nobody can decide for yet", async () => {
    world.on.set(`POST ${RAISE_API}`, () => ({
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
    expect(window.location.pathname).toBe(CLAIMS_PATH);
    expect(text(q("claim-warnings"))).toContain("Fara Khan has no Department Head assigned");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Raised 1 claim for the Department Head" }));
    click(must("claim-warnings-dismiss"));
    expect(q("claim-warnings")).toBeNull();
    await switchTo("raise", () => !!q("claim-table"));
    expect(area("claim-reason").value).toBe("");
    expect(button("claim-select-E21").getAttribute("data-state")).toBe("unchecked");
  });

  it("is all or nothing: one person who cannot be claimed for is named, and nothing is raised", async () => {
    world.on.set(`POST ${RAISE_API}`, () =>
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

describe("the claims of every kind", () => {
  it("opens on the current month, every kind and status, a page of 25", async () => {
    await openClaims();
    const sent = claimsAsked();
    expect(Object.fromEntries(sent)).toEqual({ month: "10", year: "2026", page: "1", pageSize: "25" });
    expect(rowKeys("claims-table")).toEqual(["3001", "3002", "3003", "3004", "3005", "3006", "3007"]);
  });

  it("count them by status (with their shifts) and by kind", async () => {
    await openClaims();
    expect(text(q("claim-kpi-pending-value"))).toBe("4");
    // credits waiting (in) apart from days off waiting (out): 1.50 + 0.50, no longer one 2 shifts total
    expect(text(q("claim-kpi-pending"))).toContain("1.50 in · 0.50 out");
    expect(text(q("claim-kpi-approved-value"))).toBe("2");
    expect(text(q("claim-kpi-approved"))).toContain("1.50 shifts credited");
    expect(text(q("claim-kpi-rejected-value"))).toBe("1");
    expect(text(q("claim-kpi-kind-holiday_work-value"))).toBe("3");
    expect(text(q("claim-kpi-kind-ot_allowance-value"))).toBe("1");
    expect(text(q("claim-kpi-kind-ot_shift-value"))).toBe("1");
    expect(text(q("claim-kpi-kind-birthday-value"))).toBe("1");
    expect(text(q("claim-kpi-kind-use_balance-value"))).toBe("1");
  });

  it("let the status tiles' labels and hints wrap instead of being cut off on a phone", async () => {
    await openClaims();
    for (const status of ["pending", "approved", "rejected"]) {
      const label = must(`claim-kpi-${status}-label`);
      expect(label.className, status).not.toContain("truncate");
      expect(label.className, status).toContain("break-words");
      const hint = must(`claim-kpi-${status}-hint`);
      expect(hint.className, status).not.toContain("truncate");
      expect(hint.className, status).toContain("break-words");
    }
    expect(text(q("claim-kpi-pending-hint"))).toBe("1.50 in · 0.50 out");
    expect(text(q("claim-kpi-approved-hint"))).toBe("1.50 shifts credited");
  });

  it("shrink the kind tiles' icons and letter spacing below 640 px, so a 360 px phone keeps each word whole", async () => {
    await openClaims();
    for (const kind of ["holiday_work", "ot_allowance", "ot_shift", "birthday", "use_balance"]) {
      expect(must(`claim-kpi-kind-${kind}`).querySelector('[aria-hidden="true"]')!.className, kind).toContain(
        "max-sm:size-6",
      );
      expect(must(`claim-kpi-kind-${kind}-label`).className, kind).toContain("max-sm:tracking-normal");
    }
  });

  it("label the kind tiles with short full words that wrap instead of being cut off", async () => {
    await openClaims();
    const labels = ["holiday_work", "ot_allowance", "ot_shift", "birthday", "use_balance"].map((kind) => {
      const label = must(`claim-kpi-kind-${kind}-label`);
      expect(label.className).not.toContain("truncate");
      expect(label.className).toContain("break-words");
      return text(label);
    });
    expect(labels).toEqual(["Sunday work", "Allowance", "OT credit", "Birthday", "Day off"]);
    // the full name stays in the tile's tooltip
    expect(must("claim-kpi-kind-ot_shift").getAttribute("title")).toBe("Show only: OT shift credit (Type 2)");
    // five in a row only on a wide screen (1280 px and up)
    expect(must("claim-kinds").className).toContain("xl:grid-cols-5");
    expect(must("claim-kinds").className).toContain("lg:grid-cols-3");
    expect(must("claim-kinds").className).not.toContain("lg:grid-cols-5");
  });

  it("show each claim's kind, who raised it, its date and source, what was claimed and where it stands", async () => {
    await openClaims();
    const sunday = text(rowOf("claims-table", 3001));
    expect(sunday).toContain("Hari Om");
    expect(sunday).toContain("Sunday / holiday work");
    expect(sunday).toContain("Raised by HR (Meena)");
    expect(sunday).toContain("11 Oct 2026");
    expect(sunday).toContain("0.50 shifts");
    expect(sunday).toContain("Waiting for HOD");
    expect(text(q("claim-hod-3001"))).toBe("HOD: Suresh Raj");

    const allowance = text(rowOf("claims-table", 3004));
    expect(allowance).toContain("OT allowance (Type 1)");
    expect(allowance).toContain("Raised by Employee (app)");
    expect(allowance).toContain("Shift end 17:30, last punch 19:30, 2 h past the shift end");
    expect(allowance).toContain("1 h late-in");

    const shift = text(rowOf("claims-table", 3005));
    expect(shift).toContain("OT shift credit (Type 2)");
    expect(shift).toContain("last punch 02:10 next day");
    expect(text(q("claim-decision-3005"))).toBe("Approved by Suresh Raj, 6 Oct 2026");

    expect(text(rowOf("claims-table", 3006))).toContain("Birthday credit");
    expect(text(rowOf("claims-table", 3007))).toContain("Use of balance");
    expect(text(rowOf("claims-table", 3007))).toContain("Day off from the balance");
    expect(text(q("claim-decision-3003"))).toBe("Rejected by Suresh Raj, 12 Oct 2026");
  });

  it("say when the employee has no Department Head to decide", async () => {
    world.claims[0] = { ...world.claims[0], hodName: null };
    await openClaims();
    expect(text(q("claim-hod-3001"))).toBe("No Department Head assigned");
  });

  it("filter by kind, status, who raised it, department, branch and name: each one asks the server", async () => {
    await openClaims();
    choose("claim-kind", "ot_allowance");
    await waitFor(() => claimsAsked().get("kind") === "ot_allowance", "the kind");
    await waitFor(() => rowKeys("claims-table").join() === "3004", "the allowance only");
    choose("claim-kind", "");
    choose("claim-status", "approved");
    await waitFor(() => claimsAsked().get("status") === "approved", "the status");
    expect(params().hstatus).toBe("approved");
    choose("claim-status", "");
    expect(params().hstatus).toBeUndefined();
    choose("claim-raised", "employee");
    await waitFor(() => claimsAsked().get("raisedBy") === "employee", "who raised it");
    await waitFor(() => rowKeys("claims-table").join() === "3004,3006", "the employees' claims");
    choose("claim-dept", "1");
    await waitFor(() => claimsAsked().get("departmentId") === "1", "the department");
    choose("claim-branch", "2");
    await waitFor(() => claimsAsked().get("branchId") === "2", "the branch");
    typeInto(must("claim-search") as HTMLInputElement, "asha");
    await waitFor(() => claimsAsked().get("q") === "asha", "the search");
    expect(params()).toMatchObject({ hraised: "employee", hdept: "1", hbranch: "2", hq: "asha" });
    await waitFor(() => rowKeys("claims-table").join() === "3004", "Asha's claim");
  });

  it("filter by a tile: the status tiles and the kind tiles", async () => {
    await openClaims();
    click(must("claim-kpi-rejected"));
    expect(params().hstatus).toBe("rejected");
    await waitFor(() => rowKeys("claims-table").join() === "3003", "the rejected one");
    expect(must("claim-kpi-rejected").getAttribute("aria-pressed")).toBe("true");
    click(must("claim-kpi-rejected"));
    expect(params().hstatus).toBeUndefined();
    click(must("claim-kpi-kind-use_balance"));
    expect(params().hkind).toBe("use_balance");
    await waitFor(() => rowKeys("claims-table").join() === "3007", "the use of the balance");
  });

  it("filter by the month, and can list every month at once (the year then does not apply)", async () => {
    await openClaims();
    choose("claim-month-month", "9");
    expect(params().hmonth).toBe("9");
    await waitFor(() => claimsAsked().get("month") === "9", "September");
    choose("claim-month-month", "all");
    expect(params().hmonth).toBe("all");
    await waitFor(() => claimsAsked().get("anyMonth") === "1", "every month");
    expect(claimsAsked().get("month")).toBeNull();
    expect(claimsAsked().get("year")).toBeNull();
    expect((must("claim-month-year") as HTMLSelectElement).disabled).toBe(true);
    expect(button("claim-month-prev").disabled).toBe(true);
    choose("claim-month-month", "10");
    expect(params().hmonth).toBe("10");
  });

  it("say there are none for a month, and how to get one", async () => {
    world.claims = [];
    mountPage(CLAIMS_PATH);
    await waitFor(() => text(q("claims-table")).includes("No claim for October 2026"), "the empty state");
    expect(text(q("claims-table"))).toContain("raise one in the Raise a claim tab");
  });

  it("show an error with a Retry when they cannot be read", async () => {
    world.failing.set(CLAIMS_API, { status: 500 });
    mountPage(CLAIMS_PATH);
    await waitFor(() => text(q("claims-table")).includes("Could not load the claims"), "the error");
    world.failing.clear();
    click([...must("claims-table").querySelectorAll("button")].find((b) => text(b) === "Try again"));
    await waitFor(claimsReady, "the claims");
  });
});

describe("the drawer of a claim", () => {
  it("opens from a row: the claim, the OT it is based on, the approval trail and the credit, with links", async () => {
    await openClaims();
    click(rowOf("claims-table", 3005));
    expect(params().hclaim).toBe("3005");
    await waitFor(() => !!q("claim-drawer-claim"), "the drawer");
    expect(text(q("claim-drawer"))).toContain("Chitra Devi");
    expect(text(q("claim-drawer"))).toContain("OT shift credit (Type 2) · Mon, 5 Oct 2026");
    // when it was sent: the date and the exact time (06:00 UTC = 11:30 in India)
    expect(text(q("claim-drawer-claim"))).toContain("Submitted on");
    expect(text(q("claim-drawer-claim"))).toContain("12 Oct 2026, 11:30");
    const source = text(q("claim-drawer-source"));
    expect(source).toContain("Shift end17:30");
    expect(source).toContain("Last punch02:10 (next day)");
    expect(source).toContain("Past the shift end8 h 40 min");
    expect(source).toContain("Shift credit0.50 shifts");
    expect(source).toContain("OT record#3");
    expect(must("claim-drawer-source-link").getAttribute("href")).toBe(
      "/hr/compensation/ot-detection/type-2?month=10&year=2026",
    );
    expect(text(q("claim-drawer-approval"))).toContain("Approved by Suresh Raj, 6 Oct 2026");
    expect(must("claim-drawer-approval").querySelector('[data-testid="approval-trail"]')).not.toBeNull();
    expect(text(q("claim-drawer-effect"))).toBe("0.50 shifts added to the balance on 6 Oct 2026.");
    expect(must("claim-drawer-credit-link").getAttribute("href")).toBe(
      `${HOLIDAY}/credits?lmonth=all&lemp=13&lclaim=3005`,
    );
    expect(must("claim-drawer-balance-link").getAttribute("href")).toBe(`${HOLIDAY}/balance?balemp=13`);
  });

  it("follows the link to the credit the claim made, marked in Credits", async () => {
    await openClaims(`${CLAIMS_PATH}?hclaim=3005`);
    await waitFor(() => !!q("claim-drawer-credit-link"), "the drawer");
    click(must("claim-drawer-credit-link"));
    await waitFor(() => rowKeys("ledger-table").length > 0, "Credits");
    expect(window.location.pathname).toBe(`${HOLIDAY}/credits`);
    expect(Object.fromEntries(lastQuery(world.requests(), "/api/compensation/ledger")!)).toMatchObject({
      employeeId: "13",
      page: "1",
    });
    expect(lastQuery(world.requests(), "/api/compensation/ledger")!.get("month")).toBeNull();
    expect(rowKeys("ledger-table")).toEqual(["15"]);
    expect(rowOf("ledger-table", 15)!.getAttribute("aria-current")).toBe("true");
    expect(text(q("ledger-employee"))).toContain("Employee: Chitra Devi");
  });

  it("says a pending Type 1 allowance applies nothing yet, raised by the employee, and offers Withdraw", async () => {
    await openClaims(`${CLAIMS_PATH}?hclaim=3004`);
    await waitFor(() => !!q("claim-drawer-claim"), "the drawer");
    expect(text(q("claim-drawer-claim"))).toContain("Raised byEmployee (app)");
    expect(text(q("claim-drawer-source"))).toContain("Late-in allowance1 h");
    expect(text(q("claim-drawer-effect"))).toBe("Nothing is applied until the Department Head approves it.");
    expect(q("claim-drawer-credit-link")).toBeNull();
    expect(text(q("claim-drawer-approval"))).toContain("Waiting for Suresh Raj (Department Head)");
    expect(text(must("claim-drawer-approval").querySelector('[data-testid="approval-trail"]'))).toContain("Employee");
    click(must("claim-drawer-withdraw"));
    await waitFor(() => !!q("claim-withdraw-dialog"), "the confirmation");
    expect(params().hclaim).toBeUndefined();
    expect(text(q("claim-withdraw-dialog"))).toContain("Asha Kumar, OT allowance (Type 1), 7 Oct 2026, 1 h late-in");
  });

  it("links a Sunday claim back to the day on Raise", async () => {
    await openClaims(`${CLAIMS_PATH}?hclaim=3001`);
    await waitFor(() => !!q("claim-drawer-source-link"), "the drawer");
    expect(must("claim-drawer-source-link").getAttribute("href")).toBe(`${HOLIDAY}/raise?hdate=2026-10-11`);
    expect(text(q("claim-drawer-effect"))).toBe("Nothing is credited until the Department Head approves it.");
  });

  it("opens from a link on one employee, every month: the request names the employee and the chip says who", async () => {
    await openClaims(`${CLAIMS_PATH}?hmonth=all&hemp=24&hclaim=3002`);
    await waitFor(() => !!q("claim-drawer-claim"), "the drawer");
    expect(claimsAsked().get("employeeId")).toBe("24");
    expect(claimsAsked().get("anyMonth")).toBe("1");
    expect(rowKeys("claims-table")).toEqual(["3002"]);
    expect(text(q("claim-employee"))).toContain("Employee: Indu Nair");
    expect(text(q("claim-drawer-effect"))).toBe("1 shift added to the balance on 12 Oct 2026.");
    click(must("claim-employee-clear"));
    expect(params().hemp).toBeUndefined();
  });
});

describe("withdrawing a claim", () => {
  it("is offered only on a claim still waiting for the Department Head", async () => {
    await openClaims();
    expect(q("claim-withdraw-3001")).not.toBeNull();
    expect(q("claim-withdraw-3004")).not.toBeNull();
    expect(q("claim-withdraw-3002")).toBeNull();
    expect(q("claim-withdraw-3003")).toBeNull();
  });

  it("asks first, then removes the claim", async () => {
    await openClaims();
    click(must("claim-withdraw-3001"));
    await waitFor(() => !!q("claim-withdraw-dialog"), "the confirmation");
    expect(text(q("claim-withdraw-dialog"))).toContain("Hari Om, Sunday / holiday work, 11 Oct 2026, 0.50 shifts");
    expect(text(q("claim-withdraw-dialog"))).toContain("nothing is credited");
    click(must("claim-withdraw-confirm"));
    await waitFor(
      () => world.writes.some((w) => w.method === "DELETE" && w.url === `${CLAIMS_API}/3001`),
      "the request",
    );
    await waitFor(() => !rowOf("claims-table", 3001), "the row to go");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Claim withdrawn" }));
  });

  it("keeps the claim when the question is answered No", async () => {
    await openClaims();
    click(must("claim-withdraw-3001"));
    await waitFor(() => !!q("claim-withdraw-dialog"), "the confirmation");
    click([...must("claim-withdraw-dialog").querySelectorAll("button")].find((b) => text(b) === "Keep the claim"));
    await waitFor(() => !q("claim-withdraw-dialog"), "the dialog to close");
    expect(world.writes).toEqual([]);
  });

  it("says so when the server refuses (the Department Head decided meanwhile)", async () => {
    world.on.set(`DELETE ${CLAIMS_API}/3001`, () =>
      apiError(400, {
        error:
          "This claim is already approved: only a claim that is still waiting for the Department Head can be withdrawn.",
      }),
    );
    await openClaims();
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

describe("who may raise", () => {
  it("greys out Submit with the server's reason when the login lacks Edit on Claims, and says so beside it", async () => {
    world.holidayEnabled = {
      master: true,
      holidayWork: true,
      workflow: true,
      canRaise: false,
      raiseProblem: "Raising a claim needs Edit on Compensation > Leave > Holiday work > Claims.",
    };
    await openSunday();
    click(must("claim-select-E21"));
    click(must("claim-shifts-E21-1"));
    typeInto(area("claim-reason"), "Dispatch rush");
    expect(button("claim-submit").disabled).toBe(true);
    expect(button("claim-submit").title).toBe(
      "Raising a claim needs Edit on Compensation > Leave > Holiday work > Claims.",
    );
    expect(text(q("claim-raise-problem"))).toBe(
      "Raising a claim needs Edit on Compensation > Leave > Holiday work > Claims.",
    );
    // the switches are on: no switched-off notice claims otherwise
    expect(q("holiday-off")).toBeNull();
    expect(q("holiday-workflow-off")).toBeNull();
    click(must("claim-submit"));
    await settle();
    expect(bodiesOf(world, "POST", RAISE_API)).toEqual([]);
  });

  it("raises as before when the server says HR may (no reason shown)", async () => {
    world.holidayEnabled = { ...world.holidayEnabled, canRaise: true, raiseProblem: null };
    await openSunday();
    click(must("claim-select-E21"));
    expect(button("claim-submit").disabled).toBe(false);
    expect(q("claim-raise-problem")).toBeNull();
  });
});

describe("an off Saturday", () => {
  const OFF_SATURDAY = "2026-10-10";

  it("is a day of the strip of its own: named Off Saturday (never a company holiday) and counted apart", async () => {
    world.monthDays["2026-10"] = [
      ...world.monthDays["2026-10"].slice(0, 2),
      {
        date: OFF_SATURDAY,
        kind: "off_saturday",
        kindLabel: "Off Saturday",
        holidayName: null,
        weekLabel: "Week 2",
        worked: 2,
        eligible: 2,
        claimed: { pending: 0, approved: 0 },
      },
      ...world.monthDays["2026-10"].slice(2),
    ];
    world.eligible[OFF_SATURDAY] = {
      ...world.eligible[SUNDAY_DATE],
      date: OFF_SATURDAY,
      dayKind: "off_saturday",
      kindLabel: "Off Saturday",
      holidayName: null,
    };
    await openRaise();
    expect(text(q(`hw-day-${OFF_SATURDAY}`))).toContain("Off Saturday");
    expect(text(q(`hw-day-${OFF_SATURDAY}`))).not.toContain("holiday");
    expect(text(q("hw-strip-summary"))).toBe(
      "4 Sundays, 1 holiday and 1 off Saturday · 8 worked · 5 still to claim · 1 waiting for HOD",
    );
    click(must(`hw-day-${OFF_SATURDAY}`));
    await waitFor(() => text(q("claim-day")).includes("Sat, 10 Oct 2026"), "who worked the off Saturday");
    expect(text(q("claim-day"))).toContain("Sat, 10 Oct 2026 · Off Saturday ·");
    expect(text(q("claim-day"))).not.toContain("Company holiday");
  });

  it("is named Off Saturday on a claim and in its drawer", async () => {
    world.claims[0] = {
      ...world.claims[0],
      workDate: OFF_SATURDAY,
      dayKind: "off_saturday",
      holidayName: "Off Saturday",
    };
    await openClaims(`${CLAIMS_PATH}?hclaim=3001`);
    await waitFor(() => !!q("claim-drawer-source"), "the drawer");
    // the line under the date names the day
    expect(text(rowOf("claims-table", 3001))).toContain("10 Oct 2026Off Saturday");
    expect(text(q("claim-drawer-source"))).toContain("DayOff Saturday");
  });
});

describe("what is switched off", () => {
  it("says work on Sundays and holidays is off in Settings, pauses raising, and keeps everything readable", async () => {
    world.holidayEnabled = { master: true, holidayWork: false, workflow: true, canRaise: false };
    await openSunday();
    await waitFor(() => !!q("holiday-off"), "the notice");
    const notice = must("holiday-off");
    expect(text(notice)).toContain("Work on Sundays and company holidays is switched off");
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/settings?tab=compensation#holiday-work-enabled");
    click(must("claim-select-E21"));
    expect(button("claim-submit").disabled).toBe(true);
    expect(button("claim-submit").title).toMatch(/switched off in Settings → Compensation/);
    await switchTo("claims", claimsReady);
    expect(rowKeys("claims-table")).toHaveLength(7);
  });

  it("says the approval itself is off, with a link to where to switch it on", async () => {
    world.holidayEnabled = { master: true, holidayWork: true, workflow: false, canRaise: false };
    await openSunday();
    await waitFor(() => !!q("holiday-workflow-off"), "the notice");
    const notice = must("holiday-workflow-off");
    expect(text(notice)).toContain("The approval for compensation claims is switched off");
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/user-management?tab=approvals");
    expect(q("holiday-off")).toBeNull();
    click(must("claim-select-E21"));
    expect(button("claim-submit").disabled).toBe(true);
    expect(button("claim-submit").title).toMatch(/approval is switched off in User Management/);
    // a claim already waiting can still be withdrawn
    await switchTo("claims", claimsReady);
    expect(button("claim-withdraw-3001").disabled).toBe(false);
  });

  it("pauses raising and withdrawing while the master switch is off", async () => {
    world.settings.compensationFeatureEnabled = false;
    await openSunday();
    await waitFor(() => !!q("compensation-features-off"), "the master notice");
    click(must("claim-select-E21"));
    expect(button("claim-submit").disabled).toBe(true);
    expect(button("claim-submit").title).toMatch(/Settings → Payroll/);
    await switchTo("claims", claimsReady);
    expect(button("claim-withdraw-3001").disabled).toBe(true);
    expect(q("holiday-off")).toBeNull();
  });

  it("locks Submit and Withdraw for a View Only role, and leaves the strip, Last Sunday and the filters alone", async () => {
    await openSunday();
    click(must("claim-select-E21"));
    lockMutatingControls(document.body);
    await settle();
    expect(button("claim-submit").disabled).toBe(true);
    expect(button("claim-last-sunday").disabled).toBe(false);
    expect(button("hw-day-2026-10-04").disabled).toBe(false);
    expect(button("hw-strip-prev").disabled).toBe(false);
    await switchTo("claims", claimsReady);
    lockMutatingControls(document.body);
    await settle();
    expect(button("claim-withdraw-3001").disabled).toBe(true);
    expect(button("claim-view-3001").disabled).toBe(false);
    expect((must("claim-status") as HTMLSelectElement).disabled).toBe(false);
    expect(button("claim-kpi-pending").disabled).toBe(false);
  });
});
