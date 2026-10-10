import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { defaultApplyDate, inMonth, monthBounds, monthTitle } from "./logic";

/** Raise a Casual Leave request for an eligible employee. The date is kept to the month on screen: CL is counted per
 *  calendar month of its date, and that is the month whose eligibility the HR user just looked at. */
export default function ApplyDialog({
  target,
  year,
  month,
  today,
  saving,
  problem,
  onClose,
  onSubmit,
}: {
  target: { employeeId: number; name: string } | null;
  year: number;
  month: number;
  today: string;
  saving: boolean;
  /** What the server refused with, if it did. */
  problem: string | null;
  onClose: () => void;
  onSubmit: (input: { employeeId: number; date: string; reason: string }) => void;
}) {
  const [date, setDate] = useState(defaultApplyDate(year, month, today));
  const [reason, setReason] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const { first, last } = monthBounds(year, month);

  useEffect(() => {
    if (target) {
      setDate(defaultApplyDate(year, month, today));
      setReason("");
      setLocal(null);
    }
  }, [target, year, month, today]);

  const submit = () => {
    if (!target) return;
    if (!date || !inMonth(date, year, month)) {
      setLocal(`Pick a day in ${monthTitle(year, month)}`);
      return;
    }
    setLocal(null);
    onSubmit({ employeeId: target.employeeId, date, reason: reason.trim() });
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm" data-testid="apply-dialog">
        <DialogHeader>
          <DialogTitle>Apply Casual Leave: {target?.name}</DialogTitle>
          <DialogDescription>For {monthTitle(year, month)}. The request starts as Pending.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="cl-date" className="text-xs">
              CL Date
            </Label>
            <Input
              id="cl-date"
              type="date"
              min={first}
              max={last}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="apply-date"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cl-reason" className="text-xs">
              Reason (optional)
            </Label>
            <Input
              id="cl-reason"
              placeholder="e.g. Family function"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="apply-reason"
            />
          </div>
          {(local || problem) && (
            <p
              className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700"
              role="alert"
              data-testid="apply-problem"
            >
              {local ?? problem}
            </p>
          )}
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={submit} disabled={saving} data-testid="apply-submit">
              {saving ? "Submitting…" : "Submit Request"}
            </Button>
          </div>
          <p className="-mt-1 text-[10px] text-muted-foreground">
            Approve it from the Requests tab (or the Department Head can approve it on mobile).
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
