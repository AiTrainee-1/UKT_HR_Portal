import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { copyText } from "./logic";

type IconType = ComponentType<{ size?: number; className?: string }>;

const TONES = {
  primary: "border border-primary bg-primary text-primary-foreground hover:opacity-90",
  outline: "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
  danger: "border border-rose-200 bg-white text-rose-700 hover:bg-rose-50",
  ghost: "border border-transparent bg-transparent text-slate-600 hover:bg-slate-100",
} as const;

/**
 * A flat button of the page (no gradient, no shadow: the Clean theme has nothing to undo): 44 px tall on a phone, 36 px
 * from the tablet width up. `icon` sits before the words; an icon-only button needs an `aria-label`.
 */
export const GateButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof TONES; icon?: IconType; small?: boolean }
>(function GateButton({ tone = "outline", icon: Icon, small = false, className, children, type, ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-semibold transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50",
        small ? "h-11 min-w-11 px-2.5 sm:h-8 sm:min-w-8" : "h-11 px-3.5 sm:h-9",
        TONES[tone],
        className,
      )}
      {...props}
    >
      {Icon && <Icon size={15} aria-hidden="true" />}
      {children}
    </button>
  );
});

/** Copies `value` and says so ("Username copied"); the icon turns into a tick for a moment. */
export function CopyButton({
  value,
  what,
  label,
  testId,
  disabled,
  onCopy,
}: {
  /** The text, or a function that fetches it first (the password). */
  value: string | (() => Promise<string | null>);
  /** "Username", "Password", "Address": the toast says "<what> copied". */
  what: string;
  /** The accessible name: "Copy the username". */
  label: string;
  testId?: string;
  disabled?: boolean;
  onCopy?: () => void;
}) {
  const { toast } = useToast();
  const [done, setDone] = useState(false);
  const run = async () => {
    const text = typeof value === "string" ? value : await value();
    if (text === null) return;
    if (await copyText(text)) {
      setDone(true);
      setTimeout(() => setDone(false), 1500);
      toast({ title: `${what} copied` });
      onCopy?.();
    } else {
      toast({ title: "Could not copy", description: "Your browser did not allow it. Select the text and copy it." });
    }
  };
  return (
    <GateButton
      small
      tone="ghost"
      aria-label={label}
      title={label}
      icon={done ? Check : Copy}
      onClick={() => void run()}
      disabled={disabled}
      data-testid={testId}
    />
  );
}

/** A white card of the page: border only, rounded, a title row with optional actions. Titles are h3 (the page has one h2). */
export function Panel({
  title,
  hint,
  actions,
  children,
  className,
  testId,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={cn("min-w-0 rounded-2xl border border-slate-200/80 bg-white", className)} data-testid={testId}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3.5">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-slate-900">{title}</h3>}
            {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A small uppercase label over a value (the counts grid, the login box). */
export function Fact({
  label,
  children,
  tone,
  testId,
}: {
  label: string;
  children: ReactNode;
  tone?: "rose";
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border px-3 py-2.5",
        tone === "rose" ? "border-rose-200 bg-rose-50/60" : "border-slate-200/80 bg-slate-50/60",
      )}
      data-testid={testId}
    >
      <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div
        className={cn(
          "mt-1 min-w-0 truncate text-lg font-bold tabular-nums",
          tone === "rose" ? "text-rose-700" : "text-slate-900",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** The app's Switch carries a small drop shadow (and its knob a large one): flat here, like the rest of the page. */
export const FLAT_SWITCH = "shadow-none [&_[data-slot=switch-thumb]]:shadow-none";

/** The page's field look (inputs in the dialogs). */
export const FIELD =
  "h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none sm:h-10 " +
  "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50 disabled:bg-slate-50";
