// Pure helpers for WhatsApp Control (kept out of the components so they are unit-tested in logic.test.ts): the address,
// money and dates, Meta's words for a number's health, how each message type is switched and which template it goes
// out as, the template rules Meta applies, the sending limits, and Send a test.
import {
  WHATSAPP_PRICING_CATEGORIES,
  type WhatsAppAlert,
  type WhatsAppControlSettings,
  type WhatsAppFeature,
  type WhatsAppFeatureGroup,
  type WhatsAppMessageTypeInfo,
  type WhatsAppMetaTemplate,
  type WhatsAppPricingCategory,
  type WhatsAppQueueLimit,
  type WhatsAppQuietHours,
  type WhatsAppTestRecipient,
  type WhatsAppTestType,
  type WhatsAppTypeUsage,
  type WhatsAppUsageDay,
} from "@/lib/api-client/custom-hooks";
import { CATEGORY_HELP, categoryLabel } from "./shared";

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

// ── The tabs and the address (?tab=) ────────────────────────────────────────────────────────────────────────────────

/** The tab an address names (`?tab=controls`), else the Overview. Whether the role may open it is the page's call. */
export function tabFromSearch(search: string): string {
  const tab = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("tab");
  return tab?.trim().toLowerCase() || "overview";
}

/** The address of a tab: the Overview is the page's own address, any other tab adds `?tab=`. */
export const tabHref = (base: string, tab: string): string => (tab === "overview" ? base : `${base}?tab=${tab}`);

// ── Numbers, money, dates ───────────────────────────────────────────────────────────────────────────────────────────

const INR = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat("en-IN");

/** "₹1,23,456.78" (Indian grouping, always two decimals). */
export const formatInr = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `₹${INR.format(value)}`;

/** A price per message: "₹0.115", "₹0.8631", "₹0" (up to four decimals, no trailing zeros). */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `₹${Number(value.toFixed(4)).toString()}`;
}

export const formatCount = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : COUNT.format(value);

export const formatPct = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${Number(value.toFixed(1))}%`;

export const plural = (n: number, one: string, many = `${one}s`): string => `${formatCount(n)} ${n === 1 ? one : many}`;

/** "2026-11" for a date (the factory's calendar month as the browser sees it). */
export const monthOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The month `delta` months from "YYYY-MM". */
export function shiftMonth(month: string, delta: number): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
  return monthOf(d);
}

/** "November 2026". */
export function monthLabel(month: string): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

export function daysInMonth(month: string): number {
  const m = MONTH_RE.exec(month);
  if (!m) return 30;
  return new Date(Number(m[1]), Number(m[2]), 0).getDate();
}

/**
 * The month's projected total: what was spent so far, divided by the days gone (today included), times the days in the
 * month. Only the current month is projected; a past month's projection is its actual total, a future month's is 0.
 * (The server works out the same figure; this is the page's own reading when it has only the "so far".)
 */
export function projectMonth(soFar: number, month: string, now: Date = new Date()): number {
  const current = monthOf(now);
  if (month < current) return soFar;
  if (month > current) return 0;
  const elapsed = now.getDate();
  return Math.round((soFar / elapsed) * daysInMonth(month) * 100) / 100;
}

/** "4 min ago", "3 h ago", "2 days ago", "just now"; null when there is no time. */
export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  const s = Math.max(0, Math.round((now.getTime() - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** "10:42 am" for a time today, else the date and time. */
export function fmtSendTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const time = at.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}, ${time}`;
}

// ── Cost against the budget ─────────────────────────────────────────────────────────────────────────────────────────

export type BudgetState = {
  /** none: no budget set. ok: on course. near: 80% used, or the projection passes it. over: already past it. */
  level: "none" | "ok" | "near" | "over";
  /** How much of the budget is spent (0-100+), and where the projection lands, as percentages; null without a budget. */
  usedPct: number | null;
  projectedPct: number | null;
  /** The projection goes past the budget before the month ends. */
  projectedOver: boolean;
};

export function budgetState(soFar: number, projected: number, budget: number | null): BudgetState {
  if (budget === null || budget <= 0) return { level: "none", usedPct: null, projectedPct: null, projectedOver: false };
  const usedPct = Math.round((soFar / budget) * 1000) / 10;
  const projectedPct = Math.round((projected / budget) * 1000) / 10;
  const projectedOver = projected > budget;
  const level = usedPct >= 100 ? "over" : usedPct >= 80 || projectedOver ? "near" : "ok";
  return { level, usedPct, projectedPct, projectedOver };
}

/** A price or budget HR typed: why it can't be saved, or null. `optional` lets an empty field mean "none". */
export function moneyError(
  raw: string,
  { max, optional = false }: { max?: number; optional?: boolean } = {},
): string | null {
  const text = raw.trim();
  if (text === "") return optional ? null : "Enter an amount.";
  if (!/^\d+(\.\d+)?$/.test(text)) return "Numbers only, like 0.115.";
  const n = Number(text);
  if (max !== undefined && n > max) return `At most ₹${max}.`;
  return null;
}

// ── Meta's words for the number's health ────────────────────────────────────────────────────────────────────────────

/** Meta's quality rating of the number (the last 7 days of how people reacted to its messages). */
export function qualityInfo(rating: string | null | undefined): { label: string; tone: Tone; help: string } {
  switch ((rating ?? "").toUpperCase()) {
    case "GREEN":
    case "HIGH":
      return { label: "High", tone: "good", help: "People are reading the messages and not blocking the number." };
    case "YELLOW":
    case "MEDIUM":
      return {
        label: "Medium",
        tone: "warn",
        help: "Some people blocked or reported the number lately. Send fewer automatic messages for a while.",
      };
    case "RED":
    case "LOW":
      return {
        label: "Low",
        tone: "bad",
        help: "Many people blocked or reported the number. Meta may lower its messaging limit: pause the automatic alerts.",
      };
    default:
      return { label: "Not known", tone: "neutral", help: "Meta has not rated the number yet." };
  }
}

/** Meta's messaging limit ("TIER_2K"): how many different people the business may start a chat with in 24 hours. */
export function tierInfo(tier: string | null | undefined): { label: string; people: number | null } {
  const t = (tier ?? "").toUpperCase();
  if (!t) return { label: "Not known", people: null };
  if (t.includes("UNLIMITED")) return { label: "Unlimited", people: null };
  const m = /TIER_(\d+)(K?)/.exec(t);
  if (!m) return { label: t.replace(/_/g, " ").toLowerCase(), people: null };
  const people = Number(m[1]) * (m[2] ? 1000 : 1);
  return { label: `${formatCount(people)} people / 24 h`, people };
}

/** The number's status at Meta. */
export function numberStatusInfo(status: string | null | undefined): { label: string; tone: Tone } {
  const s = (status ?? "").toUpperCase();
  if (!s) return { label: "Not known", tone: "neutral" };
  if (s === "CONNECTED") return { label: "Connected", tone: "good" };
  if (["FLAGGED", "PENDING", "MIGRATED", "UNVERIFIED"].includes(s))
    return { label: s.charAt(0) + s.slice(1).toLowerCase(), tone: "warn" };
  if (["RESTRICTED", "BANNED", "DISCONNECTED", "RATE_LIMITED", "OFFLINE", "DELETED"].includes(s))
    return { label: s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " "), tone: "bad" };
  return { label: s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " "), tone: "neutral" };
}

/** When Meta last sent a delivery receipt: none for a day while messages go out means the webhook is not reaching us. */
export function webhookHealth(
  lastAt: string | null | undefined,
  now: Date = new Date(),
): { state: "ok" | "stale" | "never"; label: string; tone: Tone } {
  if (!lastAt) return { state: "never", label: "Never received", tone: "warn" };
  const ago = timeAgo(lastAt, now) ?? "unknown";
  const hours = (now.getTime() - new Date(lastAt).getTime()) / 3_600_000;
  if (hours > 24) return { state: "stale", label: ago, tone: "warn" };
  return { state: "ok", label: ago, tone: "good" };
}

/** The overview's verdict on the connection, for the hero's badge. */
export function connectionVerdict(c: {
  configured: boolean;
  sendingAllowed: boolean;
  status?: string | null;
  qualityRating?: string | null;
}): { label: string; tone: Tone } {
  if (!c.configured) return { label: "Not set up", tone: "bad" };
  if (!c.sendingAllowed) return { label: "Sending blocked", tone: "warn" };
  const status = numberStatusInfo(c.status);
  if (status.tone === "bad") return { label: status.label, tone: "bad" };
  if ((c.qualityRating ?? "").toUpperCase() === "RED") return { label: "Quality low", tone: "bad" };
  if (status.tone === "warn") return { label: status.label, tone: "warn" };
  return { label: "Live", tone: "good" };
}

/** Errors first, then warnings, then notes. */
export function sortAlerts(alerts: WhatsAppAlert[]): WhatsAppAlert[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...alerts].sort((a, b) => rank[a.level] - rank[b.level]);
}

export const alertTone = (level: WhatsAppAlert["level"]): Tone =>
  level === "error" ? "bad" : level === "warning" ? "warn" : "info";

export type AlertTab = "templates" | "config" | "usage" | "otp" | "controls" | "messages";

/** The tab that fixes each alert the server raises (backend whatsapp_usage.alerts), by its code. */
export const ALERT_TAB: Readonly<Record<string, AlertTab>> = {
  not_configured: "config",
  sending_blocked: "config",
  token_invalid: "config",
  meta_unreachable: "config",
  webhook_never: "config",
  webhook_stale: "config",
  number_status: "config",
  quality_red: "controls",
  quality_yellow: "controls",
  tier_near_limit: "controls",
  engine_off: "controls",
  queue_paused: "controls",
  template_rejected: "templates",
  template_paused: "templates",
  template_disabled: "templates",
  templates_missing: "templates",
  templates_pending: "templates",
  template_quality: "templates",
  otp_template: "otp",
  otp_expiry_mismatch: "otp",
  otp_paused: "otp",
  budget_exceeded: "usage",
  budget_projected_over: "usage",
  budget_near: "usage",
  failures: "messages",
};

/** Which tab fixes an alert, so the alert can link there: by its code (ALERT_TAB), else by the code's family, else by
 *  its words (an alert a newer server raises). The webhook's address is on Settings, so "webhook" is tested before the
 *  "template approvals" its sentence mentions. */
export function alertTab(alert: WhatsAppAlert): AlertTab | null {
  const code = alert.code.toLowerCase();
  if (ALERT_TAB[code]) return ALERT_TAB[code];
  if (/^otp/.test(code)) return "otp";
  if (/^templates?_/.test(code)) return "templates";
  if (/^budget/.test(code)) return "usage";
  const text = `${code} ${alert.message}`.toLowerCase();
  if (/not_configured|configured|token|webhook|env|set up/.test(text)) return "config";
  if (/template/.test(text)) return "templates";
  if (/budget|cost|spend/.test(text)) return "usage";
  if (/engine|switch|paused|quiet/.test(text)) return "controls";
  return null;
}

// ── Pricing categories ──────────────────────────────────────────────────────────────────────────────────────────────

export const PRICING_LABEL: Record<WhatsAppPricingCategory, string> = {
  authentication: "Authentication",
  utility: "Utility",
  marketing: "Marketing",
  service: "Service",
};

export const PRICING_HELP: Record<WhatsAppPricingCategory, string> = {
  authentication: "One-time sign-in, password reset and activation codes.",
  utility: "Everything about an employee's own work: documents, alerts, approvals, gate and visitor messages.",
  marketing: "Promotions. The HRMS sends none; a template Meta files as marketing costs this much.",
  service: "Replies inside 24 hours of an employee's own message. Free.",
};

/** The chart colour of each category: Tailwind's variables, so the Clean theme and the dark mode recolour them. */
export const PRICING_COLOR: Record<WhatsAppPricingCategory, string> = {
  authentication: "var(--color-violet-500)",
  utility: "var(--color-emerald-500)",
  marketing: "var(--color-amber-500)",
  service: "var(--color-slate-400)",
};

export const pricingLabel = (c: string | null | undefined): string =>
  c ? (PRICING_LABEL[c as WhatsAppPricingCategory] ?? c.charAt(0).toUpperCase() + c.slice(1)) : "—";

/** Every day of the month (up to today for the current month), with zeros where the server has no row. */
export function chartDays(
  days: WhatsAppUsageDay[],
  month: string,
  now: Date = new Date(),
): (WhatsAppUsageDay & { day: number; total: number })[] {
  const byDate = new Map(days.map((d) => [d.date.slice(0, 10), d]));
  const last = month === monthOf(now) ? now.getDate() : month > monthOf(now) ? 0 : daysInMonth(month);
  const out: (WhatsAppUsageDay & { day: number; total: number })[] = [];
  for (let day = 1; day <= last; day++) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const d = byDate.get(date);
    const byCategory = d?.byCategory ?? { authentication: 0, utility: 0, marketing: 0, service: 0 };
    const total = WHATSAPP_PRICING_CATEGORIES.reduce((n, c) => n + byCategory[c], 0);
    out.push({
      date,
      day,
      sent: d?.sent ?? 0,
      delivered: d?.delivered ?? 0,
      read: d?.read ?? 0,
      failed: d?.failed ?? 0,
      byCategory,
      total,
    });
  }
  return out;
}

// ── Meta template statuses ──────────────────────────────────────────────────────────────────────────────────────────

/** How a message type stands for its template: approved (it goes out), pending (waiting for Meta), rejected / paused /
 *  disabled (it is skipped), missing (no template yet: skipped), none (this type is never sent through Meta). */
export type TemplateState =
  "approved" | "pending" | "rejected" | "paused" | "disabled" | "missing" | "none" | "unknown";

export function templateState(status: string | null | undefined): TemplateState {
  const s = (status ?? "").toUpperCase();
  if (!s) return "missing";
  if (s === "APPROVED") return "approved";
  if (["PENDING", "IN_APPEAL", "DRAFT"].includes(s)) return "pending";
  if (s === "REJECTED") return "rejected";
  if (s === "PAUSED") return "paused";
  if (["DISABLED", "DELETED", "PENDING_DELETION", "ARCHIVED", "LIMIT_EXCEEDED"].includes(s)) return "disabled";
  return "unknown";
}

export const TEMPLATE_STATE_INFO: Record<TemplateState, { label: string; tone: Tone; help: string }> = {
  approved: { label: "Approved", tone: "good", help: "Meta approved it: messages of this type go out." },
  pending: { label: "In review", tone: "warn", help: "Waiting for Meta's review (usually minutes, at most 24 hours)." },
  rejected: {
    label: "Rejected",
    tone: "bad",
    help: "Meta rejected it. Read the reason, fix the wording and submit again.",
  },
  paused: {
    label: "Paused",
    tone: "bad",
    help: "Meta paused it after poor feedback. It is skipped until Meta lifts it.",
  },
  disabled: { label: "Disabled", tone: "bad", help: "Meta disabled or deleted it. Create a new one." },
  missing: { label: "No template", tone: "warn", help: "No Meta template yet: messages of this type are skipped." },
  none: { label: "Not via Meta", tone: "neutral", help: "This message type is not sent through Meta." },
  unknown: { label: "Unknown", tone: "neutral", help: "A status this page does not know yet." },
};

/** The label of a raw Meta status (a status this page does not know shows Meta's own word). */
export function templateStatusLabel(status: string | null | undefined): string {
  const state = templateState(status);
  if (state === "unknown" || state === "disabled") {
    const s = (status ?? "").toLowerCase().replace(/_/g, " ");
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown";
  }
  if (state === "pending" && (status ?? "").toUpperCase() === "DRAFT") return "Draft";
  return TEMPLATE_STATE_INFO[state].label;
}

// ── Message types: their switch, template and count (Message Controls) ──────────────────────────────────────────────

/** The prefix of a per-message-type switch (`type:salary_slip`). */
export const TYPE_SWITCH_PREFIX = "type:";

/** The message types switched by a setting of their own (whatsapp_catalog.py `switch`) rather than a `type:` switch. */
export const OWN_SWITCH_TYPE: Readonly<Record<string, string>> = {
  otpLoginEnabled: "otp_login",
  otpResetEnabled: "otp_reset",
  otpActivateEnabled: "otp_activate",
  absentAlertEnabled: "absent_alert",
  lateAlertEnabled: "late_alert",
  missingPunchAlertEnabled: "missing_punch_alert",
  hodRequestWaitingEnabled: "hod_request_waiting",
  // the On-Duty tracking alerts (2026-11-21): one switch each, covering the Department Head's copy too
  geoLocationOffEnabled: "geo_location_off",
  geoPermissionRestrictedEnabled: "geo_permission_restricted",
  geoBackgroundRestrictedEnabled: "geo_background_restricted",
  geoMissingPunchEnabled: "geo_missing_punch",
  geoPunchReminderEnabled: "geo_punch_reminder",
  geoTrackingFailureEnabled: "geo_tracking_failure",
};

/** The message type a switch turns on and off, or null for a module / workflow switch. */
export function typeOfSwitch(key: string): string | null {
  if (key.startsWith(TYPE_SWITCH_PREFIX)) return key.slice(TYPE_SWITCH_PREFIX.length) || null;
  return OWN_SWITCH_TYPE[key] ?? null;
}

export const isTypeSwitch = (feature: WhatsAppFeature): boolean => typeOfSwitch(feature.key) !== null;

/** The three one-time code types share one Meta template (an AUTHENTICATION template with a Copy code button). */
export const OTP_TYPES: readonly string[] = ["otp_login", "otp_reset", "otp_activate"];
export const OTP_TEMPLATE = "hrms_otp";
/** Types that never go through Meta (whatsapp_catalog.py meta_template "-"): the visitor's contact card is now a line of
 *  the visitor notice. */
export const NOT_VIA_META: readonly string[] = ["visitor_contact"];
/** The catalog's default template names that are not simply hrms_<type> (backend whatsapp_catalog.py meta_template).
 *  The server sends every type's real name (settings.messageTypes); this is the page's fallback for an older server. */
export const DEFAULT_TEMPLATE_NAME: Readonly<Record<string, string>> = {
  otp_login: OTP_TEMPLATE,
  otp_reset: OTP_TEMPLATE,
  otp_activate: OTP_TEMPLATE,
  four_punch_alert: "hrms_punch_reminder",
  other: "hrms_document",
  visitor_notification: "hrms_visitor_at_reception",
  outpass_gate_out: "hrms_gate_out",
  outpass_gate_in: "hrms_gate_in",
};
/** Switches several types share besides their own `type:` switch (backend whatsapp_catalog.py `switch`): while one is
 *  OFF none of its types is sent. The server sends every type's switches (settings.messageTypes); this is the fallback. */
export const SHARED_SWITCH: Readonly<Record<string, string>> = {
  four_punch_alert: "fourPunchAlertEnabled",
  on_duty_punch_reminder: "fourPunchAlertEnabled",
  geo_approval: "geoApprovalEnabled",
  geo_rejection: "geoApprovalEnabled",
  geo_punch_approval: "geoApprovalEnabled",
  geo_punch_rejection: "geoApprovalEnabled",
};

/** The Meta template a message type goes out as: what the server says (settings.messageTypes), else HR's choice, else
 *  the template that says it serves the type, else the catalog's default name; null for a type that is not sent
 *  through Meta. */
export function templateNameFor(
  type: string,
  overrides: Record<string, string>,
  templates: WhatsAppMetaTemplate[] | null,
  serverTypes?: Record<string, WhatsAppMessageTypeInfo>,
): string | null {
  const known = serverTypes?.[type];
  if (known) return known.templateName;
  if (overrides[type]) return overrides[type];
  if (NOT_VIA_META.includes(type)) return null;
  const serving = templates?.find((t) => t.messageTypes.includes(type) && templateState(t.status) !== "disabled");
  if (serving) return serving.name;
  return DEFAULT_TEMPLATE_NAME[type] ?? `hrms_${type}`;
}

/** The best row of a template name: approved first, then in review, then whatever else (several languages may exist). */
export function findTemplate(
  name: string | null,
  templates: WhatsAppMetaTemplate[] | null,
): WhatsAppMetaTemplate | null {
  if (!name || !templates) return null;
  const rows = templates.filter((t) => t.name === name);
  const rank = (t: WhatsAppMetaTemplate) =>
    ({ approved: 0, pending: 1, rejected: 2, paused: 3, unknown: 4, disabled: 5, missing: 6, none: 7 })[
      templateState(t.status)
    ];
  return rows.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Why a message type is not sent right now, the first reason that applies: never sent through Meta, the engine, the
 *  WhatsApp OTP master, its section's master, a switch it shares with other types, its own switch, its template. */
export type OffReason = "none" | "engine" | "otp" | "module" | "shared" | "own" | "template";

export const OFF_REASON_TEXT: Record<OffReason, string> = {
  none: "Not sent: the official WhatsApp Cloud API has no template that can carry it.",
  engine: "The WhatsApp engine is OFF.",
  otp: "WhatsApp OTP is OFF (OTP tab).",
  module: "Its section switch is OFF.",
  shared: "A switch it shares with other messages is OFF.",
  own: "Switched OFF.",
  template: "Skipped: no approved Meta template.",
};

/** The sentence under a held-back type: names the shared switch that holds it when there is one. */
export function offReasonText(row: Pick<TypeRow, "off" | "offBy">): string | null {
  if (!row.off) return null;
  if (row.off === "shared" && row.offBy) return `Held: “${row.offBy.label}” is OFF.`;
  return OFF_REASON_TEXT[row.off];
}

export type TypeRow = {
  type: string;
  /** The switch that turns this type on and off. */
  feature: WhatsAppFeature;
  templateName: string | null;
  template: WhatsAppMetaTemplate | null;
  /** null while templates can't be read (the Templates tab is hidden for the role). */
  templateState: TemplateState | null;
  /** This month's messages of the type; null while usage can't be read. */
  monthCount: number | null;
  /** null: it goes out. */
  off: OffReason | null;
  /** The switch that holds it back (for "own", "module" and "shared"). */
  offBy: WhatsAppFeature | null;
  /** Every switch it needs is ON (the engine and its template aside): what the server's "Create all missing" and its
   *  "missing for switched-on types" go by. False for a type never sent through Meta. */
  switchedOn: boolean;
};

export type ControlSection = {
  group: WhatsAppFeatureGroup;
  /** The section's master switch (Document notifications, Attendance alerts (all) ...), when it has one. */
  master: WhatsAppFeature | null;
  /** The other module and workflow switches (Leave approval / rejection, Punch reminder (4 punches) ...). */
  general: WhatsAppFeature[];
  types: TypeRow[];
};

/** Each section's master switch (backend whatsapp_catalog.MODULE_SWITCHES): while it is OFF nothing in the section is
 *  sent, whatever the section's other switches say. */
export const SECTION_MASTER: Readonly<Record<string, string>> = {
  documents: "documentNotificationsEnabled",
  attendance: "attendanceAlertsEnabled",
  approvals: "approvalNotificationsEnabled",
  hod: "hodNotificationsEnabled",
  visitors: "visitorNotificationEnabled",
  outpass: "outpassNotificationsEnabled",
};

/** The switches that are about sign-in rather than a message (they live on the OTP tab only). */
export const SIGNIN_ONLY_SWITCHES: readonly string[] = ["passwordLoginEnabled"];

/** Where a module with no group of its own is shown: right after this group (else at the end). */
const PLACE_AFTER: Record<string, string> = { otp: "signin" };

/** The server's groups in its order, plus a group for every module that only has `type:` switches, so no switch is
 *  left out; groups with no switch are dropped. */
export function orderedGroups(groups: WhatsAppFeatureGroup[], features: WhatsAppFeature[]): WhatsAppFeatureGroup[] {
  const ordered = [...groups];
  const known = new Set(groups.map((g) => g.key));
  for (const f of features) {
    if (known.has(f.group)) continue;
    known.add(f.group);
    const group = { key: f.group, title: categoryLabel(f.group), blurb: CATEGORY_HELP[f.group] ?? "" };
    const anchor = PLACE_AFTER[f.group];
    const at = anchor ? ordered.findIndex((g) => g.key === anchor) : -1;
    if (at >= 0) ordered.splice(at + 1, 0, group);
    else ordered.push(group);
  }
  return ordered.filter((g) => features.some((f) => f.group === g.key));
}

type SettingsForControls = Pick<
  WhatsAppControlSettings,
  "engineEnabled" | "otpEnabled" | "groups" | "features" | "templateOverrides"
> &
  Partial<Pick<WhatsAppControlSettings, "messageTypes">>;

/** The keys of every switch a type needs besides the engine, in the order the first OFF one is named: what the server
 *  says (settings.messageTypes), else the page's own mirror (the OTP master for a code, the section's master, a shared
 *  switch, its own). */
export function typeSwitches(type: string, group: string, ownKey: string, settings: SettingsForControls): string[] {
  const known = settings.messageTypes?.[type]?.switches;
  if (known && known.length > 0) return known.includes(ownKey) ? known : [...known, ownKey];
  const out: string[] = [];
  if (OTP_TYPES.includes(type)) out.push("otpEnabled");
  for (const key of [SECTION_MASTER[group], SHARED_SWITCH[type], ownKey]) if (key && !out.includes(key)) out.push(key);
  return out;
}

/** Every section of Message Controls: its switches, and each message type with its switch, template and count. */
export function controlSections(
  settings: SettingsForControls,
  templates: WhatsAppMetaTemplate[] | null,
  byType: WhatsAppTypeUsage[] | null,
): ControlSection[] {
  const counts = byType ? new Map(byType.map((t) => [t.type, t.messages])) : null;
  const byKey = new Map(settings.features.map((f) => [f.key, f]));
  return orderedGroups(settings.groups, settings.features).map((group) => {
    const rows = settings.features.filter((f) => f.group === group.key && !SIGNIN_ONLY_SWITCHES.includes(f.key));
    const masterKey = SECTION_MASTER[group.key];
    const master = (masterKey && rows.find((f) => f.key === masterKey)) || null;
    const general = rows.filter((f) => f !== master && !isTypeSwitch(f));
    const types = rows.filter(isTypeSwitch).map((feature): TypeRow => {
      const type = typeOfSwitch(feature.key)!;
      const name = templateNameFor(type, settings.templateOverrides, templates, settings.messageTypes);
      const template = findTemplate(name, templates);
      const state: TemplateState | null =
        name === null ? "none" : templates === null ? null : templateState(template?.status ?? null);
      // the first switch that is OFF, and which kind of switch it is
      let held: { reason: OffReason; by: WhatsAppFeature | null } | null = null;
      for (const key of typeSwitches(type, group.key, feature.key, settings)) {
        const switchOf = key === feature.key ? feature : (byKey.get(key) ?? null);
        const on = key === "otpEnabled" ? settings.otpEnabled : switchOf?.enabled;
        if (on !== false) continue; // a switch this page was not given is not held against the type
        const reason: OffReason =
          key === "otpEnabled" ? "otp" : key === feature.key ? "own" : key === masterKey ? "module" : "shared";
        held = { reason, by: key === "otpEnabled" ? null : switchOf };
        break;
      }
      const off: OffReason | null =
        name === null
          ? "none"
          : !settings.engineEnabled
            ? "engine"
            : held
              ? held.reason
              : state !== null && state !== "approved"
                ? "template"
                : null;
      return {
        type,
        feature,
        templateName: name,
        template,
        templateState: state,
        monthCount: counts ? (counts.get(type) ?? 0) : null,
        off,
        offBy: held && off === held.reason ? held.by : null,
        switchedOn: name !== null && held === null,
      };
    });
    return { group, master, general, types };
  });
}

/** How many types go out, how many are held back, and how many wait for a template. A type never sent through Meta
 *  is left out of every count. */
export function controlSummary(sections: ControlSection[]): {
  total: number;
  live: number;
  off: number;
  noTemplate: number;
} {
  const rows = sections.flatMap((s) => s.types).filter((r) => r.off !== "none");
  return {
    total: rows.length,
    live: rows.filter((r) => r.off === null).length,
    off: rows.filter((r) => r.off !== null && r.off !== "template").length,
    noTemplate: rows.filter((r) => r.off === "template").length,
  };
}

/** The switched-on types whose template is missing, rejected, paused, disabled or only a draft (in review is on its
 *  way), each template once (the three code types share one): what the server's "Create all missing" submits. The
 *  engine is left aside, as on the server: templates are prepared before sending starts. */
export function missingTemplateRows(sections: ControlSection[]): TypeRow[] {
  return sections
    .flatMap((s) => s.types)
    .filter(
      (r) =>
        r.switchedOn &&
        r.templateState !== null &&
        (!["approved", "pending", "none"].includes(r.templateState) ||
          (r.template?.status ?? "").toUpperCase() === "DRAFT"),
    )
    .filter((r, i, all) => all.findIndex((x) => x.templateName === r.templateName) === i);
}

// ── Meta's template rules (the editor checks them before submitting) ────────────────────────────────────────────────

export const TEMPLATE_NAME_RE = /^[a-z0-9_]+$/;
export const FOOTER_MAX = 60;
export const BODY_MAX = 1024;
const VAR_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
export const VAR_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** The {{variables}} of a body, each once, in the order they first appear. */
export function templateVariables(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The body with each variable replaced by its example (an empty example shows the variable's name in brackets). */
export function renderTemplate(body: string, examples: Record<string, string>): string {
  return body.replace(VAR_RE, (_all, name: string) => {
    const value = examples[name];
    return value && value.trim() ? value : `[${name}]`;
  });
}

export type TemplateCheck = { errors: Record<string, string>; warnings: string[] };

/** Meta's rules for a template (https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates):
 *  a lowercase name, a body that does not start or end with a variable, enough fixed words around the variables, an
 *  example for every variable, a short footer. An AUTHENTICATION template has a fixed body Meta writes itself. */
export function checkTemplate(input: {
  name: string;
  category: string;
  body: string;
  footer: string;
  examples: Record<string, string>;
}): TemplateCheck {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  const name = input.name.trim();
  if (!name) errors.name = "Give the template a name.";
  else if (!TEMPLATE_NAME_RE.test(name)) errors.name = "Lowercase letters, digits and _ only (like hrms_salary_slip).";
  else if (name.length > 512) errors.name = "At most 512 characters.";
  if (input.category.toUpperCase() === "AUTHENTICATION") return { errors, warnings };

  const body = input.body;
  const trimmed = body.trim();
  const vars = templateVariables(body);
  if (!trimmed) errors.body = "Write the message.";
  else if (body.length > BODY_MAX) errors.body = `At most ${BODY_MAX} characters (now ${body.length}).`;
  else if (/^\{\{[^{}]*\}\}/.test(trimmed)) errors.body = "Meta refuses a message that starts with a variable.";
  else if (/\{\{[^{}]*\}\}[.!?]?$/.test(trimmed))
    errors.body = "Meta refuses a message that ends with a variable: add a closing line.";
  else if (/\}\}\s*\{\{/.test(body)) errors.body = "Two variables side by side: put words between them.";
  else {
    const bad = vars.find((v) => !VAR_NAME_RE.test(v));
    if (bad !== undefined) errors.body = `{{${bad}}}: variable names are lowercase letters, digits and _.`;
  }
  if (!errors.body && trimmed) {
    const fixedWords = trimmed
      .replace(VAR_RE, " ")
      .split(/\s+/)
      .filter((w) => /[a-z0-9]/i.test(w)).length;
    if (vars.length > 0 && fixedWords < vars.length * 2 + 1)
      warnings.push("Few fixed words for so many variables: Meta may reject it as too unclear. Add some words.");
  }
  for (const v of vars) {
    const ex = input.examples[v] ?? "";
    if (!ex.trim()) errors[`example:${v}`] = "Meta needs an example.";
    else if (/[\n\t]|\s{5,}/.test(ex)) errors[`example:${v}`] = "One line, no tabs, no long runs of spaces.";
  }
  if (input.footer.length > FOOTER_MAX)
    errors.footer = `At most ${FOOTER_MAX} characters (now ${input.footer.length}).`;
  if (input.category.toUpperCase() === "MARKETING")
    errors.category = "UK Textiles HRMS sends Utility and Authentication templates only: choose Utility.";
  return { errors, warnings };
}

/** What a stored template looks like, read from Meta's components: the header, body, footer and buttons. */
export function templateParts(components: Record<string, unknown>[]): {
  header: { format: string; text: string } | null;
  body: string;
  footer: string;
  buttons: string[];
} {
  let header: { format: string; text: string } | null = null;
  let body = "";
  let footer = "";
  const buttons: string[] = [];
  for (const c of components) {
    const type = String(c.type ?? "").toUpperCase();
    if (type === "HEADER") header = { format: String(c.format ?? "TEXT").toUpperCase(), text: String(c.text ?? "") };
    else if (type === "BODY") body = String(c.text ?? "");
    else if (type === "FOOTER") footer = String(c.text ?? "");
    else if (type === "BUTTONS" && Array.isArray(c.buttons))
      for (const b of c.buttons)
        if (b && typeof b === "object") buttons.push(String((b as { text?: unknown }).text ?? ""));
  }
  return { header, body, footer, buttons };
}

/** The examples Meta stored with a template's body ({body_text_named_params: [{param_name, example}]}). */
export function templateExamples(components: Record<string, unknown>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of components) {
    if (String(c.type ?? "").toUpperCase() !== "BODY") continue;
    const example = c.example as { body_text_named_params?: { param_name?: string; example?: string }[] } | undefined;
    for (const p of example?.body_text_named_params ?? [])
      if (p?.param_name) out[p.param_name] = String(p.example ?? "");
  }
  return out;
}

/** The fixed text of an authentication template (Meta writes it; only the expiry changes). */
export function authTemplatePreview(code: string, expiryMinutes: number | null): { body: string; footer: string } {
  return {
    body: `*${code}* is your verification code. For your security, do not share this code.`,
    footer: expiryMinutes ? `This code expires in ${expiryMinutes} minutes.` : "",
  };
}

// ── The sending limits and quiet hours ──────────────────────────────────────────────────────────────────────────────

/** Why a typed limit can't be saved, or null when it can. */
export function limitError(limit: WhatsAppQueueLimit, raw: string | undefined): string | null {
  const text = (raw ?? "").trim();
  if (text === "") return "Enter a number.";
  const n = Number(text);
  if (!Number.isInteger(n)) return "Whole numbers only.";
  if (n < limit.min || n > limit.max) return `Must be between ${limit.min} and ${limit.max}.`;
  return null;
}

/** The limits whose typed value differs from the saved one, as the PATCH body wants them. */
export function changedLimits(limits: WhatsAppQueueLimit[], draft: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of limits) {
    const raw = draft[l.key];
    if (raw === undefined || raw.trim() === "") continue;
    const n = Number(raw);
    if (n !== l.value) out[l.key] = n;
  }
  return out;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Why the quiet hours can't be saved, or null when they can. */
export function quietHoursError(q: WhatsAppQuietHours): string | null {
  if (!HHMM.test(q.start) || !HHMM.test(q.end)) return "Enter both times as HH:MM.";
  if (q.enabled && q.start === q.end) return "Start and end can't be the same time.";
  return null;
}

export const quietHoursChanged = (saved: WhatsAppQuietHours | undefined, draft: WhatsAppQuietHours): boolean =>
  !saved || saved.enabled !== draft.enabled || saved.start !== draft.start || saved.end !== draft.end;

/** True when quiet hours run past midnight (21:00 to 07:00). */
export const crossesMidnight = (q: WhatsAppQuietHours): boolean =>
  HHMM.test(q.start) && HHMM.test(q.end) && q.start > q.end;

/** How close a count is to its cap: under 80%, at 80% or more, at or over the cap. A cap of 0 means unknown. */
export function usageLevel(used: number, cap: number): "ok" | "near" | "full" {
  if (!cap) return "ok";
  const ratio = used / cap;
  if (ratio >= 1) return "full";
  if (ratio >= 0.8) return "near";
  return "ok";
}

// ── Messages: Meta's delivery ticks ─────────────────────────────────────────────────────────────────────────────────

/** WhatsApp's ticks for a message: one grey (sent), two grey (delivered), two blue (read), or none / failed. */
export function deliveryTicks(status: string): "none" | "sent" | "delivered" | "read" | "failed" {
  if (status === "read") return "read";
  if (status === "delivered") return "delivered";
  if (status === "sent" || status === "pending") return "sent";
  if (status === "failed") return "failed";
  return "none";
}

// ── Send a test ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The message types grouped by module, in the server's order. */
export function groupTestTypes(
  types: WhatsAppTestType[],
): { module: string; label: string; types: WhatsAppTestType[] }[] {
  const out: { module: string; label: string; types: WhatsAppTestType[] }[] = [];
  for (const t of types) {
    const group = out.find((g) => g.module === t.module);
    if (group) group.types.push(t);
    else out.push({ module: t.module, label: t.moduleLabel || categoryLabel(t.module), types: [t] });
  }
  return out;
}

/** "SURYA M (••••9103)": who a test goes to, as the confirmation names them. */
export const recipientLabel = (r: Pick<WhatsAppTestRecipient, "name" | "phone" | "code">): string =>
  `${r.name} (${r.phone ?? r.code})`;

/** "employee 30020" / "employees 30020 and 30021" / "employees 1, 2 and 3". */
export function employeeCodesText(codes: string[]): string {
  if (codes.length === 1) return `employee ${codes[0]}`;
  return `employees ${codes.slice(0, -1).join(", ")} and ${codes[codes.length - 1]}`;
}

/** What Meta's error codes mean, in words HR can act on (the server's own sentence is shown first). */
export const META_ERROR_HELP: Readonly<Record<number, string>> = {
  190: "The access token has expired or is wrong. Make a new System User token in Meta Business Manager and update WHATSAPP_CLOUD_ACCESS_TOKEN.",
  368: "Meta has temporarily blocked the number for policy reasons. Sending is paused; check WhatsApp Manager.",
  130429: "Too many messages too fast (Meta's rate limit). Try again in a minute.",
  131026: "The number is not on WhatsApp, or cannot receive this message.",
  131047: "More than 24 hours since the employee last wrote: only a template can be sent.",
  131048: "Meta's spam limit: too many people blocked or reported the number. Sending is paused.",
  131049: "Meta chose not to deliver it to keep the ecosystem healthy. Try again later, not straight away.",
  131056: "Too many messages to the same number in a short time. Try again later.",
  132000: "The template has a different number of variables than the HRMS sent.",
  132001: "The template does not exist or is not approved in this language.",
  132012: "A variable's value is in the wrong format (a new line, a tab or too many spaces).",
};

export const metaErrorHelp = (code: number | null | undefined): string | null =>
  code === null || code === undefined ? null : (META_ERROR_HELP[code] ?? null);
