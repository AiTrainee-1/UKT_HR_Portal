import type { ComponentType, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// The small pieces the Connection check, Send a test and the Overview notices are built from, in the look of the rest of
// WhatsApp Control (the white clay cards). The card stays white in every theme, so the text colours are set here rather
// than inherited (the dark theme's light foreground would vanish on it).

type IconType = ComponentType<{ size?: number; className?: string }>;

export type NoticeTone = "good" | "warn" | "bad" | "info" | "neutral";

const TINT: Record<NoticeTone, string> = {
  good: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  bad: "border-red-200 bg-red-50 text-red-900",
  info: "border-blue-100 bg-blue-50 text-blue-900",
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
};

const ICON_TINT: Record<NoticeTone, string> = {
  good: "text-emerald-600",
  warn: "text-amber-600",
  bad: "text-red-600",
  info: "text-blue-600",
  neutral: "text-slate-500",
};

const TONE_ICON: Record<NoticeTone, IconType> = {
  good: CheckCircle2,
  warn: AlertTriangle,
  bad: XCircle,
  info: Info,
  neutral: Info,
};

/** A tinted strip: a verdict, a rule, a problem. */
export function Notice({
  tone = "info",
  icon,
  title,
  children,
  role,
  testId,
  className,
}: {
  tone?: NoticeTone;
  icon?: IconType;
  title?: ReactNode;
  children?: ReactNode;
  role?: "alert" | "status";
  testId?: string;
  className?: string;
}) {
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <div
      role={role}
      data-testid={testId}
      data-tone={tone}
      className={cn("flex items-start gap-2.5 rounded-xl border p-3 text-xs leading-relaxed", TINT[tone], className)}
    >
      <Icon size={15} className={cn("mt-px shrink-0", ICON_TINT[tone])} />
      <div className="min-w-0 flex-1 break-words">
        {title && <p className="text-[13px] font-bold leading-snug">{title}</p>}
        {children && <div className={cn(title && "mt-0.5")}>{children}</div>}
      </div>
    </div>
  );
}

/** A white card with a title, an optional line under it, and room for actions on the right. */
export function Panel({
  title,
  description,
  icon: Icon,
  actions,
  children,
  testId,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: IconType;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <Card className={cn("border-0 text-gray-900 shadow-sm", className)} data-testid={testId}>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-x-4 gap-y-2 space-y-0 pb-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm font-bold text-gray-900">
            {Icon && <Icon size={15} className="shrink-0 text-emerald-600" />}
            {title}
          </CardTitle>
          {description && <p className="mt-1 text-xs leading-snug text-gray-500">{description}</p>}
        </div>
        {actions}
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

/** One fact in a tile: a small grey label and its value. */
export function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-xs" data-testid={testId}>
      <span className="shrink-0 font-semibold text-gray-500">{label}</span>
      <span className="min-w-0 break-words text-right font-medium text-gray-900">{children}</span>
    </div>
  );
}

/** A grey box inside a panel holding a few facts under a heading. */
export function Tile({
  title,
  icon: Icon,
  aside,
  children,
  testId,
  className,
}: {
  title: string;
  icon?: IconType;
  aside?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-slate-100 bg-slate-50 p-3", className)} data-testid={testId}>
      <header className="mb-1 flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-500">
          {Icon && <Icon size={13} className="shrink-0" />}
          {title}
        </h4>
        {aside}
      </header>
      <div className="divide-y divide-slate-200">{children}</div>
    </section>
  );
}

/** JSON the way a person can read it, folded away until asked for. */
export function RawJson({ summary, value, testId }: { summary: string; value: unknown; testId?: string }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <details className="group rounded-xl border border-slate-200 bg-white text-xs" data-testid={testId}>
      <summary className="cursor-pointer select-none px-3 py-2 font-semibold text-blue-700 hover:underline">
        {summary}
      </summary>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all border-t border-slate-100 bg-slate-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-800">
        {text ?? "null"}
      </pre>
    </details>
  );
}
