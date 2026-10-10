import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle, ExternalLink, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { Textarea } from "@/components/ui/textarea";
import { ApprovalTrail, WaitingChip } from "@/components/ApprovalTrail";
import { explainsWaiting } from "@/lib/approval-workflow";
import {
  REQUEST_STATUSES,
  decisionsHere,
  roleText,
  statusChip,
  waitingDays,
  type HubItem,
  type HubKind,
} from "./logic";
import { EmployeeCell, KindIcon, RequestActions, dateTimeLong, type ActionHandlers } from "./parts";

/** Approve or reject with an optional reason. Used for every Reject, and for an On-Duty approval (which also accepts the
 *  punches the employee has captured, so it is never a single click). */
export function DecisionDialog({
  item,
  mode,
  busy,
  onClose,
  onConfirm,
}: {
  item: HubItem | null;
  mode: "approve" | "reject";
  busy: boolean;
  onClose: () => void;
  onConfirm: (comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  useEffect(() => setComment(""), [item?.key, mode]);
  const reject = mode === "reject";
  const punches = Number(item?.extra.pendingPunchCount ?? 0);
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-testid="decision-dialog">
        <DialogHeader>
          <DialogTitle>{reject ? "Reject this request?" : "Approve this request?"}</DialogTitle>
          <DialogDescription>
            {item && (
              <>
                {item.employee.name}: {item.label}
                {item.summary ? ` (${item.summary})` : ""}.{" "}
                {reject
                  ? "The employee is told it was rejected. You can add the reason below."
                  : item.kind === "on_duty"
                    ? `Approving accepts the punches already captured${punches ? ` (${punches} waiting)` : ""} and issues the outpass.`
                    : "The employee is told it was approved."}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={reject ? "Reason (optional)" : "Note for the employee (optional)"}
          aria-label="Note"
          rows={3}
          data-testid="decision-note"
        />
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(comment)}
            disabled={busy}
            className={reject ? "gap-1 bg-red-600 hover:bg-red-700" : "gap-1 bg-green-600 hover:bg-green-700"}
            data-testid="decision-confirm"
          >
            {reject ? (
              <>
                <XCircle size={14} /> Confirm reject
              </>
            ) : (
              <>
                <CheckCircle size={14} /> Approve
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A general employee request: HR sets where it stands and writes the notes the employee reads. */
export function HandleDialog({
  item,
  busy,
  onClose,
  onSubmit,
}: {
  item: HubItem | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (status: string, notes: string) => void;
}) {
  const [status, setStatus] = useState("in_review");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (!item) return;
    const stored = String(item.extra.storedStatus ?? "pending");
    setStatus(stored === "pending" ? "in_review" : stored);
    setNotes(String(item.extra.hrNotes ?? ""));
  }, [item]);
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-testid="handle-dialog">
        <DialogHeader>
          <DialogTitle>{item?.label ?? "Request"}</DialogTitle>
          <DialogDescription>
            {item?.employee.name}: {item?.summary}
          </DialogDescription>
        </DialogHeader>
        {item?.reason && <p className="rounded-lg border bg-gray-50 p-3 text-sm text-gray-700">{item.reason}</p>}
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-semibold text-gray-500" htmlFor="handle-status">
              Status
            </label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="handle-status" data-testid="handle-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REQUEST_STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold text-gray-500" htmlFor="handle-notes">
              Notes for the employee
            </label>
            <Textarea
              id="handle-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="What was done, or what you need from them"
              data-testid="handle-notes"
            />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(status, notes)} disabled={busy} data-testid="handle-submit">
            Save status
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{label}</p>
      <div className="mt-0.5 text-sm font-semibold text-gray-900">{children}</div>
    </div>
  );
}

/** One request in full: who, what, the whole approval trail, who decided and when, and the buttons that apply. */
export function DetailDialog({
  item,
  kind,
  now,
  busy,
  handlers,
  onClose,
}: {
  item: HubItem | null;
  kind: HubKind | undefined;
  now: Date;
  busy: boolean;
  handlers: ActionHandlers;
  onClose: () => void;
}) {
  const here = item ? decisionsHere(item, kind) : null;
  const chip = item ? statusChip(item) : null;
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto" data-testid="request-detail">
        {item && chip && here && (
          <>
            <DialogHeader>
              <div className="flex items-start gap-3 pr-6">
                <KindIcon kind={item.kind} size={18} />
                <div className="min-w-0">
                  <DialogTitle className="leading-tight">{item.label}</DialogTitle>
                  <DialogDescription className="mt-0.5">{kind?.label ?? item.kind} request</DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="space-y-4">
              <div className="rounded-xl border bg-gray-50 p-3">
                <EmployeeCell item={item} size={40} />
                <p className="mt-2 text-xs text-gray-500">
                  {[
                    item.employee.designation,
                    item.employee.branch,
                    item.employee.type === "production" ? "Production" : "Staff",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={chip.tone} className="capitalize">
                  {chip.label}
                </StatusBadge>
                {item.status === "pending" && explainsWaiting(item.approval) && (
                  <WaitingChip approval={item.approval} />
                )}
                {waitingDays(item, now) >= 3 && (
                  <span className="text-xs font-semibold text-amber-600">Waiting {waitingDays(item, now)} days</span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                {item.details.map((d) => (
                  <Fact key={d.label} label={d.label}>
                    {d.value || "-"}
                  </Fact>
                ))}
              </div>

              {item.reason && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Reason</p>
                  <p className="rounded-lg border bg-gray-50 p-3 text-sm text-gray-700">{item.reason}</p>
                </div>
              )}

              {item.approval && (
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                    Approval {kind?.pipeline ? `(${kind.pipeline})` : ""}
                  </p>
                  <div className="overflow-x-auto">
                    <ApprovalTrail approval={item.approval} />
                  </div>
                  {item.approval.steps
                    .filter((s) => s.comment)
                    .map((s) => (
                      <p
                        key={s.index}
                        className="mt-2 rounded-lg border border-blue-100 bg-blue-50 p-2 text-xs text-blue-800"
                      >
                        {s.label ?? "Step"}: {s.comment}
                      </p>
                    ))}
                </div>
              )}

              {item.decided && (item.decided.by || item.decided.at) && (
                <div className="grid grid-cols-2 gap-3 rounded-lg border p-3" data-testid="decided-by">
                  <Fact label={item.status === "rejected" ? "Rejected by" : "Decided by"}>
                    {item.decided.by ?? "Not recorded"}
                    {item.decided.role ? ` (${roleText(item.decided.role)})` : ""}
                  </Fact>
                  <Fact label="When">{dateTimeLong(item.decided.at)}</Fact>
                  {item.decided.comment && (
                    <div className="col-span-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Note</p>
                      <p className="mt-0.5 text-sm text-gray-700">{item.decided.comment}</p>
                    </div>
                  )}
                </div>
              )}

              <p className="text-xs text-gray-400">Submitted {dateTimeLong(item.submittedAt)}</p>
              {here.why && item.status === "pending" && <p className="text-xs text-gray-500">{here.why}</p>}
            </div>

            <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
              <RequestActions item={item} kind={kind} busy={busy} handlers={handlers} full />
              {kind?.openPath && (kind.mode !== "link" || item.status !== "pending") && (
                <Button
                  variant="ghost"
                  className="w-full gap-1 text-blue-700"
                  onClick={() => handlers.onOpenPage(item, kind)}
                >
                  <ExternalLink size={14} /> Open in {kind.openLabel}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
