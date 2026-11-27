import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { REMARK_MAX, REMARK_MIN, cleanRemark, serverError } from "./logic";

// Several requests at once (owner 2026-11-27, round 5), on the Normal Method's lists and the Automation Method's Requests
// tab alike: a checkbox per request, Select all (the requests the filter shows), and one Approve / Reject for the ones
// ticked; a rejection asks for one reason for all of them.

export type BulkAction = "approve" | "reject";

/** A request's checkbox (it never opens the row it sits in). */
export function SelectBox({
  checked,
  onChange,
  label,
  testId,
  disabled,
}: {
  checked: boolean | "indeterminate";
  onChange: (next: boolean) => void;
  label: string;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        aria-label={label}
        disabled={disabled}
        className="h-4 w-4 rounded-[5px] border-slate-300 data-[state=checked]:border-[#006496] data-[state=checked]:bg-[#006496] data-[state=indeterminate]:border-[#006496] data-[state=indeterminate]:bg-[#006496] data-[state=indeterminate]:text-white"
        data-testid={testId}
      />
    </span>
  );
}

/** The header checkbox's state from how many of the shown ones are ticked. */
export const allState = (ticked: number, total: number): boolean | "indeterminate" =>
  total > 0 && ticked === total ? true : ticked > 0 ? "indeterminate" : false;

/** The bar above a list: how many are ticked, Select all / Clear, and the bulk Approve / Reject. */
export function BulkBar({
  ticked,
  total,
  onSelectAll,
  onClear,
  onApprove,
  onReject,
  approveLabel = "Approve selected",
  rejectLabel = "Reject selected",
  busy,
  note,
  testId = "bulk-bar",
}: {
  ticked: number;
  /** How many the current filter shows and may be ticked. */
  total: number;
  onSelectAll: () => void;
  onClear: () => void;
  onApprove: () => void;
  onReject: () => void;
  approveLabel?: string;
  rejectLabel?: string;
  busy?: boolean;
  /** A line on what the bulk step does here. */
  note?: ReactNode;
  testId?: string;
}) {
  if (total === 0) return null;
  const any = ticked > 0;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-2 transition-colors",
        any ? "border-sky-100 bg-sky-50/80" : "border-slate-100 bg-slate-50/40",
      )}
      role="region"
      aria-label="Several requests at once"
      data-view-safe
      data-testid={testId}
    >
      <span className="flex min-w-0 items-center gap-1 text-sm">
        <span
          className={cn("font-semibold", any ? "text-[#006496]" : "text-slate-600")}
          data-testid={`${testId}-count`}
        >
          {any ? `${ticked} of ${total} selected` : `${total} can be selected`}
        </span>
        {ticked < total && (
          <Button
            variant="link"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={onSelectAll}
            disabled={busy}
            data-testid={`${testId}-all`}
          >
            Select all ({total})
          </Button>
        )}
        {any && (
          <Button
            variant="link"
            size="sm"
            className="h-8 px-2 text-xs text-slate-500"
            onClick={onClear}
            disabled={busy}
            data-testid={`${testId}-clear`}
          >
            Clear
          </Button>
        )}
      </span>
      {note && <span className="hidden text-xs text-muted-foreground 2xl:inline">{note}</span>}
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="gap-1.5 from-emerald-600 to-emerald-500"
          onClick={onApprove}
          disabled={busy || ticked === 0}
          data-testid={`${testId}-approve`}
        >
          <CheckCircle2 size={14} /> {approveLabel}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="gap-1.5"
          onClick={onReject}
          disabled={busy || ticked === 0}
          data-testid={`${testId}-reject`}
        >
          <XCircle size={14} /> {rejectLabel}
        </Button>
      </span>
    </div>
  );
}

/**
 * Confirms a bulk Approve / Reject: how many and what it does, one remark (the reason, required, for a rejection;
 * optional for an approval), the progress while it runs and the server's words when it is refused. It stays open until
 * `onConfirm` settles.
 */
export function BulkDialog({
  action,
  count,
  title,
  description,
  remarkLabel,
  remarkPlaceholder,
  onConfirm,
  onCancel,
  progress,
  testId = "bulk-dialog",
}: {
  /** null: closed. */
  action: BulkAction | null;
  count: number;
  title: string;
  description: ReactNode;
  remarkLabel?: string;
  remarkPlaceholder?: string;
  onConfirm: (remark: string) => Promise<void>;
  onCancel: () => void;
  /** "Approving 2 of 5…" while it runs. */
  progress?: string | null;
  testId?: string;
}) {
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    if (action) {
      setRemark("");
      setBusy(false);
      setTried(false);
      setRefusal(null);
    }
  }, [action]);

  const reject = action === "reject";
  const problem =
    reject && cleanRemark(remark).length < REMARK_MIN
      ? `Write the reason for rejecting (at least ${REMARK_MIN} characters).`
      : null;

  const confirm = async () => {
    setTried(true);
    if (problem) return;
    setBusy(true);
    setRefusal(null);
    try {
      await onConfirm(cleanRemark(remark));
    } catch (err) {
      setRefusal(serverError(err, "This could not be saved.").text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={action !== null} onOpenChange={(o) => !o && !busy && onCancel()}>
      <AlertDialogContent data-view-safe data-testid={testId} data-action={action ?? undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <Label htmlFor={`${testId}-remark`} className="text-xs">
            {remarkLabel ?? (reject ? "Reason for rejecting (for all of them)" : "Remark (optional, for all of them)")}{" "}
            {reject && <span className="text-red-600">(required)</span>}
          </Label>
          <Textarea
            id={`${testId}-remark`}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            maxLength={REMARK_MAX}
            rows={3}
            placeholder={remarkPlaceholder ?? (reject ? "e.g. Too many leave days this month" : "Anything to note")}
            aria-invalid={!!(tried && problem)}
            disabled={busy}
            data-testid={`${testId}-remark`}
          />
          {tried && problem && (
            <p className="text-xs font-medium text-red-600" role="alert" data-testid={`${testId}-problem`}>
              {problem}
            </p>
          )}
        </div>
        {progress && (
          <p
            className="flex items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs font-medium text-indigo-800"
            role="status"
            aria-live="polite"
            data-testid={`${testId}-progress`}
          >
            <Loader2 size={13} className="animate-spin" aria-hidden /> {progress}
          </p>
        )}
        {refusal && (
          <p
            className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-700"
            role="alert"
            data-testid={`${testId}-error`}
          >
            {refusal}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} data-testid={`${testId}-cancel`}>
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || count === 0}
            className={cn("gap-2", reject ? "bg-red-600 hover:bg-red-700" : "bg-green-600 hover:bg-green-700")}
            data-testid={`${testId}-confirm`}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {reject ? `Reject ${count}` : `Approve ${count}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
