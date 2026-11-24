import type { AutoRejectKind, AutoRejectRunResult } from "@/lib/api-client/custom-hooks";

/** The tab's form: the switch and the number of days as typed. */
export type AutoRejectForm = { enabled: boolean; days: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A whole number of days, or null when the text is not one. */
export function parseDays(text: string): number | null {
  const t = text.trim();
  return /^\d{1,4}$/.test(t) ? Number(t) : null;
}

/** What is wrong with the days typed, or undefined. */
export function validateDays(text: string, limits: { min: number; max: number }): string | undefined {
  const n = parseDays(text);
  if (n === null) return `Enter a whole number of days (${limits.min} to ${limits.max}).`;
  if (n < limits.min || n > limits.max) return `Between ${limits.min} and ${limits.max} days.`;
  return undefined;
}

/** The rule in one plain sentence. */
export function ruleSentence(days: number, enabled = true): string {
  const rule = `Requests nobody decided within ${plural(days, "day")} of being submitted are rejected automatically every night.`;
  const never = "Resignations are never rejected automatically.";
  return enabled ? `${rule} ${never}` : `Switched off: nothing is rejected automatically. When on: ${rule} ${never}`;
}

/** "2026-10-03" -> "3 Oct 2026" (a calendar day, never shifted by the browser's time zone). */
export function dayText(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

const INDIA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
const INDIA_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

/** The India day of an instant, as YYYY-MM-DD. */
export function indiaDay(when: Date | string): string {
  return INDIA_DAY.format(typeof when === "string" ? new Date(when) : when);
}

/** An instant as India time: "24 Nov 2026, 01:30". */
export function stampText(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${dayText(indiaDay(d))}, ${INDIA_TIME.format(d)}`;
}

/** YYYY-MM-DD plus `n` days. */
export function addDays(isoDay: string, n: number): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** The day of the nightly run that rejects a request submitted on `submittedDay` if nobody decides it: it has then waited
 * more than `days` days (day + days + 1). */
export function rejectedOnDay(submittedDay: string, days: number): string {
  return addDays(submittedDay, days + 1);
}

/** "Missing Punch 13 · Permission 2", in the order of the kinds list. */
export function countsText(byKind: Record<string, number>, kinds: AutoRejectKind[]): string {
  const label = new Map(kinds.map((k) => [k.key, k.label]));
  const order = kinds.map((k) => k.key);
  return Object.entries(byKind)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map(([k, n]) => `${label.get(k) ?? k} ${n}`)
    .join(" · ");
}

/** What a run did, in one line. */
export function runText(run: AutoRejectRunResult, kinds: AutoRejectKind[]): string {
  const who = run.trigger === "run_now" ? `Run now by ${run.runBy}` : "Nightly run";
  const what =
    run.rejected > 0
      ? `${plural(run.rejected, "request")} rejected (${countsText(run.byKind, kinds)})`
      : "nothing was due";
  const failed =
    run.failed > 0
      ? `; ${plural(run.failed, "request")} could not be rejected and ${run.failed === 1 ? "stays" : "stay"} waiting`
      : "";
  return `${who}, ${stampText(run.at)}: ${what}${failed}.`;
}
