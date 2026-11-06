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
import { TONE, WHATSAPP_STATUS_TONE } from "@/lib/statusTones";
import type {
  WhatsAppCategory,
  WhatsAppMessage,
  WhatsAppMessageKind,
  WhatsAppMessageStatus,
} from "@/lib/api-client/custom-hooks";

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
  pending: "Handed to WhatsApp, waiting for it to confirm.",
  sent: "Accepted by WhatsApp, not yet confirmed on the phone.",
  delivered: "Reached the employee's phone.",
  read: "Opened by the employee.",
  failed: "Could not be sent. It is not re-sent automatically.",
  expired: "Too late to be useful, so it was never sent.",
  skipped: "Blocked by a rule, so it was never sent.",
};

export const STATUS_ORDER: WhatsAppMessageStatus[] = [
  "queued",
  "sending",
  "pending",
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
  code: "A one-time login code",
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
  status === "skipped" || status === "expired" ? "text-orange-700" : "text-red-700";

// The server's catalog owns the list of modules; these labels and hints are only for the ones
// known today (an unknown key falls back to its own name).
export const CATEGORY_LABEL: Record<string, string> = {
  documents: "Documents",
  otp: "OTP & Login",
  attendance: "Attendance",
  approvals: "Approvals",
  geo: "Geo Attendance",
  visitors: "Visitors",
  outpass: "Outpass & Gate",
  other: "Other",
};

export const CATEGORY_HELP: Record<string, string> = {
  documents: "Salary slips, ID cards, letters and employee documents",
  otp: "Login, activation and password-reset codes",
  attendance: "Absent, late, punch reminders and missing-punch messages",
  approvals: "Leave, permission, outpass, missing punch and other approvals",
  geo: "Geo Attendance and punch approvals and rejections",
  visitors: "Visitor arrivals with a tap-to-call card",
  outpass: "Gate OUT and IN confirmations",
  other: "Anything else",
};

export const CATEGORIES: WhatsAppCategory[] = [
  "documents",
  "otp",
  "attendance",
  "approvals",
  "geo",
  "visitors",
  "outpass",
];

export const categoryLabel = (key: string): string => CATEGORY_LABEL[key] ?? key;

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
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
      className="ml-1.5 text-[9px] px-1 py-0 font-medium text-gray-500"
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
          <div className="space-y-2 text-sm text-gray-600">{children}</div>
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

/** Everything about one message, including the exact text that was sent. */
export function MessageDetailDialog({ message, onClose }: { message: WhatsAppMessage | null; onClose: () => void }) {
  if (!message) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {message.typeLabel} <StatusPill status={message.status} />
          </DialogTitle>
        </DialogHeader>
        <div className="divide-y">
          <Row label="Employee">
            {message.employeeName} <span className="text-gray-400">({message.employeeCode})</span>
          </Row>
          <Row label="Module">{message.relatedLabel || message.categoryLabel}</Row>
          <Row label="Status">
            <span className="text-gray-600">
              {STATUS_HELP[message.status as WhatsAppMessageStatus] ?? message.status}
            </span>
          </Row>
          <Row label="Sent to">{message.phone ? `+${message.phone}` : "—"}</Row>
          <Row label="Created">{fmtDateTime(message.createdAt)}</Row>
          {message.sentAt && <Row label="Sent">{fmtDateTime(message.sentAt)}</Row>}
          {message.expiresAt && ["queued", "sending", "expired"].includes(message.status) && (
            <Row label={message.status === "expired" ? "Expired at" : "Expires"}>{fmtDateTime(message.expiresAt)}</Row>
          )}
          <Row label="Last update">{fmtDateTime(message.updatedAt)}</Row>
          <Row label="Trigger">
            {message.automatic ? (
              <Badge variant="outline" className="text-[10px]">
                Automatic
              </Badge>
            ) : (
              <span>Sent by {message.sentBy ?? "HR"}</span>
            )}
            {message.kind && (
              <span className="ml-2 text-xs text-gray-500">
                {KIND_HELP[message.kind as WhatsAppMessageKind] ?? message.kind}
              </span>
            )}
          </Row>
          {typeof message.attempts === "number" && message.attempts > 0 && (
            <Row label="Attempts">{message.attempts}</Row>
          )}
          {message.error && (
            <Row label={reasonLabel(message.status)}>
              <span className={reasonTone(message.status)}>{message.error}</span>
            </Row>
          )}
          {message.providerMessageId && (
            <Row label="Provider ID">
              <code className="text-xs">{message.providerMessageId}</code>
            </Row>
          )}
        </div>
        <div>
          <p className="text-xs font-semibold text-gray-500 mb-1">Message</p>
          <pre className="whitespace-pre-wrap rounded-lg bg-emerald-50 border border-emerald-100 p-3 text-xs text-gray-800 font-sans max-h-64 overflow-auto">
            {message.messageText || "The text of this message wasn't recorded."}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const failedTone = TONE.danger;
