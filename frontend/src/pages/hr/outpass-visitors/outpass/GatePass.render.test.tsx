import { act, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setViewOnlyWorkflows } from "@/lib/approval-workflow";
import {
  click,
  freezeClock,
  harnessError,
  here,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
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
} from "../harness";

// Gate Pass in jsdom against the fake server: In/Out (tiles, every filter going to the server and into the address, the
// tiles as status chips, the Employee filter, the drawer with the approval and the refused scan, Export with the same
// filters, a role without the Requests module), Overview (tiles, the Passes search and status filter) and Requests (the
// approval pipeline and the MD portal's view-only lock).

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  download: vi.fn(),
  user: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
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
vi.mock("@/pages/hr/outpass-visitors/kit/download", async (original) => ({
  ...(await original<typeof import("@/pages/hr/outpass-visitors/kit/download")>()),
  downloadGateFile: h.download,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  h.user.current = null;
  h.download.mockResolvedValue("gate_pass_in_out_20261014_1130.xlsx");
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  setViewOnlyWorkflows(null);
  unmountPage();
  vi.useRealTimers();
});

const OUTPASS = "/hr/outpass-visitors/outpass";
const IN_OUT = `${OUTPASS}/in-out`;
const TODAY = "from=2026-10-14&to=2026-10-14";
const WEEK = "from=2026-10-12&to=2026-10-14";

const role = (permissions: Record<string, string>) => ({
  role: "hr",
  employeeId: null,
  isSuperAdmin: false,
  permissions,
});
const names = () =>
  [...document.body.querySelectorAll('[data-testid="inout-table"] tbody tr')].map(
    (tr) => text(tr.querySelector("td p")) || text(tr.querySelector("td")),
  );
const lastGet = (path: string) => [...world.gets].reverse().find((u) => u.split("?")[0] === path) ?? "";
const params = () => new URLSearchParams(window.location.search);
const tileValue = (id: string) => text(q(`${id}-value`));

/** Picks an option of a native select the way the browser does. */
const choose = (testId: string, value: string) =>
  act(() => {
    const el = must(testId) as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
/** Types into a React-controlled input the way the browser does. */
const typeInto = (el: HTMLElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

async function openInOut(url = IN_OUT) {
  mountPage(url);
  await waitFor(() => ready("inout-table") && !!q("inout-table")?.querySelector("tbody tr"), "the In/Out rows");
}

describe("In/Out: the figures and the rows come from its own endpoints", () => {
  it("shows today's tiles, the summary line and the rows, newest exit first", async () => {
    await openInOut();
    await waitFor(() => tileValue("inout-tile-went-out") === "3", "the tiles");
    expect(
      ["went-out", "back", "out", "overdue", "not-returned", "average"].map((t) => tileValue(`inout-tile-${t}`)),
    ).toEqual(["3", "1", "2", "1", "0", "40 min"]);
    expect(text(q("inout-tile-average"))).toContain("longest 40 min");
    expect(text(q("inout-summary-line"))).toBe("3 passes · 14 Oct 2026 · 1 back · 2 still out · 1 overdue");
    expect(names()).toEqual(["Arun P", "Meena S", "Ravi Kumar"]);
    expect(lastGet("/api/outpass/in-out")).toBe(`/api/outpass/in-out?${TODAY}&page=1&pageSize=25`);
    expect(lastGet("/api/outpass/in-out/summary")).toBe(`/api/outpass/in-out/summary?${TODAY}`);
    // the out and back times with their gates, the time out against the expected return, the status
    const ravi = text(q("inout-table")?.querySelectorAll("tbody tr")[2]);
    expect(ravi).toContain("09:00· Gate 1");
    expect(ravi).toContain("09:40· Gate 2");
    expect(ravi).toContain("40 min, 10 min over");
    expect(ravi).toContain("Back");
    // the In/Out pill counts the people still out today
    expect(pillLabels("outpass-subtabs").map((l) => l.replace(/\s+/g, ""))).toContain("In/Out(2)");
  });

  it("never reads the Requests module's whole list, and works for a role without the Requests module", async () => {
    h.user.current = role({ outpass_visitors: "view", requests: "hidden" });
    // the Requests module refused like the server refuses it
    const refuse = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.startsWith("/api/outpass-requests")) {
        world.gets.push(url);
        throw harnessError(403, { error: "permission_denied" });
      }
      return refuse(url, init);
    });
    await openInOut();
    expect(names()).toEqual(["Arun P", "Meena S", "Ravi Kumar"]);
    expect(world.gets).not.toContain("/api/outpass-requests");
    expect(pillLabels("outpass-subtabs").map((l) => l.replace(/\s+/g, ""))).toEqual([
      "Overview",
      "Requests",
      "In/Out(2)",
      "ManageGates",
    ]);
  });
});

describe("In/Out: every filter asks the server, lives in the address and changes the rows", () => {
  it("dates, gate, department, status, search and Clear", async () => {
    await openInOut();
    click(must("inout-dates-week"));
    await waitFor(() => names().length === 5, "the week's rows");
    expect(params().get("range")).toBe("week");
    expect(lastGet("/api/outpass/in-out")).toContain(WEEK);
    expect(tileValue("inout-tile-not-returned")).toBe("1");

    choose("inout-gate", "2"); // the exit OR the return gate
    await waitFor(() => names().join() === "Arun P,Ravi Kumar,Kumar V", "gate 2");
    expect(params().get("gateId")).toBe("2");
    expect(lastGet("/api/outpass/in-out")).toContain("gateId=2");

    choose("inout-department", "10");
    await waitFor(() => names().join() === "Arun P,Ravi Kumar", "Cutting at gate 2");
    choose("inout-status", "back");
    await waitFor(() => names().join() === "Ravi Kumar", "back");
    expect(lastGet("/api/outpass/in-out")).toContain("status=back");
    // the tiles keep counting every status (they are the status chips)
    expect(lastGet("/api/outpass/in-out/summary")).not.toContain("status=");
    expect(text(must("inout-clear"))).toBe("Clear filters (4)");

    click(must("inout-clear"));
    await waitFor(() => names().length === 3, "today again");
    expect(window.location.search).toBe("");
    expect(q("inout-clear")).toBeNull();

    typeInto(must("inout-search"), "clinic");
    await waitFor(() => names().join() === "Meena S", "the search");
    expect(params().get("q")).toBe("clinic");
    expect(lastGet("/api/outpass/in-out")).toContain("q=clinic");
  });

  it("a typed day makes the range custom and goes to the server", async () => {
    await openInOut();
    const from = must("inout-dates-from") as HTMLInputElement;
    typeInto(from, "2026-10-13");
    await waitFor(() => names().length === 4, "13 to 14 Oct");
    expect(params().get("range")).toBe("custom");
    expect(lastGet("/api/outpass/in-out")).toContain("from=2026-10-13&to=2026-10-14");
  });

  it("the filters come back from the address", async () => {
    await openInOut(`${IN_OUT}?range=week&status=not_returned`);
    expect(names()).toEqual(["Divya R"]);
    expect((must("inout-status") as HTMLSelectElement).value).toBe("not_returned");
    expect(must("inout-tile-not-returned").getAttribute("aria-pressed")).toBe("true");
    expect(text(must("inout-clear"))).toBe("Clear filters (2)");
  });

  it("a tile is a status chip: it filters, and a second click shows every status again", async () => {
    await openInOut();
    click(must("inout-tile-overdue"));
    await waitFor(() => names().join() === "Meena S", "the overdue");
    expect(params().get("status")).toBe("overdue");
    expect(must("inout-tile-overdue").getAttribute("aria-pressed")).toBe("true");
    click(must("inout-tile-out")); // still out: overdue included
    await waitFor(() => names().join() === "Arun P,Meena S", "still out");
    click(must("inout-tile-out"));
    await waitFor(() => names().length === 3, "all again");
    expect(params().get("status")).toBeNull();
  });

  it("the Employee filter finds a person, filters by them and clears", async () => {
    await openInOut();
    typeInto(must("inout-employee-input"), "ravi");
    await waitFor(() => !!q("inout-employee-option"), "the matches");
    expect(text(must("inout-employee-list"))).toContain("Ravi Kumar");
    expect(world.gets.some((u) => u.startsWith("/api/employees?search=ravi"))).toBe(true);
    click(must("inout-employee-option"));
    await waitFor(() => names().join() === "Ravi Kumar", "Ravi's passes");
    expect(params().get("employeeId")).toBe("31");
    expect(text(must("inout-employee"))).toContain("Ravi Kumar");
    click(must("inout-employee-clear"));
    await waitFor(() => names().length === 3, "everyone again");
    expect(params().get("employeeId")).toBeNull();
  });

  it("has no Employee filter for a role without the Employees module (the search box stays)", async () => {
    h.user.current = role({ outpass_visitors: "view", employees: "hidden" });
    await openInOut();
    expect(q("inout-employee")).toBeNull();
    expect(q("inout-search")).not.toBeNull();
    // View only: the filters and Export stay usable
    expect((must("inout-export") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("In/Out: a row opens the pass", () => {
  it("with its approval and every scan, the refused one too; Esc closes it", async () => {
    await openInOut();
    const row = q("inout-table")!.querySelectorAll<HTMLElement>("tbody tr")[2];
    expect(row.getAttribute("aria-label")).toBe("Open the gate pass of Ravi Kumar");
    row.focus();
    press(row, "Enter");
    await waitFor(() => document.body.querySelectorAll('[data-testid="inout-scan"]').length === 3, "the scans");
    const drawer = must("inout-drawer");
    expect(text(drawer)).toContain("E31 · Cutting · Back");
    expect(text(drawer)).toContain("Cash deposit");
    expect(text(drawer)).toContain("HR – Priya");
    expect(drawer.querySelector('[data-testid="approval-trail"]')).not.toBeNull();
    const denied = drawer.querySelector('[data-testid="inout-scan"][data-result="denied"]');
    expect(text(denied)).toContain("Denied: Already scanned");
    expect(text(denied)).toContain("Exit at Gate 1");
    expect(lastGet("/api/outpass/in-out/31")).toBe("/api/outpass/in-out/31");
    press(document.activeElement!, "Escape");
    await waitFor(() => q("inout-drawer") === null, "the drawer to close");
  });
});

describe("In/Out: Export", () => {
  it("downloads Excel and PDF of the same filters, every page", async () => {
    await openInOut(`${IN_OUT}?range=week&status=out&page=1`);
    press(must("inout-export"), "Enter");
    await waitFor(() => !!q("inout-export-xlsx"), "the export menu");
    click(must("inout-export-xlsx"));
    await waitFor(() => h.download.mock.calls.length === 1, "the Excel file");
    const [{ path, query, format }] = h.download.mock.calls[0] as [
      { path: string; query: URLSearchParams; format: string },
    ];
    expect(path).toBe("/api/outpass/in-out/export");
    expect(format).toBe("xlsx");
    expect(query.toString()).toBe(`status=out&${WEEK}`);
    await waitFor(() => h.toast.mock.calls.length > 0, "the toast");
    expect(h.toast).toHaveBeenCalledWith({
      title: "File downloaded",
      description: "gate_pass_in_out_20261014_1130.xlsx",
    });

    await waitFor(() => !q("inout-export-xlsx"), "the menu to close");
    press(must("inout-export"), "Enter");
    await waitFor(() => !!q("inout-export-pdf"), "the export menu");
    click(must("inout-export-pdf"));
    await waitFor(() => h.download.mock.calls.length === 2, "the PDF");
    expect((h.download.mock.calls[1][0] as { format: string }).format).toBe("pdf");
  });

  it("says why when the file is too big", async () => {
    h.download.mockRejectedValueOnce(new Error("Too many rows for one file. Narrow the dates."));
    await openInOut();
    press(must("inout-export"), "Enter");
    await waitFor(() => !!q("inout-export-pdf"), "the export menu");
    click(must("inout-export-pdf"));
    await waitFor(() => h.toast.mock.calls.length > 0, "the toast");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Too many rows for one file. Narrow the dates.", variant: "destructive" }),
    );
  });
});

describe("Overview", () => {
  const passNames = () =>
    [...document.body.querySelectorAll('[data-testid="outpass-passes"] tbody tr')].map((tr) =>
      text(tr.querySelector("td p")),
    );

  it("tiles count the range's passes and filter the list; the search and the status filter narrow it", async () => {
    mountPage(`${OUTPASS}/overview/passes`);
    // This Month (the date filter's default): every pass of October, 4 on the 14th and 1 out on the 10th
    await waitFor(() => ready("outpass-passes") && passNames().length === 5, "the passes");
    expect(["passes", "waiting", "approved", "rejected", "qr"].map((t) => tileValue(`overview-tile-${t}`))).toEqual([
      "5",
      "2",
      "2",
      "1",
      "5",
    ]);
    click(must("overview-tile-waiting"));
    await waitFor(() => passNames().join() === "Employee 1,Employee 2", "the waiting ones");
    expect(text(q("outpass-passes"))).toContain("2 passes of 5");
    expect(must("overview-tile-waiting").getAttribute("aria-pressed")).toBe("true");
    click(must("overview-tile-waiting"));
    await waitFor(() => passNames().length === 5, "all again");

    // Today: the tiles follow the days (the pass that went out on the 10th drops out)
    click(must("overview-dates-today"));
    await waitFor(() => passNames().length === 4, "today's passes");
    expect(["passes", "waiting", "approved", "rejected", "qr"].map((t) => tileValue(`overview-tile-${t}`))).toEqual([
      "4",
      "2",
      "1",
      "1",
      "2",
    ]);

    choose("passes-status", "out");
    await waitFor(() => passNames().join() === "Employee 3", "out now");
    choose("passes-status", "");
    typeInto(must("passes-search"), "destination 5");
    await waitFor(() => passNames().join() === "Employee 5", "the search");
  });

  it("has no Manage Gates button when the Manage Gates tab is hidden", async () => {
    h.user.current = role({ outpass_visitors: "edit", "outpass_visitors.outpass.gates": "hidden" });
    mountPage(`${OUTPASS}/overview/passes`);
    await waitFor(() => ready("outpass-passes"), "the passes");
    expect(q("overview-manage-gates")).toBeNull();
    expect(pillLabels("outpass-subtabs").map((l) => l.replace(/\s*\(\d+\)$/, ""))).not.toContain("Manage Gates");
  });
});

describe("Requests", () => {
  it("draws Approve / Reject only where HR may decide, and the MD portal's view-only copy decides nothing", async () => {
    mountPage(`${OUTPASS}/requests`);
    await waitFor(() => ready("outpass-requests") && text(q("outpass-requests")).includes("Employee 2"), "requests");
    const buttons = (label: string) =>
      [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="outpass-requests"] button')].filter(
        (b) => text(b) === label,
      );
    expect(buttons("Approve")).toHaveLength(1); // request 1 waits for HR; request 2 for a HOD
    expect(text(q("outpass-requests"))).toContain("2 waiting · 1 for HR to decide");
    expect(text(q("outpass-requests"))).toContain("Waiting for HOD");
    unmountPage();

    setViewOnlyWorkflows(["outpass"]);
    mountPage(`${OUTPASS}/requests`);
    await waitFor(() => ready("outpass-requests") && text(q("outpass-requests")).includes("Employee 1"), "requests");
    expect(buttons("Approve")).toHaveLength(0);
    expect(buttons("Reject")).toHaveLength(0);
    expect(tab("Requests")).not.toBeNull();
    await settle(10);
    expect(world.calls).toEqual([]);
  });

  const decisionButton = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="outpass-requests"] button')].find(
      (b) => text(b) === label,
    )!;
  /** Types into a React-controlled textarea the way the browser does. */
  const typeReason = (value: string) =>
    act(() => {
      const el = must("outpass-reject-text") as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("approving is one click, with no remark asked for", async () => {
    mountPage(`${OUTPASS}/requests`);
    await waitFor(() => ready("outpass-requests") && text(q("outpass-requests")).includes("Employee 1"), "requests");
    click(decisionButton("Approve"));
    await waitFor(() => world.calls.length === 1, "the decision");
    expect(world.calls[0]).toEqual({
      method: "PUT",
      url: "/api/outpass-requests/1/hr-status",
      body: { status: "approved" },
    });
    expect(q("outpass-reject-dialog")).toBeNull();
    await waitFor(() => h.toast.mock.calls.length > 0, "the toast");
    expect(h.toast).toHaveBeenCalledWith({ title: "Gate pass approved" });
  });

  it("rejecting asks for the reason: nothing is sent without one, and the reason goes with the decision", async () => {
    mountPage(`${OUTPASS}/requests`);
    await waitFor(() => ready("outpass-requests") && text(q("outpass-requests")).includes("Employee 1"), "requests");
    click(decisionButton("Reject"));
    await waitFor(() => q("outpass-reject-dialog") !== null, "the reason dialog");
    expect(text(q("outpass-reject-dialog"))).toContain("Reject this gate pass?");
    expect(text(q("outpass-reject-dialog"))).toContain("Employee 1");
    click(must("outpass-reject-confirm"));
    await settle(10);
    expect(world.calls).toEqual([]);
    expect(text(q("outpass-reject-dialog"))).toContain("Write the reason for rejecting (at least 3 characters).");
    typeReason("  Not   a work trip ");
    click(must("outpass-reject-confirm"));
    await waitFor(() => world.calls.length === 1, "the decision");
    expect(world.calls[0]).toEqual({
      method: "PUT",
      url: "/api/outpass-requests/1/hr-status",
      body: { status: "rejected", comment: "Not a work trip" },
    });
    await waitFor(() => h.toast.mock.calls.length > 0, "the toast");
    expect(h.toast).toHaveBeenCalledWith({ title: "Gate pass rejected" });
    await waitFor(() => q("outpass-reject-dialog") === null, "the dialog to close");
    expect(here()).toBe(`${OUTPASS}/requests`);
  });

  it("keeps the dialog open with the server's words when it refuses the rejection", async () => {
    const base = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "PUT" && url.endsWith("/hr-status")) {
        throw harnessError(
          400,
          { error: "Write the reason for rejecting (at least 3 characters).", code: "remark_required" },
          "PUT",
          url,
        );
      }
      return base(url, init);
    });
    mountPage(`${OUTPASS}/requests`);
    await waitFor(() => ready("outpass-requests") && text(q("outpass-requests")).includes("Employee 1"), "requests");
    click(decisionButton("Reject"));
    await waitFor(() => q("outpass-reject-dialog") !== null, "the reason dialog");
    typeReason("Not a work trip");
    click(must("outpass-reject-confirm"));
    await waitFor(() => q("outpass-reject-error") !== null, "the refusal");
    expect(text(q("outpass-reject-error"))).toBe("Write the reason for rejecting (at least 3 characters).");
    expect(q("outpass-reject-dialog")).not.toBeNull();
    expect(h.toast).not.toHaveBeenCalledWith({ title: "Gate pass rejected" });
  });
});

describe("switching between In/Out and Manage Gates", () => {
  // both lists keep their filters in the address under the same names (`q`, the dates, `gateId`, `page`) for different
  // rows: each tab's keys stay with it (OutpassTab OWN_KEYS -> SubtabBar ownKeys); a key neither owns still goes along
  const gateCalls = () => world.gets.filter((u) => u.startsWith("/api/gate-devices"));

  it("leaves In/Out's status and search behind, shows every gate, and gives both tabs their own filters back", async () => {
    await openInOut(`${IN_OUT}?status=overdue&q=meena&x=1`);
    await waitFor(() => names().join() === "Meena S", "Meena's overdue pass");

    click(tab("Manage Gates"));
    expect(here()).toBe(`${OUTPASS}/gates?x=1`);
    await waitFor(() => ready("gate-list") && ready("gate-records-table"), "Manage Gates");
    // the whole gate list, and neither the list nor the records were asked with In/Out's filters
    for (const id of [11, 12, 13]) expect(q(`gate-card-${id}`)).not.toBeNull();
    expect(gateCalls().length).toBeGreaterThan(0);
    for (const url of gateCalls()) {
      const sent = new URL(url, "http://x").searchParams;
      expect(sent.has("q"), url).toBe(false);
      expect(sent.has("status"), url).toBe(false);
    }
    expect((must("gate-records-search") as HTMLInputElement).value).toBe("");

    // Manage Gates' own choices
    click(must("gate-card-12"));
    choose("gate-records-type", "exit");
    await waitFor(() => here() === `${OUTPASS}/gates?x=1&gate=12&type=exit`, "the gate filters in the address");

    // back to In/Out: its own filters again, none of Manage Gates'
    const before = world.gets.length;
    click(tab("In/Out"));
    expect(here()).toBe(`${IN_OUT}?x=1&status=overdue&q=meena`);
    await waitFor(() => ready("inout-table") && names().join() === "Meena S", "Meena's overdue pass again");
    expect((must("inout-status") as HTMLSelectElement).value).toBe("overdue");
    expect((must("inout-search") as HTMLInputElement).value).toBe("meena");
    for (const url of world.gets.slice(before).filter((u) => u.startsWith("/api/outpass/in-out"))) {
      const sent = new URL(url, "http://x").searchParams;
      expect(sent.has("type"), url).toBe(false);
      expect(sent.has("gate"), url).toBe(false);
    }

    // and Manage Gates opens on the gate and type it was left with
    click(tab("Manage Gates"));
    expect(here()).toBe(`${OUTPASS}/gates?x=1&gate=12&type=exit`);
    await waitFor(() => ready("gate-records-table"), "Manage Gates again");
    expect(must("gate-card-12").getAttribute("aria-pressed")).toBe("true");
    expect((must("gate-records-type") as HTMLSelectElement).value).toBe("exit");
  });
});
