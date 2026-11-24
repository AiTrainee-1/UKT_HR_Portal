// The small inputs of the Edit Attendance options added on 2026-11-24, shared by the payroll details day panel
// (DayAttendanceEdit) and the Attendance Edit page: the Payroll Done lock, Leave's part of the day and Missing Punch's time.
// What they say comes from edit-options.ts; the server decides what can be chosen.

import { Clock3, Lock } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { AttendanceEditItem } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { GROUP_LOOK, itemPortions } from "./edit-options";

/** The day's payroll is finalized (Payroll Done): nothing of it can be proposed. */
export function LockedBanner({ message, testId }: { message: string; testId: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-indigo-950"
      data-testid={testId}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-indigo-600 ring-1 ring-indigo-200">
        <Lock size={14} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-bold">Payroll finalized: this day cannot be changed</p>
        <p className="mt-0.5 text-xs leading-relaxed text-indigo-900">{message}</p>
      </div>
    </div>
  );
}

/** Leave: Full day / First half / Second half. A part the server refuses is greyed out, and why is said under it. */
export function PortionPicker({
  item,
  value,
  onChange,
  testIdPrefix,
}: {
  item: Pick<AttendanceEditItem, "portions">;
  value: string | null;
  onChange: (portion: string) => void;
  /** "pd-edit" on the payroll details panel, "edit" on the Attendance Edit page. */
  testIdPrefix: string;
}) {
  const portions = itemPortions(item);
  if (portions.length === 0) return null;
  const chosen = portions.find((p) => p.value === value);
  const refused = portions.filter((p) => !p.available && p.unavailableReason);
  return (
    <div data-testid={`${testIdPrefix}-portion`}>
      <p className="mb-1.5 text-sm font-semibold text-slate-800">Which part of the day?</p>
      <div
        className="inline-flex flex-wrap rounded-xl bg-white p-1 ring-1 ring-slate-200"
        role="group"
        aria-label="Part of the day"
      >
        {portions.map((p) => {
          const off = !p.available;
          const on = value === p.value;
          return (
            <button
              key={p.value}
              type="button"
              aria-pressed={on}
              disabled={off}
              title={off ? (p.unavailableReason ?? undefined) : p.description}
              aria-description={off ? (p.unavailableReason ?? undefined) : undefined}
              data-available={off ? "false" : "true"}
              data-testid={`${testIdPrefix}-portion-${p.value}`}
              onClick={() => onChange(p.value)}
              className={cn(
                "rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors",
                off
                  ? "cursor-not-allowed text-slate-300"
                  : on
                    ? cn(GROUP_LOOK.leave.solid, "shadow-sm")
                    : "text-slate-600 hover:bg-slate-100",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {chosen && (
        <p className="mt-1.5 text-xs text-slate-500" data-testid={`${testIdPrefix}-portion-note`}>
          {chosen.description}
        </p>
      )}
      {refused.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[11px] leading-snug text-slate-500">
          {refused.map((p) => (
            <li key={p.value} data-testid={`${testIdPrefix}-portion-${p.value}-reason`}>
              <span className="font-semibold text-slate-600">{p.label}:</span> {p.unavailableReason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Missing Punch: the time of the punch the device missed (required). */
export function PunchTimeField({
  value,
  onChange,
  testId,
}: {
  value: string;
  onChange: (time: string) => void;
  testId: string;
}) {
  return (
    <label className="block max-w-[16rem]">
      <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
        <Clock3 size={14} className="text-slate-400" /> Punch time
        <span className="font-normal text-slate-400">(required)</span>
      </span>
      <Input
        type="time"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-white"
        data-testid={testId}
      />
    </label>
  );
}
