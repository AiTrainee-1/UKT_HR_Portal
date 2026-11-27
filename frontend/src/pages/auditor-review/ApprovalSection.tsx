import { useState, type ComponentType, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  Ban,
  CheckCircle2,
  FileSpreadsheet,
  Landmark,
  Loader2,
  Lock,
  MessageSquareText,
  PencilLine,
  Scissors,
  Send,
  UserCheck,
} from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { REMARK_MAX } from "@/pages/hr/settlement/logic";
import { formatDateTime, formatMoney } from "@/pages/hr/settlement/shared";
import type { PortalData, PortalDecision, PortalItem } from "./api";
import {
  DECISION_LABEL,
  bankLines,
  bankMissing,
  bankTotal,
  modifications,
  openDecisions,
  portalTotals,
  refusalText,
  requestsWord,
  sendBlocked,
} from "./logic";
import { CARD, HEADING_FONT, Panel } from "./parts";

const CONFIRM_TITLE: Record<PortalDecision, string> = {
  approved_send_accounts: "Approve the settlement and send the bank file to Accounts?",
  approved_forward_hr: "Approve the settlement and forward it to HR?",
  changes_forward_hr: "Forward your changes to HR?",
};

const ACTION_LABEL: Record<PortalDecision, string> = {
  approved_send_accounts: "Approve & Send to Accounts",
  approved_forward_hr: "Approve & Forward to HR",
  changes_forward_hr: "Forward changes to HR",
};

type IconType = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;

const OPTION_LOOK: Record<PortalDecision, { icon: IconType; badge: string; button: string; ring: string }> = {
  approved_send_accounts: {
    icon: Landmark,
    badge: "bg-emerald-50 text-emerald-700",
    button: "bg-emerald-700 hover:bg-emerald-800",
    ring: "border-emerald-200 hover:border-emerald-300",
  },
  approved_forward_hr: {
    icon: UserCheck,
    badge: "bg-[#006496]/10 text-[#006496]",
    button: "bg-[#006496] hover:bg-[#00547e]",
    ring: "border-[#006496]/25 hover:border-[#006496]/40",
  },
  changes_forward_hr: {
    icon: ArrowRightLeft,
    badge: "bg-amber-50 text-amber-700",
    button: "bg-amber-600 hover:bg-amber-700",
    ring: "border-amber-200 hover:border-amber-300",
  },
};

const OPTION_TEST_ID: Record<PortalDecision, string> = {
  approved_send_accounts: "portal-option-send",
  approved_forward_hr: "portal-option-forward",
  changes_forward_hr: "portal-option-changes",
};

function Addresses({ to, cc }: { to: string[]; cc: string[] }) {
  const pill = "rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11.5px] text-slate-700 break-all";
  return (
    <div className="space-y-1.5 text-[12px]" data-testid="portal-accounts">
      <p className="flex flex-wrap items-center gap-1">
        <span className="w-6 shrink-0 text-[11px] font-semibold text-slate-500">To</span>
        {to.length > 0 ? (
          to.map((e) => (
            <span key={e} className={pill}>
              {e}
            </span>
          ))
        ) : (
          <span className="text-slate-400">No Accounts address is set</span>
        )}
      </p>
      {cc.length > 0 && (
        <p className="flex flex-wrap items-center gap-1">
          <span className="w-6 shrink-0 text-[11px] font-semibold text-slate-500">CC</span>
          {cc.map((e) => (
            <span key={e} className={cn(pill, "text-slate-600")}>
              {e}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/** One of the three answers, as a card: what it does, what goes with it, and why it is closed when it is. */
function OutcomeCard({
  decision,
  title,
  text,
  open,
  closedReason,
  children,
  onChoose,
}: {
  decision: PortalDecision;
  title: string;
  text: string;
  open: boolean;
  closedReason: string | null;
  children?: ReactNode;
  onChoose: () => void;
}) {
  const look = OPTION_LOOK[decision];
  const Icon = look.icon;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-2xl border-2 bg-white p-4 transition-colors",
        open ? look.ring : "border-slate-200 bg-slate-50/70",
      )}
      data-testid={OPTION_TEST_ID[decision]}
      data-open={open ? "true" : "false"}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            open ? look.badge : "bg-slate-100 text-slate-400",
          )}
        >
          <Icon size={19} aria-hidden />
        </span>
        {!open && (
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-500">
            <Lock size={10} aria-hidden /> Not available
          </span>
        )}
      </div>
      <div>
        <h3
          className={cn("text-[15px] font-bold", open ? "text-slate-900" : "text-slate-500")}
          style={{ fontFamily: HEADING_FONT }}
        >
          {title}
        </h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-slate-600">{text}</p>
      </div>
      {children}
      {closedReason && (
        <p
          className="rounded-lg bg-slate-100 px-2.5 py-2 text-[12px] font-medium text-slate-600"
          data-testid={decision === "approved_send_accounts" ? "portal-send-blocked" : `portal-closed-${decision}`}
        >
          {closedReason}
        </p>
      )}
      <div className="mt-auto pt-1">
        <Button
          className={cn("h-10 w-full gap-2 font-semibold", open && look.button)}
          variant={open ? "default" : "outline"}
          onClick={onChoose}
          disabled={!open}
          data-testid={`portal-decide-${decision}`}
        >
          {decision === "approved_send_accounts" ? (
            <Send size={15} aria-hidden />
          ) : decision === "changes_forward_hr" ? (
            <ArrowRightLeft size={15} aria-hidden />
          ) : (
            <CheckCircle2 size={15} aria-hidden />
          )}
          {ACTION_LABEL[decision]}
        </Button>
      </div>
    </div>
  );
}

function ChangeBadge({ item }: { item: PortalItem }) {
  if (item.auditor.action === "reduce")
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
        <Scissors size={11} aria-hidden /> Reduced
      </span>
    );
  if (item.auditor.action === "reject")
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-800">
        <Ban size={11} aria-hidden /> Rejected
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
      <MessageSquareText size={11} aria-hidden /> Remark only
    </span>
  );
}

/** A change as figures: HR's amount -> the auditor's (or rejected). */
function ChangeFigures({ item }: { item: PortalItem }) {
  if (item.auditor.action === "reduce")
    return (
      <span className="inline-flex items-center gap-1.5 tabular-nums">
        <span className="text-slate-400 line-through">{formatMoney(item.final.amount)}</span>
        <ArrowRight size={13} className="text-slate-400" aria-label="to" />
        <b className="font-bold text-amber-800">{formatMoney(item.auditor.amount)}</b>
      </span>
    );
  if (item.auditor.action === "reject")
    return (
      <span className="inline-flex items-center gap-1.5 tabular-nums">
        <span className="text-slate-400 line-through">{formatMoney(item.final.amount)}</span>
        <ArrowRight size={13} className="text-slate-400" aria-label="to" />
        <b className="font-bold text-rose-700">Not paid</b>
      </span>
    );
  return (
    <span className="tabular-nums text-slate-500">
      {item.final.decision === "approved" ? formatMoney(item.final.amount) : "Rejected by HR"} · unchanged
    </span>
  );
}

/**
 * Approval: the settlement as it will be paid (HR's approved total against the total after the audit), every change the
 * auditor made, an optional note to HR, and the three answers as cards. Without changes the auditor approves, either
 * sending the bank file to Accounts themselves (built here in the Payroll bank-file format from the approved requests;
 * the Accounts addresses are shown to check) or leaving it to HR; with changes the only answer is to forward them to HR.
 * Every answer is confirmed first; once submitted, the review is read-only.
 */
export default function ApprovalSection({
  data,
  onSubmit,
  onGoOverview,
}: {
  data: PortalData;
  /** Sends the answer (building the bank file when it goes to Accounts); throws the server's refusal. */
  onSubmit: (decision: PortalDecision, note: string) => Promise<void>;
  onGoOverview: () => void;
}) {
  const t = portalTotals(data);
  const changes = modifications(data);
  const lines = bankLines(data);
  const missing = bankMissing(lines);
  const blocked = sendBlocked(data);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState<PortalDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const submit = async () => {
    if (!confirming) return;
    setBusy(true);
    setRefused(null);
    try {
      await onSubmit(confirming, note.trim());
      setConfirming(null);
    } catch (err) {
      setRefused(refusalText(err, "Your review could not be submitted.").text);
    } finally {
      setBusy(false);
    }
  };
  const choose = (d: PortalDecision) => {
    setRefused(null);
    setConfirming(d);
  };

  const decisions = openDecisions(data);
  const isOpen = (d: PortalDecision) => decisions.includes(d) && (d !== "approved_send_accounts" || !blocked);
  const payments = `${lines.length} ${lines.length === 1 ? "payment" : "payments"}, ${formatMoney(bankTotal(lines))}`;

  return (
    <div className="space-y-5" data-testid="portal-approval">
      <section className={cn(CARD, "overflow-hidden")} data-testid="portal-approval-summary">
        <div className="border-b border-slate-100 px-4 py-3.5 sm:px-5">
          <h2 className="text-[15px] font-bold text-slate-900" style={{ fontFamily: HEADING_FONT }}>
            The settlement as it will be paid
          </h2>
          <p className="text-[12.5px] text-slate-500">
            {data.settlement.title} · {data.settlement.period} · {requestsWord(t.requests)}
          </p>
        </div>
        <div className="grid gap-px bg-slate-100 sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-white px-4 py-4 sm:px-5" data-testid="portal-approval-hr">
            <p className="text-xs font-medium text-slate-500">HR approved</p>
            <p
              className="mt-1 text-2xl font-bold tabular-nums text-slate-900"
              style={{ fontFamily: HEADING_FONT }}
              data-testid="portal-approval-hr-value"
            >
              {formatMoney(t.hrApproved)}
            </p>
            <p className="mt-1 text-[12px] text-slate-500">{requestsWord(t.hrApprovedCount)} approved by HR</p>
          </div>
          <div className="relative bg-white px-4 py-4 sm:px-5" data-testid="portal-approval-after">
            <p className="text-xs font-semibold text-[#006496]">After audit</p>
            <p
              className="mt-1 text-2xl font-bold tabular-nums text-[#00466a]"
              style={{ fontFamily: HEADING_FONT }}
              data-testid="portal-approval-after-value"
            >
              {formatMoney(t.afterAudit)}
            </p>
            <p className="mt-1 text-[12px] text-slate-500">
              {t.difference > 0 ? (
                <span className="font-semibold text-amber-800">{formatMoney(t.difference)} less than HR</span>
              ) : (
                "As HR finalized it"
              )}
            </p>
          </div>
          <div className="bg-white px-4 py-4 sm:px-5" data-testid="portal-approval-approved">
            <p className="text-xs font-medium text-slate-500">Approved · Rejected</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900" style={{ fontFamily: HEADING_FONT }}>
              <span className="text-emerald-700" data-testid="portal-approval-approved-value">
                {t.approved}
              </span>
              <span className="mx-1.5 text-slate-300">/</span>
              <span className={t.rejected ? "text-rose-700" : "text-slate-500"} data-testid="portal-approval-rejected">
                {t.rejected}
              </span>
            </p>
            <p className="mt-1 text-[12px] text-slate-500">
              {t.approved} approved, {t.rejected} rejected
            </p>
          </div>
          <div className="bg-white px-4 py-4 sm:px-5" data-testid="portal-approval-changes">
            <p className="text-xs font-medium text-slate-500">Your changes</p>
            <p
              className={cn("mt-1 text-2xl font-bold tabular-nums", t.changes ? "text-amber-800" : "text-slate-900")}
              style={{ fontFamily: HEADING_FONT }}
            >
              {t.changes}
            </p>
            <p className="mt-1 text-[12px] text-slate-500">
              {t.remarks} {t.remarks === 1 ? "remark" : "remarks"}
            </p>
          </div>
        </div>
      </section>

      <Panel
        title="Your changes"
        description={
          changes.length > 0
            ? `${t.changes} ${t.changes === 1 ? "change" : "changes"} and ${t.remarks} ${
                t.remarks === 1 ? "remark" : "remarks"
              } go to HR with your answer.`
            : undefined
        }
        testId="portal-modifications"
        aside={
          data.canReview ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={onGoOverview}
              data-testid="portal-go-overview"
            >
              <PencilLine size={13} aria-hidden /> Review requests
            </Button>
          ) : undefined
        }
      >
        {changes.length === 0 ? (
          <div className="flex items-start gap-2.5 rounded-xl bg-emerald-50/70 px-3.5 py-3 text-[13px] text-emerald-900">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-700" aria-hidden />
            <p data-testid="portal-no-changes">No changes: the settlement stands as HR finalized it.</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
            {changes.map(({ item, change, remark }) => (
              <li
                key={item.id}
                className={cn(
                  "grid gap-2 px-3.5 py-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.4fr)] sm:items-center sm:gap-4",
                  item.auditor.action === "reject"
                    ? "bg-rose-50/50"
                    : item.auditor.action === "reduce"
                      ? "bg-amber-50/50"
                      : "bg-white",
                )}
                data-testid={`portal-mod-${item.id}`}
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-900">{item.advance.employeeName}</p>
                  <p className="font-mono text-[11.5px] text-slate-500">
                    {item.advance.employeeCode}
                    {item.advance.employeeDepartment ? (
                      <span className="font-sans"> · {item.advance.employeeDepartment}</span>
                    ) : null}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <ChangeBadge item={item} />
                  <ChangeFigures item={item} />
                  <span className="sr-only">{change ?? "Remark only"}</span>
                </div>
                <p className="min-w-0 text-[12.5px] text-slate-600">
                  {remark ? <q className="italic">{remark}</q> : <span className="text-slate-400">No remark</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {data.link.submittedAt ? (
        <div
          className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
          role="status"
          data-testid="portal-approval-done"
        >
          <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-700" aria-hidden />
          <p>
            You submitted this review on <b>{formatDateTime(data.link.submittedAt)}</b>
            {data.link.decision ? `: ${DECISION_LABEL[data.link.decision]}` : ""}. Nothing more is needed from you.
          </p>
        </div>
      ) : !data.canReview ? (
        <div
          className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600"
          data-testid="portal-approval-closed"
        >
          <Lock size={18} className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
          <p>This settlement is no longer waiting for your review, so nothing can be submitted here.</p>
        </div>
      ) : (
        <Panel
          title="Submit your review"
          description="Choose one outcome. Every outcome is confirmed before it is sent; after that your review is read-only."
          testId="portal-submit"
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="portal-note" className="text-[13px] font-semibold text-slate-800">
                  Note to HR <span className="font-normal text-slate-500">(optional)</span>
                </Label>
                <span className="text-[11px] tabular-nums text-slate-400">
                  {note.length}/{REMARK_MAX}
                </span>
              </div>
              <Textarea
                id="portal-note"
                rows={3}
                maxLength={REMARK_MAX}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Anything HR should know about your review"
                className="text-[14px]"
                data-testid="portal-note"
              />
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <OutcomeCard
                decision="approved_send_accounts"
                title="Approve & Send to Accounts"
                text="Approve the settlement as it stands and e-mail the bank file to Accounts yourself."
                open={isOpen("approved_send_accounts")}
                closedReason={blocked}
                onChoose={() => choose("approved_send_accounts")}
              >
                <div className="space-y-2.5 rounded-xl border border-slate-200 bg-slate-50/80 p-3">
                  <p className="flex items-start gap-2 text-[12.5px] text-slate-700">
                    <FileSpreadsheet size={15} className="mt-0.5 shrink-0 text-emerald-700" aria-hidden />
                    <span>
                      Bank file (Payroll format):{" "}
                      <b className="tabular-nums text-slate-900" data-testid="portal-bank-summary">
                        {payments}
                      </b>
                      <span className="block text-[11.5px] text-slate-500">
                        Each approved amount rounded up to the rupee.
                      </span>
                    </span>
                  </p>
                  <Addresses to={data.accounts.to} cc={data.accounts.cc} />
                </div>
                {missing.length > 0 && (
                  <p
                    className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[12px] text-amber-900"
                    data-testid="portal-bank-missing"
                  >
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
                    <span>
                      {missing.map((l) => `${l.employeeName} (${l.employeeCode})`).join(", ")}: no account number or
                      IFSC. Their rows go with the details blank.
                    </span>
                  </p>
                )}
              </OutcomeCard>
              <OutcomeCard
                decision="approved_forward_hr"
                title="Approve & Forward to HR"
                text="Approve the settlement as it stands; HR sends the bank file to Accounts from the HRMS."
                open={isOpen("approved_forward_hr")}
                closedReason={data.hasChanges ? "You changed the settlement: forward the changes to HR." : null}
                onChoose={() => choose("approved_forward_hr")}
              />
              <OutcomeCard
                decision="changes_forward_hr"
                title="Forward changes to HR"
                text={
                  data.hasChanges
                    ? `${requestsWord(t.changes)} reduced or rejected by you go back to HR, who reviews them and finalizes the revised settlement before the bank file goes to Accounts.`
                    : "When you reduce or reject a request, your changes go back to HR to finalize the revised settlement."
                }
                open={isOpen("changes_forward_hr")}
                closedReason={data.hasChanges ? null : "You made no changes: approve the settlement instead."}
                onChoose={() => choose("changes_forward_hr")}
              />
            </div>
          </div>
        </Panel>
      )}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && !busy && setConfirming(null)}>
        <AlertDialogContent className="bg-white" data-testid="portal-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle style={{ fontFamily: HEADING_FONT }}>
              {confirming ? CONFIRM_TITLE[confirming] : ""}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-slate-600">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-slate-50 p-3 text-[13px]">
                  <div className="col-span-2">
                    <dt className="text-[11px] font-medium text-slate-500">Settlement</dt>
                    <dd className="font-semibold text-slate-900">
                      {data.settlement.title}, {data.settlement.period}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium text-slate-500">Approved</dt>
                    <dd className="font-semibold tabular-nums text-slate-900">
                      {t.approved} ({formatMoney(t.afterAudit)})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium text-slate-500">Rejected · changed</dt>
                    <dd className="font-semibold tabular-nums text-slate-900">
                      {t.rejected} · {t.changes} by you
                    </dd>
                  </div>
                </dl>
                {confirming === "approved_send_accounts" && (
                  <p>
                    The bank file ({payments}) goes to {data.accounts.to.join(", ")}
                    {data.accounts.cc.length > 0 ? ` (CC ${data.accounts.cc.join(", ")})` : ""}.
                  </p>
                )}
                {confirming === "approved_forward_hr" && <p>HR then sends the bank file to Accounts.</p>}
                {confirming === "changes_forward_hr" && (
                  <p>HR reviews your changes and finalizes the revised settlement.</p>
                )}
                {note.trim() && (
                  <p className="rounded-lg border border-slate-200 px-3 py-2 text-[12.5px]">
                    <span className="font-semibold text-slate-700">Your note: </span>
                    {note.trim()}
                  </p>
                )}
                <p className="flex items-center gap-1.5 font-medium text-slate-700">
                  <Lock size={13} aria-hidden /> Once submitted, your review can no longer be changed.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {refused && (
            <p
              className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-800"
              role="alert"
              data-testid="portal-confirm-error"
            >
              {refused}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} data-testid="portal-confirm-cancel">
              Cancel
            </AlertDialogCancel>
            <Button
              onClick={() => void submit()}
              disabled={busy}
              className={cn("gap-1.5 font-semibold", confirming && OPTION_LOOK[confirming].button)}
              data-testid="portal-confirm-submit"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {busy ? "Submitting…" : confirming ? ACTION_LABEL[confirming] : "Submit"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
