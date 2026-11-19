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
  text,
  unmountPage,
  waitFor,
  type World,
} from "../harness";

// Manage Gates (/hr/outpass-visitors/outpass/gates) in jsdom with the fake server of harness-gates.ts: the list and the
// tiles, choosing a gate (the address), View password (and who does not get it), Add / Edit / Reset password / Sign out
// everywhere / Switch off / Delete with the bodies they send, the records filters reaching the request, and both
// Export buttons handing the right address and filters to the download.

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

const GATES = "/hr/outpass-visitors/outpass/gates";

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  h.user.current = null;
  h.download.mockResolvedValue("gate_records_20261014_1130.xlsx");
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

const recordsGets = () => world.gets.filter((u) => u.startsWith("/api/gate-devices/records"));
const lastRecords = () => new URL(recordsGets().at(-1)!, "http://x").searchParams;
const callsTo = (method: string, url: string) => world.calls.filter((c) => c.method === method && c.url === url);

async function open(url = GATES) {
  mountPage(url);
  await waitFor(() => ready("gate-list") && ready("gate-detail") && ready("gate-records-table"), "the page");
}

describe("the list, the tiles and choosing a gate", () => {
  it("shows the tiles, the gates and the first gate with its records", async () => {
    await open();
    expect(text(must("gate-tile-gates-value"))).toBe("3");
    expect(text(must("gate-tile-gates"))).toContain("2 switched on");
    expect(text(must("gate-tile-denied-value"))).toBe("1");
    expect(text(must("gate-monitor-address"))).toContain(`${window.location.origin}/gatemonitor`);
    for (const id of [11, 12, 13]) expect(q(`gate-card-${id}`)).not.toBeNull();
    expect(text(must("gate-card-11"))).toContain("main.gate1");
    expect(text(must("gate-card-13"))).toContain("Off");
    // nothing chosen yet: the first gate is shown (and marked) without writing the address
    expect(text(must("gate-name"))).toBe("Main Gate");
    expect(must("gate-card-11").getAttribute("aria-pressed")).toBe("true");
    expect(lastRecords().get("gateId")).toBe("11");
    expect(lastRecords().get("from")).toBe("2026-10-01");
    expect(lastRecords().get("to")).toBe("2026-10-14");
    expect(text(must("gate-records-summary"))).toBe("3 records · 1 exit · 0 returns · 1 tea break · 1 denied");
    expect(text(must("gate-sessions"))).toContain("Online now");
    expect(text(must("gate-count-exits"))).toContain("10");
    // the old JSON's login link never shows on the page
    expect(document.body.innerHTML).not.toContain("login-token-11");
  });

  it("a click on a gate puts it in the address, shows it and asks for its records", async () => {
    await open();
    click(must("gate-card-12"));
    await waitFor(() => text(q("gate-name")) === "Back Gate", "Back Gate");
    expect(here()).toBe(`${GATES}?gate=12`);
    await waitFor(() => lastRecords().get("gateId") === "12", "its records");
    await waitFor(() => ready("gate-records-table") && text(q("gate-records-table")).includes("Kavitha Balan"), "rows");
    // a gate set before passwords were kept: nothing to view
    expect(q("gate-password-view")).toBeNull();
    expect(text(must("gate-password-note"))).toContain("Not stored for gates created before 18 Nov 2026");
  });

  it("opens straight on the gate of the address", async () => {
    await open(`${GATES}?gate=13`);
    expect(text(must("gate-name"))).toBe("Old Gate");
    expect(text(must("gate-header"))).toContain("switched off");
  });

  it("searches and filters the gate list on the server", async () => {
    await open();
    setValue(must("gate-search"), "main");
    await waitFor(() => world.gets.includes("/api/gate-devices?q=main"), "the search request", 2000);
    await waitFor(() => q("gate-card-12") === null, "the filtered list");
    setValue(must("gate-status-filter"), "inactive");
    await waitFor(() => world.gets.includes("/api/gate-devices?q=main&status=inactive"), "the status request");
    await waitFor(() => !!q("gate-list-empty"), "no gate matches");
    expect(here()).toContain("gq=main");
  });
});

describe("the password", () => {
  it("View asks the server, shows it and Copy copies it", async () => {
    await open();
    expect(text(must("gate-password"))).toBe("••••••••••");
    click(must("gate-password-view"));
    await waitFor(() => text(q("gate-password")) === "secret-one", "the password");
    expect(callsTo("POST", "/api/gate-devices/11/reveal-password")).toHaveLength(1);
    click(must("gate-password-copy"));
    await waitFor(() => h.clipboard.mock.calls.length === 1, "the copy");
    expect(h.clipboard).toHaveBeenCalledWith("secret-one");
    // already shown: Copy did not ask again
    expect(callsTo("POST", "/api/gate-devices/11/reveal-password")).toHaveLength(1);
    click(must("gate-password-view")); // Hide
    expect(text(must("gate-password"))).toBe("••••••••••");
  });

  it("a 409 not_stored turns into the 'set a new password' note", async () => {
    await open();
    (world.state.gates as { passwords: Record<number, string | null> }).passwords[11] = null;
    click(must("gate-password-view"));
    await waitFor(() => text(q("gate-password-note")).includes("Not stored"), "the note");
    expect(q("gate-password-view")).toBeNull();
    expect(q("gate-password-set-new")).not.toBeNull();
  });

  it("is not offered without 'See gate passwords', while the rest stays editable", async () => {
    h.user.current = role({
      outpass_visitors: "edit",
      "outpass_visitors.outpass.gate_devices.view_password": "hidden",
    });
    await open();
    expect(q("gate-password-view")).toBeNull();
    expect(q("gate-password-copy")).toBeNull();
    expect(text(must("gate-password-note"))).toContain("Only people allowed to see gate passwords");
    expect(q("gate-edit")).not.toBeNull();
    expect(q("gate-add")).not.toBeNull();
  });

  it("View only: everything to look at, nothing to change, export still there", async () => {
    h.user.current = role({ outpass_visitors: "view" });
    await open();
    expect(q("gates-view-only")).not.toBeNull();
    for (const id of ["gate-add", "gate-edit", "gate-reset", "gate-signout", "gate-delete", "gate-active"]) {
      expect(q(id), id).toBeNull();
    }
    expect(q("gate-password-view")).toBeNull();
    expect(must("gate-allow-outpass").tagName).toBe("SPAN"); // a Yes / No chip, not a switch
    expect(q("gate-records-export")).not.toBeNull();
    expect(q("gate-list-export")).not.toBeNull();
    expect(world.calls).toEqual([]);
  });
});

describe("changing gates", () => {
  it("Add gate sends the form and opens the new gate", async () => {
    await open();
    click(must("gate-add"));
    await waitFor(() => !!q("gate-add-dialog"), "the dialog");
    setValue(must("gate-form-name"), "Canteen Gate");
    setValue(must("gate-form-location"), "Canteen road");
    setValue(must("gate-form-username"), "canteen.gate");
    setValue(must("gate-form-password"), "canteen-pass");
    click(must("gate-form-allow-tea"));
    await waitFor(() => (must("gate-form-branch") as HTMLSelectElement).value === "1", "the only branch");
    click(must("gate-add-submit"));
    await waitFor(() => callsTo("POST", "/api/gate-devices").length === 1, "the POST");
    expect(callsTo("POST", "/api/gate-devices")[0].body).toEqual({
      name: "Canteen Gate",
      branchId: 1,
      username: "canteen.gate",
      password: "canteen-pass",
      location: "Canteen road",
      notes: null,
      allowOutpass: true,
      allowTeaBreak: false,
    });
    await waitFor(() => here() === `${GATES}?gate=100`, "the new gate in the address");
    await waitFor(() => text(q("gate-name")) === "Canteen Gate", "the new gate");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Gate added" }));
  });

  it("Add gate says what is wrong before sending anything", async () => {
    await open();
    click(must("gate-add"));
    await waitFor(() => !!q("gate-add-dialog"), "the dialog");
    click(must("gate-add-submit"));
    await waitFor(() => text(q("gate-add-dialog")).includes("Give the gate a name."), "the name message");
    setValue(must("gate-form-name"), "X");
    setValue(must("gate-form-username"), "a b");
    await waitFor(() => (must("gate-form-branch") as HTMLSelectElement).value === "1", "the only branch");
    click(must("gate-add-submit"));
    await waitFor(() => text(q("gate-add-dialog")).includes("Username cannot have spaces."), "the username message");
    setValue(must("gate-form-username"), "abc");
    setValue(must("gate-form-password"), "12345");
    click(must("gate-add-submit"));
    await waitFor(() => text(q("gate-add-dialog")).includes("Password must be at least 6"), "the password message");
    expect(world.calls).toEqual([]);
  });

  it("Edit sends only what changed", async () => {
    await open();
    click(must("gate-edit"));
    await waitFor(() => !!q("gate-edit-dialog"), "the dialog");
    setValue(must("gate-form-location"), "Office side");
    setValue(must("gate-form-username"), "front.gate");
    expect(text(must("gate-edit-dialog"))).toContain("A new username signs this gate out everywhere");
    click(must("gate-edit-submit"));
    await waitFor(() => callsTo("PUT", "/api/gate-devices/11").length === 1, "the PUT");
    expect(callsTo("PUT", "/api/gate-devices/11")[0].body).toEqual({ location: "Office side", username: "front.gate" });
    await waitFor(() => text(q("gate-username")) === "front.gate", "the new username");
  });

  it("Reset password sets it and shows it once with Copy", async () => {
    await open();
    click(must("gate-reset"));
    await waitFor(() => !!q("gate-reset-dialog"), "the dialog");
    setValue(must("gate-reset-password"), "fresh-pass-1");
    click(must("gate-reset-submit"));
    await waitFor(() => !!q("gate-new-password"), "the new password");
    expect(callsTo("PUT", "/api/gate-devices/11")[0].body).toEqual({ password: "fresh-pass-1" });
    expect(text(must("gate-new-password"))).toBe("fresh-pass-1");
    click(must("gate-new-password-copy"));
    await waitFor(() => h.clipboard.mock.calls.length === 1, "the copy");
    expect(h.clipboard).toHaveBeenCalledWith("fresh-pass-1");
    click(must("gate-reset-done"));
    await waitFor(() => !q("gate-reset-dialog"), "closed");
    await waitFor(() => text(q("gate-sessions")).includes("Not signed in anywhere"), "signed out");
  });

  it("Suggest fills a readable password", async () => {
    await open();
    click(must("gate-reset"));
    await waitFor(() => !!q("gate-reset-dialog"), "the dialog");
    click(must("gate-reset-password-suggest"));
    const value = (must("gate-reset-password") as HTMLInputElement).value;
    expect(value).toMatch(/^[a-zA-Z2-9]{10}$/);
    expect((must("gate-reset-password") as HTMLInputElement).type).toBe("text");
  });

  it("Sign out everywhere asks, then signs every browser out", async () => {
    await open();
    click(must("gate-signout"));
    await waitFor(() => !!q("gate-signout-confirm"), "the question");
    click(must("gate-signout-confirm-confirm"));
    await waitFor(() => callsTo("POST", "/api/gate-devices/11/sign-out").length === 1, "the sign-out");
    await waitFor(() => text(q("gate-sessions")).includes("Not signed in anywhere"), "no sessions");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Signed out everywhere", description: "1 browser was signed out." }),
    );
  });

  it("switching off asks first; switching on does not", async () => {
    await open();
    click(must("gate-active"));
    await waitFor(() => !!q("gate-switchoff-confirm"), "the question");
    expect(world.calls).toEqual([]);
    click(must("gate-switchoff-confirm-confirm"));
    await waitFor(() => callsTo("PUT", "/api/gate-devices/11").length === 1, "the PUT");
    expect(callsTo("PUT", "/api/gate-devices/11")[0].body).toEqual({ isActive: false });
    await waitFor(() => must("gate-active").getAttribute("aria-checked") === "false", "off");
    click(must("gate-active"));
    await waitFor(() => callsTo("PUT", "/api/gate-devices/11").length === 2, "the second PUT");
    expect(callsTo("PUT", "/api/gate-devices/11")[1].body).toEqual({ isActive: true });
  });

  it("a setting switch saves at once", async () => {
    await open();
    click(must("gate-allow-tea"));
    await waitFor(() => callsTo("PUT", "/api/gate-devices/11").length === 1, "the PUT");
    expect(callsTo("PUT", "/api/gate-devices/11")[0].body).toEqual({ allowTeaBreak: false });
  });

  it("Delete says it cannot be undone and offers switching off instead", async () => {
    await open();
    click(must("gate-delete"));
    await waitFor(() => !!q("gate-delete-confirm"), "the question");
    expect(text(must("gate-delete-confirm"))).toContain("cannot be undone");
    expect(text(must("gate-delete-confirm"))).toContain("switch it off instead");
    click(must("gate-delete-switchoff"));
    await waitFor(() => !!q("gate-switchoff-confirm"), "the softer way");
    expect(world.calls).toEqual([]);
    unmountPage();

    world = installWorld(h.fetch);
    await open();
    click(must("gate-delete"));
    await waitFor(() => !!q("gate-delete-confirm"), "the question");
    click(must("gate-delete-confirm-confirm"));
    await waitFor(() => callsTo("DELETE", "/api/gate-devices/11").length === 1, "the DELETE");
    await waitFor(() => q("gate-card-11") === null, "gone from the list");
  });
});

describe("the records", () => {
  it("every filter reaches the request", async () => {
    await open();
    setValue(must("gate-records-type"), "exit");
    await waitFor(() => lastRecords().get("type") === "exit", "type");
    setValue(must("gate-records-result"), "denied");
    await waitFor(() => lastRecords().get("result") === "denied", "result");
    await waitFor(
      () =>
        text(q("gate-records-table")).includes("Asha Devi") && !text(q("gate-records-table")).includes("Ravi Kumar"),
      "only the denied row",
    );
    click(must("gate-records-dates-today"));
    await waitFor(() => lastRecords().get("from") === "2026-10-14", "today");
    expect(lastRecords().get("to")).toBe("2026-10-14");
    setValue(must("gate-records-search"), "asha");
    await waitFor(() => lastRecords().get("q") === "asha", "the search", 2000);
    expect(lastRecords().get("gateId")).toBe("11");
    expect(here()).toContain("type=exit");
    click(must("gate-records-clear"));
    // back to the first request (answered from the cache): the address has no filter left, the gate stays open
    await waitFor(() => !/type=|result=|q=|range=/.test(here()), "cleared");
    await waitFor(() => text(q("gate-records-table")).includes("Ravi Kumar"), "every row again");
    expect(text(must("gate-name"))).toBe("Main Gate");
  });

  it("All gates lists every gate with a Gate filter", async () => {
    await open();
    expect(q("gate-records-gate")).toBeNull();
    click(must("gate-card-all"));
    await waitFor(() => here() === `${GATES}?gate=all`, "the address");
    await waitFor(() => !lastRecords().has("gateId"), "every gate");
    expect(q("gate-detail")).toBeNull();
    await waitFor(() => text(q("gate-records-table")).includes("Back Gate"), "the Gate column");
    setValue(must("gate-records-gate"), "12");
    await waitFor(() => lastRecords().get("gateId") === "12", "one gate");
  });

  it("a row opens its details", async () => {
    await open();
    const row = document.body.querySelector<HTMLElement>('[data-row-key="scan-2"]')!;
    click(row);
    await waitFor(() => !!q("gate-record-drawer"), "the drawer");
    expect(text(must("gate-record-drawer"))).toContain("This Outpass has expired.");
    expect(text(must("gate-record-drawer"))).toContain("Pass expired");
  });

  it("Export hands the records' filters (and the gate) to the download", async () => {
    await open();
    setValue(must("gate-records-type"), "exit");
    await waitFor(() => lastRecords().get("type") === "exit", "type");
    press(must("gate-records-export"), "Enter");
    await waitFor(() => !!q("gate-records-export-xlsx"), "the menu");
    click(must("gate-records-export-xlsx"));
    await waitFor(() => h.download.mock.calls.length === 1, "the download");
    const sent = h.download.mock.calls[0][0] as { path: string; query: URLSearchParams; format: string; title: string };
    expect(sent.path).toBe("/api/gate-devices/records/export");
    expect(sent.format).toBe("xlsx");
    expect(sent.title).toBe("Gate records - Main Gate");
    expect(Object.fromEntries(sent.query)).toEqual({
      type: "exit",
      from: "2026-10-01",
      to: "2026-10-14",
      gateId: "11",
    });
  });

  it("Export gates downloads the gate list with its filters", async () => {
    await open();
    setValue(must("gate-status-filter"), "active");
    await waitFor(() => world.gets.includes("/api/gate-devices?status=active"), "the list");
    press(must("gate-list-export"), "Enter");
    await waitFor(() => !!q("gate-list-export-pdf"), "the menu");
    click(must("gate-list-export-pdf"));
    await waitFor(() => h.download.mock.calls.length === 1, "the download");
    const sent = h.download.mock.calls[0][0] as { path: string; query: Record<string, string>; format: string };
    expect(sent.path).toBe("/api/gate-devices/export");
    expect(sent.format).toBe("pdf");
    expect(sent.query).toEqual({ q: "", status: "active" });
    await settle(10);
  });
});
