import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * A labelled control inside a SettingBlock: the label, the control, an optional unit after it, and one line of help or of
 * error under it. Use it when a block holds several controls (a setting made of a number and a switch); a block with a
 * single control can label it with `SettingBlock labelFor` instead.
 */
export function Field({
  label,
  htmlFor,
  unit,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  /** Shown after the control: "minutes", "%", "₹". */
  unit?: string;
  hint?: ReactNode;
  /** A problem with the value: replaces the hint and turns it red. */
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs font-semibold text-gray-700">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        {unit && <span className="shrink-0 text-xs font-semibold text-gray-500">{unit}</span>}
      </div>
      {error ? (
        <p role="alert" className="text-xs font-medium text-red-600">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs leading-snug text-gray-500">{hint}</p>
      )}
    </div>
  );
}

/** A switch with its words beside it, for an on/off setting. */
export function ToggleField({
  id,
  checked,
  onChange,
  onLabel,
  offLabel,
  disabled,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  /** What the switch says while on ("Late marks are counted"). */
  onLabel: string;
  offLabel: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={checked ? onLabel : offLabel}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "settings-switch relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-emerald-500" : "bg-gray-300",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
            checked ? "left-[22px]" : "left-0.5",
          )}
        />
      </button>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gray-900">{checked ? onLabel : offLabel}</p>
        {children && <div className="mt-0.5 text-xs leading-snug text-gray-500">{children}</div>}
      </div>
    </div>
  );
}
