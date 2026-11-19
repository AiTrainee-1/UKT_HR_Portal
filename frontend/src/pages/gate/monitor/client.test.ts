import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The gate monitor's own client: it sends the GATE token and nothing else (never the HR sign-in that customFetch would
// fall back to), and when the server says the gate's sign-in is over it clears the three gate keys and goes to the gate
// sign-in page with the reason.

const h = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@/pages/hr/outpass-visitors/kit/download", async (original) => ({
  ...(await original<typeof import("@/pages/hr/outpass-visitors/kit/download")>()),
  downloadGateFile: h.download,
}));

import { GateDownloadError } from "@/pages/hr/outpass-visitors/kit/download";
import {
  ENDED_MESSAGES,
  GateApiError,
  GateSessionEndedError,
  endedMessage,
  gateExport,
  gateLogin,
  gateLoginInfo,
  gateLogout,
  gateMe,
  gateRecords,
  gateScan,
  readGateSession,
  resetGateSessionEnd,
  saveGateSession,
  sessionEndReason,
  setGateNavigator,
} from "./client";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let navigated: string[] = [];

function reply(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function serve(handler: (call: Call) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        url,
        method: init.method ?? "GET",
        headers: { ...(init.headers as Record<string, string>) },
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return handler(call);
    }),
  );
}

const GATE = {
  id: 7,
  name: "Main Gate",
  branchName: "Head Office",
  location: null,
  allowOutpass: true,
  allowTeaBreak: true,
};

function signIn(token = "gate-token") {
  localStorage.setItem("gate_device_token", token);
  localStorage.setItem("gate_device_id", "7");
  localStorage.setItem("gate_device_name", "Main Gate");
}

beforeEach(() => {
  localStorage.clear();
  // an HR session in the same browser: it must never reach a gate endpoint
  localStorage.setItem("uk_textile_token", "HR-TOKEN");
  calls = [];
  navigated = [];
  setGateNavigator((to) => navigated.push(to));
  resetGateSessionEnd();
  h.download.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setGateNavigator(null);
});

const gateKeys = () => ["gate_device_token", "gate_device_id", "gate_device_name"].map((k) => localStorage.getItem(k));

describe("tokens", () => {
  it("signs in with no token at all, even with an HR session in the browser", async () => {
    serve(() => reply(200, { token: "new-gate-token", gate: GATE }));
    const res = await gateLogin("  Main.Gate1 ", "secret");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/gate-monitor/login");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[0].body).toEqual({ username: "Main.Gate1", password: "secret" });
    saveGateSession(res);
    expect(gateKeys()).toEqual(["new-gate-token", "7", "Main Gate"]);
    expect(readGateSession()).toEqual({ token: "new-gate-token", gateId: 7, gateName: "Main Gate" });
  });

  it("sends the gate token, never the HR one, on every gate call", async () => {
    signIn();
    serve((c) =>
      reply(
        200,
        c.url.startsWith("/api/gate-monitor/records")
          ? { items: [], total: 0, page: 1, pageSize: 8 }
          : { gate: GATE, session: null, expiresAt: null },
      ),
    );
    await gateMe();
    await gateRecords({ from: "2026-11-18", to: "2026-11-18", type: "", page: 1, pageSize: 8 });
    expect(calls.map((c) => c.headers.Authorization)).toEqual(["Bearer gate-token", "Bearer gate-token"]);
    expect(JSON.stringify(calls)).not.toContain("HR-TOKEN");
    // empty filters are left out of the address
    expect(calls[1].url).toBe("/api/gate-monitor/records?from=2026-11-18&to=2026-11-18&page=1&pageSize=8");
  });

  it("with no gate token it sends nothing and goes to the sign-in", async () => {
    serve(() => reply(200, {}));
    await expect(gateMe()).rejects.toBeInstanceOf(GateSessionEndedError);
    expect(calls).toHaveLength(0);
    expect(navigated).toEqual(["/gatemonitor?ended=signed_out"]);
  });

  it("stores a renewed token and the gate's current name", async () => {
    signIn("old-token");
    serve(() => reply(200, { gate: { ...GATE, name: "North Gate" }, session: null, expiresAt: null, token: "fresh" }));
    await gateMe();
    expect(gateKeys()).toEqual(["fresh", "7", "North Gate"]);
  });

  it("asks the login-info hint without a token and is quiet when the link is unknown", async () => {
    serve((c) =>
      c.url.endsWith("/known")
        ? reply(200, { gateName: "Main Gate", branchName: "HO", isActive: true })
        : reply(404, { error: "x" }),
    );
    expect(await gateLoginInfo("known")).toEqual({ gateName: "Main Gate", branchName: "HO", isActive: true });
    expect(await gateLoginInfo("nope")).toBeNull();
    expect(await gateLoginInfo("")).toBeNull();
    expect(calls.map((c) => [c.url, c.headers.Authorization])).toEqual([
      ["/api/gate-devices/login-info/known", undefined],
      ["/api/gate-devices/login-info/nope", undefined],
    ]);
  });
});

describe("a sign-in that is over", () => {
  it.each([
    [401, { error: "This gate's sign-in has ended. Sign in again.", code: "session_ended" }, "signed_out"],
    [403, { error: "This gate's access has been revoked", code: "gate_revoked" }, "switched_off"],
    [401, { error: "Invalid or expired token" }, "expired"],
    [403, { error: "This token cannot be used here" }, "signed_out"],
  ])("%i %j clears the gate keys and opens the sign-in with ?ended=%s", async (status, body, reason) => {
    signIn();
    serve(() => reply(status, body));
    const err = await gateMe().catch((e) => e);
    expect(err).toBeInstanceOf(GateSessionEndedError);
    expect(err.reason).toBe(reason);
    expect(gateKeys()).toEqual([null, null, null]);
    expect(localStorage.getItem("uk_textile_token")).toBe("HR-TOKEN"); // the HR session is not the gate's to end
    expect(navigated).toEqual([`/gatemonitor?ended=${reason}`]);
  });

  it("the first answer decides the reason when several calls find out together", async () => {
    signIn();
    serve(() => reply(403, { error: "revoked", code: "gate_revoked" }));
    await gateMe().catch(() => null);
    await gateMe().catch(() => null); // no token any more: would say "signed_out"
    expect(navigated).toEqual(["/gatemonitor?ended=switched_off"]);
  });

  it("knows which answers end a session", () => {
    expect(sessionEndReason(401, null)).toBe("expired");
    expect(sessionEndReason(403, { result: "not_allowed_here", message: "x" })).toBeNull();
    expect(sessionEndReason(403, { error: "permission_denied" })).toBeNull();
    expect(sessionEndReason(409, { code: "session_ended" })).toBeNull();
    expect(endedMessage("switched_off")).toBe(ENDED_MESSAGES.switched_off);
    expect(endedMessage("nonsense")).toBeNull();
    expect(endedMessage(null)).toBeNull();
  });
});

describe("scan", () => {
  it("hands back a refused scan's answer (403 not_allowed_here, 409, 410) without ending anything", async () => {
    signIn();
    const answers = [
      reply(403, { result: "not_allowed_here", message: "This gate does not take gate passes." }),
      reply(409, { result: "already_scanned", message: "Already exited", scanType: "exit" }),
      reply(410, { result: "expired", message: "This Outpass has expired." }),
    ];
    serve(() => answers.shift()!);
    expect((await gateScan("P.1.2.SIG")).result).toBe("not_allowed_here");
    expect((await gateScan("P.1.2.SIG")).result).toBe("already_scanned");
    expect((await gateScan("P.1.2.SIG")).result).toBe("expired");
    expect(calls[0].body).toEqual({ qrToken: "P.1.2.SIG" });
    expect(navigated).toEqual([]);
    expect(gateKeys()[0]).toBe("gate-token");
  });

  it("a lost connection is a GateApiError with status 0, not a sign-out", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const err = await gateScan("P.1.2.SIG").catch((e) => e);
    expect(err).toBeInstanceOf(GateApiError);
    expect(err.status).toBe(0);
    expect(navigated).toEqual([]);
  });

  it("an error with no result body throws the server's words", async () => {
    signIn();
    serve(() => reply(500, { error: "boom" }));
    await expect(gateScan("x")).rejects.toThrow("boom");
  });
});

describe("sign out", () => {
  it("tells the server with the gate token, then forgets the session even when the server cannot be reached", async () => {
    signIn();
    serve(() => reply(204));
    await gateLogout();
    expect(calls).toEqual([
      {
        url: "/api/gate-monitor/logout",
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer gate-token" }),
        body: undefined,
      },
    ]);
    expect(gateKeys()).toEqual([null, null, null]);

    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    await expect(gateLogout()).resolves.toBeUndefined();
    expect(gateKeys()).toEqual([null, null, null]);
    expect(localStorage.getItem("uk_textile_token")).toBe("HR-TOKEN");
  });
});

describe("export", () => {
  it("downloads with the gate token getter", async () => {
    signIn();
    h.download.mockResolvedValue("gate_records_main_gate_20261118_0900.xlsx");
    const name = await gateExport("xlsx", { from: "2026-11-18", to: "2026-11-18" });
    expect(name).toBe("gate_records_main_gate_20261118_0900.xlsx");
    const opts = h.download.mock.calls[0][0];
    expect(opts.path).toBe("/api/gate-monitor/records/export");
    expect(opts.format).toBe("xlsx");
    expect(opts.token()).toBe("gate-token");
  });

  it("a 401 from the file checks the session, which ends it", async () => {
    signIn();
    h.download.mockRejectedValue(new GateDownloadError("ended", 401));
    serve(() => reply(401, { error: "ended", code: "session_ended" }));
    await expect(gateExport("pdf", {})).rejects.toBeInstanceOf(GateSessionEndedError);
    expect(navigated).toEqual(["/gatemonitor?ended=signed_out"]);
  });

  it("another failure is passed on for the menu's toast", async () => {
    signIn();
    h.download.mockRejectedValue(new GateDownloadError("Too many rows for one file. Narrow the dates.", 413));
    await expect(gateExport("pdf", {})).rejects.toThrow("Too many rows");
    expect(navigated).toEqual([]);
  });
});
