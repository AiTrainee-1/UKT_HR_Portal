// Journey History: the small pieces every part of it draws the same way: a chip, the state pill, a figure card, the map legend.
// Colours are the standard Tailwind families (the Clean Professional theme remaps those), never a new rule.
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { TrackState } from "@/lib/api-client/custom-hooks";
import {
  APPROVAL_CLASS,
  STATE_CLASS,
  STATE_LABEL,
  approvalGroup,
  approvalLabel,
  TIMELINE_TYPE_CLASS,
  TIMELINE_TYPE_LABEL,
  type TimelineType,
} from "./logic";

export function Chip({
  className,
  children,
  testId,
  title,
}: {
  className?: string;
  children: ReactNode;
  testId?: string;
  title?: string;
}) {
  return (
    <span
      data-testid={testId}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-bold leading-tight",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** moving / stationary / offline / location off / waiting for the first fix / ended, in words and a colour. */
export function StatePill({ state, testId = "state-pill" }: { state: TrackState; testId?: string }) {
  return (
    <Chip testId={testId} className={STATE_CLASS[state]}>
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full bg-current"
        data-live={state === "moving" ? "true" : undefined}
      />
      {STATE_LABEL[state]}
    </Chip>
  );
}

/** The state of the request behind a track: pending / approved / rejected (the exact stage in the tooltip). */
export function ApprovalChip({ status, testId = "approval-chip" }: { status: string; testId?: string }) {
  const group = approvalGroup(status);
  return (
    <Chip testId={testId} className={APPROVAL_CLASS[group]} title={status || undefined}>
      {approvalLabel(status)}
    </Chip>
  );
}

export function TypeChip({ type }: { type: TimelineType }) {
  return (
    <Chip testId="timeline-type" className={TIMELINE_TYPE_CLASS[type]}>
      {TIMELINE_TYPE_LABEL[type]}
    </Chip>
  );
}

/** "Live": the track is still recording, the page refreshes by itself. */
export function LiveBadge({ children = "Live" }: { children?: ReactNode }) {
  return (
    <Chip testId="live-badge" className="bg-green-600 text-white">
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-white" />
      {children}
    </Chip>
  );
}

/** A figure with its caption: the summary row of a journey. */
export function StatCard({
  label,
  value,
  hint,
  icon,
  testId,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  testId?: string;
  tone?: "default" | "warn";
}) {
  return (
    <Card className="border-0 shadow-sm" data-testid={testId}>
      <CardContent className="p-3.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          {icon}
          {label}
        </div>
        <p
          className={cn("mt-1 text-xl font-black leading-tight", tone === "warn" ? "text-amber-700" : "text-gray-900")}
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {value}
        </p>
        {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function MapLegend({
  items,
}: {
  items: { color: string; label: string; shape?: "dot" | "line" | "dash" | "ring" }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1" data-testid="map-legend">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-700">
          {it.shape === "line" || it.shape === "dash" ? (
            <span
              aria-hidden
              className="inline-block w-5 shrink-0"
              style={{ borderTop: `3px ${it.shape === "dash" ? "dashed" : "solid"} ${it.color}` }}
            />
          ) : (
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{
                background: it.shape === "ring" ? "#ffffff" : it.color,
                border: it.shape === "ring" ? `2px solid ${it.color}` : undefined,
              }}
            />
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** A grey panel that says what is empty and why. */
export function EmptyNote({ icon, children, testId }: { icon?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="px-4 py-12 text-center" data-testid={testId}>
      {icon && <div className="mx-auto mb-3 flex justify-center text-gray-300">{icon}</div>}
      <div className="mx-auto max-w-md text-sm text-gray-500">{children}</div>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
      <Loader2 size={13} className="animate-spin" />
      {label}
    </span>
  );
}
