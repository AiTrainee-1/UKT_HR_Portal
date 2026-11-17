// The pure parts of Phone Notify Control: the words for a push result, the grouping of the switches, the numbers of the
// overview, the chart bars and the filters that live in the address. No React here, so every rule is tested on its own.
import type {
  MobileMessageControl,
  MobileMessageRow,
  MobileMessagesOverview,
  PushAudience,
  PushConfig,
  PushCounts,
  PushHealthState,
  PushStatus,
} from "@/lib/api-client/custom-hooks";
import type { Tone as BadgeTone } from "@/lib/statusTones";

/** The sentence under a locked tab or a locked control, for a role that may only look. */
export const VIEW_ONLY_TEXT = "View only: you can look, but changes can't be saved.";

// ── push results ──────────────────────────────────────────────────────────────

export const PUSH_STATUSES: readonly PushStatus[] = ["sent", "delivered", "no_device", "failed", "off"];

export const STATUS_LABEL: Record<PushStatus | "", string> = {
  sent: "Sent, not confirmed yet",
  delivered: "Delivered to the phone",
  no_device: "No phone registered",
  failed: "Push failed",
  off: "Switched off for phones",
  "": "Not pushed (older notice)",
};

/** What each result means, in a sentence HR can read without knowing how pushes work. */
export const STATUS_HELP: Record<PushStatus | "", string> = {
  sent: "Handed to the Expo push service; Google has not confirmed it reached the phone yet.",
  delivered: "Google (Firebase) accepted it for the employee's phone.",
  no_device: "The employee has no phone registered, so it was only saved in the app.",
  failed: "The push service refused it. The reason is shown with the message.",
  off: "Not pushed because a switch was off (the master switch, its kind, or the employee is muted).",
  "": "Saved before phone notifications existed, so it was never pushed.",
};

export const STATUS_TONE: Record<PushStatus | "", BadgeTone> = {
  sent: "info",
  delivered: "success",
  no_device: "warning",
  failed: "danger",
  off: "neutral",
  "": "neutral",
};

export const statusLabel = (status: string): string => STATUS_LABEL[status as PushStatus] ?? status;
export const statusTone = (status: string): BadgeTone => STATUS_TONE[status as PushStatus] ?? "neutral";

const AGAIN: readonly string[] = ["failed", "no_device", "off"];

/** May this notification be pushed again? The server says so; an older server is read from the result. */
export function canPushAgain(row: Pick<MobileMessageRow, "pushStatus" | "canPushAgain">): boolean {
  return typeof row.canPushAgain === "boolean" ? row.canPushAgain : AGAIN.includes(row.pushStatus);
}

// ── numbers ───────────────────────────────────────────────────────────────────

/** `n` of `of` as a whole percentage, or null when there is nothing to divide by. */
export function percent(n: number, of: number): number | null {
  if (!of || of <= 0) return null;
  return Math.round((n * 100) / of);
}

/** "1 phone", "2 phones". */
export const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

export const formatNumber = (n: number): string => n.toLocaleString("en-IN");

/** "17 Nov, 09:30" (or "-" for nothing). */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The delivered part of what went out (an older server sends no `delivered`: nothing is claimed then). */
export const deliveredOf = (c: PushCounts): number => c.delivered ?? 0;

/** The overview's tiles, worked out from the numbers (the tones say good / watch / bad). */
export type TileId = "master" | "phones" | "today" | "week" | "delivered" | "failed" | "off" | "nophone";
export type Tile = {
  id: TileId;
  label: string;
  value: string;
  sub: string;
  tone: "good" | "warn" | "bad" | "info" | "neutral";
};

export function overviewTiles(o: MobileMessagesOverview): Tile[] {
  const week = o.week;
  const delivered = deliveredOf(week);
  const rate = percent(delivered, week.sent);
  const muted = o.muted ?? 0;
  const kindsOn = o.kinds === undefined ? null : Math.max(0, o.kinds - o.switchedOff);
  return [
    {
      id: "master",
      label: "Phone notifications",
      value: o.pushEnabled ? "ON" : "OFF",
      sub: !o.pushEnabled
        ? "Nothing is pushed to any phone"
        : kindsOn !== null && o.kinds
          ? `${kindsOn} of ${plural(o.kinds, "kind")} on`
          : o.switchedOff
            ? `${plural(o.switchedOff, "kind")} switched off`
            : "Every kind is on",
      tone: o.pushEnabled ? "good" : "bad",
    },
    {
      id: "phones",
      label: "Phones registered",
      value: `${formatNumber(o.devices.withDevice)} / ${formatNumber(o.devices.employees)}`,
      sub: `employees with a phone, ${plural(o.devices.tokens, "phone")} in all`,
      tone: o.devices.employees > 0 && o.devices.withDevice === 0 ? "warn" : "neutral",
    },
    {
      id: "today",
      label: "Pushed today",
      value: formatNumber(o.today.sent),
      sub: `of ${plural(o.today.total, "notification")} saved today`,
      tone: "info",
    },
    {
      id: "week",
      label: "Pushed in 7 days",
      value: formatNumber(week.sent),
      sub: `of ${plural(week.total, "notification")}`,
      tone: "info",
    },
    {
      id: "delivered",
      label: "Delivered (7 days)",
      value: formatNumber(delivered),
      sub: rate === null ? "Nothing went out yet" : `${rate}% of what went out was confirmed`,
      tone: week.sent === 0 ? "neutral" : "good",
    },
    {
      id: "failed",
      label: "Failed (7 days)",
      value: formatNumber(week.failed),
      sub: week.failed ? "Open the messages to see why" : "No push was refused",
      tone: week.failed ? "bad" : "good",
    },
    {
      id: "off",
      label: "Switched off (7 days)",
      value: formatNumber(week.off),
      sub: [
        o.switchedOff ? `${plural(o.switchedOff, "kind")} off` : "Every kind is on",
        muted ? `${plural(muted, "employee")} muted` : "",
      ]
        .filter(Boolean)
        .join(", "),
      tone: week.off ? "warn" : "neutral",
    },
    {
      id: "nophone",
      label: "No phone (7 days)",
      value: formatNumber(week.noDevice),
      sub: `${plural(o.devices.withoutDevice, "employee")} with no phone registered`,
      tone: week.noDevice ? "warn" : "neutral",
    },
  ];
}

// ── the chart ─────────────────────────────────────────────────────────────────

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon 17" from "2026-11-17" (read as a calendar date, so no time zone can move it). */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d}`;
}

export type DayBar = {
  date: string;
  label: string;
  total: number;
  sent: number;
  /** The part that was saved in the app but not pushed (no phone, switched off, failed). */
  notPushed: number;
  sentPct: number;
  notPushedPct: number;
};

/** The bars of the per-day chart, scaled to the busiest day. */
export function dayBars(days: MobileMessagesOverview["byDay"]): { bars: DayBar[]; peak: number } {
  const peak = Math.max(1, ...days.map((d) => d.total));
  const bars = days.map((d) => {
    const sent = Math.min(d.sent, d.total);
    const notPushed = Math.max(0, d.total - sent);
    return {
      date: d.date,
      label: dayLabel(d.date),
      total: d.total,
      sent,
      notPushed,
      sentPct: (sent / peak) * 100,
      notPushedPct: (notPushed / peak) * 100,
    };
  });
  return { bars, peak };
}

// ── the switches ──────────────────────────────────────────────────────────────

/** The order of the groups on the Controls tab; a group the server adds later goes after them, in the order it came. */
export const GROUP_ORDER: readonly string[] = [
  "documents",
  "attendance",
  "approvals",
  "geo",
  "visitors",
  "outpass",
  "other",
  "approval_workflows",
];

export const WORKFLOW_GROUP = "approval_workflows";

export type ControlGroup = {
  key: string;
  label: string;
  rows: MobileMessageControl[];
  /** How many of its switches are ON. */
  on: number;
  /** The "Approvals by workflow" group: a decision is pushed only while its kind AND its workflow are on. */
  workflow: boolean;
};

export function groupControls(controls: readonly MobileMessageControl[]): ControlGroup[] {
  const byKey = new Map<string, ControlGroup>();
  for (const row of controls) {
    const g = byKey.get(row.group) ?? {
      key: row.group,
      label: row.groupLabel || row.group,
      rows: [],
      on: 0,
      workflow: row.group === WORKFLOW_GROUP || row.kind === "workflow",
    };
    g.rows.push(row);
    if (row.enabled) g.on += 1;
    byKey.set(row.group, g);
  }
  const rank = (key: string) => {
    const i = GROUP_ORDER.indexOf(key);
    return i < 0 ? GROUP_ORDER.length : i;
  };
  // Array.prototype.sort is stable: groups the order does not know keep the order they came in
  return [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key));
}

/** The `types` to send to turn every switch of a group ON (or OFF): only the ones that change. */
export function groupChange(rows: readonly MobileMessageControl[], on: boolean): Record<string, boolean> {
  return Object.fromEntries(rows.filter((r) => r.enabled !== on).map((r) => [r.key, on]));
}

export const AUDIENCE_LABEL: Record<PushAudience, string> = {
  employee: "To the employee",
  approver: "To the approver",
  hr: "To HR",
};

export const audienceLabel = (a: string | undefined): string =>
  AUDIENCE_LABEL[(a ?? "employee") as PushAudience] ?? AUDIENCE_LABEL.employee;

/** The kinds a message can be filtered by on the Messages tab (the workflow rows are not kinds of message). */
export const messageKinds = (controls: readonly MobileMessageControl[]) => controls.filter((c) => c.kind === "message");

// ── health ────────────────────────────────────────────────────────────────────

export const HEALTH_LABEL: Record<PushHealthState, string> = {
  ok: "Working",
  warning: "Needs a look",
  problem: "Not working",
  unknown: "Nothing to judge yet",
};

export const healthTone = (state: PushHealthState | string): "good" | "warn" | "bad" | "neutral" =>
  state === "ok" ? "good" : state === "warning" ? "warn" : state === "problem" ? "bad" : "neutral";

/** Show the health on the Overview only when it is not fine (and not when it simply has nothing to judge). */
export const healthNeedsBanner = (health: PushConfig["health"] | undefined): boolean =>
  !!health && (health.state === "warning" || health.state === "problem");

// ── phones ────────────────────────────────────────────────────────────────────

export function platformLabel(platform: string | null | undefined): string {
  const p = (platform ?? "").toLowerCase();
  if (p === "android") return "Android phone";
  if (p === "ios") return "iPhone";
  return p ? `${platform} phone` : "Phone";
}

/** The two filters the Employees tab sends for what is picked (all / has a phone / no phone yet / muted). */
export type EmployeeShow = "all" | "with" | "without" | "muted";
export const EMPLOYEE_SHOWS: readonly EmployeeShow[] = ["all", "with", "without", "muted"];

export function employeeFilter(show: EmployeeShow): { has: "with" | "without" | ""; muted: boolean } {
  if (show === "with" || show === "without") return { has: show, muted: false };
  return { has: "", muted: show === "muted" };
}

export const asEmployeeShow = (v: string): EmployeeShow => EMPLOYEE_SHOWS.find((s) => s === v) ?? "all";

// ── the Messages filters in the address ───────────────────────────────────────

export const PAGE_SIZES = [10, 20, 50, 100];

export const asStatus = (v: string): PushStatus | "" => PUSH_STATUSES.find((s) => s === v) ?? "";
export const asRead = (v: string): "read" | "unread" | "" => (v === "read" || v === "unread" ? v : "");
export const asPage = (v: string): number => Math.max(1, Number.parseInt(v, 10) || 1);
export function asSize(v: string, fallback = 20): number {
  const n = Number.parseInt(v, 10);
  return PAGE_SIZES.includes(n) ? n : fallback;
}
/** A date the filter can send (YYYY-MM-DD), else nothing. */
export const asDate = (v: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");

// ── errors ────────────────────────────────────────────────────────────────────

/** The server's own sentence for a refusal ({error: "..."}), else the error's message, else `fallback`. */
export function errorText(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown } | null)?.data;
  if (data && typeof data === "object") {
    for (const field of ["error", "message", "detail"]) {
      const v = (data as Record<string, unknown>)[field];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
