import type {
  EmployeeContact,
  VisitorDashboardSummary,
  VisitorPerson,
  VisitorVisit,
  VisitStatus,
} from "@/lib/api-client/custom-hooks";
import { copy, harnessError, NOW, paginate, sliceState, type World } from "./harness-kit";

// The render-test fake server's answers for Visitors: /api/visitor/records and /api/visitor/summary with their filters,
// /api/visitor/visits (register, one visit with its history, check-out), /api/visitor/people, the QR form's employee
// look-up the Register dialog uses. Return undefined for anything else (the QR and the branches are answered in harness.tsx;
// the reception desks of Manage Reception in harness-desks.ts). The clock is 14 Oct 2026, 11:30 in India (NOW).

const day = (d: string, utc: string) => `2026-10-${d}T${utc}:00Z`;
/** "YYYY-MM-DD" of an instant in India. */
const istDay = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);
const minutesBetween = (a: string, b: string) => Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 60_000);

export const HOSTS: Record<number, EmployeeContact & { departmentId: number }> = {
  11: {
    id: 11,
    employeeCode: "E11",
    name: "Karthik M",
    department: "Maintenance",
    departmentId: 5,
    designation: null,
    phone: "90000 11111",
    email: null,
    photoUrl: null,
  },
  12: {
    id: 12,
    employeeCode: "E12",
    name: "Selvam R",
    department: "Electrical",
    departmentId: 6,
    designation: null,
    phone: "90000 22222",
    email: null,
    photoUrl: null,
  },
};
const contact = (id: number): EmployeeContact => {
  const { departmentId: _d, ...rest } = HOSTS[id];
  return rest;
};

const LABEL: Record<VisitStatus, string> = {
  inside: "Inside",
  checked_out: "Checked out",
  not_checked_out: "Left without check-out",
};
const SOURCE_LABEL = { qr: "QR self check-in", hr: "Registered by HR", reception: "Reception desk" } as const;

type Row = VisitorVisit & { hostDepartmentId: number | null };

function visit(id: number, patch: Partial<Row> & Pick<Row, "name" | "visitorId" | "visitedAt">): Row {
  const status = patch.status ?? "inside";
  return {
    id,
    phone: `98765000${String(patch.visitorId).padStart(2, "0")}`,
    aadhaar: null,
    aadhaarLast4: null,
    whyCame: null,
    whomToMeet: "Accounts",
    purpose: "Invoice",
    branchName: "Main",
    meetingEmployee: null,
    notifiedEmailAt: null,
    notifiedWhatsappAt: null,
    branchId: 1,
    source: "qr",
    sourceLabel: SOURCE_LABEL[patch.source ?? "qr"],
    checkedInBy: null,
    checkedOutAt: null,
    checkedOutBy: null,
    checkoutSource: null,
    company: null,
    vehicleNumber: null,
    peopleCount: 1,
    idProofType: null,
    badgeNumber: null,
    notes: null,
    status,
    statusLabel: LABEL[status],
    minutesInside: status === "inside" ? minutesBetween(patch.visitedAt, NOW) : null,
    visitCount: 1,
    hostDepartmentId: null,
    ...patch,
  };
}

/** Five visits: today Visitor One (inside), Ramesh (inside since 09:12, over 2 h, registered by HR, his second visit),
 *  Prakash (08:30 to 11:15); yesterday Anand (left without check-out); 2 Oct Ramesh's first visit. */
export function visitorsWorld(): Row[] {
  return [
    visit(1, { name: "Visitor One", visitorId: 1, visitedAt: day("14", "05:00") }),
    visit(2, {
      name: "Ramesh Kumar",
      visitorId: 2,
      phone: "9845012210",
      aadhaar: "123456789012",
      aadhaarLast4: "9012",
      visitedAt: day("14", "03:42"),
      meetingEmployee: contact(11),
      hostDepartmentId: 5,
      whomToMeet: "Karthik M",
      purpose: "Spindle repair",
      company: "Apex Spares",
      vehicleNumber: "TN 37 AB 1234",
      source: "hr",
      sourceLabel: SOURCE_LABEL.hr,
      checkedInBy: "Priya",
      notifiedEmailAt: day("14", "03:43"),
      visitCount: 2,
    }),
    visit(3, {
      name: "Prakash Sharma",
      visitorId: 3,
      visitedAt: day("14", "03:00"),
      checkedOutAt: day("14", "05:45"),
      checkedOutBy: "Front Desk",
      checkoutSource: "reception",
      status: "checked_out",
      statusLabel: LABEL.checked_out,
      minutesInside: 165,
      meetingEmployee: contact(12),
      hostDepartmentId: 6,
      whomToMeet: "Selvam R",
      purpose: "Auditing",
    }),
    visit(4, {
      name: "Anand Natarajan",
      visitorId: 4,
      visitedAt: day("13", "04:30"),
      status: "not_checked_out",
      statusLabel: LABEL.not_checked_out,
      minutesInside: null,
      source: "reception",
      sourceLabel: SOURCE_LABEL.reception,
      checkedInBy: "Front Desk",
      purpose: "Cotton bales",
    }),
    visit(5, {
      name: "Ramesh Kumar",
      visitorId: 2,
      phone: "9845012210",
      visitedAt: day("02", "04:00"),
      checkedOutAt: day("02", "05:12"),
      checkedOutBy: "Priya",
      checkoutSource: "hr",
      status: "checked_out",
      statusLabel: LABEL.checked_out,
      minutesInside: 72,
      meetingEmployee: contact(12),
      hostDepartmentId: 6,
      whomToMeet: "Selvam R",
      purpose: "Spindle order",
      visitCount: 2,
    }),
  ];
}

const rowsOf = (world: World) => sliceState(world, "visitors", visitorsWorld);
const out = (r: Row): VisitorVisit => {
  const { hostDepartmentId: _h, ...rest } = r;
  return copy(rest);
};

function matches(r: Row, q: URLSearchParams, opts: { dates?: boolean; status?: boolean } = {}): boolean {
  const from = q.get("from");
  const to = q.get("to");
  const dayKey = istDay(r.visitedAt);
  if (opts.dates !== false) {
    if (from && dayKey < from) return false;
    if (to && dayKey > to) return false;
  }
  if (opts.status !== false && q.get("status") && r.status !== q.get("status")) return false;
  if (q.get("hostEmployeeId") && String(r.meetingEmployee?.id ?? "") !== q.get("hostEmployeeId")) return false;
  if (q.get("departmentId") && String(r.hostDepartmentId ?? "") !== q.get("departmentId")) return false;
  if (q.get("source") && r.source !== q.get("source")) return false;
  if (q.get("branchId") && String(r.branchId) !== q.get("branchId")) return false;
  const words = (q.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [r.name, r.phone, r.company, r.whomToMeet, r.meetingEmployee?.name, r.purpose].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

function summary(rows: Row[], q: URLSearchParams): VisitorDashboardSummary {
  const today = istDay(NOW);
  const base = rows.filter((r) => matches(r, q, { dates: false, status: false }));
  const inRange = rows.filter((r) => matches(r, q));
  const done = inRange.filter((r) => r.checkedOutAt);
  const body: VisitorDashboardSummary = {
    today: base.filter((r) => istDay(r.visitedAt) === today).length,
    thisWeek: base.filter((r) => istDay(r.visitedAt) >= "2026-10-12").length,
    thisMonth: base.length,
    insideNow: base.filter((r) => r.status === "inside").length,
    checkedOutToday: base.filter((r) => r.checkedOutAt && istDay(r.checkedOutAt) === today).length,
    longStayNow: base.filter((r) => r.status === "inside" && (r.minutesInside ?? 0) > 120).length,
    repeatThisMonth: 1,
    inRange: {
      visits: inRange.length,
      checkedOut: done.length,
      avgMinutes: done.length ? Math.round(done.reduce((n, r) => n + (r.minutesInside ?? 0), 0) / done.length) : null,
    },
  };
  if (q.get("options") === "1") {
    body.options = {
      hosts: Object.values(HOSTS).map((h) => ({ id: h.id, name: h.name, department: h.department })),
      departments: Object.values(HOSTS).map((h) => ({ id: h.departmentId, name: h.department! })),
    };
  }
  return body;
}

function people(rows: Row[], q: URLSearchParams): VisitorPerson[] {
  const byVisitor = new Map<number, Row[]>();
  for (const r of [...rows].sort((a, b) => b.visitedAt.localeCompare(a.visitedAt))) {
    byVisitor.set(r.visitorId, [...(byVisitor.get(r.visitorId) ?? []), r]);
  }
  const digits = (s: string | null) => (s ?? "").replace(/\D/g, "");
  const phone = digits(q.get("phone"));
  const words = (q.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return [...byVisitor.values()]
    .map((visits) => {
      const last = visits[0];
      return {
        id: last.visitorId,
        name: last.name,
        phoneMasked: `${digits(last.phone).slice(0, 2)}•••••${digits(last.phone).slice(-3)}`,
        lastVisitAt: last.visitedAt,
        visitCount: visits.length,
        lastHost: last.meetingEmployee?.name ?? last.whomToMeet,
        insideNow: visits.some((v) => v.status === "inside"),
        lastVisitId: last.id,
        lastCompany: last.company,
        phone: last.phone,
      };
    })
    .filter((p) => !phone || digits(p.phone).endsWith(phone.slice(-10)))
    .filter((p) => words.every((w) => `${p.name} ${p.phone}`.toLowerCase().includes(w)))
    .map(({ phone: _p, ...person }) => person);
}

export function handler(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
  world: World,
): unknown {
  if (!path.startsWith("/api/visitor/")) return undefined;
  const rows = rowsOf(world);

  if (method === "GET" && path === "/api/visitor/records") {
    const list = rows
      .filter((r) => matches(r, query))
      .sort((a, b) => b.visitedAt.localeCompare(a.visitedAt))
      .map(out);
    return paginate(list, query, 25);
  }
  if (method === "GET" && path === "/api/visitor/summary") return summary(rows, query);
  if (method === "GET" && path === "/api/visitor/people") return paginate(people(rows, query), query, 25);

  const one = /^\/api\/visitor\/visits\/(\d+)$/.exec(path);
  if (method === "GET" && one) {
    const row = rows.find((r) => r.id === Number(one[1]));
    if (!row) throw harnessError(404, { error: "This visit was not found." });
    const history = rows
      .filter((r) => r.visitorId === row.visitorId)
      .sort((a, b) => b.visitedAt.localeCompare(a.visitedAt))
      .map(out);
    return { ...out(row), history };
  }

  const checkOut = /^\/api\/visitor\/visits\/(\d+)\/check-out$/.exec(path);
  if (method === "POST" && checkOut) {
    const row = rows.find((r) => r.id === Number(checkOut[1]));
    if (!row) throw harnessError(404, { error: "This visit was not found." }, method, path);
    if (row.checkedOutAt) {
      throw harnessError(
        409,
        { error: `${row.name} was already checked out at 11:15.`, code: "already_checked_out" },
        method,
        path,
      );
    }
    Object.assign(row, {
      checkedOutAt: NOW,
      checkedOutBy: "Priya HR",
      checkoutSource: "hr",
      status: "checked_out",
      statusLabel: LABEL.checked_out,
      minutesInside: minutesBetween(row.visitedAt, NOW),
      notes: body.note ? `Check-out: ${String(body.note)}` : row.notes,
    });
    return out(row);
  }

  if (method === "POST" && path === "/api/visitor/visits") {
    const phone = String(body.phone ?? "");
    const known = rows.find((r) => r.phone.replace(/\D/g, "").endsWith(phone.replace(/\D/g, "").slice(-10)));
    if (known && known.status === "inside") {
      throw harnessError(
        409,
        {
          error: `${known.name} is already inside (checked in at 09:12). Check them out before registering a new visit.`,
          code: "already_inside",
          visitId: known.id,
        },
        method,
        path,
      );
    }
    const id = Math.max(...rows.map((r) => r.id)) + 1;
    const host = body.meetingEmployeeId ? HOSTS[Number(body.meetingEmployeeId)] : undefined;
    const row = visit(id, {
      name: String(body.name || known?.name || ""),
      visitorId: known?.visitorId ?? 100 + id,
      phone,
      visitedAt: NOW,
      company: (body.company as string) ?? null,
      vehicleNumber: body.vehicleNumber ? String(body.vehicleNumber).toUpperCase() : null,
      peopleCount: Number(body.peopleCount ?? 1),
      idProofType: (body.idProofType as string) ?? null,
      badgeNumber: (body.badgeNumber as string) ?? null,
      notes: (body.notes as string) ?? null,
      whomToMeet: String(body.whomToMeet ?? ""),
      purpose: String(body.purpose ?? ""),
      meetingEmployee: host ? contact(host.id) : null,
      hostDepartmentId: host?.departmentId ?? null,
      source: "hr",
      sourceLabel: SOURCE_LABEL.hr,
      checkedInBy: "Priya HR",
      visitCount: known ? rows.filter((r) => r.visitorId === known.visitorId).length + 1 : 1,
    });
    rows.push(row);
    return out(row);
  }

  // the QR form's employee look-up (the Register dialog's "meeting a specific employee?")
  if (method === "POST" && /^\/api\/visitor\/gate\/[^/]+\/check-employee-phone$/.test(path)) {
    const digits = String(body.phone ?? "").replace(/\D/g, "");
    const host = Object.values(HOSTS).find((h) => h.phone!.replace(/\D/g, "").endsWith(digits.slice(-10)));
    return host && digits.length >= 7 ? { found: true, employee: contact(host.id) } : { found: false };
  }
  return undefined;
}
