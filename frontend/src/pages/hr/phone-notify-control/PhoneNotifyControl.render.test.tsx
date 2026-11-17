import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import PhoneNotifyControl from "../PhoneNotifyControl";

// Phone Notify Control in jsdom, with a fake server behind customFetch: the tabs that each have an address and the redirects,
// which tab each address renders (and that a hidden one asks the server for nothing), the overview and its shortcuts, the
// message log with its filters in the address and Push again, the employees with mute and remove-a-phone (asked first, in the
// page), the switches (one, a group, the master switch), sending one message, the configuration, and a View-only tab.
// (It replaces the render test of the old Mobile App Login -> Mobile Messages tab.)

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as { role: string; employeeId: null; permissions: Record<string, string> } | null },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
// the shared Refresh button subscribes to every query: its re-renders are not what these tests are about
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

const BASE = "/hr/phone-notify-control";
const API = "/api/mobile-app/messages";

// ── the fake server ───────────────────────────────────────────────────────────

const COUNTS = { total: 5, sent: 3, delivered: 2, noDevice: 1, failed: 1, off: 0 };
const MONTH = { total: 12, sent: 8, delivered: 6, failed: 1, off: 2, noDevice: 1 };
// the categories match the switches of CONTROLS(): Leave all on, Attendance alerts partly off, Approvers all on
const CATEGORIES = () => [
  {
    key: "leave",
    label: "Leave",
    description: "Leave and casual leave requests: approved, rejected, passed on to the next approver.",
    keys: ["approval:leave"],
    total: 1,
    on: 1,
    audience: ["employee"],
    month: MONTH,
  },
  {
    key: "attendance",
    label: "Attendance alerts",
    description: "Absent, late, punch reminders and missing punches.",
    keys: ["late_alert", "absent_alert"],
    total: 2,
    on: 1,
    audience: ["employee"],
    month: { ...MONTH, total: 0, sent: 0, delivered: 0, failed: 0, off: 0, noDevice: 0 },
  },
  {
    key: "approvers",
    label: "Approvers & management",
    description: "What Department Heads receive.",
    keys: ["approval_waiting"],
    total: 1,
    on: 1,
    audience: ["approver"],
    month: MONTH,
  },
];
const overview = (over: Record<string, unknown> = {}) => ({
  pushEnabled: true,
  switchedOff: 1,
  kinds: 3,
  muted: 1,
  devices: { employees: 40, withDevice: 31, withoutDevice: 9, tokens: 33, lastRegisteredAt: "2026-11-10T09:00:00Z" },
  today: COUNTS,
  week: { ...COUNTS, total: 30, sent: 24, delivered: 20, failed: 2 },
  month: { ...COUNTS, total: 120, sent: 100, delivered: 90 },
  readRate: 61.5,
  byKind: [{ label: "Late alert", count: 12 }],
  byDay: Array.from({ length: 14 }, (_, i) => ({
    date: `2026-11-${String(4 + i).padStart(2, "0")}`,
    total: i,
    sent: i,
  })),
  categories: CATEGORIES(),
  // the week's failed pushes: #2 can be pushed again (it is in the log too), #4's employee has no phone now
  failedRecent: [
    LOG()[1],
    row(4, {
      employeeName: "Ravi Nair",
      employeeCode: "E8",
      title: "New chat message",
      kind: "Company chat: message from HR",
      source: "chat_announcement",
      category: "chat",
      pushStatus: "failed",
      pushStatusLabel: "Push failed",
      pushError: "MessageRateExceeded",
      canPushAgain: false,
    }),
  ],
  recipients: { mode: "staff", modeLabel: "Staff only", receiving: 142, receivingWithPhone: 37 },
  ...over,
});

const STATS = { total: 9, sent: 7, delivered: 6, failed: 1, off: 0, noDevice: 1 };
const control = (
  key: string,
  label: string,
  group: string,
  groupLabel: string,
  over: Record<string, unknown> = {},
) => ({
  key,
  label,
  description: `About ${label}`,
  group,
  groupLabel,
  kind: "message",
  enabled: true,
  sentFrom: `Sent from ${label}`,
  audience: "employee",
  stats: STATS,
  ...over,
});
const CONTROLS = () => [
  // the server's order is not the page's order: Approvals by workflow comes last, Attendance first
  control("approval:leave", "Leave", "approval_workflows", "Approvals by workflow", {
    kind: "workflow",
    stats: { ...STATS, total: 0 },
    category: "leave",
    categoryLabel: "Leave",
  }),
  control("late_alert", "Late alert", "attendance", "Attendance", {
    category: "attendance",
    categoryLabel: "Attendance alerts",
  }),
  control("absent_alert", "Absent alert", "attendance", "Attendance", {
    enabled: false,
    category: "attendance",
    categoryLabel: "Attendance alerts",
  }),
  control("approval_waiting", "Waiting for your approval", "approvals", "Approvals", {
    audience: "approver",
    category: "approvers",
    categoryLabel: "Approvers & management",
  }),
];

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  employeeId: 7,
  employeeName: "Asha Kumar",
  employeeCode: "E7",
  title: "Late Attendance",
  message: "Hi Asha, your attendance has been marked as Late today.",
  type: "attendance",
  kind: "Late alert",
  source: "late_alert",
  pushStatus: "delivered",
  pushStatusLabel: "Delivered to the phone",
  pushError: null,
  isRead: false,
  createdAt: "2026-11-17T09:30:00Z",
  pushedAt: "2026-11-17T09:30:01Z",
  canPushAgain: false,
  ...over,
});
const LOG = () => [
  row(1),
  row(2, {
    pushStatus: "failed",
    pushStatusLabel: "Push failed",
    pushError: "DeviceNotRegistered: The app was uninstalled",
    canPushAgain: true,
    title: "Request Rejected",
    kind: "Approval - Rejected: Leave",
  }),
  row(3, {
    employeeId: 8,
    employeeName: "Ravi Nair",
    employeeCode: "E8",
    pushStatus: "no_device",
    pushStatusLabel: "No phone registered",
    canPushAgain: false,
    isRead: true,
  }),
  row(5, { pushStatus: "sending", pushStatusLabel: "Sending to the phone", pushedAt: null }),
  row(6, { pushStatus: "", pushStatusLabel: "Waiting to be pushed", pushedAt: null }),
];

const DEVICES = () => [
  {
    id: 7,
    name: "Asha Kumar",
    employeeCode: "E7",
    employmentType: "staff",
    phone: "9000000001",
    devices: 1,
    lastRegisteredAt: "2026-11-10T09:00:00Z",
    muted: false,
    mutedBy: null,
    mutedAt: null,
    phones: [{ id: 5, platform: "android", registeredAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-10T09:00:00Z" }],
    isRecipient: undefined as boolean | undefined,
  },
  {
    id: 8,
    name: "Ravi Nair",
    employeeCode: "E8",
    employmentType: "production",
    phone: null,
    devices: 0,
    lastRegisteredAt: null,
    muted: true,
    mutedBy: "Test HR",
    mutedAt: "2026-11-12T09:00:00Z",
    phones: [],
    isRecipient: undefined as boolean | undefined,
  },
];

// who receives phone notifications: three active employees, Asha on the selected list
const PEOPLE = () => [
  {
    id: 7,
    name: "Asha Kumar",
    code: "E7",
    employmentType: "staff",
    department: "Accounts",
    departmentId: 5,
    branch: "Unit 1",
    branchId: 1,
    hasPhone: true,
  },
  {
    id: 8,
    name: "Ravi Nair",
    code: "E8",
    employmentType: "production",
    department: "Cutting",
    departmentId: 6,
    branch: "Unit 2",
    branchId: 2,
    hasPhone: false,
  },
  {
    id: 9,
    name: "Meena Das",
    code: "E9",
    employmentType: "production",
    department: "Stitching",
    departmentId: 7,
    branch: "Unit 1",
    branchId: 1,
    hasPhone: true,
  },
];
const BRANCHES = [
  { id: 1, name: "Unit 1", isHeadOffice: true, isActive: true },
  { id: 2, name: "Unit 2", isHeadOffice: false, isActive: true },
];
const DEPARTMENTS = [
  { id: 5, name: "Accounts", category: "staff", branchId: 1, branchName: "Unit 1" },
  { id: 6, name: "Cutting", category: "production", branchId: 2, branchName: "Unit 2" },
  { id: 7, name: "Stitching", category: "production", branchId: 1, branchName: "Unit 1" },
];
const MODE_LABEL: Record<string, string> = {
  all: "All employees",
  staff: "Staff only",
  production: "Production only",
  selected: "Selected employees",
};
type Match = { search?: string; type?: string; branch?: number; department?: number };

// the wording of each kind (Message Text), in the server's (Controls) order: Payroll, Attendance, then Chat
const ALERT_LIMITS = {
  absentExtraMinutes: { min: 0, max: 240, label: "Extra wait before the Absent alert" },
  reminderLeadMinutes: { min: 1, max: 60, label: "Punch reminder: this long before the punch is due" },
  missingAfterMinutes: { min: 0, max: 240, label: "Missing Punch alert: this long after the punch was due" },
};
type Variable = { name: string; help: string; sample: string };
const variable = (name: string, help: string, sample: string): Variable => ({ name, help, sample });
const template = (over: Record<string, unknown>) => ({
  key: "salary_slip",
  label: "Salary slip",
  description: "The salary slip PDF, sent with a short caption.",
  group: "documents",
  groupLabel: "Documents",
  category: "payroll",
  categoryLabel: "Payroll & salary",
  enabled: true,
  variables: [
    variable("employee_name", "Employee name", "Asha Kumar"),
    variable("month_year", "Month and year", "August 2026"),
  ],
  title: "",
  body: "",
  defaultTitle: "Salary Slip",
  defaultBody: "Dear {{employee_name}},\nYour salary slip for {{month_year}} is attached.",
  defaultNote: "The phone's built-in wording.",
  customised: false,
  preview: { title: "Salary Slip", body: "Dear Asha Kumar,\nYour salary slip for August 2026 is attached." },
  updatedBy: null as string | null,
  updatedAt: null as string | null,
  total: 0,
  sent: 0,
  failed: 0,
  lastSentAt: null as string | null,
  ...over,
});
const TEMPLATES = () => [
  template({}),
  template({
    key: "salary_paid",
    label: "Salary paid",
    description: "Sent when HR marks the month's payroll as Paid.",
    variables: [
      variable("employee_name", "The employee's name", "Asha Kumar"),
      variable("month", "The month paid", "October 2026"),
      variable("headline", "The built-in title of this notification", "Salary Paid"),
      variable("message", "The built-in sentence of this notification", "Your salary for October 2026 has been paid."),
    ],
    title: "Paid: {{month}}",
    defaultTitle: "Salary Paid",
    defaultBody: "Your salary for {{month}} has been paid.",
    defaultNote: "Names the month, never the amount.",
    customised: true,
    preview: { title: "Paid: October 2026", body: "Your salary for October 2026 has been paid." },
    updatedBy: "Test HR",
    updatedAt: "2026-11-16T10:00:00Z",
    total: 264,
    sent: 2,
    failed: 1,
    lastSentAt: "2026-11-10T07:20:44Z",
  }),
  template({
    key: "late_alert",
    label: "Late alert",
    description: "Sent when an employee is marked late.",
    category: "attendance",
    categoryLabel: "Attendance alerts",
    enabled: false,
    variables: [variable("employee_name", "Employee name", "Asha Kumar")],
    defaultTitle: "Late Attendance",
    defaultBody: "Hi {{employee_name}}, you were marked late today.",
    preview: { title: "Late Attendance", body: "Hi Asha Kumar, you were marked late today." },
  }),
  template({
    key: "chat_message",
    label: "Chat message",
    description: "A new message in a chat.",
    category: "chat",
    categoryLabel: "Internal chat",
    variables: [
      variable("headline", "The built-in title", "New message"),
      variable("message", "The built-in sentence", "Hi"),
    ],
    defaultTitle: "{{headline}}",
    defaultBody: "{{message}}",
    preview: { title: "New message", body: "Hi" },
  }),
];
type Template = ReturnType<typeof TEMPLATES>[number];
/** The server's filling-in: every {{name}} by its sample; an unknown one is an error that names the allowed ones. */
function fillWording(t: Template, title: string, body: string) {
  const names = t.variables.map((v) => v.name);
  const unknown = [...`${title} ${body}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).find((n) => !names.includes(n));
  const fill = (s: string) =>
    s.replace(/\{\{(\w+)\}\}/g, (_, n: string) => t.variables.find((v) => v.name === n)?.sample ?? "");
  return {
    title: fill(title || t.defaultTitle),
    body: fill(body || t.defaultBody),
    error: unknown ? `Unknown placeholder {{${unknown}}}. Allowed: ${names.map((n) => `{{${n}}}`).join(", ")}.` : null,
  };
}

const config = (over: Record<string, unknown> = {}) => ({
  service: {
    provider: "Expo push service",
    transport: "Firebase Cloud Messaging (Android)",
    url: "https://exp.host/--/api/v2/push/send",
    androidChannel: "default",
    appPackage: "net.uktex.employee",
  },
  health: {
    state: "ok",
    note: "Pushes are reaching phones.",
    lastSentAt: "2026-11-17T09:30:01Z",
    lastDeliveredAt: "2026-11-17T09:31:00Z",
    sent30: 120,
    delivered30: 110,
    failed30: 3,
    failureReasons: [
      {
        reason: "DeviceNotRegistered",
        label: "App uninstalled / notifications reset",
        count: 2,
        advice: "The app was uninstalled or its notifications were reset on that phone.",
      },
    ],
    ...over,
  },
  phones: { employeesWithPhone: 31, tokens: 33, lastRegisteredAt: "2026-11-10T09:00:00Z" },
  pushEnabled: true,
});

type Call = { method: string; path: string; body: Record<string, unknown> };
type World = {
  overview: ReturnType<typeof overview>;
  config: ReturnType<typeof config>;
  pushEnabled: boolean;
  controls: ReturnType<typeof CONTROLS>;
  log: ReturnType<typeof LOG>;
  devices: ReturnType<typeof DEVICES>;
  calls: Call[];
  gets: string[];
  failNext: Record<string, Error>;
  mode: string;
  picked: Set<number>;
  people: ReturnType<typeof PEOPLE>;
  templates: Template[];
  alert: { absentExtraMinutes: number; reminderLeadMinutes: number; missingAfterMinutes: number };
};

let world: World;

const paged = <T,>(items: T[], qs: URLSearchParams) => ({
  items,
  total: items.length,
  page: Number(qs.get("page") ?? 1),
  pageSize: Number(qs.get("pageSize") ?? 20),
});

function install() {
  world = {
    overview: overview(),
    config: config(),
    pushEnabled: true,
    controls: CONTROLS(),
    log: LOG(),
    devices: DEVICES(),
    calls: [],
    gets: [],
    failNext: {},
    mode: "all",
    picked: new Set([7]),
    people: PEOPLE(),
    templates: TEMPLATES(),
    alert: { absentExtraMinutes: 0, reminderLeadMinutes: 15, missingAfterMinutes: 20 },
  };
  h.fetch.mockReset();
  h.fetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const [path, query = ""] = url.split("?");
    const qs = new URLSearchParams(query);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (method === "GET") world.gets.push(url);
    else world.calls.push({ method, path, body });
    const failure = world.failNext[`${method} ${path}`];
    if (failure) {
      delete world.failNext[`${method} ${path}`];
      throw failure;
    }
    const matching = (m: Match) =>
      world.people.filter(
        (e) =>
          (!m.search || `${e.name} ${e.code}`.toLowerCase().includes(m.search.toLowerCase())) &&
          (!m.type || e.employmentType === m.type) &&
          (!m.branch || e.branchId === m.branch) &&
          (!m.department || e.departmentId === m.department),
      );
    const recipientsBody = () => {
      const reach = (list: ReturnType<typeof PEOPLE>) => ({
        employees: list.length,
        withPhone: list.filter((e) => e.hasPhone).length,
      });
      const of: Record<string, ReturnType<typeof PEOPLE>> = {
        all: world.people,
        staff: world.people.filter((e) => e.employmentType === "staff"),
        production: world.people.filter((e) => e.employmentType === "production"),
        selected: world.people.filter((e) => world.picked.has(e.id)),
      };
      const now = reach(of[world.mode]);
      return {
        mode: world.mode,
        modes: Object.keys(of).map((key) => ({
          key,
          label: MODE_LABEL[key],
          description: `About ${key}`,
          ...reach(of[key]),
        })),
        selected: of.selected.length,
        selectedWithPhone: reach(of.selected).withPhone,
        receiving: now.employees,
        receivingWithPhone: now.withPhone,
        updatedBy: "Test HR",
        updatedAt: "2026-11-16T10:00:00Z",
      };
    };
    const controlsBody = () => ({
      pushEnabled: world.pushEnabled,
      controls: world.controls,
      updatedBy: "Test HR",
      updatedAt: "2026-11-16T10:00:00Z",
    });

    if (method === "GET" && path === `${API}/overview`) return world.overview;
    if (method === "GET" && path === `${API}/config`) return world.config;
    if (method === "GET" && path === `${API}/controls`) return controlsBody();
    if (method === "PUT" && path === `${API}/controls`) {
      if (typeof body.pushEnabled === "boolean") world.pushEnabled = body.pushEnabled;
      const types = (body.types ?? {}) as Record<string, boolean>;
      world.controls = world.controls.map((c) => (c.key in types ? { ...c, enabled: types[c.key] } : c));
      return controlsBody();
    }
    if (method === "GET" && path === `${API}/log`) {
      const status = qs.get("status");
      return paged(
        world.log.filter((r) => !status || r.pushStatus === status),
        qs,
      );
    }
    const again = path.match(/^\/api\/mobile-app\/messages\/log\/(\d+)\/push-again$/);
    if (method === "POST" && again) {
      const r = world.log.find((x) => x.id === Number(again[1]))!;
      Object.assign(r, { pushStatus: "sent", pushStatusLabel: "Sent, not confirmed yet", canPushAgain: false });
      return r;
    }
    if (method === "GET" && path === `${API}/devices`) {
      const muted = qs.get("muted") === "1";
      const has = qs.get("has");
      return paged(
        world.devices.filter(
          (d) => (!muted || d.muted) && (has !== "with" || d.devices > 0) && (has !== "without" || d.devices === 0),
        ),
        qs,
      );
    }
    const mute = path.match(/^\/api\/mobile-app\/messages\/devices\/(\d+)\/mute$/);
    if (method === "PUT" && mute) {
      const d = world.devices.find((x) => x.id === Number(mute[1]))!;
      d.muted = body.muted as boolean;
      return d;
    }
    const phone = path.match(/^\/api\/mobile-app\/messages\/devices\/phones\/(\d+)$/);
    if (method === "DELETE" && phone) {
      for (const d of world.devices) {
        d.phones = d.phones.filter((p) => p.id !== Number(phone[1]));
        d.devices = d.phones.length;
      }
      return undefined;
    }
    if (method === "POST" && path === `${API}/send`) {
      return row(9, {
        title: body.title,
        message: body.message,
        kind: "Message from HR",
        pushStatus: "sent",
        pushStatusLabel: "Sent, not confirmed yet",
      });
    }
    // who receives phone notifications (the Settings tab)
    if (method === "GET" && path === `${API}/recipients`) return recipientsBody();
    if (method === "PUT" && path === `${API}/recipients`) {
      if (body.mode === "selected" && world.picked.size === 0) {
        throw Object.assign(new Error("Bad Request"), { data: { error: "Select at least one employee first." } });
      }
      world.mode = body.mode as string;
      return recipientsBody();
    }
    if (method === "GET" && path === `${API}/recipients/employees`) {
      const items = matching({
        search: qs.get("search") ?? undefined,
        type: qs.get("type") ?? undefined,
        branch: qs.get("branch") ? Number(qs.get("branch")) : undefined,
        department: qs.get("department") ? Number(qs.get("department")) : undefined,
      })
        .filter((e) => qs.get("selected") !== "1" || world.picked.has(e.id))
        .filter((e) => qs.get("selected") !== "0" || !world.picked.has(e.id))
        .map((e) => ({ ...e, selected: world.picked.has(e.id) }));
      return paged(items, qs);
    }
    if (method === "POST" && path === `${API}/recipients/employees`) {
      const before = world.picked.size;
      if (Array.isArray(body.add)) for (const id of body.add as number[]) world.picked.add(id);
      if (Array.isArray(body.remove)) for (const id of body.remove as number[]) world.picked.delete(id);
      if (body.addMatching) for (const e of matching(body.addMatching as Match)) world.picked.add(e.id);
      if (body.removeMatching) for (const e of matching(body.removeMatching as Match)) world.picked.delete(e.id);
      if (body.clear) world.picked.clear();
      return { ...recipientsBody(), changed: Math.abs(world.picked.size - before) };
    }
    // the timing of the phone attendance alerts (Settings)
    const alertBody = () => ({
      ...world.alert,
      limits: ALERT_LIMITS,
      updatedBy: "Test HR",
      updatedAt: "2026-11-16T10:00:00Z",
    });
    if (method === "GET" && path === `${API}/alert-settings`) return alertBody();
    if (method === "PUT" && path === `${API}/alert-settings`) {
      for (const [k, v] of Object.entries(body)) {
        const limit = ALERT_LIMITS[k as keyof typeof ALERT_LIMITS];
        if (!limit || typeof v !== "number" || v < limit.min || v > limit.max) {
          throw Object.assign(new Error("Bad Request"), { data: { error: `${k} must be between its limits.` } });
        }
      }
      Object.assign(world.alert, body);
      return alertBody();
    }
    // the wording of each kind (Message Text)
    if (method === "GET" && path === `${API}/templates`) return world.templates;
    const wording = path.match(/^\/api\/mobile-app\/messages\/templates\/([^/]+)(\/preview)?$/);
    if (wording) {
      const t = world.templates.find((x) => x.key === decodeURIComponent(wording[1]));
      if (!t) throw Object.assign(new Error("Not Found"), { data: { error: "No such kind." } });
      const title = String(body.title ?? "");
      const text = String(body.body ?? "");
      const filled = fillWording(t, title, text);
      if (method === "POST" && wording[2]) return filled;
      if (method === "PUT") {
        if (filled.error) throw Object.assign(new Error("Bad Request"), { data: { error: filled.error } });
        Object.assign(t, {
          title,
          body: text,
          customised: !!(title || text),
          updatedBy: title || text ? "Test HR" : null,
          updatedAt: title || text ? "2026-11-17T12:00:00Z" : null,
          preview: { title: filled.title, body: filled.body },
        });
        return { ...t };
      }
    }
    if (method === "GET" && path === "/api/branches") return BRANCHES;
    if (method === "GET" && path === "/api/departments") return DEPARTMENTS;
    throw new Error(`unexpected request ${method} ${url}`);
  });
}

// ── mounting and the DOM ──────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLElement | null = null;

const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body).slice(0, 600)}`);
  return el;
};
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error(`nothing to click; the page shows: ${text(document.body).slice(0, 400)}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(10);
};
async function waitFor(check: () => boolean, what: string, timeoutMs = 4000) {
  const t0 = performance.now();
  while (!check()) {
    if (performance.now() - t0 > timeoutMs) {
      throw new Error(`timed out waiting for ${what}: ${text(document.body).slice(0, 500)}`);
    }
    await settle(8);
  }
}
/** Types into a controlled field, or picks an option, the way a user does (React tracks the value itself). */
async function setValue(el: HTMLElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await settle(10);
}
const button = (name: string | RegExp): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    typeof name === "string" ? text(b) === name : name.test(text(b)),
  );
const tabs = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="pn-subtabs"] [role="tab"]')];
/** A pill's own label (the pill draws its label twice, for its animation). */
const label = (el: Element) => text(el.querySelector(".ptab-label") ?? el);
const tab = (name: string) => tabs().find((t) => label(t) === name);
const pathname = () => window.location.pathname;
const asked = () => world.gets.map((u) => u.split("?")[0]);
const changes = (method?: string) => world.calls.filter((c) => !method || c.method === method);

async function open(url: string, ready: string) {
  window.history.replaceState(null, "", url);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, staleTime: Infinity, gcTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(PhoneNotifyControl))));
  await waitFor(() => !!q(ready), ready);
  await settle(10);
}

const as = (permissions: Record<string, string>) => {
  h.user.current = { role: "hr", employeeId: null, permissions };
};

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
  vi.clearAllMocks();
  h.user.current = null; // no login in the test: every key is Edit (permissionLevel)
  install();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

// ── the tests ─────────────────────────────────────────────────────────────────

describe("the addresses", () => {
  it("the bare page opens the Overview at its own address, with the heading and the eight tabs", async () => {
    await open(BASE, "pn-overview");
    expect(pathname()).toBe(`${BASE}/overview`);
    expect([...document.body.querySelectorAll("h2")].map(text)).toEqual(["Phone Notify Control"]);
    expect(tabs().map(label)).toEqual([
      "Overview",
      "Messages",
      "Employees",
      "Controls",
      "Send a message",
      "Configuration",
      "Message Text",
      "Settings",
    ]);
    expect(tab("Overview")?.getAttribute("aria-selected")).toBe("true");
  });

  it("a click on a tab opens it at its own address, and only it asks the server for anything", async () => {
    await open(`${BASE}/messages`, "pn-messages");
    expect(asked()).not.toContain(`${API}/overview`);
    await click(tab("Employees"));
    await waitFor(() => !!q("pn-employees"), "the employees");
    expect(pathname()).toBe(`${BASE}/employees`);
    expect(q("pn-messages")).toBeNull();
    await click(tab("Configuration"));
    await waitFor(() => !!q("pn-config"), "the configuration");
    expect(pathname()).toBe(`${BASE}/configuration`);
  });

  it("an unknown tab lands on the first one, keeping the query string", async () => {
    await open(`${BASE}/nope?from=link`, "pn-overview");
    expect(`${window.location.pathname}${window.location.search}`).toBe(`${BASE}/overview?from=link`);
  });

  it("offers only the tabs the role may open, and sends a hidden one's address to the first open tab", async () => {
    as({
      phone_notify_control: "edit",
      "phone_notify_control.overview": "hidden",
      "phone_notify_control.send": "hidden",
    });
    await open(`${BASE}/send`, "pn-messages");
    expect(pathname()).toBe(`${BASE}/messages`);
    expect(tabs().map(label)).toEqual([
      "Messages",
      "Employees",
      "Controls",
      "Configuration",
      "Message Text",
      "Settings",
    ]);
    expect(asked()).not.toContain(`${API}/overview`);
  });

  it("follows Mobile App Login while nothing is set on the page, and says so when nothing is open", async () => {
    as({ mobile_app_login: "view" });
    await open(BASE, "pn-overview");
    expect(tabs()).toHaveLength(8);
    act(() => root?.unmount());
    host?.remove();
    world.gets = [];
    as({ mobile_app_login: "edit", phone_notify_control: "hidden" });
    await open(BASE, "pn-nothing-open");
    expect(world.gets).toEqual([]);
  });
});

describe("the overview", () => {
  it("shows the master switch, the phones and what became of the pushes, the chart and the kinds", async () => {
    await open(`${BASE}/overview`, "pn-overview");
    const t = text(must("pn-tiles"));
    for (const needle of ["ON", "2 of 3 kinds on", "31 / 40", "Pushed today", "24", "20", "83% of what went out"]) {
      expect(t, needle).toContain(needle);
    }
    expect(text(must("pn-read-rate"))).toContain("61.5%");
    expect(text(must("pn-counts"))).toContain("3 pushed");
    expect(text(must("pn-by-kind"))).toContain("Late alert");
    expect(q("pn-bar-2026-11-17")).not.toBeNull();
    expect(q("pn-master-off")).toBeNull();
    expect(q("pn-health-banner")).toBeNull();
  });

  it("puts a warning on top when phone notifications are off, or the push service is not healthy", async () => {
    world.overview = overview({ pushEnabled: false });
    world.config = config({ state: "problem", note: "Google refused pushes: the app's Firebase key is missing." });
    await open(`${BASE}/overview`, "pn-overview");
    await waitFor(() => !!q("pn-health-banner"), "the health banner");
    expect(text(must("pn-master-off"))).toContain("Switch them on");
    expect(text(must("pn-health-banner"))).toContain("Firebase key is missing");
    expect(text(must("pn-tile-master"))).toContain("OFF");
  });

  it("offers a shortcut only into a tab the role may open, and reads the health only with Configuration open", async () => {
    world.overview = overview({ pushEnabled: false });
    as({
      phone_notify_control: "edit",
      "phone_notify_control.controls": "hidden",
      "phone_notify_control.configuration": "hidden",
    });
    await open(`${BASE}/overview`, "pn-overview");
    expect(text(must("pn-master-off"))).not.toContain("Switch them on");
    expect(asked()).not.toContain(`${API}/config`);
    expect(text(must("pn-tile-failed"))).toContain("See the failures");
  });

  it("a shortcut opens the Messages tab already filtered", async () => {
    await open(`${BASE}/overview`, "pn-overview");
    const link = [...must("pn-tile-failed").querySelectorAll("a")].find((a) => text(a).includes("See the failures"));
    await click(link);
    await waitFor(() => !!q("pn-messages"), "the messages");
    expect(`${window.location.pathname}${window.location.search}`).toBe(`${BASE}/messages?status=failed`);
    await waitFor(() => world.gets.some((u) => u.includes("/log?") && u.includes("status=failed")), "the filtered log");
  });

  it("an older server without categories or failed pushes shows neither section", async () => {
    world.overview = overview({ categories: undefined, failedRecent: undefined });
    await open(`${BASE}/overview`, "pn-overview");
    expect(q("pn-categories")).toBeNull();
    expect(q("pn-attention")).toBeNull();
    expect(q("pn-tiles")).not.toBeNull();
  });

  it("says when the overview could not be loaded, with a Try again", async () => {
    world.failNext[`GET ${API}/overview`] = new Error("offline");
    await open(`${BASE}/overview`, "pn-overview-error");
    expect(button("Try again")).toBeDefined();
  });
});

describe("the overview's categories", () => {
  /** A category's five numbers of the last 30 days, by name. */
  const monthStats = (key: string) =>
    Object.fromEntries(
      [...must(`pn-category-month-${key}`).querySelectorAll("dl > div")].map((d) => [
        text(d.querySelector("dt")),
        text(d.querySelector("dd")),
      ]),
    );

  it("shows each category with its switches, its 30 days, who gets it and a way into its switches", async () => {
    await open(`${BASE}/overview`, "pn-categories");
    const cards = [...document.body.querySelectorAll('article[data-testid^="pn-category-"]')].map((c) =>
      c.getAttribute("data-testid"),
    );
    expect(cards).toEqual(["pn-category-leave", "pn-category-attendance", "pn-category-approvers"]);
    const leave = must("pn-category-leave");
    expect(leave.getAttribute("data-state")).toBe("on");
    expect(text(must("pn-category-count-leave"))).toBe("1 of 1 switch on");
    expect(text(must("pn-category-state-leave"))).toBe("ON");
    expect(text(leave)).toContain("Leave and casual leave requests");
    expect(text(must("pn-category-month-leave"))).toContain("Last 30 days: 12 saved in the app");
    expect(monthStats("leave")).toEqual({
      Pushed: "8",
      Delivered: "6",
      Failed: "1",
      "Switched off": "2",
      "No phone": "1",
    });
    expect(text(must("pn-category-month-attendance"))).toContain("none sent");
    expect(text(leave)).toMatch(/Goes to: ?Employees/);
    expect(text(must("pn-category-approvers"))).toMatch(/Goes to: ?Approvers/);
    expect(must("pn-category-manage-attendance").getAttribute("href")).toBe(`${BASE}/controls?category=attendance`);
    expect(text(must("pn-categories-summary"))).toBe("2 of 3 categories fully on");
  });

  it("shows a category with only some switches on as Some off, and turns it all on without asking", async () => {
    await open(`${BASE}/overview`, "pn-categories");
    await waitFor(() => world.gets.some((u) => u.startsWith(`${API}/controls`)), "the switches");
    const card = must("pn-category-attendance");
    expect(card.getAttribute("data-state")).toBe("partial");
    expect(text(must("pn-category-state-attendance"))).toBe("Some off");
    expect(text(must("pn-category-count-attendance"))).toBe("1 of 2 switches on");
    expect((must("pn-category-switch-attendance") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
    await click(must("pn-category-switch-attendance"));
    expect(q("pn-confirm-category-attendance")).toBeNull();
    await waitFor(() => changes().length === 1, "the change");
    // only the switch that was off is sent
    expect(changes()).toEqual([{ method: "PUT", path: `${API}/controls`, body: { types: { absent_alert: true } } }]);
    await waitFor(() => must("pn-category-attendance").getAttribute("data-state") === "on", "the category ON");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Attendance alerts: every switch ON" }));
    // the overview is asked again after the change
    await waitFor(() => world.gets.filter((u) => u.startsWith(`${API}/overview`)).length >= 2, "the overview again");
  });

  it("asks in the page before turning a whole category off, and Cancel changes nothing", async () => {
    await open(`${BASE}/overview`, "pn-categories");
    await click(must("pn-category-switch-leave"));
    expect(text(must("pn-confirm-category-leave"))).toContain("Turn off all 1 switch in Leave?");
    expect(text(must("pn-confirm-category-leave"))).toContain("still saved in the app");
    await click(button("Cancel"));
    expect(q("pn-confirm-category-leave")).toBeNull();
    expect(changes()).toEqual([]);
    await click(must("pn-category-switch-leave"));
    await click(must("pn-confirm-category-leave-yes"));
    await waitFor(() => changes().length === 1, "the change");
    expect(changes()[0].body).toEqual({ types: { "approval:leave": false } });
    await waitFor(() => must("pn-category-leave").getAttribute("data-state") === "off", "the category OFF");
    expect(q("pn-confirm-category-leave")).toBeNull();
  });

  it("a category's Manage opens the Controls tab narrowed to it", async () => {
    await open(`${BASE}/overview`, "pn-categories");
    await click(must("pn-category-manage-attendance"));
    await waitFor(() => !!q("pn-controls"), "the switches");
    expect(`${window.location.pathname}${window.location.search}`).toBe(`${BASE}/controls?category=attendance`);
    await waitFor(() => !!q("pn-group-attendance"), "the attendance group");
    expect(q("pn-group-approvals")).toBeNull();
    expect(q("pn-group-approval_workflows")).toBeNull();
    expect(must("pn-category-filter-attendance").getAttribute("aria-pressed")).toBe("true");
  });

  it("locks the category switches without the Controls tab's right, and says why", async () => {
    as({ phone_notify_control: "edit", "phone_notify_control.controls": "view" });
    await open(`${BASE}/overview`, "pn-categories");
    expect((must("pn-category-switch-leave") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-category-switch-attendance") as HTMLButtonElement).disabled).toBe(true);
    expect(text(must("pn-categories-locked"))).toBe("View only: you can look, but changes can't be saved.");
    await click(must("pn-category-switch-leave"));
    expect(q("pn-confirm-category-leave")).toBeNull();
    expect(changes()).toEqual([]);
    // looking around stays open: Manage still leads to the (View-only) switches
    expect(q("pn-category-manage-leave")).not.toBeNull();
  });

  it("locks them on a View-only Overview too, and offers no Manage when Controls is hidden", async () => {
    as({
      phone_notify_control: "edit",
      "phone_notify_control.overview": "view",
      "phone_notify_control.controls": "hidden",
    });
    await open(`${BASE}/overview`, "pn-categories");
    expect((must("pn-category-switch-leave") as HTMLButtonElement).disabled).toBe(true);
    expect(q("pn-category-manage-leave")).toBeNull();
    expect(asked()).not.toContain(`${API}/controls`);
    // the overview's own numbers are shown when the switches cannot be read
    expect(must("pn-category-attendance").getAttribute("data-state")).toBe("partial");
  });
});

describe("the overview's failed pushes", () => {
  it("lists the week's failed pushes with the reason, Push again where it can be, and a way to all of them", async () => {
    await open(`${BASE}/overview`, "pn-attention");
    const two = text(must("pn-failed-2"));
    for (const needle of ["Asha Kumar", "(E7)", "Request Rejected", "Reason: DeviceNotRegistered"]) {
      expect(two, needle).toContain(needle);
    }
    expect(text(must("pn-failed-4"))).toContain("Ravi Nair");
    expect(text(must("pn-failed-4"))).toContain("Reason: MessageRateExceeded");
    expect(q("pn-again-4")).toBeNull();
    expect(text(must("pn-failed-nophone-4"))).toBe("No phone registered now");
    expect(must("pn-attention-all").getAttribute("href")).toBe(`${BASE}/messages?status=failed`);
    await click(must("pn-again-2"));
    expect(changes()).toEqual([{ method: "POST", path: `${API}/log/2/push-again`, body: {} }]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Pushed again" }));
  });

  it("names the category of a failed push when the overview has it", async () => {
    world.overview = overview({
      categories: [...CATEGORIES(), { ...CATEGORIES()[0], key: "chat", label: "Internal chat", keys: [] }],
    });
    await open(`${BASE}/overview`, "pn-attention");
    expect(text(must("pn-failed-4"))).toContain("New chat message · Internal chat");
  });

  it("says so calmly when nothing failed this week", async () => {
    world.overview = overview({ failedRecent: [] });
    await open(`${BASE}/overview`, "pn-attention");
    expect(text(must("pn-attention-empty"))).toBe("No failed pushes this week.");
    expect(q("pn-attention-all")).toBeNull();
  });

  it("locks Push again without the Messages tab's right", async () => {
    as({ phone_notify_control: "edit", "phone_notify_control.messages": "view" });
    await open(`${BASE}/overview`, "pn-attention");
    expect((must("pn-again-2") as HTMLButtonElement).disabled).toBe(true);
    await click(must("pn-again-2"));
    expect(changes()).toEqual([]);
  });
});

describe("the messages", () => {
  it("lists each notification with what happened to its push, and filters through the address", async () => {
    await open(`${BASE}/messages`, "pn-row-1");
    const t = text(must("pn-message-table"));
    for (const needle of ["Asha Kumar", "(E7)", "Delivered to the phone", "Push failed", "No phone registered"]) {
      expect(t, needle).toContain(needle);
    }
    expect(t).toContain("Reason: DeviceNotRegistered");
    await setValue(must("pn-status-filter"), "failed");
    expect(window.location.search).toBe("?status=failed");
    await waitFor(() => !q("pn-row-1"), "the filtered list");
    expect(world.gets.some((u) => u.includes("/log?") && u.includes("status=failed"))).toBe(true);
    await click(must("pn-clear-filters"));
    expect(window.location.search).toBe("");
  });

  it("names a push being sent and one waiting for its turn", async () => {
    await open(`${BASE}/messages`, "pn-row-5");
    expect(text(must("pn-row-5"))).toContain("Sending to the phone");
    expect(text(must("pn-row-6"))).toContain("Waiting to be pushed");
    expect(q("pn-again-5")).toBeNull();
    expect(q("pn-again-6")).toBeNull();
  });

  it("offers Push again only where the server allows it, and pushes that one again", async () => {
    await open(`${BASE}/messages`, "pn-row-1");
    expect(q("pn-again-1")).toBeNull();
    expect(q("pn-again-3")).toBeNull();
    await click(must("pn-again-2"));
    expect(changes()).toEqual([{ method: "POST", path: `${API}/log/2/push-again`, body: {} }]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Pushed again" }));
  });

  it("says why when a push again is refused", async () => {
    const refusal = Object.assign(new Error("HTTP 400"), {
      data: { error: "This employee has no phone registered for notifications." },
    });
    world.failNext[`POST ${API}/log/2/push-again`] = refusal;
    await open(`${BASE}/messages`, "pn-row-1");
    await click(must("pn-again-2"));
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not push it again",
        description: "This employee has no phone registered for notifications.",
        variant: "destructive",
      }),
    );
  });

  it("opens the details of one notification: the full text and what its result means", async () => {
    await open(`${BASE}/messages`, "pn-row-2");
    await click(must("pn-details-2"));
    const detail = must("pn-message-detail");
    expect(text(detail)).toContain("Hi Asha, your attendance has been marked as Late today.");
    expect(text(detail)).toContain("The push service refused it");
    expect(text(detail)).toContain("DeviceNotRegistered");
    expect(detail.querySelector('[data-testid="pn-again-2"]')).not.toBeNull();
  });
});

describe("the employees", () => {
  it("lists who has a phone and who is muted, and filters by what is picked", async () => {
    await open(`${BASE}/employees`, "pn-employee-7");
    expect(text(must("pn-employee-7"))).toContain("1 phone");
    expect(text(must("pn-employee-8"))).toContain("No phone yet");
    expect(text(must("pn-employee-8"))).toContain("Muted");
    expect(text(must("pn-employee-8"))).toContain("Production");
    await click(tabsIn("pn-employee-filter").find((b) => label(b) === "Muted"));
    expect(window.location.search).toBe("?show=muted");
    await waitFor(() => !q("pn-employee-7"), "the muted list");
    expect(world.gets.some((u) => u.includes("/devices?") && u.includes("muted=1"))).toBe(true);
  });

  it("mutes an employee only after asking in the page, and Cancel changes nothing", async () => {
    await open(`${BASE}/employees`, "pn-employee-7");
    await click(must("pn-mute-7"));
    expect(text(must("pn-confirm-mute-7"))).toContain("No phone notification will reach them");
    await click(button("Cancel"));
    expect(q("pn-confirm-mute-7")).toBeNull();
    expect(changes()).toEqual([]);
    await click(must("pn-mute-7"));
    await click(must("pn-confirm-mute-7-yes"));
    expect(changes()).toEqual([{ method: "PUT", path: `${API}/devices/7/mute`, body: { muted: true } }]);
    await waitFor(() => text(must("pn-employee-7")).includes("Unmute notifications"), "the muted row");
  });

  it("unmutes a muted employee", async () => {
    await open(`${BASE}/employees`, "pn-employee-8");
    expect(text(must("pn-mute-8"))).toBe("Unmute notifications");
    await click(must("pn-mute-8"));
    await click(must("pn-confirm-mute-8-yes"));
    expect(changes()).toEqual([{ method: "PUT", path: `${API}/devices/8/mute`, body: { muted: false } }]);
  });

  it("shows an employee's phones and removes one after asking", async () => {
    await open(`${BASE}/employees`, "pn-employee-7");
    expect(q("pn-phone-5")).toBeNull();
    await click(must("pn-phones-7"));
    expect(text(must("pn-phone-5"))).toContain("Android phone");
    await click(must("pn-remove-5"));
    expect(text(must("pn-confirm-remove-5"))).toContain("registers it again");
    await click(must("pn-confirm-remove-5-yes"));
    expect(changes()).toEqual([{ method: "DELETE", path: `${API}/devices/phones/5`, body: {} }]);
    await waitFor(() => text(must("pn-employee-7")).includes("No phone yet"), "the phone gone");
  });
});

/** The buttons inside a test id (a pill row). */
function tabsIn(id: string): HTMLButtonElement[] {
  return [...must(id).querySelectorAll<HTMLButtonElement>("button")];
}

describe("the controls", () => {
  it("groups the switches in the page's order, each with where it is sent from, who gets it and its 30 days", async () => {
    await open(`${BASE}/controls`, "pn-controls");
    const groups = [...document.body.querySelectorAll('[data-testid^="pn-group-"]')]
      .map((g) => g.getAttribute("data-testid"))
      .filter((id) => /^pn-group-[a-z_]+$/.test(id ?? ""));
    expect(groups).toEqual(["pn-group-attendance", "pn-group-approvals", "pn-group-approval_workflows"]);
    const late = text(must("pn-control-late_alert"));
    for (const needle of ["To the employee", "Sent from: Sent from Late alert"]) {
      expect(late, needle).toContain(needle);
    }
    expect(text(must("pn-stats-late_alert"))).toContain("9 saved · 7 pushed · 6 delivered · 1 failed · 1 no phone");
    expect(text(must("pn-control-approval_waiting"))).toContain("To the approver");
    expect(text(must("pn-group-approval_workflows"))).toContain("both its own kind above and its workflow");
    expect(text(must("pn-controls"))).toContain("only stop the push to the phone");
  });

  it("switches one kind, a whole group (only the ones that change) and, after asking, the master switch", async () => {
    await open(`${BASE}/controls`, "pn-controls");
    await click(must("pn-toggle-late_alert"));
    await waitFor(() => changes().length === 1, "the first change");
    await click(must("pn-group-on-attendance"));
    await waitFor(() => changes().length === 2, "the group change");
    expect(changes().map((c) => c.body)).toEqual([
      { types: { late_alert: false } },
      { types: { late_alert: true, absent_alert: true } },
    ]);
    await click(must("pn-master-switch"));
    expect(text(must("pn-confirm-master"))).toContain("No notification will be pushed to any phone");
    expect(changes()).toHaveLength(2);
    await click(must("pn-confirm-master-yes"));
    await waitFor(() => changes().length === 3, "the master switch");
    expect(changes()[2].body).toEqual({ pushEnabled: false });
    await waitFor(() => must("pn-master").getAttribute("data-state") === "off", "the master switch OFF");
    expect(q("pn-master-off-note")).not.toBeNull();
  });
});

describe("the controls' category filter", () => {
  const groupIds = () =>
    [...document.body.querySelectorAll('[data-testid^="pn-group-"]')]
      .map((g) => g.getAttribute("data-testid"))
      .filter((id) => /^pn-group-[a-z_]+$/.test(id ?? ""));

  it("offers All and every category, and the address narrows the groups to one category", async () => {
    await open(`${BASE}/controls?category=approvers`, "pn-controls");
    const chips = [...must("pn-category-filter").querySelectorAll("button")].map((b) => text(b));
    expect(chips).toEqual(["All 4", "Leave 1", "Attendance alerts 1/2", "Approvers & management 1"]);
    expect(groupIds()).toEqual(["pn-group-approvals"]);
    expect(text(must("pn-category-showing"))).toContain("Showing the 1 switch of Approvers & management");
    expect(must("pn-category-filter-approvers").getAttribute("aria-pressed")).toBe("true");
    await click(must("pn-category-filter-all"));
    expect(window.location.search).toBe("");
    expect(groupIds()).toEqual(["pn-group-attendance", "pn-group-approvals", "pn-group-approval_workflows"]);
    await click(must("pn-category-filter-leave"));
    expect(window.location.search).toBe("?category=leave");
    expect(groupIds()).toEqual(["pn-group-approval_workflows"]);
    expect(q("pn-control-late_alert")).toBeNull();
  });

  it("shows every category for a category it does not know", async () => {
    await open(`${BASE}/controls?category=nope`, "pn-controls");
    expect(must("pn-category-filter-all").getAttribute("aria-pressed")).toBe("true");
    expect(groupIds()).toHaveLength(3);
    expect(q("pn-category-showing")).toBeNull();
  });

  it("a narrowed group's Turn all on changes only its own switches", async () => {
    await open(`${BASE}/controls?category=attendance`, "pn-controls");
    expect(text(must("pn-group-attendance"))).toContain("1 of 2 on");
    await click(must("pn-group-on-attendance"));
    await waitFor(() => changes().length === 1, "the group change");
    expect(changes()[0].body).toEqual({ types: { absent_alert: true } });
    await waitFor(
      () => text(must("pn-category-filter-attendance")) === "Attendance alerts 2",
      "the chip with every switch on",
    );
  });

  it("offers no category filter when the server does not say the categories", async () => {
    // an older server: the switches carry no category
    world.controls = CONTROLS().map((c) => {
      const rest: Record<string, unknown> = { ...c };
      delete rest.category;
      delete rest.categoryLabel;
      return rest;
    }) as typeof world.controls;
    await open(`${BASE}/controls?category=leave`, "pn-controls");
    expect(q("pn-category-filter")).toBeNull();
    expect(groupIds()).toHaveLength(3);
  });
});

describe("sending a message", () => {
  it("sends one message to one chosen employee", async () => {
    await open(`${BASE}/send`, "pn-send");
    await waitFor(() => !!q("pn-pick-E7"), "the employees to pick from");
    const send = () => must("pn-send-button") as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    await click(must("pn-pick-E7"));
    expect(text(must("pn-picked"))).toContain("To Asha Kumar");
    await setValue(must("pn-title"), "Test");
    await setValue(must("pn-message"), "Does this reach?");
    expect(send().disabled).toBe(false);
    await click(send());
    expect(changes()).toEqual([
      { method: "POST", path: `${API}/send`, body: { employeeId: 7, title: "Test", message: "Does this reach?" } },
    ]);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Message sent to the phone" }));
  });

  it("tells HR a muted employee will only get it in the app", async () => {
    await open(`${BASE}/send`, "pn-send");
    await waitFor(() => !!q("pn-pick-E8"), "the employees to pick from");
    await click(must("pn-pick-E8"));
    expect(text(must("pn-picked"))).toContain("They are muted, so it will only be in the app");
  });
});

describe("the configuration", () => {
  it("explains the road a push takes, the service, the health with the reasons and the phones", async () => {
    await open(`${BASE}/configuration`, "pn-config");
    const flow = text(must("pn-config-flow"));
    for (const needle of [
      "1. Saved in the HRMS",
      "2. Handed to the Expo push service",
      "Firebase",
      "4. On the phone",
    ]) {
      expect(flow, needle).toContain(needle);
    }
    expect(must("pn-health-state").getAttribute("data-state")).toBe("ok");
    expect(text(must("pn-failure-reasons"))).toContain("App uninstalled / notifications reset");
    expect(text(must("pn-failure-reasons"))).toContain("uninstalled or its notifications were reset");
    const service = text(must("pn-config-service"));
    expect(service).toContain("https://exp.host/--/api/v2/push/send");
    expect(service).toContain("net.uktex.employee");
    expect(text(must("pn-config-phones"))).toContain("33 phones");
  });
});

describe("a View-only tab", () => {
  it("shows the switches but changes nothing", async () => {
    as({ phone_notify_control: "edit", "phone_notify_control.controls": "view" });
    await open(`${BASE}/controls`, "pn-controls");
    expect((must("pn-toggle-late_alert") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-master-switch") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-group-on-attendance") as HTMLButtonElement).disabled).toBe(true);
    await click(must("pn-toggle-late_alert"));
    expect(changes()).toEqual([]);
    // the tabs stay usable: they only open a tab
    expect(tabs().every((t) => !(t as HTMLButtonElement).disabled)).toBe(true);
  });

  it("locks Push again, Mute, Remove and Send, and leaves looking around open", async () => {
    as({ phone_notify_control: "view" });
    await open(`${BASE}/messages`, "pn-row-2");
    expect((must("pn-again-2") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-details-2") as HTMLButtonElement).disabled).toBe(false);
    await click(tab("Employees"));
    await waitFor(() => !!q("pn-employee-7"), "the employees");
    expect((must("pn-mute-7") as HTMLButtonElement).disabled).toBe(true);
    await click(must("pn-phones-7"));
    expect((must("pn-remove-5") as HTMLButtonElement).disabled).toBe(true);
    await click(tab("Send a message"));
    await waitFor(() => !!q("pn-pick-E7"), "the employees to pick from");
    await click(must("pn-pick-E7"));
    await setValue(must("pn-title"), "Test");
    await setValue(must("pn-message"), "Hello");
    expect((must("pn-send-button") as HTMLButtonElement).disabled).toBe(true);
    expect(changes()).toEqual([]);
  });
});

// ── who receives phone notifications ──────────────────────────────────────────

/** The checkbox of one employee in the selected-list picker. */
const tick = (id: number) => must(`pn-recipient-check-${id}`) as HTMLButtonElement;
const isTicked = (id: number) => tick(id).getAttribute("aria-checked") === "true";
const listGets = () => world.gets.filter((u) => u.startsWith(`${API}/recipients/employees`));
const lastListGet = () => new URLSearchParams(listGets().at(-1)?.split("?")[1] ?? "");

describe("the settings: who receives phone notifications", () => {
  it("shows the four choices with their counts, the one in use marked, and who receives now", async () => {
    world.mode = "staff";
    await open(`${BASE}/settings`, "pn-settings");
    expect(tabs().map(label)).toContain("Settings");
    expect(tab("Settings")?.getAttribute("aria-selected")).toBe("true");
    const cards = [...must("pn-mode-options").querySelectorAll('[role="radio"]')].map((c) =>
      c.getAttribute("data-testid"),
    );
    expect(cards).toEqual(["pn-mode-all", "pn-mode-staff", "pn-mode-production", "pn-mode-selected"]);
    expect(text(must("pn-mode-reach-all"))).toBe("3 employees, 2 with a phone");
    expect(text(must("pn-mode-reach-production"))).toBe("2 employees, 1 with a phone");
    expect(text(must("pn-mode-reach-selected"))).toBe("1 employee, 1 with a phone");
    expect(text(must("pn-mode-all"))).toContain("About all");
    expect(must("pn-mode-staff").getAttribute("aria-checked")).toBe("true");
    expect(must("pn-mode-staff").getAttribute("data-current")).toBe("true");
    expect(text(must("pn-mode-staff"))).toContain("In use now");
    expect(must("pn-mode-all").getAttribute("aria-checked")).toBe("false");
    expect(text(must("pn-recipients-summary"))).toContain(
      "Phone notifications go to: Staff only — 1 employee, 1 with a phone",
    );
    expect(text(must("pn-recipients-updated"))).toContain("Last changed by Test HR");
    expect(text(must("pn-recipient-count"))).toBe("On the list: 1 employee, 1 with a phone");
    // the list is prepared here whatever the choice, and says it has no effect until Selected employees is chosen
    expect(text(must("pn-recipient-picker"))).toContain("It has no effect while the choice above is Staff only");
  });

  it("asks in the page before changing the choice, saying who stops, and Cancel changes nothing", async () => {
    await open(`${BASE}/settings`, "pn-settings");
    await click(must("pn-mode-staff"));
    const ask = must("pn-confirm-mode");
    expect(text(ask)).toContain("Change who receives phone notifications from All employees to Staff only?");
    expect(text(must("pn-confirm-mode-lines"))).toBe(
      "Production employees will stop getting phone notifications: 2 employees.",
    );
    expect(text(ask)).toContain("After the change, phone notifications go to 1 employee, 1 with a phone.");
    expect(text(must("pn-mode-staff"))).toContain("Chosen, not saved yet");
    expect(changes()).toEqual([]);
    await click(button("Cancel"));
    expect(q("pn-confirm-mode")).toBeNull();
    expect(must("pn-mode-all").getAttribute("aria-checked")).toBe("true");
    expect(changes()).toEqual([]);

    await click(must("pn-mode-staff"));
    await click(must("pn-confirm-mode-yes"));
    await waitFor(() => changes().length === 1, "the change");
    expect(changes()).toEqual([{ method: "PUT", path: `${API}/recipients`, body: { mode: "staff" } }]);
    await waitFor(() => must("pn-mode-staff").getAttribute("data-current") === "true", "Staff only in use");
    expect(q("pn-confirm-mode")).toBeNull();
    expect(text(must("pn-recipients-summary"))).toContain("Staff only — 1 employee");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Phone notifications now go to: Staff only" }),
    );
  });

  it("explains instead of asking when Selected employees is chosen with an empty list, and leads to the list", async () => {
    world.picked = new Set();
    await open(`${BASE}/settings`, "pn-settings");
    expect(text(must("pn-mode-selected"))).toContain("The list is empty: tick employees below first");
    await click(must("pn-mode-selected"));
    expect(q("pn-confirm-mode")).toBeNull();
    expect(text(must("pn-mode-blocked"))).toContain("The selected list is empty, so this cannot be saved yet");
    await click(must("pn-mode-blocked-go"));
    expect(q("pn-mode-blocked")).toBeNull();
    // the picker's search box is where it lands
    expect(document.activeElement).toBe(must("pn-recipient-search"));
    expect(changes()).toEqual([]);
  });

  it("saves Selected employees when the list has people, and shows the server's refusal", async () => {
    await open(`${BASE}/settings`, "pn-settings");
    world.failNext[`PUT ${API}/recipients`] = Object.assign(new Error("Bad Request"), {
      data: { error: "Select at least one employee first." },
    });
    await click(must("pn-mode-selected"));
    expect(text(must("pn-confirm-mode-lines"))).toContain(
      "Everyone who is not on the selected list will stop getting phone notifications: 2 employees.",
    );
    await click(must("pn-confirm-mode-yes"));
    await waitFor(() => h.toast.mock.calls.length > 0, "the refusal");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Select at least one employee first.", variant: "destructive" }),
    );
    // still asking: the choice is not lost
    expect(q("pn-confirm-mode")).not.toBeNull();
    await click(must("pn-confirm-mode-yes"));
    await waitFor(() => must("pn-mode-selected").getAttribute("data-current") === "true", "Selected in use");
    expect(changes().map((c) => c.body)).toEqual([{ mode: "selected" }, { mode: "selected" }]);
    expect(text(must("pn-recipient-picker"))).toContain("it is in use now");
  });
});

describe("the settings: the selected list", () => {
  it("lists the employees with their type, department, branch and a No phone hint, 50 a page", async () => {
    await open(`${BASE}/settings`, "pn-recipient-7");
    expect(lastListGet().get("pageSize")).toBe("50");
    expect(lastListGet().get("page")).toBe("1");
    const ravi = text(must("pn-recipient-8"));
    expect(ravi).toContain("Ravi Nair");
    expect(ravi).toContain("E8");
    expect(ravi).toContain("Production");
    expect(ravi).toContain("Cutting · Unit 2");
    expect(q("pn-recipient-nophone-8")).not.toBeNull();
    expect(q("pn-recipient-nophone-7")).toBeNull();
    expect(text(must("pn-recipient-7"))).toContain("Staff");
    expect(isTicked(7)).toBe(true);
    expect(isTicked(8)).toBe(false);
  });

  it("ticks and unticks an employee at once (no question), and the counts follow", async () => {
    await open(`${BASE}/settings`, "pn-recipient-8");
    await click(tick(8));
    expect(isTicked(8)).toBe(true);
    await waitFor(() => changes().length === 1, "the add");
    expect(changes()[0]).toEqual({ method: "POST", path: `${API}/recipients/employees`, body: { add: [8] } });
    await waitFor(() => text(must("pn-recipient-count")).startsWith("On the list: 2 employees"), "the count");
    await click(tick(7));
    await waitFor(() => changes().length === 2, "the remove");
    expect(changes()[1].body).toEqual({ remove: [7] });
    await waitFor(() => !isTicked(7), "Asha unticked");
    expect(q("pn-confirm-bulk")).toBeNull();
  });

  it("puts a tick back when the server refuses it", async () => {
    await open(`${BASE}/settings`, "pn-recipient-8");
    world.failNext[`POST ${API}/recipients/employees`] = new Error("offline");
    await click(tick(8));
    await waitFor(() => h.toast.mock.calls.length > 0, "the refusal");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Could not add Ravi Nair" }));
    await waitFor(() => !isTicked(8), "the tick put back");
  });

  it("filters by type, on the list or not, and a debounced search, all in the address", async () => {
    await open(`${BASE}/settings`, "pn-recipient-7");
    await click(must("pn-recipient-type-production"));
    await waitFor(() => !q("pn-recipient-7"), "the production employees");
    expect(lastListGet().get("type")).toBe("production");
    expect(window.location.search).toBe("?type=production");
    await click(must("pn-recipient-show-off"));
    await waitFor(() => lastListGet().get("selected") === "0", "the not-selected list");
    await click(must("pn-recipient-show-on"));
    await waitFor(() => lastListGet().get("selected") === "1", "the selected list");
    await click(must("pn-recipient-show-all"));
    await click(must("pn-recipient-type-all"));
    const before = listGets().length;
    await setValue(must("pn-recipient-search"), "R");
    await setValue(must("pn-recipient-search"), "Ra");
    await setValue(must("pn-recipient-search"), "Ravi");
    expect(listGets().length).toBe(before);
    await waitFor(() => lastListGet().get("search") === "Ravi", "the search sent once typing paused");
    expect(listGets().filter((u) => u.includes("search=")).length).toBe(1);
    await waitFor(() => !q("pn-recipient-7"), "only Ravi");
  });

  it("adds every employee the filter shows after asking with the count, carrying the filters", async () => {
    await open(`${BASE}/settings`, "pn-recipient-7");
    await click(must("pn-recipient-type-production"));
    await waitFor(() => text(must("pn-bulk-add")) === "Add all 2 shown", "the count of the filter");
    await setValue(must("pn-recipient-branch"), "2");
    await waitFor(() => lastListGet().get("branch") === "2", "the branch filter");
    // only the production departments of that branch are offered
    const offered = [...(must("pn-recipient-department") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(offered).toEqual(["Every department", "Cutting"]);
    await setValue(must("pn-recipient-department"), "6");
    await waitFor(() => lastListGet().get("department") === "6", "the department filter");
    await waitFor(() => text(must("pn-bulk-add")) === "Add all 1 shown", "the narrowed count");
    await click(must("pn-bulk-add"));
    expect(text(must("pn-confirm-bulk"))).toContain(
      "Add all 1 employee shown by this filter to the selected list? Those already on it stay as they are.",
    );
    expect(changes()).toEqual([]);
    await click(must("pn-confirm-bulk-yes"));
    await waitFor(() => changes().length === 1, "the change");
    expect(changes()[0].body).toEqual({ addMatching: { type: "production", branch: 2, department: 6 } });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "1 employee added to the selected list" }));
    await waitFor(() => q("pn-confirm-bulk") === null, "the question closed");
  });

  it("takes the filter's employees off, and clears the list, each after asking; Cancel changes nothing", async () => {
    world.picked = new Set([7, 8, 9]);
    world.mode = "selected";
    await open(`${BASE}/settings`, "pn-recipient-7");
    await click(must("pn-recipient-type-production"));
    await waitFor(() => text(must("pn-bulk-remove")) === "Remove all 2 shown", "the count");
    await click(must("pn-bulk-remove"));
    expect(text(must("pn-confirm-bulk"))).toContain(
      "Take all 2 employees shown by this filter off the selected list? Those not on it stay as they are. They stop getting phone notifications at once.",
    );
    await click(button("Cancel"));
    expect(q("pn-confirm-bulk")).toBeNull();
    expect(changes()).toEqual([]);
    await click(must("pn-bulk-remove"));
    await click(must("pn-confirm-bulk-yes"));
    await waitFor(() => changes().length === 1, "the removal");
    expect(changes()[0].body).toEqual({ removeMatching: { type: "production" } });

    await click(must("pn-bulk-clear"));
    expect(text(must("pn-confirm-bulk"))).toContain("Take all 1 employee off the selected list?");
    expect(text(must("pn-confirm-bulk"))).toContain("nobody will get phone notifications");
    await click(must("pn-confirm-bulk-yes"));
    await waitFor(() => changes().length === 2, "the clear");
    expect(changes()[1].body).toEqual({ clear: true });
    await waitFor(() => !!q("pn-recipients-nobody"), "nobody receives");
    expect((must("pn-bulk-clear") as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers no Add on the Selected only view and no Remove on the Not selected view", async () => {
    await open(`${BASE}/settings?list=on`, "pn-recipient-7");
    expect((must("pn-bulk-add") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-bulk-remove") as HTMLButtonElement).disabled).toBe(false);
    await click(must("pn-recipient-show-off"));
    await waitFor(() => !q("pn-recipient-7"), "the not-selected list");
    expect((must("pn-bulk-remove") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-bulk-add") as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides the branch filter for a login kept to one branch", async () => {
    h.user.current = {
      role: "hr",
      employeeId: null,
      permissions: { phone_notify_control: "edit" },
      branchId: 1,
    } as typeof h.user.current;
    await open(`${BASE}/settings`, "pn-recipient-7");
    expect(q("pn-recipient-branch")).toBeNull();
    expect(world.gets).not.toContain("/api/branches");
    expect(q("pn-recipient-department")).not.toBeNull();
  });
});

describe("the settings on a View-only tab", () => {
  it("shows everything but changes nothing, and keeps the filters open", async () => {
    as({ phone_notify_control: "edit", "phone_notify_control.settings": "view" });
    await open(`${BASE}/settings`, "pn-recipient-7");
    expect(text(must("pn-settings-locked"))).toBe("View only: you can look, but changes can't be saved.");
    for (const m of ["all", "staff", "production", "selected"]) {
      expect((must(`pn-mode-${m}`) as HTMLButtonElement).disabled, m).toBe(true);
    }
    expect(tick(7).disabled).toBe(true);
    expect(tick(8).disabled).toBe(true);
    expect((must("pn-bulk-add") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-bulk-remove") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-bulk-clear") as HTMLButtonElement).disabled).toBe(true);
    await click(must("pn-mode-staff"));
    await click(tick(8));
    expect(q("pn-confirm-mode")).toBeNull();
    expect(changes()).toEqual([]);
    // looking around stays open
    expect((must("pn-recipient-type-production") as HTMLButtonElement).disabled).toBe(false);
    await click(must("pn-recipient-type-production"));
    await waitFor(() => lastListGet().get("type") === "production", "the filtered list");
  });

  it("is not offered to a role with the tab hidden", async () => {
    as({ phone_notify_control: "edit", "phone_notify_control.settings": "hidden" });
    await open(`${BASE}/settings`, "pn-overview");
    expect(pathname()).toBe(`${BASE}/overview`);
    expect(tabs().map(label)).not.toContain("Settings");
    expect(asked()).not.toContain(`${API}/recipients`);
    // the Overview's line still says who receives, without a way into the hidden tab
    expect(q("pn-recipients-line")).not.toBeNull();
    expect(q("pn-recipients-settings")).toBeNull();
  });
});

describe("who receives, on the other tabs", () => {
  it("the Overview says who receives phone notifications, with a way to Settings", async () => {
    await open(`${BASE}/overview`, "pn-recipients-line");
    const line = text(must("pn-recipients-line"));
    expect(line).toContain("Phone notifications go to: Staff only — 142 employees, 37 with a phone");
    expect(text(must("pn-recipients-settings"))).toBe("Change who receives them");
    expect(must("pn-recipients-settings").getAttribute("href")).toBe(`${BASE}/settings`);
    await click(must("pn-recipients-settings"));
    await waitFor(() => !!q("pn-settings"), "the settings");
    expect(pathname()).toBe(`${BASE}/settings`);
  });

  it("the Overview of an older server says nothing about it", async () => {
    world.overview = overview({ recipients: undefined });
    await open(`${BASE}/overview`, "pn-overview");
    expect(q("pn-recipients-line")).toBeNull();
  });

  it("the Employees tab marks an employee who is not a recipient, only when the server says so", async () => {
    world.devices[1].isRecipient = false;
    world.devices[0].isRecipient = true;
    world.devices.push({ ...world.devices[0], id: 10, name: "Old Server Row", isRecipient: undefined });
    await open(`${BASE}/employees`, "pn-employee-8");
    expect(text(must("pn-not-recipient-8"))).toBe("Not a recipient");
    expect(q("pn-not-recipient-7")).toBeNull();
    expect(q("pn-not-recipient-10")).toBeNull();
  });
});

// ── the wording of each kind (Message Text) ───────────────────────────────────

const MT = `${BASE}/message-text`;
const field = (id: string) => must(id) as HTMLInputElement | HTMLTextAreaElement;
const templateCalls = () => changes().filter((c) => c.path.startsWith(`${API}/templates`));
const previews = () => templateCalls().filter((c) => c.path.endsWith("/preview"));
const saves = () => templateCalls().filter((c) => c.method === "PUT");
/** Puts the cursor in a field (React hears the focus) and where in it. */
async function focusAt(el: HTMLInputElement | HTMLTextAreaElement, at: number) {
  await act(async () => {
    el.focus();
    el.setSelectionRange(at, at);
  });
}

describe("message text: the list", () => {
  it("lists every kind by category, each with its switch, its wording and its counts", async () => {
    await open(MT, "pn-templates");
    expect(pathname()).toBe(MT);
    expect(tab("Message Text")?.getAttribute("aria-selected")).toBe("true");
    const groups = [...document.body.querySelectorAll('[data-testid^="pn-template-group-"]')].map((g) =>
      g.getAttribute("data-testid"),
    );
    // the categories' order, not the server's
    expect(groups).toEqual(["pn-template-group-attendance", "pn-template-group-payroll", "pn-template-group-chat"]);
    expect(text(must("pn-template-group-payroll"))).toContain("2 kinds, 1 with a custom wording");
    expect(text(must("pn-template-state-salary_slip"))).toBe("OnDefault");
    expect(text(must("pn-template-state-salary_paid"))).toContain("Custom");
    expect(text(must("pn-template-state-salary_paid"))).toContain("Edited by Test HR on");
    expect(text(must("pn-template-state-late_alert"))).toContain("Switched off on Controls");
    expect(text(must("pn-template-counts-salary_paid"))).toContain("264 sent · 2 pushed · 1 failed");
    expect(text(must("pn-template-counts-salary_slip"))).toContain("Last sent: never");
    expect(text(must("pn-templates-not-listed"))).toContain("Not listed, on purpose");
    expect(text(must("pn-template-edit-salary_slip"))).toBe("Edit");
  });

  it("narrows to the custom ones, and searches once typing pauses", async () => {
    await open(MT, "pn-templates");
    await click(must("pn-templates-filter-1"));
    expect(window.location.search).toBe("?custom=1");
    expect(q("pn-template-salary_slip")).toBeNull();
    expect(q("pn-template-salary_paid")).not.toBeNull();
    await click(must("pn-templates-filter-all"));
    await setValue(must("pn-templates-search"), "late");
    await waitFor(() => !q("pn-template-salary_slip"), "the search");
    expect(q("pn-template-late_alert")).not.toBeNull();
    await setValue(must("pn-templates-search"), "nothing like it");
    await waitFor(() => !!q("pn-templates-empty"), "nothing matches");
  });
});

describe("message text: the editor", () => {
  it("opens with the built-in wording, the placeholders and what is sent now", async () => {
    await open(MT, "pn-template-salary_slip");
    await click(must("pn-template-edit-salary_slip"));
    const editor = must("pn-template-editor");
    expect(text(editor)).toContain("Salary Slip");
    expect(text(must("pn-template-default-title"))).toBe("Salary Slip");
    expect(must("pn-template-default-body").textContent).toBe(
      "Dear {{employee_name}},\nYour salary slip for {{month_year}} is attached.",
    );
    expect(text(must("pn-template-default"))).toContain("The phone's built-in wording.");
    // no {{message}} among its placeholders: nothing to say about wrapping the built-in text
    expect(q("pn-template-wrap")).toBeNull();
    expect(field("pn-template-title").value).toBe("");
    expect(field("pn-template-title").placeholder).toBe("Blank: Salary Slip");
    expect(field("pn-template-body").value).toBe("");
    expect(text(must("pn-template-preview-title"))).toBe("Salary Slip");
    expect(must("pn-template-preview-body").textContent).toBe(
      "Dear Asha Kumar,\nYour salary slip for August 2026 is attached.",
    );
    expect([...must("pn-template-chips").querySelectorAll("button")].map(text)).toEqual([
      "{{employee_name}}",
      "{{month_year}}",
    ]);
    expect(text(must("pn-template-title-count"))).toBe("0 / 100");
    expect(text(must("pn-template-body-count"))).toBe("0 / 1,000");
    // nothing typed: nothing asked
    await settle(400);
    expect(previews()).toEqual([]);
    expect((must("pn-template-save") as HTMLButtonElement).disabled).toBe(true);
    expect(q("pn-template-reset")).toBeNull();
  });

  it("explains {{headline}} and {{message}} on a kind that has them", async () => {
    await open(MT, "pn-template-salary_paid");
    await click(must("pn-template-edit-salary_paid"));
    expect(text(must("pn-template-wrap"))).toContain(
      "{{headline}} is the built-in title and {{message}} the built-in sentence",
    );
    expect(field("pn-template-title").value).toBe("Paid: {{month}}");
  });

  it("puts a placeholder at the cursor of the field used last, and shows what it stands for", async () => {
    await open(MT, "pn-template-salary_slip");
    await click(must("pn-template-edit-salary_slip"));
    await setValue(field("pn-template-title"), "Payslip for ");
    await focusAt(field("pn-template-title"), 12);
    await click(must("pn-chip-month_year"));
    expect(field("pn-template-title").value).toBe("Payslip for {{month_year}}");
    expect(text(must("pn-template-chips"))).toContain("where the cursor is in the title");
    await setValue(field("pn-template-body"), "Hi , it is ready.");
    await focusAt(field("pn-template-body"), 3);
    await click(must("pn-chip-employee_name"));
    expect(field("pn-template-body").value).toBe("Hi {{employee_name}}, it is ready.");
    // the title kept its own wording
    expect(field("pn-template-title").value).toBe("Payslip for {{month_year}}");
    await act(async () => {
      must("pn-chip-employee_name").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(text(must("pn-chip-hint"))).toBe("{{employee_name}}: Employee name. Example: Asha Kumar");
    expect(must("pn-chip-month_year").getAttribute("title")).toBe("Month and year. Example: August 2026");
  });

  it("previews the wording once typing pauses, and shows the server's error", async () => {
    await open(MT, "pn-template-salary_slip");
    await click(must("pn-template-edit-salary_slip"));
    await setValue(field("pn-template-title"), "Payslip for {{month_year}}");
    await waitFor(() => previews().length === 1, "the preview");
    expect(previews()[0]).toEqual({
      method: "POST",
      path: `${API}/templates/salary_slip/preview`,
      body: { title: "Payslip for {{month_year}}", body: "" },
    });
    await waitFor(() => text(must("pn-template-preview-title")) === "Payslip for August 2026", "the new title");
    // blank message: the built-in one, filled in
    expect(must("pn-template-preview-body").textContent).toBe(
      "Dear Asha Kumar,\nYour salary slip for August 2026 is attached.",
    );
    await setValue(field("pn-template-body"), "Hello {{nope}}");
    await waitFor(() => !!q("pn-template-preview-error"), "the error");
    expect(text(must("pn-template-preview-error"))).toBe(
      "Unknown placeholder {{nope}}. Allowed: {{employee_name}}, {{month_year}}.",
    );
    expect(previews()).toHaveLength(2);
  });

  it("opens the phone card in full, and counts the title as it is typed", async () => {
    await open(MT, "pn-template-salary_slip");
    await click(must("pn-template-edit-salary_slip"));
    expect(must("pn-template-preview").getAttribute("data-expanded")).toBe("false");
    await click(must("pn-template-preview-expand"));
    expect(must("pn-template-preview").getAttribute("data-expanded")).toBe("true");
    await setValue(field("pn-template-title"), "x".repeat(61));
    expect(text(must("pn-template-title-count"))).toBe("61 / 100");
    expect(must("pn-template-title-count").className).toContain("amber");
    await setValue(field("pn-template-title"), "x".repeat(101));
    expect(must("pn-template-title-count").className).toContain("red");
    expect(text(must("pn-template-save-error"))).toBe("The title is 101 characters long; the most is 100.");
    expect((must("pn-template-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the title and message, trimmed, and closes", async () => {
    await open(MT, "pn-template-salary_slip");
    await click(must("pn-template-edit-salary_slip"));
    await setValue(field("pn-template-title"), "  Payslip ready ");
    await setValue(field("pn-template-body"), "Dear {{employee_name}}, it is in the app.\n");
    await click(must("pn-template-save"));
    await waitFor(() => saves().length === 1, "the save");
    expect(saves()[0]).toEqual({
      method: "PUT",
      path: `${API}/templates/salary_slip`,
      body: { title: "Payslip ready", body: "Dear {{employee_name}}, it is in the app." },
    });
    await waitFor(() => !q("pn-template-editor"), "the editor closed");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Salary slip: phone wording saved" }));
    await waitFor(() => text(must("pn-template-state-salary_slip")).includes("Custom"), "the row Custom");
  });

  it("shows the server's refusal in the editor and keeps it open", async () => {
    await open(MT, "pn-template-salary_slip");
    await click(must("pn-template-edit-salary_slip"));
    await setValue(field("pn-template-body"), "Hi {{nope}}");
    await click(must("pn-template-save"));
    await waitFor(() => !!q("pn-template-save-error"), "the refusal");
    expect(text(must("pn-template-save-error"))).toBe(
      "Unknown placeholder {{nope}}. Allowed: {{employee_name}}, {{month_year}}.",
    );
    expect(q("pn-template-editor")).not.toBeNull();
  });

  it("copies the built-in wording into the fields to start from", async () => {
    await open(MT, "pn-template-salary_slip");
    await click(must("pn-template-edit-salary_slip"));
    await click(must("pn-template-start-default"));
    expect(field("pn-template-title").value).toBe("Salary Slip");
    expect(field("pn-template-body").value).toBe(
      "Dear {{employee_name}},\nYour salary slip for {{month_year}} is attached.",
    );
    expect((must("pn-template-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks before going back to the built-in wording, then saves blanks", async () => {
    await open(MT, "pn-template-salary_paid");
    await click(must("pn-template-edit-salary_paid"));
    await click(must("pn-template-reset"));
    expect(text(must("pn-confirm-reset"))).toContain("Go back to the built-in wording of Salary paid?");
    expect(saves()).toEqual([]);
    await click(must("pn-confirm-reset-no"));
    expect(q("pn-confirm-reset")).toBeNull();
    await click(must("pn-template-reset"));
    await click(must("pn-confirm-reset-yes"));
    await waitFor(() => saves().length === 1, "the reset");
    expect(saves()[0].body).toEqual({ title: "", body: "" });
    await waitFor(() => !q("pn-template-editor"), "the editor closed");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Salary paid: back to the built-in wording" }),
    );
    await waitFor(() => text(must("pn-template-state-salary_paid")).includes("Default"), "the row Default");
  });

  it("asks before throwing unsaved changes away, and closes at once with none", async () => {
    await open(MT, "pn-template-salary_slip");
    await click(must("pn-template-edit-salary_slip"));
    await click(must("pn-template-cancel"));
    expect(q("pn-template-editor")).toBeNull();

    await click(must("pn-template-edit-salary_slip"));
    await setValue(field("pn-template-title"), "Payslip");
    await click(must("pn-template-cancel"));
    expect(text(must("pn-confirm-discard"))).toContain("Your changes to Salary slip are not saved.");
    await click(button("Keep editing"));
    expect(q("pn-confirm-discard")).toBeNull();
    expect(field("pn-template-title").value).toBe("Payslip");
    await click(must("pn-template-cancel"));
    await click(must("pn-confirm-discard-yes"));
    expect(q("pn-template-editor")).toBeNull();
    expect(saves()).toEqual([]);
  });
});

describe("message text on a View-only tab", () => {
  it("opens the editor to look, with nothing that can change", async () => {
    as({ phone_notify_control: "edit", "phone_notify_control.templates": "view" });
    await open(MT, "pn-template-salary_paid");
    expect(text(must("pn-template-edit-salary_paid"))).toBe("View");
    await click(must("pn-template-edit-salary_paid"));
    expect(text(must("pn-template-locked"))).toBe("View only: you can look, but changes can't be saved.");
    expect((field("pn-template-title") as HTMLInputElement).disabled).toBe(true);
    expect((field("pn-template-body") as HTMLTextAreaElement).disabled).toBe(true);
    expect((must("pn-chip-month") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-template-start-default") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-template-reset") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pn-template-save") as HTMLButtonElement).disabled).toBe(true);
    await click(must("pn-chip-month"));
    expect(field("pn-template-title").value).toBe("Paid: {{month}}");
    // the preview is there (a short one has nothing to open), and Close closes without asking
    expect(text(must("pn-template-preview-title"))).toBe("Paid: October 2026");
    expect(q("pn-template-preview-expand")).toBeNull();
    expect(text(must("pn-template-cancel"))).toBe("Close");
    await click(must("pn-template-cancel"));
    expect(q("pn-template-editor")).toBeNull();
    expect(templateCalls()).toEqual([]);
  });
});

describe("the Send tab's preview", () => {
  it("shows the message as the phone will, while it is typed", async () => {
    await open(`${BASE}/send`, "pn-send-preview");
    expect(text(must("pn-send-preview-title"))).toBe("Title");
    expect(text(must("pn-send-preview-body"))).toBe("The message");
    expect(must("pn-send-preview-title").className).toContain("text-slate-400");
    await setValue(must("pn-title"), "Canteen closed");
    expect(text(must("pn-send-preview-title"))).toBe("Canteen closed");
    expect(must("pn-send-preview-title").className).not.toContain("text-slate-400");
    expect(text(must("pn-send-preview-body"))).toBe("The message");
    await setValue(must("pn-message"), "The canteen is closed today.\nLunch is served in Hall B.");
    expect(must("pn-send-preview-body").textContent).toBe("The canteen is closed today.\nLunch is served in Hall B.");
    expect(q("pn-send-preview-expand")).not.toBeNull();
    // nothing is sent while typing
    expect(changes()).toEqual([]);
  });
});

// ── the timing of the phone attendance alerts (Settings) ──────────────────────

const timing = (k: string) => must(`pn-alert-${k}`) as HTMLInputElement;
const timingSave = () => must("pn-alert-timing-save") as HTMLButtonElement;
const alertPuts = () => changes().filter((c) => c.path === `${API}/alert-settings`);

describe("the settings: attendance alert timing (phone)", () => {
  it("shows the three timings with their names and ranges, and that they are for the phone alerts only", async () => {
    await open(`${BASE}/settings`, "pn-alert-timing");
    const panel = text(must("pn-alert-timing"));
    expect(panel).toContain("Attendance alert timing (phone)");
    expect(panel).toContain("These apply to the phone attendance alerts only.");
    expect(timing("absentExtraMinutes").value).toBe("0");
    expect(timing("reminderLeadMinutes").value).toBe("15");
    expect(timing("missingAfterMinutes").value).toBe("20");
    expect(text(must("pn-alert-field-reminderLeadMinutes"))).toContain(
      "Punch reminder: this long before the punch is due",
    );
    expect(text(must("pn-alert-absentExtraMinutes-hint"))).toBe("0 to 240 minutes");
    expect(text(must("pn-alert-reminderLeadMinutes-hint"))).toBe("1 to 60 minutes");
    expect(text(must("pn-alert-timing-updated"))).toContain("Last changed by Test HR");
    expect(timingSave().disabled).toBe(true);
    // between who receives and the selected list
    const order = [...document.body.querySelectorAll('[data-testid="pn-settings"] > *')].map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(order.indexOf("pn-alert-timing")).toBeGreaterThan(order.indexOf("pn-recipient-modes"));
  });

  it("checks the range as it is typed, and Save stays off until it is right", async () => {
    await open(`${BASE}/settings`, "pn-alert-timing");
    await setValue(timing("reminderLeadMinutes"), "0");
    expect(text(must("pn-alert-reminderLeadMinutes-hint"))).toBe("Between 1 and 60 minutes.");
    expect(timing("reminderLeadMinutes").getAttribute("aria-invalid")).toBe("true");
    expect(timingSave().disabled).toBe(true);
    await setValue(timing("reminderLeadMinutes"), "61");
    expect(text(must("pn-alert-reminderLeadMinutes-hint"))).toBe("Between 1 and 60 minutes.");
    await setValue(timing("reminderLeadMinutes"), "");
    expect(text(must("pn-alert-reminderLeadMinutes-hint"))).toBe("Enter a number of minutes.");
    expect(timingSave().disabled).toBe(true);
    await setValue(timing("missingAfterMinutes"), "241");
    expect(text(must("pn-alert-missingAfterMinutes-hint"))).toBe("Between 0 and 240 minutes.");
    await click(must("pn-alert-timing-undo"));
    expect(timing("reminderLeadMinutes").value).toBe("15");
    expect(timing("missingAfterMinutes").value).toBe("20");
    expect(text(must("pn-alert-reminderLeadMinutes-hint"))).toBe("1 to 60 minutes");
    expect(alertPuts()).toEqual([]);
  });

  it("saves only the timings that changed", async () => {
    await open(`${BASE}/settings`, "pn-alert-timing");
    await setValue(timing("absentExtraMinutes"), "10");
    await setValue(timing("missingAfterMinutes"), "20");
    expect(timingSave().disabled).toBe(false);
    await click(timingSave());
    await waitFor(() => alertPuts().length === 1, "the save");
    expect(alertPuts()[0]).toEqual({ method: "PUT", path: `${API}/alert-settings`, body: { absentExtraMinutes: 10 } });
    await waitFor(() => timingSave().disabled, "saved");
    expect(timing("absentExtraMinutes").value).toBe("10");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Attendance alert timing saved" }));
  });

  it("shows the server's refusal in the section, and clears it when the timing is changed", async () => {
    await open(`${BASE}/settings`, "pn-alert-timing");
    world.failNext[`PUT ${API}/alert-settings`] = Object.assign(new Error("Bad Request"), {
      data: { error: "The punch reminder must be between 1 and 60 minutes." },
    });
    await setValue(timing("reminderLeadMinutes"), "30");
    await click(timingSave());
    await waitFor(() => !!q("pn-alert-timing-server-error"), "the refusal");
    expect(text(must("pn-alert-timing-server-error"))).toBe("The punch reminder must be between 1 and 60 minutes.");
    expect(timing("reminderLeadMinutes").value).toBe("30");
    await setValue(timing("reminderLeadMinutes"), "25");
    expect(q("pn-alert-timing-server-error")).toBeNull();
  });

  it("shows the timing but changes nothing on a View-only tab", async () => {
    as({ phone_notify_control: "edit", "phone_notify_control.settings": "view" });
    await open(`${BASE}/settings`, "pn-alert-timing");
    expect(q("pn-settings-locked")).not.toBeNull();
    for (const k of ["absentExtraMinutes", "reminderLeadMinutes", "missingAfterMinutes"]) {
      expect(timing(k).disabled, k).toBe(true);
    }
    expect(timingSave().disabled).toBe(true);
    await click(timingSave());
    expect(alertPuts()).toEqual([]);
  });
});

// ── a module of its own ───────────────────────────────────────────────────────

describe("Phone Notify Control stands on its own", () => {
  /** Every word on screen, and every hover text, label and placeholder. */
  const everything = () =>
    [
      document.body.textContent ?? "",
      ...[...document.body.querySelectorAll("[title], [aria-label], [placeholder]")].flatMap((el) => [
        el.getAttribute("title") ?? "",
        el.getAttribute("aria-label") ?? "",
        el.getAttribute("placeholder") ?? "",
      ]),
    ].join(" ");

  const TABS: [string, string][] = [
    ["overview", "pn-categories"],
    ["messages", "pn-row-2"],
    ["employees", "pn-employee-7"],
    ["controls", "pn-group-attendance"],
    ["send", "pn-pick-E7"],
    ["configuration", "pn-config"],
    ["message-text", "pn-template-salary_slip"],
    ["settings", "pn-recipient-7"],
  ];

  it.each(TABS)("never mentions WhatsApp on the %s tab", async (path, ready) => {
    await open(`${BASE}/${path}`, ready);
    await settle(50);
    expect(everything()).not.toMatch(/whatsapp/i);
  });

  it("never mentions WhatsApp in the Message Text editor, nor in the switches' questions", async () => {
    await open(`${BASE}/message-text`, "pn-template-salary_slip");
    await click(must("pn-template-edit-salary_slip"));
    expect(everything()).not.toMatch(/whatsapp/i);
    await click(must("pn-template-cancel"));
    await click(must("pn-template-edit-salary_paid"));
    expect(everything()).not.toMatch(/whatsapp/i);
    await click(must("pn-template-cancel"));
    await click(tab("Controls"));
    await waitFor(() => !!q("pn-master-switch"), "the switches");
    await click(must("pn-master-switch"));
    expect(q("pn-confirm-master")).not.toBeNull();
    expect(everything()).not.toMatch(/whatsapp/i);
  });
});
