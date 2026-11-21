import type { ReactNode } from "react";
import { AlertCircle, HardHat, SearchX, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { FactoryPayrollCategory } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Chip } from "../account-management/parts";
import { CATEGORY_LABEL, chipStyle, type EmptyInfo } from "./logic";

export { LoadError } from "../org-structure/parts";
export { Lines, StatButton } from "../production-employees/parts";

/** The colours of the two payroll categories, the same as the rest of the portal (Staff blue, Production amber). */
export const CATEGORY_CHIP: Record<FactoryPayrollCategory, string> = {
  staff: "border-blue-200 bg-blue-50 text-blue-800",
  production: "border-amber-200 bg-amber-50 text-amber-800",
};

export const AMBER_CHIP = "border-amber-200 bg-amber-50 text-amber-800";
export const GREEN_CHIP = "border-emerald-200 bg-emerald-50 text-emerald-800";
export const GREY_CHIP = "border-gray-200 bg-gray-50 text-gray-600";

/** A label in its own colour; "No label" in grey. */
export function LabelChip({ name, color, testId }: { name: string | null; color: string | null; testId?: string }) {
  if (!name) {
    return (
      <span className="inline-flex" data-testid={testId}>
        <Chip className={GREY_CHIP}>No label</Chip>
      </span>
    );
  }
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] font-semibold"
      style={chipStyle(color)}
      data-testid={testId}
    >
      <Tag size={10} className="shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function CategoryChip({ category }: { category: FactoryPayrollCategory }) {
  return <Chip className={CATEGORY_CHIP[category]}>{CATEGORY_LABEL[category]}</Chip>;
}

/** A form field: its label, the control, and the problem (red) or the hint under it. */
export function Field({
  label,
  htmlFor,
  required,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-semibold text-gray-800">
        {label} {required && <span className="text-red-600">*</span>}
      </label>
      {children}
      {error ? (
        <p className="flex items-start gap-1 text-xs font-medium text-red-600" role="alert">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** The plain <select> of the forms (works the same on a phone and in a dialog). */
export const SELECT_CLASS =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

/** A titled block of a form. */
export function FormSection({
  title,
  hint,
  children,
  testId,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="space-y-3 rounded-2xl border bg-white p-4" data-testid={testId}>
      <div>
        <h3 className="text-sm font-bold text-gray-900">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** Two choices as cards (the payroll category). */
export function ChoiceCards<T extends string>({
  value,
  options,
  onChange,
  testId,
  disabled,
}: {
  value: T;
  options: { value: T; label: string; sub: string }[];
  onChange: (v: T) => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          data-testid={`${testId}-${o.value}`}
          className={cn(
            "rounded-xl border p-3 text-left transition-all disabled:cursor-not-allowed",
            value === o.value
              ? "border-primary bg-primary/5 ring-1 ring-primary/30"
              : "border-gray-200 bg-white hover:border-gray-300",
          )}
        >
          <span className="block text-sm font-semibold text-gray-900">{o.label}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{o.sub}</span>
        </button>
      ))}
    </div>
  );
}

/** The list while the first load is in flight. */
export function ListSkeleton() {
  return (
    <div className="space-y-3 rounded-2xl border bg-white p-4" data-testid="fe-loading">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="hidden h-5 w-20 rounded-full sm:block" />
          <Skeleton className="hidden h-8 w-24 rounded-xl sm:block" />
        </div>
      ))}
    </div>
  );
}

/** Why the list is empty, with the way on. */
export function EmptyState({
  info,
  onClear,
  onAllLabels,
  addButtons,
}: {
  info: EmptyInfo;
  onClear: () => void;
  onAllLabels: () => void;
  /** The New / Add existing buttons, for an empty page. */
  addButtons?: ReactNode;
}) {
  const filtered = info.action === "clear";
  return (
    <Card className="rounded-2xl">
      <CardContent className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="fe-empty">
        <div className={cn("rounded-2xl p-4", filtered ? "bg-gray-100 text-gray-500" : "bg-teal-50 text-teal-700")}>
          {filtered ? <SearchX size={26} /> : <HardHat size={26} />}
        </div>
        <div>
          <p className="font-bold text-gray-900">{info.title}</p>
          <p className="mt-0.5 max-w-md text-sm text-muted-foreground">{info.hint}</p>
        </div>
        {info.action === "clear" && (
          <Button variant="outline" onClick={onClear}>
            Clear filters
          </Button>
        )}
        {info.action === "all-labels" && (
          <Button variant="outline" onClick={onAllLabels}>
            Show all labels
          </Button>
        )}
        {info.action === "add" && addButtons}
      </CardContent>
    </Card>
  );
}

/** A small "why you can't" note for a part of the page this login can only look at. */
export function ViewOnlyNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="rounded-xl bg-gray-50 px-3 py-2 text-xs text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
}
