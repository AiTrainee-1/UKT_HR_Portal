import { createContext, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Link } from "wouter";
import { AlertTriangle, ArrowUpRight, Check, CheckCircle2, Copy, Info, Link2, XCircle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { EMAIL_STATUS_TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, VIEW_ONLY_TEXT, usage, type Affect, type StepTone } from "./logic";

// The small pieces every tab of SMS Control is made of. They use the portal's colour tokens (bg-card, text-foreground,
// text-muted-foreground, border) for surfaces and text, and carry a dark variant on the tinted notices, so the page reads in
// the light and in the dark themes.

type IconType = ComponentType<{ size?: number; className?: string }>;

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const TINT: Record<Tone, string> = {
  good: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  warn: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  bad: "border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200",
  info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-200",
  neutral: "border-border bg-muted/30 text-foreground",
};

const ICON_TINT: Record<Tone, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
  info: "text-sky-600 dark:text-sky-400",
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

/** A white card with a heading, an optional line about it, and room for actions on the right. */
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
  good: "border-emerald-200 dark:border-emerald-900/60",
  warn: "border-amber-200 dark:border-amber-900/60",
  bad: "border-red-200 dark:border-red-900/60",
  info: "border-sky-200 dark:border-sky-900/60",
  neutral: "border-border",
};

const VALUE_TINT: Record<Tone, string> = {
  good: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-red-700 dark:text-red-400",
  info: "text-sky-700 dark:text-sky-400",
  neutral: "text-foreground",
};

/** One status in a card: a label, the answer in big letters, and a line that says what it means. */
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

/** A bar for how much of a cap is used. It carries its numbers as text too, so the colour is never the only signal. */
export function UsageBar({ used, cap, label, testId }: { used: number; cap: number; label: string; testId?: string }) {
  const { pct, level } = usage(used, cap);
  const fill = level === "full" ? "bg-red-500" : level === "near" ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="mt-2" data-testid={testId} data-level={level}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(used, cap)}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full rounded-full", fill)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const known = status in STATUS_LABEL;
  return (
    <StatusBadge tone={EMAIL_STATUS_TONE[status] ?? "neutral"}>
      {known ? STATUS_LABEL[status as keyof typeof STATUS_LABEL] : status}
    </StatusBadge>
  );
}

const STEP_TONE: Record<StepTone, Tone> = { bad: "bad", warn: "warn", todo: "info", info: "info", done: "good" };

export const stepTone = (tone: StepTone): Tone => STEP_TONE[tone];

// ── explained settings ────────────────────────────────────────────────────────

/** "What changes" list: each place in the application that reads a setting. */
export function AffectList({ affects }: { affects: Affect[] }) {
  return (
    <div className="space-y-1" data-testid="setting-affects">
      <p className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Link2 size={11} /> What changes
      </p>
      <ul className="space-y-1">
        {affects.map((a) => (
          <li key={a.where + a.what} className="flex items-start gap-1.5 text-[12px] leading-snug">
            <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
            <span>
              {a.to ? (
                <Link
                  href={a.to}
                  className="inline-flex items-center gap-0.5 font-semibold text-sky-700 hover:underline dark:text-sky-400"
                >
                  {a.where}
                  <ArrowUpRight size={11} />
                </Link>
              ) : (
                <span className="font-semibold">{a.where}</span>
              )}
              <span className="text-muted-foreground"> - {a.what}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One setting, explained: what it is for and what changes when it changes, on the left; the control and an example worked
 * out from the value on screen, on the right (stacked on a phone).
 */
export function SettingBlock({
  id,
  title,
  purpose,
  affects,
  defaultText,
  note,
  children,
  preview,
}: {
  id: string;
  title: ReactNode;
  purpose: ReactNode;
  affects?: Affect[];
  /** What the value is when nobody has set it ("5 minutes"). */
  defaultText?: string;
  note?: ReactNode;
  children: ReactNode;
  preview?: ReactNode;
}) {
  return (
    <section
      id={`sms-setting-${id}`}
      data-testid={`sms-setting-${id}`}
      className="grid gap-x-8 gap-y-3 border-t py-5 first:border-t-0 first:pt-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
    >
      <div className="min-w-0 space-y-2">
        <h4 className="text-sm font-semibold leading-snug">{title}</h4>
        <p className="text-[13px] leading-relaxed text-muted-foreground" data-testid="setting-purpose">
          {purpose}
        </p>
        {affects && affects.length > 0 && <AffectList affects={affects} />}
        {defaultText && (
          <p className="text-[11px] font-semibold text-muted-foreground">
            Default: <span className="font-bold text-foreground">{defaultText}</span>
          </p>
        )}
        {note}
      </div>
      <div className="min-w-0 space-y-3">
        {children}
        {preview}
      </div>
    </section>
  );
}

/** A worked example under a control, in a quiet box. */
export function Example({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p
      data-testid={testId ?? "setting-example"}
      className="rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-[12px] leading-snug text-muted-foreground"
    >
      <span className="font-semibold text-foreground">Example: </span>
      {children}
    </p>
  );
}

/** The bar a section of settings ends with: one Save, Discard, and a line that says whether anything is unsaved. */
export function SaveRow({
  dirty,
  saving,
  readOnly,
  invalid = false,
  onSave,
  onDiscard,
  saveLabel,
  hint,
  testId,
}: {
  dirty: boolean;
  saving: boolean;
  readOnly: boolean;
  /** A value is not valid yet: Save stays off (and `hint` says which). */
  invalid?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel: string;
  /** Shown beside the buttons instead of the default words (why Save is off). */
  hint?: string;
  testId: string;
}) {
  const lockedWhy = useLockedWhy();
  return (
    <div
      data-testid={testId}
      data-dirty={dirty ? "true" : "false"}
      className={cn(
        "mt-4 flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5",
        dirty ? TINT.warn : "border-transparent",
      )}
    >
      <Button
        size="sm"
        onClick={onSave}
        disabled={readOnly || !dirty || saving || invalid}
        data-testid={`${testId}-save`}
      >
        {saving ? "Saving…" : saveLabel}
      </Button>
      {dirty && !readOnly && (
        <Button size="sm" variant="ghost" onClick={onDiscard} disabled={saving} data-testid={`${testId}-discard`}>
          Discard changes
        </Button>
      )}
      <span className={cn("text-xs font-medium", dirty ? "" : "text-muted-foreground")}>
        {hint ??
          (readOnly
            ? (lockedWhy ?? VIEW_ONLY_TEXT)
            : dirty
              ? "You have changes that are not saved yet."
              : "Everything shown is saved.")}
      </span>
    </div>
  );
}

// ── copying ───────────────────────────────────────────────────────────────────

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the old way
  }
  try {
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.appendChild(box);
    box.select();
    const done = document.execCommand("copy");
    box.remove();
    return done;
  } catch {
    return false;
  }
}

/** Copies `text` and says so for two seconds. `what` is read out by a screen reader ("Copy TWOFACTOR_API_KEY"). */
export function CopyButton({ text, what, testId }: { text: string; what: string; testId?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => void copy()}
      aria-label={`Copy ${what}`}
      data-testid={testId}
      className="shrink-0 gap-1.5"
    >
      {state === "copied" ? <Check size={13} /> : <Copy size={13} />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Press Ctrl+C" : "Copy"}</span>
    </Button>
  );
}

/** A value in a code box with its Copy button: an environment variable name, the template text. */
export function CopyLine({ text, what, testId }: { text: string; what: string; testId?: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2" data-testid={testId}>
      <code className="min-w-0 flex-1 break-all rounded-lg border bg-muted/40 px-2.5 py-1.5 text-[12px] leading-snug">
        {text}
      </code>
      <CopyButton text={text} what={what} />
    </div>
  );
}

// ── asking first ──────────────────────────────────────────────────────────────

/** "Are you sure?" with the consequences in words, for a change that decides what employees experience. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  testId,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-left text-sm leading-relaxed">{children}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Offered under a "someone else saved first" refusal: read what is saved now and start the form from it. */
export function ReloadButton({ onReload }: { onReload: () => void }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onReload}
      className="mt-2 border-current bg-transparent text-current"
      data-testid="sms-settings-reload"
    >
      Reload the saved settings
    </Button>
  );
}

// ── why the page is read-only ─────────────────────────────────────────────────

/** The sentence that says why this login cannot change anything (null when it can). Set once by the page. */
export const LockContext = createContext<string | null>(null);

export const useLockedWhy = (): string | null => useContext(LockContext);
