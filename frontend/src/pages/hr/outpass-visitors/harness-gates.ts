import type {
  GateRecord,
  GateRecordsPage,
  ManagedGate,
  ManagedGateDetail,
  GateSessionRow,
} from "@/lib/api-client/custom-hooks";
import { copy, harnessError, NOW, sliceState, type World } from "./harness-kit";

// The render-test fake server's answers for Manage Gates: /api/gate-devices* (the list with counts, one gate with its
// sessions, the tiles, the records, add / change / delete, reveal-password, sign-out). It also answers the plain list the
// old dialog asked for. Every non-GET is in world.calls (harness.tsx records it before asking the parts), so a test reads
// the bodies there; this part's data is in sliceState(world, "gates", ...) and changes like the server's would.

const at = (minutesAgo: number) => new Date(new Date(NOW).getTime() - minutesAgo * 60_000).toISOString();

const counts = (today: number, exits: number, returns: number, tea: number, denied: number) => ({
  today,
  exits,
  returns,
  teaOut: tea,
  teaIn: tea,
  denied,
  total: exits + returns + tea * 2 + denied,
});

const session = (id: number, minutesAgo: number): GateSessionRow => ({
  id,
  deviceLabel: "Chrome on Windows",
  createdAt: at(minutesAgo + 120),
  lastSeenAt: at(minutesAgo),
});

const gate = (id: number, patch: Partial<ManagedGateDetail>): ManagedGateDetail => ({
  id,
  name: `Gate ${id}`,
  branchId: 1,
  branchName: "Main",
  username: `gate${id}`,
  isActive: true,
  loginToken: `login-token-${id}`,
  createdBy: "Priya HR",
  createdAt: "2026-03-12T05:00:00Z",
  lastLoginAt: at(200),
  location: null,
  notes: null,
  allowOutpass: true,
  allowTeaBreak: true,
  updatedAt: null,
  updatedBy: null,
  passwordViewable: true,
  activeSessions: 0,
  lastActivityAt: at(30),
  counts: counts(0, 0, 0, 0, 0),
  sessions: [],
  ...patch,
});

/** Main Gate (11): a stored password, one browser signed in, records today. Back Gate (12): set before passwords were
 *  kept (nothing to show). Old Gate (13): switched off. */
export const GATES: ManagedGateDetail[] = [
  gate(11, {
    name: "Main Gate",
    username: "main.gate1",
    location: "Spinning side",
    notes: "Day shift kiosk",
    activeSessions: 1,
    counts: counts(3, 10, 8, 5, 2),
    sessions: [session(1, 2)],
  }),
  gate(12, { name: "Back Gate", username: "back.gate", passwordViewable: false, counts: counts(1, 2, 2, 0, 0) }),
  gate(13, { name: "Old Gate", username: "old.gate", isActive: false, lastActivityAt: null }),
];

const PASSWORDS: Record<number, string | null> = { 11: "secret-one", 12: null, 13: "secret-old" };

const person = (id: number, name: string) => ({
  id,
  employeeCode: `E${id}`,
  name,
  department: "Weaving",
  photoUrl: null,
});

const record = (id: string, patch: Partial<GateRecord>): GateRecord => ({
  id,
  at: at(10),
  type: "exit",
  result: "allowed",
  reason: null,
  reasonLabel: null,
  message: "Exit recorded",
  gateId: 11,
  gateName: "Main Gate",
  employee: person(1, "Ravi Kumar"),
  destination: "Canara Bank",
  passId: 1,
  ...patch,
});

export const RECORDS: GateRecord[] = [
  record("scan-1", {}),
  record("scan-2", {
    at: at(20),
    result: "denied",
    reason: "expired",
    reasonLabel: "Pass expired",
    message: "This Outpass has expired.",
    employee: person(2, "Asha Devi"),
    destination: "Post office",
  }),
  record("teaout-3", { at: at(40), type: "tea_out", message: "Tea break started", destination: null, passId: null }),
  record("scan-4", {
    at: at(60),
    type: "return",
    gateId: 12,
    gateName: "Back Gate",
    message: "Return recorded",
    employee: person(3, "Kavitha Balan"),
  }),
];

type GatesState = { gates: ManagedGateDetail[]; passwords: Record<number, string | null>; next: number };

const state = (world: World) =>
  sliceState<GatesState>(world, "gates", () => ({ gates: copy(GATES), passwords: { ...PASSWORDS }, next: 100 }));

const listed = (g: ManagedGateDetail): ManagedGate => {
  const { sessions: _sessions, ...rest } = g;
  return copy(rest);
};

function recordsPage(query: URLSearchParams): GateRecordsPage {
  const ids = (query.get("gateId") ?? "").split(",").filter(Boolean).map(Number);
  const type = query.get("type");
  const result = query.get("result");
  const q = (query.get("q") ?? "").toLowerCase();
  const base = RECORDS.filter((r) => ids.length === 0 || ids.includes(r.gateId ?? -1)).filter(
    (r) =>
      !q ||
      `${r.employee?.name ?? ""} ${r.employee?.employeeCode ?? ""} ${r.destination ?? ""}`.toLowerCase().includes(q),
  );
  const rows = base.filter((r) => (!type || r.type === type) && (!result || r.result === result));
  const size = Math.max(1, Number(query.get("pageSize")) || 25);
  const page = Math.max(1, Number(query.get("page")) || 1);
  const allowed = (t: string) => base.filter((r) => r.type === t && r.result === "allowed").length;
  return {
    items: copy(rows.slice((page - 1) * size, page * size)),
    total: rows.length,
    page,
    pageSize: size,
    counts: {
      exits: allowed("exit"),
      returns: allowed("return"),
      teaOut: allowed("tea_out"),
      teaIn: allowed("tea_in"),
      denied: base.filter((r) => r.result === "denied").length,
    },
  };
}

export function handler(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
  world: World,
): unknown {
  if (!path.startsWith("/api/gate-devices")) return undefined;
  const s = state(world);
  const one = /^\/api\/gate-devices\/(\d+)(?:\/(reveal-password|sign-out))?$/.exec(path);
  const find = (id: number) => {
    const g = s.gates.find((x) => x.id === id);
    if (!g) throw harnessError(404, { error: "Gate not found" }, method, path);
    return g;
  };

  if (method === "GET") {
    if (path === "/api/gate-devices") {
      const q = (query.get("q") ?? "").toLowerCase();
      const status = query.get("status");
      return s.gates
        .filter((g) => !q || `${g.name} ${g.username} ${g.location ?? ""}`.toLowerCase().includes(q))
        .filter((g) => !status || (status === "active" ? g.isActive : !g.isActive))
        .map(listed);
    }
    if (path === "/api/gate-devices/summary") {
      return {
        gates: s.gates.length,
        active: s.gates.filter((g) => g.isActive).length,
        signedInNow: s.gates.reduce((n, g) => n + g.sessions.length, 0),
        recordsToday: RECORDS.length,
        deniedToday: RECORDS.filter((r) => r.result === "denied").length,
        records: RECORDS.length,
        denied: 1,
      };
    }
    if (path === "/api/gate-devices/records") return recordsPage(query);
    if (one && !one[2]) return copy(find(Number(one[1])));
    return undefined;
  }

  if (method === "POST" && path === "/api/gate-devices") {
    const id = s.next++;
    const made = gate(id, {
      name: String(body.name),
      username: String(body.username),
      branchId: (body.branchId as number | undefined) ?? 1,
      location: (body.location as string | null) ?? null,
      notes: (body.notes as string | null) ?? null,
      allowOutpass: body.allowOutpass !== false,
      allowTeaBreak: body.allowTeaBreak !== false,
      lastActivityAt: null,
      lastLoginAt: null,
    });
    s.gates.push(made);
    s.passwords[id] = String(body.password);
    return listed(made);
  }

  if (!one) return undefined;
  const target = find(Number(one[1]));
  if (method === "POST" && one[2] === "reveal-password") {
    const password = s.passwords[target.id];
    if (!password) {
      throw harnessError(
        409,
        { error: "This gate's password was set before 18 Nov 2026, so it cannot be shown.", code: "not_stored" },
        method,
        path,
      );
    }
    return { password };
  }
  if (method === "POST" && one[2] === "sign-out") {
    const signedOut = target.sessions.length;
    target.sessions = [];
    target.activeSessions = 0;
    return { signedOut };
  }
  if (method === "PUT" && !one[2]) {
    const before = { username: target.username, isActive: target.isActive };
    for (const key of [
      "name",
      "branchId",
      "username",
      "location",
      "notes",
      "allowOutpass",
      "allowTeaBreak",
      "isActive",
    ]) {
      if (key in body) (target as Record<string, unknown>)[key] = body[key];
    }
    if (typeof body.password === "string" && body.password) {
      s.passwords[target.id] = body.password;
      target.passwordViewable = true;
    }
    if (body.password || target.username !== before.username || (before.isActive && !target.isActive)) {
      target.sessions = [];
      target.activeSessions = 0;
    }
    target.updatedAt = NOW;
    target.updatedBy = "Test HR";
    return listed(target);
  }
  if (method === "DELETE" && !one[2]) {
    s.gates = s.gates.filter((g) => g.id !== target.id);
    return null;
  }
  return undefined;
}
