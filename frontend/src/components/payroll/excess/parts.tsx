import { useId, type ReactNode } from "react";
import { Lock, MinusCircle, PlusCircle } from "lucide-react";
import type { PayAccent } from "@/components/payroll/kit/accent-ui";
import { ACCENT_UI } from "@/components/payroll/kit/accent-ui";
import { Chip } from "@/components/payroll/kit/parts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ExcessAction, ExcessKind, ExcessSource, PayrollKind } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  ACTION_LABEL,
  ACTION_TONE,
  KIND_HINT,
  KIND_LABEL,
  KIND_TONE,
  REMARK_MAX,
  SOURCE_HINT,
  SOURCE_LABEL,
  remarkCounter,
  rowStateMeta,
  type RowState,
} from "./logic";

// The small pieces of the Excess tab: the chips, the Excess / Detection choice and the amount and remark fields the three
// dialogs share.

/**
 * The server's own sentence from an error: the `{"error": "..."}` body when there is one, else the message without its
 * "HTTP 409 Conflict: " prefix.
 */
export function errorText(err: unknown): string | undefined {
  const body = (err as { data?: unknown } | null | undefined)?.data;
  if (body && typeof body === "object") {
    const sentence = (body as { error?: unknown }).error;
    if (typeof sentence === "string" && sentence.trim()) return sentence.trim();
  }
  return err instanceof Error ? err.message.replace(/^HTTP \d+[^:]*:\s*/, "") : undefined;
}

export function KindChip({ kind, className }: { kind: ExcessKind; className?: string }) {
  return (
    <Chip
      tone={KIND_TONE[kind]}
      icon={kind === "excess" ? PlusCircle : MinusCircle}
      title={KIND_HINT[kind]}
      className={className}
    >
      {KIND_LABEL[kind]}
    </Chip>
  );
}

export function ActionChip({ action }: { action: ExcessAction }) {
  return <Chip tone={ACTION_TONE[action]}>{ACTION_LABEL[action]}</Chip>;
}

export function SourceChip({ source }: { source: ExcessSource }) {
  if (source === "manual") return null;
  return (
    <Chip tone={source === "migrated" ? "accent" : "info"} title={SOURCE_HINT[source]}>
      {SOURCE_LABEL[source]}
    </Chip>
  );
}

export function RowStateChip({ state, kind = "staff" }: { state: RowState; kind?: PayrollKind }) {
  const meta = rowStateMeta(state, kind);
  return (
    <Chip tone={meta.tone} title={meta.hint}>
      {meta.label}
    </Chip>
  );
}

/** A coloured amount: green for what is added, red for what is taken off, the page's accent for a positive net. */
export function Money({
  value,
  kind,
  accent = "indigo",
  className,
  children,
}: {
  value: number;
  kind?: ExcessKind | "net";
  accent?: PayAccent;
  className?: string;
  children: ReactNode;
}) {
  const tone =
    value === 0
      ? "text-slate-400"
      : kind === "excess"
        ? "text-emerald-700"
        : kind === "detection"
          ? "text-rose-700"
          : value > 0
            ? ACCENT_UI[accent].netText
            : "text-rose-700";
  return <span className={cn("font-semibold tabular-nums", tone, className)}>{children}</span>;
}

/** The Excess / Detection choice: two big, explained options (a radio group). */
export function KindSegment({
  value,
  onChange,
  disabled,
  accent = "indigo",
}: {
  value: ExcessKind;
  onChange: (kind: ExcessKind) => void;
  disabled?: boolean;
  accent?: PayAccent;
}) {
  const options: { kind: ExcessKind; icon: typeof PlusCircle; on: string }[] = [
    {
      kind: "excess",
      icon: PlusCircle,
      on: "border-emerald-300 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-200",
    },
    { kind: "detection", icon: MinusCircle, on: "border-rose-300 bg-rose-50 text-rose-900 ring-2 ring-rose-200" },
  ];
  return (
    <div role="radiogroup" aria-label="Type" className="grid grid-cols-2 gap-2" data-testid="excess-kind">
      {options.map(({ kind, icon: Icon, on }) => {
        const active = value === kind;
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(kind)}
            className={cn(
              "flex min-w-0 items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60",
              ACCENT_UI[accent].ring,
              active ? on : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
            )}
            data-testid={`excess-kind-${kind}`}
          >
            <Icon size={16} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm font-bold">{KIND_LABEL[kind]}</span>
              <span className="block text-[11px] leading-snug opacity-75">{KIND_HINT[kind]}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The amount in rupees. */
export function AmountField({
  value,
  onChange,
  error,
  label = "Amount (₹)",
  hint,
  testId = "excess-amount",
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Shown once the field was touched (or a save was tried). */
  error: string | null;
  label?: string;
  hint?: ReactNode;
  testId?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-semibold text-gray-700">
        {label}
      </Label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-gray-400">
          ₹
        </span>
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="2000"
          className={cn("h-10 pl-7 tabular-nums", error && "border-red-300 focus-visible:ring-red-300")}
          aria-invalid={!!error}
          autoFocus={autoFocus}
          data-testid={testId}
        />
      </div>
      {error ? (
        <p className="text-xs font-medium text-red-600" data-testid={`${testId}-error`}>
          {error}
        </p>
      ) : (
        hint && <p className="text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** The mandatory remark (add) or reason (change, remove), with its character counter. */
export function RemarkField({
  value,
  onChange,
  error,
  label,
  placeholder,
  testId = "excess-remark",
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  label: string;
  placeholder: string;
  testId?: string;
}) {
  const id = useId();
  const counter = remarkCounter(value);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id} className="text-xs font-semibold text-gray-700">
          {label} <span className="text-red-600">*</span>
        </Label>
        <span
          className={cn("text-[11px] tabular-nums", counter.over ? "font-semibold text-red-600" : "text-gray-400")}
          data-testid={`${testId}-counter`}
        >
          {counter.label}
        </span>
      </div>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        maxLength={REMARK_MAX + 50}
        className={cn("resize-none bg-white", error && "border-red-300 focus-visible:ring-red-300")}
        aria-invalid={!!error}
        aria-required="true"
        data-testid={testId}
      />
      {error && (
        <p className="text-xs font-medium text-red-600" data-testid={`${testId}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

/** The violet "this month / period is finalized" line. */
export function LockedNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p
      className="flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-900"
      data-testid={testId}
    >
      <Lock size={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
