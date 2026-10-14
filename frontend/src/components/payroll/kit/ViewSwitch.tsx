import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

type IconType = ComponentType<{ size?: number; className?: string }>;

export type ViewOption<T extends string> = {
  value: T;
  label: string;
  icon?: IconType;
  /** The number beside the label (records, issues, skipped); undefined shows none, null shows a placeholder while it loads. */
  count?: number | null;
  /** The count's colour: "danger" / "warning" draw the eye to a view that has problems. */
  tone?: "default" | "warning" | "danger";
  testId?: string;
};

const ACTIVE_TEXT = { indigo: "text-indigo-700", amber: "text-amber-700" } as const;
const COUNT_TONE = {
  default: "bg-slate-200/80 text-slate-700",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-700",
} as const;

/**
 * The views of a payroll tab (Records | Issues | Skipped | Rules): a segmented control with a live count on each. Lighter
 * than PillTabs (no animation), so it can sit under the page's own tabs without competing with them.
 */
export function ViewSwitch<T extends string>({
  options,
  value,
  onChange,
  accent,
  ariaLabel = "Payroll views",
  className,
}: {
  options: ViewOption<T>[];
  value: T;
  onChange: (value: T) => void;
  accent: "indigo" | "amber";
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("inline-flex max-w-full gap-1 overflow-x-auto rounded-2xl bg-slate-100/80 p-1", className)}
      data-testid="view-switch"
    >
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              active ? cn("bg-white shadow-sm", ACTIVE_TEXT[accent]) : "text-slate-600 hover:bg-white/60",
            )}
            data-testid={o.testId ?? `view-${o.value}`}
          >
            {Icon && <Icon size={14} />}
            {o.label}
            {o.count === null ? (
              <span className="h-4 w-5 animate-pulse rounded-full bg-slate-200" aria-hidden="true" />
            ) : o.count !== undefined ? (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[11px] font-bold tabular-nums",
                  COUNT_TONE[o.count > 0 ? (o.tone ?? "default") : "default"],
                )}
                data-testid={`${o.testId ?? `view-${o.value}`}-count`}
              >
                {o.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
