import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  click,
  freezeClock,
  here,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
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
import { getTeaBreakRuleQueryKey, TEA_BREAK_RECORDS_ROOT } from "@/lib/api-client/custom-hooks";

// The Tea Break page in jsdom, against the fake server (harness.tsx + harness-tea.ts): every filter reaches the server
// and narrows the list, the Breaks / By employee switch, the details drawer, the Excel / PDF export of each view, and a
// saved rule refreshing every list and figure. The clock is 14 Oct 2026 11:30 in India.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  download: vi.fn(async () => "tea_breaks_20261014_1130.xlsx"),
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
// the file itself is the server's (tests_tea_break_admin.py); here: what the page asks for
vi.mock("../kit/download", async (original) => ({
  ...(await original<typeof import("../kit/download")>()),
  downloadGateFile: h.download,
}));

const TEA = "/hr/outpass-visitors/tea-break";
const LIST = "/api/tea-break/records";
const SUMMARY = "/api/tea-break/records/summary";
const EMPLOYEES = "/api/tea-break/records/employees";
const PEOPLE = [
  { id: 1, employeeCode: "T1", firstName: "Tea", lastName: "Ontime" },
  { id: 3, employeeCode: "T3", firstName: "Tea", lastName: "Missing" },
];

let world: World;
let peopleAsked: string[];

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  h.user.current = null;
  world = installWorld(h.fetch);
  // the employee picker's look-up (GET /api/employees?search=): answered here, it is not a Tea Break address
  peopleAsked = [];
  const server = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementation(async (url: string, init?: unknown) => {
    if (url.startsWith("/api/employees?")) {
      peopleAsked.push(url);
      const search = (new URLSearchParams(url.split("?")[1]).get("search") ?? "").toLowerCase();
      return PEOPLE.filter((p) => `${p.firstName} ${p.lastName} ${p.employeeCode}`.toLowerCase().includes(search));
    }
    return server(url, init);
  });
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
});

/** The query of the latest GET of exactly `path`. */
const lastGet = (path: string): URLSearchParams => {
  const url = [...world.gets].reverse().find((u) => u.split("?")[0] === path);
  if (!url) throw new Error(`no GET ${path} yet; asked: ${world.gets.join(", ")}`);
  return new URLSearchParams(url.split("?")[1] ?? "");
};
const asked = (path: string) => world.gets.filter((u) => u.split("?")[0] === path).length;
const listText = () => text(q("tea-break-list"));
const query = () => new URLSearchParams(window.location.search);

/** Picks an option of a native select, as a person would. */
const choose = (id: string, value: string) =>
  act(() => {
    const el = must(id) as HTMLSelectElement;
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

/** Types into an input React controls (its own value setter, then the input event React listens to). */
const typeInto = (el: HTMLElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

const row = (name: string) =>
  [...document.body.querySelectorAll<HTMLTableRowElement>('[data-testid="tea-break-list"] tbody tr')].find((tr) =>
    text(tr).includes(name),
  )!;

async function openRecords(url = `${TEA}/records`, table = "tea-break-list") {
  const page = mountPage(url);
  await waitFor(() => ready(table) && !!q("tea-tile-breaks-value"), "the records and their figures");
  return page;
}

describe("the Records tab", () => {
  it("asks for today's breaks, figures and choices, and shows each break with its status", async () => {
    await openRecords();
    const list = lastGet(LIST);
    expect(Object.fromEntries(list)).toEqual({ from: "2026-10-14", to: "2026-10-14", page: "1", pageSize: "20" });
    expect(Object.fromEntries(lastGet(SUMMARY))).toEqual({ from: "2026-10-14", to: "2026-10-14" });
    expect(asked("/api/tea-break/records/options")).toBe(1);

    expect(text(must("tea-tile-breaks-value"))).toBe("4");
    expect(text(must("tea-tile-on-break-value"))).toBe("1");
    expect(text(must("tea-tile-overtime-value"))).toBe("1");
    expect(text(must("tea-tile-not-returned-value"))).toBe("1");
    expect(text(must("tea-tile-employees-value"))).toBe("4");
    expect(text(must("tea-tile-average-value"))).toBe("17 min"); // (8 + 25) / 2 finished breaks
    expect(text(must("tea-tile-overtime"))).toContain("Over 10 min");

    // the open breaks carry their running minutes; the finished ones their result
    expect(text(must("tea-status-4"))).toBe("On break · 8 min");
    expect(text(must("tea-status-3"))).toBe("Not returned · 2 h 00 m");
    expect(text(must("tea-status-2"))).toBe("Overtime");
    expect(text(row("Tea Overtime"))).toContain("+15 min");
    expect(must("tea-time-2").getAttribute("data-tone")).toBe("rose");
    expect(text(row("Tea Overtime"))).toContain("Gate 2");
    expect(text(row("Tea Missing"))).toContain("Still out");
    expect(text(must("tea-break-count"))).toBe("4 breaks · 14 Oct 2026");
    await waitFor(() => text(q("tea-break-allowed")) === "Allowed: 10 min.", "the rule in the subtitle");
  });

  it("a status tile filters the list (not the tiles), and a second click takes it off", async () => {
    await openRecords();
    click(must("tea-tile-not-returned"));
    await waitFor(() => lastGet(LIST).get("status") === "not_returned", "the filtered request");
    await waitFor(() => !listText().includes("Tea Ontime"), "the filtered list");
    expect(listText()).toContain("Tea Missing");
    expect(lastGet(SUMMARY).get("status")).toBeNull();
    expect(text(must("tea-tile-breaks-value"))).toBe("4");
    expect(must("tea-tile-not-returned").getAttribute("aria-pressed")).toBe("true");
    click(must("tea-tile-not-returned"));
    await waitFor(() => listText().includes("Tea Ontime"), "the whole list again");
    expect(query().get("status")).toBeNull();
  });
});

describe("every filter reaches the server and narrows the list", () => {
  it("department, status and gate, then Clear filters", async () => {
    await openRecords();
    choose("tea-department", "12");
    await waitFor(() => lastGet(LIST).get("departmentId") === "12", "the department in the request");
    await waitFor(() => !listText().includes("Tea Ontime"), "Cutting only");
    expect(listText()).toContain("Tea Missing");
    expect(lastGet(SUMMARY).get("departmentId")).toBe("12");

    choose("tea-status", "not_returned");
    await waitFor(() => lastGet(LIST).get("status") === "not_returned", "the status in the request");
    await waitFor(() => !listText().includes("Tea Onbreak"), "not returned only");
    expect(here()).toBe(`${TEA}/records?departmentId=12&status=not_returned`);

    click(must("tea-clear"));
    await waitFor(() => listText().includes("Tea Ontime"), "everything again");
    expect(window.location.search).toBe("");

    choose("tea-gate", "2");
    await waitFor(() => lastGet(LIST).get("gateId") === "2", "the gate in the request");
    // a break started OR ended at Gate 2
    await waitFor(() => !listText().includes("Tea Onbreak"), "Gate 2 only");
    expect(listText()).toContain("Tea Overtime");
    expect(listText()).toContain("Tea Missing");
    expect(lastGet(SUMMARY).get("gateId")).toBe("2");
  });

  it("the search box (on Enter, or after a pause)", async () => {
    await openRecords();
    const box = must("tea-search");
    typeInto(box, "missing");
    press(box, "Enter");
    await waitFor(() => lastGet(LIST).get("q") === "missing", "the search in the request");
    await waitFor(() => !listText().includes("Tea Ontime"), "the match only");
    expect(lastGet(SUMMARY).get("q")).toBe("missing");
    typeInto(box, "overtime");
    await waitFor(() => lastGet(LIST).get("q") === "overtime", "the search after the pause", 3000);
    await waitFor(() => listText().includes("Tea Overtime") && !listText().includes("Tea Missing"), "the new match");
  });

  it("the dates: a preset and typed days", async () => {
    await openRecords();
    click(must("tea-dates-week"));
    await waitFor(() => lastGet(LIST).get("from") === "2026-10-12", "the week in the request");
    expect(lastGet(LIST).get("to")).toBe("2026-10-14");
    await waitFor(() => text(must("tea-tile-breaks-value")) === "5", "the week's figures");
    typeInto(must("tea-dates-to"), "2026-10-12");
    await waitFor(() => lastGet(LIST).get("to") === "2026-10-12", "the typed day");
    expect(query().get("range")).toBe("custom");
    await waitFor(() => !listText().includes("Tea Missing"), "12 Oct only");
    expect(listText()).toContain("Tea Ontime");
    expect(text(must("tea-break-count"))).toBe("1 break · 12 Oct 2026");
  });

  it("the branch (an account not bound to one): its own choices, and nothing of another branch", async () => {
    await openRecords();
    await waitFor(() => q("tea-branch") !== null, "the branch choice");
    choose("tea-branch", "2");
    await waitFor(() => lastGet(LIST).get("branchId") === "2", "the branch in the request");
    expect(lastGet("/api/tea-break/records/options").get("branchId")).toBe("2");
    await waitFor(() => listText().includes("No tea breaks match"), "the empty list");
  });

  it("a branch-bound account has no branch choice", async () => {
    h.user.current = { branchId: 7 };
    await openRecords();
    expect(q("tea-branch")).toBeNull();
    expect(lastGet("/api/tea-break/records/options").get("branchId")).toBeNull();
  });

  it("the employee: looked up by name, picked, then shown as a chip that takes the filter off", async () => {
    await openRecords();
    const box = must("tea-employee");
    act(() => box.focus());
    typeInto(box, "missing");
    await waitFor(() => q("tea-employee-option") !== null, "the matches");
    expect(peopleAsked.at(-1)).toContain("search=missing");
    click(must("tea-employee-option"));
    await waitFor(() => lastGet(LIST).get("employeeId") === "3", "the employee in the request");
    expect(text(must("tea-employee-chip"))).toContain("Tea Missing · T3");
    await waitFor(() => !listText().includes("Tea Ontime"), "their breaks only");
    click(must("tea-employee-clear"));
    await waitFor(() => listText().includes("Tea Ontime"), "everyone again");
    expect(query().get("employeeId")).toBeNull();
  });

  it("no employee look-up for a role that may not read Employees", async () => {
    h.user.current = {
      role: "hr",
      isSuperAdmin: false,
      permissions: { outpass_visitors: "view", employees: "hidden" },
    };
    await openRecords();
    expect(q("tea-employee")).toBeNull();
    expect(q("tea-search")).not.toBeNull();
  });
});

describe("Breaks | By employee", () => {
  it("adds the breaks up per employee, sorts on the server, and an employee row lists that employee's breaks", async () => {
    await openRecords();
    click(must("tea-view-employees"));
    await waitFor(
      () => ready("tea-break-employees") && text(q("tea-break-employees")).includes("Tea Missing"),
      "the employees",
    );
    expect(query().get("view")).toBe("employees");
    expect(lastGet(EMPLOYEES).get("from")).toBe("2026-10-14");
    expect(lastGet(EMPLOYEES).get("view")).toBeNull();
    expect(q("tea-break-list")).toBeNull();
    expect(text(must("tea-break-count"))).toBe("4 employees · 4 breaks · 14 Oct 2026");

    click(must("tea-sort-total"));
    await waitFor(() => lastGet(EMPLOYEES).get("sort") === "-total", "the order in the request");
    const names = () =>
      [...document.body.querySelectorAll('[data-testid="tea-break-employees"] tbody tr')].map((tr) =>
        text(tr.querySelector("p")),
      );
    await waitFor(() => names()[0] === "Tea Overtime", "the longest total first");

    const overtime = [
      ...document.body.querySelectorAll<HTMLElement>('[data-testid="tea-break-employees"] tbody tr'),
    ].find((tr) => text(tr).includes("Tea Overtime"))!;
    click(overtime);
    await waitFor(() => ready("tea-break-list"), "the breaks view");
    expect(query().get("view")).toBeNull();
    expect(query().get("employeeId")).toBe("2");
    await waitFor(() => lastGet(LIST).get("employeeId") === "2", "their breaks");
    expect(text(must("tea-employee-chip"))).toContain("Tea Overtime · T2");
  });
});

describe("the details drawer", () => {
  it("shows both scans, the time against the rule, the month and the recent breaks", async () => {
    await openRecords();
    click(row("Tea Overtime"));
    await waitFor(() => text(q("tea-drawer-month")).includes("October 2026"), "the details");
    expect(asked("/api/tea-break/records/2")).toBe(1);
    const scans = text(must("tea-drawer-scans"));
    expect(scans).toContain("09:30");
    expect(scans).toContain("Gate 1");
    expect(scans).toContain("09:55");
    expect(scans).toContain("Gate 2");
    expect(text(must("tea-drawer-time"))).toContain("25 min taken · 10 min allowed · 15 min over");
    expect(text(must("tea-drawer-status"))).toBe("Overtime");
    expect(text(must("tea-break-drawer"))).toContain("T2 · Sewing · Operator");
    expect(text(must("tea-drawer-recent"))).toContain("This break");
    // the row stays marked while its drawer is open
    expect(row("Tea Overtime").getAttribute("aria-current")).toBe("true");
  });

  it("opens another of the employee's breaks, lists all of them, and closes with Esc", async () => {
    await openRecords();
    click(row("Tea Ontime"));
    await waitFor(() => text(q("tea-drawer-recent")).includes("12 Oct"), "two breaks");
    const older = [...must("tea-drawer-recent").querySelectorAll("button")].find((b) => text(b).includes("12 Oct"))!;
    click(older);
    await waitFor(() => text(q("tea-drawer-scans")).includes("15:00"), "the older break");
    expect(asked("/api/tea-break/records/5")).toBe(1);

    click(must("tea-drawer-all-breaks"));
    await waitFor(() => lastGet(LIST).get("employeeId") === "1", "their breaks");
    expect(text(must("tea-employee-chip"))).toContain("Tea Ontime · T1");

    click(row("Tea Ontime"));
    await waitFor(() => q("tea-break-drawer") !== null, "the drawer");
    press(document.activeElement ?? must("tea-break-drawer"), "Escape");
    await waitFor(() => q("tea-break-drawer") === null, "the drawer to close");
  });
});

describe("Export", () => {
  const exportAs = async (format: "xlsx" | "pdf") => {
    press(must("tea-break-export"), "Enter");
    await waitFor(() => q(`tea-break-export-${format}`) !== null, "the menu");
    click(must(`tea-break-export-${format}`));
    await waitFor(() => h.download.mock.calls.length > 0, "the download");
    await settle(20); // the menu's spinner goes away once the file is saved
  };

  it("downloads the breaks with the page's filters, every page", async () => {
    await openRecords(`${TEA}/records?departmentId=11&status=overtime&page=2`);
    await exportAs("xlsx");
    const [opts] = h.download.mock.calls[0] as unknown as [
      { path: string; format: string; title: string; query: URLSearchParams },
    ];
    expect(opts.path).toBe("/api/tea-break/records/export");
    expect(opts.format).toBe("xlsx");
    expect(opts.title).toBe("Tea breaks");
    expect(Object.fromEntries(opts.query)).toEqual({
      departmentId: "11",
      status: "overtime",
      from: "2026-10-14",
      to: "2026-10-14",
      view: "breaks",
    });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "File downloaded" }));
  });

  it("downloads the employee-wise view as its own file, in its order", async () => {
    await openRecords(`${TEA}/records?view=employees&sort=-avg`, "tea-break-employees");
    expect(lastGet(EMPLOYEES).get("sort")).toBe("-avg");
    await exportAs("pdf");
    const [opts] = h.download.mock.calls[0] as unknown as [{ format: string; title: string; query: URLSearchParams }];
    expect(opts.title).toBe("Tea breaks by employee");
    expect(opts.format).toBe("pdf");
    expect(opts.query.get("view")).toBe("employees");
    expect(opts.query.get("sort")).toBe("-avg");
  });
});

describe("the Rule tab", () => {
  it("a saved rule refreshes the rule, every list and figure, and the subtitle", async () => {
    const { client } = await openRecords();
    expect(text(must("tea-status-2"))).toBe("Overtime");
    click(tab("Rule"));
    await waitFor(() => ready("tea-break-rule"), "the rule");
    const input = document.body.querySelector<HTMLInputElement>("#tea-break-allowed-minutes")!;
    await waitFor(() => input.value === "10", "the rule to load");
    typeInto(input, "30");
    const save = [...document.body.querySelectorAll("button")].find((b) => text(b) === "Save")!;
    click(save);
    await waitFor(() => world.calls.length === 1, "the save");
    expect(world.calls[0]).toEqual({ method: "PUT", url: "/api/tea-break/rule", body: { allowedMinutes: 30 } });
    await waitFor(() => text(q("tea-break-allowed")) === "Allowed: 30 min.", "the subtitle");
    // the lists and figures of Records (not on screen) are marked stale, so they are asked for again
    const records = client.getQueryCache().findAll({ queryKey: [TEA_BREAK_RECORDS_ROOT] });
    expect(records.length).toBeGreaterThanOrEqual(3);
    expect(records.every((query) => query.state.isInvalidated)).toBe(true);
    expect(client.getQueryData(getTeaBreakRuleQueryKey())).toMatchObject({ allowedMinutes: 30 });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Tea break rule saved" }));

    const before = asked(LIST);
    click(tab("Records"));
    await waitFor(() => asked(LIST) > before, "the list asked for again");
    await waitFor(() => text(q("tea-status-2")) === "On time", "25 min is on time under 30");
    expect(text(must("tea-tile-overtime"))).toContain("Over 30 min");
  });

  it("refuses a value that is not a whole number of minutes", async () => {
    mountPage(`${TEA}/rule`);
    await waitFor(() => ready("tea-break-rule"), "the rule");
    const input = document.body.querySelector<HTMLInputElement>("#tea-break-allowed-minutes")!;
    await waitFor(() => input.value === "10", "the rule to load");
    typeInto(input, "0");
    expect(text(must("tea-break-rule"))).toContain("Enter a whole number of minutes, 1 or more.");
    click([...document.body.querySelectorAll("button")].find((b) => text(b) === "Save")!);
    expect(world.calls).toEqual([]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
  });

  it("a role that may only view the rule sees it and cannot change it", async () => {
    h.user.current = {
      role: "hr",
      isSuperAdmin: false,
      permissions: { outpass_visitors: "edit", "outpass_visitors.tea_break.rule": "view" },
    };
    mountPage(`${TEA}/rule`);
    await waitFor(() => ready("tea-break-rule"), "the rule");
    const input = document.body.querySelector<HTMLInputElement>("#tea-break-allowed-minutes")!;
    await waitFor(() => input.value === "10", "the rule to load");
    expect(input.disabled).toBe(true);
    expect([...document.body.querySelectorAll("button")].some((b) => text(b) === "Save")).toBe(false);
    expect(text(must("tea-break-rule"))).toContain("Your role can see the rule but not change it.");
  });
});
