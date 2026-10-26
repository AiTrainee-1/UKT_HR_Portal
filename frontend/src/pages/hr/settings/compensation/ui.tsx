import type { FocusEvent, ReactNode } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { dateNote, type CompensationDraft, type Validation } from "./form";

/** What every section of the tab needs: the form, how to change it, and what is wrong with it. */
export type SectionProps = {
  draft: CompensationDraft;
  patch: (change: Partial<CompensationDraft>) => void;
  /** View-only role: every control is disabled. */
  readOnly: boolean;
  /** The master switch (Staff Payroll -> OT / Compensation): while it is off nothing here acts. */
  masterOn: boolean;
  validation: Validation;
  /** Today in India, YYYY-MM-DD. */
  today: string;
};

/**
 * True when a box was left for something outside its table row. The tables re-order their rows when a box is left; moving
 * between the boxes of one row must not shuffle that row away under the cursor.
 */
export function leavesRow(event: FocusEvent<HTMLElement>): boolean {
  const next = event.relatedTarget;
  return !(next instanceof Node && event.currentTarget.closest("tr")?.contains(next));
}

/** A problem with a value, in red, under it. */
export function Problem({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p role="alert" className="text-xs font-medium text-red-600" data-testid={testId}>
      {children}
    </p>
  );
}

/** The amber line under a switch that says the master switch is off, so the feature does nothing yet. */
export function masterOffNote(masterOn: boolean): string | null {
  return masterOn
    ? null
    : "The master switch (Staff Payroll -> OT / Compensation) is off, so this does nothing until it is turned on.";
}

/** Two or three notes for one SettingBlock `note`. */
export function notes(...items: (ReactNode | null | false | undefined)[]): ReactNode {
  const shown = items.filter((n): n is ReactNode => n !== null && n !== undefined && n !== false);
  if (shown.length === 0) return undefined;
  return (
    <div className="space-y-1">
      {shown.map((n, i) => (
        <p key={i}>{n}</p>
      ))}
    </div>
  );
}

/**
 * The "applies from" date of a feature: a date box, a button for today, and what the chosen date means (nothing before it
 * is ever changed; a date in the past is warned about).
 */
export function FromDate({
  id,
  value,
  onChange,
  error,
  today,
  readOnly,
  testId,
  blankText,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  error: string | null;
  today: string;
  readOnly: boolean;
  testId: string;
  /** What a blank box means ("the day you switch it on"). */
  blankText: string;
}) {
  const note = dateNote(value, today);
  return (
    <div className="space-y-2" data-testid={testId}>
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
          data-testid={`${testId}-today`}
        >
          Use today
        </Button>
      </div>
      {value === "" && !error && <p className="text-xs text-gray-500">{blankText}</p>}
      {error && <Problem testId={`${testId}-error`}>{error}</Problem>}
      {note.kind !== "none" && (
        <p
          data-testid={`${testId}-note`}
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
