import { CheckCircle2, ChevronRight, Clock, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { WaitingChip } from "@/components/ApprovalTrail";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { explainsWaiting, waitingText } from "@/lib/approval-workflow";
import { REQUEST_STATUS_TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { Chip, InitialsAvatar } from "../settlement/parts";
import { formatDateTime } from "../settlement/shared";
import {
  STAGE_LABEL,
  decisionLines,
  formatPunchTime,
  hrDecides,
  hrRejects,
  punchLabel,
  weekdayOf,
  type MissingRow,
} from "./logic";

type Props = {
  r: MissingRow;
  /** Ticked for the bulk approval (only a request HR may decide can be). */
  selected: boolean;
  onSelect: (selected: boolean) => void;
  busy: boolean;
  onApprove: (r: MissingRow) => void;
  onReject: (r: MissingRow) => void;
  onOpen: (r: MissingRow) => void;
};

/** What the request is waiting for, or how it ended. */
export function StatusChip({ r }: { r: MissingRow }) {
  if (explainsWaiting(r.approval)) return <WaitingChip approval={r.approval} className="rounded" />;
  return (
    <Chip tone={REQUEST_STATUS_TONE[r.status] ?? "neutral"}>
      {r.status === "pending_hod" ? (
        <ShieldAlert size={10} />
      ) : r.status === "pending_hr" ? (
        <ShieldCheck size={10} />
      ) : null}
      {STAGE_LABEL[r.status]}
    </Chip>
  );
}

/** One request: who, which punch they missed and why, who has decided it so far, and what HR may do now. */
export default function RequestCard({ r, selected, onSelect, busy, onApprove, onReject, onOpen }: Props) {
  const canApprove = hrDecides(r);
  const canReject = hrRejects(r);
  const decisions = decisionLines(r);

  return (
    <div
      className={cn(
        "rounded-2xl border bg-white p-4 shadow-sm transition-colors hover:border-gray-300",
        selected && "border-blue-300 bg-blue-50/40",
      )}
      data-testid={`missing-punch-${r.id}`}
    >
      <div className="flex flex-wrap items-start gap-3">
        {canApprove && r.status !== "approved" && r.status !== "rejected" ? (
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelect(v === true)}
            aria-label={`Select the request of ${r.employeeName} for ${r.date}`}
            className="mt-2.5"
            data-testid={`mp-select-${r.id}`}
          />
        ) : null}
        <InitialsAvatar name={r.employeeName} size="lg" />

        <div className="min-w-[220px] flex-1 space-y-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-bold text-gray-900">{r.employeeName}</p>
              <span className="font-mono text-xs text-gray-400">{r.employeeCode}</span>
              <StatusChip r={r} />
            </div>
            <p className="text-xs text-gray-500">
              {[r.department, r.designation, r.branch].filter(Boolean).join(" · ") || "No department"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-gray-50 px-3 py-2 text-xs">
            <span className="flex items-center gap-1.5 text-gray-700">
              <Clock size={13} className="text-violet-500" />
              <strong className="font-mono">{r.date}</strong>
              <span className="text-gray-400">{weekdayOf(r.date)}</span>
            </span>
            <span className="text-gray-700">
              {punchLabel(r)} at <strong className="font-mono">{r.punchTime}</strong>{" "}
              <span className="text-gray-400">({formatPunchTime(r.punchTime)})</span>
            </span>
            <span className="text-gray-400">Requested {formatDateTime(r.createdAt)}</span>
          </div>

          <p className="text-xs italic text-gray-700">"{r.reason}"</p>

          {decisions.length > 0 && (
            <ul className="space-y-0.5" data-testid={`mp-decisions-${r.id}`}>
              {decisions.map((d, i) => (
                <li key={i} className="text-[11px] text-gray-500">
                  <span className="font-semibold">{d.role}:</span>{" "}
                  <span className={d.outcome === "rejected" ? "text-red-600" : "text-green-700"}>{d.outcome}</span>
                  {d.by ? ` by ${d.by}` : ""}
                  {d.at ? ` on ${formatDateTime(d.at)}` : ""}
                  {d.comment ? ` - "${d.comment}"` : ""}
                </li>
              ))}
            </ul>
          )}
          {!r.approval && r.status === "pending_hod" && (
            <p className="text-[11px] text-amber-600">
              No Department Head has acted yet: HR can only approve once the Department Head approves first.
            </p>
          )}
          {r.approval && r.approval.currentStep !== null && !canApprove && (
            <p className="text-[11px] text-amber-600">
              {waitingText(r.approval)}: HR cannot decide this request until that step is done.
            </p>
          )}
          {r.status === "approved" && (
            <p className="text-[11px] text-green-600">
              Added to attendance as a real punch (source: Missing Punch): it flows through the normal attendance
              engine.
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-stretch">
          {canApprove && (
            <Button
              size="sm"
              className="h-8 gap-1.5 bg-green-600 text-xs hover:bg-green-700"
              disabled={busy}
              onClick={() => onApprove(r)}
              title={`Approve the missing punch of ${r.employeeName} on ${r.date}`}
            >
              <CheckCircle2 size={12} /> Approve
            </Button>
          )}
          {canReject && (
            <Button
              size="sm"
              variant="destructive"
              className="h-8 gap-1.5 text-xs"
              disabled={busy}
              onClick={() => onReject(r)}
              title={`Reject the missing punch of ${r.employeeName} on ${r.date}`}
            >
              <XCircle size={12} /> Reject
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-0.5 text-xs"
            onClick={() => onOpen(r)}
            data-testid={`mp-open-${r.id}`}
          >
            Details <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}
