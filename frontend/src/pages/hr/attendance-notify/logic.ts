// Attendance Notify (/hr/attendance/attendance-notify): the rules behind the page, kept apart from the screens so they
// can be tested alone: the tabs and what the address says, the labels and colours of the vocabulary, the form (a draft,
// what a save sends, the checks the server also makes, so a mistake shows before Save), times / dates / schedules in
// words and their next sends in India time, phone numbers and email addresses, and how a run reads.

import {
  EMPTY_NOTIFY_RECIPIENTS,
  NOTIFY_CATEGORIES,
  type NotifyAutomation,
  type NotifyAutomationInput,
  type NotifyCategory,
  type NotifyChannel,
  type NotifyChannelState,
  type NotifyContent,
  type NotifyDeliveryKind,
  type NotifyDeliveryStatus,
  type NotifyEmployeeType,
  type NotifyRecipientSet,
  type NotifyRun,
  type NotifyRunStatus,
} from "@/lib/api-client/custom-hooks";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { Tone } from "@/lib/statusTones";
import { WEEKDAYS, daysText, istLabel, sortTimes, timeLabel, toggleDay, validTime } from "../requests/notify/logic";

export { WEEKDAYS, daysText, istLabel, sortTimes, timeLabel, toggleDay, validTime };

// ─── tabs and the address ──────────────────────────────────────────────────────────────────────────────────────────

export type NotifyTab = "whatsapp" | "gmail" | "chat" | "automations" | "history";

export const NOTIFY_TABS: { value: NotifyTab; label: string }[] = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "gmail", label: "Gmail" },
  { value: "chat", label: "Internal Chat" },
  { value: "automations", label: "Automation Management" },
  { value: "history", label: "Execution History" },
];

export const PAGE_KEY = "attendance.attendance_notify";

/** Each tab's own permission key (Account Management -> Roles & Permissions); one without a setting follows the page. */
export const TAB_KEY: Record<NotifyTab, string> = {
  whatsapp: `${PAGE_KEY}.whatsapp`,
  gmail: `${PAGE_KEY}.gmail`,
  chat: `${PAGE_KEY}.chat`,
  automations: `${PAGE_KEY}.automations`,
  history: `${PAGE_KEY}.history`,
};

export const TAB_CHANNEL: Partial<Record<NotifyTab, NotifyChannel>> = {
  whatsapp: "whatsapp",
  gmail: "email",
  chat: "chat",
};
export const CHANNEL_TAB: Record<NotifyChannel, NotifyTab> = { whatsapp: "whatsapp", email: "gmail", chat: "chat" };

const params = (search: string) => new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

/** The tab an address names (`?tab=`); "email" is read as Gmail. Anything else is the first tab. */
export function tabFromSearch(search: string): NotifyTab {
  const raw = (params(search).get("tab") ?? "").toLowerCase();
  if (raw === "email") return "gmail";
  return NOTIFY_TABS.some((t) => t.value === raw) ? (raw as NotifyTab) : "whatsapp";
}

/** The history's own address keys: they only mean something on the Execution History tab. */
const HISTORY_KEYS = ["automation", "channel", "status", "page", "run"] as const;

/**
 * The query string (without "?") for `tab`: the history's filters go when leaving the history and `extra` is applied on
 * top (a null value removes its key).
 */
export function searchForTab(search: string, tab: NotifyTab, extra: Record<string, string | null> = {}): string {
  const next = params(search);
  next.set("tab", tab);
  if (tab !== "history") for (const k of HISTORY_KEYS) next.delete(k);
  for (const [k, v] of Object.entries(extra)) {
    if (v === null || v === "") next.delete(k);
    else next.set(k, v);
  }
  return next.toString();
}

export type HistoryFilters = {
  automation: number | null;
  channel: NotifyChannel | null;
  status: NotifyRunStatus | null;
  page: number;
  /** A run to open (a jump from "View errors"). */
  run: number | null;
};

const positiveInt = (v: string | null) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function historyFiltersFromSearch(search: string): HistoryFilters {
  const p = params(search);
  const channel = p.get("channel");
  const status = p.get("status");
  return {
    automation: positiveInt(p.get("automation")),
    channel: channel === "whatsapp" || channel === "email" || channel === "chat" ? channel : null,
    status: (["running", "done", "partial", "failed", "skipped"] as const).includes(status as NotifyRunStatus)
      ? (status as NotifyRunStatus)
      : null,
    page: positiveInt(p.get("page")) ?? 1,
    run: positiveInt(p.get("run")),
  };
}

/** The history's filters as address keys (a filter change goes back to page 1 unless the page is given). */
export function historySearch(search: string, f: Partial<HistoryFilters>): string {
  return searchForTab(search, "history", {
    automation: f.automation ? String(f.automation) : null,
    channel: f.channel ?? null,
    status: f.status ?? null,
    page: f.page && f.page > 1 ? String(f.page) : null,
    run: f.run ? String(f.run) : null,
  });
}

// ─── labels and colours ────────────────────────────────────────────────────────────────────────────────────────────

export const CHANNEL_LABEL: Record<NotifyChannel, string> = {
  whatsapp: "WhatsApp",
  email: "Gmail",
  chat: "Internal Chat",
};

export const CATEGORY_META: Record<NotifyCategory, { label: string; short: string; tone: Tone; tile: string }> = {
  absent: { label: "Absent", short: "Absent", tone: "danger", tile: "bg-rose-50 text-rose-800" },
  cl: { label: "CL (Casual Leave)", short: "CL", tone: "accent", tile: "bg-violet-50 text-violet-800" },
  on_leave: { label: "On Leave", short: "On Leave", tone: "info", tile: "bg-sky-50 text-sky-800" },
  on_duty: { label: "On Duty", short: "On Duty", tone: "neutral", tile: "bg-cyan-50 text-cyan-800" },
  permission: { label: "Permission", short: "Permission", tone: "warning", tile: "bg-amber-50 text-amber-800" },
  compensation: { label: "Compensation", short: "Compensation", tone: "success", tile: "bg-teal-50 text-teal-800" },
};

/** A category's label; an unknown key reads as itself ("late" -> "late"). */
export const categoryLabel = (c: string, short = false): string => {
  const meta = CATEGORY_META[c as NotifyCategory];
  return meta ? (short ? meta.short : meta.label) : c;
};

export const EMPLOYEE_TYPE_LABEL: Record<NotifyEmployeeType, string> = {
  all: "All employees",
  staff: "Staff",
  production: "Production",
};

export const EMPLOYEE_TYPE_TONE: Record<NotifyEmployeeType, string> = {
  all: "border-slate-200 bg-slate-50 text-slate-700",
  staff: "border-emerald-200 bg-emerald-50 text-emerald-800",
  production: "border-amber-200 bg-amber-50 text-amber-800",
};

export const CONTENT_LABEL: Record<NotifyContent, string> = {
  summary: "Summary counts",
  detailed: "Detailed employee list",
  both: "Summary and detailed list",
};

export const RUN_STATUS: Record<NotifyRunStatus, { label: string; tone: Tone }> = {
  running: { label: "Sending…", tone: "info" },
  done: { label: "Sent", tone: "success" },
  partial: { label: "Partly sent", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Skipped", tone: "neutral" },
};

export const DELIVERY_STATUS: Record<NotifyDeliveryStatus, { label: string; tone: Tone }> = {
  pending: { label: "Waiting", tone: "neutral" },
  sending: { label: "Sending", tone: "info" },
  queued: { label: "In the queue", tone: "info" },
  sent: { label: "Sent", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Skipped", tone: "neutral" },
};

export const DELIVERY_KIND_LABEL: Record<NotifyDeliveryKind, string> = {
  number: "Number",
  group: "WhatsApp group",
  connected: "Connected number",
  email: "Email",
  chat: "Chat channel",
};

/** "Scheduled · 9:30 AM", "Run now by Meena", "Retry by Meena". */
export function runTitle(run: Pick<NotifyRun, "trigger" | "slot" | "requestedBy">): string {
  if (run.trigger === "schedule") return run.slot ? `Scheduled · ${timeLabel(run.slot)}` : "Scheduled";
  const by = run.requestedBy && run.requestedBy !== "Scheduler" ? ` by ${run.requestedBy}` : "";
  return run.trigger === "retry" ? `Retry${by}` : `Run now${by}`;
}

/** "2 of 3 sent · 1 failed" ("No recipients" when there were none). */
export function deliveryText(run: Pick<NotifyRun, "recipients" | "sent" | "failed" | "status">): string {
  if (run.recipients === 0) return run.status === "skipped" ? "Nothing to send" : "No recipients";
  const parts = [`${run.sent} of ${run.recipients} sent`];
  if (run.failed) parts.push(`${run.failed} failed`);
  return parts.join(" · ");
}

/** One sentence for the toast when a run is over. */
export function runOutcome(run: NotifyRun): string {
  const name = run.automationName ? `“${run.automationName}”` : "The automation";
  if (run.status === "failed") return run.error || `${name} could not be sent: see Execution History.`;
  if (run.status === "skipped") return run.error || `${name} had nothing to report, so nothing was sent.`;
  const people = `${run.employees} employee${run.employees === 1 ? "" : "s"} in the report`;
  return `${name}: ${deliveryText(run)}. ${people}.`;
}

/** Can the failed deliveries of this run be sent again? */
export const canRetry = (run: Pick<NotifyRun, "status" | "failed">) => run.status !== "running" && run.failed > 0;

// ─── times ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MAX_TIMES = 6;

/**
 * A typed time as "HH:MM", or null: "9:30", "09:30", "9.30", "0930", "930", "9:30 pm", "9 pm", "12 am" (midnight) and
 * "21:05" are all read; "25:00", "9:75" and words are not.
 */
export function parseTime(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const m = s.match(/^(\d{1,2})(?:[:.](\d{2})|(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? m[3] ?? "0");
  const period = m[4]?.replace(/\./g, "");
  if (min > 59) return null;
  if (period) {
    if (h < 1 || h > 12) return null;
    if (period === "am") h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** The times with `raw` added (kept sorted), or why it cannot be. */
export function addTime(times: string[], raw: string): { times: string[]; error: string | null } {
  if (!raw.trim()) return { times, error: "Type or pick a time first." };
  const t = parseTime(raw);
  if (!t) return { times, error: `“${raw.trim()}” is not a time of day. Use HH:MM, for example 09:30 or 13:00.` };
  if (times.includes(t)) return { times, error: `${timeLabel(t)} is already on the list.` };
  if (times.length >= MAX_TIMES) return { times, error: `At most ${MAX_TIMES} sending times.` };
  return { times: sortTimes([...times, t]), error: null };
}

export const removeTime = (times: string[], t: string) => times.filter((x) => x !== t);

/** "9:30 AM", "9:30 AM and 1:00 PM", "9:30 AM, 1:00 PM and 6:00 PM". */
export function timesText(times: string[]): string {
  const labels = sortTimes(times).map(timeLabel);
  if (labels.length === 0) return "no time";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

// ─── dates (India time) ────────────────────────────────────────────────────────────────────────────────────────────

const IST_OFFSET_MIN = 330;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_RANGE_DAYS = 31;

const toUtcDay = (iso: string): number | null => {
  if (!ISO_DATE.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? t : null;
};

export const validDate = (iso: string | null | undefined): iso is string => !!iso && toUtcDay(iso) !== null;

/** Today's date in India ("2026-11-17"), whatever the computer's own time zone. */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const t = toUtcDay(iso);
  return t === null ? iso : new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/** How many days from `from` to `to`, both counted (17 to 17 is 1); null when either is not a date or to < from. */
export function dateSpanDays(from: string | null, to: string | null): number | null {
  const a = from ? toUtcDay(from) : null;
  const b = to ? toUtcDay(to) : null;
  if (a === null || b === null || b < a) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "17 Nov 2026" ("—" for nothing, the text itself when it is not a date). */
export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  if (!validDate(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")} ${MONTHS[m - 1]} ${y}`;
}

/** "17 Nov 2026", "01 – 15 Nov 2026", "28 Oct – 03 Nov 2026", "28 Dec 2026 – 03 Jan 2027". */
export function rangeLabel(from: string | null | undefined, to: string | null | undefined): string {
  if (!from && !to) return "—";
  if (!from || !to || from === to) return dateLabel(from || to);
  if (!validDate(from) || !validDate(to)) return `${from} – ${to}`;
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const dd = String(fd).padStart(2, "0");
  if (fy !== ty) return `${dateLabel(from)} – ${dateLabel(to)}`;
  if (fm !== tm) return `${dd} ${MONTHS[fm - 1]} – ${dateLabel(to)}`;
  return `${dd} – ${dateLabel(to)}`;
}

// ─── schedules ─────────────────────────────────────────────────────────────────────────────────────────────────────

type ScheduleBits = Pick<NotifyAutomationInput, "frequency" | "days" | "runOn" | "times">;
type ReportBits = Pick<NotifyAutomationInput, "reportType" | "reportDay" | "dateFrom" | "dateTo">;

/** "Every day", "Mon–Sat", "Once · 18 Nov 2026". */
export function frequencyText(s: Pick<ScheduleBits, "frequency" | "days" | "runOn">): string {
  if (s.frequency === "daily") return "Every day";
  if (s.frequency === "once") return `Once · ${dateLabel(s.runOn)}`;
  return daysText(s.days);
}

/** "Every day at 9:30 AM and 1:00 PM", "Mon–Sat at 9:30 AM", "Once on 18 Nov 2026 at 9:30 AM". */
export function scheduleText(s: ScheduleBits): string {
  if (s.times.length === 0) return "No sending time yet";
  const at = timesText(s.times);
  if (s.frequency === "once") return `Once on ${dateLabel(s.runOn)} at ${at}`;
  if (s.frequency === "daily") return `Every day at ${at}`;
  return `${daysText(s.days)} at ${at}`;
}

/** "Daily · today's attendance", "Daily · yesterday's attendance", "Custom · 01 – 15 Nov 2026". */
export function reportText(r: ReportBits): string {
  if (r.reportType === "custom") return `Custom · ${rangeLabel(r.dateFrom, r.dateTo)}`;
  return r.reportDay === "yesterday" ? "Daily · yesterday's attendance" : "Daily · today's attendance";
}

/**
 * The next `count` moments a schedule would send (India time, UTC+5:30), from `now`. The server decides the real next
 * run (`nextRunAt`); this shows what an unsaved draft would do.
 */
export function nextRuns(now: Date, s: ScheduleBits, count = 3): Date[] {
  const valid = sortTimes(s.times.filter(validTime));
  if (valid.length === 0) return [];
  const today = istToday(now);
  const out: Date[] = [];
  const push = (iso: string) => {
    const day = toUtcDay(iso);
    if (day === null) return;
    for (const t of valid) {
      const [h, m] = t.split(":").map(Number);
      const at = new Date(day + (h * 60 + m - IST_OFFSET_MIN) * 60_000);
      if (at.getTime() > now.getTime() && out.length < count) out.push(at);
    }
  };
  if (s.frequency === "once") {
    if (validDate(s.runOn)) push(s.runOn);
    return out;
  }
  if (s.frequency === "weekly" && s.days.length === 0) return [];
  for (let add = 0; add < 8 && out.length < count; add++) {
    const iso = addDays(today, add);
    const weekday = (new Date(toUtcDay(iso)!).getUTCDay() + 6) % 7; // 0 = Monday
    if (s.frequency === "weekly" && !s.days.includes(weekday)) continue;
    push(iso);
  }
  return out;
}

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const istClock = (d: Date) => {
  const parts = Object.fromEntries(IST_TIME.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.hour}:${parts.minute} ${String(parts.dayPeriod ?? "").toUpperCase()}`.trim();
};

/** "Today, 1:00 PM", "Tomorrow, 9:30 AM", "Yesterday, 6:00 PM", else "Wed, 19 Nov, 9:30 AM" (India time). */
export function whenText(at: string | Date | null | undefined, now: Date = new Date()): string {
  if (!at) return "—";
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return "—";
  const day = istToday(d);
  const today = istToday(now);
  if (day === today) return `Today, ${istClock(d)}`;
  if (day === addDays(today, 1)) return `Tomorrow, ${istClock(d)}`;
  if (day === addDays(today, -1)) return `Yesterday, ${istClock(d)}`;
  return istLabel(d);
}

/** "in 5 min", "in 2 h 5 min", "in 3 days", "now", "5 min ago", "2 h ago", "3 days ago". */
export function relativeText(at: string | Date | null | undefined, now: Date = new Date()): string {
  if (!at) return "";
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return "";
  const diff = Math.round((d.getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(diff);
  if (abs < 1) return "now";
  let text: string;
  if (abs < 60) text = `${abs} min`;
  else if (abs < 24 * 60) {
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    text = m && h < 6 ? `${h} h ${m} min` : `${h} h`;
  } else {
    const days = Math.round(abs / (24 * 60));
    text = `${days} day${days === 1 ? "" : "s"}`;
  }
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

/** The next send in words: "Today, 1:00 PM (in 2 h)"; "Off" when switched off; "Not scheduled" when there is none. */
export function nextRunText(a: Pick<NotifyAutomation, "isActive" | "nextRunAt">, now: Date = new Date()): string {
  if (!a.isActive) return "Off";
  if (!a.nextRunAt) return "Not scheduled";
  const rel = relativeText(a.nextRunAt, now);
  return rel ? `${whenText(a.nextRunAt, now)} (${rel})` : whenText(a.nextRunAt, now);
}

// ─── phone numbers and email addresses ─────────────────────────────────────────────────────────────────────────────

/**
 * A typed WhatsApp number as "+<country><number>", or null. A 10-digit Indian mobile (6-9...) gets +91, "0" in front of
 * one is dropped, "91" + 10 digits gets its "+", and an international number written with "+" (8 to 15 digits) is kept.
 * Spaces, dashes, dots and brackets are ignored.
 */
export function normalisePhone(raw: string): string | null {
  const s = raw.trim().replace(/[\s\-().]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) {
    const digits = s.slice(1);
    if (!/^\d{8,15}$/.test(digits)) return null;
    if (digits.startsWith("91") && !/^91[6-9]\d{9}$/.test(digits)) return null;
    return `+${digits}`;
  }
  if (!/^\d+$/.test(s)) return null;
  const digits = s.startsWith("00") ? s.slice(2) : s;
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  if (s.startsWith("00") && /^\d{8,15}$/.test(digits)) return `+${digits}`;
  return null;
}

/** "+91 98765 43210" for an Indian mobile; anything else as it is. */
export function phoneLabel(value: string): string {
  const m = value.match(/^\+91(\d{5})(\d{5})$/);
  return m ? `+91 ${m[1]} ${m[2]}` : value;
}

const EMAIL = /^[^\s@,;<>()[\]"]+@[^\s@,;<>()[\]"]+\.[a-z]{2,}$/i;

export const validEmail = (s: string) => EMAIL.test(s.trim());

/**
 * Typed or pasted addresses (separated by commas, semicolons, spaces or new lines; "Name <a@b.in>" is read too) split
 * into the good ones (lower case, each once) and the ones that are not addresses.
 */
export function splitEmails(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const parts = text
    .split(/[,;\n]+/)
    .flatMap((p) => {
      const angle = p.match(/<([^>]+)>/);
      return angle ? [angle[1]] : p.split(/\s+/);
    })
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (validEmail(p)) {
      const lower = p.toLowerCase();
      if (!valid.includes(lower)) valid.push(lower);
    } else if (!invalid.includes(p)) invalid.push(p);
  }
  return { valid, invalid };
}

/** `list` with the addresses in `text` added (each once, across To / CC / BCC when `others` are given). */
export function addEmails(
  list: string[],
  text: string,
  others: string[] = [],
): { list: string[]; invalid: string[]; duplicates: string[] } {
  const { valid, invalid } = splitEmails(text);
  const taken = new Set([...list, ...others].map((e) => e.toLowerCase()));
  const duplicates = valid.filter((e) => taken.has(e));
  return { list: [...list, ...valid.filter((e) => !taken.has(e))], invalid, duplicates };
}

// ─── the form ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The form's state: every field of an automation, and every channel's recipient keys (only the channel's are sent). */
export type NotifyDraft = Omit<NotifyAutomationInput, "recipients"> & { recipients: NotifyRecipientSet };

export type FormStep = "report" | "schedule" | "recipients" | "preview";

export const FORM_STEPS: { value: FormStep; label: string; hint: string }[] = [
  { value: "report", label: "Report", hint: "What the report holds" },
  { value: "schedule", label: "Schedule", hint: "When it is sent" },
  { value: "recipients", label: "Recipients", hint: "Who gets it" },
  { value: "preview", label: "Preview", hint: "Check it, then save" },
];

export function emptyDraft(channel: NotifyChannel): NotifyDraft {
  return {
    name: "",
    channel,
    isActive: true,
    reportType: "daily",
    reportDay: "today",
    dateFrom: null,
    dateTo: null,
    categories: [...NOTIFY_CATEGORIES],
    employeeType: "all",
    frequency: "weekly",
    days: [0, 1, 2, 3, 4, 5],
    runOn: null,
    times: ["09:30"],
    content: "both",
    includePhotos: false,
    emailFormat: "html",
    attachPdf: false,
    subject: "",
    skipWhenEmpty: false,
    recipients: {
      ...EMPTY_NOTIFY_RECIPIENTS,
      numbers: [],
      groups: [],
      listIds: [],
      to: [],
      cc: [],
      bcc: [],
      channelIds: [],
    },
  };
}

/** The form for an automation that exists (a copy: editing it never touches the cached automation). */
export function draftFrom(a: NotifyAutomation): NotifyDraft {
  const r = a.recipients;
  return {
    name: a.name,
    channel: a.channel,
    isActive: a.isActive,
    reportType: a.reportType,
    reportDay: a.reportDay,
    dateFrom: a.dateFrom,
    dateTo: a.dateTo,
    categories: [...a.categories],
    employeeType: a.employeeType,
    frequency: a.frequency,
    days: [...a.days],
    runOn: a.runOn,
    times: sortTimes(a.times),
    content: a.content,
    includePhotos: a.includePhotos,
    emailFormat: a.emailFormat,
    attachPdf: a.attachPdf,
    subject: a.subject,
    skipWhenEmpty: a.skipWhenEmpty,
    recipients: {
      connected: r.connected,
      numbers: r.numbers.map((n) => ({ ...n })),
      groups: r.groups.map((g) => ({ ...g })),
      listIds: [...r.listIds],
      to: [...r.to],
      cc: [...r.cc],
      bcc: [...r.bcc],
      channelIds: [...r.channelIds],
    },
  };
}

/** The recipient keys of `channel` only (what the server stores for it). */
export function recipientsBody(channel: NotifyChannel, r: NotifyRecipientSet): Partial<NotifyRecipientSet> {
  if (channel === "whatsapp")
    return { connected: r.connected, numbers: r.numbers, groups: r.groups, listIds: r.listIds };
  if (channel === "email") return { to: r.to, cc: r.cc, bcc: r.bcc, listIds: r.listIds };
  return { channelIds: r.channelIds };
}

/** What a save (or a preview) sends: the draft, tidied (a field that does not apply to the choices made is cleared). */
export function draftBody(d: NotifyDraft): NotifyAutomationInput {
  const custom = d.reportType === "custom";
  return {
    name: d.name.trim(),
    channel: d.channel,
    isActive: d.isActive,
    reportType: d.reportType,
    reportDay: d.reportDay,
    dateFrom: custom ? d.dateFrom : null,
    // a single day is a range of one
    dateTo: custom ? d.dateTo || d.dateFrom : null,
    categories: NOTIFY_CATEGORIES.filter((c) => d.categories.includes(c)),
    employeeType: d.employeeType,
    frequency: d.frequency,
    days: d.frequency === "weekly" ? [...new Set(d.days)].sort((a, b) => a - b) : [],
    runOn: d.frequency === "once" ? d.runOn : null,
    times: sortTimes([...new Set(d.times)]),
    content: d.content,
    includePhotos: d.content === "summary" ? false : d.includePhotos,
    emailFormat: d.emailFormat,
    attachPdf: d.channel === "email" ? d.attachPdf : false,
    subject: d.channel === "email" ? d.subject.trim() : "",
    skipWhenEmpty: d.skipWhenEmpty,
    recipients: recipientsBody(d.channel, d.recipients),
  };
}

export type Problem = { field: string; step: FormStep; message: string };

export const NAME_MAX = 120;
export const SUBJECT_MAX = 200;

/** Everything that stops a save, in plain sentences, each with the step it is on (empty: it can be saved). */
export function draftProblems(d: NotifyDraft, today: string): Problem[] {
  const out: Problem[] = [];
  const add = (field: string, step: FormStep, message: string) => out.push({ field, step, message });

  if (!d.name.trim()) add("name", "report", "Give the automation a name.");
  else if (d.name.trim().length > NAME_MAX) add("name", "report", `The name can be at most ${NAME_MAX} characters.`);
  if (d.categories.length === 0) add("categories", "report", "Pick at least one category.");
  if (d.reportType === "custom") {
    const to = d.dateTo || d.dateFrom;
    if (!validDate(d.dateFrom)) add("dateFrom", "report", "Pick the date the report is about (or the first day).");
    else if (to && !validDate(to)) add("dateTo", "report", "The last day is not a date.");
    else {
      const span = dateSpanDays(d.dateFrom, to);
      if (span === null) add("dateTo", "report", "The last day must be on or after the first day.");
      else if (span > MAX_RANGE_DAYS)
        add("dateTo", "report", `A custom report covers at most ${MAX_RANGE_DAYS} days (this one is ${span}).`);
    }
  }

  if (d.times.length === 0) add("times", "schedule", "Add at least one sending time.");
  if (d.times.some((t) => !validTime(t))) add("times", "schedule", "A sending time is not a valid time of day.");
  if (new Set(d.times).size !== d.times.length) add("times", "schedule", "A sending time is on the list twice.");
  if (d.times.length > MAX_TIMES) add("times", "schedule", `At most ${MAX_TIMES} sending times.`);
  if (d.frequency === "weekly" && d.days.length === 0) add("days", "schedule", "Pick at least one weekday.");
  if (d.frequency === "once") {
    if (!validDate(d.runOn)) add("runOn", "schedule", "Pick the date to send it on.");
    else if (d.runOn < today) add("runOn", "schedule", "The date to send it on has passed: pick today or a later day.");
  }

  for (const p of recipientProblems(d.channel, d.recipients)) add("recipients", "recipients", p);
  if (d.channel === "email" && d.subject.trim().length > SUBJECT_MAX)
    add("subject", "recipients", `The subject can be at most ${SUBJECT_MAX} characters.`);
  return out;
}

/** Why the recipients of `channel` cannot be saved (empty: they can). */
export function recipientProblems(channel: NotifyChannel, r: NotifyRecipientSet): string[] {
  const out: string[] = [];
  if (channel === "whatsapp") {
    if (!r.connected && r.numbers.length === 0 && r.groups.length === 0 && r.listIds.length === 0)
      out.push("Add at least one number, group or saved list, or send to the connected number.");
    const bad = r.numbers.filter((n) => !normalisePhone(n.value));
    if (bad.length) out.push(`Not a WhatsApp number: ${bad.map((n) => n.value).join(", ")}.`);
  } else if (channel === "email") {
    if (r.to.length === 0 && r.listIds.length === 0) out.push("Add at least one address in To (or pick a saved list).");
    const bad = [...r.to, ...r.cc, ...r.bcc].filter((e) => !validEmail(e));
    if (bad.length) out.push(`Not an email address: ${bad.join(", ")}.`);
  } else if (r.channelIds.length === 0) out.push("Pick at least one chat channel.");
  return out;
}

/** Advice that never blocks a save. */
export function draftWarnings(
  d: NotifyDraft,
  ctx: { channelState?: NotifyChannelState; connectedNumber?: string; now?: Date },
): string[] {
  const out: string[] = [];
  if (ctx.channelState && !ctx.channelState.available)
    out.push(
      `${CHANNEL_LABEL[d.channel]} cannot deliver right now${ctx.channelState.note ? `: ${ctx.channelState.note}` : "."} The automation is saved, but sends fail until it is set up.`,
    );
  if (d.channel === "whatsapp" && d.recipients.connected && !ctx.connectedNumber?.trim())
    out.push("“Also send to the connected number” is on, but no connected number is set yet (WhatsApp tab).");
  if (d.reportType === "custom" && d.frequency !== "once")
    out.push("A custom report is about the same fixed dates every time it is sent.");
  if (d.reportDay === "today" && d.reportType === "daily" && d.times.some((t) => validTime(t) && t < "09:00"))
    out.push(
      "A report about today sent before 9:00 AM may show many people as absent who simply have not punched in yet.",
    );
  if (d.isActive && ctx.now && nextRuns(ctx.now, d, 1).length === 0 && d.frequency === "once" && validDate(d.runOn))
    out.push("Every sending time on that date has passed: it will not be sent. Pick a later time or date.");
  if (!d.isActive) out.push("The automation is switched off: it is saved but sends nothing until it is switched on.");
  return out;
}

/** The first step with a problem (to jump to on Save), else null. */
export function firstProblemStep(problems: Problem[]): FormStep | null {
  for (const s of FORM_STEPS) if (problems.some((p) => p.step === s.value)) return s.value;
  return null;
}

/** "2 numbers, 1 group, the connected number" — the recipients of a draft in words (the server's for a saved one). */
export function recipientSummary(channel: NotifyChannel, r: NotifyRecipientSet): string {
  const n = (count: number, one: string, many = `${one}s`) => (count ? `${count} ${count === 1 ? one : many}` : "");
  const lists = n(r.listIds.length, "saved list");
  let parts: string[];
  if (channel === "whatsapp")
    parts = [
      r.connected ? "the connected number" : "",
      n(r.numbers.length, "number"),
      n(r.groups.length, "group"),
      lists,
    ];
  else if (channel === "email")
    parts = [
      n(r.to.length, "address", "addresses"),
      r.cc.length ? `${r.cc.length} in CC` : "",
      r.bcc.length ? `${r.bcc.length} in BCC` : "",
      lists,
    ];
  else parts = [n(r.channelIds.length, "chat channel")];
  const text = parts.filter(Boolean).join(", ");
  return text || "Nobody yet";
}

// ─── errors ────────────────────────────────────────────────────────────────────────────────────────────────────────

const body = (err: unknown) =>
  err instanceof ApiError ? ((err.data ?? {}) as { error?: unknown; field?: unknown; message?: unknown }) : {};

/** The server's sentence for a refused call, else the error's own message. */
export function errorText(err: unknown): string | undefined {
  const b = body(err);
  if (typeof b.error === "string" && b.error.trim() && !/^[a-z_]+$/.test(b.error)) return b.error;
  if (typeof b.message === "string" && b.message.trim()) return b.message;
  if (err instanceof ApiError && err.status === 403)
    return "Your login may look at Attendance Notify but not change it.";
  if (err instanceof ApiError && err.status === 409)
    return "This automation is being sent right now. Try again when it is done.";
  return err instanceof Error && err.message ? err.message : undefined;
}

/** The field a 400 names ("times"), else null. */
export function errorField(err: unknown): string | null {
  const f = body(err).field;
  return typeof f === "string" && f ? f : null;
}

/** The step a server-named field is on. */
export function stepOfField(field: string | null): FormStep | null {
  if (!field) return null;
  if (
    [
      "name",
      "categories",
      "reportType",
      "reportDay",
      "dateFrom",
      "dateTo",
      "employeeType",
      "content",
      "includePhotos",
    ].includes(field)
  )
    return "report";
  if (["frequency", "days", "runOn", "times", "isActive"].includes(field)) return "schedule";
  if (field.startsWith("recipients") || ["subject", "emailFormat", "attachPdf"].includes(field)) return "recipients";
  return null;
}

// ─── lists on screen ───────────────────────────────────────────────────────────────────────────────────────────────

/** Automations, active first, then by the soonest next send, then by name. */
export function sortAutomations(items: NotifyAutomation[]): NotifyAutomation[] {
  return [...items].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const an = a.nextRunAt ? Date.parse(a.nextRunAt) : Infinity;
    const bn = b.nextRunAt ? Date.parse(b.nextRunAt) : Infinity;
    if (an !== bn) return an - bn;
    return a.name.localeCompare(b.name);
  });
}

/** "absent-cl" style key of a category list, for a stable test id; and the categories in their fixed order. */
export const orderedCategories = (cats: string[]): NotifyCategory[] =>
  NOTIFY_CATEGORIES.filter((c) => cats.includes(c));

/** The total of a counts record over the chosen categories (all five when none are given). */
export function countTotal(counts: Record<string, number>, cats: readonly string[] = NOTIFY_CATEGORIES): number {
  return cats.reduce((sum, c) => sum + (counts[c] ?? 0), 0);
}

/**
 * A WhatsApp message split the way WhatsApp draws it: *bold* and _italic_ (one line at a time, the markers dropped). The
 * preview shows the text exactly as the phone will.
 */
export function whatsappSegments(text: string): { text: string; bold: boolean; italic: boolean }[] {
  const out: { text: string; bold: boolean; italic: boolean }[] = [];
  const re = /(\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    // a marker counts only at a word edge ("2*3*4" and "snake_case_name" stay as typed)
    const before = at === 0 ? " " : text[at - 1];
    const after = text[at + m[0].length] ?? " ";
    if (/\w/.test(before) || /\w/.test(after)) continue;
    if (at > last) out.push({ text: text.slice(last, at), bold: false, italic: false });
    out.push({ text: m[0].slice(1, -1), bold: m[0][0] === "*", italic: m[0][0] === "_" });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false, italic: false });
  return out;
}

/** A file name for the preview PDF: "attendance-report-morning-absentees-2026-11-17.pdf". */
export function pdfFilename(name: string, today: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `attendance-report-${slug ? `${slug}-` : ""}${today}.pdf`;
}
