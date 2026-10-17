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
  user: { current: null as { branchId?: number | null } | null },
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
  it("Outpass opens on its first tab, with its heading and no trace of the other two pages", async () => {
    mountPage(OUTPASS);
    expect(headings()).toEqual(["Outpass"]);
    await waitFor(() => ready("outpass-passes"), "the passes");
    expect(pathname()).toBe(`${OUTPASS}/overview/passes`);
    expect(pillLabels("outpass-subtabs").map((l) => l.replace(/\s*\(\d+\)$/, ""))).toEqual([
      "Overview",
      "Requests",
      "In/Out",
    ]);
    expect(q("tea-break-tab")).toBeNull();
    expect(q("visitors-list")).toBeNull();
  });

  it("Visitors keeps its one list: no tab strip, no nested strip, and it stays at its address", async () => {
    mountPage(VISITORS);
    expect(headings()).toEqual(["Visitors"]);
    await waitFor(() => ready("visitors-list"), "the visitors");
    expect(pathname()).toBe(VISITORS);
    expect(text(q("visitors-list"))).toContain("Visitor One");
    expect(document.body.querySelector('[data-testid$="subtabs"]')).toBeNull();
    expect(document.body.querySelector('[data-testid$="-nested"]')).toBeNull();
  });

  it("Tea Break opens on Records, with the tiles above the two tabs", async () => {
    mountPage(TEA);
    expect(headings()).toEqual(["Tea Break"]);
    await waitFor(() => ready("tea-break-list"), "the records");
    expect(pathname()).toBe(`${TEA}/records`);
    expect(pillLabels("tea-break-subtabs")).toEqual(["Records", "Rule"]);
    // the tiles (Today / This Week / This Month) come before the strip in the page
    const strip = must("tea-break-subtabs");
    const tiles = [...document.body.querySelectorAll("p")].find((p) => text(p) === "This Month")!;
    expect(tiles.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the bare /hr/outpass-visitors is Outpass", async () => {
    mountPage("/hr/outpass-visitors");
    await waitFor(() => ready("outpass-passes"), "the passes");
    expect(pathname()).toBe(`${OUTPASS}/overview/passes`);
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
    [`${VISITORS}/anything`, VISITORS],
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
    expect(text(q("outpass-qr-submissions"))).toContain("Asha QR");
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

  it("In/Out: only the exits", async () => {
    mountPage(`${OUTPASS}/in-out`);
    await waitFor(() => ready("outpass-in-out"), "the exits");
    expect(text(q("outpass-in-out"))).toContain("Employee 3");
    expect(text(q("outpass-in-out"))).toContain("(still out)");
    expect(q("outpass-passes")).toBeNull();
    expect(q("outpass-requests")).toBeNull();
    expect(q("outpass-overview")).toBeNull();
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

  it("the Today / This Week / This Month filter is still set after a nested switch and after a trip to another tab", async () => {
    mountPage(`${OUTPASS}/overview/passes`);
    await waitFor(() => ready("outpass-passes"), "the passes");
    expect(selected("Today")).toBe(true);
    expect(text(q("outpass-passes"))).toContain("4 passes");

    click(tab("This Month"));
    await waitFor(() => text(q("outpass-passes")).includes("5 passes"), "the month's passes");
    expect(selected("This Month")).toBe(true);

    // the other section of Overview shares the filter, and asks for the same range
    click(nestedTab("outpass-overview-nested", "qr-submissions"));
    await waitFor(() => ready("outpass-qr-submissions"), "the QR submissions");
    expect(selected("This Month")).toBe(true);
    await waitFor(() => text(q("outpass-qr-submissions")).includes("Person 5 QR"), "the month's submissions");
    expect(text(q("outpass-qr-submissions"))).toContain("5 submissions");

    // away to Requests (no range there) and back: still the month
    click(tab("Requests"));
    await waitFor(() => ready("outpass-requests"), "the requests");
    click(tab("Overview"));
    await waitFor(() => ready("outpass-passes"), "the passes");
    expect(selected("This Month")).toBe(true);
    expect(text(q("outpass-passes"))).toContain("5 passes");
    expect(rangeCalls("/api/outpass/records").some((s) => s.includes("range=month"))).toBe(true);
  });
});

describe("pill counts", () => {
  it("count what each tab holds: pending for HR, exits, passes in the range, QR submissions", async () => {
    mountPage(`${OUTPASS}/overview/passes`);
    await waitFor(() => ready("outpass-passes"), "the passes");
    await waitFor(() => nestedLabels("outpass-overview-nested").every((l) => /\(\d+\)/.test(l)), "the nested counts");
    // 4 passes today; the 2 QR submissions of today
    expect(nestedLabels("outpass-overview-nested").map((l) => l.replace(/\s+/g, ""))).toEqual([
      "Passes(4)",
      "GateQRsubmissions(2)",
    ]);
    // 1 request HR can decide (the other waits for a HOD); 2 gate exits
    const labels = pillLabels("outpass-subtabs").map((l) => l.replace(/\s+/g, ""));
    expect(labels).toEqual(["Overview", "Requests(1)", "In/Out(2)"]);
  });

  it("follow the filter: the passes and the QR submissions of the chosen range", async () => {
    mountPage(`${OUTPASS}/overview/passes`);
    await waitFor(() => ready("outpass-passes"), "the passes");
    click(tab("This Month"));
    await waitFor(
      () =>
        nestedLabels("outpass-overview-nested")
          .map((l) => l.replace(/\s+/g, ""))
          .join() === "Passes(5),GateQRsubmissions(5)",
      "the month's counts",
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
    expect(h.toast).toHaveBeenCalledWith({ title: "Outpass approved" });
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

  it("the range and the Overtime filter are still set after a trip to Rule", async () => {
    mountPage(`${TEA}/records`);
    await waitFor(() => ready("tea-break-list"), "the records");
    click(tab("This Week"));
    const overtime = () => [...document.body.querySelectorAll("button")].find((b) => text(b) === "Overtime")!;
    click(overtime());
    await waitFor(() => !text(q("tea-break-list")).includes("Tea Ontime"), "the filtered list");
    expect(text(q("tea-break-list"))).toContain("Tea Overtime");

    click(tab("Rule"));
    expect(pathname()).toBe(`${TEA}/rule`);
    await waitFor(() => ready("tea-break-rule"), "the rule");
    click(tab("Records"));
    await waitFor(() => ready("tea-break-list"), "the records");
    expect(selected("This Week")).toBe(true);
    await waitFor(() => text(q("tea-break-list")).includes("Tea Overtime"), "the list");
    expect(text(q("tea-break-list"))).not.toContain("Tea Ontime");
    expect(overtime().className).toContain("text-white");
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
    for (const label of ["Overview", "Requests", "In/Out"]) expect(tab(label).tagName).toBe("BUTTON");
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
