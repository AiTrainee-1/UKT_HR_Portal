import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  click,
  freezeClock,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  params,
  q,
  tab,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "../harness";

// Compensation Leave C in jsdom: who has a birthday Today, this Week or this Month, who gets the automatic paid leave and
// why not when somebody does not, what their attendance says, and the notice for the switch. The year of birth never shows.

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

const BIRTHDAYS = "/hr/compensation?tab=leave&sub=birthdays";

async function openBirthdays(url = BIRTHDAYS) {
  mountPage(url);
  await waitFor(() => !!q("birthday-kpis"), "the birthdays");
}

const rowIds = () =>
  [...(q("birthday-table")?.querySelectorAll("tbody tr") ?? [])].map((r) => r.getAttribute("data-testid"));
const birthdayRequests = () => world.requests().filter((r) => r.startsWith("/api/compensation/birthdays"));

describe("today", () => {
  it("lists who has a birthday today, with the benefit, the attendance and the punches", async () => {
    await openBirthdays();
    expect(birthdayRequests()).toEqual(["/api/compensation/birthdays?period=today&date=2026-10-14"]);
    expect(rowIds()).toEqual(["birthday-row-E31"]);
    const row = text(q("birthday-row-E31"));
    expect(row).toContain("Mala Iyer");
    expect(row).toContain("14 Oct 2026");
    expect(row).toContain("Wednesday");
    expect(row).toContain("Yes: paid leave");
    expect(row).toContain("Present");
    expect(row).toContain("1 shift");
    expect(row).toContain("Birthday marked");
    expect(row).toContain("10:40 - 16:00");
  });

  it("counts the birthdays, who gets the leave and what attendance already marked", async () => {
    await openBirthdays();
    expect(text(q("birthday-kpi-count-value"))).toBe("1");
    expect(text(q("birthday-kpi-benefit-value"))).toBe("1");
    expect(text(q("birthday-kpi-applied-value"))).toBe("1");
  });

  it("says it is automatic, what it does, and never shows a birth year", async () => {
    await openBirthdays();
    const how = text(q("birthday-how"));
    expect(how).toContain("Automatic: HR does nothing.");
    expect(how).toContain("whether they attend, stay absent, work half a day, arrive late or leave early");
    expect(how).toContain("no Late, Early Out or half-day detection applies");
    expect(how).toContain("The year of birth is never shown here.");
    expect(how).toContain("It applies from 1 Oct 2026");
    expect(text(q("birthdays-part"))).not.toMatch(/\b(19|20)\d\d-\d\d-\d\d\b/);
    // the only years on the page are the one of the dates shown
    expect([...text(q("birthday-table")).matchAll(/\b(19\d\d|20\d\d)\b/g)].every((m) => m[1] === "2026")).toBe(true);
  });
});

describe("the period", () => {
  it("shows the week, with who does not benefit and why, and who was not marked yet", async () => {
    await openBirthdays();
    click(tab("Week"));
    expect(params()).toMatchObject({ tab: "leave", sub: "birthdays", bperiod: "week" });
    await waitFor(() => rowIds().length === 3, "the week");
    expect(birthdayRequests().at(-1)).toBe("/api/compensation/birthdays?period=week&date=2026-10-14");
    expect(text(q("birthday-kpi-count"))).toContain("12 Oct - 18 Oct 2026");
    expect(text(q("birthday-kpi-benefit-value"))).toBe("2");
    expect(text(q("birthday-kpi-benefit"))).toContain("1 do not (see the reason)");

    const naveen = text(q("birthday-row-E32"));
    expect(naveen).toContain("Absent");
    expect(naveen).toContain("No punches");
    expect(naveen).toContain("Birthday marked"); // paid leave even though he was absent

    const omar = text(q("birthday-row-E33"));
    expect(omar).toContain("No");
    expect(text(q("birthday-reason-E33"))).toBe("18 Oct 2026 is a Sunday: it is already a day off.");
    expect(omar).toContain("Not computed yet");
    expect(q("birthday-row-E33")!.getAttribute("data-benefits")).toBe("false");
  });

  it("shows the month", async () => {
    await openBirthdays();
    click(tab("Month"));
    await waitFor(
      () => birthdayRequests().at(-1) === "/api/compensation/birthdays?period=month&date=2026-10-14",
      "the month",
    );
    expect(params().bperiod).toBe("month");
    await waitFor(() => !!q("birthday-table"), "the list");
  });

  it("steps to the next and the previous period, and back to today", async () => {
    await openBirthdays(`${BIRTHDAYS}&bperiod=week`);
    click(must("birthday-period-next"));
    expect(params().bdate).toBe("2026-10-21");
    await waitFor(
      () => birthdayRequests().at(-1) === "/api/compensation/birthdays?period=week&date=2026-10-21",
      "next week",
    );
    click(must("birthday-period-prev"));
    click(must("birthday-period-prev"));
    expect(params().bdate).toBe("2026-10-07");
    click(must("birthday-period-today"));
    expect(params().bdate).toBeUndefined(); // today is the default, so the address stays clean
    expect((must("birthday-period-today") as HTMLButtonElement).disabled).toBe(true);
  });

  it("follows a date typed in, and restores period and date from the address", async () => {
    await openBirthdays(`${BIRTHDAYS}&bperiod=week&bdate=2026-10-07`);
    expect(birthdayRequests()).toEqual(["/api/compensation/birthdays?period=week&date=2026-10-07"]);
    expect((must("birthday-period-date") as HTMLInputElement).value).toBe("2026-10-07");
    typeInto(must("birthday-period-date") as HTMLInputElement, "2026-11-02");
    expect(params().bdate).toBe("2026-11-02");
  });

  it("says there is no birthday, and where to look", async () => {
    world.on.set("GET /api/compensation/birthdays", (_call, qs) => ({
      period: qs.get("period"),
      date: qs.get("date"),
      from: "2026-10-14",
      to: "2026-10-14",
      enabled: { master: true, birthday: true, effectiveFrom: null },
      count: 0,
      benefitCount: 0,
      results: [],
    }));
    await openBirthdays();
    expect(text(q("birthday-empty"))).toContain("No birthday today");
    expect(q("birthday-table")).toBeNull();
    // without an effective-from date the note does not mention one
    expect(text(q("birthday-how"))).not.toContain("It applies from");
  });
});

describe("loading and errors", () => {
  it("shows the shape of the tiles and the list while the birthdays are on their way", async () => {
    const release = world.hold("/api/compensation/birthdays");
    mountPage(BIRTHDAYS);
    await waitFor(() => !!q("birthday-list"), "the card");
    expect(q("skeleton-kpis")).not.toBeNull();
    expect(q("skeleton-rows")).not.toBeNull();
    release();
    await waitFor(() => !!q("birthday-table"), "the list");
  });

  it("shows an error with a Retry", async () => {
    world.failing.set("/api/compensation/birthdays", { status: 500 });
    mountPage(BIRTHDAYS);
    await waitFor(() => !!q("birthday-error"), "the error");
    expect(text(q("birthday-error"))).toContain("Could not load the birthdays");
    world.failing.clear();
    click([...must("birthday-error").querySelectorAll("button")].find((b) => text(b) === "Retry"));
    await waitFor(() => !!q("birthday-table"), "the list");
  });
});

describe("what is switched off", () => {
  it("says birthday leave is off in Settings and keeps the list readable", async () => {
    world.birthdayEnabled = false;
    await openBirthdays();
    const notice = must("birthday-off");
    expect(text(notice)).toContain("Birthday leave is switched off");
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/settings?tab=compensation#birthday-enabled");
    expect(rowIds()).toEqual(["birthday-row-E31"]);
  });

  it("adds no notice of its own while the master switch is off (the page has one)", async () => {
    world.settings.compensationFeatureEnabled = false;
    world.on.set("GET /api/compensation/birthdays", (_call, qs) => ({
      period: qs.get("period"),
      date: qs.get("date"),
      from: "2026-10-14",
      to: "2026-10-14",
      enabled: { master: false, birthday: false, effectiveFrom: null },
      count: 0,
      benefitCount: 0,
      results: [],
    }));
    await openBirthdays();
    expect(q("birthday-off")).toBeNull();
    await waitFor(() => !!q("compensation-features-off"), "the master notice");
  });

  it("has nothing for HR to change: the leave is automatic", async () => {
    await openBirthdays();
    const buttons = [...must("birthdays-part").querySelectorAll("button")].map((b) => text(b));
    expect(buttons.filter((b) => /assign|add|save|delete|submit|redeem/i.test(b))).toEqual([]);
  });
});
