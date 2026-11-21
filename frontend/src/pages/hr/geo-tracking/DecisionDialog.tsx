// Geo Attendance: the confirmation every consequential decision goes through (approve / reject an On-Duty request or its punches,
// stop someone's live tracking). It says what will happen in plain words before anything is sent, and an approval or a rejection
// can carry a note for the employee (the API stores it as the review comment). A rejection of an employee's request needs the
// reason (requireComment, owner brief 2026-11-21): nothing is sent until it is written. Built on the portal's own AlertDialog,
// so it looks like every other confirmation (and the MD skin and the Clean theme style it).
import { useEffect, useId, useState, type ReactNode } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { REJECT_REMARK_MAX, cleanRejectRemark, rejectRemarkProblem } from "@/lib/reject-remark";
import { cn } from "@/lib/utils";

export type DecisionTone = "approve" | "reject" | "neutral";

export default function DecisionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone,
  withComment = false,
  requireComment = false,
  commentLabel = "Note for the employee (optional)",
  onConfirm,
  testId = "decision-dialog",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone: DecisionTone;
  /** Offer a note (sent as the review comment). */
  withComment?: boolean;
  /** The note is the reason for rejecting: required (lib/reject-remark), and Confirm sends nothing without it. */
  requireComment?: boolean;
  commentLabel?: string;
  onConfirm: (comment: string | undefined) => void;
  testId?: string;
}) {
  const [comment, setComment] = useState("");
  const [tried, setTried] = useState(false);
  const commentId = useId();
  // a fresh note for every decision
  useEffect(() => {
    if (open) {
      setComment("");
      setTried(false);
    }
  }, [open]);
  const askComment = withComment || requireComment;
  const problem = requireComment ? rejectRemarkProblem(comment) : null;
  const showProblem = tried && !!problem;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {tone === "approve" && <CheckCircle2 size={18} className="text-green-600" aria-hidden />}
            {tone === "reject" && <XCircle size={18} className="text-red-600" aria-hidden />}
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {askComment && (
          <div className="space-y-1.5">
            <label htmlFor={commentId} className="text-xs font-semibold text-gray-700">
              {requireComment ? (
                <>
                  Reason for rejecting <span className="font-normal text-red-600">(required)</span>
                </>
              ) : (
                commentLabel
              )}
            </label>
            <Textarea
              id={commentId}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              maxLength={requireComment ? REJECT_REMARK_MAX : 500}
              placeholder={tone === "reject" ? "Why it is rejected" : "Anything the employee should know"}
              aria-invalid={showProblem || undefined}
              className={cn(showProblem && "border-red-400 focus-visible:ring-red-300")}
              data-testid={`${testId}-comment`}
            />
            {showProblem && (
              <p className="text-xs text-red-600" role="alert" data-testid={`${testId}-problem`}>
                {problem}
              </p>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid={`${testId}-cancel`}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid={`${testId}-confirm`}
            className={cn(
              tone === "approve" && "bg-green-600 bg-none text-white hover:bg-green-700",
              tone === "reject" && "bg-red-600 bg-none text-white hover:bg-red-700",
            )}
            onClick={(e) => {
              if (requireComment) {
                setTried(true);
                // the reason is missing: the dialog stays open and nothing is sent
                if (problem) {
                  e.preventDefault();
                  return;
                }
                onConfirm(cleanRejectRemark(comment));
                return;
              }
              onConfirm(comment.trim() ? comment.trim() : undefined);
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
