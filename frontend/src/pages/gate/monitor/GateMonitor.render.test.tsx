import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Router, Switch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The gate monitor in a browser-like DOM: the sign-in (no token sent, errors in plain words, already-signed-in forward,
// why a sign-in ended), and the console (the gate's own token on every call, scanning by typed code and by the scanner,
// the colour the whole page takes for each answer and how it fades, the tea-break cooldown and return, an answer it does
// not know, no connection, the heartbeat, a sign-in that ends, Sign out to the gate's own page, the records view).

const h = vi.hoisted(() => ({ toast: vi.fn(), speak: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
// what the console says out loud (the real one needs the browser's speech, which jsdom has not got)
vi.mock("./scanner", async (original) => ({
  ...(await original<typeof import("./scanner")>()),
  speak: h.speak,
}));

import GateMonitorConsole, { GLOW_MS } from "./GateMonitorConsole";
import GateMonitorLogin from "./GateMonitorLogin";
import { resetGateSessionEnd } from "./client";

const GATE = {
  id: 7,
  name: "Main Gate",
  branchName: "Head Office",
  location: null,
  allowOutpass: true,
  allowTeaBreak: true,
};
const SUMMARY = {
  exits: 42,
  returns: 38,
  teaOut: 61,
  teaIn: 60,
  denied: 2,
  total: 203,
  passesOutNow: 4,
  teaOutNow: 1,
  outNow: 5,
  date: "2026-11-18",
};
const ROW = {
  id: "scan-1",
  at: new Date().toISOString(),
  type: "exit",
  result: "allowed",
  reason: null,
  reasonLabel: null,
  message: "Exit recorded via Main Gate",
  gateId: 7,
  gateName: "Main Gate",
  employee: { id: 1, employeeCode: "30020", name: "Rajesh Kumar", department: "Spinning", photoUrl: null },
  destination: "Bank, Peelamedu",
  passId: 3,
  minutes: null,
};
const DENIED_ROW = {
  ...ROW,
  id: "scan-2",
  result: "denied",
  reason: "expired",
  reasonLabel: "Pass expired",
  employee: { ...ROW.employee, id: 2, employeeCode: "31005", name: "Manoj Kumar" },
};
const EXIT_OK = {
  result: "success",
  scanType: "exit",
  message: "Exit recorded via Main Gate",
  employee: { name: "Rajesh Kumar", employeeCode: "30020", department: "Spinning", photoUrl: null },
  destination: "Bank, Peelamedu",
  reason: "Cash",
  approvedBy: "Priya",
  approverRole: "hr",
  approvedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  gateName: null,
  exitedAt: null,
  entryGateName: null,
  enteredAt: null,
};

type Call = { method: string; path: string; query: URLSearchParams; auth: string | undefined; body: unknown };
type Answer = { status: number; body?: unknown };
let calls: Call[] = [];
let answers: Record<string, (call: Call) => Answer | Promise<Answer>>;

function defaultAnswers(): Record<string, (call: Call) => Answer | Promise<Answer>> {
  return {
    "POST /api/gate-monitor/login": () => ({ status: 200, body: { token: "gate-token", gate: GATE } }),
    "GET /api/gate-monitor/me": () => ({ status: 200, body: { gate: GATE, session: null, expiresAt: null } }),
    "GET /api/gate-monitor/summary": () => ({ status: 200, body: SUMMARY }),
    "GET /api/gate-monitor/records": (c) => ({
      status: 200,
      body: {
        items: [ROW, DENIED_ROW],
        total: 2,
        page: Number(c.query.get("page") ?? 1),
        pageSize: Number(c.query.get("pageSize") ?? 25),
        counts: { exits: 1, returns: 0, teaOut: 0, teaIn: 0, denied: 1, total: 2 },
      },
    }),
    "POST /api/gate-monitor/scan": () => ({ status: 200, body: EXIT_OK }),
    "POST /api/gate-monitor/logout": () => ({ status: 204 }),
    "GET /api/gate-devices/login-info/old-link": () => ({
      status: 200,
      body: { gateName: "Main Gate", branchName: "Head Office", isActive: true },
    }),
  };
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const [path, qs = ""] = url.split("?");
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call: Call = {
        method: init.method ?? "GET",
        path,
        query: new URLSearchParams(qs),
        auth: headers.Authorization,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const answer = answers[`${call.method} ${path}`];
      if (!answer) throw new Error(`unexpected ${call.method} ${url}`);
      const { status, body } = await answer(call);
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let location: ReturnType<typeof memoryLocation>;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("uk_textile_token", "HR-TOKEN"); // an HR session in the same browser
  calls = [];
  answers = defaultAnswers();
  installFetch();
  resetGateSessionEnd();
  h.toast.mockReset();
  h.speak.mockReset();
  h.speak.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function signIn(token = "gate-token") {
  localStorage.setItem("gate_device_token", token);
  localStorage.setItem("gate_device_id", "7");
  localStorage.setItem("gate_device_name", "Main Gate");
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(path: string) {
  location = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <Router hook={location.hook} searchHook={location.searchHook}>
          <Switch>
            <Route path="/gatemonitor/console" component={GateMonitorConsole} />
            <Route path="/gatemonitor" component={GateMonitorLogin} />
            <Route>{() => <p data-testid="elsewhere">somewhere else</p>}</Route>
          </Switch>
        </Router>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const here = () => location.history!.at(-1)!;
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const byTestId = (id: string) => q(`[data-testid="${id}"]`);
const text = () => document.body.textContent ?? "";

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

async function submit(form: Element | null) {
  expect(form).not.toBeNull();
  await act(async () => {
    (form as HTMLFormElement).requestSubmit();
  });
  await settle();
}

const gateCalls = () => calls.filter((c) => c.path.startsWith("/api/gate-monitor/") && !c.path.endsWith("/login"));

describe("sign-in", () => {
  it("signs a gate in without sending any token and opens its console", async () => {
    await mount("/gatemonitor");
    expect(q("h1")?.textContent).toBe("Sign in to your gate");
    expect(text()).toContain("UK Textiles HRMS");
    expect(text()).toContain("Stays signed in on this device until you sign out.");
    await type(q<HTMLInputElement>("#gate-monitor-username")!, " main.gate1 ");
    await type(q<HTMLInputElement>("#gate-monitor-password")!, "secret-one");
    await submit(byTestId("gate-monitor-login"));

    const login = calls.find((c) => c.path === "/api/gate-monitor/login")!;
    expect(login.auth).toBeUndefined();
    expect(login.body).toEqual({ username: "main.gate1", password: "secret-one" });
    expect(localStorage.getItem("gate_device_token")).toBe("gate-token");
    expect(localStorage.getItem("gate_device_id")).toBe("7");
    expect(localStorage.getItem("gate_device_name")).toBe("Main Gate");
    expect(here()).toBe("/gatemonitor/console");
    expect(byTestId("gate-name")?.textContent).toContain("Main Gate");
  });

  it("shows the server's plain words for a wrong password and clears the password box", async () => {
    answers["POST /api/gate-monitor/login"] = () => ({
      status: 401,
      body: { error: "Wrong username or password.", code: "wrong" },
    });
    await mount("/gatemonitor");
    await type(q<HTMLInputElement>("#gate-monitor-username")!, "main.gate1");
    await type(q<HTMLInputElement>("#gate-monitor-password")!, "nope");
    await submit(byTestId("gate-monitor-login"));
    expect(byTestId("gate-signin-error")?.textContent).toBe("Wrong username or password.");
    expect(q<HTMLInputElement>("#gate-monitor-password")!.value).toBe("");
    expect(localStorage.getItem("gate_device_token")).toBeNull();
    expect(here()).toBe("/gatemonitor");
  });

  it("says a switched-off gate and too many tries in the server's words", async () => {
    const replies: Answer[] = [
      { status: 403, body: { error: "This gate is switched off. Ask HR to switch it on.", code: "switched_off" } },
      { status: 429, body: { error: "Too many wrong tries. Wait 15 minutes or ask HR to reset the password." } },
    ];
    answers["POST /api/gate-monitor/login"] = () => replies.shift()!;
    await mount("/gatemonitor");
    for (const expected of ["This gate is switched off.", "Too many wrong tries."]) {
      await type(q<HTMLInputElement>("#gate-monitor-username")!, "main.gate1");
      await type(q<HTMLInputElement>("#gate-monitor-password")!, "secret-one");
      await submit(byTestId("gate-monitor-login"));
      expect(byTestId("gate-signin-error")?.textContent).toContain(expected);
    }
  });

  it("shows and hides the password", async () => {
    await mount("/gatemonitor");
    const input = q<HTMLInputElement>("#gate-monitor-password")!;
    expect(input.type).toBe("password");
    await click(q('[aria-label="Show password"]'));
    expect(input.type).toBe("text");
    await click(q('[aria-label="Hide password"]'));
    expect(input.type).toBe("password");
  });

  it("forwards a browser that is already signed in to the console", async () => {
    signIn();
    await mount("/gatemonitor");
    expect(here()).toBe("/gatemonitor/console");
  });

  it("says why the sign-in ended and forgets any gate keys left behind", async () => {
    signIn();
    await mount("/gatemonitor?ended=switched_off");
    expect(here()).toBe("/gatemonitor?ended=switched_off");
    expect(byTestId("gate-signin-ended")?.textContent).toContain("This gate was switched off by HR.");
    expect(localStorage.getItem("gate_device_token")).toBeNull();
    expect(localStorage.getItem("uk_textile_token")).toBe("HR-TOKEN");
  });

  it("names the gate of an old per-gate link, asked without a token", async () => {
    await mount("/gatemonitor?gate=old-link");
    expect(byTestId("gate-signin-subtitle")?.textContent).toContain("Signing in to Main Gate, Head Office.");
    expect(calls.find((c) => c.path.startsWith("/api/gate-devices/login-info"))?.auth).toBeUndefined();
  });
});

describe("console", () => {
  it("sends a browser with no gate session to the gate sign-in, never to an HR page", async () => {
    await mount("/gatemonitor/console");
    expect(here()).toBe("/gatemonitor");
    expect(calls).toHaveLength(0);
  });

  it("shows the gate, today's counters and the latest scans, asking with the gate token only", async () => {
    signIn();
    await mount("/gatemonitor/console");
    expect(byTestId("gate-name")?.textContent).toBe("Main Gate · Head Office");
    expect(text()).toContain("UK Textiles HRMS");
    expect(text()).toContain("Today at this gate");
    expect(byTestId("today-exits-value")?.textContent).toBe("42");
    expect(byTestId("today-denied-value")?.textContent).toBe("2");
    expect(byTestId("today-out-now")?.textContent).toContain("4 on a gate pass, 1 on a tea break");
    const rows = document.querySelectorAll('[data-testid="latest-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Rajesh Kumar");
    expect(rows[1].textContent).toContain("Pass expired");
    expect(text()).toContain("You see only this gate's records.");
    expect(byTestId("gate-connection")?.dataset.online).toBe("yes");

    const seen = gateCalls();
    expect(seen.map((c) => c.path).sort()).toEqual(
      ["/api/gate-monitor/me", "/api/gate-monitor/records", "/api/gate-monitor/summary"].sort(),
    );
    expect(new Set(seen.map((c) => c.auth))).toEqual(new Set(["Bearer gate-token"]));
    const latest = seen.find((c) => c.path === "/api/gate-monitor/records")!;
    expect(latest.query.get("from")).toBe(latest.query.get("to"));
    expect(latest.query.get("gateId")).toBeNull();
  });

  it("checks a typed code and shows the answer in the big banner", async () => {
    signIn();
    await mount("/gatemonitor/console");
    calls = [];
    await type(q<HTMLInputElement>("#gate-code")!, "P.1A.2B.SIGNATURE");
    await submit(byTestId("code-form"));
    const scan = calls.find((c) => c.path === "/api/gate-monitor/scan")!;
    expect(scan.body).toEqual({ qrToken: "P.1A.2B.SIGNATURE" });
    expect(scan.auth).toBe("Bearer gate-token");
    const banner = byTestId("scan-result")!;
    expect(banner.dataset.tone).toBe("green");
    expect(byTestId("scan-result-title")?.textContent).toBe("Allowed - exit recorded");
    // the whole page answers: the page, the edge light and the scanner card take the colour
    expect(byTestId("gate-monitor-console")?.dataset.scanTone).toBe("green");
    expect(byTestId("scan-glow")?.dataset.gkTone).toBe("green");
    expect(byTestId("scan-glow")?.dataset.on).toBe("true");
    expect(byTestId("scan-card")?.dataset.on).toBe("true");
    expect(byTestId("scan-zone")?.dataset.state).toBe("green");
    expect(byTestId("scan-zone")?.textContent).toContain("Allowed - exit recorded");
    expect(byTestId("scan-glyph")?.dataset.glyph).toBe("check");
    // and says it, in words and aloud (colour is never the only signal)
    expect(byTestId("scan-announce")?.textContent).toContain("Allowed - exit recorded. Rajesh Kumar.");
    expect(byTestId("scan-announce")?.getAttribute("aria-live")).toBe("assertive");
    expect(h.speak.mock.calls).toEqual([["Approved. You may go."]]);
    expect(banner.textContent).toContain("Rajesh Kumar");
    expect(banner.textContent).toContain("Bank, Peelamedu");
    expect(banner.textContent).toContain("Approved by");
    // the counters and the list are read again
    expect(calls.some((c) => c.path === "/api/gate-monitor/summary")).toBe(true);
    await click(byTestId("scan-result-done"));
    expect(byTestId("scan-result")).toBeNull();
    expect(byTestId("gate-monitor-console")?.dataset.scanTone).toBe("idle");
  });

  it("scans from the keyboard-wedge scanner anywhere on the page, once per pass", async () => {
    signIn();
    await mount("/gatemonitor/console");
    calls = [];
    const burst = async (code: string) => {
      await act(async () => {
        for (const key of [...code, "Enter"]) {
          window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        }
      });
      await settle();
    };
    await burst("T.1A.ABCDEFGHIJKLMNOP");
    await burst("T.1A.ABCDEFGHIJKLMNOP"); // the scanner fired twice
    expect(calls.filter((c) => c.path === "/api/gate-monitor/scan").map((c) => c.body)).toEqual([
      { qrToken: "T.1A.ABCDEFGHIJKLMNOP" },
    ]);
  });

  it("shows and says only the latest scan when an earlier answer comes back after it", async () => {
    signIn();
    const later: ((a: Answer) => void)[] = [];
    const slow = (): Promise<Answer> => new Promise((resolve) => later.push(resolve));
    const TEA_OUT = { result: "success", action: "out", kind: "tea_break", message: "Tea break started" };
    const replies: (() => Answer | Promise<Answer>)[] = [
      slow, // 1: the typed code, slow
      () => ({ status: 200, body: TEA_OUT }), // 2: the scanner, while 1 still waits
      slow, // 3: the scanner, slow
      () => ({ status: 200, body: TEA_OUT }), // 4: the scanner again, while 3 still waits
    ];
    answers["POST /api/gate-monitor/scan"] = () => replies.shift()!();
    await mount("/gatemonitor/console");
    const burst = async (code: string) => {
      await act(async () => {
        for (const key of [...code, "Enter"])
          window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
      await settle();
    };

    // the typed-code path, then the scanner while it waits
    await type(q<HTMLInputElement>("#gate-code")!, "P.1A.FIRST.SIGNATURE");
    await submit(byTestId("code-form"));
    await burst("T.1A.SECONDCODE00001");
    expect(byTestId("scan-result-title")?.textContent).toBe("Tea break started");
    expect(h.speak.mock.calls).toEqual([["Tea break started."]]);
    await act(async () => later.shift()!({ status: 200, body: EXIT_OK })); // the first answer, late
    await settle();
    expect(byTestId("scan-result-title")?.textContent).toBe("Tea break started");
    expect(h.speak.mock.calls).toEqual([["Tea break started."]]);

    // the scanner twice: the first answer, late, is not shown or said either
    h.speak.mockClear();
    await burst("P.1A.THIRDCODE000001");
    await burst("T.1A.FOURTHCODE00001");
    await act(async () =>
      later.shift()!({ status: 409, body: { result: "already_scanned", message: "Already exited" } }),
    );
    await settle();
    expect(byTestId("scan-result-title")?.textContent).toBe("Tea break started");
    expect(byTestId("scan-result")?.dataset.tone).toBe("green");
    expect(h.speak.mock.calls).toEqual([["Tea break started."]]);
    // every scan reached the server once
    expect(calls.filter((c) => c.path === "/api/gate-monitor/scan").map((c) => c.body)).toEqual([
      { qrToken: "P.1A.FIRST.SIGNATURE" },
      { qrToken: "T.1A.SECONDCODE00001" },
      { qrToken: "P.1A.THIRDCODE000001" },
      { qrToken: "T.1A.FOURTHCODE00001" },
    ]);
  });

  it("shows a refused kind and an answer it does not know without crashing", async () => {
    signIn();
    const replies: Answer[] = [
      {
        status: 403,
        body: { result: "not_allowed_here", kind: "tea_break", message: "This gate does not take tea-break scans." },
      },
      { status: 200, body: { result: "brand_new_result", message: "Something new" } },
      { status: 500, body: { error: "Server error" } },
    ];
    answers["POST /api/gate-monitor/scan"] = () => replies.shift()!;
    await mount("/gatemonitor/console");
    await type(q<HTMLInputElement>("#gate-code")!, "T.1.SIG");
    await submit(byTestId("code-form"));
    expect(byTestId("scan-result-title")?.textContent).toBe("Denied - no tea breaks at this gate");
    expect(byTestId("scan-result")?.dataset.tone).toBe("red");
    expect(byTestId("gate-monitor-console")?.dataset.scanTone).toBe("red");
    expect(byTestId("scan-glyph")?.dataset.glyph).toBe("cross");
    expect(byTestId("scan-result")?.textContent).toContain("Tea break");
    await type(q<HTMLInputElement>("#gate-code")!, "T.2.SIG");
    await submit(byTestId("code-form"));
    expect(byTestId("scan-result-title")?.textContent).toBe("Check with HR");
    await type(q<HTMLInputElement>("#gate-code")!, "T.3.SIG");
    await submit(byTestId("code-form"));
    expect(byTestId("scan-result-title")?.textContent).toBe("Check with HR");
    expect(byTestId("scan-result-message")?.textContent).toBe("Server error");
    expect(byTestId("gate-monitor-console")?.dataset.scanTone).toBe("neutral");
  });

  it("answers a repeat tea-break scan in the cooldown in orange, with when to scan again and a countdown", async () => {
    signIn();
    const now = Date.now();
    answers["POST /api/gate-monitor/scan"] = () => ({
      status: 409,
      body: {
        result: "cooldown",
        kind: "tea_break",
        lastAction: "out",
        lastScanAt: new Date(now - 88_000).toISOString(),
        retryAt: new Date(now + 212_000).toISOString(),
        waitSeconds: 212,
        cooldownMinutes: 5,
        message: "Already scanned at 10:05 (tea break started). Scan again after 10:10.",
        employee: { id: 4, name: "Priya S", employeeCode: "30111", department: "Weaving", photoUrl: null },
      },
    });
    await mount("/gatemonitor/console");
    await type(q<HTMLInputElement>("#gate-code")!, "T.1A.COOLDOWNCODE01");
    await submit(byTestId("code-form"));
    expect(byTestId("gate-monitor-console")?.dataset.scanTone).toBe("orange");
    expect(byTestId("scan-result")?.dataset.result).toBe("cooldown");
    expect(byTestId("scan-result")?.dataset.tone).toBe("orange");
    expect(byTestId("scan-result-title")?.textContent).toBe("Already scanned - please wait");
    expect(byTestId("scan-result-message")?.textContent).toMatch(
      /^Already scanned at \d\d:\d\d - tea break started\. Scan again after \d\d:\d\d\.$/,
    );
    expect(byTestId("scan-zone-note")?.textContent).toBe(byTestId("scan-result-message")?.textContent);
    expect(byTestId("scan-result-countdown")?.textContent).toMatch(/^Scan again in 3:3[0-2]$/);
    expect(byTestId("scan-glyph")?.dataset.glyph).toBe("wait");
    expect(byTestId("scan-result")?.textContent).toContain("Priya S");
    expect(h.speak.mock.calls).toEqual([["Already scanned. Please wait."]]);
  });

  it("shows a tea-break return in its own colour, and a break over the allowed time as a warning", async () => {
    signIn();
    const replies: Answer[] = [
      { status: 200, body: { result: "success", action: "out", kind: "tea_break", message: "Tea break started" } },
      {
        status: 200,
        body: {
          result: "success",
          action: "in",
          kind: "tea_break",
          takenMinutes: 18,
          allowedMinutes: 15,
          message: "Tea break ended - 18 min, via Main Gate",
          employee: { id: 4, name: "Priya S", employeeCode: "30111", department: "Weaving", photoUrl: null },
        },
      },
    ];
    answers["POST /api/gate-monitor/scan"] = () => replies.shift()!;
    await mount("/gatemonitor/console");
    await type(q<HTMLInputElement>("#gate-code")!, "T.1A.BREAKSTART001");
    await submit(byTestId("code-form"));
    expect(byTestId("gate-monitor-console")?.dataset.scanTone).toBe("green");
    expect(byTestId("scan-result-title")?.textContent).toBe("Tea break started");
    await type(q<HTMLInputElement>("#gate-code")!, "T.1A.BREAKBACK0001");
    await submit(byTestId("code-form"));
    expect(byTestId("gate-monitor-console")?.dataset.scanTone).toBe("return");
    expect(byTestId("scan-glow")?.dataset.gkTone).toBe("return");
    expect(byTestId("scan-glyph")?.dataset.glyph).toBe("return");
    expect(byTestId("scan-result-title")?.textContent).toBe("Back from tea break - 18 min");
    expect(byTestId("scan-result-warning")?.textContent).toContain("Over the allowed 15 min by 3 min");
    expect(byTestId("scan-result")?.textContent).toContain("Time on break");
    expect(h.speak.mock.calls.at(-1)).toEqual(["Tea break ended. Over the allowed time."]);
  });

  it("fades the page back to Ready after a few seconds and keeps the result until the next scan", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    signIn();
    await mount("/gatemonitor/console");
    expect(byTestId("gate-monitor-console")?.dataset.scanTone).toBe("idle");
    expect(byTestId("scan-glow")).toBeNull(); // nothing lit before the first scan
    await type(q<HTMLInputElement>("#gate-code")!, "P.1A.2B.SIGNATURE");
    await submit(byTestId("code-form"));
    expect(byTestId("gate-monitor-console")?.dataset.scanTone).toBe("green");
    await act(async () => {
      vi.advanceTimersByTime(GLOW_MS - 500);
    });
    expect(byTestId("gate-monitor-console")?.dataset.scanTone).toBe("green");
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(byTestId("gate-monitor-console")?.dataset.scanTone).toBe("idle");
    expect(byTestId("scan-glow")?.dataset.on).toBe("false");
    expect(byTestId("scan-card")?.dataset.on).toBe("false");
    expect(byTestId("scan-zone")?.dataset.state).toBe("idle");
    expect(byTestId("scan-zone")?.textContent).toContain("Ready - scan a gate pass or tea-break QR");
    // the detail stays
    expect(byTestId("scan-result-title")?.textContent).toBe("Allowed - exit recorded");
  });

  it("shows no connection in grey when the scan cannot reach the server", async () => {
    signIn();
    await mount("/gatemonitor/console");
    const real = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/api/gate-monitor/scan")) throw new TypeError("Failed to fetch");
        return real(url, init);
      }),
    );
    await type(q<HTMLInputElement>("#gate-code")!, "P.1A.OFFLINECODE01");
    await submit(byTestId("code-form"));
    expect(byTestId("gate-monitor-console")?.dataset.scanTone).toBe("neutral");
    expect(byTestId("scan-result-title")?.textContent).toBe("No connection");
    expect(byTestId("scan-glyph")?.dataset.glyph).toBe("offline");
    expect(byTestId("gate-connection")?.dataset.online).toBe("no");
    expect(h.speak.mock.calls).toEqual([["No connection. Please try again."]]);
  });

  it("keeps a renewed token and checks the session again when the tab comes back", async () => {
    signIn("old-token");
    answers["GET /api/gate-monitor/me"] = () => ({
      status: 200,
      body: { gate: { ...GATE, name: "North Gate" }, session: null, expiresAt: null, token: "fresh-token" },
    });
    await mount("/gatemonitor/console");
    expect(localStorage.getItem("gate_device_token")).toBe("fresh-token");
    expect(localStorage.getItem("gate_device_name")).toBe("North Gate");
    expect(byTestId("gate-name")?.textContent).toContain("North Gate");
    const before = calls.filter((c) => c.path === "/api/gate-monitor/me").length;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    const me = calls.filter((c) => c.path === "/api/gate-monitor/me");
    expect(me.length).toBe(before + 1);
    expect(me.at(-1)!.auth).toBe("Bearer fresh-token");
  });

  it("goes to the gate sign-in with the reason when HR ends the session", async () => {
    signIn();
    answers["GET /api/gate-monitor/me"] = () => ({
      status: 401,
      body: { error: "This gate's sign-in has ended. Sign in again.", code: "session_ended" },
    });
    await mount("/gatemonitor/console");
    expect(here()).toBe("/gatemonitor?ended=signed_out");
    expect(localStorage.getItem("gate_device_token")).toBeNull();
    expect(localStorage.getItem("uk_textile_token")).toBe("HR-TOKEN");
    expect(byTestId("gate-signin-ended")?.textContent).toContain("This gate was signed out.");
  });

  it("says a switched-off gate when the gate was switched off", async () => {
    signIn();
    answers["GET /api/gate-monitor/summary"] = () => ({
      status: 403,
      body: { error: "This gate's access has been revoked", code: "gate_revoked" },
    });
    await mount("/gatemonitor/console");
    expect(here()).toBe("/gatemonitor?ended=switched_off");
    expect(text()).toContain("This gate was switched off by HR.");
  });

  it("signs out to the gate's own sign-in page after a confirm, ending the session on the server", async () => {
    signIn();
    await mount("/gatemonitor/console");
    await click(byTestId("gate-sign-out"));
    expect(text()).toContain("Sign out of Main Gate?");
    await click(byTestId("gate-sign-out-confirm"));
    const logout = calls.find((c) => c.path === "/api/gate-monitor/logout")!;
    expect(logout.method).toBe("POST");
    expect(logout.auth).toBe("Bearer gate-token");
    expect(localStorage.getItem("gate_device_token")).toBeNull();
    expect(localStorage.getItem("gate_device_id")).toBeNull();
    expect(localStorage.getItem("gate_device_name")).toBeNull();
    expect(localStorage.getItem("uk_textile_token")).toBe("HR-TOKEN");
    expect(here()).toBe("/gatemonitor");
    expect(q("h1")?.textContent).toBe("Sign in to your gate");
  });

  it("lists this gate's records for the chosen dates and type", async () => {
    signIn();
    await mount("/gatemonitor/console");
    await click(byTestId("view-records"));
    expect(here()).toBe("/gatemonitor/console?view=records");
    expect(byTestId("gate-records")).not.toBeNull();
    const first = calls.filter((c) => c.path === "/api/gate-monitor/records").at(-1)!;
    expect(first.query.get("pageSize")).toBe("25");
    expect(first.query.get("from")).toBeTruthy();
    expect(text()).toContain("2 records · 1 exits · 0 returns · 0 tea breaks · 1 denied");
    expect(text()).toContain("Denied · Pass expired");

    const select = q<HTMLSelectElement>('[data-testid="records-type"] select, select[data-testid="records-type"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "exit");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    const filtered = calls.filter((c) => c.path === "/api/gate-monitor/records").at(-1)!;
    expect(filtered.query.get("type")).toBe("exit");
    expect(filtered.query.get("gateId")).toBeNull();
    expect(filtered.auth).toBe("Bearer gate-token");
  });
});
