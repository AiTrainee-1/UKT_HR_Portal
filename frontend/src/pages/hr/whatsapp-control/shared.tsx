import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { TONE, WHATSAPP_STATUS_TONE } from "@/lib/statusTones";
import type { WhatsAppCategory, WhatsAppMessage, WhatsAppMessageStatus } from "@/lib/api-client/custom-hooks";

export const STATUS_LABEL: Record<WhatsAppMessageStatus, string> = {
  pending: "Pending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
};

export const STATUS_ORDER: WhatsAppMessageStatus[] = ["pending", "sent", "delivered", "read", "failed"];

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
  return <StatusBadge tone={tone}>{STATUS_LABEL[status as WhatsAppMessageStatus] ?? status}</StatusBadge>;
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
          <Row label="Sent to">{message.phone ? `+${message.phone}` : "—"}</Row>
          <Row label="Created">{fmtDateTime(message.createdAt)}</Row>
          <Row label="Last update">{fmtDateTime(message.updatedAt)}</Row>
          <Row label="Trigger">
            {message.automatic ? (
              <Badge variant="outline" className="text-[10px]">
                Automatic
              </Badge>
            ) : (
              <span>Sent by {message.sentBy ?? "HR"}</span>
            )}
          </Row>
          {message.error && (
            <Row label="Failure reason">
              <span className="text-red-700">{message.error}</span>
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
