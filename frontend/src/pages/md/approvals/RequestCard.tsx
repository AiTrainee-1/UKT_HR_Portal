import { useId, useState } from "react";
import { AlertTriangle, Check, ChevronRight, Lock, X } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { cn } from "@/lib/utils";
import { useDecide } from "./api";
import { agoText, approvalWarning, stateTone, stepName, whenText } from "./logic";
import type { ApprovalItem, Decision, Hod } from "./types";

const GROUP_CHIP: Record<ApprovalItem["group"], string> = {
  leave: "md-chip md-chip-wine",
  permission: "md-chip md-chip-sand",
  other: "md-chip",
};

const STATE_CHIP: Record<ReturnType<typeof stateTone>, string> = {
  warning: "md-chip md-chip-warning",
  success: "md-chip md-chip-success",
  danger: "md-chip md-chip-danger",
  neutral: "md-chip",
};

/** The pipeline in one line: each step, who decided it, and the step it is waiting at. */
function Steps({ steps }: { steps: ApprovalItem["steps"] }) {
  if (steps.length === 0) return null;
  return (
    <ol
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-md-ink-soft"
      aria-label="Approval steps"
    >
      {steps.map((s, i) => {
        const done = s.state === "approved";
        const rejected = s.state === "rejected";
        const now = s.state === "pending";
        return (
          <li key={i} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight size={12} aria-hidden="true" className="text-md-ink/30" />}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold",
                done && "bg-md-success-600/10 text-md-success-700",
                rejected && "bg-md-danger-600/10 text-md-danger-700",
                now && "bg-md-warning-500/15 text-md-warning-800",
                !done && !rejected && !now && "bg-md-ink/5",
              )}
            >
              {done && <Check size={11} aria-hidden="true" />}
              {rejected && <X size={11} aria-hidden="true" />}
              {stepName(s)}
              {s.state === "skipped" && " (skipped)"}
              {now && " · now"}
            </span>
            {s.by && <span className="text-md-ink-soft">by {s.by}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** One request submitted to the Department Head: who, what, when, why, where it stands, and (when it is the head's turn)
 *  Approve / Reject with a confirm step that takes an optional comment. */
export default function RequestCard({ item, hod }: { item: ApprovalItem; hod: Hod }) {
  const [asking, setAsking] = useState<Decision | null>(null);
  const [comment, setComment] = useState("");
  const decide = useDecide();
  const commentId = useId();
  const who = item.employee.name || item.employee.code || "the employee";
  const warning = asking === "approved" ? approvalWarning(item) : null;
  const when = whenText(item);
  const ago = agoText(item.submittedAt);

  const send = () => {
    if (!asking) return;
    const decision = asking;
    decide.mutate(
      { managerId: hod.id, kind: item.kind, id: item.id, decision, comment: comment.trim() || undefined },
      {
        onSuccess: (res) => {
          setAsking(null);
          setComment("");
          const next =
            res.item?.state === "pending"
              ? ` It now waits for ${res.item.statusLabel.replace(/^Waiting for /, "")}.`
              : "";
          toast({
            title: `${decision === "approved" ? "Approved" : "Rejected"}: ${who}'s ${item.kindLabel.toLowerCase()}`,
            description: `Recorded as ${res.actor}.${next}`,
          });
        },
      },
    );
  };

  return (
    <article
      className="rounded-2xl border border-white/80 bg-white/55 p-4 shadow-sm backdrop-blur @container"
      data-testid={`md-approval-${item.key}`}
      aria-label={`${item.kindLabel} request from ${who}`}
    >
      <div className="flex flex-col gap-2 @xl:flex-row @xl:items-start @xl:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={GROUP_CHIP[item.group]}>{item.kindLabel}</span>
            <p className="min-w-0 break-words text-sm font-extrabold text-md-ink">
              {who}
              {item.employee.code && (
                <span className="ml-1.5 text-xs font-semibold tabular-nums text-md-ink-soft">{item.employee.code}</span>
              )}
            </p>
            {item.employee.department && <span className="text-xs text-md-ink-soft">· {item.employee.department}</span>}
          </div>
          <p className="mt-1.5 text-[13px] font-semibold text-md-ink">
            {item.title}
            {when && <span className="font-medium text-md-ink-soft"> · {when}</span>}
            {item.detail && <span className="font-medium text-md-ink-soft"> · {item.detail}</span>}
          </p>
          {item.reason && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-md-ink-soft" title={item.reason}>
              “{item.reason.trim()}”
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 @xl:shrink-0 @xl:flex-col @xl:items-end @xl:text-right">
          <span className={STATE_CHIP[stateTone(item.state)]} data-testid="md-approval-state">
            {item.statusLabel}
          </span>
          {ago && <span className="text-[11px] text-md-ink-soft">Sent {ago}</span>}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Steps steps={item.steps} />
        {!asking && (item.canApprove || item.canReject) && (
          <div className="ml-auto flex items-center gap-2">
            {item.canReject && (
              <button
                type="button"
                className="md-btn md-btn-danger md-btn-sm"
                onClick={() => setAsking("rejected")}
                data-testid="md-approval-reject"
              >
                <X size={14} aria-hidden="true" /> Reject
              </button>
            )}
            {item.canApprove && (
              <button
                type="button"
                className="md-btn md-btn-primary md-btn-sm"
                onClick={() => setAsking("approved")}
                data-testid="md-approval-approve"
              >
                <Check size={14} aria-hidden="true" /> Approve
              </button>
            )}
          </div>
        )}
      </div>

      {item.blockedReason && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-md-ink-soft" data-testid="md-approval-blocked">
          <Lock size={13} aria-hidden="true" className="mt-px shrink-0" />
          {item.blockedReason}
        </p>
      )}

      {asking && (
        <div
          className={cn(
            "mt-3 rounded-xl border p-3",
            asking === "approved"
              ? "border-md-wine/20 bg-md-wine/[0.04]"
              : "border-md-danger-600/25 bg-md-danger-600/[0.05]",
          )}
          data-testid="md-approval-confirm"
        >
          <p className="text-[13px] font-bold text-md-ink">
            {asking === "approved" ? "Approve" : "Reject"} {who}'s {item.kindLabel.toLowerCase()} for {hod.name}?
          </p>
          <p className="mt-0.5 text-xs text-md-ink-soft">
            It is decided at {hod.name}'s step and recorded in your name. The employee is told as usual.
          </p>
          {warning && (
            <p className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-md-danger-700">
              <AlertTriangle size={13} aria-hidden="true" className="mt-px shrink-0" />
              {warning}
            </p>
          )}
          <label htmlFor={commentId} className="mt-3 block text-xs font-bold text-md-ink">
            Comment <span className="font-medium text-md-ink-soft">(optional, the employee sees it)</span>
          </label>
          <textarea
            id={commentId}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={500}
            rows={2}
            className="mt-1 w-full resize-y rounded-lg border border-md-ink/15 bg-white/80 px-3 py-2 text-sm text-md-ink outline-none focus-visible:border-md-wine focus-visible:ring-2 focus-visible:ring-md-wine/20"
            data-testid="md-approval-comment"
          />
          {decide.isError && (
            <p role="alert" className="mt-2 text-xs font-semibold text-md-danger-700" data-testid="md-approval-error">
              {describeMdError(decide.error)}
            </p>
          )}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="md-btn md-btn-ghost md-btn-sm"
              onClick={() => {
                setAsking(null);
                decide.reset();
              }}
              disabled={decide.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className={cn("md-btn md-btn-sm", asking === "approved" ? "md-btn-primary" : "md-btn-danger")}
              onClick={send}
              disabled={decide.isPending}
              data-testid="md-approval-send"
            >
              {decide.isPending
                ? "Saving…"
                : asking === "approved"
                  ? `Approve for ${hod.name}`
                  : `Reject for ${hod.name}`}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
