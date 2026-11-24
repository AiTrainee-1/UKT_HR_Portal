import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  click,
  freezeClock,
  here,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  nestedLabels,
  nestedTab,
  pillLabels,
  press,
  q,
  ready,
  settle,
  tab,
  text,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// Outpass, Visitors and Tea Break in jsdom, with a fake server behind customFetch: the three first-level addresses, the tabs
// and nested tabs that each have an address, the redirects of a path that stops early, which section each tab renders (and
// that the others are not there), the filters that survive a switch, the counts on the pills, the Approve flow and the
// keyboard.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
// the shared Refresh button subscribes to every query: its re-renders are not what these tests are about
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));
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

const pathname = () => window.location.pathname;
const headings = () => [...document.body.querySelectorAll("h2")].map(text);
const selected = (name: string) => tab(name).getAttribute("aria-selected") === "true";
const rangeCalls = (path: string) =>
  world.gets.filter((u) => u.startsWith(path)).map((u) => new URL(u, "http://x").search);

const OUTPASS = "/hr/outpass-visitors/outpass";
const TEA = "/hr/outpass-visitors/tea-break";
const VISITORS = "/hr/outpass-visitors/visitors";

describe("the three first-level addresses", () => {
  it("Gate Pass opens on its first tab, with its heading and no trace of the other two pages", async () => {
    mountPage(OUTPASS);
    expect(headings()).toEqual(["Gate Pass"]);
    await waitFor(() => ready("outpass-passes"), "the passes");
    expect(pathname()).toBe(`${OUTPASS}/overview/passes`);
    expect(pillLabels("outpass-subtabs").map((l) => l.replace(/\s*\(\d+\)$/, ""))).toEqual([
      "Overview",
      "Requests",
      "In/Out",
      "Manage Gates",
    ]);
    expect(q("tea-break-tab")).toBeNull();
    expect(q("visitors-list")).toBeNull();
  });

  it("Visitors opens on its Visitors tab: the Visitors / Manage Reception strip, then the list", async () => {
    mountPage(VISITORS);
    expect(headings()).toEqual(["Visitors"]);
    await waitFor(() => ready("visitors-list"), "the visitors");
    expect(pathname()).toBe(`${VISITORS}/visits`);
    expect(text(q("visitors-list"))).toContain("Visitor One");
    expect(pillLabels("visitors-subtabs")).toEqual(["Visitors", "Manage Reception"]);
    // Visits | People is a switch in the address (?view=), not a tab strip with addresses of its own
    expect(q("visitors-view")).not.toBeNull();
    expect(document.body.querySelector('[data-testid$="-nested"]')).toBeNull();
    expect(q("visitors-desks")).toBeNull();
  });

  it("Tea Break opens on Records: the two tabs, then the tiles, the filters and the list", async () => {
    mountPage(TEA);
    expect(headings()).toEqual(["Tea Break"]);
    await waitFor(() => ready("tea-break-list"), "the records");
    expect(pathname()).toBe(`${TEA}/records`);
    expect(pillLabels("tea-break-subtabs")).toEqual(["Records", "Rule"]);
    // the strip, then the period's tiles, the one filter row and the list, in that order
    const parts = ["tea-break-subtabs", "tea-break-tiles", "tea-break-filters", "tea-break-list"].map(must);
    for (let i = 1; i < parts.length; i += 1) {
      expect(parts[i - 1].compareDocumentPosition(parts[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // the subtitle states the rule
    await waitFor(() => text(q("tea-break-allowed")) === "Allowed: 10 min.", "the allowed minutes");
  });

  it("the bare /hr/outpass-visitors is Outpass", async () => {
    mountPage("/hr/outpass-visitors");
    await waitFor(() => ready("outpass-passes"), "the passes");
    expect(pathname()).toBe(`${OUTPASS}/overview/passes`);
  });
});

describe("a role that may see only some of it (Account Management -> Roles & Permissions)", () => {
  const role = (permissions: Record<string, string>) => ({
    role: "hr",
    employeeId: null,
    isSuperAdmin: false,
    permissions,
  });
  const button = (name: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b).includes(name)) ?? null;

  it("offers only the tabs and sections it may see, and lands on the first of them", async () => {
    h.user.current = role({
      outpass_visitors: "edit",
      "outpass_visitors.outpass.overview.passes": "hidden",
      "outpass_visitors.outpass.in_out": "hidden",
    });
    mountPage(OUTPASS);
    await waitFor(() => pathname() === `${OUTPASS}/overview/qr-submissions`, "the first section it may see");
    await waitFor(() => ready("outpass-qr-submissions"), "the QR submissions");
    expect(pillLabels("outpass-subtabs").map((l) => l.replace(/\s*\(\d+\)$/, ""))).toEqual([
      "Overview",
      "Requests",
      "Manage Gates",
    ]);
    expect(nestedLabels("outpass-overview-nested").map((l) => l.replace(/\s*\(?\d+\)?$/, ""))).toEqual([
      "Gate QR submissions",
    ]);
  });

  it("the bare address lands on the first page it may see", async () => {
    h.user.current = role({ outpass_visitors: "edit", "outpass_visitors.outpass": "hidden" });
    mountPage("/hr/outpass-visitors");
    await waitFor(() => pathname() === `${VISITORS}/visits`, "Visitors");
    expect(headings()).toEqual(["Visitors"]);
  });

  it("says so when every tab of a page is hidden, and asks for none of them", async () => {
    h.user.current = role({
      outpass_visitors: "edit",
      "outpass_visitors.tea_break.records": "hidden",
      "outpass_visitors.tea_break.rule": "hidden",
    });
    mountPage(TEA);
    await waitFor(() => q("nothing-open") !== null, "the note");
    expect(pathname()).toBe(TEA);
    expect(text(q("nothing-open"))).toBe("Nothing on this page is open to your role.");
    expect(world.gets.some((u) => u.startsWith("/api/tea-break"))).toBe(false);
  });

  it("has no Manage Gates without 'Gate scanner devices'; with it, Overview links to the Manage Gates tab", async () => {
    // the Overview's Manage Gates button (it opens the tab), not the Manage Gates tab of the strip
    const overviewButton = () =>
      [...(q("outpass-overview")?.querySelectorAll("button") ?? [])].find((b) => text(b).includes("Manage Gates")) ??
      null;
    h.user.current = role({ outpass_visitors: "edit", "outpass_visitors.outpass.gate_devices": "hidden" });
    mountPage(OUTPASS);
    await waitFor(() => ready("outpass-passes"), "the passes");
    expect(button("Manage Gates")).toBeNull();
    // the Manage Gates tab follows "Gate scanner devices" while the role sets nothing on it
    expect(pillLabels("outpass-subtabs").map((l) => l.replace(/\s*\(\d+\)$/, ""))).not.toContain("Manage Gates");
    expect(world.gets.some((u) => u.startsWith("/api/gate-devices"))).toBe(false);
    unmountPage();
    h.user.current = role({ outpass_visitors: "edit", "outpass_visitors.outpass.gate_devices": "view" });
    mountPage(OUTPASS);
    await waitFor(() => ready("outpass-passes"), "the passes");
    expect(pillLabels("outpass-subtabs").map((l) => l.replace(/\s*\(\d+\)$/, ""))).toContain("Manage Gates");
    // a link, not an edit: a View-only role may follow it (the page there locks what it may not change)
    expect(overviewButton()!.disabled).toBe(false);
    click(overviewButton());
    expect(pathname()).toBe(`${OUTPASS}/gates`);
  });

  it("sends a role without 'Gate scanner devices' away from the Manage Gates address", async () => {
    h.user.current = role({ outpass_visitors: "edit", "outpass_visitors.outpass.gate_devices": "hidden" });
    mountPage(`${OUTPASS}/gates`);
    await waitFor(() => pathname() === `${OUTPASS}/overview/passes`, "the first tab it may see");
    expect(q("outpass-gates")).toBeNull();
  });
});

describe("the redirects", () => {
  const cases: [string, string][] = [
    [OUTPASS, `${OUTPASS}/overview/passes`],
    [`${OUTPASS}/overview`, `${OUTPASS}/overview/passes`],
    [`${OUTPASS}/overview/nope`, `${OUTPASS}/overview/passes`],
    [`${OUTPASS}/nope`, `${OUTPASS}/overview/passes`],
    [`${OUTPASS}/requests/whatever`, `${OUTPASS}/requests`],
    [TEA, `${TEA}/records`],
    [`${TEA}/nope`, `${TEA}/records`],
    [`${TEA}/rule/deeper`, `${TEA}/rule`],
    [VISITORS, `${VISITORS}/visits`],
    [`${VISITORS}/anything`, `${VISITORS}/visits`],
    [`${VISITORS}/desks/7`, `${VISITORS}/desks`],
  ];
  it.each(cases)("%s lands on %s", async (from, to) => {
    mountPage(from);
    await waitFor(() => pathname() === to, `the redirect to ${to}`);
    expect(pathname()).toBe(to);
  });

  it("replaces the entry, so Back does not bounce, and keeps the query string", async () => {
    const before = window.history.length;
    mountPage(`${OUTPASS}?from=link`);
    await waitFor(() => pathname() === `${OUTPASS}/overview/passes`, "the redirect");
    expect(here()).toBe(`${OUTPASS}/overview/passes?from=link`);
    expect(window.history.length).toBe(before);
  });
});

describe("Outpass: each tab renders only its section", () => {
  it("Overview > Passes: the tiles, the range filter, the nested strip and only the passes", async () => {
    mountPage(`${OUTPASS}/overview/passes`);
    await waitFor(() => ready("outpass-passes"), "the passes");
    expect(q("outpass-overview")).not.toBeNull();
    expect(text(q("outpass-passes"))).toContain("Employee 1");
    expect(q("outpass-qr-submissions")).toBeNull();
    expect(q("outpass-requests")).toBeNull();
    expect(q("outpass-in-out")).toBeNull();
    expect(selected("Overview")).toBe(true);
    expect(nestedTab("outpass-overview-nested", "passes").getAttribute("aria-selected")).toBe("true");
  });

  it("Overview > Gate QR submissions: only the QR submissions", async () => {
    mountPage(`${OUTPASS}/overview/qr-submissions`);
    await waitFor(() => ready("outpass-qr-submissions"), "the QR submissions");
    // This Month (the date filter's default): the month's submissions
    expect(text(q("outpass-qr-submissions"))).toContain("Person 1 QR");
    expect(q("outpass-passes")).toBeNull();
    expect(q("outpass-requests")).toBeNull();
    expect(q("outpass-in-out")).toBeNull();
  });

  it("Requests: only the pending list, and no Overview tiles or nested strip", async () => {
    mountPage(`${OUTPASS}/requests`);
    await waitFor(() => ready("outpass-requests"), "the requests");
    expect(text(q("outpass-requests"))).toContain("Employee 1");
    expect(q("outpass-passes")).toBeNull();
    expect(q("outpass-qr-submissions")).toBeNull();
    expect(q("outpass-in-out")).toBeNull();
    expect(q("outpass-overview")).toBeNull();
    expect(q("outpass-overview-nested")).toBeNull();
    // one section: no strip of one pill
    expect(document.body.querySelector('[data-testid$="-nested"]')).toBeNull();
  });

  it("In/Out: only the exits, from its own endpoints", async () => {
    mountPage(`${OUTPASS}/in-out`);
    await waitFor(() => ready("outpass-in-out"), "the exits");
    await waitFor(() => text(q("outpass-in-out")).includes("Arun P"), "today's exits");
    expect(text(q("outpass-in-out"))).toContain("Meena S");
    expect(text(q("outpass-in-out"))).toContain("Overdue");
    expect(q("outpass-passes")).toBeNull();
    expect(q("outpass-requests")).toBeNull();
    expect(q("outpass-overview")).toBeNull();
    // the Requests module's whole list is not read here any more
    expect(world.gets).not.toContain("/api/outpass-requests");
  });

  it("Manage Gates: its own address and panel, and no Overview", async () => {
    mountPage(`${OUTPASS}/gates`);
    await waitFor(() => q("outpass-gates") !== null, "the Manage Gates panel");
    expect(pathname()).toBe(`${OUTPASS}/gates`);
    expect(headings()).toEqual(["Gate Pass"]);
    expect(selected("Manage Gates")).toBe(true);
    expect(q("outpass-overview")).toBeNull();
    expect(q("outpass-passes")).toBeNull();
    expect(q("outpass-in-out")).toBeNull();
  });

  it("a section that is not on screen asks the server for nothing", async () => {
    mountPage(`${OUTPASS}/in-out`);
    await waitFor(() => ready("outpass-in-out"), "the exits");
    await settle(20);
    const asked = world.gets.map((u) => u.split("?")[0]);
    // the gate QR's lists belong to Overview; the other tab's queries are not made
    for (const path of ["/api/outpass/records", "/api/outpass/summary", "/api/outpass/qr"]) {
      expect(asked, path).not.toContain(path);
    }
  });
});

describe("Outpass: switching", () => {
  it("clicking a tab opens its address (a new history entry) and Overview opens straight on Passes", async () => {
    mountPage(`${OUTPASS}/requests`);
    await waitFor(() => ready("outpass-requests"), "the requests");
    click(tab("Overview"));
    expect(pathname()).toBe(`${OUTPASS}/overview/passes`);
    await waitFor(() => ready("outpass-passes"), "the passes");
    click(tab("In/Out"));
    expect(pathname()).toBe(`${OUTPASS}/in-out`);
    await waitFor(() => ready("outpass-in-out"), "the exits");
    expect(q("outpass-passes")).toBeNull();
  });

  it("the query string goes along with a switch", async () => {
    mountPage(`${OUTPASS}/overview/passes?x=1`);
    await waitFor(() => ready("outpass-passes"), "the passes");
    click(nestedTab("outpass-overview-nested", "qr-submissions"));
    expect(here()).toBe(`${OUTPASS}/overview/qr-submissions?x=1`);
    click(tab("Requests"));
    expect(here()).toBe(`${OUTPASS}/requests?x=1`);
  });

  it("the date filter (This Month by default) is still set after a nested switch and after a trip to another tab", async () => {
    mountPage(`${OUTPASS}/overview/passes`);
    await waitFor(() => ready("outpass-passes"), "the passes");
    const pressed = (id: string) => must(id).getAttribute("aria-pressed") === "true";
    expect(pressed("overview-dates-month")).toBe(true);
    expect(text(q("outpass-passes"))).toContain("5 passes");
    expect(text(q("outpass-passes"))).toContain("October 2026");

    click(must("overview-dates-today"));
    await waitFor(() => text(q("outpass-passes")).includes("4 passes"), "today's passes");
    expect(pressed("overview-dates-today")).toBe(true);
    expect(here()).toContain("range=today");

    // the other section of Overview shares the filter, and asks for the same days
    click(nestedTab("outpass-overview-nested", "qr-submissions"));
    await waitFor(() => ready("outpass-qr-submissions"), "the QR submissions");
    expect(pressed("overview-dates-today")).toBe(true);
    await waitFor(() => text(q("outpass-qr-submissions")).includes("Babu QR"), "today's submissions");
    expect(text(q("outpass-qr-submissions"))).toContain("2 submissions");

    // away to Requests (no dates there) and back: still today
    click(tab("Requests"));
    await waitFor(() => ready("outpass-requests"), "the requests");
    expect(here()).not.toContain("range=");
    click(tab("Overview"));
    await waitFor(() => ready("outpass-passes"), "the passes");
    expect(pressed("overview-dates-today")).toBe(true);
    expect(text(q("outpass-passes"))).toContain("4 passes");
    expect(rangeCalls("/api/outpass/records").some((s) => s.includes("from=2026-10-14&to=2026-10-14"))).toBe(true);
  });

  it("an earlier month: the passes of that month only (none in September here)", async () => {
    mountPage(`${OUTPASS}/overview/passes`);
    await waitFor(() => ready("outpass-passes") && text(q("outpass-passes")).includes("5 passes"), "the passes");
    click(must("overview-dates-prev"));
    await waitFor(() => text(q("outpass-passes")).includes("No gate passes for September 2026"), "September");
    expect(here()).toContain("month=2026-09");
    expect(rangeCalls("/api/outpass-requests").some((s) => s.includes("from=2026-09-01&to=2026-09-30"))).toBe(true);
    expect(must("overview-tile-passes").textContent).toContain("0");
  });
});

describe("pill counts", () => {
  it("count what each tab holds: pending for HR, exits, passes in the range, QR submissions", async () => {
    mountPage(`${OUTPASS}/overview/passes`);
    await waitFor(() => ready("outpass-passes"), "the passes");
    await waitFor(() => nestedLabels("outpass-overview-nested").every((l) => /\(\d+\)/.test(l)), "the nested counts");
    // This Month (the default): all 5 passes; the month's 5 QR submissions
    expect(nestedLabels("outpass-overview-nested").map((l) => l.replace(/\s+/g, ""))).toEqual([
      "Passes(5)",
      "GateQRsubmissions(5)",
    ]);
    // 1 request HR can decide (the other waits for a HOD); 2 people still out today (In/Out's own summary)
    const labels = pillLabels("outpass-subtabs").map((l) => l.replace(/\s+/g, ""));
    expect(labels).toEqual(["Overview", "Requests(1)", "In/Out(2)", "ManageGates"]);
  });

  it("follow the filter: the passes and the QR submissions of the chosen range", async () => {
    mountPage(`${OUTPASS}/overview/passes`);
    await waitFor(() => ready("outpass-passes"), "the passes");
    click(must("overview-dates-today"));
    await waitFor(
      () =>
        nestedLabels("outpass-overview-nested")
          .map((l) => l.replace(/\s+/g, ""))
          .join() === "Passes(4),GateQRsubmissions(2)",
      "today's counts",
    );
  });

  it("drop the Requests count when HR has decided the request", async () => {
    mountPage(`${OUTPASS}/requests`);
    await waitFor(() => ready("outpass-requests"), "the requests");
    await waitFor(() => /Requests\s*\(1\)/.test(text(tab("Requests"))), "the Requests count");
    const approve = [...document.body.querySelectorAll("button")].find((b) => text(b) === "Approve")!;
    click(approve);
    await waitFor(() => !/\(\d+\)/.test(text(tab("Requests"))), "the count to go");
    expect(world.calls).toEqual([
      { method: "PUT", url: "/api/outpass-requests/1/hr-status", body: { status: "approved" } },
    ]);
    expect(h.toast).toHaveBeenCalledWith({ title: "Gate pass approved" });
    expect(text(q("outpass-requests"))).not.toContain("Employee 1");
    expect(text(q("outpass-requests"))).toContain("Waiting for HOD");
  });
});

describe("Tea Break", () => {
  it("Records: the list with its filters, and not the rule", async () => {
    mountPage(`${TEA}/records`);
    await waitFor(() => ready("tea-break-list"), "the records");
    expect(text(q("tea-break-list"))).toContain("Tea Ontime");
    expect(q("tea-break-rule")).toBeNull();
    expect(selected("Records")).toBe(true);
  });

  it("Rule: the allowed minutes, and not the list; saving still writes the rule", async () => {
    mountPage(`${TEA}/rule`);
    await waitFor(() => ready("tea-break-rule"), "the rule");
    expect(q("tea-break-list")).toBeNull();
    expect(q("tea-break-records")).toBeNull();
    const input = document.body.querySelector<HTMLInputElement>("#tea-break-allowed-minutes")!;
    await waitFor(() => input.value === "10", "the rule to load");
    const save = [...document.body.querySelectorAll("button")].find((b) => text(b) === "Save")!;
    click(save);
    await waitFor(() => world.calls.length === 1, "the save");
    expect(world.calls[0]).toEqual({ method: "PUT", url: "/api/tea-break/rule", body: { allowedMinutes: 10 } });
  });

  it("the dates and the status are still set after a trip to Rule (they live in the address)", async () => {
    mountPage(`${TEA}/records`);
    await waitFor(() => ready("tea-break-list"), "the records");
    click(must("tea-dates-today"));
    await waitFor(() => !!q("tea-tile-overtime"), "the tiles");
    click(must("tea-tile-overtime"));
    await waitFor(() => !text(q("tea-break-list")).includes("Tea Ontime"), "the filtered list");
    expect(text(q("tea-break-list"))).toContain("Tea Overtime");
    expect(here()).toBe(`${TEA}/records?range=today&status=overtime`);

    click(tab("Rule"));
    expect(here()).toBe(`${TEA}/rule?range=today&status=overtime`);
    await waitFor(() => ready("tea-break-rule"), "the rule");
    click(tab("Records"));
    await waitFor(() => ready("tea-break-list"), "the records");
    expect(must("tea-dates-today").getAttribute("aria-pressed")).toBe("true");
    expect(must("tea-tile-overtime").getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => text(q("tea-break-list")).includes("Tea Overtime"), "the list");
    expect(text(q("tea-break-list"))).not.toContain("Tea Ontime");
    // the list itself (not its summary or options) was asked for with both
    const list = world.gets.filter((u) => u.split("?")[0] === "/api/tea-break/records").at(-1);
    expect(list).toContain("status=overtime");
    expect(list).toContain("from=2026-10-14&to=2026-10-14");
  });

  it("the records of a tab that is not on screen are not asked for", async () => {
    mountPage(`${TEA}/rule`);
    await waitFor(() => ready("tea-break-rule"), "the rule");
    await settle(20);
    expect(world.gets.map((u) => u.split("?")[0])).not.toContain("/api/tea-break/records");
  });
});

describe("the keyboard", () => {
  it("Left / Right / Home / End move between the nested tabs and open the one they land on", async () => {
    mountPage(`${OUTPASS}/overview/passes`);
    await waitFor(() => ready("outpass-passes"), "the passes");
    const passes = nestedTab("outpass-overview-nested", "passes");
    const qr = nestedTab("outpass-overview-nested", "qr-submissions");
    // a roving tabindex: only the open tab is in the Tab order
    expect(passes.tabIndex).toBe(0);
    expect(qr.tabIndex).toBe(-1);

    press(passes, "ArrowRight");
    expect(pathname()).toBe(`${OUTPASS}/overview/qr-submissions`);
    await waitFor(() => ready("outpass-qr-submissions"), "the QR submissions");
    expect(document.activeElement).toBe(qr);

    press(nestedTab("outpass-overview-nested", "qr-submissions"), "ArrowRight");
    expect(pathname()).toBe(`${OUTPASS}/overview/passes`);
    press(nestedTab("outpass-overview-nested", "passes"), "End");
    expect(pathname()).toBe(`${OUTPASS}/overview/qr-submissions`);
    press(nestedTab("outpass-overview-nested", "qr-submissions"), "Home");
    expect(pathname()).toBe(`${OUTPASS}/overview/passes`);
  });

  it("the tab strip is made of real buttons, so Tab reaches them and Enter or Space opens one", async () => {
    mountPage(`${OUTPASS}/requests`);
    await waitFor(() => ready("outpass-requests"), "the requests");
    for (const label of ["Overview", "Requests", "In/Out", "Manage Gates"]) expect(tab(label).tagName).toBe("BUTTON");
  });
});

describe("a role bound to one branch", () => {
  it("has no branch picker on Overview (its branch is its own)", async () => {
    h.user.current = { branchId: 7 };
    mountPage(`${OUTPASS}/overview/passes`);
    await waitFor(() => ready("outpass-passes"), "the passes");
    expect(text(q("outpass-overview"))).not.toContain("Select branch");
    expect(world.gets.some((u) => u.startsWith("/api/branches"))).toBe(false);
  });
});
