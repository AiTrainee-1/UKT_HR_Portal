import type { ReactNode } from "react";
import { act } from "react";
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

// The balance and the credits of the claim workflow in jsdom (Compensation Leave B): every employee's EARNED / USED /
// WAITING / AVAILABLE with its filters, the drawer with every entry behind a balance (and the claim that made it), Use
// balance (a request on the employee's behalf that goes to the Department Head), HR's direct Redeem (kept), and Credits:
// every credit and debit of the balances with its filters and links, with the earlier Alternative-Day credits below.

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
  // a redemption takes the shifts off the balance at once, as the server does
  world.on.set("POST /api/compensation/balance/redeem", (call) => {
    const row = world.balances.find((b) => b.employeeId === call.body.employeeId)!;
    row.used = Math.round((row.used + Number(call.body.shifts)) * 100) / 100;
    row.available = Math.round((row.available - Number(call.body.shifts)) * 100) / 100;
    return {
      entry: {
        id: 77,
        type: "debit",
        shifts: call.body.shifts,
        date: call.body.date,
        source: "redemption",
        note: null,
        createdBy: "Meena",
        createdAt: null,
        counted: true,
      },
      balance: row.available,
    };
  });
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
});

const HOLIDAY = "/hr/compensation/compensation-leave/holiday-work";
const BALANCE_PATH = `${HOLIDAY}/balance`;
const CREDITS_PATH = `${HOLIDAY}/credits`;
const BALANCE_API = "/api/compensation/balance";
const LEDGER_API = "/api/compensation/ledger";
const REDEEM = "/api/compensation/balance/redeem";
const USE = "/api/compensation/use";

const balanceReady = () => rowKeys("balance-table").length > 0;
const ledgerReady = () => rowKeys("ledger-table").length > 0;

async function openBalance(url = BALANCE_PATH) {
  mountPage(url);
  await waitFor(balanceReady, "the balances");
}

async function openCredits(url = CREDITS_PATH) {
  mountPage(url);
  await waitFor(ledgerReady, "the credits");
}

const button = (id: string) => must(id) as HTMLButtonElement;
const input = (id: string) => must(id) as HTMLInputElement;
const balanceAsked = () =>
  lastQuery(
    world.requests().filter((r) => !r.includes("employeeId=")),
    BALANCE_API,
  )!;
const ledgerAsked = () => lastQuery(world.requests(), LEDGER_API)!;

describe("the balances", () => {
  it("are their own nested subtab: the claim form, the claims and the credits are not on it", async () => {
    await openBalance();
    for (const other of ["claim-form", "claim-list", "credits-part"]) expect(q(other), other).toBeNull();
  });

  it("list every employee's earned, used, waiting and available shifts, a page of 25", async () => {
    await openBalance();
    expect(Object.fromEntries(balanceAsked())).toEqual({ page: "1", pageSize: "25" });
    expect(rowKeys("balance-table")).toEqual(["21", "24", "26"]);
    const fara = text(rowOf("balance-table", 21));
    expect(fara).toContain("Fara Khan");
    expect(fara).toContain("Cutting");
    expect(text(q("balance-available-E21"))).toBe("1 shift");
    expect(text(q("balance-available-E24"))).toBe("0.25 shifts");
    // the columns, in order: earned 2, used 0.50, waiting 0.50, available 1
    const cells = [...rowOf("balance-table", 21)!.querySelectorAll("td")].map(text);
    expect(cells.slice(1, 5)).toEqual(["2", "0.50", "0.50", "1 shift"]);
    expect(cells[5]).toBe("12 Oct 2026");
  });

  it("total them in the tiles", async () => {
    await openBalance();
    expect(text(q("balance-kpi-people-value"))).toBe("2");
    expect(text(q("balance-kpi-earned-value"))).toBe("4");
    expect(text(q("balance-kpi-used-value"))).toBe("2.25");
    expect(text(q("balance-kpi-pending-value"))).toBe("0.50");
    expect(text(q("balance-kpi-total-value"))).toBe("1.25");
  });

  it("say how a balance comes about", async () => {
    await openBalance();
    const card = text(q("balance-card"));
    expect(card).toContain("Shifts earned from approved claims and earlier credits");
    expect(card).toContain("what is waiting for the Department Head");
  });

  it("filter by department, branch and name or code, each one asking the server", async () => {
    await openBalance();
    choose("balance-dept", "1");
    await waitFor(() => balanceAsked().get("departmentId") === "1", "the department");
    await waitFor(() => rowKeys("balance-table").join() === "24,26", "Sales");
    choose("balance-branch", "2");
    await waitFor(() => balanceAsked().get("branchId") === "2", "the branch");
    typeInto(must("balance-search") as HTMLInputElement, "indu");
    await waitFor(() => balanceAsked().get("q") === "indu", "the search");
    await waitFor(() => rowKeys("balance-table").join() === "24", "Indu");
    expect(params()).toMatchObject({ baldept: "1", balbranch: "2", balq: "indu" });
    typeInto(must("balance-search") as HTMLInputElement, "zzz");
    await waitFor(() => text(q("balance-table")).includes("Nobody matches the filters"), "nobody");
  });

  it("show the shape of the list while it loads, and an error with a Retry", async () => {
    const release = world.hold(BALANCE_API);
    mountPage(BALANCE_PATH);
    await waitFor(() => !!q("balance-card"), "the card");
    expect(must("balance-table").getAttribute("aria-busy")).toBe("true");
    release();
    await waitFor(balanceReady, "the balances");
    unmountPage();

    world.failing.set(BALANCE_API, { status: 500 });
    mountPage(BALANCE_PATH);
    await waitFor(() => text(q("balance-table")).includes("Could not load the balances"), "the error");
    world.failing.clear();
    click([...must("balance-table").querySelectorAll("button")].find((b) => text(b) === "Try again"));
    await waitFor(balanceReady, "the balances");
  });

  it("explain that nobody has one yet", async () => {
    world.balances = [];
    mountPage(BALANCE_PATH);
    await waitFor(() => text(q("balance-table")).includes("Nobody has a balance yet"), "the empty state");
  });
});

describe("the drawer of a balance", () => {
  it("opens from a row: the four figures, the request still waiting and every entry with its claim", async () => {
    await openBalance();
    click(rowOf("balance-table", 21));
    expect(params().balemp).toBe("21");
    await waitFor(() => !!q("ledger-table") && !!q("ledger-waiting"), "the entries");
    const drawer = text(q("ledger-dialog"));
    expect(drawer).toContain("Balance of Fara Khan");
    expect(drawer).toContain("E21 · 1 shift available");
    expect(text(q("ledger-earned-value"))).toBe("2");
    expect(text(q("ledger-used-value"))).toBe("0.50");
    expect(text(q("ledger-pending-value"))).toBe("0.50");
    expect(text(q("ledger-available-value"))).toBe("1");
    // the use of the balance waiting for the HOD, with its link
    expect(text(q("ledger-waiting"))).toContain("0.50 shifts on 16 Oct 2026 · HOD: Suresh Raj");
    expect(must("ledger-waiting-3007").getAttribute("href")).toBe(`${HOLIDAY}/claims?hmonth=all&hemp=21&hclaim=3007`);
    const pending = lastQuery(world.requests(), "/api/compensation/claims")!;
    expect(Object.fromEntries(pending)).toMatchObject({
      employeeId: "21",
      kind: "use_balance",
      status: "pending",
      anyMonth: "1",
    });
    const rows = [...must("ledger-table").querySelectorAll("tbody tr")].map(text);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("9 Oct 2026");
    expect(rows[0]).toContain("Redeemed as a day off (by HR)");
    expect(rows[0]).toContain("−0.50");
    expect(rows[1]).toContain("Sunday / holiday work (approved by the Department Head)");
    expect(rows[1]).toContain("+1");
    expect(must("ledger-claim-2990").getAttribute("href")).toBe(`${HOLIDAY}/claims?hmonth=all&hemp=21&hclaim=2990`);
    expect(rows[2]).toContain("Earlier Alternative-Day credit");
    expect(must("ledger-credits-link").getAttribute("href")).toBe(`${HOLIDAY}/credits?lmonth=all&lemp=21`);
  });

  it("opens from a link on the employee, and says when there is no entry", async () => {
    await openBalance(`${BALANCE_PATH}?balemp=24`);
    await waitFor(() => !!q("ledger-empty"), "the empty entries");
    expect(text(q("ledger-dialog"))).toContain("Balance of Indu Nair");
  });

  it("follows the link of an entry to its claim", async () => {
    await openBalance(`${BALANCE_PATH}?balemp=21`);
    await waitFor(() => !!q("ledger-claim-2990"), "the entries");
    click(must("ledger-claim-2990"));
    await waitFor(() => window.location.pathname === `${HOLIDAY}/claims`, "Claims");
    expect(params()).toEqual({ hmonth: "all", hemp: "21", hclaim: "2990" });
  });

  it("is open to a View Only role", async () => {
    await openBalance();
    lockMutatingControls(document.body);
    await settle();
    click(rowOf("balance-table", 21));
    await waitFor(() => !!q("ledger-table"), "the entries");
  });
});

describe("Use balance: a request for the Department Head, on the employee's behalf", () => {
  it("asks for the day, the shifts and a reason, and says what happens", async () => {
    await openBalance();
    click(must("balance-use-E21"));
    await waitFor(() => !!q("use-dialog"), "the dialog");
    expect(text(q("use-dialog"))).toContain("Use the balance of Fara Khan");
    expect(text(q("use-available"))).toBe("1 shift");
    expect(text(q("use-dialog"))).toContain("This asks the employee's Department Head");
    click(must("use-submit"));
    await settle();
    expect(text(q("use-dialog"))).toContain("Choose the day off.");
    expect(text(q("use-dialog"))).toContain("Choose how many shifts.");
    expect(text(q("use-dialog"))).toContain("Give a reason");
    expect(bodiesOf(world, "POST", USE)).toEqual([]);
    typeInto(input("use-date"), "2026-10-20");
    click(must("use-shifts-0.5"));
    typeInto(must("use-reason") as unknown as HTMLInputElement, "Family function");
    expect(text(q("use-summary"))).toContain(
      "Tue, 20 Oct 2026 is topped up by 0.50 shifts once the Department Head approves",
    );
    expect(text(q("use-summary"))).toContain("the available balance goes from 1 to 0.50");
  });

  it("sends the employee, the day, the shifts and the reason, then the balance shows it waiting", async () => {
    await openBalance();
    click(must("balance-use-E21"));
    await waitFor(() => !!q("use-dialog"), "the dialog");
    typeInto(input("use-date"), "2026-10-20");
    click(must("use-shifts-0.5"));
    typeInto(must("use-reason") as unknown as HTMLInputElement, "Family function");
    click(must("use-submit"));
    await waitFor(() => bodiesOf(world, "POST", USE).length === 1, "the request");
    expect(bodiesOf(world, "POST", USE)[0]).toEqual({
      employeeId: 21,
      date: "2026-10-20",
      shifts: 0.5,
      reason: "Family function",
    });
    await waitFor(() => !q("use-dialog"), "the dialog to close");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Sent to the Department Head" }));
    // every Compensation list is read again: the balance now shows 1 shift waiting and 0.50 available
    await waitFor(() => text(q("balance-available-E21")) === "0.50 shifts", "the new balance");
    expect([...rowOf("balance-table", 21)!.querySelectorAll("td")].map(text)[3]).toBe("1");
  });

  it("never offers more than is available, and not at all when nothing is", async () => {
    await openBalance();
    expect(button("balance-use-E26").disabled).toBe(true);
    expect(button("balance-use-E26").title).toBe("Nothing available to use");
    click(must("balance-use-E24"));
    await waitFor(() => !!q("use-dialog"), "the dialog");
    expect(button("use-shifts-0.25").disabled).toBe(false);
    for (const choice of ["0.5", "0.75", "1"]) expect(button(`use-shifts-${choice}`).disabled).toBe(true);
  });

  it("shows the server's sentence when the day cannot be used, and stays open", async () => {
    world.on.set(`POST ${USE}`, () =>
      apiError(400, {
        error: "20 Oct 2026 is outside the request window: only this month can be asked for.",
        code: "not_eligible",
      }),
    );
    await openBalance();
    click(must("balance-use-E21"));
    await waitFor(() => !!q("use-dialog"), "the dialog");
    typeInto(input("use-date"), "2026-10-20");
    click(must("use-shifts-0.5"));
    typeInto(must("use-reason") as unknown as HTMLInputElement, "Family function");
    click(must("use-submit"));
    await waitFor(() => !!q("use-error"), "the refusal");
    expect(text(q("use-error"))).toContain("outside the request window");
    expect(q("use-dialog")).not.toBeNull();
  });
});

describe("Redeem: HR's direct day off, kept", () => {
  it("redeems from what is available and closes", async () => {
    await openBalance();
    click(must("balance-redeem-E21"));
    await waitFor(() => !!q("redeem-dialog"), "the dialog");
    expect(text(q("redeem-dialog"))).toContain("Redeem the balance of Fara Khan");
    expect(text(q("redeem-balance"))).toBe("1 shift");
    typeInto(input("redeem-date"), "2026-10-15");
    click(must("redeem-shifts-0.5"));
    expect(text(q("redeem-summary"))).toContain("The balance goes from 1 to 0.50.");
    click(must("redeem-submit"));
    await waitFor(() => bodiesOf(world, "POST", REDEEM).length === 1, "the request");
    expect(bodiesOf(world, "POST", REDEEM)[0]).toEqual({ employeeId: 21, date: "2026-10-15", shifts: 0.5 });
    await waitFor(() => !q("redeem-dialog"), "the dialog to close");
    await waitFor(() => text(q("balance-available-E21")) === "0.50 shifts", "the new balance");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Day off recorded" }));
  });

  it("takes the shifts once when the button is clicked twice in a row", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.on.set(`POST ${REDEEM}`, async () => {
      await gate;
      return {
        entry: {
          id: 77,
          type: "debit",
          shifts: 0.5,
          date: "2026-10-15",
          source: "redemption",
          note: null,
          createdBy: "Meena",
          createdAt: null,
          counted: true,
        },
        balance: 0.5,
      };
    });
    await openBalance();
    click(must("balance-redeem-E21"));
    await waitFor(() => !!q("redeem-dialog"), "the dialog");
    typeInto(input("redeem-date"), "2026-10-15");
    click(must("redeem-shifts-0.5"));
    const submit = must("redeem-submit");
    act(() => {
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(20);
    expect(bodiesOf(world, "POST", REDEEM)).toHaveLength(1);
    release();
    await waitFor(() => !q("redeem-dialog"), "the dialog to close");
    expect(bodiesOf(world, "POST", REDEEM)).toHaveLength(1);
  });

  it("is not offered for nothing, and the drawer offers it too", async () => {
    await openBalance(`${BALANCE_PATH}?balemp=21`);
    expect(button("balance-redeem-E26").disabled).toBe(true);
    expect(button("balance-redeem-E26").title).toBe("Nothing to redeem");
    await waitFor(() => !!q("ledger-table"), "the drawer");
    click(must("ledger-redeem"));
    await waitFor(() => !!q("redeem-dialog"), "the dialog");
    expect(text(q("redeem-balance"))).toBe("1 shift");
  });
});

describe("what pauses Use balance and Redeem", () => {
  it("pauses both, with the reason, while the master switch is off, and keeps everything readable", async () => {
    world.settings.compensationFeatureEnabled = false;
    await openBalance();
    await waitFor(() => button("balance-redeem-E21").disabled, "the pause");
    expect(button("balance-redeem-E21").title).toMatch(/switched off in Settings → Payroll/);
    expect(button("balance-use-E21").disabled).toBe(true);
    expect(rowKeys("balance-table")).toHaveLength(3);
  });

  it("locks Use balance and Redeem for a View Only role", async () => {
    await openBalance();
    expect(button("balance-redeem-E21").title).toMatch(/create a day off/);
    expect(button("balance-use-E21").title).toMatch(/send a request/);
    lockMutatingControls(document.body);
    await settle();
    expect(button("balance-redeem-E21").disabled).toBe(true);
    expect(button("balance-use-E21").disabled).toBe(true);
  });
});

describe("Credits: every credit and debit", () => {
  it("lists the month's entries, newest first, with the claim behind each", async () => {
    await openCredits();
    expect(Object.fromEntries(ledgerAsked())).toEqual({ month: "10", year: "2026", page: "1", pageSize: "25" });
    expect(rowKeys("ledger-table")).toEqual(["20", "15", "12", "9"]);
    const indu = text(rowOf("ledger-table", 20));
    expect(indu).toContain("12 Oct 2026");
    expect(indu).toContain("Indu Nair");
    expect(indu).toContain("+1");
    expect(indu).toContain("Sunday / holiday work (approved by the Department Head)");
    expect(must("ledger-row-claim-3002").getAttribute("href")).toBe(`${HOLIDAY}/claims?hmonth=all&hemp=24&hclaim=3002`);
    expect(text(rowOf("ledger-table", 15))).toContain("OT shift credit, Type 2 (approved by the Department Head)");
    const redeem = text(rowOf("ledger-table", 12));
    expect(redeem).toContain("−0.50");
    expect(redeem).toContain("Redeemed as a day off (by HR)");
    expect(redeem).toContain("HR redeem");
  });

  it("totals the credits and the debits", async () => {
    await openCredits();
    expect(text(q("ledger-kpi-credits-value"))).toBe("3");
    expect(text(q("ledger-kpi-credits"))).toContain("+2.50 shifts");
    expect(text(q("ledger-kpi-debits-value"))).toBe("1");
    expect(text(q("ledger-kpi-debits"))).toContain("−0.50 shifts");
    expect(text(q("ledger-kpi-net-value"))).toBe("2");
  });

  it("filters by credit or debit, source, every month, department, branch and name: each one asks the server", async () => {
    await openCredits();
    choose("ledger-type", "debit");
    await waitFor(() => ledgerAsked().get("entryType") === "debit", "debits");
    await waitFor(() => rowKeys("ledger-table").join() === "12", "the debit");
    choose("ledger-type", "");
    choose("ledger-source", "birthday");
    await waitFor(() => ledgerAsked().get("source") === "birthday", "the source");
    choose("ledger-month-month", "all");
    await waitFor(
      () => ledgerAsked().get("month") === null && ledgerAsked().get("source") === "birthday",
      "every month",
    );
    await waitFor(() => rowKeys("ledger-table").join() === "7", "September's birthday credit");
    choose("ledger-dept", "1");
    await waitFor(() => ledgerAsked().get("departmentId") === "1", "the department");
    choose("ledger-branch", "2");
    await waitFor(() => ledgerAsked().get("branchId") === "2", "the branch");
    typeInto(must("ledger-search") as HTMLInputElement, "kiran");
    await waitFor(() => ledgerAsked().get("q") === "kiran", "the search");
    expect(params()).toMatchObject({ lsource: "birthday", lmonth: "all", ldept: "1", lbranch: "2", lq: "kiran" });
  });

  it("filters by a tile", async () => {
    await openCredits();
    click(must("ledger-kpi-credits"));
    expect(params().ltype).toBe("credit");
    await waitFor(() => rowKeys("ledger-table").join() === "20,15,9", "the credits");
  });

  it("follows the link of an entry to its claim, opened in its drawer", async () => {
    await openCredits();
    click(must("ledger-row-claim-3002"));
    await waitFor(() => !!q("claim-drawer-claim"), "the claim's drawer");
    expect(window.location.pathname).toBe(`${HOLIDAY}/claims`);
    expect(text(q("claim-drawer"))).toContain("Indu Nair");
  });

  it("opens the employee's balance from the name", async () => {
    await openCredits();
    const link = rowOf("ledger-table", 20)!.querySelector("a[href*='balemp']")!;
    expect(link.getAttribute("href")).toBe(`${HOLIDAY}/balance?balemp=24`);
  });

  it("shows the earlier Alternative-Day credits as a section of their own", async () => {
    await openCredits();
    await waitFor(() => !!q("credits-table"), "the earlier credits");
    expect(text(q("credits-card"))).toContain("Earlier Alternative-Day credits (2)");
    expect(text(q("credit-row-4"))).toContain("Fara Khan");
    expect(text(q("credit-row-4"))).toContain("12 Sep 2026");
    expect(text(q("credit-row-4"))).toContain("Available: 1 shift");
    expect(text(q("credit-row-5"))).toContain("Used on 30 Sep 2026");
    expect(text(q("credits-card"))).toContain("Each available credit counts as one shift in the Compensation balance");
  });

  it("says when there are no entries, and no earlier credits", async () => {
    world.ledger = [];
    world.credits = [];
    mountPage(CREDITS_PATH);
    await waitFor(() => text(q("ledger-table")).includes("No entry for October 2026"), "the empty ledger");
    await waitFor(() => !!q("credits-empty"), "the empty earlier credits");
  });
});
