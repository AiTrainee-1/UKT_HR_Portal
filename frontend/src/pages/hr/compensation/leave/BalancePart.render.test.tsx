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
  q,
  settle,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "../harness";

// The compensation balance in jsdom (Compensation Leave B): who has shifts to take, what is behind each balance, the Redeem
// dialog that replaced the old date prompt (employee, date, shifts that cannot be more than the balance), and the earlier
// Alternative-Day credits, which stay visible.

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
  // a redemption takes the shifts off the balance, as the server does
  world.on.set("POST /api/compensation/balance/redeem", (call) => {
    const row = world.balances.find((b) => b.employeeId === call.body.employeeId)!;
    row.balance = Math.round((row.balance - Number(call.body.shifts)) * 100) / 100;
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
      balance: row.balance,
    };
  });
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
});

const REDEEM = "/api/compensation/balance/redeem";

async function openBalance() {
  mountPage("/hr/compensation?tab=leave&sub=holiday-work");
  await waitFor(() => !!q("balance-table"), "the balances");
}

const button = (id: string) => must(id) as HTMLButtonElement;
const input = (id: string) => must(id) as HTMLInputElement;
const rowIds = () =>
  [...(q("balance-table")?.querySelectorAll("tbody tr") ?? [])].map((r) => r.getAttribute("data-testid"));

describe("the balances", () => {
  it("list the staff with shifts to take, and total them", async () => {
    await openBalance();
    expect(rowIds()).toEqual(["balance-row-E21", "balance-row-E24", "balance-row-E26"]);
    expect(text(q("balance-row-E21"))).toContain("Fara Khan");
    expect(text(q("balance-row-E21"))).toContain("1.50 shifts");
    expect(text(q("balance-row-E24"))).toContain("0.25 shifts");
    expect(text(q("balance-kpi-people-value"))).toBe("2");
    expect(text(q("balance-kpi-total-value"))).toBe("1.75");
  });

  it("say how a balance comes about, and that HR redeems it", async () => {
    await openBalance();
    const card = text(q("balance-card"));
    expect(card).toContain("They are added when the Department Head approves a Sunday / holiday work claim");
    expect(card).toContain("HR redeems them on a date");
  });

  it("search by name, code or department", async () => {
    await openBalance();
    typeInto(must("balance-search") as HTMLInputElement, "indu");
    expect(rowIds()).toEqual(["balance-row-E24"]);
    typeInto(must("balance-search") as HTMLInputElement, "zzz");
    expect(text(q("balance-empty"))).toContain("Nobody matches the search");
  });

  it("show the shape of the list while it loads, and an error with a Retry", async () => {
    const release = world.hold("/api/compensation/balance");
    mountPage("/hr/compensation?tab=leave&sub=holiday-work");
    await waitFor(() => !!q("balance-card"), "the card");
    expect(q("skeleton-kpis")).not.toBeNull();
    release();
    await waitFor(() => !!q("balance-table"), "the balances");
    unmountPage();

    world.failing.set("/api/compensation/balance", { status: 500 });
    mountPage("/hr/compensation?tab=leave&sub=holiday-work");
    await waitFor(() => !!q("balance-error"), "the error");
    expect(text(q("balance-error"))).toContain("Could not load the balances");
    world.failing.clear();
    click([...must("balance-error").querySelectorAll("button")].find((b) => text(b) === "Retry"));
    await waitFor(() => !!q("balance-table"), "the balances");
  });

  it("explain that nobody has one yet", async () => {
    world.balances = [];
    mountPage("/hr/compensation?tab=leave&sub=holiday-work");
    await waitFor(() => !!q("balance-empty"), "the empty state");
    expect(text(q("balance-empty"))).toContain("Nobody has a balance yet");
  });
});

describe("what is behind a balance", () => {
  it("lists the credits and the days off taken, with where each came from", async () => {
    await openBalance();
    click(must("balance-details-E21"));
    await waitFor(() => !!q("ledger-table"), "the entries");
    const dialog = text(q("ledger-dialog"));
    expect(dialog).toContain("Balance of Fara Khan");
    expect(dialog).toContain("1.50 shifts to take");
    const rows = [...must("ledger-table").querySelectorAll("tbody tr")].map(text);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("9 Oct 2026");
    expect(rows[0]).toContain("Redeemed as a day off");
    expect(rows[0]).toContain("−0.50");
    expect(rows[1]).toContain("Sunday / holiday work (approved by the Department Head)");
    expect(rows[1]).toContain("+1");
    expect(rows[2]).toContain("Earlier Alternative-Day credit");
  });

  it("says there are no entries for a balance without any", async () => {
    await openBalance();
    click(must("balance-details-E24"));
    await waitFor(() => !!q("ledger-empty"), "the empty state");
  });

  it("is open to a View Only role", async () => {
    await openBalance();
    lockMutatingControls(document.body);
    await settle();
    expect(button("balance-details-E21").disabled).toBe(false);
  });
});

describe("the Redeem dialog", () => {
  it("replaces the old date prompt: the employee, the day and the shifts, with what will happen", async () => {
    await openBalance();
    click(must("balance-redeem-E21"));
    await waitFor(() => !!q("redeem-dialog"), "the dialog");
    expect(text(q("redeem-dialog"))).toContain("Redeem the balance of Fara Khan");
    expect(text(q("redeem-balance"))).toBe("1.50 shifts");
    expect(button("redeem-submit").disabled).toBe(true);
    typeInto(input("redeem-date"), "2026-10-15");
    click(must("redeem-shifts-0.5"));
    expect(button("redeem-submit").disabled).toBe(false);
    expect(text(q("redeem-summary"))).toBe(
      "Thu, 15 Oct 2026 is topped up by 0.50 shifts (a day never goes above 1 shift) and marked Compensation in attendance. The balance goes from 1.50 to 1.",
    );
  });

  it("sends the employee, the day and the shifts, then closes and shows the new balance", async () => {
    await openBalance();
    click(must("balance-redeem-E21"));
    await waitFor(() => !!q("redeem-dialog"), "the dialog");
    typeInto(input("redeem-date"), "2026-10-15");
    click(must("redeem-shifts-0.5"));
    click(must("redeem-submit"));
    await waitFor(() => bodiesOf(world, "POST", REDEEM).length === 1, "the request");
    expect(bodiesOf(world, "POST", REDEEM)[0]).toEqual({ employeeId: 21, date: "2026-10-15", shifts: 0.5 });
    await waitFor(() => !q("redeem-dialog"), "the dialog to close");
    await waitFor(() => text(q("balance-row-E21")).includes("1 shift"), "the new balance");
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
        balance: 1,
      };
    });
    await openBalance();
    click(must("balance-redeem-E21"));
    await waitFor(() => !!q("redeem-dialog"), "the dialog");
    typeInto(input("redeem-date"), "2026-10-15");
    click(must("redeem-shifts-0.5"));
    const submit = must("redeem-submit");
    // both clicks arrive before the page has drawn again (a double click)
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

  it("never offers more shifts than the balance", async () => {
    await openBalance();
    click(must("balance-redeem-E24")); // 0.25
    await waitFor(() => !!q("redeem-dialog"), "the dialog");
    expect(button("redeem-shifts-0.25").disabled).toBe(false);
    for (const choice of ["0.5", "0.75", "1"]) {
      expect(button(`redeem-shifts-${choice}`).disabled).toBe(true);
      expect(button(`redeem-shifts-${choice}`).title).toBe("More than the balance (0.25)");
    }
    typeInto(input("redeem-date"), "2026-10-15");
    click(must("redeem-shifts-1")); // a disabled choice does nothing
    expect(button("redeem-submit").disabled).toBe(true);
    click(must("redeem-shifts-0.25"));
    expect(button("redeem-submit").disabled).toBe(false);
  });

  it("allows the whole balance", async () => {
    await openBalance();
    click(must("balance-redeem-E21")); // 1.50: the most one day can take is 1
    await waitFor(() => !!q("redeem-dialog"), "the dialog");
    typeInto(input("redeem-date"), "2026-10-15");
    click(must("redeem-shifts-1"));
    expect(text(q("redeem-summary"))).toContain("The balance goes from 1.50 to 0.50.");
  });

  it("needs a real day", async () => {
    await openBalance();
    click(must("balance-redeem-E21"));
    await waitFor(() => !!q("redeem-dialog"), "the dialog");
    click(must("redeem-shifts-0.5"));
    expect(button("redeem-submit").disabled).toBe(true);
    typeInto(input("redeem-date"), "2026-10-15");
    expect(button("redeem-submit").disabled).toBe(false);
  });

  it("shows the server's sentence when the day cannot take the shifts, and stays open", async () => {
    world.on.set(`POST ${REDEEM}`, () =>
      apiError(400, {
        error: "11 Oct 2026 is a Sunday: it is already a day off, so there is nothing to top up.",
        balance: 1.5,
      }),
    );
    await openBalance();
    click(must("balance-redeem-E21"));
    await waitFor(() => !!q("redeem-dialog"), "the dialog");
    typeInto(input("redeem-date"), "2026-10-11");
    click(must("redeem-shifts-0.5"));
    click(must("redeem-submit"));
    await waitFor(() => !!q("redeem-error"), "the refusal");
    expect(text(q("redeem-error"))).toContain("is a Sunday");
    expect(q("redeem-dialog")).not.toBeNull();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("does nothing on Cancel", async () => {
    await openBalance();
    click(must("balance-redeem-E21"));
    await waitFor(() => !!q("redeem-dialog"), "the dialog");
    click([...must("redeem-dialog").querySelectorAll("button")].find((b) => text(b) === "Cancel"));
    await waitFor(() => !q("redeem-dialog"), "the dialog to close");
    expect(world.writes).toEqual([]);
  });

  it("is not offered for a balance of nothing", async () => {
    await openBalance();
    expect(button("balance-redeem-E26").disabled).toBe(true);
    expect(button("balance-redeem-E26").title).toBe("Nothing to redeem");
  });
});

describe("what pauses Redeem", () => {
  it("pauses it, with the reason, while the master switch is off", async () => {
    world.settings.compensationFeatureEnabled = false;
    await openBalance();
    await waitFor(() => button("balance-redeem-E21").disabled, "the pause");
    expect(button("balance-redeem-E21").title).toMatch(/switched off in Settings → Payroll/);
    // the balance and what is behind it stay readable
    expect(rowIds()).toHaveLength(3);
    expect(button("balance-details-E21").disabled).toBe(false);
  });

  it("locks Redeem for a View Only role", async () => {
    await openBalance();
    expect(button("balance-redeem-E21").title).toMatch(/create a day off/);
    lockMutatingControls(document.body);
    await settle();
    expect(button("balance-redeem-E21").disabled).toBe(true);
  });
});

describe("the earlier Alternative-Day credits", () => {
  it("stay visible, with each one's state", async () => {
    await openBalance();
    await waitFor(() => !!q("credits-table"), "the credits");
    expect(text(q("credit-row-4"))).toContain("Fara Khan");
    expect(text(q("credit-row-4"))).toContain("12 Sep 2026");
    expect(text(q("credit-row-4"))).toContain("Available: 1 shift");
    expect(text(q("credit-row-5"))).toContain("Used on 30 Sep 2026");
    expect(text(q("credits-card"))).toContain("Each available credit counts as one shift in the balance above");
  });

  it("say so when there are none", async () => {
    world.credits = [];
    await openBalance();
    await waitFor(() => !!q("credits-empty"), "the empty state");
  });
});
