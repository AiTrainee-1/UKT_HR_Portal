import { useCallback, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { AlertTriangle, Info, PauseCircle } from "lucide-react";
import { paginateRows, type RowPage } from "@/components/payroll/panels/issues/lists";
import { DataPagination } from "@/components/ui/DataPagination";
import { Chip } from "@/components/payroll/kit/parts";
import type { ShiftsValue } from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { SHIFT_CHOICES, compensationSettingsHref, fmtShifts } from "./logic";

// The few small pieces every tab of the Compensation page shares: the notice for a feature that is switched off, the
// shifts picker, a labelled field, the paged list.

type Accent = "amber" | "blue" | "red" | "slate";

const NOTICE: Record<Accent, { box: string; icon: string }> = {
  amber: { box: "border-amber-200 bg-amber-50 text-amber-900", icon: "text-amber-600" },
  blue: { box: "border-sky-200 bg-sky-50 text-sky-900", icon: "text-sky-600" },
  red: { box: "border-red-200 bg-red-50 text-red-900", icon: "text-red-600" },
  slate: { box: "border-slate-200 bg-slate-50 text-slate-700", icon: "text-slate-500" },
};

/** A line of information, a warning or an error above a list or a form. */
export function Notice({
  accent = "blue",
  icon: Icon = Info,
  children,
  testId,
  role = "status",
  className,
}: {
  accent?: Accent;
  icon?: typeof Info;
  children: ReactNode;
  testId?: string;
  role?: "status" | "alert";
  className?: string;
}) {
  const tone = NOTICE[accent];
  return (
    <div
      className={cn("flex items-start gap-2.5 rounded-xl border p-3.5 text-xs", tone.box, className)}
      role={role}
      data-testid={testId}
    >
      <Icon size={16} className={cn("mt-0.5 shrink-0", tone.icon)} />
      <div className="min-w-0 flex-1 space-y-1 leading-relaxed">{children}</div>
    </div>
  );
}

/**
 * "This feature is switched off in Settings -> Compensation": what is paused, what stays readable, and a link to the very
 * switch. Everything on the page stays readable; only changes are paused.
 */
export function SwitchOffNotice({
  testId,
  title,
  setting,
  children,
}: {
  testId: string;
  title: string;
  /** The `data-setting-id` of the switch on the Settings -> Compensation tab. */
  setting: string;
  children: ReactNode;
}) {
  return (
    <Notice accent="amber" icon={PauseCircle} testId={testId}>
      <p>
        <strong>{title}</strong> {children} Switch it on in{" "}
        <Link href={compensationSettingsHref(setting)} className="font-semibold underline">
          Settings → Compensation
        </Link>
        . Nothing is deleted while it is off.
      </p>
    </Notice>
  );
}

/** A request that failed, with the server's sentence. */
export function ErrorNotice({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <Notice accent="red" icon={AlertTriangle} role="alert" testId={testId}>
      <p>{children}</p>
    </Notice>
  );
}

/** A label, the control, and a hint or a problem under it. */
export function Field({
  label,
  htmlFor,
  hint,
  problem,
  children,
  className,
  testId,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  problem?: string | null;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)} data-testid={testId}>
      <label htmlFor={htmlFor} className="text-xs font-semibold text-slate-700">
        {label}
      </label>
      {children}
      {problem ? (
        <p role="alert" className="text-xs font-medium text-red-600">
          {problem}
        </p>
      ) : (
        hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/**
 * 0.25 / 0.50 / 0.75 / 1 as four buttons that act as one radio group. `max` greys out what is more than the employee has
 * (the balance); `suggested` is marked with a dot and says so in its name, so the suggestion is never colour alone.
 */
export function ShiftsPicker({
  value,
  onChange,
  label,
  suggested,
  max,
  disabled,
  testId,
  className,
}: {
  value: ShiftsValue | null;
  onChange: (value: ShiftsValue) => void;
  /** What the group is for, read out by a screen reader: "Shifts for Asha Kumar". */
  label: string;
  suggested?: number | null;
  max?: number;
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex flex-wrap gap-1", className)}
      data-testid={testId}
    >
      {SHIFT_CHOICES.map((choice) => {
        const tooMuch = max !== undefined && choice > max + 1e-9;
        const on = value === choice;
        const isSuggested = suggested === choice;
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${fmtShifts(choice)} ${choice === 1 ? "shift" : "shifts"}${isSuggested ? ", suggested" : ""}`}
            disabled={disabled || tooMuch}
            title={
              tooMuch ? `More than the balance (${fmtShifts(max)})` : isSuggested ? "Suggested by the rules" : undefined
            }
            onClick={() => onChange(choice)}
            data-testid={testId ? `${testId}-${choice}` : undefined}
            className={cn(
              "inline-flex h-8 min-w-12 items-center justify-center gap-1 rounded-lg border px-2.5 text-xs font-bold tabular-nums transition-colors",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
              on
                ? "border-indigo-600 bg-indigo-600 text-white"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
            )}
          >
            {fmtShifts(choice)}
            {isSuggested && (
              <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-white" : "bg-indigo-500")} />
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Runs an async action one at a time: a second call while the first is still on its way does nothing. A double click on
 * Redeem must not take the shifts twice, and the button's own `disabled` only follows after React has drawn again.
 */
export function useSingleFlight() {
  const busy = useRef(false);
  return useCallback(async <T,>(run: () => Promise<T>): Promise<T | undefined> => {
    if (busy.current) return undefined;
    busy.current = true;
    try {
      return await run();
    } finally {
      busy.current = false;
    }
  }, []);
}

/** A name over its code and department: the first cell of nearly every list. */
export function PersonCell({
  name,
  code,
  department,
}: {
  name: string;
  code?: string | null;
  department?: string | null;
}) {
  return (
    <div className="min-w-0">
      <p className="font-semibold text-gray-900">{name}</p>
      <p className="text-[11px] text-muted-foreground">
        {code && <span className="font-mono">{code}</span>}
        {code && department ? " · " : ""}
        {department}
      </p>
    </div>
  );
}

/** A chip with its meaning in words (the colour only helps). */
export function StatusChip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <Chip tone={tone} title={title}>
      {children}
    </Chip>
  );
}

export const TABLE_HEAD = "bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500";
export const CELL = "px-3 py-3 align-top";

/** A list shown 25 rows at a time; the page number belongs to the filters it was chosen under (`viewKey`). */
export function usePaged<T>(rows: T[], viewKey: string, size = 25): RowPage<T> & { setPage: (page: number) => void } {
  const [state, setState] = useState({ key: viewKey, page: 1 });
  const page = paginateRows(rows, state.key === viewKey ? state.page : 1, size);
  return { ...page, setPage: (next: number) => setState({ key: viewKey, page: next }) };
}

export function Pager({
  paged,
  size = 25,
}: {
  paged: RowPage<unknown> & { setPage: (page: number) => void };
  size?: number;
}) {
  return (
    <div className="px-3">
      <DataPagination
        page={paged.page}
        totalPages={paged.totalPages}
        totalItems={paged.total}
        pageSize={size}
        onPageChange={paged.setPage}
      />
    </div>
  );
}
