// Small pieces of the MD Settlement page: the page's one row of tabs, a dropdown, the leave chip, the decision chip, a
// segmented switch (the decision form's) and a labelled figure.
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { AlertOctagon, AlertTriangle, CalendarCheck, CalendarClock, ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { decisionKind, decisionText, finalKind, leaveChip, type DecisionKind, type LeaveTone } from "./logic";
import type { LeaveCheck, SettlementItem } from "./types";

// Own classes rather than md-chip + overrides: the skin's md-chip is unlayered CSS, which a Tailwind colour cannot beat.
const LEAVE_CLASS: Record<LeaveTone, string> = {
  critical: "border-md-danger-300 bg-md-danger-100 text-md-danger-800",
  // the owner's orange: the clay ramp (the ochre "warning" ramp reads yellow)
  warning: "border-md-clay-300 bg-md-clay-100 text-md-clay-800",
  ok: "border-md-ink/10 bg-white/70 text-md-ink-soft",
  unknown: "border-dashed border-md-ink/15 bg-white/40 text-md-ink-soft",
};
const LEAVE_ICON = { critical: AlertOctagon, warning: AlertTriangle, ok: CalendarCheck, unknown: CalendarClock };

/** The leave check of the 1st-20th as a chip whose words carry the meaning (the colour only repeats it); the full sentence
 *  is its tooltip and what a screen reader hears. */
export function LeaveChip({ check, className }: { check: LeaveCheck | null | undefined; className?: string }) {
  const info = leaveChip(check);
  const Icon = LEAVE_ICON[info.tone];
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold leading-normal",
        LEAVE_CLASS[info.tone],
        className,
      )}
      title={info.detail}
      data-testid="md-settlement-leave"
      data-tone={info.tone}
    >
      <Icon size={12} strokeWidth={2.4} aria-hidden="true" className="shrink-0" />
      <span aria-hidden="true" className="truncate">
        {info.label}
      </span>
      <span className="sr-only">{info.detail}</span>
    </span>
  );
}

const DECISION_CHIP: Record<DecisionKind, string> = {
  approved: "md-chip md-chip-success",
  reduced: "md-chip md-chip-sand",
  rejected: "md-chip md-chip-danger",
  undecided: "md-chip",
};

/** The MD's decision (or, with `final`, HR's final one) as a chip: "Approved ₹10,000", "Reduced ₹10,000 → ₹6,000". */
export function DecisionChip({ item, final = false }: { item: SettlementItem; final?: boolean }) {
  const kind = final ? finalKind(item) : decisionKind(item);
  const amount = final ? item.final.amount : item.md.amount;
  return (
    <span
      className={cn(DECISION_CHIP[kind], "max-w-full")}
      data-testid={final ? "md-settlement-final" : "md-settlement-decision"}
      data-kind={kind}
    >
      <span className="truncate">{decisionText(kind, item.requestedAmount, amount)}</span>
    </span>
  );
}

/** A frosted switch of a few options, one chosen (a radio group); scrolls sideways inside itself on a phone. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  testId?: string;
}) {
  return (
    <div className="max-w-full overflow-x-auto pb-0.5">
      <div role="radiogroup" aria-label={label} className="md-seg" data-testid={testId}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={cn("md-seg-item whitespace-nowrap text-xs", o.value === value && "is-active")}
            onClick={() => onChange(o.value)}
            data-testid={testId ? `${testId}-${o.value}` : undefined}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A small label over its figure. */
export function Figure({
  label,
  children,
  className,
  testId,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("min-w-0", className)} data-testid={testId}>
      <p className="text-[10.5px] font-bold uppercase tracking-wide text-md-ink-soft">{label}</p>
      <p className="mt-0.5 break-words text-[13px] font-semibold tabular-nums text-md-ink">{children}</p>
    </div>
  );
}

/** A quoted note with who wrote it ("Purpose", "HR's note", "Your remark"). */
export function Quote({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <p className="text-xs leading-relaxed text-md-ink-soft" data-testid={testId}>
      <span className="font-bold text-md-ink">{label}:</span> “{children}”
    </p>
  );
}

export type PageTab<T extends string> = { value: T; label: string; icon: LucideIcon; count?: number };

/**
 * The page's one row of tabs (owner 2026-11-27: one row of sub-tabs at the top, each section its own tab, nothing nested):
 * the MD portal's frosted track with the chosen tab a wine glass pill, like the Payroll page's views. Left / right arrows
 * move between the tabs. The panel it controls has the id `${idBase}-panel`.
 */
export function PageTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idBase,
}: {
  tabs: PageTab<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  idBase: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + tabs.length) % tabs.length;
    onChange(tabs[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div className="md-analytics-segs" data-testid="md-settlement-tabs">
      <div role="tablist" aria-label={label} className="md-seg md-shell-seg">
        {tabs.map((t, i) => {
          const on = t.value === value;
          return (
            <button
              key={t.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${idBase}-tab-${t.value}`}
              aria-selected={on}
              aria-controls={`${idBase}-panel`}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(t.value)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn("md-seg-item min-h-9 whitespace-nowrap px-3.5 text-[13px]", on && "md-money-seg-on")}
              data-testid={`md-settlement-tab-${t.value}`}
            >
              <t.icon size={14} strokeWidth={2.2} aria-hidden="true" className="shrink-0" />
              {t.label}
              {t.count !== undefined && <span className="md-analytics-seg-count">{t.count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A dropdown (the browser's own select: the phone's native picker) in the MD glass field look. `label` is read out, and
 *  shown before the field unless `hideLabel`. */
export function SelectField({
  label,
  value,
  options,
  onChange,
  hideLabel = false,
  className,
  testId,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  hideLabel?: boolean;
  className?: string;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "shrink-0 text-xs font-bold text-md-ink-soft"}>
        {label}
      </label>
      <div className="relative min-w-0 flex-1">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="md-field h-9 w-full min-w-0 cursor-pointer appearance-none truncate pl-3 pr-8 text-xs font-semibold"
          data-testid={testId}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-md-ink-soft"
        />
      </div>
    </div>
  );
}
