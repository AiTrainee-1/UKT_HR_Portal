// Requests hub: the reminders employees sent to HR from the mobile app (HOD Assignment -> My Requests -> "Remind HR").
//
// The HR portal has no inbox of its own, so a reminder to HR is shown where HR decides: on the request's row, as
// "Employee reminded on 31 Oct, 10:05". GET /api/hr/approval-reminders (backend/api/mobile_reminder_views.py) lists the
// latest reminder per request for the requests still waiting, keyed like the hub's items ("leave-12"). A reminder to a
// Department Head goes to their phone instead and is not listed here.

import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import type { HubItem, HubResponse } from "./logic";

export const REMINDERS_KEY = "/api/hr/approval-reminders";

export type HrReminder = { key: string; remindedAt: string; count: number };

/** The list, read leniently: rows without a key or a time are dropped; anything that is not a list is no reminders. */
export function normalizeReminders(raw: unknown): HrReminder[] {
  const rows = raw && typeof raw === "object" ? (raw as { reminders?: unknown }).reminders : null;
  if (!Array.isArray(rows)) return [];
  const out: HrReminder[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const { key, remindedAt, count } = r as Record<string, unknown>;
    if (typeof key !== "string" || !key || typeof remindedAt !== "string" || !remindedAt) continue;
    out.push({ key, remindedAt, count: typeof count === "number" && count > 0 ? count : 1 });
  }
  return out;
}

/** Refreshes every minute. A user who may not read it (or an older backend) simply gets no reminders. */
export function useHrReminders() {
  return useQuery<HrReminder[]>({
    queryKey: [REMINDERS_KEY],
    queryFn: async () => normalizeReminders(await customFetch<unknown>(REMINDERS_KEY)),
    refetchInterval: 60_000,
    retry: false,
  });
}

/** The hub's response with each waiting request's reminder put on it (`extra.hrReminder`). Decided requests get none. */
export function withReminders(hub: HubResponse, reminders: HrReminder[] | undefined): HubResponse {
  if (!reminders?.length) return hub;
  const byKey = new Map(reminders.map((r) => [r.key, r]));
  let changed = false;
  const items = hub.items.map((item) => {
    const r = byKey.get(item.key);
    if (!r || item.status !== "pending") return item;
    changed = true;
    return { ...item, extra: { ...item.extra, hrReminder: { remindedAt: r.remindedAt, count: r.count } } };
  });
  return changed ? { ...hub, items } : hub;
}

/** The reminder on a row, or null. */
export function reminderOf(item: Pick<HubItem, "extra">): { remindedAt: string; count: number } | null {
  const r = (item.extra as { hrReminder?: unknown } | undefined)?.hrReminder;
  if (!r || typeof r !== "object") return null;
  const { remindedAt, count } = r as Record<string, unknown>;
  if (typeof remindedAt !== "string" || !remindedAt) return null;
  return { remindedAt, count: typeof count === "number" && count > 0 ? count : 1 };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Employee reminded HR on 31 Oct, 10:05" (+ " (3 times)"). '' when there is no usable reminder. */
export function reminderText(r: { remindedAt: string; count: number } | null): string {
  if (!r) return "";
  const d = new Date(r.remindedAt);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const times = r.count > 1 ? ` (${r.count} times this week)` : "";
  return `Employee reminded HR on ${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}${times}`;
}
