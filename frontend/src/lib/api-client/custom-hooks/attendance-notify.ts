// attendance-notify: hooks/types for the Attendance Notify page (/hr/attendance/attendance-notify), see ./index.ts.
//
// HR sets up automations that send attendance reports (Absent, CL, On Leave, Permission, Compensation; Staff /
// Production / everyone) on a schedule through WhatsApp, Gmail (email) or the Internal Chat. The server answers:
//
//   GET  /api/attendance/notify/overview                 channel states, counts, the connected number, the next 5 sends
//   GET  /api/attendance/notify/snapshot?date=&employeeType=   today's live numbers per category
//   GET  /api/attendance/notify/automations?channel=&status=&search=   {items}
//   POST /api/attendance/notify/automations              201 Automation; PUT|DELETE .../automations/<id>
//   POST /api/attendance/notify/automations/<id>/toggle {isActive}; .../run -> 202 {run} (409 {error} when one runs)
//   POST /api/attendance/notify/preview                  the draft (may be unsaved) -> what would be sent; nothing is sent
//   POST /api/attendance/notify/preview-pdf              the draft -> application/pdf
//   GET  /api/attendance/notify/runs?automation=&channel=&status=&page=   25 per page, deliveries included
//   GET  /api/attendance/notify/runs/<id>; POST .../runs/<id>/retry -> 202 {run} (only the failed deliveries again)
//   GET|POST /api/attendance/notify/recipient-lists?channel=; PUT|DELETE .../recipient-lists/<id>
//   GET  /api/attendance/notify/whatsapp-groups?refresh=1   {supported, groups, note, fetchedAt}
//   GET  /api/attendance/notify/chat-channels             {items}
//   GET|PUT /api/attendance/notify/settings               {connectedNumber}
//
// A refused change is 400 {"error": "<one sentence>", "field": "<key>"}. Every answer is read leniently (read* below): a
// key an older or newer server leaves out shows as empty instead of crashing the page.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

// ── vocabulary ───────────────────────────────────────────────────────────────

export type NotifyChannel = "whatsapp" | "email" | "chat";
export const NOTIFY_CHANNELS: readonly NotifyChannel[] = ["whatsapp", "email", "chat"];

export type NotifyCategory = "absent" | "cl" | "on_leave" | "on_duty" | "permission" | "compensation";
export const NOTIFY_CATEGORIES: readonly NotifyCategory[] = [
  "absent",
  "cl",
  "on_leave",
  "on_duty",
  "permission",
  "compensation",
];

export type NotifyEmployeeType = "all" | "staff" | "production";
export const NOTIFY_EMPLOYEE_TYPES: readonly NotifyEmployeeType[] = ["all", "staff", "production"];

export type NotifyReportType = "daily" | "custom";
export type NotifyReportDay = "today" | "yesterday";
export type NotifyFrequency = "daily" | "weekly" | "once";
export type NotifyContent = "summary" | "detailed" | "both";
export type NotifyEmailFormat = "text" | "html";

export type NotifyRunStatus = "running" | "done" | "partial" | "failed" | "skipped";
export const NOTIFY_RUN_STATUSES: readonly NotifyRunStatus[] = ["running", "done", "partial", "failed", "skipped"];
export type NotifyDeliveryStatus = "pending" | "sending" | "queued" | "sent" | "failed" | "skipped";
export type NotifyDeliveryKind = "number" | "group" | "connected" | "email" | "chat";
export type NotifyTrigger = "schedule" | "manual" | "retry";

// ── recipients ───────────────────────────────────────────────────────────────

export type WhatsAppNumber = { value: string; label: string };
export type WhatsAppGroupRef = { id: string; name: string };
export type WhatsAppRecipients = {
  /** Also send to the number the HRMS's WhatsApp is linked to (set once on the page). */
  connected: boolean;
  numbers: WhatsAppNumber[];
  groups: WhatsAppGroupRef[];
  listIds: number[];
};
export type EmailRecipients = { to: string[]; cc: string[]; bcc: string[]; listIds: number[] };
export type ChatRecipients = { channelIds: number[] };

/** Every channel's recipient keys at once (the reader fills the ones a channel does not use with empties); only the
 *  automation's own channel's keys are sent back (see recipientsBody). */
export type NotifyRecipientSet = WhatsAppRecipients & EmailRecipients & ChatRecipients;

export const EMPTY_NOTIFY_RECIPIENTS: NotifyRecipientSet = {
  connected: false,
  numbers: [],
  groups: [],
  listIds: [],
  to: [],
  cc: [],
  bcc: [],
  channelIds: [],
};

// ── the automation ───────────────────────────────────────────────────────────

export type NotifyLastRun = {
  id: number;
  at: string | null;
  status: NotifyRunStatus;
  employees: number;
  error: string;
};

/** What a POST / PUT accepts (and preview / preview-pdf take, saved or not). */
export type NotifyAutomationInput = {
  name: string;
  channel: NotifyChannel;
  isActive: boolean;
  reportType: NotifyReportType;
  reportDay: NotifyReportDay;
  dateFrom: string | null;
  dateTo: string | null;
  categories: NotifyCategory[];
  employeeType: NotifyEmployeeType;
  frequency: NotifyFrequency;
  /** 0 = Monday ... 6 = Sunday (weekly). */
  days: number[];
  /** "YYYY-MM-DD" (once). */
  runOn: string | null;
  /** "HH:MM", India time, 1 to 6. */
  times: string[];
  content: NotifyContent;
  includePhotos: boolean;
  emailFormat: NotifyEmailFormat;
  attachPdf: boolean;
  /** "" = the default subject. */
  subject: string;
  skipWhenEmpty: boolean;
  recipients: Partial<NotifyRecipientSet>;
};

export type NotifyAutomation = Omit<NotifyAutomationInput, "recipients"> & {
  id: number;
  recipients: NotifyRecipientSet;
  recipientSummary: string;
  /** The creator's branch scope (null = the whole company). */
  branch: { id: number; name: string } | null;
  nextRunAt: string | null;
  lastRun: NotifyLastRun | null;
  createdBy: string;
  createdAt: string | null;
  updatedBy: string;
  updatedAt: string | null;
};

// ── overview, snapshot ───────────────────────────────────────────────────────

export type NotifyChannelState = { available: boolean; note: string };

export type NotifyUpcoming = { automationId: number; name: string; channel: NotifyChannel; at: string };

export type NotifyOverview = {
  channels: Record<NotifyChannel, NotifyChannelState>;
  counts: {
    automations: number;
    active: number;
    byChannel: Record<NotifyChannel, number>;
    runsToday: number;
    failedToday: number;
  };
  settings: { connectedNumber: string };
  /** The next sends (at most 5), soonest first. */
  upcoming: NotifyUpcoming[];
};

export type NotifyCounts = Record<NotifyCategory, number>;

export type NotifySnapshot = {
  date: string;
  employeeType: NotifyEmployeeType;
  counts: NotifyCounts;
  /** Active employees in scope. */
  total: number;
  generatedAt: string | null;
};

export type NotifySnapshotParams = { date: string; employeeType: NotifyEmployeeType };

// ── preview ──────────────────────────────────────────────────────────────────

/** One line of a report: one employee on one day in one category. */
export type NotifyRow = {
  date: string;
  category: NotifyCategory | string;
  employeeId: number | null;
  code: string;
  name: string;
  department: string;
  designation: string;
  employmentType: string;
  /** "First half CL · Personal work". */
  detail: string;
  photoUrl: string | null;
};

export type NotifyMessage = { kind: "text" | "document"; text: string; filename: string | null };

/** A report posted to the Internal Chat (a chat message's `report`, chat.ts), and the chat preview's card. */
export type NotifyChatReport = {
  title: string;
  date: string;
  dateLabel: string;
  counts: NotifyCounts;
  /** The categories the report is about (all five when the server leaves it out). */
  categories: NotifyCategory[];
  /** Empty when `content` is "summary". */
  rows: NotifyRow[];
  content: NotifyContent;
  includePhotos: boolean;
  /** Employees in the report, and active employees in scope. */
  employees: number | null;
  total: number | null;
  /** When the numbers were taken. */
  asOf: string | null;
  /** More people than the rows shown. */
  truncated: boolean;
};

export type NotifyPreview = {
  dates: string[];
  counts: NotifyCounts;
  total: number;
  employees: number;
  messages: NotifyMessage[];
  /** The email's HTML body (null when the email is plain text or the channel is not email). */
  html: string | null;
  subject: string | null;
  /** At most 200. */
  rows: NotifyRow[];
  truncated: boolean;
  warnings: string[];
};

// ── runs ─────────────────────────────────────────────────────────────────────

export type NotifyDelivery = {
  id: number;
  kind: NotifyDeliveryKind;
  recipient: string;
  label: string;
  status: NotifyDeliveryStatus;
  note: string;
  attempts: number;
  updatedAt: string | null;
};

export type NotifyRun = {
  id: number;
  automationId: number | null;
  automationName: string;
  channel: NotifyChannel;
  trigger: NotifyTrigger;
  slot: string | null;
  runDate: string | null;
  reportFrom: string | null;
  reportTo: string | null;
  status: NotifyRunStatus;
  employees: number;
  counts: NotifyCounts;
  recipients: number;
  sent: number;
  failed: number;
  error: string;
  requestedBy: string;
  startedAt: string | null;
  finishedAt: string | null;
  deliveries: NotifyDelivery[];
};

export type NotifyRunPage = { total: number; page: number; pageSize: number; items: NotifyRun[] };

export type NotifyRunsParams = {
  automation?: number | null;
  channel?: NotifyChannel | null;
  status?: NotifyRunStatus | null;
  page?: number;
};

// ── lists, groups, chat channels, settings ───────────────────────────────────

export type NotifyRecipientList = {
  id: number;
  name: string;
  channel: "whatsapp" | "email";
  /** WhatsApp lists. */
  numbers: WhatsAppNumber[];
  /** Email lists. */
  emails: { to: string[]; cc: string[]; bcc: string[] };
  createdBy: string;
  updatedAt: string | null;
};

export type NotifyRecipientListInput = {
  id?: number;
  name: string;
  channel: "whatsapp" | "email";
  items: WhatsAppNumber[] | { to: string[]; cc: string[]; bcc: string[] };
};

export type NotifyWhatsAppGroup = { id: string; name: string; size: number | null };
export type NotifyWhatsAppGroups = {
  supported: boolean;
  groups: NotifyWhatsAppGroup[];
  note: string;
  fetchedAt: string | null;
};

export type NotifyChatChannel = {
  id: number;
  type: "company" | "department";
  name: string;
  branch: string;
  members: number | null;
  /** Who reads it and where it can be opened ("" from an older server). */
  note: string;
};

export type NotifySettings = { connectedNumber: string };

// ── reading the answers leniently ────────────────────────────────────────────

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose => (v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => list(v).filter((s): s is string => typeof s === "string" && s.trim() !== "");
const ids = (v: unknown): number[] => [
  ...new Set(list(v).filter((n): n is number => typeof n === "number" && Number.isInteger(n))),
];
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

const isChannel = (v: unknown): v is NotifyChannel => NOTIFY_CHANNELS.includes(v as NotifyChannel);

/** The five category counts, zero for one the server left out. */
export function readNotifyCounts(raw: unknown): NotifyCounts {
  const r = obj(raw);
  return Object.fromEntries(NOTIFY_CATEGORIES.map((c) => [c, num(r[c])])) as NotifyCounts;
}

function readNotifyNumbers(raw: unknown): WhatsAppNumber[] {
  return list(raw)
    .map((n) => (typeof n === "string" ? { value: n, label: "" } : obj(n)))
    .map((n) => ({ value: str(n.value).trim(), label: str(n.label).trim() }))
    .filter((n) => n.value !== "");
}

/** Recipients with every channel's keys present. */
export function readNotifyRecipients(raw: unknown): NotifyRecipientSet {
  const r = obj(raw);
  return {
    connected: r.connected === true,
    numbers: readNotifyNumbers(r.numbers),
    groups: list(r.groups)
      .map((g) => (typeof g === "string" ? { id: g, name: g } : obj(g)))
      .map((g) => ({ id: str(g.id), name: str(g.name) || str(g.id) }))
      .filter((g) => g.id !== ""),
    listIds: ids(r.listIds),
    to: strings(r.to),
    cc: strings(r.cc),
    bcc: strings(r.bcc),
    channelIds: ids(r.channelIds),
  };
}

function readNotifyLastRun(raw: unknown): NotifyLastRun | null {
  const r = obj(raw);
  if (typeof r.id !== "number") return null;
  return {
    id: r.id,
    at: strOrNull(r.at),
    status: oneOf(r.status, NOTIFY_RUN_STATUSES, "done"),
    employees: num(r.employees),
    error: str(r.error),
  };
}

/** One automation (null when it is not one). */
export function readNotifyAutomation(raw: unknown): NotifyAutomation | null {
  const r = obj(raw);
  if (typeof r.id !== "number" || !isChannel(r.channel)) return null;
  const branch = obj(r.branch);
  const days = list(r.days).filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6);
  return {
    id: r.id,
    name: str(r.name) || `Automation #${r.id}`,
    channel: r.channel,
    isActive: r.isActive !== false,
    reportType: oneOf(r.reportType, ["daily", "custom"] as const, "daily"),
    reportDay: oneOf(r.reportDay, ["today", "yesterday"] as const, "today"),
    dateFrom: strOrNull(r.dateFrom),
    dateTo: strOrNull(r.dateTo),
    categories: list(r.categories).filter((c): c is NotifyCategory => NOTIFY_CATEGORIES.includes(c as NotifyCategory)),
    employeeType: oneOf(r.employeeType, NOTIFY_EMPLOYEE_TYPES, "all"),
    frequency: oneOf(r.frequency, ["daily", "weekly", "once"] as const, "daily"),
    days: [...new Set(days)].sort((a, b) => a - b),
    runOn: strOrNull(r.runOn),
    times: strings(r.times).sort(),
    content: oneOf(r.content, ["summary", "detailed", "both"] as const, "both"),
    includePhotos: r.includePhotos === true,
    emailFormat: oneOf(r.emailFormat, ["text", "html"] as const, "html"),
    attachPdf: r.attachPdf === true,
    subject: str(r.subject),
    skipWhenEmpty: r.skipWhenEmpty === true,
    recipients: readNotifyRecipients(r.recipients),
    recipientSummary: str(r.recipientSummary),
    branch: typeof branch.id === "number" ? { id: branch.id, name: str(branch.name) } : null,
    nextRunAt: strOrNull(r.nextRunAt),
    lastRun: readNotifyLastRun(r.lastRun),
    createdBy: str(r.createdBy),
    createdAt: strOrNull(r.createdAt),
    updatedBy: str(r.updatedBy),
    updatedAt: strOrNull(r.updatedAt),
  };
}

export function readNotifyAutomations(raw: unknown): NotifyAutomation[] {
  const r = obj(raw);
  return list(Array.isArray(raw) ? raw : r.items)
    .map(readNotifyAutomation)
    .filter((a): a is NotifyAutomation => a !== null);
}

function readNotifyChannelState(raw: unknown): NotifyChannelState {
  const r = obj(raw);
  // unknown availability is shown as available: a run itself reports a channel that could not deliver
  return { available: r.available !== false, note: str(r.note) };
}

export function readNotifyOverview(raw: unknown): NotifyOverview {
  const r = obj(raw);
  const ch = obj(r.channels);
  const c = obj(r.counts);
  const by = obj(c.byChannel);
  return {
    channels: {
      whatsapp: readNotifyChannelState(ch.whatsapp),
      email: readNotifyChannelState(ch.email),
      chat: readNotifyChannelState(ch.chat),
    },
    counts: {
      automations: num(c.automations),
      active: num(c.active),
      byChannel: { whatsapp: num(by.whatsapp), email: num(by.email), chat: num(by.chat) },
      runsToday: num(c.runsToday),
      failedToday: num(c.failedToday),
    },
    settings: { connectedNumber: str(obj(r.settings).connectedNumber) },
    upcoming: list(r.upcoming)
      .map((u) => obj(u))
      .filter((u) => typeof u.automationId === "number" && isChannel(u.channel) && str(u.at) !== "")
      .map((u) => ({
        automationId: u.automationId as number,
        name: str(u.name),
        channel: u.channel as NotifyChannel,
        at: str(u.at),
      })),
  };
}

export function readNotifySnapshot(raw: unknown, asked?: NotifySnapshotParams): NotifySnapshot {
  const r = obj(raw);
  return {
    date: str(r.date) || asked?.date || "",
    employeeType: oneOf(r.employeeType, NOTIFY_EMPLOYEE_TYPES, asked?.employeeType ?? "all"),
    counts: readNotifyCounts(r.counts),
    total: num(r.total),
    generatedAt: strOrNull(r.generatedAt),
  };
}

export function readNotifyRow(raw: unknown): NotifyRow | null {
  const r = obj(raw);
  if (!str(r.name) && !str(r.code)) return null;
  return {
    date: str(r.date),
    category: str(r.category),
    employeeId: numOrNull(r.employeeId),
    code: str(r.code),
    name: str(r.name),
    department: str(r.department),
    designation: str(r.designation),
    employmentType: str(r.employmentType),
    detail: str(r.detail),
    photoUrl: strOrNull(r.photoUrl),
  };
}

export const readNotifyRows = (raw: unknown): NotifyRow[] =>
  list(raw)
    .map(readNotifyRow)
    .filter((x): x is NotifyRow => x !== null);

export function readNotifyPreview(raw: unknown): NotifyPreview {
  const r = obj(raw);
  return {
    dates: strings(r.dates),
    counts: readNotifyCounts(r.counts),
    total: num(r.total),
    employees: num(r.employees),
    messages: list(r.messages)
      .map((m) => obj(m))
      .map((m) => ({
        kind: m.kind === "document" ? ("document" as const) : ("text" as const),
        text: str(m.text),
        filename: strOrNull(m.filename),
      }))
      .filter((m) => m.text !== "" || m.filename !== null),
    html: strOrNull(r.html),
    subject: strOrNull(r.subject),
    rows: readNotifyRows(r.rows),
    truncated: r.truncated === true,
    warnings: strings(r.warnings),
  };
}

/** A chat message's report (null when there is none, or it is not one). */
export function readChatReport(raw: unknown): NotifyChatReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = obj(raw);
  const rows = readNotifyRows(r.rows);
  if (!str(r.title) && rows.length === 0 && !r.counts) return null;
  const categories = list(r.categories).filter((c): c is NotifyCategory =>
    NOTIFY_CATEGORIES.includes(c as NotifyCategory),
  );
  return {
    title: str(r.title) || "Attendance report",
    date: str(r.date),
    dateLabel: str(r.dateLabel) || str(r.date),
    counts: readNotifyCounts(r.counts),
    categories: categories.length ? NOTIFY_CATEGORIES.filter((c) => categories.includes(c)) : [...NOTIFY_CATEGORIES],
    rows,
    content: oneOf(r.content, ["summary", "detailed", "both"] as const, rows.length ? "both" : "summary"),
    includePhotos: r.includePhotos === true,
    employees: numOrNull(r.employees),
    total: numOrNull(r.total),
    asOf: strOrNull(r.asOf),
    truncated: r.truncated === true,
  };
}

function readNotifyDelivery(raw: unknown): NotifyDelivery | null {
  const r = obj(raw);
  if (typeof r.id !== "number") return null;
  return {
    id: r.id,
    kind: oneOf(r.kind, ["number", "group", "connected", "email", "chat"] as const, "number"),
    recipient: str(r.recipient),
    label: str(r.label),
    status: oneOf(r.status, ["pending", "sending", "queued", "sent", "failed", "skipped"] as const, "pending"),
    note: str(r.note),
    attempts: num(r.attempts),
    updatedAt: strOrNull(r.updatedAt),
  };
}

/** One run (null when it is not one). */
export function readNotifyRun(raw: unknown): NotifyRun | null {
  const r = obj(raw);
  if (typeof r.id !== "number") return null;
  const deliveries = list(r.deliveries)
    .map(readNotifyDelivery)
    .filter((d): d is NotifyDelivery => d !== null);
  return {
    id: r.id,
    automationId: numOrNull(r.automationId),
    automationName: str(r.automationName),
    channel: isChannel(r.channel) ? r.channel : "whatsapp",
    trigger: oneOf(r.trigger, ["schedule", "manual", "retry"] as const, "manual"),
    slot: strOrNull(r.slot),
    runDate: strOrNull(r.runDate),
    reportFrom: strOrNull(r.reportFrom),
    reportTo: strOrNull(r.reportTo),
    status: oneOf(r.status, NOTIFY_RUN_STATUSES, "done"),
    employees: num(r.employees),
    counts: readNotifyCounts(r.counts),
    recipients: typeof r.recipients === "number" ? r.recipients : deliveries.length,
    sent: typeof r.sent === "number" ? r.sent : deliveries.filter((d) => d.status === "sent").length,
    failed: typeof r.failed === "number" ? r.failed : deliveries.filter((d) => d.status === "failed").length,
    error: str(r.error),
    requestedBy: str(r.requestedBy),
    startedAt: strOrNull(r.startedAt),
    finishedAt: strOrNull(r.finishedAt),
    deliveries,
  };
}

export function readNotifyRunPage(raw: unknown): NotifyRunPage {
  const r = obj(raw);
  const items = list(r.items)
    .map(readNotifyRun)
    .filter((x): x is NotifyRun => x !== null);
  return {
    items,
    total: typeof r.total === "number" ? r.total : items.length,
    page: typeof r.page === "number" && r.page > 0 ? r.page : 1,
    pageSize: typeof r.pageSize === "number" && r.pageSize > 0 ? r.pageSize : 25,
  };
}

/** The run a 202 (run / retry) answered with: `{run}`, or the run itself. */
export function readNotifyStartedRun(raw: unknown): NotifyRun | null {
  const r = obj(raw);
  return readNotifyRun(r.run ?? raw);
}

export function readNotifyRecipientList(raw: unknown): NotifyRecipientList | null {
  const r = obj(raw);
  if (typeof r.id !== "number") return null;
  const channel = r.channel === "email" ? "email" : "whatsapp";
  const items = r.items;
  const emails = obj(items);
  return {
    id: r.id,
    name: str(r.name) || `List #${r.id}`,
    channel,
    numbers: channel === "whatsapp" ? readNotifyNumbers(items) : [],
    emails:
      channel === "email"
        ? { to: strings(emails.to), cc: strings(emails.cc), bcc: strings(emails.bcc) }
        : { to: [], cc: [], bcc: [] },
    createdBy: str(r.createdBy),
    updatedAt: strOrNull(r.updatedAt),
  };
}

export const readNotifyRecipientLists = (raw: unknown): NotifyRecipientList[] =>
  list(Array.isArray(raw) ? raw : obj(raw).items)
    .map(readNotifyRecipientList)
    .filter((x): x is NotifyRecipientList => x !== null);

export function readNotifyWhatsAppGroups(raw: unknown): NotifyWhatsAppGroups {
  const r = obj(raw);
  return {
    supported: r.supported === true,
    groups: list(r.groups)
      .map((g) => obj(g))
      .filter((g) => str(g.id) !== "")
      .map((g) => ({ id: str(g.id), name: str(g.name) || str(g.id), size: numOrNull(g.size) })),
    note: str(r.note),
    fetchedAt: strOrNull(r.fetchedAt),
  };
}

export const readNotifyChatChannels = (raw: unknown): NotifyChatChannel[] =>
  list(Array.isArray(raw) ? raw : obj(raw).items)
    .map((c) => obj(c))
    .filter((c) => typeof c.id === "number")
    .map((c) => ({
      id: c.id as number,
      type: c.type === "company" ? ("company" as const) : ("department" as const),
      name: str(c.name) || `Channel #${c.id}`,
      branch: str(c.branch),
      members: numOrNull(c.members),
      note: str(c.note),
    }));

// ── query strings ────────────────────────────────────────────────────────────

const BASE = "/api/attendance/notify";
export const NOTIFY_OVERVIEW_KEY = `${BASE}/overview`;
export const NOTIFY_SNAPSHOT_KEY = `${BASE}/snapshot`;
export const NOTIFY_AUTOMATIONS_KEY = `${BASE}/automations`;
export const NOTIFY_RUNS_KEY = `${BASE}/runs`;
export const NOTIFY_LISTS_KEY = `${BASE}/recipient-lists`;
export const NOTIFY_GROUPS_KEY = `${BASE}/whatsapp-groups`;
export const NOTIFY_CHAT_CHANNELS_KEY = `${BASE}/chat-channels`;
export const NOTIFY_SETTINGS_KEY = `${BASE}/settings`;

export type NotifyAutomationsParams = {
  channel?: NotifyChannel | null;
  status?: "active" | "inactive" | null;
  search?: string;
};

/** "channel=whatsapp&status=active&search=morning" (empty keys left out). */
export function notifyAutomationsQuery(p: NotifyAutomationsParams): string {
  const qs = new URLSearchParams();
  if (p.channel) qs.set("channel", p.channel);
  if (p.status) qs.set("status", p.status);
  if (p.search?.trim()) qs.set("search", p.search.trim());
  return qs.toString();
}

/** "automation=7&channel=email&status=failed&page=2" (empty keys and page 1 left out). */
export function notifyRunsQuery(p: NotifyRunsParams): string {
  const qs = new URLSearchParams();
  if (p.automation) qs.set("automation", String(p.automation));
  if (p.channel) qs.set("channel", p.channel);
  if (p.status) qs.set("status", p.status);
  if (p.page && p.page > 1) qs.set("page", String(p.page));
  return qs.toString();
}

const withQuery = (path: string, qs: string) => (qs ? `${path}?${qs}` : path);

// ── hooks: the dashboard ─────────────────────────────────────────────────────

export const useAttendanceNotifyOverview = () =>
  useQuery<NotifyOverview>({
    queryKey: [NOTIFY_OVERVIEW_KEY],
    queryFn: async () => readNotifyOverview(await customFetch<unknown>(NOTIFY_OVERVIEW_KEY)),
    // the next sends and today's runs move on by themselves
    refetchInterval: 60_000,
  });

export const useAttendanceNotifySnapshot = (params: NotifySnapshotParams) =>
  useQuery<NotifySnapshot>({
    queryKey: [NOTIFY_SNAPSHOT_KEY, params],
    queryFn: async () => {
      const qs = new URLSearchParams({ employeeType: params.employeeType });
      if (params.date) qs.set("date", params.date);
      return readNotifySnapshot(await customFetch<unknown>(`${NOTIFY_SNAPSHOT_KEY}?${qs.toString()}`), params);
    },
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

// ── hooks: automations ───────────────────────────────────────────────────────

/** The automations (filtered by the server). Refreshes every minute: the next / last run move on by themselves. */
export const useAttendanceNotifyAutomations = (
  params: NotifyAutomationsParams = {},
  options: { enabled?: boolean } = {},
) =>
  useQuery<NotifyAutomation[]>({
    queryKey: [NOTIFY_AUTOMATIONS_KEY, "list", params],
    queryFn: async () =>
      readNotifyAutomations(
        await customFetch<unknown>(withQuery(NOTIFY_AUTOMATIONS_KEY, notifyAutomationsQuery(params))),
      ),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });

/** After any change to an automation: the lists, the dashboard and the history read again. */
function useInvalidateNotify() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: [NOTIFY_AUTOMATIONS_KEY] });
    void queryClient.invalidateQueries({ queryKey: [NOTIFY_OVERVIEW_KEY] });
    void queryClient.invalidateQueries({ queryKey: [NOTIFY_RUNS_KEY] });
  };
}

/** Creates (no id) or saves (an id) an automation; answers with the automation as the server now has it. */
export const useSaveAttendanceNotifyAutomation = () => {
  const invalidate = useInvalidateNotify();
  return useMutation({
    mutationFn: async ({ id, body }: { id?: number | null; body: NotifyAutomationInput }) => {
      const answer = await customFetch<unknown>(id ? `${NOTIFY_AUTOMATIONS_KEY}/${id}` : NOTIFY_AUTOMATIONS_KEY, {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      const saved = readNotifyAutomation(answer);
      if (!saved) throw new Error("The server did not send the automation back.");
      return saved;
    },
    onSuccess: invalidate,
  });
};

/** Deletes an automation (its run history is kept, under the saved name). */
export const useDeleteAttendanceNotifyAutomation = () => {
  const invalidate = useInvalidateNotify();
  return useMutation({
    mutationFn: async (id: number) => {
      await customFetch<unknown>(`${NOTIFY_AUTOMATIONS_KEY}/${id}`, { method: "DELETE" });
      return id;
    },
    onSuccess: invalidate,
  });
};

export const useToggleAttendanceNotifyAutomation = () => {
  const invalidate = useInvalidateNotify();
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) =>
      readNotifyAutomation(
        await customFetch<unknown>(`${NOTIFY_AUTOMATIONS_KEY}/${id}/toggle`, {
          method: "POST",
          body: JSON.stringify({ isActive }),
        }),
      ),
    onSuccess: invalidate,
  });
};

/** Sends an automation now. The answer comes back at once (202) with the run, which is then sent in the background. */
export const useRunAttendanceNotifyAutomation = () => {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateNotify();
  return useMutation({
    mutationFn: async (id: number) => {
      const run = readNotifyStartedRun(
        await customFetch<unknown>(`${NOTIFY_AUTOMATIONS_KEY}/${id}/run`, { method: "POST" }),
      );
      if (!run) throw new Error("The server did not say which run it started.");
      return run;
    },
    onSuccess: (run) => {
      queryClient.setQueryData([NOTIFY_RUNS_KEY, "one", run.id], run);
      invalidate();
    },
  });
};

// ── hooks: preview ───────────────────────────────────────────────────────────

/** What the draft would send now (saved or not). A POST, but nothing is sent. */
export const useAttendanceNotifyPreview = () =>
  useMutation({
    mutationFn: async (body: NotifyAutomationInput) =>
      readNotifyPreview(await customFetch<unknown>(`${BASE}/preview`, { method: "POST", body: JSON.stringify(body) })),
  });

/** The draft's report as a PDF, saved by the browser as `filename`. */
export async function downloadAttendanceNotifyPreviewPdf(body: NotifyAutomationInput, filename: string): Promise<void> {
  const blob = await customFetch<Blob>(`${BASE}/preview-pdf`, {
    method: "POST",
    body: JSON.stringify(body),
    responseType: "blob",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

// ── hooks: runs ──────────────────────────────────────────────────────────────

/** The run history, newest first. Polls every 3 s while a run on the page is still going. */
export const useAttendanceNotifyRuns = (params: NotifyRunsParams, options: { enabled?: boolean } = {}) =>
  useQuery<NotifyRunPage>({
    queryKey: [NOTIFY_RUNS_KEY, "page", params],
    queryFn: async () =>
      readNotifyRunPage(await customFetch<unknown>(withQuery(NOTIFY_RUNS_KEY, notifyRunsQuery(params)))),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === "running") ? 3_000 : 30_000),
    enabled: options.enabled ?? true,
  });

/** One run with its deliveries; polled every 3 s while it is still running. `id` null asks for nothing. */
export const useAttendanceNotifyRun = (id: number | null) =>
  useQuery<NotifyRun | null>({
    queryKey: [NOTIFY_RUNS_KEY, "one", id],
    queryFn: async () => readNotifyRun(await customFetch<unknown>(`${NOTIFY_RUNS_KEY}/${id}`)),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3_000 : false),
  });

/** Sends the failed deliveries of a run again (a new run, answered at once with 202). */
export const useRetryAttendanceNotifyRun = () => {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateNotify();
  return useMutation({
    mutationFn: async (id: number) => {
      const run = readNotifyStartedRun(
        await customFetch<unknown>(`${NOTIFY_RUNS_KEY}/${id}/retry`, { method: "POST" }),
      );
      if (!run) throw new Error("The server did not say which run it started.");
      return run;
    },
    onSuccess: (run) => {
      queryClient.setQueryData([NOTIFY_RUNS_KEY, "one", run.id], run);
      invalidate();
    },
  });
};

// ── hooks: recipient lists, groups, chat channels, settings ──────────────────

export const useAttendanceNotifyRecipientLists = (channel: "whatsapp" | "email", options: { enabled?: boolean } = {}) =>
  useQuery<NotifyRecipientList[]>({
    queryKey: [NOTIFY_LISTS_KEY, channel],
    queryFn: async () => readNotifyRecipientLists(await customFetch<unknown>(`${NOTIFY_LISTS_KEY}?channel=${channel}`)),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });

/** Saves a list (a new one without an id) and answers with it. */
export const useSaveAttendanceNotifyRecipientList = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: NotifyRecipientListInput) => {
      const answer = await customFetch<unknown>(id ? `${NOTIFY_LISTS_KEY}/${id}` : NOTIFY_LISTS_KEY, {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(id ? { name: body.name, items: body.items } : body),
      });
      const saved = readNotifyRecipientList(answer);
      if (!saved) throw new Error("The server did not send the list back.");
      return saved;
    },
    onSuccess: (saved) => void queryClient.invalidateQueries({ queryKey: [NOTIFY_LISTS_KEY, saved.channel] }),
  });
};

export const useDeleteAttendanceNotifyRecipientList = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await customFetch<unknown>(`${NOTIFY_LISTS_KEY}/${id}`, { method: "DELETE" });
      return id;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [NOTIFY_LISTS_KEY] }),
  });
};

/**
 * The WhatsApp groups the linked account is in. Asking the provider is slow and may be refused, so nothing is read
 * until `enabled` (a button press); the answer is kept for 5 minutes. `refresh` asks the provider again (?refresh=1).
 */
export const useAttendanceNotifyWhatsAppGroups = (enabled: boolean) =>
  useQuery<NotifyWhatsAppGroups>({
    queryKey: [NOTIFY_GROUPS_KEY],
    queryFn: async () => readNotifyWhatsAppGroups(await customFetch<unknown>(NOTIFY_GROUPS_KEY)),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });

export const useRefreshAttendanceNotifyWhatsAppGroups = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => readNotifyWhatsAppGroups(await customFetch<unknown>(`${NOTIFY_GROUPS_KEY}?refresh=1`)),
    onSuccess: (groups) => queryClient.setQueryData([NOTIFY_GROUPS_KEY], groups),
  });
};

export const useAttendanceNotifyChatChannels = (options: { enabled?: boolean } = {}) =>
  useQuery<NotifyChatChannel[]>({
    queryKey: [NOTIFY_CHAT_CHANNELS_KEY],
    queryFn: async () => readNotifyChatChannels(await customFetch<unknown>(NOTIFY_CHAT_CHANNELS_KEY)),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
  });

/** Saves the connected WhatsApp number (shown on the dashboard, used by "Also send to the connected number"). */
export const useUpdateAttendanceNotifySettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: NotifySettings): Promise<NotifySettings> => {
      const answer = obj(
        await customFetch<unknown>(NOTIFY_SETTINGS_KEY, { method: "PUT", body: JSON.stringify(body) }),
      );
      return {
        connectedNumber: typeof answer.connectedNumber === "string" ? answer.connectedNumber : body.connectedNumber,
      };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [NOTIFY_OVERVIEW_KEY] });
      void queryClient.invalidateQueries({ queryKey: [NOTIFY_AUTOMATIONS_KEY] });
    },
  });
};
