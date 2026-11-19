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
import { choose, lastQuery, rowKeys } from "./leave-test-utils";

// Compensation Leave C in jsdom: birthdays by attendance. A birthday is a normal working day: absent or on leave = an
// automatic paid birthday leave, present = one credit to claim (from the app, or here by HR for the employee), which the
// Department Head approves into the balance; an off day gives nothing. The list shows what each birthday gave, with its
// filters and figures; How it works says so. The year of birth never shows.

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

const BIRTHDAYS = "/hr/compensation/compensation-leave/birthdays/list";
const HOW = "/hr/compensation/compensation-leave/birthdays/how";
const API = "/api/compensation/birthdays";
const CLAIMS_API = "/api/compensation/claims";

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
    expect(text(q("birthday-outcome-E31"))).toBe("Credit to claim");
    expect(q("birthday-row-E31")!.getAttribute("data-outcome")).toBe("credit_claimable");
    expect(text(q("birthday-claim-button-E31"))).toBe("Claim for employee");
  });

  it("counts the birthdays by what they gave", async () => {
    await openBirthdays();
    expect(text(q("birthday-kpi-count-value"))).toBe("1");
    expect(text(q("birthday-kpi-leave-value"))).toBe("0");
    expect(text(q("birthday-kpi-claimable-value"))).toBe("1");
    expect(text(q("birthday-kpi-claimed-value"))).toBe("0");
    expect(text(q("birthday-kpi-upcoming-value"))).toBe("0");
  });
});

describe("how it works", () => {
  it("says a birthday is a normal working day: absent = paid leave, present = a credit to claim the HOD approves", async () => {
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
    expect(how).toContain("Present (or half a day): one 1-shift credit to claim");
    expect(how).toContain("the Department Head approves it, and then it is in the compensation balance");
    expect(how).toContain("A Sunday, a declared holiday or an off Saturday gives no birthday benefit");
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
  it("shows the week: paid leave for the absent, a claim waiting, a credit to claim and an off day", async () => {
    await openBirthdays();
    click(tab("Week"));
    expect(params()).toMatchObject({ bperiod: "week" });
    await waitFor(() => rowCodes().length === 4, "the week");
    expect(birthdayRequests().at(-1)).toBe(`${API}?period=week&date=2026-10-14`);
    expect(text(q("birthday-kpi-count"))).toContain("12 Oct - 18 Oct 2026");
    expect(text(q("birthday-kpi-leave-value"))).toBe("1");
    expect(text(q("birthday-kpi-claimable-value"))).toBe("1");
    expect(text(q("birthday-kpi-claimed-value"))).toBe("1");
    expect(text(q("birthday-kpi-claimed"))).toContain("1 waiting for HOD");

    expect(text(q("birthday-outcome-E32"))).toBe("Paid birthday leave");
    expect(text(q("birthday-outcome-E34"))).toBe("Claimed: waiting for HOD");
    expect(must("birthday-claim-E34").getAttribute("href")).toBe(
      "/hr/compensation/compensation-leave/holiday-work/claims?hmonth=all&hemp=34&hclaim=3006",
    );
    expect(q("birthday-claim-button-E34")).toBeNull();
    expect(q("birthday-claim-button-E32")).toBeNull();
    expect(text(q("birthday-outcome-E33"))).toBe("Off day: no benefit");
    expect(text(q("birthday-reason-E33"))).toBe("18 Oct 2026 is a Sunday: it is already a day off.");
  });

  it("shows the month, with the birthdays still to come", async () => {
    await openBirthdays(`${BIRTHDAYS}?bperiod=month`);
    expect(birthdayRequests().at(-1)).toBe(`${API}?period=month&date=2026-10-14`);
    expect(text(q("birthday-outcome-E35"))).toBe("Upcoming");
    expect(text(q("birthday-kpi-upcoming-value"))).toBe("1");
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
    await waitFor(() => rowCodes().length === 4, "every birthday of the week");
  });

  it("filter by a tile, and the tiles keep counting every outcome", async () => {
    await openBirthdays(`${BIRTHDAYS}?bperiod=week`);
    click(must("birthday-kpi-leave"));
    expect(params().boutcome).toBe("paid_leave");
    await waitFor(() => rowCodes().join() === "birthday-row-E32", "the paid leave");
    expect(text(q("birthday-kpi-claimable-value"))).toBe("1");
    expect(must("birthday-kpi-leave").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("claiming a birthday credit for an employee", () => {
  it("sends the claim to the Department Head, with a reason", async () => {
    await openBirthdays();
    click(must("birthday-claim-button-E31"));
    await waitFor(() => !!q("birthday-claim-dialog"), "the dialog");
    const dialog = text(q("birthday-claim-dialog"));
    expect(dialog).toContain("Claim the birthday credit of Mala Iyer");
    expect(dialog).toContain("worked on their birthday, Wed, 14 Oct 2026: one 1-shift credit");
    expect(dialog).toContain("The claim goes to their Department Head");
    expect((must("birthday-claim-reason") as HTMLTextAreaElement).value).toBe("Worked on the birthday");
    click(must("birthday-claim-submit"));
    await waitFor(() => bodiesOf(world, "POST", CLAIMS_API).length === 1, "the request");
    expect(bodiesOf(world, "POST", CLAIMS_API)[0]).toEqual({
      kind: "birthday",
      date: "2026-10-14",
      reason: "Worked on the birthday",
      items: [{ employeeId: 31 }],
    });
    await waitFor(() => !q("birthday-claim-dialog"), "the dialog to close");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Birthday credit claimed" }));
  });

  it("needs a reason", async () => {
    await openBirthdays();
    click(must("birthday-claim-button-E31"));
    await waitFor(() => !!q("birthday-claim-dialog"), "the dialog");
    typeInto(must("birthday-claim-reason") as unknown as HTMLInputElement, "  ");
    expect(button("birthday-claim-submit").disabled).toBe(true);
    expect(text(q("birthday-claim-dialog"))).toContain("Give a reason");
  });

  it("shows the server's sentence when it refuses, and stays open", async () => {
    world.on.set(`POST ${CLAIMS_API}`, () =>
      apiError(409, { error: "Mala Iyer has no Department Head assigned.", code: "no_hod" }),
    );
    await openBirthdays();
    click(must("birthday-claim-button-E31"));
    await waitFor(() => !!q("birthday-claim-dialog"), "the dialog");
    click(must("birthday-claim-submit"));
    await waitFor(() => !!q("birthday-claim-error"), "the refusal");
    expect(text(q("birthday-claim-error"))).toContain("no Department Head assigned");
    expect(q("birthday-claim-dialog")).not.toBeNull();
  });

  it("is locked for a View Only role", async () => {
    await openBirthdays();
    lockMutatingControls(document.body);
    await settle();
    expect(button("birthday-claim-button-E31").disabled).toBe(true);
    expect((must("birthday-outcome") as HTMLSelectElement).disabled).toBe(false);
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
});

describe("what is switched off", () => {
  it("says birthday leave is off in Settings and keeps the list readable", async () => {
    world.birthdayEnabled = false;
    await openBirthdays();
    const notice = must("birthday-off");
    expect(text(notice)).toContain("Birthday leave is switched off");
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
