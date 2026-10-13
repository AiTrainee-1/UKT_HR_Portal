import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** A number or time box with its unit after it and, when the value is wrong, the reason under it. */
export function UnitInput({
  id,
  value,
  onChange,
  unit,
  type = "number",
  step,
  min,
  max,
  disabled,
  invalid,
  error,
  errorTestId,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  unit?: string;
  type?: "number" | "time";
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Mark the box red without a message of its own (the message is shown elsewhere). */
  invalid?: boolean;
  error?: string;
  errorTestId?: string;
}) {
  const bad = invalid || !!error;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type={type}
          inputMode={type === "number" ? "decimal" : undefined}
          step={step}
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-invalid={bad}
          className={cn("max-w-[150px]", bad && "border-red-400 focus-visible:ring-red-300")}
        />
        {unit && <span className="text-xs font-semibold text-gray-500">{unit}</span>}
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-red-600" data-testid={errorTestId}>
          {error}
        </p>
      )}
    </div>
  );
}
