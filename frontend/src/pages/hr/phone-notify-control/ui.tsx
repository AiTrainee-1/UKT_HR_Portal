import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import { STATUS_HELP, statusLabel, statusTone } from "./logic";

// The small pieces every tab of Phone Notify Control is made of, in the look of the SMS / WhatsApp / Gmail Control pages:
// the portal's colour tokens for surfaces and text, plain palette colours for the tinted notices (no opacity utilities, so the
// Clean theme draws them as they are).

type IconType = ComponentType<{ size?: number; className?: string }>;

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const TINT: Record<Tone, string> = {
  good: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  warn: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  bad: "border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
  info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200",
  neutral: "border-border bg-muted text-foreground",
};

const ICON_TINT: Record<Tone, string> = {
  good: "text-emerald-600",
  warn: "text-amber-600",
  bad: "text-red-600",
  info: "text-sky-600",
  neutral: "text-muted-foreground",
};

const TONE_ICON: Record<Tone, IconType> = {
  good: CheckCircle2,
  warn: AlertTriangle,
  bad: XCircle,
  info: Info,
  neutral: Info,
};

/** A tinted strip: a problem, a warning, a piece of advice. `role="alert"` for a problem that just happened. */
export function Notice({
  tone = "info",
  children,
  role,
  testId,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  role?: "alert" | "status";
  testId?: string;
  className?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      role={role}
      data-testid={testId}
      data-tone={tone}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border p-3 text-[13px] leading-relaxed",
        TINT[tone],
        className,
      )}
    >
      <Icon size={15} className={cn("mt-0.5 shrink-0", ICON_TINT[tone])} />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

/** A card with a heading, an optional line about it, and room for actions on the right. */
export function Panel({
  title,
  description,
  icon: Icon,
  actions,
  children,
  testId,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  icon?: IconType;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={cn("rounded-2xl border bg-card p-4 text-card-foreground shadow-sm sm:p-5", className)}
    >
      {(title || actions) && (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {title && (
              <h3 className="flex items-center gap-2 text-[15px] font-semibold leading-tight">
                {Icon && <Icon size={16} className="shrink-0 text-muted-foreground" />}
                {title}
              </h3>
            )}
            {description && <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

const CARD_TINT: Record<Tone, string> = {
  good: "border-emerald-200",
  warn: "border-amber-200",
  bad: "border-red-200",
  info: "border-sky-200",
  neutral: "border-border",
};

const VALUE_TINT: Record<Tone, string> = {
  good: "text-emerald-700",
  warn: "text-amber-700",
  bad: "text-red-700",
  info: "text-sky-700",
  neutral: "text-foreground",
};

/** One number in a card: a label, the number in big letters, and a line that says what it means. */
export function StatusCard({
  label,
  value,
  sub,
  tone = "neutral",
  icon: Icon,
  testId,
  children,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  icon: IconType;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      data-tone={tone}
      className={cn("min-w-0 rounded-2xl border bg-card p-4 text-card-foreground shadow-sm", CARD_TINT[tone])}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon size={13} className="shrink-0" /> {label}
      </p>
      <p className={cn("mt-1.5 break-words text-xl font-bold leading-tight tabular-nums", VALUE_TINT[tone])}>{value}</p>
      {sub && <p className="mt-1 break-words text-xs leading-snug text-muted-foreground">{sub}</p>}
      {children}
    </div>
  );
}

/** What happened to a push, as a coloured chip with the meaning on hover. */
export function PushStatusChip({ status }: { status: string }) {
  return (
    <span
      title={STATUS_HELP[status as keyof typeof STATUS_HELP]}
      data-status={status || "none"}
      className="inline-flex"
    >
      <StatusBadge tone={statusTone(status)}>{statusLabel(status)}</StatusBadge>
    </span>
  );
}

/** "Could not be loaded" with a Try again (it only reads, so a View only role may press it too). */
export function LoadError({ what, onRetry, testId }: { what: string; onRetry: () => void; testId?: string }) {
  return (
    <Notice tone="bad" role="alert" testId={testId}>
      <div className="flex flex-wrap items-center gap-3">
        <span>{what} could not be loaded. Check the connection and try again.</span>
        <Button size="sm" variant="outline" onClick={onRetry} data-view-safe>
          Try again
        </Button>
      </div>
    </Notice>
  );
}

/** An ON / OFF word beside a switch, so the colour is never the only signal. */
export function OnOff({ on, className }: { on: boolean; className?: string }) {
  return (
    <span className={cn("w-8 text-right text-xs font-bold", on ? "text-emerald-600" : "text-gray-400", className)}>
      {on ? "ON" : "OFF"}
    </span>
  );
}

// ── asking first, inside the page ─────────────────────────────────────────────

/**
 * "Are you sure?" drawn in the page where the action was pressed (not a browser box, not a dialog): the consequence in words,
 * the action's own button, and Cancel.
 */
export function InlineConfirm({
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  pending = false,
  destructive = false,
  testId,
}: {
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  destructive?: boolean;
  testId?: string;
}) {
  return (
    <div
      role="group"
      data-testid={testId}
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-xl border p-3 text-[13px] leading-relaxed",
        destructive ? TINT.bad : TINT.warn,
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="outline" onClick={onCancel} disabled={pending} data-view-safe>
          Cancel
        </Button>
        <Button
          size="sm"
          variant={destructive ? "destructive" : "default"}
          onClick={onConfirm}
          disabled={pending}
          data-testid={testId ? `${testId}-yes` : undefined}
        >
          {pending ? "Working…" : confirmLabel}
        </Button>
      </div>
    </div>
  );
}

// ── why a tab is read-only ────────────────────────────────────────────────────

/** The sentence that says why this login cannot change anything on the tab on screen (null when it can). Set by the page. */
export const LockContext = createContext<string | null>(null);

export const useLockedWhy = (): string | null => useContext(LockContext);
