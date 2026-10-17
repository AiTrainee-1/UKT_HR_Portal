import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnsavedGuard, confirmLeaveTab } from "../kit/leaveGuard";
import EndpointSharingTab from "../EndpointSharingTab";
import {
  SECRET_KEY,
  all,
  buttonNamed,
  choose,
  click,
  clickId,
  css,
  here,
  installBrowserStubs,
  installWorld,
  mount,
  must,
  params,
  press,
  q,
  settle,
  text,
  typeAt,
  unmount,
  waitFor,
  type World,
} from "./testing";

// Settings -> Endpoint Sharing in jsdom, with a small copy of the server behind customFetch: the three subtabs, each showing
// only its own section; the endpoint editor with its four nested sections; the one Save with its checks, the confirmation
// for personal and financial fields, the unsaved and stale guards; origins; keys shown once; the preview; the generated
// guide with its language switcher and copy buttons; the general guide; the activity log; and the failure states.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "t", user: h.user.current }) }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

const SUPER = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };
const BASE = "/hr/settings?tab=endpoint_sharing";

let world: World;

beforeAll(installBrowserStubs);
beforeEach(() => {
  vi.clearAllMocks();
  h.user.current = SUPER;
  world = installWorld(h.fetch);
});
afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmount();
  setUnsavedGuard(null);
});

const open = async (url = BASE) => {
  mount(url, EndpointSharingTab);
  await settle();
  // an address that names an endpoint draws the editor (or says why not) once the datasets and the endpoint have come
  if (url.includes("endpoint=")) {
    await waitFor(
      () => q("endpoint-editor") !== null || q("endpoint-load-error") !== null || q("catalog-error") !== null,
      "the editor or its error",
    );
  }
};
const section = (name: "basics" | "data" | "access" | "guide") => clickId(`endpoint-sections-${name}`);
const onlySection = (name: string) => {
  for (const id of ["endpoint-basics", "endpoint-data", "endpoint-access", "endpoint-guide"]) {
    if (id === `endpoint-${name}`) expect(q(id), id).not.toBeNull();
    else expect(q(id), `${id} is not drawn`).toBeNull();
  }
};
const tabs = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="sharing-subtabs"] [role="tab"]')];
const writes = () => world.writes.map((w) => `${w.method} ${w.url}`);
const lastWrite = () => world.writes[world.writes.length - 1];
const openEndpoint = async (id: number, which: "basics" | "data" | "access" | "guide" = "basics") => {
  await open(`${BASE}&sub=endpoints&endpoint=${id}&section=${which}`);
  await waitFor(() => q("endpoint-editor") !== null, "the editor");
};
const saveBar = () => q("save-bar")!;

/**
 * A table that shares its box (no hidden sideways scroll at laptop width) and, below 640 px, turns each row into a small card
 * whose cells are labelled by their column: every cell of every row must name its column.
 */
const expectFitTable = (root: Element | null, minRows = 1) => {
  const region = root?.querySelector('[data-fit="true"]');
  expect(region, "a table that fits its box").not.toBeNull();
  const heads = [...region!.querySelectorAll("th")].map((th) => text(th));
  const rows = [...region!.querySelectorAll("tbody tr")];
  expect(rows.length).toBeGreaterThanOrEqual(minRows);
  for (const row of rows) {
    expect([...row.querySelectorAll("td")].map((td) => td.getAttribute("data-label"))).toEqual(heads);
  }
  expect(region!.querySelector("table")!.className).not.toContain("min-w-max");
};
const saveButton = () => buttonNamed(/^(Save|Create) endpoint$/)!;

describe("who gets the tab", () => {
  it("draws nothing for a login that is not the super admin, and asks the server for nothing", async () => {
    for (const user of [
      { role: "hr", employeeId: null, isSuperAdmin: false, permissions: { settings: "edit" } },
      { role: "hr", employeeId: null, permissions: {} },
      { role: "employee", employeeId: 5 },
      null,
    ]) {
      h.user.current = user;
      await open();
      expect(q("sharing-forbidden")).not.toBeNull();
      expect(text(q("sharing-forbidden"))).toContain("Only the super admin");
      expect(q("endpoint-sharing-tab")).toBeNull();
      expect(world.requests).toEqual([]);
      unmount();
    }
  });
});

describe("the three subtabs: only the open one is drawn", () => {
  it("opens on Endpoints: the list, with what a person wants to know at a glance and the warning that nothing is shared yet", async () => {
    await open();
    await waitFor(() => all("endpoint-card").length === 2, "the list");
    expect(q("endpoint-sharing-tab")?.dataset.sub).toBe("endpoints");
    expect(tabs().map((t) => text(t))).toEqual([
      expect.stringContaining("Endpoints"),
      expect.stringContaining("Integration guide"),
      expect.stringContaining("Activity"),
    ]);
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(q("integration-guide")).toBeNull();
    expect(q("activity-log")).toBeNull();
    expect(text(q("nothing-shared"))).toContain("Nothing is shared until you select fields and create a key");

    const cards = all("endpoint-card");
    expect(cards.map((c) => c.dataset.slug)).toEqual(["hr-departments", "hr-employees"]);
    expect(text(cards[0])).toContain("Departments for the intranet");
    expect(text(cards[0])).toContain("/api/shared/hr-departments");
    expect(text(cards[0])).toContain("On");
    expect(text(cards[0])).toContain("Shares Departments: 2 fields");
    expect(text(cards[0])).toContain("Live keys: 1");
    expect(text(cards[0])).toContain("Websites: 1");
    expect(text(cards[0])).toContain("Calls in 24 hours: 12");
    // an endpoint with no key says it shares nothing, and one that is off says so
    expect(text(cards[1])).toContain("Switched off");
    expect(text(cards[1])).toContain("No live key, so nothing can be read.");
    // reading the list does not ask for the catalogue or anything else
    expect(world.requests).toEqual(["GET /api/shared-endpoints", "GET /api/shared-endpoints/catalog"]);
  });

  it("lists what each part of the tab controls in a 'What changes' list in its first card", async () => {
    await open();
    await waitFor(() => all("endpoint-card").length === 2, "the list");
    const list = q("setting-affects");
    expect(list).not.toBeNull();
    expect(q("endpoints-list")?.contains(list)).toBe(true); // in the first card of the tab
    expect(text(list)).toContain("What changes");
    const items = [...list!.querySelectorAll("li")].map((li) => text(li));
    for (const part of ["Endpoints", "Fields", "Websites (origins)", "API keys", "Activity", "Audit log"]) {
      expect(
        items.some((i) => i.startsWith(part)),
        part,
      ).toBe(true);
    }
  });

  it("shows an empty list in words, and an error with a retry", async () => {
    world.endpoints = {};
    await open();
    // the list is read by a query: wait for what the query produced (one settle() is not enough on a busy machine)
    await waitFor(() => q("endpoints-empty") !== null, "the empty list");
    expect(text(q("endpoints-empty"))).toContain("No endpoint yet");
    unmount();

    world.failing.set("/api/shared-endpoints", { status: 500 });
    await open();
    await waitFor(() => q("endpoints-error") !== null, "the error");
    world.failing.clear();
    await click(buttonNamed("Try again"));
    await waitFor(() => q("endpoints-empty") !== null, "the list after the retry");
  });

  it("opens the Integration guide on its own address, and goes back", async () => {
    await open();
    await click(tabs()[1]);
    expect(params()).toMatchObject({ tab: "endpoint_sharing", sub: "guide" });
    expect(q("endpoint-sharing-tab")?.dataset.sub).toBe("guide");
    expect(q("integration-guide")).not.toBeNull();
    expect(q("endpoints-list")).toBeNull();
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    await click(tabs()[0]);
    expect(params().sub).toBe("endpoints");
    expect(q("endpoints-list")).not.toBeNull();
    expect(q("integration-guide")).toBeNull();
  });

  it("follows an address that names a subtab, and an unknown one falls back to Endpoints", async () => {
    await open(`${BASE}&sub=activity`);
    expect(q("activity-log")).not.toBeNull();
    expect(q("endpoints-list")).toBeNull();
    unmount();
    await open(`${BASE}&sub=nonsense`);
    expect(q("endpoints-list")).not.toBeNull();
  });
});

describe("the endpoint editor: four nested sections, one at a time", () => {
  it("opens an endpoint on Basics, and each nested subtab draws only its own section with its own address", async () => {
    await open();
    await waitFor(() => all("endpoint-card").length === 2, "the list");
    await click(css('[aria-label="Open Departments for the intranet"]'));
    await waitFor(() => q("endpoint-editor") !== null, "the editor");
    expect(params()).toMatchObject({ sub: "endpoints", endpoint: "3", section: "basics" });
    expect(text(q("editor-title"))).toBe("Departments for the intranet");
    expect(text(q("editor-address"))).toContain("/api/shared/hr-departments");
    expect(q("endpoint-sections")?.getAttribute("role")).toBe("tablist");
    expect(
      [...document.body.querySelectorAll('[data-testid="endpoint-sections-strip"] [role="tab"]')].map(text),
    ).toEqual(["Basics", "Data", "Access", "Guide"]);
    onlySection("basics");
    // the list is not drawn while an endpoint is open
    expect(q("endpoints-list")).toBeNull();

    for (const name of ["data", "access", "guide", "basics"] as const) {
      await section(name);
      await waitFor(() => q(`endpoint-${name}`) !== null, `${name} section`);
      expect(params().section).toBe(name);
      onlySection(name);
      expect(q(`endpoint-sections-${name}`)?.getAttribute("aria-selected")).toBe("true");
    }
    // a section that is not open asks the server for nothing: the guide was drawn once, access once
    expect(world.requests.filter((r) => r.endsWith("/guide"))).toHaveLength(1);
  });

  it("moves between the nested subtabs with the arrow keys, Home and End", async () => {
    await openEndpoint(3);
    const basics = must("endpoint-sections-basics");
    basics.focus();
    await press(basics, "ArrowRight");
    expect(params().section).toBe("data");
    await press(must("endpoint-sections-data"), "End");
    expect(params().section).toBe("guide");
    await press(must("endpoint-sections-guide"), "Home");
    expect(params().section).toBe("basics");
    await press(must("endpoint-sections-basics"), "ArrowLeft");
    expect(params().section).toBe("guide");
  });

  it("says whether the endpoint shares anything: live with fields and a key, or nothing yet", async () => {
    await openEndpoint(3);
    expect(q("sharing-state")?.dataset.tone).toBe("good");
    expect(text(q("sharing-state"))).toContain("2 fields can be read with 1 live key");
    unmount();
    await openEndpoint(4);
    expect(q("sharing-state")?.dataset.tone).toBe("warn");
    expect(text(q("sharing-state"))).toContain("Nothing is shared until you select fields and create a key");
  });

  it("shows a missing endpoint, a catalogue that cannot be read and a failed load in words", async () => {
    world.failing.set("/api/shared-endpoints/99", { status: 404 });
    await open(`${BASE}&endpoint=99`);
    await waitFor(() => q("endpoint-load-error") !== null, "the missing endpoint");
    expect(text(q("endpoint-load-error"))).toContain("no longer exists");
    unmount();

    world.failing.clear();
    world.failing.set("/api/shared-endpoints/catalog", { status: 404 });
    await open(`${BASE}&endpoint=3`);
    await waitFor(() => q("catalog-error") !== null, "the catalogue error");
    expect(text(q("catalog-error"))).toContain("could not be loaded");
    expect(q("endpoint-editor")).toBeNull();
    unmount();

    world.failing.set("/api/shared-endpoints/catalog", {
      status: 403,
      body: { error: "Sign in as the head-office super administrator." },
    });
    await open(`${BASE}&endpoint=3`);
    await waitFor(() => q("catalog-error") !== null, "the refusal");
    expect(text(q("catalog-error"))).toContain("head-office super administrator");
  });
});

describe("Basics", () => {
  it("shows the saved name, an address that cannot change and the full URL with a copy button", async () => {
    await openEndpoint(3);
    expect((css("#es-name") as HTMLInputElement).value).toBe("Departments for the intranet");
    const slug = css("#es-slug") as HTMLInputElement;
    expect(slug.value).toBe("hr-departments");
    expect(slug.readOnly).toBe(true);
    expect(text(q("endpoint-url"))).toContain("/api/shared/hr-departments");
    expect(q("endpoint-url-copy")).not.toBeNull();
    expect(text(q("setting-basics-address"))).toContain("can never be changed");
    expect(saveBar().dataset.dirty).toBe("false");
    expect(saveButton().disabled).toBe(true);
  });

  it("makes the address from the name while creating, until the address is typed by hand", async () => {
    await open(`${BASE}&endpoint=new`);
    expect(text(q("editor-title"))).toBe("New endpoint");
    expect((css("#es-slug") as HTMLInputElement).readOnly).toBe(false);
    await typeAt("#es-name", "Monthly Payroll Summary!");
    expect((css("#es-slug") as HTMLInputElement).value).toBe("monthly-payroll-summary");
    await typeAt("#es-slug", "my-own-address");
    await typeAt("#es-name", "Something else");
    expect((css("#es-slug") as HTMLInputElement).value).toBe("my-own-address");
    expect(text(q("endpoint-url"))).toContain("/api/shared/my-own-address");
  });

  it("asks before switching an endpoint off, and keeps it on when the question is declined", async () => {
    await openEndpoint(3);
    expect(css("#es-enabled")?.getAttribute("aria-checked")).toBe("true");
    await click(css("#es-enabled"));
    expect(q("confirm-switch-off")).not.toBeNull();
    expect(text(q("confirm-switch-off"))).toContain("answered as");
    await click(buttonNamed("Keep it on"));
    await settle();
    expect(css("#es-enabled")?.getAttribute("aria-checked")).toBe("true");
    expect(saveBar().dataset.dirty).toBe("false");

    await click(css("#es-enabled"));
    await clickId("confirm-switch-off-yes");
    await settle();
    expect(css("#es-enabled")?.getAttribute("aria-checked")).toBe("false");
    expect(saveBar().dataset.dirty).toBe("true");
    await click(saveButton());
    await waitFor(() => writes().includes("PUT /api/shared-endpoints/3"), "the save");
    expect(lastWrite().body).toMatchObject({ enabled: false, expectedVersion: "ver1" });
    expect(world.endpoints[3].enabled).toBe(false);
  });

  it("switching on needs no question", async () => {
    await openEndpoint(4);
    expect(css("#es-enabled")?.getAttribute("aria-checked")).toBe("false");
    await click(css("#es-enabled"));
    expect(q("confirm-switch-off")).toBeNull();
    expect(css("#es-enabled")?.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Data", () => {
  it("shows the dataset as fixed, the fields grouped by sensitivity, what is never shared and the locked filters", async () => {
    await openEndpoint(4, "data");
    const dataset = css("#es-dataset") as HTMLSelectElement;
    expect(dataset.value).toBe("employees");
    expect(dataset.disabled).toBe(true);
    expect(text(q("setting-data-dataset"))).toContain("cannot be changed");
    expect(text(q("dataset-description"))).toContain("employee master list");

    // three groups, each explained, and the ticks as saved
    expect(all("field-group-basic")).toHaveLength(1);
    expect(text(q("field-group-personal"))).toContain("Phone");
    expect(text(q("field-group-financial"))).toContain("Salary amount");
    expect(text(q("field-group-financial"))).toContain("most sensitive");
    expect((q("field-employeeCode") as HTMLInputElement).checked).toBe(true);
    expect((q("field-phone") as HTMLInputElement).checked).toBe(true);
    expect((q("field-email") as HTMLInputElement).checked).toBe(false);
    expect(text(q("field-count"))).toBe("2 of 6 fields ticked");

    // the hard-excluded list, from the server
    expect(text(q("hard-excluded"))).toContain("Never shared, from any dataset");
    expect(text(q("hard-excluded"))).toContain("Aadhaar and PAN numbers");
    expect(text(q("hard-excluded"))).toContain("PF, ESI and UAN numbers");

    // the status filter is locked to "active": the caller cannot change it
    expect((css("#es-lock-status") as HTMLInputElement).checked).toBe(true);
    expect((css("#es-lockvalue-status") as HTMLSelectElement).value).toBe("active");
    expect(text(q("filter-status"))).toContain("Locked: the caller cannot change it");
    expect((css("#es-lock-departmentId") as HTMLInputElement).checked).toBe(false);
  });

  it("ticks and clears a whole group, and counts the ticks", async () => {
    await openEndpoint(4, "data");
    await click(css('[aria-label="Tick all basic fields"]'));
    expect(text(q("field-count"))).toBe("4 of 6 fields ticked");
    await click(css('[aria-label="Clear all basic fields"]'));
    expect(text(q("field-count"))).toBe("1 of 6 fields ticked");
    await click(q("field-phone"));
    expect(text(q("field-count"))).toBe("0 of 6 fields ticked - nothing is shared yet");
    expect(text(q("endpoint-save-error") ?? document.body)).not.toContain("undefined");
    expect(saveButton().disabled).toBe(true);
    expect(text(saveBar())).toContain("Tick at least one field");
  });

  it("locks and unlocks filters, and a locked filter needs a value of the right kind", async () => {
    await openEndpoint(4, "data");
    await click(css("#es-lock-departmentId"));
    expect((css("#es-lockvalue-departmentId") as HTMLInputElement).value).toBe("");
    expect(saveButton().disabled).toBe(true);
    expect(text(saveBar())).toContain("Type a value for Department id");
    await typeAt("#es-lockvalue-departmentId", "1.5");
    expect(text(q("filter-error-departmentId"))).toContain("whole number");
    expect(saveButton().disabled).toBe(true);
    await typeAt("#es-lockvalue-departmentId", "7");
    expect(q("filter-error-departmentId")).toBeNull();
    expect(saveButton().disabled).toBe(false);
    await click(css("#es-lock-status"));
    expect(css("#es-lockvalue-status")).toBeNull();
    await click(saveButton());
    await waitFor(() => writes().includes("PUT /api/shared-endpoints/4"), "the save");
    expect(lastWrite().body.lockedFilters).toEqual({ departmentId: "7" });
    expect(world.endpoints[4].lockedFilters).toEqual({ departmentId: "7" });
  });

  it("warns on the employees dataset that every matching employee is shared, and locks the external-apps filter as yes", async () => {
    await openEndpoint(4, "data");
    const note = q("employees-external-note");
    expect(text(note)).toBe(
      'Every employee that matches your filters is shared, including those not marked as visible to external applications; lock the filter "Visible to external apps = yes" to share only those.',
    );
    // the control is a Yes / No list that sends the words true / false (the contract of the API)
    await click(css("#es-lock-visibleToExternal"));
    const box = css("#es-lockvalue-visibleToExternal") as HTMLSelectElement;
    expect(box.tagName).toBe("SELECT");
    expect(box.value).toBe("true"); // a new lock starts at yes: locking "no" would change nothing
    expect([...box.options].map((o) => [o.value, o.textContent])).toEqual([
      ["true", "Yes"],
      ["false", "No"],
    ]);
    expect(text(q("employees-external-note"))).toBe(
      "Only employees marked as visible to external applications are shared (the filter is locked to yes).",
    );
    await choose("#es-lockvalue-visibleToExternal", "false");
    expect(text(q("employees-external-note"))).toContain("Every employee that matches your filters is shared");
    await choose("#es-lockvalue-visibleToExternal", "true");
    await click(saveButton());
    await waitFor(() => writes().includes("PUT /api/shared-endpoints/4"), "the save");
    expect(lastWrite().body.lockedFilters).toEqual({ status: "active", visibleToExternal: "true" });
  });

  it("shows no external-apps note on a dataset that has no such filter", async () => {
    await openEndpoint(3, "data");
    expect(q("employees-external-note")).toBeNull();
  });

  it("says a dataset with no filters has nothing to lock", async () => {
    await openEndpoint(3, "data");
    expect(text(q("setting-data-filters"))).toContain("no filters, so there is nothing to lock");
  });

  it("shows the first rows of the saved endpoint, and says so when the form has unsaved changes", async () => {
    await openEndpoint(3, "data");
    expect(q("preview-saved-note")).toBeNull();
    await clickId("preview-run");
    await waitFor(() => q("preview-result") !== null, "the preview rows");
    expect(world.previews).toEqual([{ limit: 5 }]);
    const heads = [...document.body.querySelectorAll('[data-testid="preview-result"] th')].map(text);
    expect(heads).toEqual(["id", "name"]);
    expect(all("preview-row").map(text)).toEqual(["4Stitching", "5Cutting"]);
    expect(text(q("preview-result"))).toContain("Only the saved fields are in each row");
    // an edit makes the page say the preview is of what is saved
    await click(q("field-branch"));
    expect(q("preview-saved-note")).not.toBeNull();
  });

  it("sends the filters of the preview that nobody locked", async () => {
    await openEndpoint(4, "data");
    // status is locked, so only the department box is offered
    expect(css("#es-preview-status")).toBeNull();
    await typeAt("#es-preview-departmentId", "12");
    await clickId("preview-run");
    await waitFor(() => world.previews.length === 1, "the preview request");
    expect(world.previews[0]).toEqual({ limit: 5, filters: { departmentId: "12" } });
  });

  it("asks to save first when the endpoint is new, and shows a preview error in words", async () => {
    await open(`${BASE}&endpoint=new&section=data`);
    expect(q("preview-needs-save")).not.toBeNull();
    expect(q("preview-run")).toBeNull();
    expect(text(q("choose-dataset-first"))).toContain("Choose a dataset");
    unmount();
    world.failing.set("/api/shared-endpoints/3/preview", { status: 400, body: { error: "dateFrom is needed." } });
    await openEndpoint(3, "data");
    await clickId("preview-run");
    await waitFor(() => q("preview-error") !== null, "the preview error");
    expect(text(q("preview-error"))).toBe("dateFrom is needed.");
  });
});

describe("creating an endpoint: one Save, all or nothing", () => {
  it("checks each box, lists what is wrong first, and enables Create only for a complete form", async () => {
    await open(`${BASE}&endpoint=new`);
    expect(saveButton().textContent).toContain("Create endpoint");
    expect(saveButton().disabled).toBe(true);
    expect(text(saveBar())).toContain("Fix this first: Give the endpoint a name");
    await typeAt("#es-name", "Departments");
    // the address follows the name; typing a bad one by hand is caught
    await typeAt("#es-slug", "ab");
    expect(text(saveBar())).toContain("Fix this first: The address needs 3 to 60 characters");
    await typeAt("#es-slug", "departments");
    expect(text(saveBar())).toContain("Fix this first: Choose which data this endpoint shares.");
    await section("data");
    await choose("#es-dataset", "departments");
    expect(text(saveBar())).toContain("Tick at least one field");
    await click(q("field-name"));
    await click(q("field-id"));
    expect(saveButton().disabled).toBe(false);
    expect(text(q("setting-data-fields"))).toContain("Personal and financial fields ask for a confirmation");
  });

  it("creates a basic-only endpoint without a question, then opens it on Access to make a key", async () => {
    await open(`${BASE}&endpoint=new`);
    await typeAt("#es-name", "Departments feed");
    await section("data");
    await choose("#es-dataset", "departments");
    await click(q("field-name"));
    await click(q("field-id"));
    await click(saveButton());
    expect(q("confirm-sensitive")).toBeNull();
    await waitFor(() => params().endpoint === "5", "the new endpoint opens");
    expect(params()).toMatchObject({ sub: "endpoints", endpoint: "5", section: "access" });
    expect(lastWrite()).toMatchObject({ method: "POST", url: "/api/shared-endpoints" });
    expect(lastWrite().body).toEqual({
      slug: "departments-feed",
      dataset: "departments",
      name: "Departments feed",
      description: "",
      fields: ["id", "name"],
      lockedFilters: {},
      origins: [],
      allowNoOrigin: true,
      pageSizeDefault: 50,
      pageSizeMax: 200,
      rateLimitPerMinute: 60,
      enabled: true,
    });
    await waitFor(() => q("keys-panel") !== null, "the keys box of the new endpoint");
    expect(q("keys-needs-save")).toBeNull();
    await waitFor(() => q("keys-empty") !== null, "the empty key list");
    expect(text(q("keys-empty"))).toContain("No key yet");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Endpoint created" }));
  });

  it("changing the dataset starts again with no fields and no locks", async () => {
    await open(`${BASE}&endpoint=new&section=data`);
    await choose("#es-dataset", "employees");
    await click(q("field-employeeCode"));
    await click(css("#es-lock-status"));
    expect(text(q("field-count"))).toBe("1 of 6 fields ticked");
    await choose("#es-dataset", "payroll-summary");
    expect(text(q("field-count"))).toBe("0 of 2 fields ticked - nothing is shared yet");
    expect(q("filter-status")).toBeNull();
    expect(text(q("filter-month"))).toContain("The caller must send it");
  });
});

describe("personal and financial fields need a confirmation", () => {
  const startEmployees = async () => {
    await open(`${BASE}&endpoint=new`);
    await typeAt("#es-name", "People");
    await section("data");
    await choose("#es-dataset", "employees");
    await click(q("field-employeeCode"));
  };

  it("names the fields in a box, needs the tick, and only then sends acknowledgeSensitive", async () => {
    await startEmployees();
    await click(q("field-phone"));
    await click(q("field-salaryAmount"));
    expect(text(q("new-sensitive-notice"))).toContain("Phone, Salary amount");
    await click(saveButton());
    const dialog = q("confirm-sensitive")!;
    expect(dialog).not.toBeNull();
    expect(text(dialog)).toContain("Share personal or financial data?");
    expect(all("confirm-sensitive-fields").map(text)[0]).toContain("Phone");
    expect(all("confirm-sensitive-fields").map(text)[0]).toContain("Personal");
    expect(all("confirm-sensitive-fields").map(text)[0]).toContain("Salary amount");
    expect(all("confirm-sensitive-fields").map(text)[0]).toContain("Financial");
    // basic fields are not in the list
    expect(all("confirm-sensitive-fields").map(text)[0]).not.toContain("Employee code");
    // nothing has been sent, and the button is dead until the box is ticked
    expect(world.writes).toEqual([]);
    expect((q("confirm-sensitive-yes") as HTMLButtonElement).disabled).toBe(true);
    await click(css("#es-understood"));
    expect((q("confirm-sensitive-yes") as HTMLButtonElement).disabled).toBe(false);
    await clickId("confirm-sensitive-yes");
    await waitFor(() => writes().includes("POST /api/shared-endpoints"), "the create");
    expect(lastWrite().body).toMatchObject({
      fields: ["employeeCode", "phone", "salaryAmount"],
      acknowledgeSensitive: true,
    });
  });

  it("goes back without saving when the box is declined", async () => {
    await startEmployees();
    await click(q("field-email"));
    await click(saveButton());
    expect(q("confirm-sensitive")).not.toBeNull();
    await click(buttonNamed("Go back"));
    await settle();
    expect(q("confirm-sensitive")).toBeNull();
    expect(world.writes).toEqual([]);
    expect(params().endpoint).toBe("new");
  });

  it("asks again for a field that is added to a saved endpoint, but not for what it already shares", async () => {
    await openEndpoint(4, "data");
    // phone is already shared: ticking nothing new sensitive saves without a question
    await click(q("field-firstName"));
    await click(saveButton());
    expect(q("confirm-sensitive")).toBeNull();
    await waitFor(() => writes().includes("PUT /api/shared-endpoints/4"), "the first save");
    expect(lastWrite().body).not.toHaveProperty("acknowledgeSensitive");

    // e-mail is new: the box lists only e-mail
    await click(q("field-email"));
    expect(text(q("new-sensitive-notice"))).toContain("Email");
    expect(text(q("new-sensitive-notice"))).not.toContain("Phone");
    await click(saveButton());
    expect(q("confirm-sensitive")).not.toBeNull();
    expect(text(q("confirm-sensitive-fields"))).toContain("Email");
    expect(text(q("confirm-sensitive-fields"))).not.toContain("Phone");
    expect(text(q("confirm-sensitive"))).toContain("Save and share these fields");
    await click(css("#es-understood"));
    await clickId("confirm-sensitive-yes");
    await waitFor(() => writes().filter((w) => w.startsWith("PUT")).length === 2, "the second save");
    expect(lastWrite().body).toMatchObject({ acknowledgeSensitive: true, expectedVersion: "ver2" });
    // the dataset's own order, whatever order they were ticked in
    expect(world.endpoints[4].fields).toEqual(["employeeCode", "firstName", "phone", "email"]);
  });
});

describe("Access: allowed websites", () => {
  it("lists the saved websites and explains honestly what they do and do not protect", async () => {
    await openEndpoint(3, "access");
    expect(all("origin-row").map((r) => r.dataset.origin)).toEqual(["https://intranet.example.com"]);
    expect(text(q("origins-count"))).toBe("1 of 20 websites");
    expect(text(q("origins-honesty"))).toContain("Origins protect browsers. They are not a password.");
    expect(text(q("origins-honesty"))).toContain("never put a key in a web page");
    expect(text(q("origins-honesty"))).toContain("let your own server make the call instead");
    expect(text(q("origin-examples"))).toContain("https://*.example.com");
    expect(text(q("origin-examples"))).toContain("Not allowed");
  });

  const invalid: [string, RegExp][] = [
    ["https://*.example.com", /star/i],
    ["*", /star/i],
    ["http://intranet.example.com", /localhost/],
    ["https://intranet.example.com/reports", /path/],
    ["intranet.example.com", /http:\/\//],
    ["https://intranet.example.com:99999", /port/],
  ];
  it.each(invalid)("refuses %s with a plain sentence, and keeps nothing", async (value, message) => {
    await openEndpoint(3, "access");
    await typeAt("#es-origin-add", value);
    await clickId("origin-add");
    expect(text(q("origin-error"))).toMatch(message);
    expect(all("origin-row")).toHaveLength(1);
    expect(saveBar().dataset.dirty).toBe("false");
  });

  it("adds valid ones in their saved form, collapses a duplicate, edits and removes", async () => {
    await openEndpoint(3, "access");
    await typeAt("#es-origin-add", "  HTTPS://Reports.Example.com:8443/ ");
    await clickId("origin-add");
    expect(all("origin-row").map((r) => r.dataset.origin)).toEqual([
      "https://intranet.example.com",
      "https://reports.example.com:8443",
    ]);
    expect((css("#es-origin-add") as HTMLInputElement).value).toBe("");
    expect(saveBar().dataset.dirty).toBe("true");

    // the same website again is not added twice
    await typeAt("#es-origin-add", "https://intranet.example.com");
    await clickId("origin-add");
    expect(all("origin-row")).toHaveLength(2);
    expect(text(q("origin-note"))).toContain("already in the list");

    // Enter adds
    await typeAt("#es-origin-add", "http://localhost:5173");
    await press(css("#es-origin-add")!, "Enter");
    expect(all("origin-row")).toHaveLength(3);

    // change one: a bad value is refused in place, a good one replaces it
    await click(css('[aria-label="Change https://reports.example.com:8443"]'));
    await typeAt("#es-origin-edit", "https://reports.example.com/x");
    await click(css('[aria-label="Keep this change"]'));
    expect(text(q("origin-edit-error"))).toMatch(/path/);
    await typeAt("#es-origin-edit", "https://reports.example.org");
    await click(css('[aria-label="Keep this change"]'));
    expect(all("origin-row").map((r) => r.dataset.origin)).toContain("https://reports.example.org");
    expect(all("origin-row").map((r) => r.dataset.origin)).not.toContain("https://reports.example.com:8443");

    // remove one
    await click(css('[aria-label="Remove http://localhost:5173"]'));
    expect(all("origin-row").map((r) => r.dataset.origin)).toEqual([
      "https://intranet.example.com",
      "https://reports.example.org",
    ]);

    await click(saveButton());
    await waitFor(() => writes().includes("PUT /api/shared-endpoints/3"), "the save");
    expect(lastWrite().body.origins).toEqual(["https://intranet.example.com", "https://reports.example.org"]);
  });

  it("stops at twenty websites, and removing the last one says that browsers are refused", async () => {
    world.endpoints[3].origins = Array.from({ length: 20 }, (_, i) => `https://s${i}.example.com`);
    await openEndpoint(3, "access");
    expect(text(q("origins-count"))).toBe("20 of 20 websites");
    await typeAt("#es-origin-add", "https://one-more.example.com");
    await clickId("origin-add");
    expect(text(q("origin-error"))).toContain("20 allowed websites at most");
    unmount();

    world.endpoints[3].origins = ["https://a.example.com"];
    await openEndpoint(3, "access");
    await click(css('[aria-label="Remove https://a.example.com"]'));
    expect(text(q("origins-empty"))).toContain("browsers on every website are refused");
  });

  it("switches server-to-server calls, and checks the rate limit and the page sizes", async () => {
    await openEndpoint(3, "access");
    expect(css("#es-no-origin")?.getAttribute("aria-checked")).toBe("true");
    await click(css("#es-no-origin"));
    expect(css("#es-no-origin")?.getAttribute("aria-checked")).toBe("false");
    expect(text(q("setting-access-server-to-server"))).toContain("Prefer server-to-server calls");

    await typeAt("#es-rate", "0");
    expect(text(css("#es-rate")!.closest("div.space-y-1\\.5")!)).toContain("1 to 6000");
    expect(saveButton().disabled).toBe(true);
    expect(text(saveBar())).toContain("Fix this first: The limit is a whole number of calls a minute");
    await typeAt("#es-rate", "120");
    await typeAt("#es-page-default", "300");
    expect(saveButton().disabled).toBe(true);
    expect(text(saveBar())).toContain("cannot be bigger than the largest page");
    await typeAt("#es-page-default", "25");
    await typeAt("#es-page-max", "501");
    expect(text(saveBar())).toContain("1 to 500");
    await typeAt("#es-page-max", "100");
    expect(saveButton().disabled).toBe(false);
    await click(saveButton());
    await waitFor(() => writes().includes("PUT /api/shared-endpoints/3"), "the save");
    expect(lastWrite().body).toMatchObject({
      allowNoOrigin: false,
      rateLimitPerMinute: 120,
      pageSizeDefault: 25,
      pageSizeMax: 100,
    });
  });
});

describe("Access: API keys", () => {
  it("lists the keys with their start, dates and status, and never a whole key or a hash", async () => {
    await openEndpoint(3, "access");
    await waitFor(() => q("keys-table") !== null, "the keys");
    const row = q("key-row")!;
    expect(text(row)).toContain("Intranet server");
    expect(text(row)).toContain("uks_abcd1234...");
    expect(text(row)).toContain("Active");
    expect(text(row)).toContain("Never"); // expiry
    expect(text(q("keys-table"))).not.toContain(SECRET_KEY);
    expect(text(q("keys-immediate"))).toContain("do not wait for Save");
    expect(text(q("keys-panel"))).toContain("1 of 10 live keys");
  });

  it("lays each key out as a card: name, status and Revoke first, dates under them, and no sideways scroll to reach them", async () => {
    await openEndpoint(3, "access");
    await waitFor(() => q("keys-table") !== null, "the keys");
    const list = q("keys-table")!;
    expect(list.tagName).toBe("UL");
    expect(list.querySelector("table")).toBeNull();
    expect(list.closest('[class*="overflow-x"]')).toBeNull(); // nothing around the keys scrolls sideways
    const row = q("key-row")!;
    const label = row.querySelector('[data-testid="key-label"]')!;
    const revoke = row.querySelector('[data-testid="key-revoke"]')!;
    const details = row.querySelector("dl")!;
    expect(text(label)).toBe("Intranet server");
    expect(revoke.getAttribute("aria-label")).toBe("Revoke Intranet server");
    // reading order: the name, then Revoke, then the dates (the button is never behind the dates)
    expect(label.compareDocumentPosition(revoke) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(revoke.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...details.querySelectorAll("dt")].map((dt) => text(dt))).toEqual(["Created", "Last used", "Expires"]);
    // the row wraps (so it fits 390 px), and the dates sit in a grid that collapses to one column on a phone
    expect(row.querySelector("div")!.className).toContain("flex-wrap");
    expect(details.className).toContain("sm:grid-cols-3");
    expect(row.textContent).not.toContain("uks_abcd1234_");
  });

  it("keeps a revoked key's row without a Revoke button", async () => {
    await openEndpoint(3, "access");
    await waitFor(() => q("keys-table") !== null, "the keys");
    await click(css('[aria-label="Revoke Intranet server"]'));
    await click(q("confirm-revoke-yes"));
    await waitFor(() => q("key-row")?.dataset.status === "revoked", "the revoked row");
    expect(q("key-row")!.querySelector('[data-testid="key-revoke"]')).toBeNull();
    expect(text(q("key-row"))).toContain("Revoked");
  });

  it("makes a key: the whole key is shown ONCE with a warning, then never again", async () => {
    await openEndpoint(3, "access");
    await waitFor(() => q("keys-table") !== null, "the keys");
    // a label is needed
    await clickId("key-create");
    expect(text(q("key-error"))).toContain("Give the key a label");
    expect(world.writes).toEqual([]);

    await typeAt("#es-key-label", "Payroll tool");
    await clickId("key-create");
    await waitFor(() => q("key-reveal") !== null, "the key box");
    expect(lastWrite()).toMatchObject({
      method: "POST",
      url: "/api/shared-endpoints/3/keys",
      body: { label: "Payroll tool", expiresAt: null },
    });
    const box = q("key-reveal")!;
    expect(text(box)).toContain("copy it now, it is never shown again");
    expect(text(box)).toContain("Never put it in a web page");
    expect(text(q("key-secret")?.querySelector("pre"))).toBe(SECRET_KEY);
    expect(q("key-secret-copy")).not.toBeNull();
    // the list got the new key (its start only), the label box is empty
    await waitFor(() => all("key-row").length === 2, "the new key in the list");
    expect(text(all("key-row")[0])).toContain("Payroll tool");
    expect(text(all("key-row")[0])).toContain("uks_wxyz9876...");
    expect((css("#es-key-label") as HTMLInputElement).value).toBe("");

    // "I have copied it" hides it for good
    await clickId("key-hide");
    expect(q("key-reveal")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET_KEY);
    // the list does not give it back, not after a reload of the list either
    expect(h.fetch.mock.results.length).toBeGreaterThan(0);
    await section("basics");
    await section("access");
    await waitFor(() => q("keys-table") !== null, "the keys again");
    expect(document.body.textContent).not.toContain(SECRET_KEY);
    expect(q("key-reveal")).toBeNull();
  });

  it("drops the secret when the person leaves the section without hiding it", async () => {
    await openEndpoint(3, "access");
    await typeAt("#es-key-label", "Temp");
    await clickId("key-create");
    await waitFor(() => q("key-reveal") !== null, "the key box");
    await section("guide");
    await section("access");
    await waitFor(() => q("keys-panel") !== null, "the keys box");
    expect(q("key-reveal")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET_KEY);
  });

  it("checks an expiry, sends a date, and stops at ten live keys", async () => {
    await openEndpoint(3, "access");
    await waitFor(() => q("keys-table") !== null, "the keys");
    await typeAt("#es-key-label", "Short lived");
    await typeAt("#es-key-expires", "2020-01-01");
    await clickId("key-create");
    expect(text(q("key-error"))).toContain("after today");
    expect(world.writes).toEqual([]);
    await typeAt("#es-key-expires", "2027-03-31");
    await clickId("key-create");
    await waitFor(() => q("key-reveal") !== null, "the key box");
    expect(lastWrite().body).toEqual({ label: "Short lived", expiresAt: "2027-03-31" });
    unmount();

    world.keys[3] = Array.from({ length: 10 }, (_, i) => ({ ...world.keys[3][0], id: 100 + i, label: `K${i}` }));
    await openEndpoint(3, "access");
    await waitFor(() => q("keys-table") !== null, "the keys");
    expect((q("key-create") as HTMLButtonElement).disabled).toBe(true);
    expect(text(q("keys-panel"))).toContain("10 of 10 live keys. Revoke one before making another.");
  });

  it("revokes a key only after the question, and the key shows as revoked", async () => {
    await openEndpoint(3, "access");
    await waitFor(() => q("keys-table") !== null, "the keys");
    await click(css('[aria-label="Revoke Intranet server"]'));
    const dialog = q("confirm-revoke")!;
    expect(text(dialog)).toContain('Revoke the key "Intranet server"?');
    expect(text(dialog)).toContain("stops working at once");
    expect(text(dialog)).toContain("can not be undone");
    expect(world.writes).toEqual([]);
    // declining changes nothing
    await click(buttonNamed("Keep the key"));
    await settle();
    expect(world.writes).toEqual([]);
    expect(q("key-row")?.dataset.status).toBe("active");

    await click(css('[aria-label="Revoke Intranet server"]'));
    await clickId("confirm-revoke-yes");
    await waitFor(() => writes().includes("DELETE /api/shared-endpoints/3/keys/11"), "the revoke");
    await waitFor(() => q("key-row")?.dataset.status === "revoked", "the revoked row");
    expect(text(q("key-row"))).toContain("Revoked");
    // a revoked key has no button any more
    expect(css('[aria-label="Revoke Intranet server"]')).toBeNull();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Key revoked" }));
  });

  it("asks to save a new endpoint before keys can be made, and shows a failed list with a retry", async () => {
    await open(`${BASE}&endpoint=new&section=access`);
    expect(q("keys-needs-save")).not.toBeNull();
    expect(q("key-create")).toBeNull();
    unmount();
    world.failing.set("/api/shared-endpoints/3/keys", { status: 500 });
    await openEndpoint(3, "access");
    await waitFor(() => q("keys-error") !== null, "the keys error");
    world.failing.clear();
    await click(buttonNamed("Try again"));
    await waitFor(() => q("keys-table") !== null, "the keys after the retry");
  });

  it("shows a refused key creation in words", async () => {
    world.failing.set("/api/shared-endpoints/3/keys", {
      status: 400,
      body: { error: "An endpoint can have at most 10 live keys." },
    });
    await openEndpoint(3, "access");
    await typeAt("#es-key-label", "One");
    await act(async () => {
      must("key-create").click();
    });
    await settle();
    // the list read fails too (same path), but the create answer is what the person is told
    expect(text(q("key-error"))).toContain("at most 10 live keys");
    expect(q("key-reveal")).toBeNull();
  });
});

describe("unsaved changes and stale copies", () => {
  it("asks before the Back button, a subtab or the Settings page leaves an edited form", async () => {
    await openEndpoint(3);
    await typeAt("#es-name", "Renamed");
    expect(saveBar().dataset.dirty).toBe("true");

    // the Settings page asks through the leave guard
    expect(confirmLeaveTab(() => false)).toBe(false);
    // the browser asks before the tab closes
    const closing = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(closing);
    expect(closing.defaultPrevented).toBe(true);

    // Back: the question, and "Keep editing" keeps the edit
    await clickId("editor-back");
    expect(q("confirm-leave")).not.toBeNull();
    await click(buttonNamed("Keep editing"));
    await settle();
    expect(params().endpoint).toBe("3");
    expect((css("#es-name") as HTMLInputElement).value).toBe("Renamed");

    // a main subtab asks the same question
    await click(tabs()[1]);
    expect(q("confirm-leave")).not.toBeNull();
    await click(buttonNamed("Keep editing"));
    await settle();
    expect(params().sub).toBe("endpoints");

    // "Leave and lose" goes
    await clickId("editor-back");
    await clickId("confirm-leave-yes");
    await settle();
    expect(params().endpoint).toBeUndefined();
    expect(q("endpoints-list")).not.toBeNull();
    expect(world.writes).toEqual([]);
    // nothing is unsaved any more
    expect(confirmLeaveTab(() => false)).toBe(true);
    const later = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });

  it("does not ask when nothing was changed, nor after Discard, nor after a save", async () => {
    await openEndpoint(3);
    await clickId("editor-back");
    expect(q("confirm-leave")).toBeNull();
    expect(q("endpoints-list")).not.toBeNull();
    unmount();

    await openEndpoint(3);
    await typeAt("#es-name", "Changed");
    await click(buttonNamed("Discard changes"));
    expect((css("#es-name") as HTMLInputElement).value).toBe("Departments for the intranet");
    expect(confirmLeaveTab(() => false)).toBe(true);

    await typeAt("#es-name", "Saved name");
    await click(saveButton());
    await waitFor(() => writes().includes("PUT /api/shared-endpoints/3"), "the save");
    await waitFor(() => saveBar().dataset.dirty === "false", "a clean form after the save");
    expect(confirmLeaveTab(() => false)).toBe(true);
    expect(text(q("editor-title"))).toBe("Saved name");
  });

  it("refuses a save made from a copy somebody else outdated, says so, and reloads on request", async () => {
    await openEndpoint(3);
    await typeAt("#es-name", "My edit");
    // somebody else saves meanwhile
    world.endpoints[3].version = "ver9";
    world.endpoints[3].name = "Their name";
    await click(saveButton());
    await waitFor(() => q("endpoint-save-error") !== null, "the refusal");
    expect(text(q("endpoint-save-error"))).toContain("Someone else saved this endpoint");
    // the edit is kept
    expect((css("#es-name") as HTMLInputElement).value).toBe("My edit");
    expect(lastWrite().body.expectedVersion).toBe("ver1");

    // reloading while edited asks, then shows their copy
    await clickId("endpoint-reload");
    expect(q("confirm-reload")).not.toBeNull();
    await clickId("confirm-reload-yes");
    await waitFor(() => (css("#es-name") as HTMLInputElement).value === "Their name", "their copy");
    expect(q("endpoint-save-error")).toBeNull();
    expect(saveBar().dataset.dirty).toBe("false");
    // and the next save sends their version
    await typeAt("#es-name", "Now mine");
    await click(saveButton());
    await waitFor(() => writes().filter((w) => w.startsWith("PUT")).length === 2, "the second save");
    expect(lastWrite().body.expectedVersion).toBe("ver9");
  });

  it("shows a refused save as one sentence next to Save, and keeps the form", async () => {
    await openEndpoint(3);
    await typeAt("#es-name", "Edited");
    world.failing.set("/api/shared-endpoints/3", {
      status: 400,
      body: { error: "The largest page size must be 1 to 500." },
    });
    await click(saveButton());
    await waitFor(() => q("endpoint-save-error") !== null, "the error");
    // the load of the saved copy is the same path: the form is still on screen with the edit
    expect(text(q("endpoint-save-error"))).toContain("The largest page size must be 1 to 500.");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to save the endpoint", variant: "destructive" }),
    );
  });
});

describe("deleting an endpoint", () => {
  it("asks first, names what is lost, and then returns to the list without the endpoint", async () => {
    await openEndpoint(3);
    await clickId("editor-delete");
    const dialog = q("confirm-delete")!;
    expect(text(dialog)).toContain('Delete the endpoint "Departments for the intranet"?');
    expect(text(dialog)).toContain("all of its keys are deleted");
    expect(text(dialog)).toContain("activity log is kept");
    expect(text(dialog)).toContain("switch it off instead");
    expect(world.writes).toEqual([]);
    await click(buttonNamed("Keep it"));
    await settle();
    expect(world.writes).toEqual([]);

    await clickId("editor-delete");
    await clickId("confirm-delete-yes");
    await waitFor(() => writes().includes("DELETE /api/shared-endpoints/3"), "the delete");
    await waitFor(() => q("endpoints-list") !== null, "the list");
    expect(params().endpoint).toBeUndefined();
    await waitFor(() => all("endpoint-card").length === 1, "the list without it");
    expect(all("endpoint-card")[0].dataset.slug).toBe("hr-employees");
  });

  it("has no delete button for a new endpoint", async () => {
    await open(`${BASE}&endpoint=new`);
    expect(q("editor-delete")).toBeNull();
  });
});

describe("the Guide of one endpoint", () => {
  it("asks to save a new endpoint first", async () => {
    await open(`${BASE}&endpoint=new&section=guide`);
    expect(q("guide-needs-save")).not.toBeNull();
    expect(q("guide-view")).toBeNull();
  });

  it("draws the generated guide: address, headers, parameters, response, errors and who may call", async () => {
    await openEndpoint(4, "guide");
    await waitFor(() => q("guide-view") !== null, "the guide");
    expect(text(q("guide-url-box"))).toContain("GET https://hr.example.com/api/shared/hr-employees");
    expect(q("guide-url-box-copy")).not.toBeNull();
    // headers
    expect(text(q("guide-headers"))).toContain("Authorization");
    expect(text(q("guide-headers"))).toContain("Bearer YOUR_API_KEY");
    expect(text(q("guide-headers"))).toContain("Never put a key in the address");
    // parameters: a locked filter is not one
    const parameters = text(q("guide-parameters"));
    expect(parameters).toContain("departmentId");
    expect(parameters).toContain("page");
    expect(parameters).toContain("pageSize");
    expect(parameters).not.toMatch(/\bstatus\b.*enum/);
    expect(text(q("guide-locked"))).toContain("status is always active");
    expect(text(q("guide-paging"))).toContain("50 rows a page");
    expect(text(q("guide-paging"))).toContain("60 calls a minute");
    // the response: the ticked fields with their meaning, and a sample
    expect(text(q("guide-response"))).toContain("employeeCode");
    expect(text(q("guide-response"))).toContain("phone");
    expect(text(q("guide-sample"))).toContain('"endpoint": "hr-employees"');
    // errors
    expect(text(q("guide-errors"))).toContain("invalid_key");
    expect(text(q("guide-errors"))).toContain("origin_not_allowed");
    // who may call
    expect(text(q("guide-access"))).toContain("No website is allowed");
    expect(text(q("guide-access"))).toContain("Calls with no origin (from a server) are accepted");
    expect(text(q("guide-notes"))).toContain("Origins protect browsers only");
  });

  it("lets the tables share the box and labels every cell, so nothing hides behind a sideways scroll", async () => {
    await openEndpoint(4, "guide");
    await waitFor(() => q("guide-parameters") !== null, "the guide");
    for (const id of ["guide-headers", "guide-parameters", "guide-response", "guide-errors"]) {
      expectFitTable(q(id));
    }
    // the column that used to be clipped is the last one of the parameters table
    const heads = [...q("guide-parameters")!.querySelectorAll("th")].map((th) => text(th));
    expect(heads[heads.length - 1]).toBe("What it does");
  });

  it("switches language, copies the code, and says to press Ctrl+C when copying is refused", async () => {
    await openEndpoint(3, "guide");
    await waitFor(() => q("guide-view") !== null, "the guide");
    const languages = [...document.body.querySelectorAll('[data-testid="guide-code-languages"] [role="tab"]')].map(
      text,
    );
    expect(languages).toEqual(["curl", "JavaScript", "Python", "PHP", "C#", "Node"]);
    expect(q("guide-code-lang-curl")?.getAttribute("aria-selected")).toBe("true");
    expect(text(q("guide-code-code"))).toContain("# curl example");
    expect(css('[data-testid="guide-code"] [role="tabpanel"]')?.dataset.language).toBe("curl");

    await clickId("guide-code-lang-python");
    expect(q("guide-code-lang-python")?.getAttribute("aria-selected")).toBe("true");
    expect(q("guide-code-lang-curl")?.getAttribute("aria-selected")).toBe("false");
    expect(text(q("guide-code-code"))).toContain("import requests");
    // the arrow keys move along the languages
    await press(must("guide-code-lang-python"), "ArrowRight");
    expect(q("guide-code-lang-php")?.getAttribute("aria-selected")).toBe("true");
    await press(must("guide-code-lang-php"), "End");
    expect(q("guide-code-lang-node")?.getAttribute("aria-selected")).toBe("true");
    await clickId("guide-code-lang-python");

    // copy
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await clickId("guide-code-code-copy");
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("import requests"));
    expect(text(q("guide-code-code-copy"))).toContain("Copied");

    // refused: the old way is tried, then the code is selected and the person is told
    writeText.mockRejectedValue(new Error("denied"));
    document.execCommand = vi.fn(() => false);
    await clickId("guide-code-code-copy");
    await settle();
    expect(text(q("guide-view"))).toContain("Your browser blocked copying. The text is selected: press Ctrl+C.");
    expect(window.getSelection()?.toString()).toContain("import requests");
  });

  it("copies with the old way when the clipboard is refused but the browser still allows it", async () => {
    await openEndpoint(3, "guide");
    await waitFor(() => q("guide-view") !== null, "the guide");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    document.execCommand = vi.fn(() => true);
    await clickId("guide-url-box-copy");
    await settle();
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(text(q("guide-url-box-copy"))).toContain("Copied");
    expect(text(q("guide-view"))).not.toContain("blocked copying");
  });

  it("says the guide is of the saved endpoint while the form has changes, and shows a failed load with a retry", async () => {
    await openEndpoint(3, "guide");
    await waitFor(() => q("guide-view") !== null, "the guide");
    expect(q("guide-saved-note")).toBeNull();
    await section("basics");
    await typeAt("#es-name", "Edited");
    await section("guide");
    expect(q("guide-saved-note")).not.toBeNull();
    unmount();

    world.failing.set("/api/shared-endpoints/3/guide", { status: 500 });
    await openEndpoint(3, "guide");
    await waitFor(() => q("guide-error") !== null, "the guide error");
    world.failing.clear();
    await click(buttonNamed("Try again"));
    await waitFor(() => q("guide-view") !== null, "the guide after the retry");
  });
});

describe("the Integration guide", () => {
  const SECTIONS = [
    ["guide-how", "How it works"],
    ["guide-auth", "Authentication: the API key"],
    ["guide-request", "The request"],
    ["guide-pagination", "Pages of results"],
    ["guide-response", "What comes back"],
    ["guide-errors", "Errors"],
    ["guide-cors", "Browsers, CORS and allowed origins"],
    ["guide-keys", "Looking after keys"],
    ["guide-examples", "Example code"],
    ["guide-security", "Security checklist"],
  ];

  it("has every section, each explained and findable by the page's search", async () => {
    await open(`${BASE}&sub=guide`);
    expect(world.requests).toEqual(["GET /api/shared-endpoints/catalog"]);
    for (const [id, title] of SECTIONS) {
      const card = css(`[data-setting-id="${id}"]`);
      expect(card, id).not.toBeNull();
      expect(text(card!.querySelector("h4"))).toBe(title);
      expect(text(card!.querySelector('[data-testid="setting-purpose"]')).length, id).toBeGreaterThan(25);
    }
    expect(q("endpoints-list")).toBeNull();
  });

  it("explains authentication, the request, paging, the answer and the errors in the words the server uses", async () => {
    await open(`${BASE}&sub=guide`);
    const auth = text(q("guide-auth"));
    expect(auth).toContain("Authorization");
    expect(auth).toContain("X-API-Key");
    expect(auth).toContain("never accepted in the address");
    expect(text(q("guide-base-url"))).toContain("/api/shared/your-endpoint");
    expect(text(q("guide-pagination"))).toContain("hasMore");
    expect(text(q("guide-response-shape"))).toContain('"generatedAt"');
    expect(text(q("guide-read-only"))).toContain("Nothing in the HR system can be added, changed or deleted");
    const errors = text(q("guide-error-table"));
    for (const code of [
      "not_found",
      "origin_not_allowed",
      "origin_required",
      "invalid_key",
      "rate_limited",
      "invalid_parameter",
    ]) {
      expect(errors).toContain(code);
    }
    for (const status of ["401", "403", "404", "429", "400", "405"]) expect(errors).toContain(status);
  });

  it("explains CORS and origins honestly: origins protect browsers, the key is the protection, prefer a server", async () => {
    await open(`${BASE}&sub=guide`);
    const cors = text(q("guide-cors"));
    expect(cors).toContain("a rule for browsers, not a password");
    expect(cors).toContain("Origins can be faked outside a browser");
    expect(cors).toContain("The key is the protection");
    expect(cors).toContain("Better: let your own server call the endpoint");
    expect(text(q("guide-no-browser-keys"))).toContain("Do not paste a key into JavaScript that runs in a visitor");
    const keys = text(q("guide-keys"));
    expect(keys).toContain("shown once");
    expect(keys).toContain("Never in the code, in git");
    expect(keys).toContain("revoke it at once");
  });

  it("lets the general guide's tables share the box and labels every cell", async () => {
    await open(`${BASE}&sub=guide`);
    for (const id of ["guide-auth", "guide-request", "guide-errors"]) {
      expectFitTable(q(id));
    }
  });

  it("has a security checklist and example code in six languages with a switcher and copy", async () => {
    await open(`${BASE}&sub=guide`);
    expect(css('[data-testid="security-checklist"]')!.querySelectorAll("li").length).toBeGreaterThanOrEqual(10);
    expect(text(q("security-checklist"))).toContain("Call from a server");
    expect(text(q("security-checklist"))).toContain(
      "Escape everything you display (HTML) or export (CSV formulas starting with = + - @): treat the data as untrusted text.",
    );
    const langs = [...document.body.querySelectorAll('[data-testid="general-code-languages"] [role="tab"]')].map(text);
    expect(langs).toEqual(["curl", "JavaScript", "Python", "PHP", "C#", "Node"]);
    expect(text(q("general-code-code"))).toContain("Authorization: Bearer YOUR_API_KEY");
    expect(text(q("general-code-code"))).toContain("/api/shared/your-endpoint");
    for (const [lang, snippet] of [
      ["javascript", "process.env.SHARED_API_KEY"],
      ["python", "requests.get"],
      ["php", "curl_init"],
      ["csharp", "HttpClient"],
      ["node", "X-API-Key"],
    ]) {
      await clickId(`general-code-lang-${lang}`);
      expect(text(q("general-code-code")), lang).toContain(snippet);
      // an example never carries a real key
      expect(text(q("general-code-code")), lang).not.toMatch(/uks_[a-z0-9]{8}_/);
    }
    expect(q("general-code-code-copy")).not.toBeNull();
  });
});

describe("Activity", () => {
  it("lists every endpoint's calls, the refused ones too, and filters by endpoint and by result", async () => {
    await open(`${BASE}&sub=activity`);
    await waitFor(() => q("activity-table") !== null, "the log");
    expect(q("endpoints-list")).toBeNull();
    expect((css("#es-activity-endpoint") as HTMLSelectElement).value).toBe("all");
    expect(all("activity-row")).toHaveLength(2);
    expect(text(all("activity-row")[0])).toContain("hr-departments");
    expect(text(all("activity-row")[0])).toContain("200");
    expect(text(all("activity-row")[0])).toContain("Intranet server");
    expect(text(all("activity-row")[0])).toContain("https://intranet.example.com");
    expect(text(all("activity-row")[1])).toContain("invalid_key");
    expect(text(all("activity-row")[1])).toContain("none");
    expect(text(q("activity-page"))).toBe("Page 1 of 1: 2 calls in all");
    expect(world.requests).toContain("GET /api/shared-endpoints/activity?page=1");

    await choose("#es-activity-endpoint", "3");
    await waitFor(() => world.requests.includes("GET /api/shared-endpoints/3/activity?page=1"), "one endpoint's log");
    expect(params().endpoint).toBe("3");
    await choose("#es-activity-status", "error");
    await waitFor(
      () => world.requests.includes("GET /api/shared-endpoints/3/activity?page=1&status=error"),
      "the result filter",
    );
    await choose("#es-activity-status", "401");
    await waitFor(
      () => world.requests.includes("GET /api/shared-endpoints/3/activity?page=1&status=401"),
      "the 401 filter",
    );
  });

  it("shows every column of the log in a table that shares the box: website and address are not pushed out of sight", async () => {
    await open(`${BASE}&sub=activity`);
    await waitFor(() => q("activity-table") !== null, "the log");
    expectFitTable(q("activity-table"), 2);
    const heads = [...q("activity-table")!.querySelectorAll("th")].map((th) => text(th));
    expect(heads).toEqual(["When", "Endpoint", "Result", "Key", "Website and address"]);
    const row = all("activity-row")[0];
    expect(text(row)).toContain("https://intranet.example.com");
    expect(text(row)).toContain("from 10.0.0.5");
    expect(text(row)).toContain("12 rows, 18 ms"); // rows and time share the Result cell
  });

  it("says when nothing was called, and when the log cannot be read", async () => {
    world.activity = [];
    await open(`${BASE}&sub=activity`);
    await waitFor(() => q("activity-empty") !== null, "the empty log");
    expect(text(q("activity-empty"))).toContain("No call has reached any endpoint in the last 90 days");
    unmount();
    world.failing.set("/api/shared-endpoints/activity", { status: 500 });
    await open(`${BASE}&sub=activity`);
    await waitFor(() => q("activity-error") !== null, "the log error");
    world.failing.clear();
    world.activity = [];
    await click(buttonNamed("Try again"));
    await waitFor(() => q("activity-empty") !== null, "the log after the retry");
  });

  it("opens on the endpoint named in the address, and is reached from an open endpoint with it selected", async () => {
    await openEndpoint(3);
    await click(tabs()[2]);
    await waitFor(() => q("activity-table") !== null, "the log");
    expect(params()).toMatchObject({ sub: "activity", endpoint: "3" });
    expect((css("#es-activity-endpoint") as HTMLSelectElement).value).toBe("3");
    expect(here()).toContain("sub=activity");
  });
});

describe("typing helpers stay honest", () => {
  it("the key box labels, the origin box labels and every control of the editor has a label", async () => {
    await openEndpoint(3, "access");
    await waitFor(() => q("keys-table") !== null, "the keys");
    for (const input of document.body.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input, select, textarea",
    )) {
      const labelled =
        (input.id && document.body.querySelector(`label[for="${input.id}"]`)) ||
        input.getAttribute("aria-label") ||
        input.closest("label");
      expect(labelled, `${input.tagName} #${input.id} has a label`).toBeTruthy();
    }
    for (const button of document.body.querySelectorAll<HTMLButtonElement>("button")) {
      expect(text(button) || button.getAttribute("aria-label"), "every button has a name").toBeTruthy();
    }
  });
});
