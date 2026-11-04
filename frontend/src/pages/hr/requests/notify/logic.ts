// Notify (Requests page, ?tab=notify): the rules behind the automatic HoD reminder, kept apart from the screens so they can
// be tested alone: the form and what a save sends, the time / weekday / template checks (the same rules the server applies,
// so a mistake shows before Save), the schedule in words and its next runs in India time, who a "Send now" reaches on which
// channel, and how a run reads.

import type {
  HodChannel,
  HodChannelCount,
  HodChannelStatus,
  HodChannelSwitches,
  HodDeliveryStatus,
  HodReminderSettings,
  HodReminderSettingsInput,
  HodRow,
  HodRun,
} from "@/lib/api-client/custom-hooks";
import { readHodRun } from "@/lib/api-client/custom-hooks/hod-reminders";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { Tone } from "@/lib/statusTones";

export const MAX_TIMES = 6;
export const TEMPLATE_MIN = 10;
export const TEMPLATE_MAX = 2000;
export const DEFAULT_DAYS = [0, 1, 2, 3, 4, 5];

/** 0 = Monday, as the server counts. */
export const WEEKDAYS: { value: number; short: string; long: string }[] = [
  { value: 0, short: "Mon", long: "Monday" },
  { value: 1, short: "Tue", long: "Tuesday" },
  { value: 2, short: "Wed", long: "Wednesday" },
  { value: 3, short: "Thu", long: "Thursday" },
  { value: 4, short: "Fri", long: "Friday" },
  { value: 5, short: "Sat", long: "Saturday" },
  { value: 6, short: "Sun", long: "Sunday" },
];

export const CHANNEL_LABEL: Record<HodChannel, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  push: "Mobile push",
};

export const EMAIL_SUBJECT = "Pending approvals awaiting you – UK Textiles HRMS";
export const PUSH_TITLE = "Pending approvals";

export const PLACEHOLDERS: { token: string; label: string; hint: string }[] = [
  { token: "{{name}}", label: "HoD name", hint: "The HoD's full name" },
  { token: "{{pendingList}}", label: "Pending list", hint: "One line per kind of request with something pending" },
  { token: "{{total}}", label: "Total", hint: "How many requests are waiting in all" },
  { token: "{{date}}", label: "Date", hint: 'Today, as "04 Nov 2026"' },
];

// ─── the form ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type NotifyForm = {
  enabled: boolean;
  times: string[];
  days: number[];
  channels: HodChannelSwitches;
  template: string;
};

export function formFrom(s: HodReminderSettings | undefined): NotifyForm {
  return {
    enabled: s?.enabled ?? false,
    times: sortTimes(s?.times ?? []),
    days: [...(s?.days ?? DEFAULT_DAYS)].sort((a, b) => a - b),
    channels: { ...(s?.channels ?? { whatsapp: true, email: true, push: true }) },
    template: s?.template ?? "",
  };
}

const sameList = <T>(a: T[], b: T[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** What differs between the saved settings and the form: the body of the PUT (only what changed). */
export function changedFields(saved: NotifyForm, form: NotifyForm): HodReminderSettingsInput {
  const out: HodReminderSettingsInput = {};
  if (saved.enabled !== form.enabled) out.enabled = form.enabled;
  if (!sameList(sortTimes(saved.times), sortTimes(form.times))) out.times = sortTimes(form.times);
  if (!sameList([...saved.days].sort(), [...form.days].sort())) out.days = [...form.days].sort((a, b) => a - b);
  if ((["whatsapp", "email", "push"] as HodChannel[]).some((c) => saved.channels[c] !== form.channels[c]))
    out.channels = { ...form.channels };
  if (saved.template !== form.template) out.template = form.template;
  return out;
}

export const sameForm = (a: NotifyForm, b: NotifyForm) => Object.keys(changedFields(a, b)).length === 0;

// ─── times ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "HH:MM", 00:00 to 23:59. */
export const validTime = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

export const sortTimes = (times: string[]) => [...times].sort();

/** The times with `t` added (kept sorted), or why it cannot be. */
export function addTime(times: string[], t: string): { times: string[]; error: string | null } {
  if (!validTime(t)) return { times, error: "Pick a time first." };
  if (times.includes(t)) return { times, error: `${timeLabel(t)} is already on the list.` };
  if (times.length >= MAX_TIMES) return { times, error: `At most ${MAX_TIMES} times a day.` };
  return { times: sortTimes([...times, t]), error: null };
}

export const removeTime = (times: string[], t: string) => times.filter((x) => x !== t);

/** "10:00" -> "10:00 AM", "16:30" -> "4:30 PM". */
export function timeLabel(t: string): string {
  if (!validTime(t)) return t;
  const [h, m] = t.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// ─── days ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function toggleDay(days: number[], day: number): number[] {
  const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
  return [...new Set(next)].sort((a, b) => a - b);
}

/** "Every day", "Mon–Sat", "Mon, Wed, Fri", "No day". A run of three or more days reads as a range. */
export function daysText(days: number[]): string {
  const sorted = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (sorted.length === 0) return "No day";
  if (sorted.length === 7) return "Every day";
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  const flush = () => {
    if (prev - start >= 2) parts.push(`${WEEKDAYS[start].short}–${WEEKDAYS[prev].short}`);
    else for (let d = start; d <= prev; d++) parts.push(WEEKDAYS[d].short);
  };
  for (const d of sorted.slice(1)) {
    if (d === prev + 1) prev = d;
    else {
      flush();
      start = prev = d;
    }
  }
  flush();
  return parts.join(", ");
}

/** "Mon–Sat at 10:00 AM and 4:00 PM". */
export function scheduleText(form: Pick<NotifyForm, "times" | "days">): string {
  const times = sortTimes(form.times).map(timeLabel);
  if (times.length === 0) return "No time picked";
  const list = times.length === 1 ? times[0] : `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
  return `${daysText(form.days)} at ${list}`;
}

// ─── India time ────────────────────────────────────────────────────────────────────────────────────────────────────

const IST_OFFSET_MIN = 330;

/**
 * The next `count` moments the schedule on screen would run (India time, UTC+5:30), from `now`. The server decides the real
 * next run (`nextRunAt`); this shows what an unsaved change would do.
 */
export function nextRuns(now: Date, times: string[], days: number[], count = 3): Date[] {
  const valid = sortTimes(times.filter(validTime));
  if (valid.length === 0 || days.length === 0) return [];
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const out: Date[] = [];
  for (let add = 0; add < 8 && out.length < count; add++) {
    const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add));
    const weekday = (day.getUTCDay() + 6) % 7; // 0 = Monday
    if (!days.includes(weekday)) continue;
    for (const t of valid) {
      const [h, m] = t.split(":").map(Number);
      const at = new Date(day.getTime() + (h * 60 + m - IST_OFFSET_MIN) * 60_000);
      if (at.getTime() > now.getTime() && out.length < count) out.push(at);
    }
  }
  return out;
}

const IST_FORMAT = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "Wed, 04 Nov, 4:00 PM" in India time; "—" for nothing. */
export function istLabel(at: Date | string | null | undefined): string {
  if (!at) return "—";
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return "—";
  const parts = Object.fromEntries(IST_FORMAT.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.weekday}, ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${String(parts.dayPeriod ?? "").toUpperCase()}`.trim();
}

// ─── checks ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why the template cannot be saved, or null. The same rules as the server. */
export function templateProblem(t: string): string | null {
  const length = t.trim().length;
  if (length < TEMPLATE_MIN) return `The message needs at least ${TEMPLATE_MIN} characters.`;
  if (t.length > TEMPLATE_MAX) return `The message can be at most ${TEMPLATE_MAX} characters (it has ${t.length}).`;
  if (!t.includes("{{pendingList}}"))
    return "The message must contain {{pendingList}}: it is the list of what is pending.";
  return null;
}

/** Placeholders the template uses that the server does not know ("{{nme}}"): they would be sent as typed. */
export function unknownPlaceholders(t: string): string[] {
  const known = new Set(PLACEHOLDERS.map((p) => p.token));
  return [...new Set(t.match(/\{\{\s*[^{}]*\s*\}\}/g) ?? [])].filter((p) => !known.has(p));
}

/** Everything that stops a save, in plain sentences (empty: it can be saved). */
export function formProblems(form: NotifyForm): string[] {
  const out: string[] = [];
  if (form.times.some((t) => !validTime(t))) out.push("A time is not a valid time of day.");
  if (new Set(form.times).size !== form.times.length) out.push("A time is on the list twice.");
  if (form.times.length > MAX_TIMES) out.push(`At most ${MAX_TIMES} times a day.`);
  if (form.enabled && form.times.length === 0) out.push("Add at least one time, or switch the reminders off.");
  if (form.enabled && form.days.length === 0) out.push("Pick at least one day, or switch the reminders off.");
  const t = templateProblem(form.template);
  if (t) out.push(t);
  return out;
}

/** Advice that never blocks a save. */
export function formWarnings(form: NotifyForm, status: Record<HodChannel, HodChannelStatus> | undefined): string[] {
  const out: string[] = [];
  const on = (["whatsapp", "email", "push"] as HodChannel[]).filter((c) => form.channels[c]);
  if (form.enabled && on.length === 0) out.push("Every channel is off: the schedule runs but nobody is reminded.");
  if (status) {
    const dead = on.filter((c) => !status[c].available);
    if (form.enabled && on.length > 0 && dead.length === on.length)
      out.push("None of the channels that are on can deliver right now (see the notes under Channels).");
  }
  const unknown = unknownPlaceholders(form.template);
  if (unknown.length) out.push(`Not a placeholder: ${unknown.join(", ")}. It is sent exactly as typed.`);
  return out;
}

/** The template with `token` put at the caret (replacing a selection), and where the caret goes after it. */
export function insertAt(text: string, token: string, start: number, end: number): { text: string; caret: number } {
  const a = Math.max(0, Math.min(start, text.length));
  const b = Math.max(a, Math.min(end, text.length));
  return { text: text.slice(0, a) + token + text.slice(b), caret: a + token.length };
}

// ─── errors ────────────────────────────────────────────────────────────────────────────────────────────────────────

const body = (err: unknown) =>
  err instanceof ApiError ? ((err.data ?? {}) as { error?: unknown; code?: unknown; message?: unknown }) : {};

/** The server refused because the schedule is company-wide and this login is branch-limited (or may only view). */
export function isCompanyWideRefusal(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 403) return false;
  const b = body(err);
  return b.code === "company_wide_rule" || b.error === "company_wide_rule" || b.code === "company_wide_settings";
}

/** The server's sentence for a refused call, else the error's own message. */
export function errorText(err: unknown): string | undefined {
  const b = body(err);
  if (typeof b.message === "string" && b.message.trim()) return b.message;
  if (typeof b.error === "string" && b.error.trim() && !/^[a-z_]+$/.test(b.error)) return b.error;
  if (isCompanyWideRefusal(err))
    return "The reminder schedule is company-wide: only a login that is not limited to one branch can change it or send reminders.";
  if (err instanceof ApiError && err.status === 403) return "Your login may look at the reminders but not change them.";
  return err instanceof Error && err.message ? err.message : undefined;
}

/** A Send now refused because a run is still going (409 "run_in_progress", with that run): its id, to follow it instead. */
export function runInProgress(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const run = readHodRun((err.data as { run?: unknown } | null)?.run);
  return run ? run.id : null;
}

// ─── who a "Send now" reaches ──────────────────────────────────────────────────────────────────────────────────────

/** For one head and one channel: it goes, or why it will not. */
export type PlanCell = { goes: boolean; note: string };
export type PlanRow = { managerId: number; name: string; pending: number } & Record<HodChannel, PlanCell>;

/**
 * Who a reminder sent now reaches, and on which channels: every head with something pending (the reminder never goes to
 * one with nothing), each channel either going or the reason it will not (switched off, not set up, no number / email /
 * registered phone).
 */
export function sendPlan(
  rows: HodRow[],
  channels: HodChannelSwitches,
  status: Record<HodChannel, HodChannelStatus> | undefined,
): PlanRow[] {
  const cell = (c: HodChannel, row: HodRow): PlanCell => {
    if (!channels[c]) return { goes: false, note: "Switched off" };
    if (status && !status[c].available)
      return { goes: false, note: status[c].note || `${CHANNEL_LABEL[c]} is not set up` };
    if (c === "whatsapp" && !row.phone) return { goes: false, note: "No phone number" };
    if (c === "email" && !row.email) return { goes: false, note: "No email address" };
    if (c === "push" && row.devices <= 0) return { goes: false, note: "No phone registered for notifications" };
    return { goes: true, note: CHANNEL_LABEL[c] };
  };
  return rows
    .filter((r) => r.pending > 0)
    .sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name))
    .map((r) => ({
      managerId: r.managerId,
      name: r.name,
      pending: r.pending,
      whatsapp: cell("whatsapp", r),
      email: cell("email", r),
      push: cell("push", r),
    }));
}

/** How many of the chosen heads each channel reaches, and how many are reached by none. */
export function planCounts(plan: PlanRow[]): Record<HodChannel, number> & { unreachable: number } {
  return {
    whatsapp: plan.filter((p) => p.whatsapp.goes).length,
    email: plan.filter((p) => p.email.goes).length,
    push: plan.filter((p) => p.push.goes).length,
    unreachable: plan.filter((p) => !p.whatsapp.goes && !p.email.goes && !p.push.goes).length,
  };
}

// ─── runs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DELIVERY_TONE: Record<HodDeliveryStatus, Tone> = {
  pending: "info",
  sent: "success",
  failed: "danger",
  skipped: "warning",
  off: "neutral",
};

export const DELIVERY_LABEL: Record<HodDeliveryStatus, string> = {
  pending: "Waiting",
  sent: "Sent",
  failed: "Failed",
  skipped: "Skipped",
  off: "Off",
};

export const RUN_STATUS: Record<HodRun["status"], { label: string; tone: Tone }> = {
  running: { label: "Sending…", tone: "info" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

/** "Scheduled · 10:00 AM" or "Sent now by Meena". */
export function runTitle(run: Pick<HodRun, "trigger" | "slot" | "sentBy">): string {
  if (run.trigger === "schedule") return run.slot ? `Scheduled · ${timeLabel(run.slot)}` : "Scheduled";
  return run.sentBy ? `Sent now by ${run.sentBy}` : "Sent now";
}

/** "3 sent · 1 failed · 2 skipped" (the zeros left out); "nothing" when all are zero. */
export function countText(c: HodChannelCount): string {
  const parts = [
    c.sent ? `${c.sent} sent` : "",
    c.failed ? `${c.failed} failed` : "",
    c.skipped ? `${c.skipped} skipped` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "nothing";
}

/** One sentence for the toast when a run is over. */
export function runOutcome(run: HodRun): string {
  if (run.status === "failed") return run.error ?? "The run stopped with an error: see the run history.";
  if (run.hods === 0) return "No HoD had anything pending: nobody was reminded.";
  const parts = (["whatsapp", "email", "push"] as HodChannel[])
    .filter((c) => run.counts[c].sent + run.counts[c].failed + run.counts[c].skipped > 0)
    .map((c) => `${CHANNEL_LABEL[c]}: ${countText(run.counts[c])}`);
  return `${run.hods} HoD${run.hods === 1 ? "" : "s"} reminded. ${parts.join(". ")}`.trim();
}
