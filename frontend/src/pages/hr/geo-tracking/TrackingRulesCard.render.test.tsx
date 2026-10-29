import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import TrackingRulesCard from "./TrackingRulesCard";
import {
  apiError,
  buttonNamed,
  choose,
  click,
  css,
  installBrowserStubs,
  installWorld,
  mount,
  q,
  settle,
  text,
  typeAt,
  unmount,
  waitFor,
  type World,
} from "./testing";

// Tracking Settings -> "Geo-tracking rules" in jsdom: the saved rules in the units HR thinks in, the checks in words, a save that
// sends only what changed, the confirmation before two photos, the privacy note of the address lookup, the server's own
// sentence when it refuses, and View only.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "tok", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

const SUPER = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };
const VIEW_ONLY = { role: "hr", employeeId: null, isSuperAdmin: false, permissions: { "settings.attendance": "view" } };
const EDITOR = { role: "hr", employeeId: null, isSuperAdmin: false, permissions: { "settings.attendance": "edit" } };
const BRANCH_LOGIN = {
  role: "hr",
  employeeId: null,
  isSuperAdmin: false,
  branchId: 3,
  permissions: { "settings.attendance": "edit" },
};

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
});

const open = async () => {
  mount("/hr/geo-attendance?tab=tracking", TrackingRulesCard);
  await waitFor(() => q("rules-card") !== null || q("rules-error") !== null, "the card");
};
const input = (id: string) => css(`#${id}`) as HTMLInputElement;
const bar = () => q("save-bar")!;
const saveButton = () => buttonNamed("Save tracking rules") as HTMLButtonElement;
const puts = () => world.writes.filter((w) => w.method === "PUT");
const lastBody = () => puts().at(-1)!.body;

describe("the saved rules", () => {
  it("shows the rules the server holds, in the units HR thinks in", async () => {
    await open();
    expect(input("rule-stop-minutes").value).toBe("3");
    expect(input("rule-stop-radius").value).toBe("50");
    expect(input("rule-gap-minutes").value).toBe("5");
    expect(input("rule-signal-lost").value).toBe("10");
    expect(input("rule-max-accuracy").value).toBe("100");
    expect(input("rule-max-speed").value).toBe("200");
    expect(input("rule-sample-moving").value).toBe("3");
    expect(input("rule-sample-still").value).toBe("60");
    expect(input("rule-upload-batch").value).toBe("30");
    expect(input("rule-upload-interval").value).toBe("60");
    expect(input("rule-retention").value).toBe("365");
    expect(input("rule-day-end").value).toBe("23:50");
    expect((input("rule-photos-1") as HTMLInputElement).checked).toBe(true);
    expect((input("rule-photos-2") as HTMLInputElement).checked).toBe(false);
    expect((css("#rule-notice-text") as HTMLTextAreaElement).value).toContain("records your route");
    expect(text(q("notice-version"))).toContain("Notice version 3");
    expect((css("#rule-geocoder") as HTMLSelectElement).value).toBe("off");
    expect(text(q("rules-updated"))).toContain("Last saved 20 Oct, 08:00 by Asha Admin");
    expect(text(q("rules-tracking"))).toContain("Geo-tracking is on");
  });

  it("keeps the three advanced rules apart", async () => {
    await open();
    const advanced = q("rules-advanced")!;
    expect(advanced.querySelector("#rule-stop-factor")).not.toBeNull();
    expect(advanced.querySelector("#rule-merge-gap")).not.toBeNull();
    expect(advanced.querySelector("#rule-distance-filter")).not.toBeNull();
    expect(input("rule-stop-factor").value).toBe("2");
    expect(input("rule-merge-gap").value).toBe("120");
    expect(input("rule-distance-filter").value).toBe("10");
  });

  it("opens the folded Advanced part by itself when something inside it is wrong", async () => {
    await open();
    expect(q("rules-advanced")!.hasAttribute("open")).toBe(false);
    typeAt("#rule-distance-filter", "500");
    await settle();
    expect(q("rules-advanced")!.hasAttribute("open")).toBe(true);
    expect(text(q("rules-advanced"))).toContain("Phone: ignore moves under: must be between 0 and 200 metres.");
  });

  it("shows placeholders while loading and a way to try again when the rules cannot be read", async () => {
    world.failing.set("/api/tracking/settings", { status: 500, body: { error: "The database is busy." } });
    await open();
    expect(text(q("rules-error"))).toContain("The database is busy.");
    world.failing.clear();
    click(buttonNamed("Try again"));
    await waitFor(() => q("rules-card") !== null, "the card after trying again");
  });

  it("says when the role may not see the rules", async () => {
    world.failing.set("/api/tracking/settings", { status: 403, body: null });
    await open();
    expect(text(q("rules-error"))).toContain("You are not allowed to see the tracking rules.");
  });
});

describe("editing", () => {
  it("says there are unsaved changes, and Discard puts everything back", async () => {
    await open();
    expect(bar().dataset.dirty).toBe("false");
    expect(saveButton().disabled).toBe(true);
    typeAt("#rule-stop-minutes", "4");
    await settle();
    expect(bar().dataset.dirty).toBe("true");
    expect(text(bar())).toContain("You have changes that are not saved yet.");
    expect(saveButton().disabled).toBe(false);
    click(buttonNamed("Discard changes"));
    await settle();
    expect(input("rule-stop-minutes").value).toBe("3");
    expect(bar().dataset.dirty).toBe("false");
  });

  it("refuses a value outside its range in words, under the field, and blocks the save", async () => {
    await open();
    typeAt("#rule-stop-minutes", "0");
    typeAt("#rule-max-speed", "9000");
    await settle();
    const alerts = [...document.body.querySelectorAll('[role="alert"]')].map((a) => text(a));
    expect(alerts).toContain("Stationary after: must be between 1 and 60 minutes.");
    expect(alerts).toContain("Ignore jumps faster than: must be between 30 and 500 km/h.");
    expect(input("rule-stop-minutes").getAttribute("aria-invalid")).toBe("true");
    expect(text(bar())).toContain("Fix the highlighted fields first.");
    expect(saveButton().disabled).toBe(true);
    click(saveButton());
    await settle();
    expect(puts()).toHaveLength(0);
  });

  it("refuses an empty field and a day end that is not a time", async () => {
    await open();
    typeAt("#rule-retention", "");
    typeAt("#rule-day-end", "");
    await settle();
    const alerts = [...document.body.querySelectorAll('[role="alert"]')].map((a) => text(a));
    expect(alerts.some((a) => a.startsWith("Keep raw positions for: enter a number between 7 and 3650 days"))).toBe(
      true,
    );
    expect(alerts).toContain("Day end: choose a time of day (for example 23:50).");
    expect(saveButton().disabled).toBe(true);
  });
});

describe("saving", () => {
  it("sends only what changed, with the long times back in seconds, and shows it as saved", async () => {
    await open();
    typeAt("#rule-stop-minutes", "4");
    typeAt("#rule-gap-minutes", "7.5");
    typeAt("#rule-stop-radius", "60");
    typeAt("#rule-day-end", "23:30");
    await settle();
    click(saveButton());
    await waitFor(() => puts().length === 1, "the save");
    expect(puts()[0].url).toBe("/api/tracking/settings");
    expect(lastBody()).toEqual({ stopSeconds: 240, gapSeconds: 450, stopRadiusM: 60, dayEndTime: "23:30" });
    await waitFor(() => bar().dataset.dirty === "false", "a clean bar");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Tracking rules saved" }));
    expect(input("rule-stop-minutes").value).toBe("4");
    expect(text(bar())).toContain("Everything shown is saved.");
  });

  it("sends the master switch", async () => {
    await open();
    click(css("#geo-enabled"));
    await settle();
    expect(text(q("rules-tracking"))).toContain("Geo-tracking is off");
    click(saveButton());
    await waitFor(() => puts().length === 1, "the save");
    expect(lastBody()).toEqual({ enabled: false });
  });

  it("asks everybody to accept the notice again by raising its version", async () => {
    await open();
    click(css("#rule-reaccept"));
    await settle();
    expect(text(q("rules-notice"))).toContain("The version becomes 4 when you save.");
    click(saveButton());
    await waitFor(() => puts().length === 1, "the save");
    expect(lastBody()).toEqual({ noticeVersion: 4 });
    await waitFor(() => text(q("notice-version")).includes("Notice version 4"), "the new version");
    expect((input("rule-reaccept") as HTMLInputElement).checked).toBe(false);
  });

  it("sends a changed notice text, which is a new version everybody accepts again, and refuses an empty one", async () => {
    await open();
    typeAt("#rule-notice-text", "   ");
    await settle();
    expect([...document.body.querySelectorAll('[role="alert"]')].map((a) => text(a))).toContain(
      "Write the notice employees accept before tracking starts.",
    );
    expect(saveButton().disabled).toBe(true);
    typeAt("#rule-notice-text", "We record your route and stops while you are On-Duty.");
    await settle();
    expect(text(q("notice-bump"))).toBe("You changed the text, so the version becomes 4 when you save.");
    expect((input("rule-reaccept") as HTMLInputElement).checked).toBe(true);
    expect((input("rule-reaccept") as HTMLInputElement).disabled).toBe(true); // it happens anyway
    click(saveButton());
    await waitFor(() => puts().length === 1, "the save");
    expect(lastBody()).toEqual({
      noticeText: "We record your route and stops while you are On-Duty.",
      noticeVersion: 4,
    });
    await waitFor(() => text(q("notice-version")).includes("Notice version 4"), "the new version");
  });

  it("shows the server's own sentence when it refuses, keeps the edits, and does not say saved", async () => {
    await open();
    typeAt("#rule-stop-minutes", "9");
    await settle();
    const real = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === "PUT") throw apiError(400, { error: "Stop time must be shorter than the gap time." });
      return real(url, options);
    });
    click(saveButton());
    await waitFor(() => q("rules-server-error") !== null, "the server's sentence");
    expect(text(q("rules-server-error"))).toBe("Stop time must be shorter than the gap time.");
    expect(input("rule-stop-minutes").value).toBe("9");
    expect(bar().dataset.dirty).toBe("true");
    expect(h.toast).not.toHaveBeenCalled();
    // editing again clears the message
    typeAt("#rule-stop-minutes", "2");
    await settle();
    expect(q("rules-server-error")).toBeNull();
  });
});

describe("on-duty punch photos", () => {
  it("explains the rollout: switch to two only after everybody has the new app", async () => {
    await open();
    expect(text(q("photos-rollout-note"))).toContain("Switch to 2 only after everybody has the new app");
    expect(text(q("rules-photos"))).toContain("1 photo");
    expect(text(q("rules-photos"))).toContain("2 photos");
  });

  it("asks before requiring two photos, and sends nothing when the answer is no", async () => {
    await open();
    click(css("#rule-photos-2"));
    await settle();
    click(saveButton());
    await settle();
    expect(document.body.textContent).toContain("Require 2 photos at every On-Duty punch?");
    expect(document.body.textContent).toContain("old app will not be able to punch");
    expect(puts()).toHaveLength(0);
    click(buttonNamed("Keep 1 photo"));
    await settle();
    expect(puts()).toHaveLength(0);
  });

  it("sends the switch to two photos once confirmed", async () => {
    await open();
    click(css("#rule-photos-2"));
    await settle();
    click(saveButton());
    await settle();
    click(buttonNamed("Require 2 photos"));
    await waitFor(() => puts().length === 1, "the save");
    expect(lastBody()).toEqual({ ondutyPunchPhotos: 2 });
    await waitFor(() => bar().dataset.dirty === "false", "saved");
    expect((input("rule-photos-2") as HTMLInputElement).checked).toBe(true);
  });

  it("goes back to one photo without a question", async () => {
    world.settings = { ...world.settings, ondutyPunchPhotos: 2 };
    await open();
    expect((input("rule-photos-2") as HTMLInputElement).checked).toBe(true);
    click(css("#rule-photos-1"));
    await settle();
    click(saveButton());
    await waitFor(() => puts().length === 1, "the save");
    expect(lastBody()).toEqual({ ondutyPunchPhotos: 1 });
    expect(document.body.textContent).not.toContain("Require 2 photos at every On-Duty punch?");
  });
});

describe("addresses of stops", () => {
  it("says what the lookup sends: nothing while off, the coordinates of each stop to a public service when on", async () => {
    await open();
    expect(text(q("geocoder-privacy"))).toContain("Off keeps every coordinate on this server");
    choose("#rule-geocoder", "nominatim");
    await settle();
    const note = text(q("geocoder-privacy"));
    expect(note).toContain("Privacy: the coordinates of every stop are sent to a public service");
    expect(note).toContain("nominatim.openstreetmap.org");
    click(saveButton());
    await waitFor(() => puts().length === 1, "the save");
    expect(lastBody()).toEqual({ reverseGeocodeProvider: "nominatim" });
  });
});

describe("View only", () => {
  it("lets a role with View only read the rules but not change them", async () => {
    h.user.current = VIEW_ONLY;
    await open();
    expect(text(q("rules-view-only"))).toContain("View only");
    expect(q("save-bar")).toBeNull();
    expect(q("rules-footer")).toBeNull();
    const fields = [
      ...document.body.querySelectorAll<HTMLInputElement>("#geo-rules input, #geo-rules textarea, #geo-rules select"),
    ];
    expect(fields.length).toBeGreaterThan(15);
    expect(fields.filter((f) => !f.disabled).map((f) => f.id)).toEqual([]);
    expect(input("rule-stop-minutes").value).toBe("3"); // still readable
    expect(puts()).toHaveLength(0);
  });

  it("lets a login that belongs to one branch read the rules but not change them: they are company-wide", async () => {
    h.user.current = BRANCH_LOGIN;
    await open();
    expect(text(q("rules-view-only"))).toContain("a branch login can read them but not change them");
    expect(q("save-bar")).toBeNull();
    expect(input("rule-stop-minutes").disabled).toBe(true);
    expect(input("rule-stop-minutes").value).toBe("3");
  });

  it("follows the Attendance settings permission, not the Geo Attendance page's", async () => {
    // a role that may edit the page but only view the Attendance settings (the rules live there for the API)
    h.user.current = {
      role: "hr",
      employeeId: null,
      isSuperAdmin: false,
      permissions: { geo_attendance: "edit", "settings.attendance": "view" },
    };
    await open();
    expect(q("rules-view-only")).not.toBeNull();
    expect(q("save-bar")).toBeNull();
  });

  it("lets a role with edit access save", async () => {
    h.user.current = EDITOR;
    await open();
    expect(q("rules-view-only")).toBeNull();
    expect(q("save-bar")).not.toBeNull();
    expect(input("rule-stop-minutes").disabled).toBe(false);
  });
});
