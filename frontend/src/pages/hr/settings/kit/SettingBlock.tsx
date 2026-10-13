import type { ComponentType, ReactNode } from "react";
import { Link } from "wouter";
import { ArrowUpRight, Eye, FlaskConical, Info, Link2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** One thing in the application that reads a setting: where it is, and what it does with the value. */
export type Affect = {
  /** The feature or page, for example "Staff Attendance" or "Salary slip PDF". */
  where: string;
  /** What it does differently when the value changes, in a plain sentence. */
  what: string;
  /** Page to open to see the effect (an app path). */
  to?: string;
};

/**
 * One setting, explained: what it is for, what in the application changes when it is changed, and (optionally) a live
 * example worked out from the value on screen. Every control on the Settings page goes inside one of these, so each
 * setting reads the same way: the explanation on the left, the control and its example on the right.
 *
 * `id` makes the block a target of the page's search (`?tab=attendance#late-window`): it scrolls into view and flashes.
 */
export function SettingBlock({
  id,
  labelFor,
  title,
  purpose,
  affects,
  defaultText,
  note,
  preview,
  children,
  tone = "default",
  className,
  testId,
}: {
  id?: string;
  /** Id of the control this setting is: the title then labels it (clicking it focuses the control, and tests find it by label). */
  labelFor?: string;
  title: ReactNode;
  /** What the setting is for: one or two sentences an HR manager understands. */
  purpose: ReactNode;
  /** What changes in the application when it is changed. */
  affects?: Affect[];
  /** What the value is when nobody has set it ("Off", "10 minutes"). */
  defaultText?: string;
  /** Something to be careful about (money, history, a confirm needed). */
  note?: ReactNode;
  /** A worked example from the current value; see PreviewCard. */
  preview?: ReactNode;
  children: ReactNode;
  tone?: "default" | "danger";
  className?: string;
  testId?: string;
}) {
  return (
    <section
      id={id}
      data-setting-id={id}
      data-testid={testId ?? (id ? `setting-${id}` : undefined)}
      className={cn(
        "settings-divide grid gap-x-8 gap-y-4 border-t py-5 first:border-t-0 first:pt-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]",
        "scroll-mt-24 [&.setting-flash]:rounded-2xl [&.setting-flash]:bg-sky-100/60 [&.setting-flash]:ring-2 [&.setting-flash]:ring-sky-300",
        className,
      )}
    >
      <div className="min-w-0 space-y-2">
        <h4 className={cn("text-sm font-bold leading-snug", tone === "danger" ? "text-red-700" : "text-gray-900")}>
          {labelFor ? <label htmlFor={labelFor}>{title}</label> : title}
        </h4>
        <p className="text-[13px] leading-relaxed text-gray-600" data-testid="setting-purpose">
          {purpose}
        </p>
        {affects && affects.length > 0 && <AffectList affects={affects} />}
        {defaultText && (
          <p className="text-[11px] font-semibold text-gray-400">
            Default: <span className="font-bold text-gray-500">{defaultText}</span>
          </p>
        )}
        {note && (
          <div className="flex items-start gap-2 rounded-xl bg-amber-50/80 px-2.5 py-2 text-[12px] leading-snug text-amber-800 ring-1 ring-amber-200/70">
            <Info size={13} className="mt-0.5 shrink-0" />
            <div>{note}</div>
          </div>
        )}
      </div>
      <div className="min-w-0 space-y-3">
        <div className="space-y-3">{children}</div>
        {preview}
      </div>
    </section>
  );
}

/** "What changes" list: each place in the application that reads the setting. */
export function AffectList({ affects }: { affects: Affect[] }) {
  return (
    <div className="space-y-1" data-testid="setting-affects">
      <p className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-gray-400">
        <Link2 size={11} /> What changes
      </p>
      <ul className="space-y-1">
        {affects.map((a) => (
          <li key={a.where + a.what} className="flex items-start gap-1.5 text-[12px] leading-snug text-gray-600">
            <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-blue-300" />
            <span>
              {a.to ? (
                <Link
                  href={a.to}
                  className="inline-flex items-center gap-0.5 font-semibold text-blue-700 hover:underline"
                >
                  {a.where}
                  <ArrowUpRight size={11} />
                </Link>
              ) : (
                <span className="font-semibold text-gray-800">{a.where}</span>
              )}
              <span className="text-gray-500"> - {a.what}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A worked example under a control. The rows are worked out from the value being typed (not the saved one), so HR sees
 * what the new number would do before saving. Say which example it is ("A 09:00 shift with 10 minutes' grace").
 */
export function PreviewCard({
  title = "Example",
  scenario,
  children,
  testId,
}: {
  title?: string;
  /** The made-up case the rows are about. */
  scenario?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="settings-clay-inset p-3.5" data-testid={testId ?? "setting-preview"}>
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-blue-600">
        <FlaskConical size={12} /> {title}
      </p>
      {scenario && <p className="mt-1 text-[12px] leading-snug text-gray-600">{scenario}</p>}
      <div className="mt-2 space-y-1.5">{children}</div>
    </div>
  );
}

const LINE_TONES = {
  neutral: "bg-white text-gray-700 border-slate-100",
  good: "bg-emerald-50 text-emerald-800 border-emerald-100",
  warn: "bg-amber-50 text-amber-800 border-amber-100",
  bad: "bg-red-50 text-red-800 border-red-100",
  info: "bg-blue-50 text-blue-800 border-blue-100",
};

/** One line of an example: what happens on the left, the outcome on the right. */
export function PreviewLine({
  label,
  result,
  tone = "neutral",
  testId,
}: {
  label: ReactNode;
  result: ReactNode;
  tone?: keyof typeof LINE_TONES;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "settings-line flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-xl border px-3 py-1.5 text-[12px]",
        LINE_TONES[tone],
      )}
      data-testid={testId}
    >
      <span className="min-w-0 font-medium">{label}</span>
      <span className="font-bold tabular-nums">{result}</span>
    </div>
  );
}

/**
 * A group of settings with one purpose, in a card of its own: the heading says what the group is, and the line under
 * it says who or what it is used by. `footer` is where the group's Save button goes.
 */
export function SettingsSection({
  icon: Icon,
  title,
  purpose,
  usedBy,
  children,
  footer,
  id,
  testId,
  className,
}: {
  icon?: IconType;
  title: string;
  purpose?: ReactNode;
  /** Short list of the features that read this group, as chips. */
  usedBy?: { label: string; to?: string }[];
  children: ReactNode;
  footer?: ReactNode;
  id?: string;
  testId?: string;
  className?: string;
}) {
  return (
    <section
      id={id}
      data-testid={testId}
      className={cn("settings-glass scroll-mt-24 rounded-3xl p-4 sm:p-6", className)}
    >
      <header className="mb-1 flex items-start gap-3">
        {Icon && (
          <span className="settings-tile mt-0.5 h-10 w-10 shrink-0 rounded-2xl">
            <Icon size={16} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-black leading-tight text-gray-900">{title}</h3>
          {purpose && <p className="mt-0.5 text-[13px] leading-snug text-gray-500">{purpose}</p>}
          {usedBy && usedBy.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Used by</span>
              {usedBy.map((u) =>
                u.to ? (
                  <Link
                    key={u.label}
                    href={u.to}
                    className="settings-chip inline-flex items-center gap-0.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold text-slate-700 hover:text-blue-700"
                  >
                    {u.label}
                    <ArrowUpRight size={10} />
                  </Link>
                ) : (
                  <span
                    key={u.label}
                    className="settings-chip rounded-full px-2.5 py-0.5 text-[11px] font-semibold text-slate-700"
                  >
                    {u.label}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
      </header>
      <div>{children}</div>
      {footer && <div className="settings-divide mt-4 flex flex-wrap items-center gap-2 border-t pt-4">{footer}</div>}
    </section>
  );
}

/**
 * Where a setting that looks like it belongs here is really kept. Each setting lives in exactly one place; a tab that
 * is related to it says so and links there instead of showing a second control for the same value.
 */
export function ManagedElsewhere({
  title,
  children,
  to,
  linkLabel,
  testId,
}: {
  title: string;
  children: ReactNode;
  to: string;
  linkLabel: string;
  testId?: string;
}) {
  return (
    <div
      className="settings-glass flex flex-wrap items-center justify-between gap-3 rounded-3xl p-4"
      data-testid={testId ?? "managed-elsewhere"}
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-bold text-gray-800">
          <Sparkles size={14} className="text-blue-500" /> {title}
        </p>
        <p className="mt-0.5 text-[13px] leading-snug text-gray-600">{children}</p>
      </div>
      <Link
        href={to}
        className="settings-clay inline-flex items-center gap-1 rounded-2xl px-3.5 py-2 text-xs font-bold text-blue-700 hover:text-blue-900"
      >
        {linkLabel} <ArrowUpRight size={13} />
      </Link>
    </div>
  );
}

/** The amber strip a tab shows when the signed-in role may look but not change (the lock itself is in Settings.tsx). */
export function ViewOnlyNotice() {
  return (
    <div
      className="settings-glass flex items-center gap-2 rounded-2xl px-3.5 py-2.5 text-sm font-semibold text-amber-800 !bg-amber-50/70"
      data-testid="settings-view-only"
    >
      <Eye size={15} strokeWidth={2} />
      View only: browse and inspect freely, changes can't be saved.
    </div>
  );
}
