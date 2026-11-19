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
  pillLabels,
  press,
  q,
  ready,
  settle,
  text,
  unmountPage,
  waitFor,
  type World,
} from "../../harness";

// Visitors -> Manage Reception (/hr/outpass-visitors/visitors/desks) in jsdom with the fake server of harness-desks.ts: the
// strip, the list and the tiles, choosing a desk (the address keys desk / deskQ / deskStatus, never the Visitors tab's),
// View password (and who does not get it), Add / Edit / Reset password / Sign out everywhere / Switch off / Delete with the
// bodies they send, the records filters reaching the request, and both Export buttons handing the right address and
// filters to the download.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  download: vi.fn(),
  clipboard: vi.fn(),
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

const DESKS = "/hr/outpass-visitors/visitors/desks";

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  h.user.current = null;
  h.download.mockResolvedValue("reception_records_20261014_1130.xlsx");
  h.clipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: h.clipboard }, configurable: true });
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
});

const role = (permissions: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  role: "hr",
  employeeId: null,
  isSuperAdmin: false,
  permissions,
  ...extra,
});

/** Types into an input / select the way React hears it. */
function setValue(el: HTMLElement, value: string) {
  act(() => {
    const proto =
      el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

const recordsGets = () => world.gets.filter((u) => u.startsWith("/api/reception-devices/records"));
const lastRecords = () => new URL(recordsGets().at(-1)!, "http://x").searchParams;
const callsTo = (method: string, url: string) => world.calls.filter((c) => c.method === method && c.url === url);

async function open(url = DESKS) {
  mountPage(url);
  await waitFor(() => ready("desk-list") && ready("desk-detail") && ready("desk-records-table"), "the page");
}

describe("the strip, the list, the tiles and choosing a desk", () => {
  it("shows the tiles, the desks and the first desk with its records", async () => {
    await open();
    expect(pillLabels("visitors-subtabs")).toEqual(["Visitors", "Manage Reception"]);
    expect(text(must("desk-tile-desks-value"))).toBe("3");
    expect(text(must("desk-tile-desks"))).toContain("2 switched on");
    expect(text(must("desk-tile-check-ins-value"))).toBe("2");
    expect(text(must("desk-tile-check-outs-value"))).toBe("1");
    expect(text(must("desk-signin-address"))).toContain(`${window.location.origin}/reception-login`);
    for (const id of [21, 22, 23]) expect(q(`desk-card-${id}`)).not.toBeNull();
    expect(text(must("desk-card-21"))).toContain("front.desk");
    expect(text(must("desk-card-21"))).toContain("3 today");
    expect(text(must("desk-card-23"))).toContain("Off");
    // nothing chosen yet: the first desk is shown (and marked) without writing the address
    expect(text(must("desk-name"))).toBe("Front Desk");
    expect(must("desk-card-21").getAttribute("aria-pressed")).toBe("true");
    expect(lastRecords().get("deskId")).toBe("21");
    expect(lastRecords().get("from")).toBe("2026-10-01");
    expect(lastRecords().get("to")).toBe("2026-10-14");
    expect(text(must("desk-records-summary"))).toBe("2 records · 1 check-in · 1 check-out");
    expect(text(must("desk-sessions"))).toContain("Online now");
    expect(text(must("desk-count-check-ins"))).toContain("12");
    expect(text(must("desk-count-check-outs"))).toContain("9");
    expect(text(must("desk-notes"))).toBe("Day shift desk");
    // the old JSON's login link never shows on the page, and the Visitors list is not drawn here
    expect(document.body.innerHTML).not.toContain("desk-login-token-21");
    expect(q("visitors-list")).toBeNull();
  });

  it("a click on a desk puts it in the address (its own key), shows it and asks for its records", async () => {
    await open();
    click(must("desk-card-22"));
    await waitFor(() => text(q("desk-name")) === "Side Desk", "Side Desk");
    expect(here()).toBe(`${DESKS}?desk=22`);
    await waitFor(() => lastRecords().get("deskId") === "22", "its records");
    await waitFor(() => text(q("desk-records-table")).includes("Anand Natarajan"), "rows");
    // a desk set before passwords were kept: nothing to view
    expect(q("desk-password-view")).toBeNull();
    expect(text(must("desk-password-note"))).toContain("Not stored for desks created before 18 Nov 2026");
  });

  it("opens straight on the desk of the address", async () => {
    await open(`${DESKS}?desk=23`);
    expect(text(must("desk-name"))).toBe("Old Desk");
    expect(text(must("desk-header"))).toContain("switched off");
  });

  it("searches and filters the desk list on the server, with keys of its own", async () => {
    await open();
    setValue(must("desk-search"), "front");
    await waitFor(() => world.gets.includes("/api/reception-devices?q=front"), "the search request", 2000);
    await waitFor(() => q("desk-card-22") === null, "the filtered list");
    setValue(must("desk-status-filter"), "inactive");
    await waitFor(() => world.gets.includes("/api/reception-devices?q=front&deskStatus=inactive"), "the status");
    await waitFor(() => !!q("desk-list-empty"), "no desk matches");
    expect(here()).toContain("deskQ=front");
    expect(here()).toContain("deskStatus=inactive");
    expect(here()).not.toMatch(/[?&](q|status)=/);
  });

  it("Visitors tab filters in the address do not filter the desks, and the strip goes back", async () => {
    await open(`${DESKS}?q=apex&status=inside&range=week`);
    expect(world.gets.filter((u) => u.startsWith("/api/reception-devices?"))).toEqual([]);
    expect(lastRecords().has("q")).toBe(false);
    expect(lastRecords().get("from")).toBe("2026-10-01"); // the records' own default (this month), not ?range=week
    click([...document.body.querySelectorAll<HTMLElement>('[data-testid="visitors-subtabs"] [role="tab"]')][0]);
    await waitFor(() => window.location.pathname === "/hr/outpass-visitors/visitors/visits", "the Visitors tab");
    await waitFor(() => ready("visitors-list"), "the visits");
  });
});

describe("the password", () => {
  it("View asks the server, shows it and Copy copies it", async () => {
    await open();
    expect(text(must("desk-password"))).toBe("••••••••••");
    click(must("desk-password-view"));
    await waitFor(() => text(q("desk-password")) === "desk-secret", "the password");
    expect(callsTo("POST", "/api/reception-devices/21/reveal-password")).toHaveLength(1);
    click(must("desk-password-copy"));
    await waitFor(() => h.clipboard.mock.calls.length === 1, "the copy");
    expect(h.clipboard).toHaveBeenCalledWith("desk-secret");
    expect(callsTo("POST", "/api/reception-devices/21/reveal-password")).toHaveLength(1);
    click(must("desk-password-view")); // Hide
    expect(text(must("desk-password"))).toBe("••••••••••");
  });

  it("a 409 not_stored turns into the 'set a new password' note", async () => {
    await open();
    (world.state.desks as { passwords: Record<number, string | null> }).passwords[21] = null;
    click(must("desk-password-view"));
    await waitFor(() => text(q("desk-password-note")).includes("Not stored"), "the note");
    expect(q("desk-password-view")).toBeNull();
    expect(q("desk-password-set-new")).not.toBeNull();
  });

  it("is not offered without 'See desk passwords', while the rest stays editable", async () => {
    h.user.current = role({
      outpass_visitors: "edit",
      "outpass_visitors.visitors.reception_devices.view_password": "hidden",
    });
    await open();
    expect(q("desk-password-view")).toBeNull();
    expect(q("desk-password-copy")).toBeNull();
    expect(text(must("desk-password-note"))).toContain("Only people allowed to see desk passwords");
    expect(q("desk-edit")).not.toBeNull();
    expect(q("desk-add")).not.toBeNull();
  });

  it("View only: everything to look at, nothing to change, export still there", async () => {
    h.user.current = role({ outpass_visitors: "view" });
    await open();
    expect(q("desks-view-only")).not.toBeNull();
    for (const id of ["desk-add", "desk-edit", "desk-reset", "desk-signout", "desk-delete", "desk-active"]) {
      expect(q(id), id).toBeNull();
    }
    expect(q("desk-password-view")).toBeNull();
    expect(q("desk-records-export")).not.toBeNull();
    expect(q("desk-list-export")).not.toBeNull();
    expect(world.calls).toEqual([]);
  });

  it("a role that set the tab itself to View only gets a View-only page", async () => {
    h.user.current = role({ outpass_visitors: "edit", "outpass_visitors.visitors.desks": "view" });
    await open();
    expect(q("desks-view-only")).not.toBeNull();
    expect(q("desk-add")).toBeNull();
  });
});

describe("who may open the tab", () => {
  it("has no Manage Reception without 'Reception desk devices', and sends that role away from its address", async () => {
    h.user.current = role({ outpass_visitors: "edit", "outpass_visitors.visitors.reception_devices": "hidden" });
    mountPage(DESKS);
    await waitFor(() => window.location.pathname === "/hr/outpass-visitors/visitors/visits", "the Visitors tab");
    await waitFor(() => ready("visitors-list"), "the visits");
    expect(pillLabels("visitors-subtabs")).toEqual(["Visitors"]);
    expect(q("visitors-desks")).toBeNull();
    expect(world.gets.some((u) => u.startsWith("/api/reception-devices"))).toBe(false);
  });

  it("a role with only Manage Reception lands on it", async () => {
    h.user.current = role({ outpass_visitors: "edit", "outpass_visitors.visitors.visits": "hidden" });
    mountPage("/hr/outpass-visitors/visitors");
    await waitFor(() => window.location.pathname === DESKS, "the Manage Reception tab");
    await waitFor(() => ready("desk-list"), "the desks");
    expect(pillLabels("visitors-subtabs")).toEqual(["Manage Reception"]);
  });
});

describe("changing desks", () => {
  it("Add desk sends the form and opens the new desk", async () => {
    await open();
    click(must("desk-add"));
    await waitFor(() => !!q("desk-add-dialog"), "the dialog");
    setValue(must("desk-form-name"), "Gate Desk");
    setValue(must("desk-form-location"), "Near the gate");
    setValue(must("desk-form-username"), "gate.desk");
    setValue(must("desk-form-password"), "gate-pass-1");
    await waitFor(() => (must("desk-form-branch") as HTMLSelectElement).value === "1", "the only branch");
    click(must("desk-add-submit"));
    await waitFor(() => callsTo("POST", "/api/reception-devices").length === 1, "the POST");
    expect(callsTo("POST", "/api/reception-devices")[0].body).toEqual({
      name: "Gate Desk",
      branchId: 1,
      username: "gate.desk",
      password: "gate-pass-1",
      location: "Near the gate",
      notes: null,
    });
    await waitFor(() => here() === `${DESKS}?desk=200`, "the new desk in the address");
    await waitFor(() => text(q("desk-name")) === "Gate Desk", "the new desk");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Desk added" }));
  });

  it("Add desk says what is wrong before sending anything", async () => {
    await open();
    click(must("desk-add"));
    await waitFor(() => !!q("desk-add-dialog"), "the dialog");
    click(must("desk-add-submit"));
    await waitFor(() => text(q("desk-add-dialog")).includes("Give the desk a name."), "the name message");
    setValue(must("desk-form-name"), "X");
    setValue(must("desk-form-username"), "a b");
    await waitFor(() => (must("desk-form-branch") as HTMLSelectElement).value === "1", "the only branch");
    click(must("desk-add-submit"));
    await waitFor(() => text(q("desk-add-dialog")).includes("Username cannot have spaces."), "the username message");
    setValue(must("desk-form-username"), "abc");
    setValue(must("desk-form-password"), "12345");
    click(must("desk-add-submit"));
    await waitFor(() => text(q("desk-add-dialog")).includes("Password must be at least 6"), "the password message");
    expect(world.calls).toEqual([]);
  });

  it("Edit sends only what changed and warns about a new username", async () => {
    await open();
    click(must("desk-edit"));
    await waitFor(() => !!q("desk-edit-dialog"), "the dialog");
    setValue(must("desk-form-location"), "Office side");
    setValue(must("desk-form-username"), "lobby.desk");
    expect(text(must("desk-edit-dialog"))).toContain("A new username signs this desk out everywhere");
    click(must("desk-edit-submit"));
    await waitFor(() => callsTo("PUT", "/api/reception-devices/21").length === 1, "the PUT");
    expect(callsTo("PUT", "/api/reception-devices/21")[0].body).toEqual({
      location: "Office side",
      username: "lobby.desk",
    });
    await waitFor(() => text(q("desk-username")) === "lobby.desk", "the new username");
  });

  it("Reset password sets it and shows it once with Copy", async () => {
    await open();
    click(must("desk-reset"));
    await waitFor(() => !!q("desk-reset-dialog"), "the dialog");
    setValue(must("desk-reset-password"), "fresh-pass-1");
    click(must("desk-reset-submit"));
    await waitFor(() => !!q("desk-new-password"), "the new password");
    expect(callsTo("PUT", "/api/reception-devices/21")[0].body).toEqual({ password: "fresh-pass-1" });
    expect(text(must("desk-new-password"))).toBe("fresh-pass-1");
    click(must("desk-new-password-copy"));
    await waitFor(() => h.clipboard.mock.calls.length === 1, "the copy");
    click(must("desk-reset-done"));
    await waitFor(() => !q("desk-reset-dialog"), "closed");
    await waitFor(() => text(q("desk-sessions")).includes("Not signed in anywhere"), "signed out");
  });

  it("Suggest fills a readable password", async () => {
    await open();
    click(must("desk-reset"));
    await waitFor(() => !!q("desk-reset-dialog"), "the dialog");
    click(must("desk-reset-password-suggest"));
    expect((must("desk-reset-password") as HTMLInputElement).value).toMatch(/^[a-zA-Z2-9]{10}$/);
    expect((must("desk-reset-password") as HTMLInputElement).type).toBe("text");
  });

  it("Sign out everywhere asks, then signs every browser out", async () => {
    await open();
    click(must("desk-signout"));
    await waitFor(() => !!q("desk-signout-confirm"), "the question");
    click(must("desk-signout-confirm-confirm"));
    await waitFor(() => callsTo("POST", "/api/reception-devices/21/sign-out").length === 1, "the sign-out");
    await waitFor(() => text(q("desk-sessions")).includes("Not signed in anywhere"), "no sessions");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Signed out everywhere", description: "1 browser was signed out." }),
    );
  });

  it("switching off asks first; switching on does not", async () => {
    await open();
    click(must("desk-active"));
    await waitFor(() => !!q("desk-switchoff-confirm"), "the question");
    expect(world.calls).toEqual([]);
    click(must("desk-switchoff-confirm-confirm"));
    await waitFor(() => callsTo("PUT", "/api/reception-devices/21").length === 1, "the PUT");
    expect(callsTo("PUT", "/api/reception-devices/21")[0].body).toEqual({ isActive: false });
    await waitFor(() => must("desk-active").getAttribute("aria-checked") === "false", "off");
    click(must("desk-active"));
    await waitFor(() => callsTo("PUT", "/api/reception-devices/21").length === 2, "the second PUT");
    expect(callsTo("PUT", "/api/reception-devices/21")[1].body).toEqual({ isActive: true });
  });

  it("Delete says it cannot be undone and offers switching off instead", async () => {
    await open();
    click(must("desk-delete"));
    await waitFor(() => !!q("desk-delete-confirm"), "the question");
    expect(text(must("desk-delete-confirm"))).toContain("cannot be undone");
    expect(text(must("desk-delete-confirm"))).toContain("switch it off instead");
    click(must("desk-delete-switchoff"));
    await waitFor(() => !!q("desk-switchoff-confirm"), "the softer way");
    expect(world.calls).toEqual([]);
    unmountPage();

    world = installWorld(h.fetch);
    await open();
    click(must("desk-delete"));
    await waitFor(() => !!q("desk-delete-confirm"), "the question");
    click(must("desk-delete-confirm-confirm"));
    await waitFor(() => callsTo("DELETE", "/api/reception-devices/21").length === 1, "the DELETE");
    await waitFor(() => q("desk-card-21") === null, "gone from the list");
  });
});

describe("the records", () => {
  it("every filter reaches the request, under keys of its own", async () => {
    await open();
    setValue(must("desk-records-type"), "check_out");
    await waitFor(() => lastRecords().get("type") === "check_out", "type");
    await waitFor(
      () =>
        text(q("desk-records-table")).includes("Prakash Sharma") &&
        !text(q("desk-records-table")).includes("Ramesh Kumar"),
      "only the check-out",
    );
    click(must("desk-records-dates-today"));
    await waitFor(() => lastRecords().get("from") === "2026-10-14", "today");
    expect(lastRecords().get("to")).toBe("2026-10-14");
    setValue(must("desk-records-search"), "audit");
    await waitFor(() => lastRecords().get("q") === "audit", "the search", 2000);
    expect(lastRecords().get("deskId")).toBe("21");
    expect(here()).toContain("recType=check_out");
    expect(here()).toContain("recQ=audit");
    click(must("desk-records-clear"));
    await waitFor(() => !/recType=|recQ=|recRange=/.test(here()), "cleared");
    await waitFor(() => text(q("desk-records-table")).includes("Ramesh Kumar"), "every row again");
    expect(text(must("desk-name"))).toBe("Front Desk");
  });

  it("All desks lists every desk with a Desk filter", async () => {
    await open();
    expect(q("desk-records-desk")).toBeNull();
    click(must("desk-card-all"));
    await waitFor(() => here() === `${DESKS}?desk=all`, "the address");
    await waitFor(() => !lastRecords().has("deskId"), "every desk");
    expect(q("desk-detail")).toBeNull();
    await waitFor(() => text(q("desk-records-table")).includes("Side Desk"), "the Desk column");
    setValue(must("desk-records-desk"), "22");
    await waitFor(() => lastRecords().get("deskId") === "22", "one desk");
    expect(here()).toContain("recDesk=22");
  });

  it("a row opens its details", async () => {
    await open();
    click(document.body.querySelector<HTMLElement>('[data-row-key="out-2"]')!);
    await waitFor(() => !!q("desk-record-drawer"), "the drawer");
    expect(text(must("desk-record-drawer"))).toContain("Prakash Sharma");
    expect(text(must("desk-record-drawer"))).toContain("Checked out");
  });

  it("Export hands the records' filters (and the desk) to the download", async () => {
    await open();
    setValue(must("desk-records-type"), "check_in");
    await waitFor(() => lastRecords().get("type") === "check_in", "type");
    press(must("desk-records-export"), "Enter");
    await waitFor(() => !!q("desk-records-export-xlsx"), "the menu");
    click(must("desk-records-export-xlsx"));
    await waitFor(() => h.download.mock.calls.length === 1, "the download");
    const sent = h.download.mock.calls[0][0] as { path: string; query: URLSearchParams; format: string; title: string };
    expect(sent.path).toBe("/api/reception-devices/records/export");
    expect(sent.format).toBe("xlsx");
    expect(sent.title).toBe("Reception records - Front Desk");
    expect(Object.fromEntries(sent.query)).toEqual({
      deskId: "21",
      from: "2026-10-01",
      to: "2026-10-14",
      type: "check_in",
    });
  });

  it("Export desks downloads the desk list with its filters", async () => {
    await open();
    setValue(must("desk-status-filter"), "active");
    await waitFor(() => world.gets.includes("/api/reception-devices?deskStatus=active"), "the list");
    press(must("desk-list-export"), "Enter");
    await waitFor(() => !!q("desk-list-export-pdf"), "the menu");
    click(must("desk-list-export-pdf"));
    await waitFor(() => h.download.mock.calls.length === 1, "the download");
    const sent = h.download.mock.calls[0][0] as { path: string; query: Record<string, string>; format: string };
    expect(sent.path).toBe("/api/reception-devices/export");
    expect(sent.format).toBe("pdf");
    expect(sent.query).toEqual({ q: "", deskStatus: "active" });
    await settle(10);
  });
});
