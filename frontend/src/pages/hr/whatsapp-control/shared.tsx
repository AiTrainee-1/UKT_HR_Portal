import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { WHATSAPP_STATUS_TONE } from "@/lib/statusTones";
import type { WhatsAppMessageKind, WhatsAppMessageStatus } from "@/lib/api-client/custom-hooks";

// Words and small pieces shared by the tabs of WhatsApp Control. Nothing here imports the page's logic or kit (they
// import this file), so there is no import cycle.

export const STATUS_LABEL: Record<WhatsAppMessageStatus, string> = {
  queued: "Queued",
  sending: "Sending",
  pending: "Pending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  expired: "Expired",
  skipped: "Skipped",
};

/** What each status means, in a sentence HR can read without knowing how the queue works. */
export const STATUS_HELP: Record<WhatsAppMessageStatus, string> = {
  queued: "Waiting its turn in the sending queue.",
  sending: "Being sent right now.",
  pending: "Handed to Meta, waiting for it to confirm.",
  sent: "Accepted by Meta (one grey tick), not yet on the phone.",
  delivered: "Reached the employee's phone (two grey ticks).",
  read: "Opened by the employee (two blue ticks).",
  failed: "Could not be sent or delivered. It is not re-sent automatically.",
  expired: "Too late to be useful, so it was never sent.",
  skipped: "Held back by a rule (a switch, no approved template, No WhatsApp), so it was never sent.",
};

export const STATUS_ORDER: WhatsAppMessageStatus[] = [
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
  "expired",
  "skipped",
];

export const KIND_LABEL: Record<WhatsAppMessageKind, string> = {
  code: "Code",
  requested: "Requested",
  automatic: "Auto",
  document: "Document",
};

export const KIND_HELP: Record<WhatsAppMessageKind, string> = {
  code: "A one-time sign-in code",
  requested: "Something the employee asked for",
  automatic: "Sent automatically by the HRMS",
  document: "A document HR sent",
};

/** What the message's failure/reason text means for its status. */
export function reasonLabel(status: WhatsAppMessageStatus | string): string {
  if (status === "skipped") return "Skipped because";
  if (status === "expired") return "Expired because";
  return "Failure reason";
}

/** Red for a real failure; a message held back by a rule or by the clock is not one. */
export const reasonTone = (status: WhatsAppMessageStatus | string): string =>
  status === "skipped" || status === "expired"
    ? "text-orange-700 dark:text-orange-300"
    : "text-red-700 dark:text-red-300";

// The server's catalog owns the list of modules; these labels and hints are only for the ones
// known today (an unknown key falls back to its own name).
export const CATEGORY_LABEL: Record<string, string> = {
  signin: "Sign-in codes",
  documents: "Documents",
  otp: "OTP & Login",
  attendance: "Attendance",
  approvals: "Approvals",
  hod: "Department Heads",
  geo: "Geo Attendance",
  geo_alerts: "On-Duty tracking alerts",
  visitors: "Visitors",
  outpass: "Outpass & Gate",
  other: "Other",
};

export const CATEGORY_HELP: Record<string, string> = {
  documents: "Salary slips, ID cards, letters and employee documents",
  otp: "Sign-in, activation and password-reset codes",
  attendance: "Absent, late, punch reminders and missing-punch messages",
  approvals: "Leave, permission, outpass, missing punch and other approvals",
  hod: "New requests waiting for a Department Head, and the scheduled reminder",
  geo: "Geo Attendance and punch approvals and rejections",
  geo_alerts: "Location off, permission or background restrictions, missing Geo-Punches, reminders, tracking stopped",
  visitors: "Visitor arrivals, with the visitor's phone number",
  outpass: "Gate OUT and IN confirmations",
  other: "Anything else",
};

export const CATEGORIES: string[] = [
  "documents",
  "otp",
  "attendance",
  "approvals",
  "hod",
  "geo",
  "geo_alerts",
  "visitors",
  "outpass",
];

/** The HRMS workflows a message can come from (whatsapp_catalog.APPROVAL_MODULES and the On-Duty ones). */
export const WORKFLOWS: { key: string; label: string }[] = [
  { key: "leave", label: "Leave" },
  { key: "permission", label: "Permission" },
  { key: "casual_leave", label: "Casual Leave" },
  { key: "missing_punch", label: "Missing Punch" },
  { key: "outpass", label: "Gate Outpass" },
  { key: "attendance_correction", label: "Attendance Correction" },
  { key: "holiday_work", label: "Holiday Work Compensation" },
  { key: "birthday_compensation", label: "Birthday Compensation" },
  { key: "resignation", label: "Resignation" },
  { key: "advance", label: "Advance" },
  { key: "request", label: "Other Requests" },
  { key: "on_duty", label: "On-Duty request" },
  { key: "on_duty_punch", label: "On-Duty punch" },
];

export const categoryLabel = (key: string): string => CATEGORY_LABEL[key] ?? key;

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function useDebounced<T>(value: T, ms = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Shows text the way WhatsApp does: *bold* and _italic_ instead of the raw marks. */
export function WhatsAppText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) return <b key={i}>{part.slice(1, -1)}</b>;
        if (part.length > 2 && part.startsWith("_") && part.endsWith("_")) return <i key={i}>{part.slice(1, -1)}</i>;
        return part;
      })}
    </>
  );
}

export function StatusPill({ status }: { status: WhatsAppMessageStatus | string }) {
  const tone = WHATSAPP_STATUS_TONE[status] ?? "neutral";
  return (
    <span title={STATUS_HELP[status as WhatsAppMessageStatus]} data-status={status} className="inline-flex">
      <StatusBadge tone={tone}>{STATUS_LABEL[status as WhatsAppMessageStatus] ?? status}</StatusBadge>
    </span>
  );
}

/** A small, quiet tag for why a message was sent (code, requested, automatic, document). */
export function KindTag({ kind }: { kind: string }) {
  const label = KIND_LABEL[kind as WhatsAppMessageKind] ?? kind;
  return (
    <Badge
      variant="outline"
      className="ml-1.5 px-1 py-0 text-[9px] font-medium text-muted-foreground"
      title={KIND_HELP[kind as WhatsAppMessageKind]}
      data-testid="whatsapp-message-kind"
    >
      {label}
    </Badge>
  );
}

/** "Are you sure?" in the page's dialog style. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
  testId,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-md" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogDescription asChild>
          <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
        </DialogDescription>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={pending}
            data-testid={testId ? `${testId}-confirm` : undefined}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Kept for Gmail Control, which imports them from here (gmail-control/shared.tsx) ─────────────────────────────────

export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  color,
}: {
  label: string;
  value: number | string;
  sub?: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  color: string;
}) {
  return (
    <div className={`rounded-2xl p-4 flex items-start gap-3 ${color}`}>
      <div className="mt-0.5 opacity-80">
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium opacity-70">{label}</p>
        <p className="text-2xl font-black tabular-nums">{value}</p>
        {sub && <p className="text-xs opacity-60 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-3 py-1.5 text-sm">
      <span className="text-xs font-semibold text-gray-500 pt-0.5">{label}</span>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}
