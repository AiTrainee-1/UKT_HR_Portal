// Pure helpers for the Feature Controls and queue UI of WhatsApp Control (kept out of the components so they are unit-tested).
import type {
  WhatsAppFeature,
  WhatsAppFeatureGroup,
  WhatsAppQueueLimit,
  WhatsAppQuietHours,
} from "@/lib/api-client/custom-hooks";
import { CATEGORY_HELP, categoryLabel } from "./shared";

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
