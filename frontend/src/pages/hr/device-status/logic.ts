// The Biometric Device Status page's pure rules: wording, colours, filtering, sorting, timing. No React here, so
// every rule has a plain unit test (logic.test.ts).
import type {
  DeviceReadout,
  DeviceReach,
  DeviceStatusRow,
  DeviceStatusState,
  LayerState,
  ProbeView,
  PushDelay,
} from "@/lib/api-client/custom-hooks";

export type Tone = "good" | "bad" | "warn" | "info" | "muted" | "busy";

/** Tailwind classes for each tone: a soft fill, readable text, and a ring for the card edge. */
export const TONE_CLASSES: Record<Tone, { chip: string; dot: string; ring: string; text: string }> = {
  good: {
    chip: "bg-emerald-50 text-emerald-700",
    dot: "bg-emerald-500",
    ring: "ring-emerald-200",
    text: "text-emerald-700",
  },
  bad: { chip: "bg-red-50 text-red-600", dot: "bg-red-500", ring: "ring-red-200", text: "text-red-600" },
  warn: { chip: "bg-amber-50 text-amber-700", dot: "bg-amber-500", ring: "ring-amber-200", text: "text-amber-700" },
  info: {
    chip: "bg-indigo-50 text-indigo-700",
    dot: "bg-indigo-500",
    ring: "ring-indigo-200",
    text: "text-indigo-700",
  },
  muted: { chip: "bg-slate-100 text-slate-500", dot: "bg-slate-400", ring: "ring-slate-200", text: "text-slate-500" },
  busy: { chip: "bg-sky-50 text-sky-700", dot: "bg-sky-500", ring: "ring-sky-200", text: "text-sky-700" },
};

export const STATUS_TONE: Record<DeviceStatusState, Tone> = {
  connected: "good",
  disconnected: "bad",
  error: "warn",
  disabled: "muted",
};

export const REACH_TONE: Record<DeviceReach, Tone> = {
  reachable: "good",
  unreachable: "info",
  refused: "warn",
  auth: "warn",
  error: "warn",
  unchecked: "muted",
};

export const LAYER_TONE: Record<LayerState, Tone> = {
  ok: "good",
  warn: "warn",
  problem: "bad",
  unknown: "muted",
  na: "muted",
};

export const LAYER_STATE_LABEL: Record<LayerState, string> = {
  ok: "OK",
  warn: "Check",
  problem: "Problem",
  unknown: "Unknown",
  na: "Not testable here",
};

export type StatusFilter = "all" | "connected" | "disconnected" | "error" | "unreachable";

export const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "connected", label: "Connected" },
  { value: "disconnected", label: "Disconnected" },
  { value: "error", label: "Error" },
  { value: "unreachable", label: "Unreachable" },
];

/** "just now", "3 min ago", "2 h ago", "5 days ago"; "never" when there is no time. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** "12 ms", "1.2 s"; "–" when nothing was measured. */
export function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return "–";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Fast / acceptable / slow, for colouring a latency. */
export function latencyTone(ms: number | null | undefined, slowMs = 250): Tone {
  if (ms == null) return "muted";
  if (ms > slowMs * 2) return "bad";
  if (ms > slowMs) return "warn";
  return "good";
}

/** "4 seconds", "25 minutes", "3 hours": how long punches take to reach the server. */
export function formatDelay(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}

export function describeDelay(delay: PushDelay | null): { label: string; tone: Tone } {
  if (!delay) return { label: "No punches measured yet", tone: "muted" };
  if (delay.verdict === "realtime") return { label: `Arrive in ~${formatDelay(delay.medianSeconds)}`, tone: "good" };
  if (delay.verdict === "delayed") return { label: `Arrive ~${formatDelay(delay.medianSeconds)} late`, tone: "warn" };
  return { label: `Batched: ~${formatDelay(delay.medianSeconds)} late`, tone: "bad" };
}

/** What the "Ping" tile shows for a device: the ping reply, or the port-connect time when the server cannot ping. */
export function pingSummary(probe: ProbeView | null): { value: string; sub: string; tone: Tone } {
  if (!probe) return { value: "–", sub: "Not checked yet", tone: "muted" };
  const ping = probe.ping;
  if (ping?.available && ping.ok) {
    return {
      value: formatLatency(ping.ms ?? probe.latencyMs),
      sub: "Ping replied",
      tone: latencyTone(ping.ms ?? probe.latencyMs),
    };
  }
  if (probe.latencyMs != null) {
    const why = ping?.available ? "no ping reply, port answered" : "port connect time";
    return { value: formatLatency(probe.latencyMs), sub: why, tone: latencyTone(probe.latencyMs) };
  }
  if (ping?.available && ping.ok === false) return { value: "No reply", sub: "Ping and port both silent", tone: "bad" };
  return { value: "No reply", sub: probe.error || "Could not connect", tone: "bad" };
}

/** The device's own clock against the server's, as words. */
export function describeClock(skewSeconds: number | undefined): string | null {
  if (skewSeconds == null) return null;
  const abs = Math.abs(skewSeconds);
  if (abs <= 60) return "in step with the server";
  const text = abs < 3600 ? `${Math.round(abs / 60)} min` : `${(abs / 3600).toFixed(1)} h`;
  return `${text} ${skewSeconds > 0 ? "ahead of" : "behind"} the server`;
}

export function timeZoneText(minutes: number | null | undefined): string | null {
  if (minutes == null) return null;
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `UTC${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
}

/** The status cards on top double as filters: which devices does each one count? */
export function matchesFilter(row: DeviceStatusRow, filter: StatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "connected":
      return row.status === "connected";
    case "disconnected":
      return row.isActive && row.status === "disconnected";
    case "error":
      return row.status === "error";
    case "unreachable":
      return row.isActive && (row.reach === "unreachable" || row.reach === "refused");
  }
}

export function matchesQuery(row: DeviceStatusRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.name, row.host, row.serialNumber ?? "", row.deviceType].some((v) => v.toLowerCase().includes(q));
}

const SEVERITY: Record<DeviceStatusState, number> = { error: 0, disconnected: 1, connected: 2, disabled: 3 };

/** Problems first (errors, then disconnected), then working devices, then switched-off ones; by name within each. */
export function sortDevices(rows: DeviceStatusRow[]): DeviceStatusRow[] {
  return [...rows].sort(
    (a, b) =>
      SEVERITY[a.status] - SEVERITY[b.status] ||
      b.diagnosis.problems.length - a.diagnosis.problems.length ||
      a.name.localeCompare(b.name),
  );
}

export function visibleDevices(rows: DeviceStatusRow[], filter: StatusFilter, query: string): DeviceStatusRow[] {
  return sortDevices(rows.filter((r) => matchesFilter(r, filter) && matchesQuery(r, query)));
}

/** One sentence for the toast after a connection check. */
export function summarizeCheck(rows: DeviceStatusRow[], ranIds: number[]): string {
  const ran = rows.filter((r) => ranIds.includes(r.id));
  if (ran.length === 0) return "No devices were checked.";
  const reachable = ran.filter((r) => r.reach === "reachable").length;
  const noun = ran.length === 1 ? "device" : "devices";
  if (reachable === ran.length) return `Checked ${ran.length} ${noun}: all reachable from this server.`;
  if (reachable === 0) {
    return `Checked ${ran.length} ${noun}: none reachable from this server.`;
  }
  return `Checked ${ran.length} ${noun}: ${reachable} reachable, ${ran.length - reachable} not.`;
}

/** The first thing to say about the page as a whole. */
export function overallVerdict(rows: DeviceStatusRow[]): { text: string; tone: Tone } {
  const enabled = rows.filter((r) => r.isActive);
  if (enabled.length === 0) return { text: "No devices are being monitored.", tone: "muted" };
  const connected = enabled.filter((r) => r.status === "connected").length;
  if (connected === enabled.length) return { text: `All ${enabled.length} devices are connected.`, tone: "good" };
  if (connected === 0) return { text: `None of the ${enabled.length} devices is connected.`, tone: "bad" };
  return { text: `${connected} of ${enabled.length} devices are connected.`, tone: "warn" };
}

// ── The path from this computer to the server ──────────────────────────────────────────────────────────────────────

export type PathStats = { min: number; avg: number; max: number; lost: number; sent: number };

export function pathStats(samples: (number | null)[]): PathStats | null {
  const ok = samples.filter((s): s is number => s != null);
  if (samples.length === 0) return null;
  const lost = samples.length - ok.length;
  if (ok.length === 0) return { min: 0, avg: 0, max: 0, lost, sent: samples.length };
  return {
    min: Math.min(...ok),
    avg: ok.reduce((a, b) => a + b, 0) / ok.length,
    max: Math.max(...ok),
    lost,
    sent: samples.length,
  };
}

export type PathResult = {
  stats: PathStats | null;
  /** null = could not be tried (the browser refused the request for a reason that says nothing about the path) */
  admsReachable: boolean | null;
  at: number;
};

/**
 * Time a few round trips to the API from THIS computer, and see whether the address the devices use answers at all.
 * On a computer inside the factory network this goes through the same firewall rule as a device's traffic.
 * `fetcher` and `clock` are parameters so a test can run it without a network.
 */
export async function measureApiPath(options: {
  origin: string;
  rounds?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  clock?: () => number;
}): Promise<PathResult> {
  const { origin, rounds = 5, timeoutMs = 6000 } = options;
  const fetcher = options.fetcher ?? fetch.bind(globalThis);
  const clock = options.clock ?? (() => performance.now());

  const timed = async (url: string, init: RequestInit): Promise<number | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = clock();
    try {
      const response = await fetcher(url, { ...init, signal: controller.signal, cache: "no-store" });
      // an opaque (no-cors) answer has no status to read: getting one at all is the proof
      if (response.type !== "opaque" && !response.ok) return null;
      return clock() - started;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const samples: (number | null)[] = [];
  for (let i = 0; i < rounds; i++) samples.push(await timed(`${origin}/api/healthz?t=${Date.now()}-${i}`, {}));
  // The attendance listener's own address, with no serial number (so it is not counted as a device).
  const adms = await timed(`${origin}/iclock/getrequest`, { mode: "no-cors" });
  return { stats: pathStats(samples), admsReachable: adms != null, at: Date.now() };
}

/** What a path measurement means, in a sentence a person can act on. */
export function describePath(result: PathResult): { text: string; tone: Tone } {
  const stats = result.stats;
  if (!stats || stats.lost === stats.sent) {
    return {
      text: "This computer could not reach the server at all: check its internet connection and whether the firewall allows this address.",
      tone: "bad",
    };
  }
  if (result.admsReachable === false) {
    return {
      text: "The server answers, but the address the devices use did not: the firewall may treat that path differently.",
      tone: "warn",
    };
  }
  if (stats.lost > 0)
    return {
      text: `The server answers, but ${stats.lost} of ${stats.sent} requests were lost: an unreliable link.`,
      tone: "warn",
    };
  if (stats.avg > 600)
    return { text: `The server answers, but slowly (${formatLatency(stats.avg)} on average).`, tone: "warn" };
  return {
    text: `The server answers quickly (${formatLatency(stats.avg)} on average) and the device address is reachable.`,
    tone: "good",
  };
}

// ── What was read from the device ──────────────────────────────────────────────────────────────────────────────────

export type ReadoutRow = { label: string; value: string; tone: Tone; note?: string };

const SERVER_PORTS = [80, 443];

/** The device's own settings as labelled rows, each marked when the value on its own explains a failure. */
export function readoutRows(d: DeviceReadout | null | undefined): ReadoutRow[] {
  if (!d) return [];
  const rows: ReadoutRow[] = [];
  const add = (label: string, value: string | undefined | null, tone: Tone = "muted", note?: string) => {
    if (value != null && value !== "") rows.push({ label, value, tone, note });
  };
  const zero = (v: string | undefined) => v === "0.0.0.0";
  add("Model", [d.deviceName, d.platform].filter(Boolean).join(" · ") || undefined);
  add("Serial number", d.serial);
  add("MAC address", d.mac);
  add("IP address", d.ip);
  add("Subnet mask", d.mask);
  add(
    "Gateway",
    d.gateway,
    zero(d.gateway) ? "bad" : "muted",
    zero(d.gateway) ? "none set: cannot leave the factory network" : undefined,
  );
  add(
    "DNS",
    d.dns,
    zero(d.dns) ? "bad" : "muted",
    zero(d.dns) ? "none set: cannot find the server by name" : undefined,
  );
  if (d.dhcp != null)
    add("DHCP", d.dhcp ? "On" : "Off", d.dhcp ? "warn" : "muted", d.dhcp ? "the address can change" : undefined);
  if (d.admsEnabled != null) {
    add(
      "Cloud server push (ADMS)",
      d.admsEnabled ? "On" : "Off",
      d.admsEnabled ? "good" : "bad",
      d.admsEnabled ? undefined : "the device never sends attendance",
    );
  }
  add("Server address", d.serverUrl);
  if (d.serverPort != null) {
    const odd = !SERVER_PORTS.includes(d.serverPort);
    add("Server port", String(d.serverPort), odd ? "bad" : "good", odd ? "the server listens on 443 or 80" : undefined);
  }
  if (d.proxyEnabled != null) add("Proxy", d.proxyEnabled ? "On" : "Off");
  const zone = timeZoneText(d.timeZoneMinutes);
  add(
    "Time zone",
    zone,
    d.timeZoneMinutes != null && d.timeZoneMinutes !== 330 ? "warn" : "muted",
    d.timeZoneMinutes != null && d.timeZoneMinutes !== 330 ? "India is UTC+5:30" : undefined,
  );
  if (d.deviceTime) {
    const skew = describeClock(d.clockSkewSeconds);
    add(
      "Device clock",
      d.deviceTime.replace("T", " "),
      Math.abs(d.clockSkewSeconds ?? 0) > 300 ? "warn" : "muted",
      skew ?? undefined,
    );
  }
  if (d.users != null) add("Users enrolled", String(d.users));
  if (d.records != null) add("Records stored", String(d.records));
  return rows;
}
