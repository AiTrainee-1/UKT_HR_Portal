import { Check, Clock, X } from "lucide-react";
import { EmptyBlock } from "@/components/md/kit/states";
import { cn } from "@/lib/utils";
import {
  agoText,
  reasonMissingText,
  requestDayText,
  requestedLabel,
  requestedText,
  stepName,
  submittedText,
} from "./logic";
import { DetailsSheet, Fact } from "./parts";
import { DecisionLine } from "./RequestCard";
import type { ApprovalItem, Hod } from "./types";

/** Every step of the approval with who decided it, when, and what they wrote. */
function StepList({ steps }: { steps: ApprovalItem["steps"] }) {
  if (steps.length === 0) return <p className="text-xs text-md-ink-soft">No approval steps recorded.</p>;
  return (
    <ol className="space-y-2" data-testid="md-approval-details-steps">
      {steps.map((s, i) => {
        const Icon = s.state === "approved" ? Check : s.state === "rejected" ? X : Clock;
        return (
          <li key={i} className="flex gap-2.5 rounded-xl bg-white/60 px-3 py-2">
            <span
              className={cn(
                "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                s.state === "approved" && "bg-md-success-600/15 text-md-success-700",
                s.state === "rejected" && "bg-md-danger-600/15 text-md-danger-700",
                s.state !== "approved" && s.state !== "rejected" && "bg-md-ink/5 text-md-ink-soft",
              )}
            >
              <Icon size={13} aria-hidden="true" />
            </span>
            <div className="min-w-0 text-xs">
              <p className="font-bold text-md-ink">
                {stepName(s)}{" "}
                <span className="font-semibold capitalize text-md-ink-soft">
                  · {s.state === "pending" ? "waiting now" : s.state}
                </span>
              </p>
              {(s.by || s.at) && (
                <p className="text-md-ink-soft">
                  {s.by && `by ${s.by}`}
                  {s.at && ` · ${submittedText(s.at)}`}
                </p>
              )}
              {s.comment && <p className="mt-0.5 text-md-ink">“{s.comment}”</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** One request in full: who, what, the request date, the date(s) it is for, the moment it was sent (to the second), the
 *  reason and the approval steps with every remark. The Approve / Reject buttons stay on the request's card. */
export default function RequestDetails({
  item,
  hod,
  open,
  onClose,
}: {
  item: ApprovalItem | undefined;
  hod: Hod;
  open: boolean;
  onClose: () => void;
}) {
  const who = item ? item.employee.name || item.employee.code || "Employee" : "Request";
  return (
    <DetailsSheet
      open={open}
      onClose={onClose}
      title={item ? `${item.kindLabel} · ${who}` : "Request"}
      subtitle={item ? `Sent to ${hod.name} · ${item.statusLabel}` : undefined}
      testId="md-approval-details-sheet"
    >
      {!item ? (
        <EmptyBlock title="This request is not in the list any more">
          It may have been decided or withdrawn. Close this and refresh the page.
        </EmptyBlock>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 rounded-2xl border border-white/80 bg-white/55 p-3.5">
            <Fact label="Employee" wide>
              {who}
              {item.employee.code && <span className="ml-1.5 text-xs text-md-ink-soft">{item.employee.code}</span>}
              <span className="block text-xs font-medium text-md-ink-soft">
                {[item.employee.department, item.employee.designation].filter(Boolean).join(" · ") || "—"}
              </span>
            </Fact>
            <Fact label="Request">{item.title}</Fact>
            <Fact label="Details">{item.detail || "—"}</Fact>
            <Fact label="Request date">{requestDayText(item.submittedAt) || "Not recorded"}</Fact>
            <Fact label={requestedLabel(item)}>{requestedText(item) ?? "Not tied to a date"}</Fact>
            <Fact label="Submitted at" wide>
              <span className="tabular-nums" data-testid="md-approval-details-submitted">
                {submittedText(item.submittedAt) || "Not recorded"}
              </span>
              {item.submittedAt && (
                <span className="ml-1.5 text-xs font-medium text-md-ink-soft">{agoText(item.submittedAt)}</span>
              )}
            </Fact>
            <Fact label={item.reasonLabel || "Reason"} wide>
              {item.reason ? (
                <span className="whitespace-pre-line font-medium" data-testid="md-approval-details-reason">
                  {item.reason}
                </span>
              ) : (
                <span className="font-medium text-md-ink-soft">{reasonMissingText(item)}</span>
              )}
            </Fact>
          </div>
          <DecisionLine item={item} />
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-md-ink-soft">Approval steps</p>
            <StepList steps={item.steps} />
          </div>
          {item.blockedReason && <p className="text-xs text-md-ink-soft">{item.blockedReason}</p>}
        </div>
      )}
    </DetailsSheet>
  );
}
