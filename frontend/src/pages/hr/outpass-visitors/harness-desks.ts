import type {
  DeskSessionRow,
  ManagedDesk,
  ManagedDeskDetail,
  ReceptionRecord,
  ReceptionRecordsPage,
} from "@/lib/api-client/custom-hooks";
import { copy, harnessError, NOW, sliceState, type World } from "./harness-kit";

// The render-test fake server's answers for Visitors -> Manage Reception: /api/reception-devices* on the HR side (the list
// with counts, one desk with its sessions, the tiles, the records, add / change / delete, reveal-password, sign-out). Every
// non-GET is in world.calls (harness.tsx records it before asking the parts), so a test reads the bodies there; this
// part's data is in sliceState(world, "desks", ...) and changes like the server's would.

const at = (minutesAgo: number) => new Date(new Date(NOW).getTime() - minutesAgo * 60_000).toISOString();

const counts = (today: number, checkIns: number, checkOuts: number) => ({
  today,
  checkIns,
  checkOuts,
  total: checkIns + checkOuts,
});

const session = (id: number, minutesAgo: number): DeskSessionRow => ({
  id,
  deviceLabel: "Chrome on Windows",
  createdAt: at(minutesAgo + 120),
  lastSeenAt: at(minutesAgo),
});

const desk = (id: number, patch: Partial<ManagedDeskDetail>): ManagedDeskDetail => ({
  id,
  name: `Desk ${id}`,
  branchId: 1,
  branchName: "Main",
  username: `desk${id}`,
  isActive: true,
  loginToken: `desk-login-token-${id}`,
  createdBy: "Priya HR",
  createdAt: "2026-03-12T05:00:00Z",
  lastLoginAt: at(200),
  location: null,
  notes: null,
  updatedAt: null,
  updatedBy: null,
  passwordViewable: true,
  activeSessions: 0,
  lastActivityAt: at(30),
  counts: counts(0, 0, 0),
  sessions: [],
  ...patch,
});

/** Front Desk (21): a stored password, one browser signed in, records today. Side Desk (22): set before passwords were
 *  kept (nothing to show). Old Desk (23): switched off. */
export const DESKS: ManagedDeskDetail[] = [
  desk(21, {
    name: "Front Desk",
    username: "front.desk",
    location: "Main lobby",
    notes: "Day shift desk",
    activeSessions: 1,
    counts: counts(3, 12, 9),
    sessions: [session(1, 2)],
  }),
  desk(22, { name: "Side Desk", username: "side.desk", passwordViewable: false, counts: counts(1, 2, 1) }),
  desk(23, { name: "Old Desk", username: "old.desk", isActive: false, lastActivityAt: null }),
];

const PASSWORDS: Record<number, string | null> = { 21: "desk-secret", 22: null, 23: "old-secret" };

const visit = (id: number, name: string, patch: Partial<NonNullable<ReceptionRecord["visit"]>> = {}) => ({
  id,
  visitorName: name,
  company: null,
  peopleCount: 1,
  host: "Karthik M",
  hostDepartment: "Maintenance",
  purpose: "Invoice",
  badgeNumber: null,
  status: "inside" as const,
  statusLabel: "Inside",
  visitedAt: at(60),
  checkedOutAt: null,
  minutesInside: 60,
  branchName: "Main",
  ...patch,
});

const record = (id: string, patch: Partial<ReceptionRecord>): ReceptionRecord => ({
  id,
  at: at(10),
  type: "check_in",
  typeLabel: "Check-in",
  desk: { id: 21, name: "Front Desk" },
  visit: visit(1, "Ramesh Kumar", { company: "Apex Spares" }),
  ...patch,
});

export const DESK_RECORDS: ReceptionRecord[] = [
  record("in-1", {}),
  record("out-2", {
    at: at(20),
    type: "check_out",
    typeLabel: "Check-out",
    visit: visit(2, "Prakash Sharma", {
      status: "checked_out",
      statusLabel: "Checked out",
      checkedOutAt: at(20),
      purpose: "Audit",
    }),
  }),
  record("in-3", {
    at: at(40),
    desk: { id: 22, name: "Side Desk" },
    visit: visit(3, "Anand Natarajan", { purpose: "Cotton bales" }),
  }),
];

type DesksState = { desks: ManagedDeskDetail[]; passwords: Record<number, string | null>; next: number };

const state = (world: World) =>
  sliceState<DesksState>(world, "desks", () => ({ desks: copy(DESKS), passwords: { ...PASSWORDS }, next: 200 }));

const listed = (d: ManagedDeskDetail): ManagedDesk => {
  const { sessions: _sessions, ...rest } = d;
  return copy(rest);
};

function recordsPage(query: URLSearchParams): ReceptionRecordsPage {
  const ids = (query.get("deskId") ?? "").split(",").filter(Boolean).map(Number);
  const type = query.get("type");
  const q = (query.get("q") ?? "").toLowerCase();
  const base = DESK_RECORDS.filter((r) => ids.length === 0 || ids.includes(r.desk?.id ?? -1)).filter(
    (r) =>
      !q ||
      `${r.visit?.visitorName ?? ""} ${r.visit?.company ?? ""} ${r.visit?.host ?? ""} ${r.visit?.purpose ?? ""}`
        .toLowerCase()
        .includes(q),
  );
  const rows = base.filter((r) => !type || r.type === type);
  const size = Math.max(1, Number(query.get("pageSize")) || 25);
  const page = Math.max(1, Number(query.get("page")) || 1);
  const ins = base.filter((r) => r.type === "check_in").length;
  const outs = base.filter((r) => r.type === "check_out").length;
  return {
    items: copy(rows.slice((page - 1) * size, page * size)),
    total: rows.length,
    page,
    pageSize: size,
    counts: { checkIns: ins, checkOuts: outs, total: ins + outs },
  };
}

export function handler(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
  world: World,
): unknown {
  if (!path.startsWith("/api/reception-devices")) return undefined;
  const s = state(world);
  const one = /^\/api\/reception-devices\/(\d+)(?:\/(reveal-password|sign-out))?$/.exec(path);
  const find = (id: number) => {
    const d = s.desks.find((x) => x.id === id);
    if (!d) throw harnessError(404, { error: "Reception desk not found" }, method, path);
    return d;
  };

  if (method === "GET") {
    if (path === "/api/reception-devices") {
      const q = (query.get("q") ?? "").toLowerCase();
      const status = query.get("deskStatus");
      return s.desks
        .filter((d) => !q || `${d.name} ${d.username} ${d.location ?? ""}`.toLowerCase().includes(q))
        .filter((d) => !status || (status === "active" ? d.isActive : !d.isActive))
        .map(listed);
    }
    if (path === "/api/reception-devices/overview") {
      return {
        desks: s.desks.length,
        active: s.desks.filter((d) => d.isActive).length,
        signedInNow: s.desks.reduce((n, d) => n + d.sessions.length, 0),
        checkInsToday: DESK_RECORDS.filter((r) => r.type === "check_in").length,
        checkOutsToday: DESK_RECORDS.filter((r) => r.type === "check_out").length,
        checkIns: 14,
        checkOuts: 10,
      };
    }
    if (path === "/api/reception-devices/records") return recordsPage(query);
    if (one && !one[2]) return copy(find(Number(one[1])));
    return undefined;
  }

  if (method === "POST" && path === "/api/reception-devices") {
    const id = s.next++;
    const made = desk(id, {
      name: String(body.name),
      username: String(body.username),
      branchId: (body.branchId as number | undefined) ?? 1,
      location: (body.location as string | null) ?? null,
      notes: (body.notes as string | null) ?? null,
      lastActivityAt: null,
      lastLoginAt: null,
    });
    s.desks.push(made);
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
        { error: "This desk's password was set before 18 Nov 2026, so it cannot be shown.", code: "not_stored" },
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
    for (const key of ["name", "branchId", "username", "location", "notes", "isActive"]) {
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
    s.desks = s.desks.filter((d) => d.id !== target.id);
    return null;
  }
  return undefined;
}
