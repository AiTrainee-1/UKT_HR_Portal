import type { ComponentType, ReactNode } from "react";
import { Factory, Loader2, Mail, MessageCircle, MessagesSquare, Users, UsersRound } from "lucide-react";
import { Chip } from "@/components/payroll/kit/parts";
import type {
  NotifyCategory,
  NotifyChannel,
  NotifyDeliveryStatus,
  NotifyEmployeeType,
  NotifyRunStatus,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  CATEGORY_META,
  CHANNEL_LABEL,
  DELIVERY_STATUS,
  EMPLOYEE_TYPE_LABEL,
  EMPLOYEE_TYPE_TONE,
  RUN_STATUS,
  categoryLabel,
} from "./logic";

// The small pieces every part of Attendance Notify is made of: the channel's look, the category / employee-type / status
// chips and the segmented switches.

type IconType = ComponentType<{ size?: number; className?: string }>;

export const CHANNEL_META: Record<NotifyChannel, { icon: IconType; tile: string; solid: string; soft: string }> = {
  whatsapp: {
    icon: MessageCircle,
    tile: "bg-emerald-50 text-emerald-800",
    solid: "bg-emerald-600 text-white",
    soft: "border-emerald-200 bg-emerald-50 text-emerald-800",
  },
  email: {
    icon: Mail,
    tile: "bg-rose-50 text-rose-800",
    solid: "bg-rose-600 text-white",
    soft: "border-rose-200 bg-rose-50 text-rose-800",
  },
  chat: {
    icon: MessagesSquare,
    tile: "bg-indigo-50 text-indigo-800",
    solid: "bg-indigo-600 text-white",
    soft: "border-indigo-200 bg-indigo-50 text-indigo-800",
  },
};

/** The channel as a small coloured pill: icon + "WhatsApp" / "Gmail" / "Internal Chat". */
export function ChannelBadge({ channel, className }: { channel: NotifyChannel; className?: string }) {
  const meta = CHANNEL_META[channel];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        meta.soft,
        className,
      )}
      data-channel={channel}
    >
      <Icon size={11} /> {CHANNEL_LABEL[channel]}
    </span>
  );
}

/** The channel's square icon tile. */
export function ChannelIcon({
  channel,
  size = 16,
  className,
}: {
  channel: NotifyChannel;
  size?: number;
  className?: string;
}) {
  const meta = CHANNEL_META[channel];
  const Icon = meta.icon;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded-xl p-2", meta.solid, className)}
      aria-hidden
    >
      <Icon size={size} />
    </span>
  );
}

export function CategoryChip({
  category,
  count,
  short = true,
  className,
}: {
  category: NotifyCategory | string;
  count?: number;
  short?: boolean;
  className?: string;
}) {
  const meta = CATEGORY_META[category as NotifyCategory];
  return (
    <Chip tone={meta?.tone ?? "neutral"} className={className}>
      {categoryLabel(category, short)}
      {count !== undefined && <span className="tabular-nums">· {count.toLocaleString("en-IN")}</span>}
    </Chip>
  );
}

const TYPE_ICON: Record<NotifyEmployeeType, IconType> = { all: UsersRound, staff: Users, production: Factory };

export function EmployeeTypeChip({ type, className }: { type: NotifyEmployeeType; className?: string }) {
  const Icon = TYPE_ICON[type];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        EMPLOYEE_TYPE_TONE[type],
        className,
      )}
      data-employee-type={type}
    >
      <Icon size={11} /> {type === "all" ? "All" : EMPLOYEE_TYPE_LABEL[type]}
    </span>
  );
}

export function RunStatusChip({ status, title }: { status: NotifyRunStatus; title?: string }) {
  const meta = RUN_STATUS[status];
  return (
    <span data-run-status={status} className="inline-flex">
      <Chip tone={meta.tone} title={title}>
        {status === "running" && <Loader2 size={11} className="animate-spin" />}
        {meta.label}
      </Chip>
    </span>
  );
}

export function DeliveryStatusChip({ status, title }: { status: NotifyDeliveryStatus; title?: string }) {
  const meta = DELIVERY_STATUS[status];
  return (
    <span data-delivery-status={status} className="inline-flex">
      <Chip tone={meta.tone} title={title}>
        {status === "sending" && <Loader2 size={11} className="animate-spin" />}
        {meta.label}
      </Chip>
    </span>
  );
}

/** A row of choices, one pressed (filters and the form's single choices). Never changes data on its own. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  testId,
  disabled,
  size = "md",
}: {
  options: { value: T; label: ReactNode; icon?: IconType }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  testId: string;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <div
      className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-xl bg-slate-100 p-1"
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {options.map((o) => {
        const on = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60",
              size === "sm" ? "h-7" : "h-8",
              on ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-900",
            )}
            data-view-safe
            data-testid={`${testId}-${o.value}`}
          >
            {Icon && <Icon size={13} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export const EMPLOYEE_TYPE_OPTIONS: { value: NotifyEmployeeType; label: string; icon: IconType }[] = [
  { value: "all", label: "All", icon: UsersRound },
  { value: "staff", label: "Staff", icon: Users },
  { value: "production", label: "Production", icon: Factory },
];

/** A labelled block of the form. */
export function Field({
  label,
  hint,
  htmlFor,
  error,
  children,
  testId,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  error?: string | null;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="space-y-1.5" data-testid={testId}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="block text-xs font-semibold text-slate-700">
          {label}
        </label>
      ) : (
        <p className="text-xs font-semibold text-slate-700">{label}</p>
      )}
      {children}
      {error ? (
        <p role="alert" className="text-xs font-medium text-red-600">
          {error}
        </p>
      ) : (
        hint && <p className="text-[11px] leading-snug text-slate-500">{hint}</p>
      )}
    </div>
  );
}

/** A switch with its label and one line of explanation, as a row. */
export function ToggleRow({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-slate-100 bg-white px-3 py-2.5">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-semibold text-slate-900">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs leading-snug text-slate-500">{hint}</p>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}
