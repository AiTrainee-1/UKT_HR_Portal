import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  SettlementBatch,
  SettlementBatchItem,
  SettlementFinalInput,
  SettlementStage,
} from "@/lib/api-client/custom-hooks/settlement-automation";
import { cn } from "@/lib/utils";
import { LeaveChip } from "../LeaveChip";
import { REMARK_MAX, REMARK_MIN, TYPE_LABEL, cleanRemark, serverError } from "../logic";
import { MONTHS, formatMoney } from "../shared";
import { useLoanAdvanceRules } from "../rules";
import {
  auditorChangeText,
  auditorReview,
  finalChanged,
  finalEmiText,
  finalMonthsOf,
  finalDefaults,
  finalPayload,
  finalProblems,
  finalReview,
  finalStartText,
  hasProblems,
  requestsText,
  type FinalEdit,
} from "./logic";
import {
  answerText,
  auditorAnswerOf,
  hrProposalProblems,
  mdRemarkOf,
  reduceCeilingText,
  type HrProposalEdit,
} from "./focus";
import { roundingSteps } from "./rounding";

type Refusal = { text: string; code: string | null };

const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function RefusalBox({ refusal, testId }: { refusal: Refusal | null; testId: string }) {
  if (!refusal) return null;
  return (
    <p
      className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-700"
      role="alert"
      data-testid={testId}
    >
      {refusal.text}
    </p>
  );
}

// ─── A step with an optional note: Forward to MD, Proceed to Next Step, Complete without bank file ──

/**
 * Confirms one workflow step, with an optional note that goes into the batch's history (Forward: HR's note to the MD).
 * The dialog stays open while it saves and shows the server's own words when it is refused.
 */
export function NoteActionDialog({
  open,
  title,
  description,
  children,
  noteLabel = "Note (optional)",
  notePlaceholder,
  confirmLabel,
  busyLabel = "Saving…",
  onConfirm,
  onCancel,
  testId,
  wide,
  confirmDisabled,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  noteLabel?: string;
  notePlaceholder?: string;
  confirmLabel: string;
  busyLabel?: string;
  /** Saves the step; throws when the server refuses it (the dialog then shows why and stays open). */
  onConfirm: (note: string) => Promise<void>;
  onCancel: () => void;
  testId: string;
  wide?: boolean;
  confirmDisabled?: boolean;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    if (open) {
      setNote("");
      setBusy(false);
      setRefusal(null);
    }
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await onConfirm(cleanRemark(note));
    } catch (err) {
      setRefusal(serverError(err, "This step could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && !busy && onCancel()}>
      <AlertDialogContent
        className={cn("max-h-[92vh] overflow-y-auto", wide && "sm:max-w-3xl")}
        data-view-safe
        data-testid={testId}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <div className="space-y-1">
          <Label htmlFor={`${testId}-note`} className="text-xs">
            {noteLabel}
          </Label>
          <Textarea
            id={`${testId}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={REMARK_MAX}
            rows={3}
            placeholder={notePlaceholder}
            disabled={busy}
            data-testid={`${testId}-note`}
          />
        </div>
        <RefusalBox refusal={refusal} testId={`${testId}-error`} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} data-testid={`${testId}-cancel`}>
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            onClick={confirm}
            disabled={busy || confirmDisabled}
            className="gap-2"
            data-testid={`${testId}-confirm`}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? busyLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── A step without a note: several requests' answers in a rework stage ─────────

/** Confirms a step that needs no note (accept / keep several requests' answers at once), stays open while it saves and
 *  shows the server's own words when it is refused. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busyLabel = "Saving…",
  tone = "emerald",
  onConfirm,
  onCancel,
  testId,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  tone?: "emerald" | "blue";
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  testId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    if (open) {
      setBusy(false);
      setRefusal(null);
    }
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await onConfirm();
    } catch (err) {
      setRefusal(serverError(err, "This could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && !busy && onCancel()}>
      <AlertDialogContent data-view-safe data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <RefusalBox refusal={refusal} testId={`${testId}-error`} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} data-testid={`${testId}-cancel`}>
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className={cn(
              "gap-2",
              tone === "emerald" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-blue-600 hover:bg-blue-700",
            )}
            data-testid={`${testId}-confirm`}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? busyLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── HR Review: the note to the MD on one request ───────────────────────────────

export function HrNoteDialog({
  item,
  onSave,
  onCancel,
}: {
  item: SettlementBatchItem | null;
  onSave: (item: SettlementBatchItem, note: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    setNote(item?.hrNote ?? "");
    setBusy(false);
    setRefusal(null);
  }, [item]);

  const save = async () => {
    if (!item) return;
    setBusy(true);
    setRefusal(null);
    try {
      await onSave(item, cleanRemark(note));
    } catch (err) {
      setRefusal(serverError(err, "The note could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const a = item?.advance;
  return (
    <AlertDialog open={item !== null} onOpenChange={(o) => !o && !busy && onCancel()}>
      <AlertDialogContent data-view-safe data-testid="hr-note-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Note to the MD: {a?.employeeName}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>
                {a && `${TYPE_LABEL[a.advanceType]} of ${formatMoney(item?.requestedAmount)}`}
                {a?.purpose ? `, for ${a.purpose}` : ""}. The MD reads your note beside the request.
              </p>
              {a && <LeaveChip check={a.leaveCheck} />}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <Label htmlFor="hr-note-text" className="text-xs">
            Note (optional)
          </Label>
          <Textarea
            id="hr-note-text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={REMARK_MAX}
            rows={4}
            placeholder="e.g. Second advance this year; recommend a smaller amount"
            disabled={busy}
            data-testid="hr-note-text"
          />
          <p className="text-right text-[11px] tabular-nums text-gray-400">
            {note.length}/{REMARK_MAX}
          </p>
        </div>
        <RefusalBox refusal={refusal} testId="hr-note-error" />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button type="button" onClick={save} disabled={busy} className="gap-2" data-testid="hr-note-confirm">
            {busy && <Loader2 size={14} className="animate-spin" />}
            Keep note
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── HR Review: HR's proposal on one request (reduce / reject) ──────────────────

/** A Salary Advance's three figures before HR decides (2026-11-27): what was asked for, the eligible limit and the
 *  rounded amount (the "as asked" amount), with how it was rounded under them. */
function RoundingFacts({ item }: { item: SettlementBatchItem }) {
  const r = item.rounding;
  if (!r) return null;
  const fact = (label: string, value: string, testId: string, tone?: string) => (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm font-semibold tabular-nums text-slate-900", tone)} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
  return (
    <div className="space-y-2 rounded-xl border border-slate-100 bg-slate-50/60 p-3" data-testid="hr-proposal-facts">
      <dl className="grid grid-cols-3 gap-3">
        {fact("Requested", formatMoney(r.requested), "hr-proposal-fact-requested")}
        {fact("Eligible limit", r.limit != null ? formatMoney(r.limit) : "—", "hr-proposal-fact-limit")}
        {fact("Rounded", formatMoney(r.rounded), "hr-proposal-fact-rounded", r.zero ? "text-red-600" : undefined)}
      </dl>
      <p className="text-[11px] leading-snug text-muted-foreground" data-testid="hr-proposal-fact-steps">
        {roundingSteps(r)}
      </p>
    </div>
  );
}

/**
 * HR's proposal at HR Review (owner 2026-11-27): Reduce asks for an amount below the one asked for (a Salary Advance:
 * below its rounded amount) and a remark; Reject asks for the reason. The proposal reaches the MD as the MD's starting
 * decision; nothing is final until the settlement is.
 */
export function HrProposalDialog({
  target,
  onSave,
  onCancel,
  stage,
}: {
  target: { item: SettlementBatchItem; action: "reduce" | "reject" } | null;
  onSave: (item: SettlementBatchItem, edit: HrProposalEdit) => Promise<void>;
  onCancel: () => void;
  /** HR Rework (MD Changes): the proposal is HR's answer to the MD, shown beside the MD's own decision. */
  stage?: SettlementStage;
}) {
  const [edit, setEdit] = useState<HrProposalEdit>({ action: "reduce", amount: "", remark: "" });
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    if (!target) return;
    const hr = target.item.hr;
    setEdit({
      action: target.action,
      amount: target.action === "reduce" && hr?.action === "reduce" && hr.amount != null ? String(hr.amount) : "",
      remark: target.item.hrNote ?? "",
    });
    setBusy(false);
    setTried(false);
    setRefusal(null);
  }, [target]);

  const item = target?.item ?? null;
  const problems = item ? hrProposalProblems(item, edit) : {};
  const reduce = edit.action === "reduce";
  const shown = (text: string | undefined) => (tried ? text : undefined);

  const save = async () => {
    if (!item) return;
    setTried(true);
    if (problems.amount || problems.remark) return;
    setBusy(true);
    setRefusal(null);
    try {
      await onSave(item, edit);
    } catch (err) {
      setRefusal(serverError(err, "The proposal could not be kept."));
    } finally {
      setBusy(false);
    }
  };

  const a = item?.advance;
  return (
    <AlertDialog open={target !== null} onOpenChange={(o) => !o && !busy && onCancel()}>
      <AlertDialogContent data-view-safe data-testid="hr-proposal-dialog" data-action={edit.action}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {reduce ? "Propose a smaller amount" : "Propose to reject"}: {a?.employeeName}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>
                {a && `${TYPE_LABEL[a.advanceType]}: ${formatMoney(item?.requestedAmount)} asked for`}
                {a?.purpose ? `, for ${a.purpose}` : ""}.
              </p>
              {stage === "md_changes" && item && (
                <p className="text-gray-700" data-testid="hr-proposal-md">
                  The MD{" "}
                  {item.md.decision === "approved" ? (
                    <>
                      approved <b className="text-gray-900">{formatMoney(item.md.amount)}</b>
                    </>
                  ) : item.md.decision === "rejected" ? (
                    <b className="text-red-700">rejected it</b>
                  ) : (
                    "has not decided it"
                  )}
                  {mdRemarkOf(item) ? `: "${mdRemarkOf(item)}"` : "."}
                </p>
              )}
              <p className="text-xs">
                {stage === "md_changes"
                  ? "This is your answer to the MD: your proposal and remark go back to the MD when you resubmit; the MD decides."
                  : "Your proposal and remark reach the MD as their starting decision on this request; the MD decides."}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {item && <RoundingFacts item={item} />}
        {reduce && (
          <div className="space-y-1">
            <Label htmlFor="hr-proposal-amount" className="text-xs">
              Proposed amount (₹)
            </Label>
            <Input
              id="hr-proposal-amount"
              inputMode="decimal"
              value={edit.amount}
              onChange={(e) => setEdit((x) => ({ ...x, amount: e.target.value }))}
              aria-invalid={!!problems.amount}
              disabled={busy}
              className="w-44"
              data-testid="hr-proposal-amount"
            />
            <p
              className={cn("text-[11px]", shown(problems.amount) ? "font-medium text-red-600" : "text-gray-500")}
              data-testid={shown(problems.amount) ? "hr-proposal-amount-problem" : undefined}
            >
              {shown(problems.amount) ?? (item ? `${upper(reduceCeilingText(item))}.` : "")}
            </p>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="hr-proposal-remark" className="text-xs">
            {reduce ? "Remark" : "Reason for rejecting"} <span className="text-red-600">(required)</span>
          </Label>
          <Textarea
            id="hr-proposal-remark"
            value={edit.remark}
            onChange={(e) => setEdit((x) => ({ ...x, remark: e.target.value }))}
            maxLength={REMARK_MAX}
            rows={3}
            placeholder={reduce ? "e.g. Above the earned limit" : "e.g. Too many leave days this month"}
            aria-invalid={!!shown(problems.remark)}
            disabled={busy}
            data-testid="hr-proposal-remark"
          />
          {shown(problems.remark) && (
            <p className="text-[11px] font-medium text-red-600" role="alert" data-testid="hr-proposal-remark-problem">
              {problems.remark}
            </p>
          )}
        </div>
        <RefusalBox refusal={refusal} testId="hr-proposal-error" />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} data-testid="hr-proposal-cancel">
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className={cn("gap-2", !reduce && "bg-red-600 hover:bg-red-700")}
            data-testid="hr-proposal-confirm"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {reduce ? "Propose this amount" : "Propose to reject"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── HR Final Settlement: one request's final decision, within the MD's ─────────

export function FinalDecisionDialog({
  item,
  onSave,
  onCancel,
  stage,
}: {
  item: SettlementBatchItem | null;
  onSave: (item: SettlementBatchItem, body: SettlementFinalInput) => Promise<void>;
  onCancel: () => void;
  /** HR Rework (Auditor Changes): the decision is HR's answer to the auditor, shown beside the auditor's change. */
  stage?: SettlementStage;
}) {
  const [edit, setEdit] = useState<FinalEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // a Term Loan's months: 1 to Settings' most
  const maxMonths = useLoanAdvanceRules()?.tl.maxMonths ?? null;

  useEffect(() => {
    setEdit(item ? finalDefaults(item) : null);
    setBusy(false);
    setTried(false);
    setRefusal(null);
  }, [item]);

  const patch = (p: Partial<FinalEdit>) => {
    setEdit((e) => (e ? { ...e, ...p } : e));
    setRefusal(null);
  };

  const problems = item && edit ? finalProblems(item, edit, maxMonths) : {};
  const changed = item && edit ? finalChanged(item, edit) : false;
  const mdApproved = item?.md.decision === "approved";
  const approve = edit?.decision === "approved";

  const save = async () => {
    if (!item || !edit) return;
    setTried(true);
    if (hasProblems(problems)) return;
    setBusy(true);
    setRefusal(null);
    try {
      await onSave(item, finalPayload(edit, item));
    } catch (err) {
      setRefusal(serverError(err, "The final decision could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const shown = (text: string | undefined) => (tried || refusal ? text : undefined);
  const a = item?.advance;
  return (
    <AlertDialog open={item !== null} onOpenChange={(o) => !o && !busy && onCancel()}>
      <AlertDialogContent className="max-h-[92vh] overflow-y-auto" data-view-safe data-testid="final-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Final decision: {a?.employeeName}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                {a && `${TYPE_LABEL[a.advanceType]}: ${formatMoney(item?.requestedAmount)} asked for`}
                {a?.purpose ? `, for ${a.purpose}` : ""}.
              </p>
              <p data-testid="final-md">
                The MD{" "}
                {mdApproved ? (
                  <>
                    approved <b className="text-gray-900">{formatMoney(item?.md.amount)}</b>
                  </>
                ) : (
                  <b className="text-red-700">rejected it</b>
                )}
                {item?.md.remark ? `: "${item.md.remark}"` : "."}
              </p>
              {stage === "auditor_changes" && item && (auditorChangeText(item) || item.auditor?.remark) && (
                <p className="text-gray-700" data-testid="final-auditor">
                  The auditor: <b className="text-orange-800">{auditorChangeText(item) ?? "no change"}</b>
                  {item.auditor?.remark ? `: "${item.auditor.remark}"` : "."}
                </p>
              )}
              <p className="text-xs">
                You can only stay within the MD&apos;s decision: lower the amount, move the first deduction month
                {a?.advanceType === "term" ? ", change the repayment months" : ""} or reject. A change from the
                MD&apos;s amount or decision needs a remark.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {item && edit && (
          <div className="space-y-3">
            <div role="radiogroup" aria-label="Final decision" className="grid grid-cols-2 gap-2">
              {(["approved", "rejected"] as const).map((d) => {
                const on = edit.decision === d;
                const blocked = d === "approved" && !mdApproved;
                return (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={busy || blocked}
                    title={blocked ? "The MD rejected this request: it can only stay rejected." : undefined}
                    onClick={() => patch({ decision: d })}
                    className={cn(
                      "rounded-xl border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                      on && d === "approved" && "border-green-300 bg-green-50 text-green-800",
                      on && d === "rejected" && "border-red-300 bg-red-50 text-red-800",
                      !on && "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                    )}
                    data-testid={`final-decision-${d}`}
                  >
                    {d === "approved" ? "Approve" : "Reject"}
                  </button>
                );
              })}
            </div>
            {shown(problems.decision) && (
              <p className="text-xs font-medium text-red-600" role="alert">
                {problems.decision}
              </p>
            )}

            {approve && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="col-span-2 space-y-1 sm:col-span-1">
                  <Label htmlFor="final-amount" className="text-xs">
                    Final amount (₹)
                  </Label>
                  <Input
                    id="final-amount"
                    inputMode="decimal"
                    value={edit.amount}
                    onChange={(e) => patch({ amount: e.target.value })}
                    aria-invalid={!!problems.amount}
                    disabled={busy}
                    data-testid="final-amount"
                  />
                  <p className="text-[11px] text-gray-500">
                    At most the {formatMoney(item.md.amount)} the MD approved.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="final-start-month" className="text-xs">
                    {a?.advanceType === "term" ? "First deduction" : "Deducted in"}
                  </Label>
                  <Select
                    value={String(edit.startMonth)}
                    onValueChange={(v) => patch({ startMonth: Number(v) })}
                    disabled={busy}
                  >
                    <SelectTrigger id="final-start-month" data-testid="final-start-month">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((m, i) => (
                        <SelectItem key={m} value={String(i + 1)}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="final-start-year" className="text-xs">
                    Year
                  </Label>
                  <Input
                    id="final-start-year"
                    inputMode="numeric"
                    value={String(edit.startYear)}
                    onChange={(e) => patch({ startYear: Number(e.target.value) })}
                    disabled={busy}
                    data-testid="final-start-year"
                  />
                </div>
              </div>
            )}
            {approve && a?.advanceType === "term" && (
              <div className="space-y-1">
                <Label htmlFor="final-months" className="text-xs">
                  Repayment months
                </Label>
                <Input
                  id="final-months"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={Math.max(maxMonths ?? 0, finalMonthsOf(item) ?? 0) || undefined}
                  step={1}
                  value={edit.months}
                  onChange={(e) => patch({ months: e.target.value })}
                  aria-invalid={!!problems.months}
                  disabled={busy}
                  className="w-28"
                  data-testid="final-months"
                />
                <p className="text-[11px] text-gray-500" data-testid="final-emi">
                  {!problems.amount && !problems.months
                    ? finalEmiText(item, Number(edit.amount), Number(edit.months)) || "-"
                    : maxMonths != null
                      ? `1 to ${maxMonths} months`
                      : ""}
                </p>
              </div>
            )}
            {(problems.amount || problems.months || problems.start) && (
              <p className="text-xs font-medium text-red-600" role="alert" data-testid="final-problem">
                {problems.amount ?? problems.months ?? problems.start}
              </p>
            )}
            {changed && !problems.amount && (
              <p className="text-xs font-medium text-orange-700" data-testid="final-changed">
                This differs from the MD&apos;s decision: the remark is required and shown to the MD and the auditor.
              </p>
            )}

            <div className="space-y-1">
              <Label htmlFor="final-remark" className="text-xs">
                Remark{" "}
                <span className={changed ? "text-red-600" : "font-normal text-gray-400"}>
                  {changed ? "(required)" : "(optional)"}
                </span>
              </Label>
              <Textarea
                id="final-remark"
                value={edit.remark}
                onChange={(e) => patch({ remark: e.target.value })}
                maxLength={REMARK_MAX}
                rows={3}
                placeholder={changed ? "Why it differs from the MD, e.g. Budget limit" : "Anything to note (optional)"}
                aria-invalid={!!shown(problems.remark)}
                disabled={busy}
                data-testid="final-remark"
              />
              <div className="flex items-start justify-between gap-3 text-[11px]">
                <p
                  className={shown(problems.remark) ? "font-medium text-red-600" : "text-gray-500"}
                  data-testid={shown(problems.remark) ? "final-remark-problem" : undefined}
                >
                  {shown(problems.remark) ?? "The employee is told when the settlement is finalized."}
                </p>
                <p className="shrink-0 tabular-nums text-gray-400">
                  {edit.remark.length}/{REMARK_MAX}
                  {changed && cleanRemark(edit.remark).length < REMARK_MIN ? ` · at least ${REMARK_MIN}` : ""}
                </p>
              </div>
            </div>
          </div>
        )}

        <RefusalBox refusal={refusal} testId="final-error" />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} data-testid="final-cancel">
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            onClick={save}
            disabled={busy || !!problems.amount || !!problems.decision || !!problems.months || !!problems.start}
            className="gap-2"
            data-testid="final-confirm"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Keep this decision
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── Finalize: every decision, the changes from the MD and the totals ───────────

/** The review before Finalize: the list of every final decision and what changed from the MD, with the totals. */
export function FinalizeReview({ batch }: { batch: SettlementBatch }) {
  const review = finalReview(batch);
  return (
    <div className="space-y-3" data-testid="finalize-review">
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Figure label="Approved" value={`${review.approved} · ${formatMoney(review.finalApproved)}`} tone="green" />
        <Figure label="Rejected" value={String(review.rejected)} tone="red" />
        <Figure label="MD approved" value={formatMoney(review.mdApproved)} tone="slate" />
        <Figure label="Changed from the MD" value={String(review.changed)} tone={review.changed ? "orange" : "slate"} />
      </div>
      <div className="max-h-[45vh] overflow-y-auto rounded-xl border border-slate-200">
        <table className="w-full text-left text-[13px]">
          <thead className="sticky top-0 bg-slate-50 text-xs font-medium text-slate-500">
            <tr>
              <th className="px-3 py-2">Employee</th>
              <th className="px-3 py-2">MD</th>
              <th className="px-3 py-2">Final</th>
            </tr>
          </thead>
          <tbody>
            {review.lines.map(({ item, changes }) => (
              <tr
                key={item.id}
                className={cn("border-t border-slate-100 align-top", changes.length > 0 && "bg-orange-50/60")}
                data-testid={`finalize-line-${item.id}`}
              >
                <td className="px-3 py-2">
                  <p className="font-semibold text-slate-900">{item.advance.employeeName}</p>
                  <p className="text-[11px] text-slate-500">
                    {item.advance.employeeCode} · {TYPE_LABEL[item.advance.advanceType]} ·{" "}
                    {formatMoney(item.requestedAmount)} asked
                  </p>
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {item.md.decision === "approved" ? `Approved ${formatMoney(item.md.amount)}` : "Rejected"}
                </td>
                <td className="px-3 py-2">
                  <p className={item.final.decision === "approved" ? "font-semibold text-green-800" : "text-red-700"}>
                    {item.final.decision === "approved"
                      ? `Approved ${formatMoney(item.final.amount)}`
                      : item.final.decision === "rejected"
                        ? "Rejected"
                        : "Not decided"}
                  </p>
                  {finalStartText(item) && (
                    <p className="text-[11px] text-slate-500">Deduction from {finalStartText(item)}</p>
                  )}
                  {changes.length > 0 && (
                    <p className="text-[11px] font-semibold text-orange-700">{changes.join("; ")}</p>
                  )}
                  {item.final.remark && <p className="text-[11px] italic text-slate-600">“{item.final.remark}”</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {review.undecided > 0 && (
        <p className="text-xs font-medium text-red-600" role="alert">
          {requestsText(review.undecided)} still without a final decision.
        </p>
      )}
    </div>
  );
}

// ─── HR Review of Auditor Changes: every change, the remarks and the totals ──────

/** The auditor's changes (2026-11-27): every request reduced or rejected (from -> to), every auditor remark, the
 *  auditor's note to HR, HR's final total against the total with the auditor's changes, and (in HR's rework) HR's answer
 *  on each. Shown on the HR Rework (Auditor Changes) stage card. */
export function AuditorChangesReview({
  batch,
  testId = "auditor-changes",
}: {
  batch: SettlementBatch;
  testId?: string;
}) {
  const review = auditorReview(batch);
  const rework = batch.stage === "auditor_changes";
  return (
    <div className="space-y-3" data-testid={testId}>
      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Figure label="HR final approved" value={formatMoney(review.hrApproved)} tone="slate" />
        <Figure
          label={rework ? "With the auditor's changes" : "After the audit"}
          value={formatMoney(review.payable)}
          tone="green"
        />
        <Figure
          label="Changed by the auditor"
          value={String(review.changes)}
          tone={review.changes ? "orange" : "slate"}
        />
        <Figure label="Approved · rejected" value={`${review.approved} · ${review.rejected}`} tone="slate" />
      </div>
      {batch.auditor.submittedNote && (
        <div
          className="rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-[13px] text-sky-900"
          data-testid={`${testId}-note`}
        >
          <p className="text-[11.5px] font-semibold text-sky-700">The auditor&apos;s note to HR</p>
          <p>{batch.auditor.submittedNote}</p>
        </div>
      )}
      {review.lines.length === 0 ? (
        <p className="text-xs text-slate-500">The auditor changed nothing and left no remark.</p>
      ) : (
        <div className="max-h-[45vh] overflow-y-auto rounded-xl border border-slate-200">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 bg-slate-50 text-xs font-medium text-slate-500">
              <tr>
                <th className="px-3 py-2">Employee</th>
                <th className="px-3 py-2">HR final</th>
                <th className="px-3 py-2">Auditor</th>
                {rework && <th className="px-3 py-2">Your answer</th>}
              </tr>
            </thead>
            <tbody>
              {review.lines.map(({ item, change, remark }) => (
                <tr
                  key={item.id}
                  className={cn("border-t border-slate-100 align-top", change && "bg-orange-50/60")}
                  data-testid={`${testId}-line-${item.id}`}
                >
                  <td className="px-3 py-2">
                    <p className="font-semibold text-slate-900">{item.advance.employeeName}</p>
                    <p className="text-[11px] text-slate-500">
                      {item.advance.employeeCode} · {formatMoney(item.requestedAmount)} asked
                    </p>
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    {item.final.decision === "approved" ? `Approved ${formatMoney(item.final.amount)}` : "Rejected"}
                  </td>
                  <td className="px-3 py-2">
                    {change ? (
                      <p className="font-semibold text-orange-800">{change}</p>
                    ) : (
                      <p className="text-slate-500">No change</p>
                    )}
                    {remark && <p className="text-[11px] italic text-slate-600">“{remark}”</p>}
                  </td>
                  {rework && (
                    <td className="px-3 py-2 text-[12px]" data-testid={`${testId}-answer-${item.id}`}>
                      {auditorAnswerOf(item) === "waiting" ? (
                        <span className="font-semibold text-amber-700">Waiting for your answer</span>
                      ) : (
                        <span className="text-slate-600">{answerText(auditorAnswerOf(item), "auditor") || "-"}</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const FIGURE_TONE = {
  green: "bg-green-50 text-green-800",
  red: "bg-red-50 text-red-800",
  slate: "bg-slate-100 text-slate-800",
  orange: "bg-orange-50 text-orange-800",
};

function Figure({ label, value, tone }: { label: string; value: string; tone: keyof typeof FIGURE_TONE }) {
  return (
    <div className={cn("rounded-xl px-3 py-2", FIGURE_TONE[tone])}>
      <p className="text-[11px] font-semibold opacity-70">{label}</p>
      <p className="text-sm font-bold">{value}</p>
    </div>
  );
}
