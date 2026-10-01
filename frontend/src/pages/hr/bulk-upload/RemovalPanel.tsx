import { AlertTriangle, Archive, EyeOff, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { removalSummary } from "./logic";
import type { ListStatus, MissingEmployee, RemovalAction } from "./types";

type Props = {
  missing: MissingEmployee[];
  inFile: number | null;
  total: number;
  status: ListStatus;
  kindLabel: string;
  fallback: RemovalAction;
  overrides: Record<string, RemovalAction>;
  onFallback: (a: RemovalAction) => void;
  onOverride: (code: string, a: RemovalAction) => void;
  onResetOverrides: () => void;
};

const OPTIONS: {
  key: RemovalAction;
  title: string;
  text: string;
  icon: typeof Archive;
  tone: string;
  active: string;
}[] = [
  {
    key: "keep",
    title: "Leave them as they are",
    text: "Nothing happens to them. The safe choice when the file is only part of the list.",
    icon: EyeOff,
    tone: "text-gray-700",
    active: "border-gray-900 bg-gray-50 ring-1 ring-gray-900",
  },
  {
    key: "inactive",
    title: "Make them Inactive",
    text: "They leave the active list but all their history stays, and you can make them active again.",
    icon: Archive,
    tone: "text-amber-700",
    active: "border-amber-500 bg-amber-50 ring-1 ring-amber-500",
  },
  {
    key: "delete",
    title: "Delete them and their data",
    text: "Removes the employee with their attendance, payroll and leave records for good. This cannot be undone.",
    icon: Trash2,
    tone: "text-red-700",
    active: "border-red-500 bg-red-50 ring-1 ring-red-500",
  },
];

export default function RemovalPanel({
  missing,
  inFile,
  total,
  status,
  kindLabel,
  fallback,
  overrides,
  onFallback,
  onOverride,
  onResetOverrides,
}: Props) {
  const options = OPTIONS.filter((o) => status === "active" || o.key !== "inactive");
  const summary = removalSummary(missing, fallback, overrides);
  const overridden = Object.keys(overrides).length;
  const mostlyMissing = total > 0 && missing.length / total >= 0.5;

  return (
    <div className="space-y-4 rounded-xl border-2 border-amber-300 bg-amber-50/40 p-4" data-testid="removal-panel">
      <div className="flex items-start gap-3">
        <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-600" />
        <div>
          <p className="text-sm font-black text-gray-900" data-testid="removal-title">
            {missing.length} {kindLabel} employee{missing.length === 1 ? " is" : "s are"} not in your file
          </p>
          <p className="mt-0.5 text-xs text-gray-600">
            The file has {inFile ?? total - missing.length} of the {total} employees in this list. Nothing is removed
            unless you choose it here: tell us what to do with the {missing.length === 1 ? "one" : "rest"} that
            {missing.length === 1 ? " is" : " are"} missing.
          </p>
        </div>
      </div>

      {mostlyMissing && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">
          Most of the list is missing from this file. Check you uploaded the right, complete file before removing
          anyone.
        </p>
      )}

      <div
        className="grid gap-2 sm:grid-cols-3"
        role="radiogroup"
        aria-label="What to do with the employees who are not in the file"
      >
        {options.map((o) => {
          const Icon = o.icon;
          const on = fallback === o.key;
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`removal-${o.key}`}
              onClick={() => onFallback(o.key)}
              className={cn(
                "rounded-xl border bg-white p-3 text-left transition-colors hover:bg-gray-50",
                on ? o.active : "border-gray-200",
              )}
            >
              <p className={cn("flex items-center gap-1.5 text-sm font-bold", o.tone)}>
                <Icon size={15} /> {o.title}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-gray-600">{o.text}</p>
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
          <p className="text-xs font-semibold text-gray-700">Decide one by one if you need to</p>
          {overridden > 0 && (
            <button
              type="button"
              className="text-xs font-semibold text-blue-700 hover:underline"
              onClick={onResetOverrides}
            >
              Use the choice above for everyone
            </button>
          )}
        </div>
        <div className="max-h-72 divide-y overflow-y-auto">
          {missing.map((m) => {
            const action = overrides[m.code] ?? fallback;
            const d = m.dataCounts;
            return (
              <div
                key={m.code}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
                data-testid={`missing-${m.code}`}
              >
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate text-sm font-semibold text-gray-900">
                    {m.code} <span className="font-normal text-gray-600">{m.name}</span>
                  </p>
                  <p className="truncate text-[11px] text-gray-500">
                    {[m.department, m.designation, m.branch].filter(Boolean).join(" · ") || "No department"}
                    {" · "}
                    {d.attendance} attendance, {d.payroll} payroll, {d.leaves} leave record{d.leaves === 1 ? "" : "s"}
                  </p>
                </div>
                <select
                  value={action}
                  onChange={(e) => onOverride(m.code, e.target.value as RemovalAction)}
                  aria-label={`What to do with ${m.code}`}
                  className={cn(
                    "h-8 rounded-md border px-2 text-xs font-semibold",
                    action === "delete"
                      ? "border-red-300 bg-red-50 text-red-700"
                      : action === "inactive"
                        ? "border-amber-300 bg-amber-50 text-amber-800"
                        : "bg-white text-gray-700",
                  )}
                >
                  <option value="keep">Leave as is</option>
                  {status === "active" && <option value="inactive">Make Inactive</option>}
                  <option value="delete">Delete with data</option>
                </select>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-gray-700" data-testid="removal-summary">
        <span className="font-bold">If you apply:</span> {summary.keep} left as they are
        {status === "active" ? `, ${summary.inactive} made Inactive` : ""}, {summary.delete} deleted
        {summary.delete > 0 && (
          <span className="font-semibold text-red-700">
            {" "}
            (with {summary.deleteData.attendance} attendance, {summary.deleteData.payroll} payroll and{" "}
            {summary.deleteData.leaves} leave records)
          </span>
        )}
        .
      </p>
    </div>
  );
}
