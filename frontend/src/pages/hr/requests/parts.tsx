import type { ComponentType, MouseEvent, ReactNode } from "react";
import {
  Calendar,
  Camera,
  CheckCircle,
  ClipboardCheck,
  Clock,
  DoorOpen,
  ExternalLink,
  Fingerprint,
  Inbox,
  LogOut,
  MapPin,
  Sun,
  Wallet,
  XCircle,
} from "lucide-react";
import EmployeeAvatar from "@/components/EmployeeAvatar";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { WaitingChip, ApprovalTrailLine } from "@/components/ApprovalTrail";
import { explainsWaiting } from "@/lib/approval-workflow";
import { cn } from "@/lib/utils";
import { decisionsHere, roleText, statusChip, waitingDays, type HubItem, type HubKind, type KindKey } from "./logic";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** The icon and tint of each kind of request (full class strings, so Tailwind sees them). */
export const KIND_VISUAL: Record<KindKey, { icon: IconType; tile: string }> = {
  leave: { icon: Calendar, tile: "bg-blue-50 text-blue-600" },
  permission: { icon: Clock, tile: "bg-cyan-50 text-cyan-600" },
  casual_leave: { icon: Sun, tile: "bg-amber-50 text-amber-600" },
  missing_punch: { icon: Fingerprint, tile: "bg-violet-50 text-violet-600" },
  on_duty: { icon: MapPin, tile: "bg-emerald-50 text-emerald-600" },
  on_duty_punch: { icon: Camera, tile: "bg-lime-50 text-lime-700" },
  outpass: { icon: DoorOpen, tile: "bg-teal-50 text-teal-600" },
  request: { icon: Inbox, tile: "bg-indigo-50 text-indigo-600" },
  attendance_correction: { icon: ClipboardCheck, tile: "bg-orange-50 text-orange-600" },
  resignation: { icon: LogOut, tile: "bg-rose-50 text-rose-600" },
  advance: { icon: Wallet, tile: "bg-sky-50 text-sky-600" },
};

export function KindIcon({ kind, size = 15 }: { kind: KindKey; size?: number }) {
  const { icon: Icon, tile } = KIND_VISUAL[kind];
  return (
    <div className={cn("mt-0.5 shrink-0 rounded-lg p-2", tile)} aria-hidden>
      <Icon size={size} />
    </div>
  );
}

/** One figure above the list. A button when it can narrow the list to what it counts. */
export function FigureCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  onClick,
  active,
  testId,
}: {
  label: string;
  value: number | string;
  sub?: string;
  icon: IconType;
  tone: string;
  onClick?: () => void;
  active?: boolean;
  testId?: string;
}) {
  const body = (
    <>
      <div className="mt-0.5 rounded-xl bg-white/60 p-2">
        <Icon size={16} />
      </div>
      <div className="min-w-0 text-left">
        <p className="text-xs font-medium opacity-70">{label}</p>
        <p className="text-2xl font-black leading-tight" data-testid={testId ? `${testId}-value` : undefined}>
          {value}
        </p>
        {sub && <p className="mt-0.5 text-xs leading-snug opacity-60">{sub}</p>}
      </div>
    </>
  );
  const cls = cn("flex w-full items-start gap-3 rounded-2xl p-4", tone, active && "ring-2 ring-offset-1 ring-current");
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(cls, "transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2")}
      data-testid={testId}
      aria-pressed={active}
    >
      {body}
    </button>
  ) : (
    <div className={cls} data-testid={testId}>
      {body}
    </div>
  );
}

const dateShort = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "";
const timeShort = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "";

export const dateTimeLong = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-IN") : "-");

export function EmployeeCell({ item, size = 34 }: { item: HubItem; size?: number }) {
  const { employee } = item;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <EmployeeAvatar photoUrl={employee.photoUrl} name={employee.name} size={size} />
      <div className="min-w-0">
        <p className="truncate text-sm font-bold text-gray-900">{employee.name}</p>
        <p className="truncate text-xs text-gray-500">
          {employee.code}
          {employee.department ? ` · ${employee.department}` : ""}
        </p>
      </div>
    </div>
  );
}

/** What was asked, in one or two lines. */
export function RequestCell({ item }: { item: HubItem }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <KindIcon kind={item.kind} />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gray-900">{item.label}</p>
        <p className="line-clamp-2 text-xs text-gray-600">{item.summary}</p>
        {item.reason && item.reason !== item.summary && (
          <p className="line-clamp-1 text-xs italic text-gray-400">{item.reason}</p>
        )}
      </div>
    </div>
  );
}

/** The status chip, who a waiting request is with, and how far it has got. */
export function StatusCell({ item, now }: { item: HubItem; now: Date }) {
  const chip = statusChip(item);
  const days = waitingDays(item, now);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge tone={chip.tone} className="capitalize">
          {chip.label}
        </StatusBadge>
        {item.status === "pending" && explainsWaiting(item.approval) && <WaitingChip approval={item.approval} />}
      </div>
      <ApprovalTrailLine approval={item.approval} />
      {days >= 3 && <p className="text-[11px] font-semibold text-amber-600">Waiting {days} days</p>}
    </div>
  );
}

export function SubmittedCell({ item }: { item: HubItem }) {
  return (
    <div className="whitespace-nowrap text-xs text-gray-500" title={dateTimeLong(item.submittedAt)}>
      <p className="font-semibold text-gray-700">{dateShort(item.submittedAt)}</p>
      <p>{timeShort(item.submittedAt)}</p>
    </div>
  );
}

export function DecidedCell({ item }: { item: HubItem }) {
  const d = item.decided;
  if (!d || (!d.by && !d.at)) return <span className="text-xs text-gray-300">-</span>;
  return (
    <div className="text-xs text-gray-500" title={dateTimeLong(d.at)}>
      <p className="font-semibold text-gray-700">
        {d.by ?? "Not recorded"}
        {d.role ? <span className="ml-1 font-medium text-gray-400">({roleText(d.role)})</span> : null}
      </p>
      {d.at && (
        <p className="whitespace-nowrap">
          {dateShort(d.at)} · {timeShort(d.at)}
        </p>
      )}
    </div>
  );
}

export type ActionHandlers = {
  onApprove: (item: HubItem) => void;
  onReject: (item: HubItem) => void;
  onHandle: (item: HubItem) => void;
  onOpenPage: (item: HubItem, kind: HubKind) => void;
};

/** The buttons a request offers HR here: Approve / Reject when it is HR's turn, a form for general requests, a link to the
 *  dedicated page when the decision needs more than a button. */
export function RequestActions({
  item,
  kind,
  busy,
  handlers,
  full,
}: {
  item: HubItem;
  kind: HubKind | undefined;
  busy: boolean;
  handlers: ActionHandlers;
  /** Buttons fill the width (phone card, dialog footer). */
  full?: boolean;
}) {
  const here = decisionsHere(item, kind);
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const size = full ? "default" : "sm";
  const base = full ? "flex-1 gap-1" : "h-7 gap-1 px-2 text-xs";
  const buttons: ReactNode[] = [];

  if (here.approve) {
    buttons.push(
      <Button
        key="approve"
        size={size}
        variant="outline"
        className={cn(base, "border-green-200 text-green-700 hover:bg-green-50")}
        disabled={busy}
        onClick={stop(() => handlers.onApprove(item))}
        data-testid={`approve-${item.kind}-${item.id}`}
      >
        <CheckCircle size={12} /> Approve
      </Button>,
    );
  }
  if (here.needsType && kind) {
    buttons.push(
      <Button
        key="type"
        size={size}
        variant="outline"
        className={cn(base, "border-green-200 text-green-700 hover:bg-green-50")}
        onClick={stop(() => handlers.onOpenPage(item, kind))}
      >
        <CheckCircle size={12} /> Set type & approve
      </Button>,
    );
  }
  if (here.reject) {
    buttons.push(
      <Button
        key="reject"
        size={size}
        variant="outline"
        className={cn(base, "border-red-200 text-red-600 hover:bg-red-50")}
        disabled={busy}
        onClick={stop(() => handlers.onReject(item))}
        data-testid={`reject-${item.kind}-${item.id}`}
      >
        <XCircle size={12} /> Reject
      </Button>,
    );
  }
  if (here.notes) {
    buttons.push(
      <Button
        key="handle"
        size={size}
        variant="outline"
        className={cn(base, "border-indigo-200 text-indigo-700 hover:bg-indigo-50")}
        onClick={stop(() => handlers.onHandle(item))}
        data-testid={`handle-${item.kind}-${item.id}`}
      >
        Reply & set status
      </Button>,
    );
  }
  if (item.status === "pending" && kind?.mode === "link" && kind.openPath) {
    buttons.push(
      <Button
        key="open"
        size={size}
        variant="outline"
        className={cn(base, "border-blue-200 text-blue-700 hover:bg-blue-50")}
        onClick={stop(() => handlers.onOpenPage(item, kind))}
        data-testid={`open-${item.kind}-${item.id}`}
      >
        <ExternalLink size={12} /> Open in {kind.openLabel}
      </Button>,
    );
  }
  if (buttons.length === 0) return null;
  return <div className={cn("flex items-center gap-1", full && "w-full")}>{buttons}</div>;
}
