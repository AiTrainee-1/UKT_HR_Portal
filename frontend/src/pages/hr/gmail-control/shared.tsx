import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { EMAIL_STATUS_TONE } from "@/lib/statusTones";
import type { GmailCategory, GmailMessage, GmailMessageStatus } from "@/lib/api-client/custom-hooks";
import { Row, fmtDateTime } from "../whatsapp-control/shared";

// The date, debounce, stat-card and detail-row helpers are the same ones the WhatsApp Control page uses.
export { Row, StatCard, fmtDateTime, useDebounced } from "../whatsapp-control/shared";

export const STATUS_LABEL: Record<GmailMessageStatus, string> = {
  sent: "Sent",
  failed: "Failed",
  blocked: "Not sent",
};

export const STATUS_ORDER: GmailMessageStatus[] = ["sent", "failed", "blocked"];

// The server's catalog owns the list of modules; these labels and hints are only for the ones
// known today (an unknown key falls back to its own name).
export const CATEGORY_LABEL: Record<string, string> = {
  documents: "Documents",
  visitors: "Visitors",
  recruitment: "Recruitment",
  other: "Other",
};

export const CATEGORY_HELP: Record<string, string> = {
  documents: "Salary slips, offer letters, ID cards and resignation letters",
  visitors: "Tells an employee a visitor has arrived at reception",
  recruitment: "Rejection notices and interview invitations",
  other: "The test email and anything else",
};

export const CATEGORIES: GmailCategory[] = ["documents", "visitors", "recruitment", "other"];

export const categoryLabel = (key: string): string => CATEGORY_LABEL[key] ?? key;

export function StatusPill({ status }: { status: GmailMessageStatus | string }) {
  const tone = EMAIL_STATUS_TONE[status] ?? "neutral";
  return <StatusBadge tone={tone}>{STATUS_LABEL[status as GmailMessageStatus] ?? status}</StatusBadge>;
}

/** Everything about one email, including the exact wording that was sent. */
export function MessageDetailDialog({ message, onClose }: { message: GmailMessage | null; onClose: () => void }) {
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
          <Row label="Recipient">
            {message.recipientName || "—"}
            {message.employeeCode && <span className="text-gray-400"> ({message.employeeCode})</span>}
          </Row>
          <Row label="Email address">{message.recipientEmail || "—"}</Row>
          <Row label="Module">{message.categoryLabel}</Row>
          <Row label="Subject">{message.subject || "—"}</Row>
          {message.attachmentName && <Row label="Attachment">{message.attachmentName}</Row>}
          <Row label="Created">{fmtDateTime(message.createdAt)}</Row>
          <Row label="Trigger">
            {message.sentBy ? <span>Sent by {message.sentBy}</span> : <span>Automatic or sent by the system</span>}
          </Row>
          {message.error && (
            <Row label={message.status === "blocked" ? "Why not sent" : "Failure reason"}>
              <span className={message.status === "blocked" ? "text-amber-800" : "text-red-700"}>{message.error}</span>
            </Row>
          )}
        </div>
        <div>
          <p className="text-xs font-semibold text-gray-500 mb-1">Email text</p>
          <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 border p-3 text-xs text-gray-800 font-sans max-h-64 overflow-auto">
            {message.messageText || "The text of this email wasn't recorded."}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
}
