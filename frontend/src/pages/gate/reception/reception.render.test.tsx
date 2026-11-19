import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch } from "wouter";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { istDateKey } from "@/pages/hr/outpass-visitors/kit/fmt";
import ReceptionConsole from "../ReceptionConsole";
import ReceptionLogin from "../ReceptionLogin";
import { resetDeskSessionEnd } from "./desk-api";
import ReceptionSignIn from "./ReceptionSignIn";

// The reception desk in jsdom with a fake server behind window.fetch: the shared sign-in sends no HR token and shows the
// server's words, the console checks its session (GET me, storing a renewed token), lists the desk's visits with a Check
// out button for those inside, registers a walk-in, has a Records view with its filters and files (all with the desk's
// token only), and Sign out or an ended session lands on /reception-login, never on an HR page, leaving an HR session in
// the same browser alone.

const h = vi.hoisted(() => ({ toast: vi.fn(), download: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/pages/hr/outpass-visitors/kit/download", async (original) => ({
  ...(await original<typeof import("@/pages/hr/outpass-visitors/kit/download")>()),
  downloadGateFile: h.download,
}));

type Call = { method: string; url: string; auth: string | null; body: unknown };
let calls: Call[] = [];
let answer: (method: string, url: string) => { status: number; body: unknown } | undefined;
let root: Root | null = null;
let host: HTMLElement | null = null;

const visit = (id: number, name: string, status: "inside" | "checked_out") => ({
  id,
  name,
  phone: `98765000${id}`,
  aadhaar: null,
  aadhaarLast4: null,
  whyCame: null,
  whomToMeet: "Accounts",
  purpose: "Invoice",
  branchName: "Main",
  visitedAt: "2026-10-14T04:00:00Z",
  meetingEmployee: null,
  notifiedEmailAt: null,
  notifiedWhatsappAt: null,
  visitorId: id,
  branchId: 1,
  source: "qr",
  sourceLabel: "QR self check-in",
  checkedInBy: null,
  checkedOutAt: status === "checked_out" ? "2026-10-14T05:00:00Z" : null,
  checkedOutBy: status === "checked_out" ? "Front Desk" : null,
  checkoutSource: status === "checked_out" ? "reception" : null,
  company: null,
  vehicleNumber: null,
  peopleCount: 1,
  idProofType: null,
  badgeNumber: null,
  notes: null,
  status,
  statusLabel: status === "inside" ? "Inside" : "Checked out",
  minutesInside: 60,
  visitCount: 1,
});

const HOST = {
  id: 41,
  employeeCode: "E041",
  name: "Karthik Raja",
  department: "Accounts",
  designation: "Manager",
  phone: "90000 11111",
  email: null,
  photoUrl: null,
};

let visits: ReturnType<typeof visit>[] = [];
let meToken: string | undefined;

function serve(method: string, url: string, body: unknown) {
  const custom = answer?.(method, url);
  if (custom) return custom;
  const path = url.split("?")[0];
  if (method === "POST" && path === "/api/reception-devices/login")
    return {
      status: 200,
      body: {
        token: "desk-token",
        deviceId: 7,
        deskName: "Front Desk",
        desk: { id: 7, name: "Front Desk", branchName: "Unit 1", location: null },
      },
    };
  if (method === "GET" && path.startsWith("/api/reception-devices/login-info/"))
    return { status: 200, body: { deskName: "Front Desk", branchName: "Unit 1", isActive: true } };
  if (method === "GET" && path === "/api/reception-devices/me")
    return {
      status: 200,
      body: {
        desk: { id: 7, name: "Front Desk", branchName: "Unit 1", location: null },
        session: { id: 3, deviceLabel: "Chrome on Windows", createdAt: null, lastSeenAt: null },
        expiresAt: null,
        ...(meToken ? { token: meToken } : {}),
      },
    };
  if (method === "POST" && path === "/api/reception-devices/logout") return { status: 204, body: null };
  if (method === "GET" && path === "/api/reception-devices/summary")
    return { status: 200, body: { today: 2, thisWeek: 2, thisMonth: 2, insideNow: 1, checkedOutToday: 1 } };
  if (method === "GET" && path === "/api/reception-devices/visits")
    return { status: 200, body: { items: visits, total: visits.length, page: 1, pageSize: 15 } };
  if (method === "POST" && path === "/api/reception-devices/visits") {
    const b = body as { name: string; whomToMeet: string };
    const made = { ...visit(9, b.name, "inside"), whomToMeet: b.whomToMeet, source: "reception" };
    visits = [made, ...visits];
    return { status: 201, body: made };
  }
  if (method === "POST" && path === "/api/reception-devices/host-lookup")
    return { status: 200, body: { found: true, employee: HOST } };
  if (method === "GET" && path === "/api/reception-devices/visitor-lookup")
    return { status: 200, body: { visitor: null } };
  const out = /^\/api\/reception-devices\/visits\/(\d+)\/check-out$/.exec(path);
  if (method === "POST" && out) {
    const row = visits.find((v) => v.id === Number(out[1]))!;
    visits = visits.map((v) => (v.id === row.id ? visit(row.id, row.name, "checked_out") : v));
    return { status: 200, body: visits.find((v) => v.id === row.id) };
  }
  return { status: 599, body: { error: `unexpected ${method} ${url}` } };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  calls = [];
  answer = () => undefined;
  meToken = undefined;
  visits = [visit(1, "Asha Visitor", "inside"), visit(2, "Babu Visitor", "checked_out")];
  localStorage.clear();
  sessionStorage.clear();
  resetDeskSessionEnd();
  h.toast.mockReset();
  h.download.mockReset();
  h.download.mockResolvedValue("visitors_20261014_1130.xlsx");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method, url, auth: headers.get("Authorization"), body });
      const res = serve(method, url, body);
      if (res.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function mount(url: string) {
  window.history.replaceState(null, "", url);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          Switch,
          null,
          createElement(Route, { path: "/reception/console", component: ReceptionConsole }),
          createElement(Route, { path: "/reception-login", component: ReceptionSignIn }),
          createElement(Route, { path: "/reception-login/:loginToken", component: ReceptionLogin }),
        ),
      ),
    ),
  );
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 10)));
async function waitFor(check: () => boolean, what: string) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > 4000) throw new Error(`timed out waiting for ${what}: ${text(document.body).slice(0, 300)}`);
    await settle();
  }
}
const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function choose(el: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
const submit = (el: Element | null) =>
  act(() => el!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
const buttonNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => text(b) === name) ?? null;
const desksCalls = () => calls.filter((c) => c.auth !== null);

function signedIn() {
  localStorage.setItem("reception_device_token", "desk-token");
  localStorage.setItem("reception_device_id", "7");
  localStorage.setItem("reception_device_name", "Front Desk");
}

// ═══ the sign-in ═════════════════════════════════════════════════════════════════════════════════════════════════════

describe("the reception sign-in", () => {
  it("signs a desk in without ever sending the HR token, and opens the console", async () => {
    localStorage.setItem("uk_textile_token", "hr-token-of-someone");
    mount("/reception-login");
    expect(text(document.querySelector("h1"))).toBe("Reception");
    expect(text(document.body)).toContain("UK Textiles HRMS");
    expect(text(document.body)).toContain("Stays signed in on this device until you sign out.");
    type(input("reception-sign-in-username"), " frontdesk ");
    type(input("reception-sign-in-password"), "secret1");
    submit(byId("reception-sign-in"));
    await waitFor(() => window.location.pathname === "/reception/console", "the console");
    const login = calls.find((c) => c.url.endsWith("/api/reception-devices/login"))!;
    expect(login.auth).toBeNull();
    expect(login.body).toEqual({ username: "frontdesk", password: "secret1" });
    expect(localStorage.getItem("reception_device_token")).toBe("desk-token");
    expect(localStorage.getItem("reception_device_name")).toBe("Front Desk");
    await waitFor(() => calls.some((c) => c.url.includes("/api/reception-devices/visits")), "the visits");
    expect(desksCalls().every((c) => c.auth === "Bearer desk-token")).toBe(true);
    expect(localStorage.getItem("uk_textile_token")).toBe("hr-token-of-someone");
  });

  it.each([
    [401, "Wrong username or password."],
    [403, "This desk is switched off. Ask HR to switch it on."],
    [429, "Too many wrong tries. Wait 15 minutes or ask HR to reset the password."],
  ])("shows the server's words for a %s", async (status, message) => {
    answer = (method, url) =>
      method === "POST" && url.endsWith("/login") ? { status, body: { error: message, code: "x" } } : undefined;
    mount("/reception-login");
    type(input("reception-sign-in-username"), "x");
    type(input("reception-sign-in-password"), "y");
    submit(byId("reception-sign-in"));
    await waitFor(() => byId("reception-signin-error") !== null, "the error");
    expect(text(byId("reception-signin-error"))).toBe(message);
    expect(window.location.pathname).toBe("/reception-login");
    expect(localStorage.getItem("reception_device_token")).toBeNull();
    expect(input("reception-sign-in-password").value).toBe("");
  });

  it("says why the last sign-in ended, and forgets that desk", async () => {
    signedIn();
    mount("/reception-login?ended=switched_off");
    await waitFor(() => byId("reception-signin-ended") !== null, "the notice");
    expect(text(byId("reception-signin-ended"))).toContain("HR switched this desk off");
    expect(localStorage.getItem("reception_device_token")).toBeNull();
    expect(window.location.pathname).toBe("/reception-login");
  });

  it("a desk that is already signed in goes straight to its console", async () => {
    signedIn();
    mount("/reception-login");
    await waitFor(() => window.location.pathname === "/reception/console", "the console");
  });

  it("the old per-desk link still works and names the desk", async () => {
    mount("/reception-login/abc123");
    await waitFor(() => byId("reception-desk-hint") !== null, "the hint");
    expect(text(byId("reception-desk-hint"))).toContain("Front Desk · Unit 1");
    expect(text(document.querySelector("h1"))).toBe("Reception");
    expect(calls[0].auth).toBeNull();
  });
});

// ═══ the console ═════════════════════════════════════════════════════════════════════════════════════════════════════

describe("the reception console", () => {
  it("checks its session on load and keeps a renewed token", async () => {
    signedIn();
    meToken = "desk-token-2";
    mount("/reception/console");
    await waitFor(() => localStorage.getItem("reception_device_token") === "desk-token-2", "the renewed token");
    const me = calls.find((c) => c.url.endsWith("/api/reception-devices/me"))!;
    expect(me.auth).toBe("Bearer desk-token");
    await waitFor(() => text(byId("reception-desk-name")).includes("Unit 1"), "the branch");
    expect(text(byId("reception-desk-name"))).toBe("Front Desk · Unit 1");
    // the tab coming back into view asks again, with the new token
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => calls.filter((c) => c.url.endsWith("/me")).length >= 2, "the second heartbeat");
    expect(calls.filter((c) => c.url.endsWith("/me")).at(-1)!.auth).toBe("Bearer desk-token-2");
  });

  it("lists the visits with a Check out button only for who is inside, and checks out with the desk token", async () => {
    signedIn();
    mount("/reception/console");
    await waitFor(() => text(document.body).includes("Asha Visitor"), "the visits");
    expect(text(document.body)).toContain("Visitors - Today");
    expect(byId("reception-check-out-1")).not.toBeNull();
    expect(byId("reception-check-out-2")).toBeNull();
    click(byId("reception-check-out-1"));
    await waitFor(() => byId("check-out-confirm") !== null, "the dialog");
    click(byId("check-out-confirm"));
    await waitFor(() => calls.some((c) => c.url.endsWith("/visits/1/check-out")), "the check-out");
    const call = calls.find((c) => c.url.endsWith("/visits/1/check-out"))!;
    expect([call.method, call.auth, call.body]).toEqual(["POST", "Bearer desk-token", {}]);
    await waitFor(() => byId("reception-check-out-1") === null, "the row checked out");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Asha Visitor is checked out" }));
  });

  it("Sign out asks first, ends the session on the server, forgets only the desk and lands on the sign-in", async () => {
    signedIn();
    localStorage.setItem("uk_textile_token", "hr-token");
    mount("/reception/console");
    await waitFor(() => byId("reception-sign-out") !== null, "the console");
    click(byId("reception-sign-out"));
    await waitFor(() => byId("reception-sign-out-confirm") !== null, "the confirm");
    expect(window.location.pathname).toBe("/reception/console");
    click(byId("reception-sign-out-confirm"));
    await waitFor(() => window.location.pathname === "/reception-login", "the sign-in");
    const logout = calls.find((c) => c.url.endsWith("/api/reception-devices/logout"))!;
    expect([logout.method, logout.auth]).toEqual(["POST", "Bearer desk-token"]);
    expect(localStorage.getItem("reception_device_token")).toBeNull();
    expect(localStorage.getItem("uk_textile_token")).toBe("hr-token");
    expect(text(document.querySelector("h1"))).toBe("Reception");
  });

  it("a desk switched off by HR is sent to the sign-in with the reason", async () => {
    signedIn();
    answer = (_m, url) =>
      url.includes("/api/reception-devices/")
        ? { status: 403, body: { error: "This desk's access has been revoked", code: "desk_revoked" } }
        : undefined;
    mount("/reception/console");
    await waitFor(() => window.location.pathname === "/reception-login", "the sign-in");
    expect(window.location.search).toBe("?ended=switched_off");
    await waitFor(() => text(document.body).includes("HR switched this desk off"), "the reason");
    expect(localStorage.getItem("reception_device_token")).toBeNull();
  });

  it("a session ended elsewhere (signed out, a new password) is sent to the sign-in", async () => {
    signedIn();
    answer = (_m, url) =>
      url.includes("/api/reception-devices/")
        ? { status: 401, body: { error: "This desk's sign-in has ended. Sign in again.", code: "session_ended" } }
        : undefined;
    mount("/reception/console");
    await waitFor(() => window.location.search === "?ended=signed_out", "the sign-in");
    expect(text(byId("reception-signin-ended"))).toContain("This desk was signed out");
    expect(localStorage.getItem("reception_device_token")).toBeNull();
    expect(localStorage.getItem("reception_device_name")).toBeNull();
  });

  it("without a desk sign-in it goes to the reception sign-in, not to an HR page", async () => {
    localStorage.setItem("uk_textile_token", "hr-token");
    mount("/reception/console");
    await waitFor(() => window.location.pathname === "/reception-login", "the sign-in");
    expect(calls.filter((c) => c.url.includes("/summary") || c.url.includes("/visits"))).toEqual([]);
  });
});

// ═══ Register visitor ════════════════════════════════════════════════════════════════════════════════════════════════

describe("registering a walk-in at the desk", () => {
  async function openRegister() {
    signedIn();
    localStorage.setItem("uk_textile_token", "hr-token");
    mount("/reception/console");
    await waitFor(() => text(document.body).includes("Asha Visitor"), "the visits");
    click(byId("reception-register"));
    await waitFor(() => byId("desk-register-form") !== null, "the dialog");
  }

  it("checks the visitor in with the desk token (never the HR one), with the employee looked up by phone", async () => {
    await openRegister();
    type(byId("register-phone") as HTMLInputElement, "98400 55555");
    type(byId("register-name") as HTMLInputElement, "Lakshmi Narayan");
    type(byId("register-company") as HTMLInputElement, "Lotus Mills");
    type(byId("register-purpose") as HTMLInputElement, "Invoice");
    click(buttonNamed("Yes"));
    await waitFor(() => byId("input-meeting-emp-phone") !== null, "the look-up");
    type(byId("input-meeting-emp-phone") as HTMLInputElement, "90000 11111");
    click(byId("button-lookup-employee"));
    await waitFor(() => text(document.body).includes("Karthik Raja"), "the matched employee");
    const lookup = calls.find((c) => c.url.endsWith("/api/reception-devices/host-lookup"))!;
    expect([lookup.method, lookup.auth, lookup.body]).toEqual(["POST", "Bearer desk-token", { phone: "90000 11111" }]);
    submit(byId("desk-register-form"));
    await waitFor(
      () => calls.some((c) => c.method === "POST" && c.url.endsWith("/api/reception-devices/visits")),
      "the save",
    );
    const save = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/reception-devices/visits"))!;
    expect(save.auth).toBe("Bearer desk-token");
    expect(save.body).toEqual({
      name: "Lakshmi Narayan",
      phone: "98400 55555",
      whomToMeet: "Karthik Raja",
      purpose: "Invoice",
      peopleCount: 1,
      meetingEmployeeId: 41,
      company: "Lotus Mills",
    });
    await waitFor(() => byId("desk-register-form") === null, "the dialog closed");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Lakshmi Narayan is checked in" }));
    await waitFor(() => text(document.body).includes("Lakshmi Narayan"), "the new row");
    expect(calls.every((c) => c.auth === null || c.auth === "Bearer desk-token")).toBe(true);
  });

  it("checks the form first and shows the server's words for a visitor still inside", async () => {
    await openRegister();
    submit(byId("desk-register-form"));
    await waitFor(() => byId("register-error") !== null, "the error");
    expect(text(byId("register-error"))).toContain("phone number");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/visits"))).toBe(false);

    answer = (method, url) =>
      method === "POST" && url.endsWith("/api/reception-devices/visits")
        ? {
            status: 409,
            body: {
              error: "Asha Visitor is already inside (checked in at 09:30).",
              code: "already_inside",
              visitId: 1,
            },
          }
        : undefined;
    type(byId("register-phone") as HTMLInputElement, "9876500011");
    type(byId("register-name") as HTMLInputElement, "Asha Visitor");
    type(input("meeting-whom"), "Accounts");
    type(byId("register-purpose") as HTMLInputElement, "Invoice");
    submit(byId("desk-register-form"));
    await waitFor(() => text(byId("register-error")).includes("already inside"), "the 409");
    expect(byId("register-open-visit")).toBeNull();
    expect(byId("desk-register-form")).not.toBeNull();
  });
});

// ═══ Records and files ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("the desk's records and files", () => {
  it("asks the server for the chosen dates, status and search", async () => {
    signedIn();
    mount("/reception/console?view=records");
    const today = istDateKey(new Date());
    const visitCalls = () =>
      calls.filter((c) => c.method === "GET" && c.url.includes("/api/reception-devices/visits?"));
    await waitFor(() => visitCalls().length > 0, "the records");
    const first = new URL(visitCalls()[0].url, "http://x").searchParams;
    expect([first.get("from"), first.get("to"), first.has("range")]).toEqual([today, today, false]);
    expect(visitCalls()[0].auth).toBe("Bearer desk-token");
    choose(byId("desk-records-status") as HTMLSelectElement, "inside");
    await waitFor(
      () => visitCalls().some((c) => new URL(c.url, "http://x").searchParams.get("status") === "inside"),
      "the status",
    );
    const search = byId("desk-records-search") as HTMLInputElement;
    type(search, "asha");
    press(search, "Enter");
    await waitFor(
      () => visitCalls().some((c) => new URL(c.url, "http://x").searchParams.get("q") === "asha"),
      "the search",
    );
    expect(window.location.search).toContain("q=asha");
  });

  it("the records file goes with the desk token and the filters", async () => {
    signedIn();
    localStorage.setItem("uk_textile_token", "hr-token");
    mount("/reception/console?view=records&q=asha");
    await waitFor(() => byId("desk-records-export") !== null, "the export");
    press(byId("desk-records-export")!, "Enter");
    await waitFor(() => byId("desk-records-export-xlsx") !== null, "the menu");
    click(byId("desk-records-export-xlsx"));
    await waitFor(() => h.download.mock.calls.length === 1, "the download");
    const opts = h.download.mock.calls[0][0] as {
      path: string;
      format: string;
      query: URLSearchParams;
      token: () => string | null;
    };
    expect([opts.path, opts.format]).toEqual(["/api/reception-devices/visits/export", "xlsx"]);
    expect(opts.query.get("q")).toBe("asha");
    expect(opts.query.get("from")).toBe(istDateKey(new Date()));
    expect(opts.query.has("page")).toBe(false);
    expect(opts.token()).toBe("desk-token");
    await waitFor(() => h.toast.mock.calls.some((c) => c[0]?.title === "File downloaded"), "the toast");
  });

  it("today's list exports its range, and a refused file finds out whether the session ended", async () => {
    signedIn();
    mount("/reception/console");
    await waitFor(() => text(document.body).includes("Asha Visitor"), "the visits");
    click(byId("reception-range-week"));
    await waitFor(() => text(document.body).includes("Visitors - This week"), "the week");
    const { GateDownloadError } = await import("@/pages/hr/outpass-visitors/kit/download");
    h.download.mockRejectedValueOnce(new GateDownloadError("Your sign-in has ended.", 401));
    answer = (_m, url) =>
      url.endsWith("/api/reception-devices/me")
        ? { status: 401, body: { error: "This desk's sign-in has ended. Sign in again.", code: "session_ended" } }
        : undefined;
    press(byId("reception-export")!, "Enter");
    await waitFor(() => byId("reception-export-pdf") !== null, "the menu");
    click(byId("reception-export-pdf"));
    await waitFor(() => window.location.search === "?ended=signed_out", "the sign-in");
    const opts = h.download.mock.calls[0][0] as { query: Record<string, string>; format: string };
    expect([opts.format, opts.query]).toEqual(["pdf", { range: "week" }]);
  });
});
