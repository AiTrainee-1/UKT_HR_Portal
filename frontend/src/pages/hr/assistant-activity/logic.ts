// HR Assistant activity: the rules behind the page (pure, tested in logic.test.ts).

import type { HrActivityRow } from "@/lib/api-client/custom-hooks";

export const ACTION_LABEL: Record<string, string> = {
  create: "Added",
  update: "Changed",
  delete: "Deleted",
  approve: "Approved",
  reject: "Rejected",
  export: "Exported",
  login: "Signed in",
  logout: "Signed out",
  login_failed: "Sign-in failed",
};

export const ACTION_TONE: Record<string, string> = {
  approve: "border-emerald-200 bg-emerald-50 text-emerald-700",
  reject: "border-rose-200 bg-rose-50 text-rose-700",
  delete: "border-rose-200 bg-rose-50 text-rose-700",
  create: "border-blue-200 bg-blue-50 text-blue-700",
  update: "border-amber-200 bg-amber-50 text-amber-800",
  login: "border-slate-200 bg-slate-50 text-slate-600",
};

export const actionLabel = (action: string) => ACTION_LABEL[action] ?? action.replace(/_/g, " ");

/** The filters the page offers, as choices: every action an assistant's row can carry. */
export const ACTION_CHOICES = ["approve", "reject", "update", "create", "delete", "export", "login"];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A value written for people: text as is, numbers, yes/no, short lists; nested objects as compact JSON. */
export function showValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(showValue).join(", ");
  return JSON.stringify(v);
}

export type Change = { field: string; before: string | null; after: string };

/** "field: old -> new" lines for a row. A generic activity row keeps what was sent ({request: {...}}): those are the new
 *  values, with no "before". A row a view logged itself may have both. */
export function changesOf(row: Pick<HrActivityRow, "oldValues" | "newValues">): Change[] {
  const before = isPlainObject(row.oldValues) ? row.oldValues : {};
  let after: Record<string, unknown> = isPlainObject(row.newValues) ? row.newValues : {};
  if (isPlainObject(after.request) && Object.keys(after).length === 1) after = after.request;
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  return keys.map((field) => ({
    field,
    before: field in before ? showValue(before[field]) : null,
    after: field in after ? showValue(after[field]) : "—",
  }));
}

/** "10 Nov 2026, 14:05" in the viewer's clock, spelled out (Intl month names differ between browsers). */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const csvCell = (v: unknown) => {
  const text = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The rows on screen as a CSV file's text (Excel opens it). */
export function toCsv(rows: HrActivityRow[]): string {
  const header = ["When", "Username", "Name", "Action", "Module", "Record", "What", "Changes"];
  const lines = rows.map((r) =>
    [
      when(r.at),
      r.username ?? "",
      r.fullName ?? "",
      actionLabel(r.action),
      r.moduleLabel,
      r.recordId ?? "",
      r.description ?? "",
      changesOf(r)
        .map((c) => (c.before === null ? `${c.field}: ${c.after}` : `${c.field}: ${c.before} -> ${c.after}`))
        .join("; "),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}
