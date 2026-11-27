import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  HandCoins,
  Hourglass,
  Inbox,
  Info,
  Lock,
  Plus,
  Search,
  Settings2,
  Stamp,
  Wallet,
  XCircle,
} from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import WorkflowFlow from "@/components/settlement-flow/WorkflowFlow";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PillTabs, type PillTabItem } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { canApprove, canEdit, useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  getSettlementMonthQueryKey,
  useSettlementFinalBulk,
  useSettlementFinalDecision,
  useSettlementHrNote,
  useSettlementHrReview,
  useSettlementHrReviewBulk,
  useSettlementMonth,
  useSettlementResolve,
  useSettlementResolveBulk,
  useSettlementRework,
  type SettlementAdvanceType,
  type SettlementBatch,
  type SettlementBatchItem,
  type SettlementFinalInput,
  type SettlementResolveHow,
} from "@/lib/api-client/custom-hooks/settlement-automation";
import { kindFor } from "@/lib/hr-access";
import { cn } from "@/lib/utils";
import { useCompany } from "../../report-log/useCompany";
import { TYPE_LABEL } from "../logic";
import { earnedRange } from "../rules";
import { BulkDialog, type BulkAction } from "../bulk";
import { useLeaveCalendar } from "../LeaveCalendarButton";
import NewRequestDialog from "../NewRequestDialog";
import PageHeading from "../PageHeading";
import { EmptyState, StatCard } from "../parts";
import { formatMoney } from "../shared";
import { useFlash } from "../table-kit";
import AutomationBulkBar, { type BulkButton, type BulkKind } from "./BulkActions";
import { ConfirmDialog, FinalDecisionDialog, HrNoteDialog, HrProposalDialog } from "./dialogs";
import { BatchHistory, FilesSent } from "./FilesAndHistory";
import {
  CARD_FILTERS,
  FILTER_LABEL,
  countText,
  filterCounts,
  hrProposalPayload,
  isCardFilter,
  parseFocus,
  requestsShown,
  skippedText,
  type CardFilter,
  type FocusKey,
  type HrProposalEdit,
} from "./focus";
import FocusPanel from "./FocusPanel";
import { monthFromUrl, monthText, monthToUrl, pickBatch, reached, workflowRefusal, type MonthRef } from "./logic";
import MonthSwitcher from "./MonthSwitcher";
import RequestsTable, { type RequestsMode, type RowActionKind } from "./RequestsTable";
import { baseOf, roundedTotalOf, roundingChanged, roundsToZero } from "./rounding";
import StagePanel from "./StagePanel";

/** The address: the month ("" = this month in India), the batch shown ("" = the month's current one), the top tab
 *  ("" = Workflow), the stage or card listed under the tracker (`focus`), and the Requests tab's filter and search. */
const URL_DEFAULTS = { month: "", year: "", batch: "", view: "", focus: "", show: "", q: "" };

/** The page's one row of tabs (owner 2026-11-27): each section on its own tab, nothing stacked or nested. */
export const VIEWS = ["workflow", "requests", "summary", "files", "history"] as const;
export type AutomationView = (typeof VIEWS)[number];
const asView = (raw: string): AutomationView =>
  (VIEWS as readonly string[]).includes(raw) ? (raw as AutomationView) : "workflow";

const STAGE_DOT: Record<SettlementBatch["stage"], string> = {
  hr_review: "bg-amber-400",
  md_review: "bg-violet-500",
  md_changes: "bg-orange-500",
  hr_final: "bg-indigo-500",
  auditor_send: "bg-sky-500",
  auditor_review: "bg-sky-500",
  auditor_changes: "bg-orange-500",
  accounts_send: "bg-teal-500",
  completed: "bg-emerald-500",
};

/** The month's batches as one select beside the month (a dropdown, not a second row of tabs). */
function BatchSelect({
  batches,
  value,
  onChange,
}: {
  batches: SettlementBatch[];
  value: number | null;
  onChange: (id: number) => void;
}) {
  if (batches.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5" data-view-safe data-testid="auto-batches">
      <span className="text-xs font-semibold text-slate-500">Batch</span>
      <Select value={value != null ? String(value) : undefined} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger className="h-9 w-64" aria-label="Batch" data-testid="auto-batch-select">
          <SelectValue placeholder="Choose a batch" />
        </SelectTrigger>
        <SelectContent>
          {batches.map((b) => (
            <SelectItem key={b.id} value={String(b.id)} data-testid={`auto-batch-${b.number}`}>
              <span className="flex items-center gap-2">
                <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", STAGE_DOT[b.stage])} />
                {b.label} · {b.stage === "completed" ? "Completed" : b.stageLabel} · {b.counts.total}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** "1st–20th": the days the batch's leave checks count (Settings' day, kept on each request); "" when unknown. */
function countedDays(batch: Pick<SettlementBatch, "items">): string {
  const through = batch.items.find((i) => i.advance.leaveCheck?.throughDay)?.advance.leaveCheck?.throughDay;
  return through ? earnedRange(through) : "";
}

/** What this login may do on the batch's requests now (from the server's `actions`): HR Review's proposals, the answers
 *  to the MD in HR Rework (MD Changes), HR Final Settlement's final decisions, or the answers to the auditor in HR Rework
 *  (Auditor Changes). */
export function requestsMode(batch: SettlementBatch | null, may: boolean): RequestsMode {
  if (!batch || !may) return null;
  const a = batch.actions;
  switch (batch.stage) {
    case "hr_review":
      return a.canEditHrNotes ? "hr_review" : null;
    case "md_changes":
      return a.canResolveMd || a.canEditHrNotes ? "md_changes" : null;
    case "hr_final":
      return a.canEditFinal ? "hr_final" : null;
    case "auditor_changes":
      return a.canResolveAuditor || a.canEditFinal ? "auditor_changes" : null;
    default:
      return null;
  }
}

/** The summary cards as filters (owner 2026-11-27): a click lists those requests under them. */
type Picker = { active: FocusKey | null; onPick: (filter: CardFilter) => void };

function Headline({ batch, active, onPick }: { batch: SettlementBatch } & Picker) {
  const c = batch.counts;
  const m = batch.amounts;
  // the "as asked" total after the Salary Advance rounding (2026-11-27)
  const rounded = roundedTotalOf(batch);
  const card = (filter: CardFilter) => ({
    onClick: () => onPick(filter),
    active: active === filter,
    title: `Show the ${FILTER_LABEL[filter].toLowerCase()} below`,
  });
  return (
    <div className="space-y-3" data-testid="auto-headline">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          testId="auto-count-received"
          label="Requests received"
          value={c.total}
          sub={`${formatMoney(m.requested)} requested`}
          icon={Inbox}
          tone="bg-slate-100 text-slate-800"
          {...card("all")}
        />
        <StatCard
          testId="auto-count-approved"
          label="Approved"
          value={c.approved}
          sub={
            batch.stage === "hr_review" || batch.stage === "md_review" || batch.stage === "md_changes"
              ? "by the MD so far"
              : "final decisions"
          }
          icon={CheckCircle2}
          tone="bg-green-50 text-green-800"
          {...card("approved")}
        />
        <StatCard
          testId="auto-count-rejected"
          label="Rejected"
          value={c.rejected}
          icon={XCircle}
          tone="bg-red-50 text-red-800"
          {...card("rejected")}
        />
        <StatCard
          testId="auto-count-pending"
          label="Pending decision"
          value={c.undecided}
          sub={batch.stage === "hr_review" ? "not forwarded yet" : undefined}
          icon={Hourglass}
          tone="bg-amber-50 text-amber-800"
          {...card("pending")}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          testId="auto-leave-flags"
          label={`Leave flags${countedDays(batch) ? ` (${countedDays(batch)})` : ""}`}
          value={c.critical + c.warning}
          sub={`${c.critical} critical (more than 3 days) · ${c.warning} warning (3 days)`}
          icon={c.critical > 0 ? AlertOctagon : AlertTriangle}
          tone={
            c.critical > 0
              ? "bg-red-50 text-red-800"
              : c.warning > 0
                ? "bg-orange-50 text-orange-800"
                : "bg-slate-100 text-slate-700"
          }
          {...card("leave")}
        />
        <StatCard
          testId="auto-amount-requested"
          label="Requested"
          value={formatMoney(m.requested)}
          sub={rounded != null ? `Rounded total ${formatMoney(rounded)}` : undefined}
          icon={HandCoins}
          tone="bg-slate-50 text-slate-800"
        />
        <StatCard
          testId="auto-amount-md"
          label="MD approved"
          value={formatMoney(m.mdApproved)}
          icon={Wallet}
          tone="bg-violet-50 text-violet-800"
        />
        <StatCard
          testId="auto-amount-final"
          label="Final approved"
          value={formatMoney(m.finalApproved)}
          sub={
            batch.finalizedAt
              ? batch.finalizedVia === "md"
                ? "finalized by the MD (direct to auditor)"
                : "finalized"
              : "after HR's final settlement"
          }
          icon={Wallet}
          tone="bg-emerald-50 text-emerald-800"
        />
      </div>
      {/* the audit (2026-11-27): what the auditor changed, and what is paid after it */}
      {reached(batch, "auditor_review") && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="auto-audit-figures">
          <StatCard
            testId="auto-auditor-changes"
            label="Auditor changes"
            value={batch.auditor.changes}
            sub={`${batch.auditor.remarks} with a remark${batch.auditor.outcome ? ` · ${OUTCOME_WORD[batch.auditor.outcome]}` : ""}`}
            icon={Stamp}
            tone={batch.auditor.changes > 0 ? "bg-orange-50 text-orange-800" : "bg-slate-100 text-slate-700"}
          />
          <StatCard
            testId="auto-amount-payable"
            label="To be paid (after audit)"
            value={formatMoney(m.payable)}
            sub={
              m.payable !== m.finalApproved
                ? `${formatMoney(m.finalApproved - m.payable)} less than HR's final settlement`
                : "as HR finalized it"
            }
            icon={Wallet}
            tone="bg-teal-50 text-teal-800"
          />
        </div>
      )}
    </div>
  );
}

/** Under the tracker: the batch's requests at a glance, each figure a filter (owner 2026-11-27). */
function FocusCards({ batch, active, onPick }: { batch: SettlementBatch } & Picker) {
  const n = filterCounts(batch.items);
  const tone: Record<CardFilter, string> = {
    all: "border-slate-200 bg-slate-50 text-slate-800",
    approved: "border-green-200 bg-green-50 text-green-800",
    rejected: "border-red-200 bg-red-50 text-red-800",
    pending: "border-amber-200 bg-amber-50 text-amber-800",
    leave:
      n.leave > 0 ? "border-orange-200 bg-orange-50 text-orange-800" : "border-slate-200 bg-slate-50 text-slate-600",
  };
  return (
    <div
      className="grid grid-cols-2 gap-2 sm:grid-cols-5"
      role="group"
      aria-label="Show requests"
      data-testid="auto-focus-cards"
    >
      {CARD_FILTERS.map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => onPick(f)}
          aria-pressed={active === f}
          className={cn(
            "flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300",
            tone[f],
            active === f && "ring-2 ring-current ring-offset-1",
          )}
          data-view-safe
          data-testid={`auto-focus-card-${f}`}
        >
          <span className="text-[12px] font-semibold">{f === "all" ? "Received" : FILTER_LABEL[f]}</span>
          <span className="text-lg font-black tabular-nums" data-testid={`auto-focus-card-${f}-value`}>
            {n[f]}
          </span>
        </button>
      ))}
    </div>
  );
}

const OUTCOME_WORD: Record<NonNullable<SettlementBatch["auditor"]["outcome"]>, string> = {
  approved: "approved by the auditor",
  changes: "changed by the auditor",
  confirmed_by_hr: "confirmed by HR by hand",
};

/**
 * Loan & Advance, Automation Method (owner 2026-11-26), one type's page (2026-11-27: Salary Advance and Term Loan run
 * their own workflows, each on its own page from the sidebar): the type's requests raised in a month go through the
 * workflow batch by batch, HR Review -> MD Review & Approval -> HR Final Settlement -> Send to Auditor -> Auditor Review
 * (HR confirms) -> Send Bank File to Accounts -> Completed. The page opens on this month (India time) and its current
 * batch; earlier months and the month's other batches are a select away. What can be done is the batch's `actions` (the
 * server's), and only for a login with the Loan & Advance edit right for all units.
 */
export default function AutomationSettlement({ advanceType }: { advanceType: SettlementAdvanceType }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const company = useCompany();
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  const period = useMemo(() => monthFromUrl(url.month, url.year), [url.month, url.year]);
  const { data, isLoading, isError, refetch, isFetching } = useSettlementMonth(period.month, period.year, advanceType);
  const batch = pickBatch(data, url.batch);
  const typeLabel = TYPE_LABEL[advanceType];
  const [showNew, setShowNew] = useState(false);

  const queryClient = useQueryClient();
  const hrNote = useSettlementHrNote();
  const hrReview = useSettlementHrReview();
  const hrBulk = useSettlementHrReviewBulk();
  const finalDecision = useSettlementFinalDecision();
  const finalBulk = useSettlementFinalBulk();
  const rework = useSettlementRework();
  const resolve = useSettlementResolve();
  const resolveBulk = useSettlementResolveBulk();
  const [noteItem, setNoteItem] = useState<SettlementBatchItem | null>(null);
  const [finalItem, setFinalItem] = useState<SettlementBatchItem | null>(null);
  const [proposal, setProposal] = useState<{ item: SettlementBatchItem; action: "reduce" | "reject" } | null>(null);
  const [busy, setBusy] = useState<{ id: number; action: RowActionKind } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const [answerAll, setAnswerAll] = useState<SettlementResolveHow | null>(null);
  // the row that just moved between the groups (waiting / approved / rejected) glows where it landed
  const [flashId, flash] = useFlash();
  const leave = useLeaveCalendar();
  const showLeave = (item: SettlementBatchItem) => leave.show(item.advance.id, item.advance.employeeName);

  const editRight = canEdit(user, "settlement");
  const branchScoped = data?.branchScoped === true;
  const may = editRight && !branchScoped;
  const mayNotReason = branchScoped
    ? "A branch login can look at the workflow but not move it: a login for all units does."
    : !editRight
      ? "View only: moving the workflow needs the Loan & Advance edit right."
      : undefined;
  const missingRights = batch
    ? [...new Set(batch.items.map((i) => i.advance.advanceType))].filter(
        (t) => !canApprove(user, kindFor("advance", { advanceType: t })),
      )
    : [];
  const finalizeBlocked =
    missingRights.length > 0
      ? `Finalize decides the advances: your login may not approve ${missingRights
          .map((t) => `${TYPE_LABEL[t]}s`)
          .join(" or ")}.`
      : null;

  const setMonth = (next: MonthRef) => setUrl({ ...monthToUrl(next), batch: "" });

  // the stage or card listed under the tracker: a second click on it closes the list
  const focus = parseFocus(url.focus);
  const pick = (key: FocusKey) => setUrl({ focus: focus === key ? "" : key });
  const showFilter: CardFilter = (CARD_FILTERS as readonly string[]).includes(url.show)
    ? (url.show as CardFilter)
    : "all";

  // what this login may do on the requests now, and the ticked ones (cleared when the batch or its stage changes)
  const mode = requestsMode(batch, may);
  const shownItems = useMemo(
    () => (batch ? requestsShown(batch.items, showFilter, url.q) : []),
    [batch, showFilter, url.q],
  );
  const ticked = shownItems.filter((i) => selected.has(i.id));
  const batchKey = batch ? `${batch.id}:${batch.stage}` : "";
  useEffect(() => setSelected(new Set()), [batchKey]);
  const toggle = (id: number, on: boolean) =>
    setSelected((old) => {
      const next = new Set(old);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggleAll = (on: boolean) => setSelected(on ? new Set(shownItems.map((i) => i.id)) : new Set());
  const refetchMonth = () =>
    queryClient.invalidateQueries({ queryKey: getSettlementMonthQueryKey(period.month, period.year, advanceType) });

  const who = (item: SettlementBatchItem) => item.advance.employeeName;
  const fail = (title: string, err: unknown) =>
    toast({ title, description: workflowRefusal(err, "Something went wrong.").text, variant: "destructive" });

  /** One request's step from its row: the button spins while it saves; the row then glows where it landed. */
  const rowStep = async (
    item: SettlementBatchItem,
    action: RowActionKind,
    run: () => Promise<unknown>,
    done: { title: string; description: string },
    failTitle: string,
  ) => {
    setBusy({ id: item.id, action });
    try {
      await run();
      flash(item.id);
      toast(done);
    } catch (err) {
      if (workflowRefusal(err, "").code === "changed") void refetchMonth();
      fail(failTitle, err);
    } finally {
      setBusy(null);
    }
  };

  const reviewer = batch?.stage === "auditor_changes" ? "the auditor" : "the MD";
  const onAction = (item: SettlementBatchItem, action: RowActionKind) => {
    if (!batch) return;
    const stage = batch.stage;
    switch (action) {
      case "remark":
        return setNoteItem(item);
      case "reduce":
      case "reject":
        return setProposal({ item, action });
      case "final":
        return setFinalItem(item);
      case "keep": {
        // a Salary Advance kept as asked goes at its rounded amount (2026-11-27)
        const asked = roundingChanged(item.rounding) ? `at the rounded ${formatMoney(baseOf(item))}` : "as asked";
        return void rowStep(
          item,
          action,
          () => hrReview.mutateAsync({ itemId: item.id, body: { action: "keep" } }),
          stage === "md_changes"
            ? { title: "Kept as asked", description: `${who(item)}: your answer goes to the MD ${asked}.` }
            : { title: "Kept as asked", description: `${who(item)}'s request goes to the MD ${asked}.` },
          "The proposal could not be changed",
        );
      }
      case "rework":
        return void rowStep(
          item,
          action,
          () => rework.mutateAsync({ itemId: item.id }),
          {
            title: "Reopened for rework",
            description: `${who(item)}'s request waits for your decision again, at the top of the list.`,
          },
          "The request could not be reopened",
        );
      case "accept":
      case "keepOwn": {
        const how: SettlementResolveHow = action === "accept" ? "accept" : "keep";
        const done =
          how === "accept"
            ? stage === "md_changes"
              ? {
                  title: "MD's decision accepted",
                  description: `${who(item)}: the MD's decision is your proposal now.`,
                }
              : {
                  title: "Auditor's change accepted",
                  description: `${who(item)}: the auditor's change is your final settlement now.`,
                }
            : stage === "md_changes"
              ? { title: "Your proposal kept", description: `${who(item)}: the MD sees it again when you resubmit.` }
              : {
                  title: "Your settlement kept",
                  description: `${who(item)}: the auditor sees it again when you resubmit.`,
                };
        return void rowStep(
          item,
          action,
          () => resolve.mutateAsync({ itemId: item.id, how }),
          done,
          `Your answer to ${reviewer} could not be saved`,
        );
      }
    }
  };

  const saveProposal = async (item: SettlementBatchItem, edit: HrProposalEdit) => {
    await hrReview.mutateAsync({ itemId: item.id, body: hrProposalPayload(edit) });
    setProposal(null);
    flash(item.id);
    const answer = batch?.stage === "md_changes";
    toast({
      title: edit.action === "reduce" ? "Smaller amount proposed" : "Rejection proposed",
      description: answer
        ? `${who(item)}: your answer goes to the MD when you resubmit the settlement.`
        : `${who(item)}: the MD sees your proposal and remark when you forward the batch.`,
    });
  };

  // ── Several requests at once: HR Review (approve = keep as asked), HR Final Settlement (within the MD's), or in a
  // rework stage the same answer to the reviewer on each (accept their change / keep HR's own) ──
  const runBulk = async (remark: string) => {
    if (!batch || !bulk || !mode) return;
    const itemIds = ticked.map((i) => i.id);
    try {
      if (mode === "hr_review") {
        await hrBulk.mutateAsync({ batchId: batch.id, itemIds, action: bulk, remark });
        toast({
          title:
            bulk === "approve"
              ? `${countText(itemIds.length)} kept as asked`
              : `Rejection proposed for ${countText(itemIds.length)}`,
          description: "The MD sees your proposals when you forward the batch.",
        });
      } else {
        const reply = await finalBulk.mutateAsync({
          batchId: batch.id,
          itemIds,
          decision: bulk === "approve" ? "approved" : "rejected",
          remark,
        });
        const skipped = reply.skipped ?? [];
        toast({
          title: `Final decision kept for ${countText(itemIds.length - skipped.length)}`,
          description:
            skipped.length > 0 ? `Left out: ${skippedText(batch, skipped)}` : "Nothing is decided until you Finalize.",
          variant: skipped.length > 0 && skipped.length === itemIds.length ? "destructive" : undefined,
        });
      }
      setBulk(null);
      setSelected(new Set());
    } catch (err) {
      if (workflowRefusal(err, "").code === "changed") void refetchMonth();
      throw err;
    }
  };

  const runAnswerAll = async () => {
    if (!batch || !answerAll) return;
    const itemIds = ticked.map((i) => i.id);
    try {
      const reply = await resolveBulk.mutateAsync({ batchId: batch.id, itemIds, how: answerAll });
      const skipped = reply.skipped ?? [];
      const n = countText(itemIds.length - skipped.length);
      toast({
        title:
          answerAll === "accept"
            ? `${batch.stage === "md_changes" ? "MD's decision" : "Auditor's change"} accepted on ${n}`
            : `Your own kept on ${n}`,
        description:
          skipped.length > 0
            ? `Left out: ${skippedText(batch, skipped)}`
            : `${reviewer === "the MD" ? "The MD" : "The auditor"} sees the revised settlement when you resubmit it.`,
        variant: skipped.length > 0 && skipped.length === itemIds.length ? "destructive" : undefined,
      });
      setAnswerAll(null);
      setSelected(new Set());
    } catch (err) {
      if (workflowRefusal(err, "").code === "changed") void refetchMonth();
      throw err;
    }
  };

  const runBulkButton = (kind: BulkKind) => {
    if (kind === "accept" || kind === "keep") setAnswerAll(kind);
    else setBulk(kind);
  };
  const bulkButtons: BulkButton[] =
    mode === "md_changes" || mode === "auditor_changes"
      ? [
          { kind: "accept", label: mode === "md_changes" ? "Accept the MD's decision" : "Accept the auditor's change" },
          { kind: "keep", label: mode === "md_changes" ? "Keep mine" : "Keep HR's settlement" },
        ]
      : [
          { kind: "approve", label: mode === "hr_review" ? "Keep selected as asked" : "Approve selected" },
          { kind: "reject", label: mode === "hr_review" ? "Propose reject" : "Reject selected" },
        ];
  const bulkNote =
    mode === "hr_review"
      ? "HR Review: keep as asked, or propose to reject with one reason; the MD decides."
      : mode === "hr_final"
        ? "Approve at the MD's amount (a request the MD rejected is left out), or reject with one reason."
        : mode === "md_changes"
          ? "Your answer to the MD on each selected request: take the MD's decision, or keep your own proposal."
          : mode === "auditor_changes"
            ? "Your answer to the auditor on each selected request: take the auditor's change, or keep your settlement."
            : undefined;

  const saveNote = async (item: SettlementBatchItem, note: string) => {
    await hrNote.mutateAsync({ itemId: item.id, hrNote: note });
    setNoteItem(null);
    toast({ title: note ? "Note kept" : "Note removed", description: `${item.advance.employeeName}'s request.` });
  };

  const saveFinal = async (item: SettlementBatchItem, body: SettlementFinalInput) => {
    await finalDecision.mutateAsync({ itemId: item.id, body });
    setFinalItem(null);
    flash(item.id);
    toast({
      title: "Final decision kept",
      description: `${item.advance.employeeName}: ${
        body.decision === "approved" ? `approve ${formatMoney(body.amount)}` : "reject"
      }. ${
        batch?.stage === "auditor_changes"
          ? "The auditor sees it when you resubmit the settlement."
          : "Nothing is decided until you Finalize."
      }`,
    });
  };

  const tracker = batch?.tracker ?? data?.tracker ?? [];
  const view = asView(url.view);
  const tabs: PillTabItem[] = [
    { value: "workflow", label: "Workflow" },
    { value: "requests", label: "Requests", count: batch?.items.length ?? 0 },
    { value: "summary", label: "Summary" },
    { value: "files", label: "Files sent", count: batch?.files.length ?? 0 },
    { value: "history", label: "History", count: batch?.history?.length ?? 0 },
  ];
  const noRequests = data ? (
    <Card className="rounded-2xl">
      <CardContent className="p-0">
        <EmptyState
          icon={Inbox}
          title={`No ${typeLabel} requests in ${monthText(period)}`}
          text={
            data.isCurrentMonth
              ? `No ${typeLabel} request has been raised this month yet. Each one joins the month's open ${typeLabel} batch as it arrives.`
              : `No ${typeLabel} request raised in this month is in the workflow.`
          }
          testId="auto-empty"
        />
      </CardContent>
    </Card>
  ) : null;

  return (
    <HrLayout>
      <div
        className="min-w-0 space-y-5"
        data-ui-area="payroll"
        data-testid="settlement-automation"
        data-advance-type={advanceType}
      >
        <PageHeading
          page={advanceType}
          automation
          actions={
            <>
              <Link
                href="/hr/settings?tab=settlement"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                data-testid="auto-settings-link"
              >
                <Settings2 size={14} aria-hidden /> Method and e-mails
              </Link>
              <Button className="h-9 gap-2" onClick={() => setShowNew(true)} data-testid="new-advance">
                <Plus size={15} /> New request
              </Button>
            </>
          }
        >
          {typeLabel}s raised in a month go through their own workflow, batch by batch: HR review, the MD&apos;s
          approval, HR&apos;s final settlement, the auditor and the bank file for Accounts.
        </PageHeading>

        {/* the page's one row of tabs, at the top: each section on its own tab (owner 2026-11-27) */}
        <div className="max-w-full overflow-x-auto" data-testid="auto-tabs">
          <PillTabs
            items={tabs}
            value={view}
            onChange={(next) => setUrl({ view: next === "workflow" ? "" : next })}
            baseColor="#4f46e5"
            size="sm"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3" data-testid="auto-filters">
          <MonthSwitcher value={period} onChange={setMonth} />
          {data && (
            <BatchSelect
              batches={data.batches}
              value={batch?.id ?? null}
              onChange={(id) => setUrl({ batch: id === data.currentBatchId ? "" : String(id) })}
            />
          )}
          {isFetching && !isLoading && <span className="text-[11px] text-slate-400">Refreshing…</span>}
        </div>

        {branchScoped && (
          <p
            className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700"
            data-testid="auto-branch-note"
          >
            <Lock size={14} className="mt-0.5 shrink-0" aria-hidden />
            You are signed in to a branch: you see your branch&apos;s requests only, read-only. The workflow is
            company-wide and is moved by a login for all units.
          </p>
        )}
        {data && data.outsideWorkflow > 0 && view === "requests" && (
          <p
            className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900"
            data-testid="auto-outside-note"
          >
            <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
            {data.outsideWorkflow === 1
              ? `1 ${typeLabel} request of this month was decided outside the workflow`
              : `${data.outsideWorkflow} ${typeLabel} requests of this month were decided outside the workflow`}{" "}
            (on the Normal Method, before the Automation Method was switched on). They are in no batch.
          </p>
        )}

        {isLoading ? (
          <div className="space-y-3" data-testid="auto-loading">
            <Skeleton className="h-28 w-full rounded-2xl" />
            <Skeleton className="h-64 w-full rounded-2xl" />
          </div>
        ) : isError || !data ? (
          <Card className="rounded-2xl">
            <CardContent className="p-0">
              <EmptyState
                icon={AlertTriangle}
                tone="bg-red-50 text-red-600"
                title={`The ${typeLabel} workflow could not be loaded`}
                text="Check your connection and try again."
                testId="auto-error"
              >
                <Button variant="outline" onClick={() => void refetch()}>
                  Retry
                </Button>
              </EmptyState>
            </CardContent>
          </Card>
        ) : view === "workflow" ? (
          <div className="space-y-5" data-testid="auto-view-workflow">
            <Card className="rounded-2xl">
              <CardContent className="p-4 sm:p-5">
                <h3 className="mb-4 text-sm font-bold text-slate-900" data-testid="auto-tracker-title">
                  {typeLabel} · {monthText(period)}
                  {batch ? ` · ${batch.label}` : ""}
                </h3>
                <WorkflowFlow
                  steps={tracker}
                  flow={batch?.flow ?? data.flow ?? null}
                  history={batch?.history ?? []}
                  received={batch?.items.length ?? data.received}
                  label={`${typeLabel} workflow`}
                  variant="hrms"
                  onSelect={
                    batch
                      ? (key: string) => {
                          const next = parseFocus(key);
                          if (next) pick(next);
                        }
                      : undefined
                  }
                  selected={focus && !isCardFilter(focus) ? focus : null}
                />
                {batch && batch.items.length > 0 && (
                  <div className="mt-4 border-t border-slate-100 pt-4">
                    <FocusCards batch={batch} active={focus} onPick={pick} />
                  </div>
                )}
              </CardContent>
            </Card>
            {batch && focus && (
              <FocusPanel batch={batch} focus={focus} onClose={() => setUrl({ focus: "" })} onLeave={showLeave} />
            )}
            {batch ? (
              <StagePanel
                key={batch.id}
                batch={batch}
                recipients={data.recipients}
                may={may}
                mayNotReason={mayNotReason}
                finalizeBlocked={finalizeBlocked}
                company={company.excel}
                onOpenRequests={() => setUrl({ view: "requests" })}
              />
            ) : (
              noRequests
            )}
          </div>
        ) : !batch ? (
          noRequests
        ) : view === "requests" ? (
          <Card className="overflow-hidden rounded-2xl" data-testid="auto-view-requests">
            <CardContent className="p-0">
              <div className="flex flex-wrap items-start justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-slate-900">
                    {typeLabel} requests in {batch.label}
                  </h3>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Leave: orange = 3 days, red = more than 3 days of leave
                    {countedDays(batch) ? ` in the ${countedDays(batch)}` : " in the days the earned salary counts"};
                    click it for the calendar.
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2" data-view-safe>
                  <Select value={showFilter} onValueChange={(v) => setUrl({ show: v === "all" ? "" : v })}>
                    <SelectTrigger className="h-9 w-48 rounded-xl" aria-label="Show" data-testid="auto-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CARD_FILTERS.map((f) => (
                        <SelectItem key={f} value={f} data-testid={`auto-filter-${f}`}>
                          {FILTER_LABEL[f]} ({filterCounts(batch.items)[f]})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="relative">
                    <Search
                      size={14}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
                      aria-hidden
                    />
                    <Input
                      value={url.q}
                      onChange={(e) => setUrl({ q: e.target.value })}
                      placeholder="Search name or code"
                      aria-label="Search the requests"
                      className="h-9 w-52 rounded-xl pl-8 text-sm"
                      data-testid="auto-search"
                    />
                  </div>
                </div>
              </div>
              {mode && batch.items.length > 0 && (
                <AutomationBulkBar
                  ticked={ticked.length}
                  total={shownItems.length}
                  onSelectAll={() => toggleAll(true)}
                  onClear={() => toggleAll(false)}
                  buttons={bulkButtons}
                  onRun={runBulkButton}
                  note={bulkNote}
                  testId="auto-bulk"
                />
              )}
              {batch.items.length === 0 ? (
                <EmptyState
                  icon={Inbox}
                  title="No requests to show"
                  text={
                    branchScoped
                      ? "None of this batch's requests is from your branch."
                      : "This batch holds no requests."
                  }
                  testId="auto-items-empty"
                />
              ) : shownItems.length === 0 ? (
                <EmptyState
                  icon={Search}
                  tone="bg-gray-100 text-gray-500"
                  title="No request matches"
                  text="Try another filter or fewer words."
                  testId="auto-items-no-match"
                >
                  <Button variant="outline" onClick={() => setUrl({ show: "", q: "" })}>
                    Show all
                  </Button>
                </EmptyState>
              ) : (
                <RequestsTable
                  batch={batch}
                  items={shownItems}
                  mode={mode}
                  selected={selected}
                  onToggle={toggle}
                  onToggleAll={toggleAll}
                  onAction={onAction}
                  onLeave={showLeave}
                  busy={busy}
                  canRework={may && batch.actions.canRework === true}
                  flashId={flashId}
                />
              )}
            </CardContent>
          </Card>
        ) : view === "summary" ? (
          <div className="space-y-4" data-testid="auto-view-summary">
            <Headline batch={batch} active={focus} onPick={pick} />
            {focus && isCardFilter(focus) && (
              <FocusPanel batch={batch} focus={focus} onClose={() => setUrl({ focus: "" })} onLeave={showLeave} />
            )}
          </div>
        ) : view === "files" ? (
          <div data-testid="auto-view-files">
            <FilesSent batch={batch} />
          </div>
        ) : (
          <div data-testid="auto-view-history">
            <BatchHistory batch={batch} />
          </div>
        )}

        <HrNoteDialog item={noteItem} onSave={saveNote} onCancel={() => setNoteItem(null)} />
        <HrProposalDialog
          target={proposal}
          onSave={saveProposal}
          onCancel={() => setProposal(null)}
          stage={batch?.stage}
        />
        <BulkDialog
          action={bulk}
          count={ticked.length}
          title={
            mode === "hr_review"
              ? bulk === "approve"
                ? `Keep ${countText(ticked.length)} as asked?`
                : `Propose to reject ${countText(ticked.length)}?`
              : bulk === "approve"
                ? `Approve ${countText(ticked.length)} at the MD's amount?`
                : `Reject ${countText(ticked.length)}?`
          }
          description={
            mode === "hr_review" ? (
              <>
                <p>
                  {bulk === "approve"
                    ? ticked.some((i) => i.rounding)
                      ? "Each one goes to the MD as asked, a Salary Advance at its rounded amount (an earlier proposal on it is cleared)."
                      : "Each one goes to the MD as asked (an earlier proposal on it is cleared)."
                    : "Each one goes to the MD with your proposal to reject it and this reason."}{" "}
                  The MD decides; nothing is final until the settlement is.
                </p>
                {bulk === "approve" && ticked.some(roundsToZero) && (
                  <p className="font-medium text-red-700" data-testid="auto-bulk-zero">
                    {ticked.filter(roundsToZero).length === 1
                      ? "One of them rounds to ₹0 and can only be rejected: untick it or propose to reject it."
                      : `${ticked.filter(roundsToZero).length} of them round to ₹0 and can only be rejected: untick them or propose to reject them.`}
                  </p>
                )}
              </>
            ) : (
              <p>
                {bulk === "approve"
                  ? "Each one is approved at the amount the MD approved; a request the MD rejected is left out."
                  : "Each one is rejected with this reason (a change from the MD's approval)."}{" "}
                Nothing is decided until you Finalize.
              </p>
            )
          }
          onConfirm={runBulk}
          onCancel={() => setBulk(null)}
          testId="auto-bulk-dialog"
        />
        <ConfirmDialog
          open={answerAll !== null}
          tone={answerAll === "keep" ? "blue" : "emerald"}
          title={
            answerAll === "accept"
              ? `Accept ${reviewer === "the MD" ? "the MD's decision" : "the auditor's change"} on ${countText(ticked.length)}?`
              : `Keep your own on ${countText(ticked.length)}?`
          }
          description={
            <p>
              {answerAll === "accept"
                ? batch?.stage === "md_changes"
                  ? "On each one the MD's decision becomes your proposal (a request the MD has not decided is left out)."
                  : "On each one the auditor's reduced amount or rejection becomes your final settlement (a remark alone changes nothing)."
                : batch?.stage === "md_changes"
                  ? "On each one you stand by your own proposal; the MD sees it again when you resubmit."
                  : "On each one you stand by your final settlement; the auditor sees it again when you resubmit."}{" "}
              Rework reopens any of them before you resubmit.
            </p>
          }
          confirmLabel={answerAll === "accept" ? `Accept on ${ticked.length}` : `Keep on ${ticked.length}`}
          onConfirm={runAnswerAll}
          onCancel={() => setAnswerAll(null)}
          testId="auto-answer-dialog"
        />
        {leave.dialog}
        <FinalDecisionDialog
          item={finalItem}
          onSave={saveFinal}
          onCancel={() => setFinalItem(null)}
          stage={batch?.stage}
        />
        {/* a new request joins this month's open batch of this type: the page then shows this month's current batch */}
        <NewRequestDialog
          open={showNew}
          onClose={() => setShowNew(false)}
          fixedType={advanceType}
          onCreated={() => setUrl({ month: "", year: "", batch: "" })}
        />
      </div>
    </HrLayout>
  );
}
