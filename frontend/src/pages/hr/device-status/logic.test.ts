import { describe, expect, it, vi } from "vitest";
import type { DeviceStatusRow, ProbeView } from "@/lib/api-client/custom-hooks";
import {
  describeClock,
  describeDelay,
  describePath,
  formatDelay,
  formatLatency,
  latencyTone,
  matchesFilter,
  matchesQuery,
  measureApiPath,
  overallVerdict,
  pathStats,
  pingSummary,
  readoutRows,
  relativeTime,
  sortDevices,
  summarizeCheck,
  timeZoneText,
  visibleDevices,
} from "./logic";

const NOW = new Date("2026-10-06T12:00:00Z").getTime();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function row(over: Partial<DeviceStatusRow> & { name?: string }): DeviceStatusRow {
  return {
    id: 1,
    name: "Gate 1",
    deviceType: "aiface_mars",
    host: "192.168.0.59",
    port: 4370,
    serialNumber: "SN1",
    isActive: true,
    privateAddress: true,
    status: "connected",
    statusLabel: "Connected",
    neverConnected: false,
    reach: "unchecked",
    reachLabel: "Not checked",
    reachIsFresh: false,
    headline: "",
    action: "",
    diagnosis: { headline: "", headlineLayer: null, action: "", layers: [], problems: [] },
    errors: [],
    push: {
      lastContactAt: null,
      lastHeartbeatAt: null,
      lastDataAt: null,
      lastPushAt: null,
      lastPunch: null,
      remoteIp: null,
      punchesToday: 0,
      delay: null,
      reportedConfig: null,
      reportedConfigAt: null,
      skippedIds: 0,
      skippedPunches: 0,
    },
    pull: { lastSyncAt: null, lastSyncError: null, lastSyncErrorAt: null, lastReachableAt: null, probe: null },
    ...over,
  };
}

const probe = (over: Partial<ProbeView>): ProbeView => ({
  checkedAt: ago(10),
  ageSeconds: 10,
  status: "reachable",
  latencyMs: 12,
  ping: { available: true, ok: true, ms: 2 },
  error: "",
  detail: null,
  steps: [],
  checkedFrom: null,
  ...over,
});

describe("times and sizes", () => {
  it("says how long ago in the unit a person would use", () => {
    expect(relativeTime(null)).toBe("never");
    expect(relativeTime(ago(3), NOW)).toBe("just now");
    expect(relativeTime(ago(40), NOW)).toBe("40 s ago");
    expect(relativeTime(ago(180), NOW)).toBe("3 min ago");
    expect(relativeTime(ago(2 * 3600), NOW)).toBe("2 h ago");
    expect(relativeTime(ago(5 * 86400), NOW)).toBe("5 days ago");
  });

  it("never reports a time in the future", () => {
    expect(relativeTime(new Date(NOW + 60000).toISOString(), NOW)).toBe("just now");
  });

  it("formats latency from sub-millisecond to seconds, and a missing one as a dash", () => {
    expect(formatLatency(null)).toBe("–");
    expect(formatLatency(0.4)).toBe("<1 ms");
    expect(formatLatency(12.4)).toBe("12 ms");
    expect(formatLatency(1250)).toBe("1.3 s");
  });

  it("colours a latency fast, slow or very slow around the threshold", () => {
    expect(latencyTone(null)).toBe("muted");
    expect(latencyTone(100)).toBe("good");
    expect(latencyTone(300)).toBe("warn");
    expect(latencyTone(900)).toBe("bad");
    expect(latencyTone(300, 400)).toBe("good");
  });

  it("describes how long punches take to arrive", () => {
    expect(formatDelay(4)).toBe("4 seconds");
    expect(formatDelay(1500)).toBe("25 minutes");
    expect(formatDelay(7200)).toBe("2 hours");
    expect(describeDelay(null).tone).toBe("muted");
    expect(describeDelay({ medianSeconds: 4, maxSeconds: 9, samples: 20, verdict: "realtime" })).toEqual({
      label: "Arrive in ~4 seconds",
      tone: "good",
    });
    expect(describeDelay({ medianSeconds: 1200, maxSeconds: 1500, samples: 5, verdict: "delayed" }).tone).toBe("warn");
    expect(describeDelay({ medianSeconds: 7200, maxSeconds: 9000, samples: 5, verdict: "batched" }).tone).toBe("bad");
  });

  it("turns the device clock and time zone into words", () => {
    expect(describeClock(undefined)).toBeNull();
    expect(describeClock(30)).toBe("in step with the server");
    expect(describeClock(450)).toBe("8 min ahead of the server");
    expect(describeClock(-7200)).toBe("2.0 h behind the server");
    expect(timeZoneText(330)).toBe("UTC+5:30");
    expect(timeZoneText(-300)).toBe("UTC-5:00");
    expect(timeZoneText(null)).toBeNull();
  });
});

describe("the ping tile", () => {
  it("is empty before any check", () => {
    expect(pingSummary(null).tone).toBe("muted");
  });

  it("shows the ping reply when there is one", () => {
    expect(pingSummary(probe({}))).toMatchObject({ value: "2 ms", sub: "Ping replied", tone: "good" });
  });

  it("falls back to the port time when the server has no ping program, and says so", () => {
    const s = pingSummary(probe({ ping: { available: false, ok: false, ms: null }, latencyMs: 30 }));
    expect(s).toMatchObject({ value: "30 ms", sub: "port connect time" });
  });

  it("says no reply, with the reason, when nothing answered", () => {
    const s = pingSummary(
      probe({
        status: "timeout",
        latencyMs: null,
        ping: { available: true, ok: false, ms: null },
        error: "No answer within 3 seconds",
      }),
    );
    expect(s).toMatchObject({ value: "No reply", tone: "bad" });
  });

  it("marks a slow answer", () => {
    expect(pingSummary(probe({ ping: null, latencyMs: 900 })).tone).toBe("bad");
  });

  it("says a cloud server cannot test a private address, instead of showing a failure", () => {
    const silent = probe({
      status: "timeout",
      latencyMs: null,
      ping: { available: false, ok: false, ms: null },
      error: "No answer within 3 seconds",
    });
    expect(pingSummary(silent, true)).toMatchObject({ value: "Not testable", tone: "muted" });
    expect(pingSummary(silent, false)).toMatchObject({ value: "No reply", tone: "bad" });
  });

  it("still shows a real answer even when the server is in the cloud", () => {
    expect(pingSummary(probe({}), true)).toMatchObject({ value: "2 ms", tone: "good" });
  });
});

describe("filtering and ordering the devices", () => {
  const devices = [
    row({ id: 1, name: "Stores", status: "connected" }),
    row({ id: 2, name: "Main gate", status: "disconnected", reach: "unreachable" }),
    row({ id: 3, name: "Canteen", status: "error", errors: [{ source: "push", message: "x", at: null }] }),
    row({ id: 4, name: "Old gate", status: "disabled", isActive: false, reach: "unreachable" }),
    row({ id: 5, name: "Back gate", status: "disconnected", reach: "refused", serialNumber: "CQIK9" }),
  ];

  it("each status filter counts what its card counts", () => {
    const ids = (f: Parameters<typeof matchesFilter>[1]) => devices.filter((d) => matchesFilter(d, f)).map((d) => d.id);
    expect(ids("all")).toEqual([1, 2, 3, 4, 5]);
    expect(ids("connected")).toEqual([1]);
    expect(ids("disconnected")).toEqual([2, 5]);
    expect(ids("error")).toEqual([3]);
    expect(ids("unreachable")).toEqual([2, 5]); // a switched-off device is not an unreachable device
  });

  it("searches name, address and serial number without regard to case", () => {
    expect(matchesQuery(devices[1], "MAIN")).toBe(true);
    expect(matchesQuery(devices[1], "0.59")).toBe(true);
    expect(matchesQuery(devices[4], "cqik9")).toBe(true);
    expect(matchesQuery(devices[0], "zzz")).toBe(false);
    expect(matchesQuery(devices[0], "   ")).toBe(true);
  });

  it("lists errors first, then disconnected, then connected, then switched off", () => {
    expect(sortDevices(devices).map((d) => d.status)).toEqual([
      "error",
      "disconnected",
      "disconnected",
      "connected",
      "disabled",
    ]);
  });

  it("puts the device with more problems first among equals, then orders by name", () => {
    const two = row({
      id: 6,
      name: "Zed",
      status: "disconnected",
      diagnosis: { headline: "", headlineLayer: null, action: "", layers: [], problems: ["port", "ip_config"] },
    });
    const order = sortDevices([devices[1], devices[4], two]).map((d) => d.name);
    expect(order).toEqual(["Zed", "Back gate", "Main gate"]);
  });

  it("combines the filter and the search", () => {
    expect(visibleDevices(devices, "disconnected", "gate").map((d) => d.name)).toEqual(["Back gate", "Main gate"]);
    expect(visibleDevices(devices, "connected", "gate")).toEqual([]);
  });

  it("does not change the list it was given", () => {
    const copy = [...devices];
    sortDevices(devices);
    expect(devices).toEqual(copy);
  });
});

describe("what to tell the user", () => {
  const ran = [
    row({ id: 1, reach: "reachable" }),
    row({ id: 2, reach: "unreachable" }),
    row({ id: 3, reach: "reachable" }),
  ];

  it("summarises a connection check", () => {
    expect(summarizeCheck(ran, [])).toBe("No devices were checked.");
    expect(summarizeCheck(ran, [1])).toBe("Checked 1 device: all reachable from this server.");
    expect(summarizeCheck(ran, [2])).toBe("Checked 1 device: none reachable from this server.");
    expect(summarizeCheck(ran, [1, 2, 3])).toBe("Checked 3 devices: 2 reachable, 1 not.");
  });

  it("gives one sentence for the whole page", () => {
    expect(overallVerdict([]).tone).toBe("muted");
    expect(overallVerdict([row({ isActive: false, status: "disabled" })]).text).toBe("No devices are being monitored.");
    expect(overallVerdict([row({}), row({ id: 2 })])).toEqual({ text: "All 2 devices are connected.", tone: "good" });
    expect(overallVerdict([row({}), row({ id: 2, status: "disconnected" })])).toEqual({
      text: "1 of 2 devices are connected.",
      tone: "warn",
    });
    expect(overallVerdict([row({ status: "disconnected" })])).toEqual({
      text: "None of the 1 devices is connected.",
      tone: "bad",
    });
  });
});

describe("the settings read from a device", () => {
  const good = {
    serial: "SN1",
    deviceName: "x 2008",
    platform: "ZAM180_TFT",
    ip: "192.168.0.59",
    gateway: "192.168.0.254",
    dns: "8.8.8.8",
    dhcp: false,
    serverUrl: "api.uktextiles.in",
    admsEnabled: true,
    timeZoneMinutes: 330,
    deviceTime: "2026-10-06T12:00:00",
    clockSkewSeconds: 2,
    users: 510,
    records: 51102,
  };
  const by = (rows: ReturnType<typeof readoutRows>) => Object.fromEntries(rows.map((r) => [r.label, r]));

  it("shows nothing when nothing was read", () => {
    expect(readoutRows(null)).toEqual([]);
  });

  it("shows a healthy device without a single warning", () => {
    expect(readoutRows(good).every((r) => r.tone === "muted" || r.tone === "good")).toBe(true);
    expect(by(readoutRows(good))["Cloud server push (ADMS)"].value).toBe("On");
  });

  it("flags the settings that explain why a device never reaches the server", () => {
    const rows = by(
      readoutRows({
        ...good,
        gateway: "0.0.0.0",
        dns: "0.0.0.0",
        serverPort: 81,
        admsEnabled: false,
        dhcp: true,
        timeZoneMinutes: 300,
      }),
    );
    expect(rows["Gateway"].tone).toBe("bad");
    expect(rows["DNS"].tone).toBe("bad");
    expect(rows["Server port"]).toMatchObject({ value: "81", tone: "bad" });
    expect(rows["Cloud server push (ADMS)"]).toMatchObject({ value: "Off", tone: "bad" });
    expect(rows["DHCP"].tone).toBe("warn");
    expect(rows["Time zone"].tone).toBe("warn");
  });

  it("accepts the standard server ports", () => {
    expect(by(readoutRows({ ...good, serverPort: 443 }))["Server port"].tone).toBe("good");
    expect(by(readoutRows({ ...good, serverPort: 80 }))["Server port"].tone).toBe("good");
  });

  it("warns about a clock that is far out", () => {
    const clock = by(readoutRows({ ...good, clockSkewSeconds: 900 }))["Device clock"];
    expect(clock.tone).toBe("warn");
    expect(clock.note).toBe("15 min ahead of the server");
  });

  it("leaves out what the model did not report", () => {
    const labels = readoutRows({ serial: "SN1" }).map((r) => r.label);
    expect(labels).toEqual(["Serial number"]);
  });
});

describe("the path from this computer to the server", () => {
  it("summarises round trips with the lost ones counted", () => {
    expect(pathStats([])).toBeNull();
    expect(pathStats([10, 30, null, 20])).toEqual({ min: 10, avg: 20, max: 30, lost: 1, sent: 4 });
    expect(pathStats([null, null])).toEqual({ min: 0, avg: 0, max: 0, lost: 2, sent: 2 });
  });

  const clockOf = (...ticks: number[]) => {
    let i = 0;
    return () => ticks[Math.min(i++, ticks.length - 1)];
  };

  it("times five round trips and tries the address the devices use", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, type: "basic" }) as unknown as Response);
    // each call reads the clock twice: before and after
    const clock = clockOf(0, 20, 20, 60, 60, 80, 80, 100, 100, 130, 130, 140);
    const result = await measureApiPath({
      origin: "https://api.example",
      fetcher: fetcher as unknown as typeof fetch,
      clock,
    });
    expect(fetcher).toHaveBeenCalledTimes(6);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toMatch(/^https:\/\/api\.example\/api\/healthz\?t=/);
    expect(calls[5]).toEqual(["https://api.example/iclock/getrequest", expect.objectContaining({ mode: "no-cors" })]);
    expect(result.stats).toMatchObject({ sent: 5, lost: 0, min: 20 });
    expect(result.admsReachable).toBe(true);
  });

  it("counts a failed request and an error status as lost, and an unreachable device address as not reachable", async () => {
    let n = 0;
    const fetcher = vi.fn(async (url: string) => {
      n += 1;
      if (url.includes("iclock")) throw new TypeError("Failed to fetch");
      if (n === 1) throw new TypeError("Failed to fetch");
      if (n === 2) return { ok: false, type: "basic" } as unknown as Response;
      return { ok: true, type: "basic" } as unknown as Response;
    });
    const result = await measureApiPath({
      origin: "",
      rounds: 4,
      fetcher: fetcher as unknown as typeof fetch,
      clock: () => 0,
    });
    expect(result.stats).toMatchObject({ sent: 4, lost: 2 });
    expect(result.admsReachable).toBe(false);
  });

  it("accepts an opaque answer as proof the address responds", async () => {
    const fetcher = vi.fn(async () => ({ ok: false, type: "opaque" }) as unknown as Response);
    const result = await measureApiPath({
      origin: "",
      rounds: 1,
      fetcher: fetcher as unknown as typeof fetch,
      clock: () => 0,
    });
    expect(result.stats?.lost).toBe(0);
    expect(result.admsReachable).toBe(true);
  });

  it("explains each outcome", () => {
    const stats = (over = {}) => ({ min: 10, avg: 40, max: 90, lost: 0, sent: 5, ...over });
    expect(describePath({ stats: stats({ lost: 5 }), admsReachable: false, at: 0 }).tone).toBe("bad");
    expect(describePath({ stats: null, admsReachable: null, at: 0 }).tone).toBe("bad");
    expect(describePath({ stats: stats(), admsReachable: false, at: 0 }).tone).toBe("warn");
    expect(describePath({ stats: stats({ lost: 2 }), admsReachable: true, at: 0 }).text).toContain("2 of 5");
    expect(describePath({ stats: stats({ avg: 900 }), admsReachable: true, at: 0 }).tone).toBe("warn");
    expect(describePath({ stats: stats(), admsReachable: true, at: 0 })).toMatchObject({ tone: "good" });
  });
});
