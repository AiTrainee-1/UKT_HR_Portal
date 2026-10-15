import type { FocusEvent, ReactNode } from "react";
import { Info, Power } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { prettyDate } from "../compensation/form";
import { Problem } from "../compensation/ui";
import { dateNote, type ShiftRulesDraft, type Validation } from "./form";

export { Problem };

/** What every section of the tab needs: the form, how to change it, and what is wrong with it. */
export type SectionProps = {
  draft: ShiftRulesDraft;
  patch: (change: Partial<ShiftRulesDraft>) => void;
  /** View-only role, or a branch login: every control is disabled. */
  readOnly: boolean;
  validation: Validation;
  /** Today in India, YYYY-MM-DD. */
  today: string;
};

/**
 * True when a box was left for something outside its row. The tables put their rows in time order when a box is left;
 * moving between the boxes of one row must not shuffle that row away under the cursor.
 */
export function leavesRow(event: FocusEvent<HTMLElement>): boolean {
  const next = event.relatedTarget;
  return !(next instanceof Node && event.currentTarget.closest("[data-row]")?.contains(next));
}

/** A small caption above a box in a row: seen on a phone, where the column headings are not there. */
export function Caption({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="mb-1 block text-[11px] font-semibold text-slate-500 xl:hidden">
      {children}
    </span>
  );
}

/** A heading of a row's columns, seen only where the rows are laid out as a table. */
export function ColumnHeading({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-xs font-semibold text-slate-600", className)}>{children}</span>;
}

/**
 * The top of the tab: whether the rules are in force and from when, and that they are for production only. A read-only
 * strip: the switch and the date are the first settings below it.
 */
export function RulesStrip({ enabled, from, today }: { enabled: boolean; from: string | null; today: string }) {
  const future = enabled && !!from && from > today;
  const state = !enabled ? "off" : future ? "future" : "on";
  const when = from ? prettyDate(from) : "";
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-x-4 gap-y-2 rounded-xl border px-4 py-3",
        state === "off" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white",
      )}
      data-testid="production-rules-strip"
      data-state={state}
    >
      <span
        className={cn(
          "mt-0.5 rounded-lg p-2",
          state === "off" ? "bg-amber-100 text-amber-800" : "bg-emerald-50 text-emerald-700",
        )}
      >
        <Power size={16} />
      </span>
      <div className="min-w-0 flex-1 basis-48 space-y-1">
        <p className="text-sm font-semibold text-slate-900" data-testid="production-rules-status">
          {state === "off"
            ? "The production shift rules are OFF"
            : state === "future"
              ? `The production shift rules start on ${when}`
              : `The production shift rules are ON${when ? ` from ${when}` : ""}`}
        </p>
        <p className="text-[13px] leading-snug text-slate-600">
          {state === "off"
            ? "Every production day uses the old calculation. Everything below can still be edited and saved, but none of it acts until the switch is turned on. "
            : state === "future"
              ? "Until then every production day keeps the old calculation. "
              : "A production worker's shifts earned come from the groups, ladders and breaks below, for every day from the start date. Earlier days keep the old calculation, so nothing already paid is judged again. "}
          Pay is the shifts earned times the worker's salary per shift:{" "}
          <Link href="/hr/production-payroll" className="font-semibold text-blue-700 hover:underline">
            Production Payroll
          </Link>
          .
        </p>
      </div>
      <span
        className="settings-chip shrink-0 self-center px-2.5 py-1 text-[11px] font-semibold text-slate-700"
        data-testid="production-only"
        title="Staff employees are never affected by anything on this tab."
      >
        Production employees only
      </span>
    </div>
  );
}

/**
 * The "applies from" date: a date box, a button for today, and what the chosen date means (every earlier day keeps the old
 * calculation; a date in the past is warned about, never blocked).
 */
export function FromDate({
  id,
  value,
  onChange,
  error,
  today,
  readOnly,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  error: string | null;
  today: string;
  readOnly: boolean;
}) {
  const note = dateNote(value, today);
  return (
    <div className="space-y-2" data-testid="rules-from">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          type="date"
          value={value}
          disabled={readOnly}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          className={cn("w-44", error && "border-red-400")}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={readOnly || value === today}
          onClick={() => onChange(today)}
          data-testid="rules-from-today"
        >
          Use today
        </Button>
      </div>
      {error && <Problem testId="rules-from-error">{error}</Problem>}
      {note.kind !== "none" && (
        <p
          data-testid="rules-from-note"
          data-kind={note.kind}
          className={cn(
            "flex items-start gap-1.5 rounded-lg px-2.5 py-2 text-xs leading-snug",
            note.kind === "past" ? "bg-amber-50 text-amber-900 ring-1 ring-amber-200" : "bg-slate-50 text-slate-600",
          )}
        >
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>{note.text}</span>
        </p>
      )}
    </div>
  );
}
