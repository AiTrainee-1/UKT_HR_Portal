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
import { STATUS_LABEL, VIEW_ONLY_TEXT, type Affect, type Tone } from "./logic";

// The pieces every tab of SMS Control is made of, in the look of the portal's other control pages (WhatsApp, Phone Notify):
// the portal's colour tokens for surfaces and text (bg-card, text-foreground, text-muted-foreground, border), plain palette
// colours for the tints (no opacity utilities, so the Clean theme draws them as they are), and a dark variant on each tint.

export type { Tone };

type IconType = ComponentType<{ size?: number; className?: string }>;

export const TINT: Record<Tone, string> = {
  good: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  warn: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  bad: "border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
  info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200",
  neutral: "border-border bg-muted text-foreground",
};

export const ICON_TINT: Record<Tone, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
  info: "text-sky-600 dark:text-sky-400",
  neutral: "text-muted-foreground",
};

export const VALUE_TINT: Record<Tone, string> = {
  good: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-red-700 dark:text-red-400",
  info: "text-sky-700 dark:text-sky-400",
  neutral: "text-foreground",
};

/** The round icon tile of a card or of the status line: a soft fill in the tone's colour. */
export const ICON_TILE: Record<Tone, string> = {
  good: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200",
  warn: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200",
  bad: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200",
  info: "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-200",
  neutral: "bg-muted text-muted-foreground",
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
  icon,
}: {
  tone?: Tone;
  children: ReactNode;
  role?: "alert" | "status";
  testId?: string;
  className?: string;
  icon?: IconType;
}) {
  const Icon = icon ?? TONE_ICON[tone];
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
      className={cn("min-w-0 rounded-2xl border bg-card p-4 text-card-foreground shadow-sm sm:p-5", className)}
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

/** One figure in a tile: a label with its icon, the figure in big letters, and a line that says what it means. */
export function StatTile({
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
      className="min-w-0 rounded-2xl border bg-card p-4 text-card-foreground shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", ICON_TILE[tone])}>
          <Icon size={14} />
        </span>
      </div>
      <p
        className={cn("mt-2 break-words text-2xl font-black leading-none tabular-nums", VALUE_TINT[tone])}
        data-testid={testId ? `${testId}-value` : undefined}
      >
        {value}
      </p>
      {sub && <p className="mt-1.5 break-words text-xs leading-snug text-muted-foreground">{sub}</p>}
      {children}
    </div>
  );
}

const METER_FILL: Record<Tone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  info: "bg-sky-500",
  neutral: "bg-slate-400",
};

/** A bar for how much of something is used (a cap, a budget). Its numbers are always in words beside it too, so the colour is
 *  never the only signal. `pct` is 0 to 100. */
export function Meter({
  pct,
  tone,
  label,
  testId,
  marker,
}: {
  pct: number;
  tone: Tone;
  label: string;
  testId?: string;
  /** A second mark on the bar (the projection), 0 to 100. */
  marker?: number | null;
}) {
  const width = Math.max(0, Math.min(100, pct));
  return (
    <div className="relative mt-2" data-testid={testId} data-tone={tone}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(width)}
        className="h-2.5 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full rounded-full", METER_FILL[tone])} style={{ width: `${width}%` }} />
      </div>
      {marker !== undefined && marker !== null && (
        <span
          aria-hidden="true"
          title="At this pace"
          className="absolute -top-0.5 h-3.5 w-0.5 rounded-full bg-foreground"
          style={{ left: `calc(${Math.max(0, Math.min(100, marker))}% - 1px)` }}
        />
      )}
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

/** An ON / OFF word beside a switch, so the colour is never the only signal. */
export function OnOff({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "text-xs font-bold",
        on ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
        className,
      )}
    >
      {on ? "ON" : "OFF"}
    </span>
  );
}

/** "Could not be loaded" with a Try again (it only reads, so a View only role may press it too). */
export function LoadError({ what, onRetry, testId }: { what: string; onRetry: () => void; testId?: string }) {
  return (
    <Notice tone="bad" role="alert" testId={testId}>
      <div className="flex flex-wrap items-center gap-3">
        <span>{what} could not be loaded. Check the connection and try again.</span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </Notice>
  );
}

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
            <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground" />
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
      className="rounded-lg border border-dashed bg-muted px-3 py-2 text-[12px] leading-snug text-muted-foreground"
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
      className="h-7 shrink-0 gap-1.5 px-2 text-xs"
    >
      {state === "copied" ? <Check size={12} /> : <Copy size={12} />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Press Ctrl+C" : "Copy"}</span>
    </Button>
  );
}

/** A value in a code box with its Copy button: an environment variable name, the template text. */
export function CopyLine({ text, what, testId }: { text: string; what: string; testId?: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2" data-testid={testId}>
      <code className="min-w-0 flex-1 break-all rounded-lg border bg-muted px-2.5 py-1.5 text-[12px] leading-snug">
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
