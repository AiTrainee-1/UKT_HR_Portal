// Small pieces shared by the MD's own pages (HOD Approvals, Activity Logs, Recruitment, Reports): a pill switch, a side
// sheet for a record's details, and a labelled fact. Kept here (not in the kit) so these pages do not depend on files
// other parts of the portal are changing.
import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** A row of pills, one chosen (a radio group). Scrolls sideways inside itself on a phone. */
export function Pills<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  testId?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-full border border-md-ink/10 bg-white/60 p-1 shadow-sm backdrop-blur"
      data-testid={testId}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            data-testid={testId ? `${testId}-${o.value}` : undefined}
            className={cn(
              "min-h-8 whitespace-nowrap rounded-full px-3.5 text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-wine",
              active ? "bg-md-wine text-white shadow" : "text-md-ink-soft hover:bg-md-wine/[0.06] hover:text-md-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A record's details in a side sheet (full width on a phone); the page behind stays as it was. */
export function DetailsSheet({
  open,
  onClose,
  title,
  subtitle,
  testId,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="md-analytics-sheet w-full overflow-y-auto sm:max-w-lg" data-testid={testId}>
        <div className="space-y-4">
          <div className="pr-8">
            <SheetTitle className="text-lg font-black leading-tight text-md-ink">{title}</SheetTitle>
            <SheetDescription className={cn("mt-1 text-[13px] text-md-ink-soft", !subtitle && "sr-only")}>
              {subtitle ?? "Details"}
            </SheetDescription>
          </div>
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A label over its value, for a grid of facts. */
export function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <p className="text-[11px] font-bold uppercase tracking-wide text-md-ink-soft">{label}</p>
      <div className="mt-0.5 break-words text-[13px] font-semibold text-md-ink">{children}</div>
    </div>
  );
}

/** Small CSS columns for a few months (no chart library): each month a pair of bars, its label underneath. */
export function MonthColumns({
  months,
  first,
  second,
  testId,
  onPick,
  active,
}: {
  months: { month: string; label: string; a: number; b: number }[];
  first: string;
  second: string;
  testId?: string;
  onPick?: (month: string) => void;
  active?: string | null;
}) {
  const top = Math.max(1, ...months.flatMap((m) => [m.a, m.b]));
  return (
    <div data-testid={testId}>
      <div className="flex h-32 items-end gap-2 sm:gap-3">
        {months.map((m) => {
          const body = (
            <>
              <span className="flex h-24 w-full items-end justify-center gap-1">
                <span
                  className="w-1/2 max-w-4 rounded-t bg-md-wine"
                  style={{ height: `${Math.max(m.a ? 6 : 0, (m.a / top) * 100)}%` }}
                  title={`${first}: ${m.a}`}
                />
                <span
                  className="w-1/2 max-w-4 rounded-t bg-md-ink/35"
                  style={{ height: `${Math.max(m.b ? 6 : 0, (m.b / top) * 100)}%` }}
                  title={`${second}: ${m.b}`}
                />
              </span>
              <span
                className={cn(
                  "mt-1 block text-center text-[11px] font-semibold tabular-nums text-md-ink-soft",
                  active === m.month && "text-md-wine",
                )}
              >
                {m.label}
              </span>
            </>
          );
          return onPick ? (
            <button
              key={m.month}
              type="button"
              onClick={() => onPick(m.month)}
              aria-label={`${m.label}: ${first} ${m.a}, ${second} ${m.b}`}
              className={cn(
                "flex-1 rounded-lg px-0.5 hover:bg-md-wine/[0.05]",
                active === m.month && "bg-md-wine/[0.06]",
              )}
              data-testid={testId ? `${testId}-${m.month}` : undefined}
            >
              {body}
            </button>
          ) : (
            <div key={m.month} className="flex-1" aria-label={`${m.label}: ${first} ${m.a}, ${second} ${m.b}`}>
              {body}
            </div>
          );
        })}
      </div>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-semibold text-md-ink-soft">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-md-wine" /> {first}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-md-ink/35" /> {second}
        </span>
      </p>
    </div>
  );
}
