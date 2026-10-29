// Geo Attendance: the small pieces every tab of the page is made of, so the tabs look like one product (and like the redesigned
// payroll and requests pages): a toolbar card, status chips in the portal's tones, a quiet note, the skeleton of a list, the
// person cell. Colours are the portal's status tones (src/lib/statusTones.ts): the themes remap them, never a new hex.
import type { ComponentType, ReactNode } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { Avatar, Chip } from "@/components/payroll/kit/parts";
import { Skeleton } from "@/components/ui/skeleton";
import type { OnDutySessionItem, TrackState } from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { approvalGroup, approvalLabel, STATE_LABEL, type ApprovalGroup } from "./logic";

type IconType = ComponentType<{ size?: number; className?: string }>;

// ── words and tones ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Where an On-Duty request stands, in the words of the approval pipeline. */
export const STAGE_LABEL: Record<OnDutySessionItem["status"], string> = {
  pending_hod: "Awaiting Department Head",
  pending_hr: "Awaiting HR",
  active: "Active",
  completed: "Completed",
  rejected: "Rejected",
};

export const SESSION_TONE: Record<OnDutySessionItem["status"], Tone> = {
  pending_hod: "warning",
  pending_hr: "info",
  active: "info",
  completed: "success",
  rejected: "danger",
};

export const PUNCH_STATUS_LABEL = { pending: "Awaiting HR", approved: "Approved", rejected: "Rejected" } as const;
export const PUNCH_TONE: Record<keyof typeof PUNCH_STATUS_LABEL, Tone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
};

export const STATE_TONE: Record<TrackState, Tone> = {
  moving: "success",
  stationary: "warning",
  offline: "neutral",
  location_off: "danger",
  waiting_first_fix: "info",
  ended: "neutral",
};

const APPROVAL_TONE: Record<ApprovalGroup, Tone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  unknown: "neutral",
};

// ── chips ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a phone is doing: moving, stationary, offline, location off ... with a dot in the state's colour. */
export function StateChip({ state, testId = "state-pill" }: { state: TrackState; testId?: string }) {
  return (
    <span data-testid={testId} className="contents">
      <Chip tone={STATE_TONE[state]}>
        <span
          aria-hidden
          className={cn("inline-block h-1.5 w-1.5 rounded-full bg-current", state === "moving" && "animate-pulse")}
        />
        {STATE_LABEL[state]}
      </Chip>
    </span>
  );
}

/** The request behind a track: pending (with the stage), approved or rejected (the raw stage in the tooltip). */
export function ApprovalPill({ status, testId = "approval-chip" }: { status: string; testId?: string }) {
  return (
    <span data-testid={testId} className="contents">
      <Chip tone={APPROVAL_TONE[approvalGroup(status)]} title={status || undefined}>
        {approvalLabel(status)}
      </Chip>
    </span>
  );
}

/** An On-Duty request's own stage (Awaiting HR, Active, Completed ...). */
export function SessionChip({ status, className }: { status: OnDutySessionItem["status"]; className?: string }) {
  return (
    <Chip tone={SESSION_TONE[status] ?? "neutral"} className={className}>
      {STAGE_LABEL[status] ?? status}
    </Chip>
  );
}

// ── layout ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The row of controls above a list or a map: the same bordered white card on every tab. */
export function ToolbarCard({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-2xl border bg-white p-3", className)}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/** "3 requests", "12 of 40 employees": the quiet count at the end of a toolbar. */
export function CountText({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="text-xs font-medium text-muted-foreground sm:ml-auto" data-testid={testId} aria-live="polite">
      {children}
    </p>
  );
}

/** A line of information or a warning inside a card. */
export function Note({
  tone = "info",
  icon,
  children,
  className,
  testId,
}: {
  tone?: "info" | "warn" | "danger";
  icon?: IconType;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const Icon = icon ?? (tone === "info" ? Info : AlertTriangle);
  const classes = {
    info: "border-slate-200 bg-slate-50 text-slate-700",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-red-200 bg-red-50 text-red-900",
  }[tone];
  return (
    <div
      className={cn("flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-snug", classes, className)}
      data-testid={testId}
    >
      <Icon size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Rows that look like the list that is about to appear. */
export function ListSkeleton({ rows = 3, height = "h-24" }: { rows?: number; height?: string }) {
  return (
    <div className="space-y-3" data-testid="geo-skeleton">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={cn("w-full rounded-2xl", height)} />
      ))}
    </div>
  );
}

/** An employee in a list: the avatar, the name with the code, and the department (and whatever else is known) under it. */
export function PersonCell({
  name,
  code,
  sub,
  size = 36,
  className,
}: {
  name: string;
  code?: string;
  sub?: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <Avatar name={name} size={size} />
      <div className="min-w-0">
        <p className="truncate text-sm font-bold leading-tight text-gray-900">
          {name}
          {code && <span className="ml-1.5 font-mono text-[11px] font-medium text-gray-400">{code}</span>}
        </p>
        {sub && <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

/** A small caption above a group of facts: "Destination", "Review". */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-[10px] font-semibold uppercase tracking-wider text-gray-400", className)}>{children}</p>
  );
}
