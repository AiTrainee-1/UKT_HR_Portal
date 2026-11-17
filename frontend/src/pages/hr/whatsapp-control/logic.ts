// Pure helpers for the Feature Controls and queue UI of WhatsApp Control (kept out of the components so they are unit-tested).
import type {
  WhatsAppControlSettings,
  WhatsAppControlTemplate,
  WhatsAppFeature,
  WhatsAppFeatureGroup,
  WhatsAppProviderState,
  WhatsAppQueueLimit,
  WhatsAppQuietHours,
  WhatsAppTestRecipient,
  WhatsAppTestType,
} from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";
import { CATEGORY_HELP, categoryLabel } from "./shared";

// ── The tabs and the address (?tab=) ────────────────────────────────────────────────────────────────────────────────

/** The tab an address names (`?tab=controls`), else the Overview. Whether the role may open it is the page's call. */
export function tabFromSearch(search: string): string {
  const tab = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("tab");
  return tab?.trim().toLowerCase() || "overview";
}

/** The address of a tab: the Overview is the page's own address, any other tab adds `?tab=`. */
export const tabHref = (base: string, tab: string): string => (tab === "overview" ? base : `${base}?tab=${tab}`);

/** The prefix of a per-message-type switch (`type:salary_slip`). */
export const TYPE_SWITCH_PREFIX = "type:";
export const isTypeSwitch = (feature: WhatsAppFeature): boolean => feature.key.startsWith(TYPE_SWITCH_PREFIX);

/** Where a module with no group of its own is shown: right after this group (else at the end). */
const PLACE_AFTER: Record<string, string> = { otp: "signin" };

export type FeatureSection = {
  group: WhatsAppFeatureGroup;
  /** The module and workflow switches. */
  general: WhatsAppFeature[];
  /** One switch per message type. */
  perType: WhatsAppFeature[];
};

/** The server's groups in its order, plus a group for every module that only has `type:` switches, so no switch is
 *  left out; groups with no switch are dropped. */
export function featureSections(groups: WhatsAppFeatureGroup[], features: WhatsAppFeature[]): FeatureSection[] {
  const ordered = [...groups];
  const known = new Set(groups.map((g) => g.key));
  for (const f of features) {
    if (known.has(f.group)) continue;
    known.add(f.group);
    // A module the server has switches for but no group: named the way the rest of the page names it.
    const group = { key: f.group, title: categoryLabel(f.group), blurb: CATEGORY_HELP[f.group] ?? "" };
    const anchor = PLACE_AFTER[f.group];
    const at = anchor ? ordered.findIndex((g) => g.key === anchor) : -1;
    if (at >= 0) ordered.splice(at + 1, 0, group);
    else ordered.push(group);
  }
  return ordered
    .map((group) => {
      const rows = features.filter((f) => f.group === group.key);
      return { group, general: rows.filter((f) => !isTypeSwitch(f)), perType: rows.filter(isTypeSwitch) };
    })
    .filter((s) => s.general.length + s.perType.length > 0);
}

/** Why a typed limit can't be saved, or null when it can. */
export function limitError(limit: WhatsAppQueueLimit, raw: string | undefined): string | null {
  const text = (raw ?? "").trim();
  if (text === "") return "Enter a number.";
  const n = Number(text);
  if (!Number.isInteger(n)) return "Whole numbers only.";
  if (n < limit.min || n > limit.max) return `Must be between ${limit.min} and ${limit.max}.`;
  return null;
}

/** The limits whose typed value differs from the saved one, as the PUT body wants them. */
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

/** "10:42 am" for a time today, else the date and time. */
export function fmtSendTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const time = at.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}, ${time}`;
}

// ── What is switched off (the Overview's banner, Feature Controls) ──────────────────────────────────────────────────

/** Each section's master switch (backend whatsapp_catalog.MODULE_SWITCHES): while it is OFF nothing in the section is
 *  sent, whatever the section's other switches say. A section without one (sign-in, Geo) is left out. */
export const SECTION_MASTER: Readonly<Record<string, string>> = {
  documents: "documentNotificationsEnabled",
  attendance: "attendanceAlertsEnabled",
  approvals: "approvalNotificationsEnabled",
  hod: "hodNotificationsEnabled",
  visitors: "visitorNotificationEnabled",
  outpass: "outpassNotificationsEnabled",
};

/** The section's master switch, when it has one and the server sent it. */
export function sectionMaster(groupKey: string, features: WhatsAppFeature[]): WhatsAppFeature | null {
  const key = SECTION_MASTER[groupKey];
  return (key && features.find((f) => f.key === key)) || null;
}

/** Why a message type is never sent: the engine (master switch), its module's switch, its own switch, or its wording
 *  switched off on Message Text. */
export type OffReason = "engine" | "module" | "own" | "wording";

export type TypeSwitchState = {
  documentType: string;
  label: string;
  category: string;
  categoryLabel: string;
  /** null while it can be sent. */
  off: OffReason | null;
};

export type SwitchedOffSummary = {
  total: number;
  on: TypeSwitchState[];
  off: TypeSwitchState[];
  /** The modules with something switched off, in the server's order, with how many. */
  offByModule: { key: string; label: string; count: number }[];
  /** engine-off: nothing at all is sent. most: more than half the types are off. some: a few. none: every type can go. */
  level: "engine-off" | "most" | "some" | "none";
};

/** Every message type and whether HR's switches let it go out (the server's own fields: the type's switch, its
 *  module's switch, its Message Text switch; and the engine). */
export function switchedOffSummary(templates: WhatsAppControlTemplate[], engineEnabled: boolean): SwitchedOffSummary {
  const states: TypeSwitchState[] = templates.map((t) => ({
    documentType: t.documentType,
    label: t.label,
    category: t.category,
    categoryLabel: t.categoryLabel || categoryLabel(t.category),
    off: !engineEnabled
      ? "engine"
      : t.moduleEnabled === false
        ? "module"
        : t.featureEnabled === false
          ? "own"
          : t.isEnabled === false
            ? "wording"
            : null,
  }));
  const off = states.filter((s) => s.off !== null);
  const offByModule: SwitchedOffSummary["offByModule"] = [];
  for (const s of off) {
    const row = offByModule.find((m) => m.key === s.category);
    if (row) row.count += 1;
    else offByModule.push({ key: s.category, label: s.categoryLabel, count: 1 });
  }
  const level =
    states.length === 0
      ? "none"
      : !engineEnabled
        ? "engine-off"
        : off.length === 0
          ? "none"
          : off.length * 2 > states.length
            ? "most"
            : "some";
  return { total: states.length, on: states.filter((s) => s.off === null), off, offByModule, level };
}

/** When the message types can't be read (the Message Text tab is hidden for the role): the switches themselves. */
export function switchCounts(settings: Pick<WhatsAppControlSettings, "features">): { total: number; off: number } {
  return { total: settings.features.length, off: settings.features.filter((f) => !f.enabled).length };
}

export type HodSwitch = {
  feature: WhatsAppFeature;
  /** Its own switch is ON and the engine and the section switch let it through. */
  on: boolean;
  /** Its own switch is ON, but the engine or the section switch holds it back. */
  held: boolean;
};

export type HodStatus = {
  engineOn: boolean;
  /** The section's master switch (Department Head notifications (all)); null on a server without one. */
  master: WhatsAppFeature | null;
  items: HodSwitch[];
  /** on: every message to the heads can go. off: none can. partly: some. */
  state: "on" | "off" | "partly";
};

/** The Department Head notifications section ("hod", 2026-11-17): the new-request message and the scheduled reminder.
 *  null when the server has no such section (an older release). */
export function hodStatus(settings: Pick<WhatsAppControlSettings, "engineEnabled" | "features">): HodStatus | null {
  const rows = settings.features.filter((f) => f.group === "hod");
  if (rows.length === 0) return null;
  const engineOn = settings.engineEnabled !== false;
  const master = sectionMaster("hod", rows);
  const open = engineOn && (master?.enabled ?? true);
  const items = rows
    .filter((f) => f !== master)
    .map((feature) => ({ feature, on: open && feature.enabled, held: feature.enabled && !open }));
  const onCount = items.filter((i) => i.on).length;
  const state =
    items.length === 0 ? (open ? "on" : "off") : onCount === items.length ? "on" : onCount ? "partly" : "off";
  return { engineOn, master, items, state };
}

// ── The connection check (Configuration) ────────────────────────────────────────────────────────────────────────────

const PROVIDER_STATES: Record<string, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "success" },
  disconnected: { label: "Disconnected", tone: "danger" },
  logged_out: { label: "Logged out", tone: "danger" },
  pending: { label: "Pending", tone: "warning" },
  linking: { label: "Linking", tone: "warning" },
  connecting: { label: "Connecting", tone: "warning" },
  unknown: { label: "Unknown", tone: "neutral" },
};

/** The badge for WAClient's state: green connected, red disconnected or logged out, amber on its way, grey unknown. */
export function providerBadge(state: WhatsAppProviderState): { label: string; tone: Tone } {
  return PROVIDER_STATES[state] ?? { label: state.replace(/_/g, " "), tone: "neutral" };
}

/** The server lists every problem; the documents one (WAClient can't download a PDF from here) is set apart, since
 *  documents are a lower priority than the text messages (owner, 2026-11-17). */
export function splitProblems(
  problems: string[],
  documentsProblem: string | null,
): { main: string[]; documents: string | null } {
  const isDocs = (p: string) =>
    p.startsWith("Documents cannot be sent") || (!!documentsProblem && p.includes(documentsProblem));
  const docs = problems.find(isDocs);
  return { main: problems.filter((p) => !isDocs(p)), documents: documentsProblem ?? docs ?? null };
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

/** The longest text WAClient is sent (the server refuses more). */
export const TEST_TEXT_MAX = 4000;
