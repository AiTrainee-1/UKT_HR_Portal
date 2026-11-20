import { useState, type ComponentType, type ReactNode } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, FileText, Image as ImageIcon, Info, XCircle } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Tone as BadgeTone } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { TEMPLATE_STATE_INFO, templateStatusLabel, templateState, type TemplateState, type Tone } from "./logic";
import { WhatsAppText } from "./shared";

// The pieces every tab of WhatsApp Control is made of. Surfaces and text use the portal's tokens (bg-card, border,
// text-muted-foreground), so the default theme, its dark mode and the Clean theme all draw them; the tinted notices use
// plain palette colours with a dark: twin (the Clean theme maps each family to its ramp, see themes/clean).

type IconType = ComponentType<{ size?: number; className?: string }>;

export const TINT: Record<Tone, string> = {
  good: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
  warn: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100",
  bad: "border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100",
  info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100",
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
  good: "text-emerald-700 dark:text-emerald-300",
  warn: "text-amber-700 dark:text-amber-300",
  bad: "text-red-700 dark:text-red-300",
  info: "text-sky-700 dark:text-sky-300",
  neutral: "text-foreground",
};

const DOT: Record<Tone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  info: "bg-sky-500",
  neutral: "bg-slate-400",
};

const BADGE: Record<Tone, BadgeTone> = {
  good: "success",
  warn: "warning",
  bad: "danger",
  info: "info",
  neutral: "neutral",
};

const TONE_ICON: Record<Tone, IconType> = {
  good: CheckCircle2,
  warn: AlertTriangle,
  bad: XCircle,
  info: Info,
  neutral: Info,
};

/** A tinted strip: a verdict, a rule, a problem. `role="alert"` for a problem that just happened. */
export function Notice({
  tone = "info",
  icon,
  title,
  children,
  role,
  testId,
  className,
  action,
}: {
  tone?: Tone;
  icon?: IconType;
  title?: ReactNode;
  children?: ReactNode;
  role?: "alert" | "status";
  testId?: string;
  className?: string;
  action?: ReactNode;
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
      <div className="min-w-0 flex-1 break-words">
        {title && <p className="font-semibold leading-snug">{title}</p>}
        {children && <div className={cn(title && "mt-0.5")}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
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
        <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {title && (
              <h3 className="flex items-center gap-2 text-[15px] font-semibold leading-tight">
                {Icon && <Icon size={16} className="shrink-0 text-emerald-600 dark:text-emerald-400" />}
                {title}
              </h3>
            )}
            {description && <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** One number: a small label, the number in big letters, and a line that says what it means. */
export function Kpi({
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
  icon?: IconType;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      data-tone={tone}
      className="min-w-0 rounded-2xl border bg-card p-4 text-card-foreground shadow-sm"
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon size={13} className="shrink-0" />} {label}
      </p>
      <p className={cn("mt-1.5 break-words text-2xl font-bold leading-tight tabular-nums", VALUE_TINT[tone])}>
        {value}
      </p>
      {sub && <p className="mt-1 break-words text-xs leading-snug text-muted-foreground">{sub}</p>}
      {children}
    </div>
  );
}

/** A coloured chip for a state (good / watch / bad). */
export function Chip({
  tone,
  children,
  title,
  testId,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
  testId?: string;
}) {
  return (
    <span title={title} data-testid={testId} data-tone={tone} className="inline-flex">
      <StatusBadge tone={BADGE[tone]}>{children}</StatusBadge>
    </span>
  );
}

/** A small coloured dot and a word: a health reading inside a sentence or a fact. */
export function Dot({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-full", DOT[tone])} />
      {children}
    </span>
  );
}

/** A template's status as a chip, with what it means on hover. */
export function TemplateStatusChip({
  status,
  state,
  testId,
}: {
  status?: string | null;
  state?: TemplateState;
  testId?: string;
}) {
  const s = state ?? templateState(status ?? null);
  const info = TEMPLATE_STATE_INFO[s];
  return (
    <Chip tone={info.tone} title={info.help} testId={testId}>
      {status && !state ? templateStatusLabel(status) : info.label}
    </Chip>
  );
}

/** One fact: a small grey label and its value, on one line (stacked on a phone). */
export function Fact({ label, children, testId }: { label: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b py-2 text-[13px] last:border-b-0"
      data-testid={testId}
    >
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-medium">{children}</span>
    </div>
  );
}

/** A bar for a share of a whole, with an optional second mark (where the month is heading). */
export function Meter({
  pct,
  markPct,
  tone,
  label,
  testId,
}: {
  pct: number;
  markPct?: number | null;
  tone: Tone;
  label: string;
  testId?: string;
}) {
  const width = Math.max(0, Math.min(100, pct));
  const mark = markPct === null || markPct === undefined ? null : Math.max(0, Math.min(100, markPct));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(width)}
      data-testid={testId}
      data-tone={tone}
      className="relative h-2.5 w-full overflow-visible rounded-full bg-muted"
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", DOT[tone])}
        style={{ width: `${width}%` }}
      />
      {mark !== null && mark > width && (
        <div
          aria-hidden
          className={cn("absolute top-0 h-full rounded-r-full opacity-30", DOT[tone])}
          style={{ left: `${width}%`, width: `${mark - width}%` }}
        />
      )}
      {mark !== null && (
        <span
          aria-hidden
          className="absolute -top-1 h-[18px] w-0.5 rounded bg-foreground opacity-70"
          style={{ left: `calc(${mark}% - 1px)` }}
        />
      )}
    </div>
  );
}

/** A value HR copies into another system (the webhook address), with a copy button that says it worked. */
export function CopyField({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-xl border bg-muted/60 px-3 py-2" data-testid={testId}>
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
        {value || "—"}
      </code>
      <button
        type="button"
        onClick={copy}
        disabled={!value}
        aria-label={`Copy ${label}`}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-sky-700 hover:bg-sky-50 disabled:opacity-50 dark:text-sky-300 dark:hover:bg-sky-950"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** JSON the way a person can read it, folded away until asked for. */
export function RawJson({ summary, value, testId }: { summary: string; value: unknown; testId?: string }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <details className="group rounded-xl border bg-card text-xs" data-testid={testId}>
      <summary className="cursor-pointer select-none px-3 py-2 font-semibold text-sky-700 hover:underline dark:text-sky-300">
        {summary}
      </summary>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all border-t bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed">
        {text ?? "null"}
      </pre>
    </details>
  );
}

/** "Nothing here yet", centred in a dashed box. */
export function Empty({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/**
 * A received WhatsApp business message the way the employee's phone shows it: the chat's wallpaper, then one bubble with
 * the template's header (a document or a photo), its body, its grey footer and its buttons. The colours are WhatsApp's
 * own (a drawing of the phone, not part of the portal's palette).
 */
export function WhatsAppPreview({
  body,
  header,
  footer,
  buttons = [],
  sender = "UK Textiles HR",
  testId = "wa-preview",
  className,
}: {
  body: string;
  header?: "" | "document" | "image" | "text" | string | null;
  footer?: string;
  buttons?: string[];
  sender?: string;
  testId?: string;
  className?: string;
}) {
  const head = (header ?? "").toLowerCase();
  return (
    <div className={cn("overflow-hidden rounded-2xl border", className)} data-testid={testId}>
      <div className="flex items-center gap-2.5 bg-[#008069] px-3 py-2 text-white">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/20 text-[11px] font-bold">
          UK
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold leading-tight">{sender}</p>
          <p className="text-[10px] leading-tight text-[#d1f4cc]">Business account</p>
        </div>
      </div>
      <div className="bg-[#efeae2] px-3 py-4">
        <div className="relative w-fit max-w-[92%] rounded-lg rounded-tl-none bg-white text-[13px] leading-snug text-[#111b21] shadow-sm">
          <span
            aria-hidden
            className="absolute -left-2 top-0 h-0 w-0 border-l-8 border-t-8 border-l-transparent border-t-white"
          />
          <div className="px-2.5 pb-1.5 pt-2">
            {head === "document" && (
              <p className="mb-1.5 flex items-center gap-2 rounded-md bg-[#f0f2f5] px-2 py-2 text-[12px] font-medium text-[#54656f]">
                <FileText size={18} className="shrink-0 text-red-500" /> Document (PDF)
              </p>
            )}
            {head === "image" && (
              <p className="mb-1.5 flex h-24 items-center justify-center gap-1.5 rounded-md bg-[#d9dee3] text-[12px] text-[#54656f]">
                <ImageIcon size={18} /> Photo
              </p>
            )}
            <p className="whitespace-pre-wrap break-words" data-testid={`${testId}-body`}>
              {body.trim() ? <WhatsAppText text={body} /> : <i className="text-[#667781]">The message is empty</i>}
            </p>
            {footer && <p className="mt-1 text-[11px] text-[#667781]">{footer}</p>}
            <p className="mt-0.5 text-right text-[10px] text-[#667781]">10:42</p>
          </div>
          {buttons.map((b, i) => (
            <p
              key={i}
              className="border-t border-[#e9edef] py-2 text-center text-[13px] font-medium text-[#027eb5]"
              data-testid={`${testId}-button`}
            >
              {b}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
