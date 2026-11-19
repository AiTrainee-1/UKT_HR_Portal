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
  text,
  unmountPage,
  waitFor,
  type World,
} from "../harness";

// The Visitors page in jsdom with the fake server of harness-visitors.ts: the figures, every filter asking the server (and
// living in the address), the drawer with the history and the Aadhaar Show / Hide, check-out from the row and the drawer
// (and a refused one), registering a new and a returning visitor (with the employee look-up), the People view, the export
// and a View-only role. The clock is 14 Oct 2026, 11:30 in India.

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
vi.mock("../kit/download", async (original) => ({
  ...(await original<typeof import("../kit/download")>()),
  downloadGateFile: h.download,
}));

const URL_ = "/hr/outpass-visitors/visitors/visits";
let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  h.user.current = null;
  h.download.mockResolvedValue("visitors_20261014_1130.xlsx");
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
});

const role = (permissions: Record<string, string>, branchId: number | null = null) => ({
  role: "hr",
  employeeId: null,
  isSuperAdmin: false,
  permissions,
  branchId,
});

const records = () => world.gets.filter((u) => u.startsWith("/api/visitor/records"));
const lastRecords = () => new URLSearchParams(records().at(-1)!.split("?")[1] ?? "");
const rowNames = (id = "visitors-list") =>
  [...(q(id)?.querySelectorAll("tbody tr") ?? [])].map((tr) => text(tr.querySelector("td")));
const button = (name: string, root: ParentNode = document.body) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === name) ?? null;
const rowOf = (name: string) =>
  [...document.body.querySelectorAll<HTMLTableRowElement>('[data-testid="visitors-list"] tbody tr')].find((tr) =>
    text(tr).includes(name),
  )!;

function setValue(el: HTMLElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const blur = (el: HTMLElement) => act(() => el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

async function open() {
  mountPage(URL_);
  await waitFor(() => ready("visitors-list") && rowNames().length > 0, "the visits");
  await waitFor(() => text(q("visitors-stat-inside-value")) !== "", "the figures");
}

describe("the Visits view", () => {
  it("shows today's visits, the five figures, and asks for India's today without the screen switch", async () => {
    await open();
    expect(rowNames()).toEqual([
      expect.stringContaining("Visitor One"),
      expect.stringContaining("Ramesh Kumar"),
      expect.stringContaining("Prakash Sharma"),
    ]);
    expect(text(q("visitors-stat-inside-value"))).toBe("2");
    expect(text(q("visitors-stat-today-value"))).toBe("3");
    expect(text(q("visitors-stat-checked-out-value"))).toBe("1");
    expect(text(q("visitors-stat-long-value"))).toBe("1");
    expect(text(q("visitors-stat-repeat-value"))).toBe("1");
    const params = lastRecords();
    expect(params.get("from")).toBe("2026-10-14");
    expect(params.get("to")).toBe("2026-10-14");
    expect(params.has("view")).toBe(false);
    expect(params.has("range")).toBe(false);
    // the phone is masked in the table, the status is a word
    expect(text(rowOf("Ramesh"))).toContain("98•••••210");
    expect(text(rowOf("Ramesh"))).not.toContain("9845012210");
    expect(text(rowOf("Prakash"))).toContain("Checked out");
    expect(text(q("visitors-summary-line"))).toBe("3 visits · 1 checked out · 2 h 45 m on average");
  });

  it("every filter asks the server and stays in the address; Clear brings today back", async () => {
    await open();
    setValue(must("visitors-status"), "inside");
    await waitFor(() => lastRecords().get("status") === "inside", "the status filter");
    await waitFor(() => rowNames().length === 2, "two inside");
    expect(here()).toContain("status=inside");

    setValue(must("visitors-status"), "");
    await waitFor(() => (q("visitors-host") as HTMLSelectElement).options.length > 1, "the hosts");
    setValue(must("visitors-host"), "11");
    await waitFor(() => lastRecords().get("hostEmployeeId") === "11", "the host filter");
    await waitFor(() => rowNames().length === 1, "Ramesh only");
    setValue(must("visitors-host"), "");

    setValue(must("visitors-department"), "6");
    await waitFor(() => lastRecords().get("departmentId") === "6", "the department filter");
    await waitFor(() => rowNames().length === 1 && rowNames()[0].includes("Prakash"), "Prakash only");
    setValue(must("visitors-department"), "");

    setValue(must("visitors-source"), "hr");
    await waitFor(() => lastRecords().get("source") === "hr", "the check-in filter");
    setValue(must("visitors-source"), "");

    setValue(must("visitors-search"), "apex");
    await waitFor(() => lastRecords().get("q") === "apex", "the search (after the pause)");
    await waitFor(() => rowNames().length === 1 && rowNames()[0].includes("Ramesh"), "the search result");
    expect(here()).toContain("q=apex");

    // an account not bound to a branch picks one: it filters the list too
    await waitFor(() => (q("visitors-branch") as HTMLSelectElement | null)?.options.length === 2, "the branches");
    setValue(must("visitors-branch"), "1");
    await waitFor(() => lastRecords().get("branchId") === "1", "the branch filter");

    click(must("visitors-clear"));
    // (the first answer is cached, so the cleared list need not be asked for again)
    await waitFor(() => !here().includes("q=") && !here().includes("branchId="), "the cleared filters");
    await waitFor(() => rowNames().length === 3, "today's three");
    expect(q("visitors-clear")).toBeNull();
  });

  it("the dates: This week asks for Monday to today, a typed day is a custom range", async () => {
    await open();
    click(must("visitors-dates-week"));
    await waitFor(() => lastRecords().get("from") === "2026-10-12", "this week");
    expect(lastRecords().get("to")).toBe("2026-10-14");
    await waitFor(() => rowNames().length === 4, "with yesterday's visit");
    setValue(must("visitors-dates-from"), "2026-10-01");
    await waitFor(() => lastRecords().get("from") === "2026-10-01", "the typed day");
    await waitFor(() => rowNames().length === 5, "every visit");
    expect(here()).toContain("range=custom");
  });

  it("the Inside now figure filters the list", async () => {
    await open();
    click(must("visitors-stat-inside"));
    await waitFor(() => lastRecords().get("status") === "inside", "inside now");
    expect(must("visitors-stat-inside").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the visit panel", () => {
  it("opens from the row with the full phone, the Aadhaar masked until Show, and the history", async () => {
    await open();
    click(rowOf("Ramesh"));
    await waitFor(() => ready("visit-drawer") && text(q("visit-drawer")).includes("9845012210"), "the drawer");
    const drawer = must("visit-drawer");
    expect(text(drawer)).toContain("Registered by HR (Priya)");
    expect(text(drawer)).toContain("TN 37 AB 1234");
    expect(text(must("visit-drawer-aadhaar"))).toBe("XXXX XXXX 9012");
    click(must("visit-drawer-aadhaar-toggle"));
    expect(text(must("visit-drawer-aadhaar"))).toBe("1234 5678 9012");
    expect(text(must("visit-drawer-history"))).toContain("Visit history (2)");
    // an earlier visit opens in the same panel
    const older = [...must("visit-drawer-history").querySelectorAll("button")].find((b) =>
      text(b).includes("Spindle order"),
    )!;
    click(older);
    await waitFor(() => world.gets.includes("/api/visitor/visits/5"), "the older visit");
    await waitFor(
      () => text(q("visit-drawer")).includes("72 min") || text(q("visit-drawer")).includes("1 h 12 m"),
      "its stay",
    );
    expect(q("visit-drawer-check-out")).toBeNull(); // it is over
  });

  it("checks a visitor out from the panel, with a note", async () => {
    await open();
    click(rowOf("Ramesh"));
    await waitFor(() => q("visit-drawer-check-out") !== null, "the Check out button");
    click(must("visit-drawer-check-out"));
    await waitFor(() => q("check-out-dialog") !== null, "the dialog");
    setValue(must("check-out-note"), "Returned the badge");
    click(must("check-out-confirm"));
    await waitFor(() => world.calls.some((c) => c.url === "/api/visitor/visits/2/check-out"), "the check-out");
    expect(world.calls.find((c) => c.url === "/api/visitor/visits/2/check-out")!.body).toEqual({
      note: "Returned the badge",
    });
    await waitFor(() => h.toast.mock.calls.some(([t]) => t.title === "Ramesh Kumar is checked out"), "the toast");
    await waitFor(() => text(rowOf("Ramesh")).includes("Checked out"), "the row now checked out");
  });
});

describe("check-out from the table", () => {
  it("asks first, then records it and the row and the figures change", async () => {
    await open();
    expect(q("check-out-3")).toBeNull(); // Prakash already left
    click(must("check-out-1"));
    await waitFor(() => q("check-out-dialog") !== null, "the dialog");
    expect(text(must("check-out-dialog"))).toContain("Check out Visitor One");
    click(must("check-out-confirm"));
    await waitFor(() => world.calls.some((c) => c.url === "/api/visitor/visits/1/check-out"), "the call");
    expect(world.calls.at(-1)!.body).toEqual({});
    await waitFor(() => q("check-out-1") === null, "the button gone");
    await waitFor(() => text(q("visitors-stat-inside-value")) === "1", "one inside now");
  });

  it("says why when the visitor was already checked out elsewhere", async () => {
    await open();
    click(must("check-out-1"));
    await waitFor(() => q("check-out-dialog") !== null, "the dialog");
    // a reception desk checks Visitor One out meanwhile
    const rows = world.state.visitors as { id: number; checkedOutAt: string | null }[];
    rows.find((r) => r.id === 1)!.checkedOutAt = "2026-10-14T05:45:00Z";
    click(must("check-out-confirm"));
    await waitFor(() => text(q("check-out-dialog")).includes("already checked out"), "the reason");
  });
});

describe("Register visitor", () => {
  const openDialog = async () => {
    await open();
    click(must("visitors-register"));
    await waitFor(() => q("register-visitor-dialog") !== null, "the dialog");
  };

  it("checks a new visitor in, with the employee they meet looked up by phone", async () => {
    await openDialog();
    click(must("register-submit"));
    expect(text(must("register-error"))).toContain("Enter the visitor's phone number");
    expect(world.calls.filter((c) => c.url === "/api/visitor/visits")).toEqual([]);

    setValue(must("register-phone"), "70000 12345");
    blur(must("register-phone"));
    await waitFor(() => q("register-new-visitor") !== null, "the number checked: a new visitor");
    setValue(must("register-name"), "Lakshmi Narayan");
    setValue(must("register-company"), "Lotus Mills");
    setValue(must("register-vehicle"), "tn 01 x 9");
    setValue(must("register-purpose"), "Yarn samples");
    click(button("Yes", must("register-visitor-dialog")));
    setValue(must("input-meeting-emp-phone"), "9000011111");
    click(must("button-lookup-employee"));
    await waitFor(() => text(q("register-visitor-dialog")).includes("Karthik M"), "the matched employee");
    click(must("register-submit"));
    await waitFor(() => world.calls.some((c) => c.url === "/api/visitor/visits"), "the register call");
    const body = world.calls.find((c) => c.url === "/api/visitor/visits")!.body;
    expect(body).toMatchObject({
      name: "Lakshmi Narayan",
      phone: "70000 12345",
      company: "Lotus Mills",
      vehicleNumber: "tn 01 x 9",
      purpose: "Yarn samples",
      whomToMeet: "Karthik M",
      meetingEmployeeId: 11,
      peopleCount: 1,
      branchId: 1,
    });
    await waitFor(() => q("register-visitor-dialog") === null, "the dialog closed");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Lakshmi Narayan is checked in" }));
    await waitFor(() => rowNames().some((n) => n.includes("Lakshmi")), "the new visit listed");
  });

  it("knows a returning visitor, and one still inside points to their open visit", async () => {
    await openDialog();
    setValue(must("register-phone"), "98450 12210");
    blur(must("register-phone"));
    await waitFor(() => q("register-returning") !== null, "the returning visitor");
    expect(text(must("register-returning"))).toContain("Returning visitor: Ramesh Kumar, 2 visits");
    expect(text(must("register-returning"))).toContain("Still inside");
    expect((must("register-name") as HTMLInputElement).value).toBe("Ramesh Kumar");
    setValue(must("input-whom-freetext"), "Stores");
    setValue(must("register-purpose"), "Delivery");
    click(must("register-submit"));
    await waitFor(() => q("register-error") !== null, "the refusal");
    expect(text(must("register-error"))).toContain("already inside (checked in at 09:12)");
    click(must("register-open-visit"));
    await waitFor(() => q("register-visitor-dialog") === null, "the dialog closed");
    await waitFor(() => world.gets.includes("/api/visitor/visits/2"), "the open visit");
  });
});

describe("the People view", () => {
  it("lists everyone who visited, without the visit filters, and a person opens their last visit", async () => {
    await open();
    click(must("visitors-view-people"));
    await waitFor(() => ready("visitors-people") && rowNames("visitors-people").length > 0, "the people");
    expect(here()).toContain("view=people");
    const asked = world.gets.filter((u) => u.startsWith("/api/visitor/people")).at(-1)!;
    expect(asked).not.toContain("view=");
    expect(asked).not.toContain("from=");
    expect(rowNames("visitors-people")).toHaveLength(4);
    const ramesh = [...must("visitors-people").querySelectorAll("tbody tr")].find((tr) => text(tr).includes("Ramesh"))!;
    expect(text(ramesh)).toContain("98•••••210");
    expect(text(ramesh)).toContain("Inside now");
    click(ramesh);
    await waitFor(() => world.gets.includes("/api/visitor/visits/2"), "Ramesh's last visit");
    // back to the visits
    click(must("visitors-view-visits"));
    await waitFor(() => ready("visitors-list"), "the visits again");
    expect(here()).not.toContain("view=");
  });

  it("searches people on the server, and its Clear only clears this view's search", async () => {
    await open();
    setValue(must("visitors-status"), "inside");
    await waitFor(() => lastRecords().get("status") === "inside", "a visit filter");
    click(must("visitors-view-people"));
    await waitFor(() => ready("visitors-people") && rowNames("visitors-people").length === 4, "the people");
    expect(q("visitors-people-clear")).toBeNull(); // the visit filter does not count here
    setValue(must("visitors-people-search"), "ramesh");
    await waitFor(
      () => world.gets.some((u) => u.startsWith("/api/visitor/people") && u.includes("q=ramesh")),
      "the search",
    );
    await waitFor(() => rowNames("visitors-people").length === 1, "Ramesh only");
    click(must("visitors-people-clear"));
    await waitFor(() => rowNames("visitors-people").length === 4, "everyone again");
    expect(here()).toContain("status=inside");
  });
});

describe("the export", () => {
  it("downloads Excel of the list's filters, without the screen switch or the paging", async () => {
    await open();
    setValue(must("visitors-status"), "inside");
    await waitFor(() => lastRecords().get("status") === "inside", "the filter");
    press(must("visitors-export"), "Enter");
    await waitFor(() => q("visitors-export-xlsx") !== null, "the menu");
    click(must("visitors-export-xlsx"));
    await waitFor(() => h.download.mock.calls.length === 1, "the download");
    const { path, format, query } = h.download.mock.calls[0][0] as {
      path: string;
      format: string;
      query: URLSearchParams;
    };
    expect([path, format]).toEqual(["/api/visitor/export", "xlsx"]);
    expect(query.get("status")).toBe("inside");
    expect(query.get("from")).toBe("2026-10-14");
    expect(query.has("view")).toBe(false);
    expect(query.has("page")).toBe(false);
  });
});

describe("the reception desks and the visitor QR", () => {
  it("Manage Reception opens the tab of the desk logins (no dialog), and the QR button says Visitor QR", async () => {
    await open();
    expect(button("Visitor QR")).not.toBeNull();
    expect(button("Gate QR")).toBeNull();
    expect(q("visitors-reception-logins")).toBeNull();
    click(must("visitors-manage-reception"));
    await waitFor(() => window.location.pathname === "/hr/outpass-visitors/visitors/desks", "the Manage Reception tab");
    await waitFor(() => q("visitors-desks") !== null, "the desks page");
  });

  it("a View-only role may follow the link; a role without the desk logins has none", async () => {
    h.user.current = role({ outpass_visitors: "view" });
    await open();
    expect((must("visitors-manage-reception") as HTMLButtonElement).disabled).toBe(false);
    unmountPage();
    h.user.current = role({ outpass_visitors: "edit", "outpass_visitors.visitors.reception_devices": "hidden" });
    await open();
    expect(q("visitors-manage-reception")).toBeNull();
    expect(world.gets.some((u) => u.startsWith("/api/reception-devices"))).toBe(false);
  });
});

describe("a View-only role and a branch account", () => {
  it("View only: sees everything, cannot register or check out, may export", async () => {
    h.user.current = role({ outpass_visitors: "view" }, 1);
    await open();
    expect(q("visitors-register")).toBeNull();
    expect(q("check-out-1")).toBeNull();
    expect(q("visitors-branch")).toBeNull(); // bound to a branch: no branch filter
    expect((must("visitors-export") as HTMLButtonElement).disabled).toBe(false);
    click(rowOf("Ramesh"));
    await waitFor(() => ready("visit-drawer") && text(q("visit-drawer")).includes("9845012210"), "the drawer");
    expect(q("visit-drawer-check-out")).toBeNull();
  });

  it("an edit role bound to a branch registers without choosing one", async () => {
    h.user.current = role({ outpass_visitors: "edit" }, 1);
    await open();
    click(must("visitors-register"));
    await waitFor(() => q("register-visitor-dialog") !== null, "the dialog");
    expect(q("register-branch")).toBeNull();
    setValue(must("register-phone"), "70000 99999");
    setValue(must("register-name"), "Mani");
    setValue(must("input-whom-freetext"), "Accounts");
    setValue(must("register-purpose"), "Cheque");
    click(must("register-submit"));
    await waitFor(() => world.calls.some((c) => c.url === "/api/visitor/visits"), "the call");
    expect(world.calls.find((c) => c.url === "/api/visitor/visits")!.body).not.toHaveProperty("branchId");
  });
});
