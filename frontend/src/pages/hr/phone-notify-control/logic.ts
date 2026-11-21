// The pure parts of Phone Notify Control: the words for a push result, the grouping of the switches, the numbers of the
// overview, the chart bars and the filters that live in the address. No React here, so every rule is tested on its own.
import type {
  AlertTimingKey,
  AlertTimingLimit,
  MobileMessageControl,
  MobileMessageRow,
  MobileMessagesOverview,
  PhoneAlertSettings,
  PushAudience,
  PushCategory,
  PushConfig,
  PushCounts,
  PushHealthState,
  PushKindStats,
  PushRecipients,
  PushStatus,
  PushTemplate,
  RecipientChange,
  RecipientEmployeeParams,
  RecipientMatch,
  RecipientMode,
  RecipientModeOption,
  RecipientsLine,
} from "@/lib/api-client/custom-hooks";
import type { Tone as BadgeTone } from "@/lib/statusTones";

/** The sentence under a locked tab or a locked control, for a role that may only look. */
export const VIEW_ONLY_TEXT = "View only: you can look, but changes can't be saved.";

// ── push results ──────────────────────────────────────────────────────────────

/** The results the Messages tab filters by (the server takes these five; "sending" only lasts a moment). */
export const PUSH_STATUSES: readonly PushStatus[] = ["sent", "delivered", "no_device", "failed", "off"];

export const STATUS_LABEL: Record<PushStatus | "", string> = {
  sent: "Sent, not confirmed yet",
  delivered: "Delivered to the phone",
  no_device: "No phone registered",
  failed: "Push failed",
  off: "Switched off for phones",
  sending: "Sending to the phone",
  "": "Waiting to be pushed",
};

/** What each result means, in a sentence HR can read without knowing how pushes work. */
export const STATUS_HELP: Record<PushStatus | "", string> = {
  sent: "Handed to the Expo push service; Google has not confirmed it reached the phone yet.",
  delivered: "Google (Firebase) accepted it for the employee's phone.",
  no_device: "The employee has no phone registered, so it was only saved in the app.",
  failed: "The push service refused it. The reason is shown with the message.",
  off: "Not pushed because a switch was off (the master switch, its kind, or the employee is muted), or the employee is not one of the people who receive phone notifications (Settings tab).",
  sending: "Being handed to the Expo push service right now; it settles within a few seconds.",
  "": "Saved and waiting for its turn, usually pushed within a minute. A notice saved before phone notifications existed stays like this.",
};

export const STATUS_TONE: Record<PushStatus | "", BadgeTone> = {
  sent: "info",
  delivered: "success",
  no_device: "warning",
  failed: "danger",
  off: "neutral",
  sending: "info",
  "": "neutral",
};

/** The words for a result; one this page does not know yet takes the server's own label (`fallback`), else the raw value. */
export const statusLabel = (status: string, fallback?: string): string =>
  STATUS_LABEL[status as PushStatus] ?? (fallback || status);
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
  // the server counts the phones over the employees who receive phone notifications (the Settings tab): say whose they are
  // when that is not everyone
  const scope = o.recipients && o.recipients.mode !== "all" ? recipientsLine(o.recipients).label : null;
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
      sub: `${scope ? `${scope}: ` : ""}employees with a phone, ${plural(o.devices.tokens, "phone")} in all`,
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
      sub: `${plural(o.devices.withoutDevice, "employee")} with no phone registered${scope ? ` (${scope})` : ""}`,
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
  "tracking",
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
  employee_hod: "To the employee, then the Department Head",
};

export const audienceLabel = (a: string | undefined): string =>
  AUDIENCE_LABEL[(a ?? "employee") as PushAudience] ?? AUDIENCE_LABEL.employee;

/** The kinds a message can be filtered by on the Messages tab (the workflow rows are not kinds of message). */
export const messageKinds = (controls: readonly MobileMessageControl[]) => controls.filter((c) => c.kind === "message");

// ── the categories (the Overview's dashboard, the Controls tab's filter) ──────

/**
 * The order of the categories where the server gives none (the Controls tab reads them from the switches); a category the
 * server adds later goes after them, in the order it came. The Overview keeps the server's own order.
 */
export const CATEGORY_ORDER: readonly string[] = [
  "leave",
  "permission",
  "attendance",
  "on_duty",
  "compensation",
  "payroll",
  "chat",
  "employee",
  "gate",
  "decisions",
  "approvers",
];

/** Every switch of a category on, none, some of them ("partial"), or a category with no switch at all ("none"). */
export type CategoryState = "on" | "off" | "partial" | "none";

export function categoryState(c: { on: number; total: number }): CategoryState {
  if (c.total <= 0) return "none";
  if (c.on >= c.total) return "on";
  if (c.on <= 0) return "off";
  return "partial";
}

export const CATEGORY_STATE_LABEL: Record<CategoryState, string> = {
  on: "ON",
  off: "OFF",
  partial: "Some off",
  none: "No switches",
};

/** A press on a category's switch turns every switch in it ON, unless every one is on already: then all OFF. */
export const categoryTarget = (state: CategoryState): boolean => state !== "on";

/**
 * How many of a category's switches are on: counted from the switches when they are loaded (they change the moment a save
 * comes back), else the overview's own numbers.
 */
export function categoryCounts(
  cat: Pick<PushCategory, "keys" | "on" | "total">,
  controls?: readonly MobileMessageControl[],
): { on: number; total: number } {
  const keys = new Set(cat.keys);
  const rows = (controls ?? []).filter((r) => keys.has(r.key));
  if (rows.length === 0) return { on: cat.on, total: cat.total };
  return { on: rows.filter((r) => r.enabled).length, total: rows.length };
}

/**
 * The `types` to send to turn every switch of a category ON (or OFF). With the switches loaded, only the ones that change;
 * without them, every switch of the category (the server leaves a switch that is already so as it is).
 */
export function categoryChange(
  keys: readonly string[],
  on: boolean,
  controls?: readonly MobileMessageControl[],
): Record<string, boolean> {
  const known = new Map((controls ?? []).map((r) => [r.key, r.enabled]));
  return Object.fromEntries(keys.filter((k) => known.get(k) !== on).map((k) => [k, on]));
}

export const AUDIENCE_SHORT: Record<PushAudience, string> = {
  employee: "Employees",
  approver: "Approvers",
  hr: "HR",
  employee_hod: "Employees",
};

/** Who receives a category, in words ("Employees", "Approvers"); nothing known: the employees. */
export function audienceNames(audience: readonly string[] | undefined): string[] {
  const list = audience && audience.length ? audience : ["employee"];
  // "the employee, then the Department Head" names both (each once)
  const names = list.flatMap((a) =>
    a === "employee_hod" ? ["Employees", "Approvers"] : [AUDIENCE_SHORT[a as PushAudience] ?? a],
  );
  return [...new Set(names)];
}

export type SegmentId = "delivered" | "sent" | "failed" | "off" | "noDevice" | "waiting";

export type Segment = { id: SegmentId; label: string; value: number; pct: number };

export const SEGMENT_LABEL: Record<SegmentId, string> = {
  delivered: "Delivered",
  sent: "Sent, not confirmed",
  failed: "Failed",
  off: "Switched off",
  noDevice: "No phone",
  waiting: "Waiting or older",
};

/**
 * A category's 30 days as the parts of one bar: delivered, sent but not confirmed, failed, switched off, no phone, and the
 * rest (waiting to be pushed, or saved before phone notifications existed). Parts with nothing in them are left out.
 */
export function monthSegments(m: PushKindStats): Segment[] {
  const delivered = Math.max(0, m.delivered);
  const sentOnly = Math.max(0, m.sent - delivered);
  const counted = delivered + sentOnly + m.failed + m.off + m.noDevice;
  const waiting = Math.max(0, m.total - counted);
  const whole = Math.max(1, counted + waiting);
  const parts: [SegmentId, number][] = [
    ["delivered", delivered],
    ["sent", sentOnly],
    ["failed", m.failed],
    ["off", m.off],
    ["noDevice", m.noDevice],
    ["waiting", waiting],
  ];
  return parts
    .filter(([, value]) => value > 0)
    .map(([id, value]) => ({ id, label: SEGMENT_LABEL[id], value, pct: (value * 100) / whole }));
}

export type CategoryChip = { key: string; label: string; total: number; on: number };

/**
 * The categories the switches belong to (the Controls tab's filter), in the dashboard's order. Empty when the server does
 * not say (an older one): the filter is then not offered.
 */
export function controlCategories(controls: readonly MobileMessageControl[]): CategoryChip[] {
  const byKey = new Map<string, CategoryChip>();
  for (const row of controls) {
    if (!row.category) continue;
    const c = byKey.get(row.category) ?? {
      key: row.category,
      label: row.categoryLabel || row.category,
      total: 0,
      on: 0,
    };
    c.total += 1;
    if (row.enabled) c.on += 1;
    byKey.set(row.category, c);
  }
  const rank = (key: string) => {
    const i = CATEGORY_ORDER.indexOf(key);
    return i < 0 ? CATEGORY_ORDER.length : i;
  };
  // Array.prototype.sort is stable: categories the order does not know keep the order they came in
  return [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key));
}

/** The category the address asks for, when the switches have it; anything else is every category (""). */
export const asCategory = (v: string, chips: readonly { key: string }[]): string =>
  chips.some((c) => c.key === v) ? v : "";

/** The switches of one category ("" = all of them). */
export const inCategory = (controls: readonly MobileMessageControl[], category: string): MobileMessageControl[] =>
  category ? controls.filter((r) => r.category === category) : [...controls];

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

// ── who receives phone notifications (the Settings tab) ──────────────────────

export const RECIPIENT_MODES: readonly RecipientMode[] = ["all", "staff", "production", "selected"];

/** The names of the four choices, where the server gives none. */
export const RECIPIENT_MODE_LABEL: Record<RecipientMode, string> = {
  all: "All employees",
  staff: "Staff only",
  production: "Production only",
  selected: "Selected employees",
};

/** A choice's name: the server's own, else the page's. */
export function modeLabel(mode: string, modes?: readonly Pick<RecipientModeOption, "key" | "label">[]): string {
  return modes?.find((m) => m.key === mode)?.label || RECIPIENT_MODE_LABEL[mode as RecipientMode] || mode;
}

/** "1 employee", "1,420 employees". */
export const employeesText = (n: number): string => `${formatNumber(n)} ${n === 1 ? "employee" : "employees"}`;

/** "142 employees, 37 with a phone". */
export const reachText = (employees: number, withPhone: number): string =>
  `${employeesText(employees)}, ${formatNumber(withPhone)} with a phone`;

/** The mode and how far it reaches, as the Settings tab's summary and the Overview's line say it. */
export function recipientsLine(r: PushRecipients | RecipientsLine): { label: string; reach: string } {
  const label = r.modeLabel || modeLabel(r.mode, "modes" in r ? r.modes : undefined);
  return { label, reach: reachText(r.receiving, r.receivingWithPhone) };
}

/** Why a choice cannot be saved right now (null when it can): the server refuses Selected employees with an empty list. */
export function modeBlocked(mode: RecipientMode, r: Pick<PushRecipients, "selected">): string | null {
  if (mode === "selected" && r.selected <= 0) {
    return "The selected list is empty, so this cannot be saved yet: nobody would get phone notifications. Tick the employees in the list below first, then choose Selected employees again.";
  }
  return null;
}

type Group = "staff" | "production";
const COVERS: Record<Exclude<RecipientMode, "selected">, readonly Group[]> = {
  all: ["staff", "production"],
  staff: ["staff"],
  production: ["production"],
};
const GROUP_NAME: Record<Group, string> = { staff: "Staff employees", production: "Production employees" };

/** What a change of mode does, in words. `stops`: somebody will stop getting phone notifications (asked in red). */
export type ModeChange = { lines: string[]; stops: boolean; after: string };

/**
 * What changing the mode from `from` to `to` does: who will stop and who will start getting phone notifications, with the
 * counts the server gave for each choice, and how many get them afterwards. Between All, Staff and Production the counts
 * are exact; to or from the selected list only the totals are known, so the words say who without a split.
 */
export function modeChange(from: RecipientMode, to: RecipientMode, modes: readonly RecipientModeOption[]): ModeChange {
  const n = (k: RecipientMode) => modes.find((m) => m.key === k)?.employees ?? 0;
  const lines: string[] = [];
  let stops = false;
  const stop = (who: string, count: number) => {
    if (count <= 0) return;
    stops = true;
    lines.push(`${who} will stop getting phone notifications: ${employeesText(count)}.`);
  };
  const start = (who: string, count: number) => {
    if (count > 0) lines.push(`${who} will start getting phone notifications: ${employeesText(count)}.`);
  };
  const notOnList = Math.max(0, n("all") - n("selected"));

  if (from === to) {
    // nothing changes
  } else if (from !== "selected" && to !== "selected") {
    for (const g of COVERS[from]) if (!COVERS[to].includes(g)) stop(GROUP_NAME[g], n(g));
    for (const g of COVERS[to]) if (!COVERS[from].includes(g)) start(GROUP_NAME[g], n(g));
  } else if (to === "selected" && from === "all") {
    stop("Everyone who is not on the selected list", notOnList);
  } else if (from === "selected" && to === "all") {
    start("Everyone who is not on the selected list", notOnList);
  } else if (to === "selected") {
    const group = from as Group;
    const other: Group = group === "staff" ? "production" : "staff";
    stops = true;
    lines.push(
      `Only the ${employeesText(n("selected"))} on the selected list will get phone notifications: ${GROUP_NAME[group].toLowerCase()} who are not on it will stop getting them, and ${GROUP_NAME[other].toLowerCase()} on it will start.`,
    );
  } else {
    const group = to as Group;
    const other: Group = group === "staff" ? "production" : "staff";
    lines.push(
      `Every ${group} employee will get phone notifications (${employeesText(n(group))}), not only the ones on the selected list. ${GROUP_NAME[other]} on the selected list will stop getting them.`,
    );
  }
  if (from !== to && lines.length === 0) lines.push("No employee is affected right now.");

  const target = modes.find((m) => m.key === to);
  const after = `After the change, phone notifications go to ${reachText(target?.employees ?? 0, target?.withPhone ?? 0)}.`;
  return { lines, stops, after };
}

// The picker of the selected list: its filters live in the address (?q=asha&type=staff&branch=2&dept=5&list=on&page=2).

export const RECIPIENT_PAGE_SIZE = 50;

/** Everyone, only the ones on the selected list, or only the ones not on it. */
export type PickerShow = "all" | "on" | "off";

export type PickerFilters = {
  search: string;
  type: "" | "staff" | "production";
  /** Ids as the address holds them ("" = any). */
  branch: string;
  department: string;
  show: PickerShow;
};

export const asPickerType = (v: string): PickerFilters["type"] => (v === "staff" || v === "production" ? v : "");
export const asPickerShow = (v: string): PickerShow => (v === "on" || v === "off" ? v : "all");
/** A positive whole number as text, else "" (any). */
export const asId = (v: string): string => (/^\d+$/.test(v) && Number(v) > 0 ? String(Number(v)) : "");

/** The filters as "every employee matching" (the bulk changes): empty ones left out, ids as numbers. */
export function recipientMatch(f: PickerFilters): RecipientMatch {
  const out: RecipientMatch = {};
  const search = f.search.trim();
  if (search) out.search = search;
  if (f.type) out.type = f.type;
  const branch = asId(f.branch);
  if (branch) out.branch = Number(branch);
  const department = asId(f.department);
  if (department) out.department = Number(department);
  return out;
}

/** What the list asks the server for: the same filters, on / not on the list, one page. */
export function recipientParams(
  f: PickerFilters,
  page: number,
  pageSize = RECIPIENT_PAGE_SIZE,
): RecipientEmployeeParams {
  const selected = f.show === "on" ? "1" : f.show === "off" ? "0" : undefined;
  return { ...recipientMatch(f), ...(selected ? { selected } : {}), page, pageSize };
}

/** Does anything besides "on / not on the list" narrow the list? (Without, "every employee matching" is everyone.) */
export const isNarrowed = (f: PickerFilters): boolean => Object.keys(recipientMatch(f)).length > 0;

export type BulkKind = "add" | "remove" | "clear";

/** The body of a bulk change: every employee matching the filters (on / not on the list does not count), or the whole list. */
export function bulkChange(kind: BulkKind, f: PickerFilters): RecipientChange {
  if (kind === "clear") return { clear: true };
  const match = recipientMatch(f);
  return kind === "add" ? { addMatching: match } : { removeMatching: match };
}

/**
 * The question a bulk change asks first, with its count. `shown` = how many the filter shows; `listed` = how many are on
 * the list; `mode` = the current mode (a change to the list matters at once only while it is Selected employees).
 */
export function bulkQuestion(
  kind: BulkKind,
  f: PickerFilters,
  counts: { shown: number; listed: number },
  mode: RecipientMode,
): string {
  const live = mode === "selected";
  if (kind === "clear") {
    return `Take all ${employeesText(counts.listed)} off the selected list?${
      live
        ? " The mode is Selected employees, so nobody will get phone notifications until employees are added again or another option is chosen above."
        : ""
    }`;
  }
  const who = isNarrowed(f)
    ? `all ${employeesText(counts.shown)} shown by this filter`
    : f.show === "all"
      ? `every active employee (${employeesText(counts.shown)})`
      : `all ${employeesText(counts.shown)} shown`;
  if (kind === "add") {
    return `Add ${who} to the selected list? Those already on it stay as they are.${
      live ? " They start getting phone notifications at once." : ""
    }`;
  }
  return `Take ${who} off the selected list? Those not on it stay as they are.${
    live ? " They stop getting phone notifications at once." : ""
  }`;
}

/** The toast after a change to the list, from how many the server really changed. */
export function changeDoneText(kind: BulkKind, changed: number): string {
  if (kind === "clear") {
    return changed > 0
      ? `The selected list is empty now (${employeesText(changed)} taken off)`
      : "The selected list was already empty";
  }
  if (kind === "add") {
    return changed > 0
      ? `${employeesText(changed)} added to the selected list`
      : "Nobody was added: they were all on the list already";
  }
  return changed > 0
    ? `${employeesText(changed)} taken off the selected list`
    : "Nobody was taken off: none of them was on the list";
}

// ── the phone attendance alerts' timing (the Settings tab) ────────────────────

/** The three timings, in the order the page shows them. */
export const ALERT_TIMING_KEYS: readonly AlertTimingKey[] = [
  "absentExtraMinutes",
  "reminderLeadMinutes",
  "missingAfterMinutes",
];

/** The fields as typed (text, so a field can be empty while it is being changed). */
export type AlertTimingDraft = Record<AlertTimingKey, string>;

export const alertTimingDraft = (s: Pick<PhoneAlertSettings, AlertTimingKey>): AlertTimingDraft => ({
  absentExtraMinutes: String(s.absentExtraMinutes),
  reminderLeadMinutes: String(s.reminderLeadMinutes),
  missingAfterMinutes: String(s.missingAfterMinutes),
});

/** Why a typed timing cannot be saved (null when it can): empty, not whole minutes, or outside the server's range. */
export function alertTimingProblem(value: string, limit: Pick<AlertTimingLimit, "min" | "max">): string | null {
  const v = value.trim();
  if (v === "") return "Enter a number of minutes.";
  if (!/^\d+$/.test(v)) return "Whole minutes only.";
  const n = Number(v);
  if (n < limit.min || n > limit.max) return `Between ${limit.min} and ${limit.max} minutes.`;
  return null;
}

/** "0 to 240 minutes". */
export const alertTimingRange = (limit: Pick<AlertTimingLimit, "min" | "max">): string =>
  `${limit.min} to ${limit.max} minutes`;

/** What Save sends: only the timings that changed, as numbers (an empty object when nothing changed). */
export function alertTimingChanges(
  saved: Pick<PhoneAlertSettings, AlertTimingKey>,
  draft: AlertTimingDraft,
): Partial<Record<AlertTimingKey, number>> {
  const out: Partial<Record<AlertTimingKey, number>> = {};
  for (const k of ALERT_TIMING_KEYS) {
    const v = draft[k].trim();
    if (/^\d+$/.test(v) && Number(v) !== saved[k]) out[k] = Number(v);
  }
  return out;
}

// ── the wording of each kind (the Message Text tab) ───────────────────────────

/** The longest title and message the server takes. */
export const TEMPLATE_TITLE_MAX = 100;
export const TEMPLATE_BODY_MAX = 1000;
/** About how much of a title a phone shows before it cuts it off (40 to 60 characters, by phone). */
export const TITLE_SHOWN = 60;

/** Characters as the server counts them (an emoji is one, not two). */
export const charCount = (text: string): number => [...text].length;

export type CountTone = "ok" | "long" | "over";

/** The title's counter: over 60 a phone may cut it off, over 100 it cannot be saved. */
export function titleCount(title: string): { text: string; tone: CountTone } {
  const n = charCount(title);
  return {
    text: `${formatNumber(n)} / ${TEMPLATE_TITLE_MAX}`,
    tone: n > TEMPLATE_TITLE_MAX ? "over" : n > TITLE_SHOWN ? "long" : "ok",
  };
}

/** The message's counter: over 1,000 it cannot be saved. */
export function bodyCount(body: string): { text: string; tone: CountTone } {
  const n = charCount(body);
  return {
    text: `${formatNumber(n)} / ${formatNumber(TEMPLATE_BODY_MAX)}`,
    tone: n > TEMPLATE_BODY_MAX ? "over" : "ok",
  };
}

/** Why a wording cannot be saved, the way the server says it (null when it can). Unknown placeholders: the server's word. */
export function wordingProblem(title: string, body: string): string | null {
  if (/[\r\n]/.test(title)) return "The title must be one line.";
  const t = charCount(title.trim());
  if (t > TEMPLATE_TITLE_MAX)
    return `The title is ${formatNumber(t)} characters long; the most is ${TEMPLATE_TITLE_MAX}.`;
  const b = charCount(body.trim());
  if (b > TEMPLATE_BODY_MAX) {
    return `The message is ${formatNumber(b)} characters long; the most is ${formatNumber(TEMPLATE_BODY_MAX)}.`;
  }
  return null;
}

/** `{{name}}`. */
export const placeholderToken = (name: string): string => `{{${name}}}`;

/**
 * Puts `token` where the cursor is (replacing what is selected); no cursor known: at the end. Returns the new text and where
 * the cursor goes (right after the token).
 */
export function insertAt(
  value: string,
  token: string,
  start?: number | null,
  end?: number | null,
): { value: string; caret: number } {
  const from = Math.min(Math.max(start ?? value.length, 0), value.length);
  const to = Math.min(Math.max(end ?? from, from), value.length);
  return { value: value.slice(0, from) + token + value.slice(to), caret: from + token.length };
}

/** Is the wording in the fields different from the saved one? (Spaces at either end do not count: they are not saved.) */
export const isWordingDirty = (t: Pick<PushTemplate, "title" | "body">, title: string, body: string): boolean =>
  title.trim() !== t.title.trim() || body.trim() !== t.body.trim();

/** What Save sends: the fields without the spaces at either end. */
export const wordingBody = (title: string, body: string): { title: string; body: string } => ({
  title: title.trim(),
  body: body.trim(),
});

/** On (its switch on Controls is on) or switched off there. */
export const templateStatus = (t: Pick<PushTemplate, "enabled">): { label: string; tone: BadgeTone } =>
  t.enabled ? { label: "On", tone: "success" } : { label: "Switched off on Controls", tone: "neutral" };

/** Does a kind match the search? Every word must be in its name, description, category, key or HR's own wording. */
export function templateMatches(t: PushTemplate, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [t.label, t.description, t.categoryLabel, t.groupLabel, t.key, t.title, t.body].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export type TemplateGroup = { key: string; label: string; rows: PushTemplate[]; custom: number };

/**
 * The kinds by category, in the categories' order (a category the page does not know goes after them, in the order it
 * came), each in the server's (Controls) order, narrowed by the search and "custom only". Empty categories are left out.
 */
export function groupTemplates(
  rows: readonly PushTemplate[],
  opts: { search?: string; customOnly?: boolean } = {},
): TemplateGroup[] {
  const byKey = new Map<string, TemplateGroup>();
  for (const t of rows) {
    if (opts.customOnly && !t.customised) continue;
    if (!templateMatches(t, opts.search ?? "")) continue;
    const g = byKey.get(t.category) ?? { key: t.category, label: t.categoryLabel || t.category, rows: [], custom: 0 };
    g.rows.push(t);
    if (t.customised) g.custom += 1;
    byKey.set(t.category, g);
  }
  const rank = (key: string) => {
    const i = CATEGORY_ORDER.indexOf(key);
    return i < 0 ? CATEGORY_ORDER.length : i;
  };
  // Array.prototype.sort is stable: categories the order does not know keep the order they came in
  return [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key));
}

/**
 * Can a kind wrap its built-in text? Its placeholders include {{message}} (the built-in sentence), and usually {{headline}}
 * (the built-in title).
 */
export function wrapsBuiltIn(t: Pick<PushTemplate, "variables">): { message: boolean; headline: boolean } {
  const names = new Set(t.variables.map((v) => v.name));
  return { message: names.has("message"), headline: names.has("headline") };
}

/** Should the phone card offer to expand (more than it shows in about two lines, like Android's collapsed card)? */
export const phoneCanExpand = (title: string, body: string): boolean =>
  body.includes("\n") || charCount(body) > 80 || charCount(title) > 40;

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
