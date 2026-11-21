import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { REJECT_REMARK_MAX, REJECT_REMARK_MIN, cleanRejectRemark, rejectRemarkProblem } from "@/lib/reject-remark";

/**
 * Reject with a reason: the one dialog every Reject in the HR portal opens (owner brief 2026-11-21). The reason is
 * required (at least REJECT_REMARK_MIN characters) and nothing is sent without it; the employee reads it. While saving
 * the dialog stays open, and a refusal from the server is shown inside it.
 */
export function RejectReasonDialog({
  open,
  title = "Reject this request?",
  description,
  confirmLabel = "Reject",
  busy = false,
  error,
  onCancel,
  onConfirm,
  testIdPrefix = "reject-reason",
}: {
  open: boolean;
  title?: string;
  /** Who and what is being rejected; the dialog adds that the employee sees the reason. */
  description?: ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  /** The server's refusal, shown under the reason. */
  error?: string | null;
  onCancel: () => void;
  /** Called with the cleaned reason, only when it is long enough. */
  onConfirm: (reason: string) => void;
  testIdPrefix?: string;
}) {
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setReason("");
    setTried(false);
  }, [open]);

  const problem = rejectRemarkProblem(reason);
  const length = cleanRejectRemark(reason).length;
  const showProblem = tried && !!problem;

  const submit = () => {
    setTried(true);
    if (problem) {
      box.current?.focus();
      return;
    }
    onConfirm(cleanRejectRemark(reason));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent className="max-w-md" data-testid={`${testIdPrefix}-dialog`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description}
            {description ? " " : ""}A reason is required; the employee sees it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label htmlFor={id} className="text-sm font-semibold text-gray-800">
            Reason for rejecting <span className="font-normal text-red-600">(required)</span>
          </label>
          <Textarea
            id={id}
            ref={box}
            value={reason}
            maxLength={REJECT_REMARK_MAX}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this request rejected?"
            rows={3}
            aria-invalid={showProblem || undefined}
            aria-describedby={`${id}-help`}
            className={cn(showProblem && "border-red-400 focus-visible:ring-red-300")}
            data-testid={`${testIdPrefix}-text`}
          />
          <div id={`${id}-help`} className="flex items-start justify-between gap-3 text-xs">
            <span
              className={showProblem ? "text-red-600" : "text-muted-foreground"}
              role={showProblem ? "alert" : undefined}
            >
              {showProblem ? problem : `At least ${REJECT_REMARK_MIN} characters.`}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {length}/{REJECT_REMARK_MAX}
            </span>
          </div>
          {error && (
            <p
              className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700"
              role="alert"
              data-testid={`${testIdPrefix}-error`}
            >
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy}
            className="gap-1 bg-red-600 hover:bg-red-700"
            data-testid={`${testIdPrefix}-confirm`}
          >
            <XCircle size={14} /> {busy ? "Rejecting..." : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
