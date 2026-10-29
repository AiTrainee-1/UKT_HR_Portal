import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import GeoAttendance from "../GeoAttendance";
import {
  all,
  buttonNamed,
  click,
  css,
  installBrowserStubs,
  installWorld,
  mount,
  newWorld,
  q,
  settle,
  text,
  typeAt,
  unmount,
  waitFor,
  type Raw,
  type World,
} from "./testing";

// Tracking Settings -> the list of employees HR switched live tracking on for: the figures, the search and the filter, one switch
// per employee, "Enable All / Disable All" (asked first: it changes every active employee) and the pages of a long list.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "tok123", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("react-leaflet", async () => (await import("./leafletMock")).leafletMock);
vi.mock("@/components/HrLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));

const SUPER = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };

let world: World;
let staff: Raw[];
let writes: { method: string; url: string; body: Record<string, unknown> }[];

const person = (id: number, first: string, last: string, on: boolean): Raw => ({
  id,
  employeeCode: `E${String(id).padStart(3, "0")}`,
  firstName: first,
  lastName: last,
  departmentName: id % 2 ? "Stitching" : "Cutting",
  branchName: "Head Office",
  status: "active",
  locationTrackingEnabled: on,
});

beforeAll(installBrowserStubs);
beforeEach(() => {
  vi.clearAllMocks();
  h.user.current = SUPER;
  writes = [];
  staff = [
    person(1, "Asha", "Kumar", true),
    person(2, "Ravi", "Nair", false),
    person(3, "Meena", "Devi", true),
    person(4, "Zoya", "Khan", false),
  ];
  world = installWorld(h.fetch, newWorld());
  const base = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    const [path] = url.split("?");
    const method = (options?.method ?? "GET").toUpperCase();
    if (method === "GET" && path === "/api/employees") return JSON.parse(JSON.stringify(staff));
    if (method === "PATCH" && path === "/api/employees/location-tracking/bulk") {
      const body = JSON.parse(String(options?.body ?? "{}"));
      writes.push({ method, url: path, body });
      for (const e of staff) e.locationTrackingEnabled = body.enabled;
      return { updated: staff.length, enabled: body.enabled };
    }
    if (method === "PATCH" && /^\/api\/employees\/\d+$/.test(path)) {
      const body = JSON.parse(String(options?.body ?? "{}"));
      writes.push({ method, url: path, body });
      return {};
    }
    return base(url, options);
  });
});
afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmount();
  vi.restoreAllMocks();
});

const open = async () => {
  mount("/hr/geo-attendance?tab=tracking", GeoAttendance);
  await waitFor(() => all("tracking-row").length > 0, "the employees");
};
const names = () => all("tracking-row").map((r) => text(r.querySelector("p")).replace(/\s*E\d+$/, ""));
const figure = (id: string) => text(q(`${id}-value`));

describe("the list of employees", () => {
  it("shows the figures and one row per employee with the switch and what it says", async () => {
    await open();
    expect(figure("tracking-total")).toBe("4");
    expect(figure("tracking-enabled")).toBe("2");
    expect(figure("tracking-disabled")).toBe("2");
    expect(names()).toEqual(["Asha Kumar", "Ravi Nair", "Meena Devi", "Zoya Khan"]);
    const asha = all("tracking-row")[0];
    expect(text(asha)).toContain("Tracking on");
    expect(text(asha)).toContain("Stitching · Head Office");
    expect(text(all("tracking-row")[1])).toContain("Tracking off");
    expect(asha.querySelector('[role="switch"]')!.getAttribute("aria-label")).toBe("Toggle live location tracking");
  });

  it("searches by name or code and filters by what is on", async () => {
    await open();
    typeAt('input[aria-label="Search employees"]', "e003");
    await settle();
    expect(names()).toEqual(["Meena Devi"]);
    typeAt('input[aria-label="Search employees"]', "");
    await settle();
    const tab = (name: RegExp) =>
      [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
        name.test(text(t.querySelector(".ptab-label"))),
      )!;
    click(tab(/^Enabled/));
    await settle();
    expect(names()).toEqual(["Asha Kumar", "Meena Devi"]);
    click(tab(/^Disabled/));
    await settle();
    expect(names()).toEqual(["Ravi Nair", "Zoya Khan"]);
    typeAt('input[aria-label="Search employees"]', "nobody");
    await settle();
    expect(text(q("tracking-list"))).toContain("No employees match.");
  });
});

describe("switching tracking", () => {
  it("sends one employee's switch and says what happened", async () => {
    await open();
    click(all("tracking-row")[1].querySelector('[role="switch"]'));
    await waitFor(() => writes.length === 1, "the change");
    expect(writes[0]).toEqual({ method: "PATCH", url: "/api/employees/2", body: { locationTrackingEnabled: true } });
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Live tracking enabled", description: "Ravi Nair" }),
    );
  });

  it("asks before it changes everybody, says how many employees that is, and sends nothing when the answer is no", async () => {
    await open();
    click(buttonNamed("Disable All"));
    await settle();
    const dialog = text(css('[role="alertdialog"]'));
    expect(dialog).toContain("Disable live tracking for everyone?");
    expect(dialog).toContain("all 4 active employees, not just the ones currently shown in this list");
    click(buttonNamed("Cancel"));
    await settle();
    expect(writes).toEqual([]);
    expect(css('[role="alertdialog"]')).toBeNull();
  });

  it("changes everybody once confirmed", async () => {
    await open();
    click(buttonNamed("Enable All"));
    await settle();
    expect(text(css('[role="alertdialog"]'))).toContain("Enable live tracking for everyone?");
    click(css('[role="alertdialog"] button:last-child'));
    await waitFor(() => writes.length === 1, "the change");
    expect(writes[0].body).toEqual({ enabled: true });
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Live tracking enabled for everyone", description: "4 employees updated" }),
    );
  });
});

describe("a long list", () => {
  beforeEach(() => {
    staff = Array.from({ length: 23 }, (_, i) => person(i + 1, `First${i + 1}`, "Last", i % 2 === 0));
  });

  it("shows ten at a time, with the portal's pagination, and goes back to the first page when the search changes", async () => {
    await open();
    expect(all("tracking-row")).toHaveLength(10);
    expect(text(document.body)).toContain("Page 1 of 3");
    click(css('button[aria-label="Page 3"]'));
    await settle();
    expect(all("tracking-row")).toHaveLength(3);
    expect(text(document.body)).toContain("Page 3 of 3");
    typeAt('input[aria-label="Search employees"]', "first2");
    await settle();
    expect(text(document.body)).toContain("Page 1 of 1");
    expect(names()).toEqual(["First2 Last", "First20 Last", "First21 Last", "First22 Last", "First23 Last"]);
  });
});
