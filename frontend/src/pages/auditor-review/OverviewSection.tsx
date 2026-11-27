import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Ban,
  BadgeCheck,
  CalendarDays,
  CheckCheck,
  FileText,
  Info,
  Loader2,
  MessageSquarePlus,
  MinusCircle,
  PencilLine,
  Scale,
  Search,
  Undo2,
  X,
  XCircle,
} from "lucide-react";
import { LeaveCalendarDialog } from "@/components/leave-calendar/LeaveCalendar";
import { PersonCell, RowAction, RowActions } from "@/pages/hr/settlement/table-kit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { REMARK_MAX, formatDays } from "@/pages/hr/settlement/logic";
import { formatMoney } from "@/pages/hr/settlement/shared";
import {
  fetchLeaveCalendar,
  type PortalBulkInput,
  type PortalChangeInput,
  type PortalData,
  type PortalItem,
} from "./api";
import ChangeDialog from "./ChangeDialog";
import {
  ROW_FILTERS,
  UNDO_BODY,
  asRowFilter,
  bulkBody,
  bulkProblem,
  bulkSelectable,
  bulkSummary,
  chosenItems,
  filterItems,
  firstEmiMonth,
  hrApproved,
  isChanged,
  isTermSettlement,
  portalTotals,
  refusalText,
  requestsWord,
  rowStatus,
  selectionState,
  termEmi,
  termFixedSalary,
  termMonths,
  toggleAll,
  type BulkAction,
  type ChangeMode,
  type RowFilter,
} from "./logic";
import { AfterAudit, CARD, FOCUS, HEADING_FONT, HrAmount, LeaveCount, RemarkText, StatCard, StatusTag } from "./parts";

// The HRMS table look (owner 2026-11-27: "the All Employees table is the reference"): quiet sentence-case headings, one
// value per column, the employee as initials + name over the code and department.
const TH =
  "sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-2 py-2.5 text-left align-bottom text-xs font-medium text-slate-500";
const TD = "border-b border-slate-100 px-2 py-3 align-middle";
const NUM = "text-right tabular-nums";
const dash = <span className="text-slate-300">—</span>;
const money = (n: number | null | undefined) => (n != null ? formatMoney(n) : dash);

type Column = {
  key: string;
  header: string;
  /** A figure: right-aligned, and listed on a phone's card. */
  figure?: boolean;
  /** The card's shorter label. */
  short?: string;
  className?: string;
  cell: (item: PortalItem, sno: number) => ReactNode;
  total?: ReactNode;
};

/** The amount asked for, marked in words and colour when it is more than the limit. */
function Requested({ item, limit }: { item: PortalItem; limit: number | null | undefined }) {
  const over = limit != null && item.requestedAmount > limit;
  return (
    <span className={cn("tabular-nums", over && "font-semibold text-amber-800")}>
      {formatMoney(item.requestedAmount)}
      {over && <span className="block text-[10.5px] font-semibold text-amber-700">over the limit</span>}
    </span>
  );
}

/** A Term Loan's monthly EMI on HR's approved amount (whole rupees up, the last smaller). */
function Emi({ item }: { item: PortalItem }) {
  if (!hrApproved(item)) return dash;
  const e = termEmi(item.final.amount, termMonths(item));
  if (!e) return dash;
  return (
    <span className="tabular-nums">
      {formatMoney(e.emi)}
      {e.last !== e.emi && <span className="block text-[10.5px] text-slate-500">last {formatMoney(e.last)}</span>}
    </span>
  );
}

/** What is paid after the audit; a Term Loan the auditor reduced also shows its new EMI. */
function After({ item, term, align }: { item: PortalItem; term: boolean; align?: "left" | "right" }) {
  const e = term && rowStatus(item) === "reduced" ? termEmi(item.auditor.amount, termMonths(item)) : null;
  return (
    <div className={cn("flex flex-col gap-0.5", align === "left" ? "items-start" : "items-end")}>
      <AfterAudit item={item} align={align} />
      {e && <span className="text-[10.5px] font-medium text-amber-800">new EMI {formatMoney(e.emi)}</span>}
    </div>
  );
}

function Employee({ item }: { item: PortalItem }) {
  const a = item.advance;
  return (
    <div className="max-w-[15rem]" title={a.employeeDesignation ?? undefined}>
      <PersonCell name={a.employeeName} code={a.employeeCode} department={a.employeeDepartment} />
    </div>
  );
}

/** The columns of the settlement's type: a Salary Advance batch in the Salary Advance report's figures (earned to
 *  Settings' day, 50 % limit), a Term Loan batch in the Term Loan report's (fixed salary, eligible limit, months, EMI). */
function columnsFor(data: PortalData, leave: (item: PortalItem) => ReactNode): Column[] {
  const t = portalTotals(data);
  const term = isTermSettlement(data);
  const head: Column[] = [
    {
      key: "employee",
      header: "Employee",
      cell: (i) => <Employee item={i} />,
      total: <span className="font-semibold text-slate-700">Total · {requestsWord(t.requests)}</span>,
    },
  ];
  const requested: Column = {
    key: "requested",
    header: "Requested",
    figure: true,
    cell: (i) => <Requested item={i} limit={term ? i.advance.termLimit : i.advance.earnings?.limit} />,
    total: formatMoney(t.requested),
  };
  const hr: Column = {
    key: "hr",
    header: "HR approved",
    figure: true,
    cell: (i) => <HrAmount item={i} />,
    total: formatMoney(t.hrApproved),
  };
  const figures: Column[] = term
    ? [
        {
          key: "fixedSalary",
          header: "Fixed salary",
          figure: true,
          cell: (i) => money(termFixedSalary(i)),
        },
        {
          key: "termLimit",
          header: "Eligible limit",
          figure: true,
          cell: (i) => money(i.advance.termLimit),
        },
        requested,
        hr,
        {
          key: "months",
          header: "Months",
          figure: true,
          cell: (i) => (hrApproved(i) && termMonths(i) ? termMonths(i) : dash),
        },
        { key: "emi", header: "Monthly EMI", figure: true, cell: (i) => <Emi item={i} /> },
        {
          key: "firstEmi",
          header: "First EMI",
          short: "First EMI",
          figure: true,
          className: "whitespace-nowrap",
          cell: (i) => (hrApproved(i) && firstEmiMonth(i) ? firstEmiMonth(i) : dash),
        },
      ]
    : [
        {
          key: "fixedSalary",
          header: "Fixed salary",
          figure: true,
          cell: (i) => money(i.advance.earnings?.fixedSalary),
        },
        {
          key: "workingDays",
          header: "Working days",
          figure: true,
          cell: (i) => (i.advance.earnings ? formatDays(i.advance.earnings.workingDays) : dash),
        },
        {
          key: "earned",
          header: "Earned",
          figure: true,
          cell: (i) => money(i.advance.earnings?.earnedAmount),
        },
        requested,
        {
          key: "limit",
          header: "Eligible limit",
          figure: true,
          cell: (i) => money(i.advance.earnings?.limit),
        },
        hr,
      ];
  const tail: Column[] = [
    { key: "leave", header: "Leave", cell: leave },
    {
      key: "after",
      header: "After audit",
      figure: true,
      className: "min-w-[7rem]",
      cell: (i) => <After item={i} term={term} />,
      total: (
        <span className="flex flex-col items-end">
          {t.afterAudit !== t.hrApproved && (
            <span className="text-[11px] font-normal text-slate-400 line-through">{formatMoney(t.hrApproved)}</span>
          )}
          <span className="text-[#00466a]">{formatMoney(t.afterAudit)}</span>
        </span>
      ),
    },
    { key: "remarks", header: "Remarks", className: "min-w-[7rem] pr-3", cell: (i) => <RemarkText item={i} /> },
  ];
  return [...head, ...figures, ...tail];
}

/** The row's look: a change is tinted and edged (words say it too: the status tag), a chosen row in the brand tint. */
function rowLook(item: PortalItem, chosen: boolean): { bg: string; edge: string } {
  const s = rowStatus(item);
  const bg =
    s === "rejected_by_auditor"
      ? "bg-rose-50"
      : s === "reduced"
        ? "bg-amber-50"
        : chosen
          ? "bg-[#eef6fb]"
          : s === "rejected_by_hr"
            ? "bg-slate-50 text-slate-500"
            : "bg-white group-hover:bg-slate-50";
  const edge =
    s === "rejected_by_auditor"
      ? "shadow-[inset_3px_0_0_#e11d48]"
      : s === "reduced"
        ? "shadow-[inset_3px_0_0_#d97706]"
        : chosen
          ? "shadow-[inset_3px_0_0_#006496]"
          : "";
  return { bg, edge };
}

/** The row's own actions while the review is open: Reduce and Reject on what HR approved, a Remark on any, Undo. */
function Actions({
  item,
  onOpen,
  onUndo,
  busy,
  prefix,
  compact,
}: {
  item: PortalItem;
  onOpen: (item: PortalItem, mode: ChangeMode) => void;
  onUndo: (item: PortalItem) => void;
  busy: boolean;
  prefix: string;
  compact?: boolean;
}) {
  const who = `${item.advance.employeeName}'s request`;
  const undoable = isChanged(item) || !!(item.auditor.remark ?? "").trim();
  if (compact) {
    // the table: icon buttons with their hover label on one line, as the HRMS tables (the label is drawn above the page,
    // so the table's own scroll box never cuts it off)
    return (
      <RowActions>
        {hrApproved(item) && (
          <>
            <RowAction
              label="Reduce the approved amount"
              icon={<MinusCircle size={15} />}
              color="amber"
              onClick={() => onOpen(item, "reduce")}
              disabled={busy}
              aria={`Reduce ${who}`}
              testId={`${prefix}-reduce-${item.id}`}
            />
            <RowAction
              label="Reject the request"
              icon={<XCircle size={15} />}
              color="red"
              onClick={() => onOpen(item, "reject")}
              disabled={busy}
              aria={`Reject ${who}`}
              testId={`${prefix}-reject-${item.id}`}
            />
          </>
        )}
        <RowAction
          label="Add a remark"
          icon={<MessageSquarePlus size={15} />}
          color="blue"
          onClick={() => onOpen(item, "remark")}
          disabled={busy}
          aria={`Remark on ${who}`}
          testId={`${prefix}-remark-${item.id}`}
        />
        {undoable ? (
          <RowAction
            label="Undo your change"
            icon={busy ? <Loader2 size={15} className="animate-spin" /> : <Undo2 size={15} />}
            color="blue"
            onClick={() => onUndo(item)}
            disabled={busy}
            aria={`Undo your change on ${who}`}
            testId={`${prefix}-undo-${item.id}`}
          />
        ) : (
          <span className="w-8 shrink-0" aria-hidden />
        )}
      </RowActions>
    );
  }
  const base = cn(
    "inline-flex items-center justify-center rounded-lg border font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50",
    compact ? "h-7 gap-1 text-[11.5px]" : "h-8 gap-1.5 text-[12px]",
    FOCUS,
    "focus-visible:ring-offset-1",
  );
  // in the table the labels show from 2xl on (below it the buttons are icons with their names as tooltips)
  const pad = compact ? "w-7 px-0 2xl:w-auto 2xl:px-2" : "px-2.5";
  const label = compact ? "hidden 2xl:inline" : undefined;
  const icon = compact ? "w-7 px-0" : "px-2.5";
  return (
    <div className={cn("flex items-center", compact ? "justify-end gap-1" : "flex-wrap gap-1.5")}>
      {hrApproved(item) && (
        <>
          <button
            type="button"
            className={cn(
              base,
              pad,
              "border-slate-200 bg-white text-slate-700 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-900",
            )}
            onClick={() => onOpen(item, "reduce")}
            disabled={busy}
            aria-label={`Reduce ${who}`}
            title="Reduce the approved amount"
            data-testid={`${prefix}-reduce-${item.id}`}
          >
            <MinusCircle size={13} aria-hidden />
            <span className={label}>Reduce</span>
          </button>
          <button
            type="button"
            className={cn(base, pad, "border-slate-200 bg-white text-rose-700 hover:border-rose-300 hover:bg-rose-50")}
            onClick={() => onOpen(item, "reject")}
            disabled={busy}
            aria-label={`Reject ${who}`}
            title="Reject the request"
            data-testid={`${prefix}-reject-${item.id}`}
          >
            <XCircle size={13} aria-hidden />
            <span className={label}>Reject</span>
          </button>
        </>
      )}
      <button
        type="button"
        className={cn(
          base,
          icon,
          "border-slate-200 bg-white text-slate-600 hover:border-[#006496]/40 hover:bg-[#006496]/5 hover:text-[#006496]",
        )}
        onClick={() => onOpen(item, "remark")}
        disabled={busy}
        aria-label={`Remark on ${who}`}
        title="Add a remark"
        data-testid={`${prefix}-remark-${item.id}`}
      >
        <MessageSquarePlus size={14} aria-hidden />
        {!compact && "Remark"}
      </button>
      {undoable ? (
        <button
          type="button"
          className={cn(
            base,
            icon,
            "border-transparent bg-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-800",
          )}
          onClick={() => onUndo(item)}
          disabled={busy}
          aria-label={`Undo your change on ${who}`}
          title="Undo your change"
          data-testid={`${prefix}-undo-${item.id}`}
        >
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Undo2 size={14} aria-hidden />}
          {!compact && "Undo"}
        </button>
      ) : (
        compact && <span className="w-7 shrink-0" aria-hidden />
      )}
    </div>
  );
}

/** A request's selection box (only a request HR approved can be chosen: HR's rejection can only get a remark). */
function SelectBox({
  item,
  chosen,
  onToggle,
  testId,
}: {
  item: PortalItem;
  chosen: boolean;
  onToggle: (item: PortalItem) => void;
  testId: string;
}) {
  const can = bulkSelectable(item);
  return (
    <input
      type="checkbox"
      className={cn(
        "h-4 w-4 cursor-pointer rounded border-slate-300 accent-[#006496] disabled:cursor-not-allowed",
        FOCUS,
      )}
      checked={can && chosen}
      disabled={!can}
      onChange={() => onToggle(item)}
      aria-label={
        can
          ? `Select ${item.advance.employeeName}'s request`
          : `${item.advance.employeeName}'s request was rejected by HR and cannot be selected`
      }
      title={can ? undefined : "Rejected by HR: only a remark can be added"}
      data-testid={testId}
    />
  );
}

function SelectAll({
  state,
  onToggle,
  testId,
  label,
}: {
  state: "none" | "some" | "all";
  onToggle: () => void;
  testId: string;
  label?: ReactNode;
}) {
  return (
    <input
      type="checkbox"
      ref={(el) => {
        if (el) el.indeterminate = state === "some";
      }}
      className={cn("h-4 w-4 cursor-pointer rounded border-slate-300 accent-[#006496]", FOCUS)}
      checked={state === "all"}
      onChange={onToggle}
      aria-label={typeof label === "string" ? label : "Select all requests shown"}
      data-testid={testId}
    />
  );
}

/** Approve or reject the chosen requests at once: Approve keeps HR's amount (clearing a change of yours; a remark is
 *  optional), Reject gives them all one reason. */
function BulkDialog({
  action,
  items,
  onClose,
  onSubmit,
}: {
  action: BulkAction | null;
  items: PortalItem[];
  onClose: () => void;
  onSubmit: (action: BulkAction, remark: string) => Promise<void>;
}) {
  const [remark, setRemark] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<BulkAction | null>(null);
  if (action !== lastAction) {
    // a new opening starts empty
    setLastAction(action);
    setRemark("");
    setTried(false);
    setRefused(null);
  }
  const s = bulkSummary(items);
  const problem = action ? bulkProblem(action, remark) : null;
  const reject = action === "reject";
  const submit = async () => {
    if (!action) return;
    setTried(true);
    setRefused(null);
    if (problem) return;
    setBusy(true);
    try {
      await onSubmit(action, remark);
    } catch (err) {
      setRefused(refusalText(err, "The requests could not be updated.").text);
    } finally {
      setBusy(false);
    }
  };
  const shown = items.slice(0, 6);
  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[92vh] max-w-md gap-0 overflow-y-auto bg-white p-0"
        data-testid="portal-bulk-dialog"
        data-action={action ?? ""}
      >
        <DialogHeader className="space-y-0 border-b border-slate-100 px-5 pb-4 pr-12 pt-5 text-left">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                reject ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700",
              )}
            >
              {reject ? <Ban size={18} aria-hidden /> : <CheckCheck size={18} aria-hidden />}
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-[17px] font-bold text-slate-900" style={{ fontFamily: HEADING_FONT }}>
                {reject ? "Reject" : "Approve"} {requestsWord(s.count)}?
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-[13px] text-slate-500">
                HR approved {formatMoney(s.amount)} on {s.count === 1 ? "it" : "them"}.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="space-y-4 px-5 py-4">
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200" data-testid="portal-bulk-list">
            {shown.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                <span className="min-w-0 truncate">
                  <b className="font-semibold text-slate-900">{i.advance.employeeName}</b>{" "}
                  <span className="font-mono text-[11.5px] text-slate-500">{i.advance.employeeCode}</span>
                </span>
                <span className="shrink-0 tabular-nums text-slate-700">{formatMoney(i.final.amount)}</span>
              </li>
            ))}
            {items.length > shown.length && (
              <li className="px-3 py-2 text-[12px] text-slate-500">and {items.length - shown.length} more</li>
            )}
          </ul>
          <p className="text-[13px] text-slate-600">
            {reject
              ? "Each request is rejected with this one reason. HR sees it with your change."
              : "Each request keeps the amount HR approved."}
            {!reject && s.changed > 0 && (
              <>
                {" "}
                <b className="font-semibold text-amber-800">
                  {s.changed === 1 ? "1 of them you had changed" : `${s.changed} of them you had changed`}
                </b>
                : your reduction or rejection is cleared.
              </>
            )}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="portal-bulk-remark" className="text-[13px] font-semibold text-slate-800">
              {reject ? (
                <>
                  Reason for rejecting <span className="text-rose-600">*</span>
                </>
              ) : (
                "Remark (optional)"
              )}
            </Label>
            <Textarea
              id="portal-bulk-remark"
              rows={3}
              maxLength={REMARK_MAX}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder={reject ? "e.g. Advances on hold this month" : "e.g. Checked with the time cards"}
              aria-invalid={tried && !!problem}
              aria-describedby={tried && problem ? "portal-bulk-remark-error" : undefined}
              className={cn("text-[14px]", tried && problem && "border-rose-400")}
              data-testid="portal-bulk-remark"
            />
            {tried && problem && (
              <p id="portal-bulk-remark-error" role="alert" className="text-xs font-medium text-rose-700">
                {problem}
              </p>
            )}
          </div>
          {refused && (
            <p
              className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-800"
              role="alert"
              data-testid="portal-bulk-error"
            >
              {refused}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3.5 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy} data-testid="portal-bulk-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy}
            className={cn("gap-1.5", reject ? "bg-rose-600 hover:bg-rose-700" : "bg-emerald-700 hover:bg-emerald-800")}
            data-testid="portal-bulk-submit"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {reject ? "Reject" : "Approve"} {requestsWord(s.count)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Overview: the settlement's figures (summary cards), then every request as HR finalized it in the Loan & Advance
 * report's columns for the batch's type (a Term Loan batch in the Term Loan columns), with the leave check (opens the
 * employee's leave calendar), what is paid after the audit and the auditor's remark. While the review is open each request
 * can be reduced, rejected or given a remark, and undone; several can be chosen (Select All) and approved or rejected at
 * once. Changes are highlighted (from -> to, rejected rows) and saved as they are made.
 */
export default function OverviewSection({
  data,
  token,
  onChange,
  onBulk,
  onGoApproval,
}: {
  data: PortalData;
  token: string;
  /** Saves a change; throws the server's refusal. */
  onChange: (item: PortalItem, body: PortalChangeInput) => Promise<void>;
  /** Saves a bulk action; throws the server's refusal. */
  onBulk: (body: PortalBulkInput) => Promise<void>;
  onGoApproval: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<{ item: PortalItem; mode: ChangeMode } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [leaveFor, setLeaveFor] = useState<PortalItem | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RowFilter>("all");
  const [chosen, setChosen] = useState<ReadonlySet<number>>(() => new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const t = portalTotals(data);
  const term = isTermSettlement(data);
  const review = data.canReview;

  const shown = useMemo(() => filterItems(data.items, filter, query), [data.items, filter, query]);
  const sno = useMemo(() => new Map(data.items.map((i, n) => [i.id, n + 1])), [data.items]);
  const picked = review ? chosenItems(shown, chosen) : [];
  const selState = selectionState(shown, chosen);
  const selectable = shown.filter(bulkSelectable).length;
  const rejectedByHr = data.items.filter((i) => !hrApproved(i)).length;
  const rejectedByYou = data.items.filter((i) => rowStatus(i) === "rejected_by_auditor").length;

  const toggle = (item: PortalItem) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  const toggleShown = () => setChosen((prev) => toggleAll(shown, prev));

  const save = async (item: PortalItem, body: PortalChangeInput) => {
    await onChange(item, body);
    setEditing(null);
  };
  const undo = async (item: PortalItem) => {
    setBusyId(item.id);
    try {
      await onChange(item, UNDO_BODY);
      toast({ title: "Change undone", description: `${item.advance.employeeName}'s request is as HR finalized it.` });
    } catch (err) {
      toast({
        title: "Could not undo",
        description: refusalText(err, "The change could not be undone.").text,
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };
  const runBulk = async (action: BulkAction, remark: string) => {
    const body = bulkBody(picked, action, remark);
    await onBulk(body);
    setBulk(null);
    setChosen(new Set());
    toast({
      title: `${requestsWord(body.itemIds.length)} ${action === "reject" ? "rejected" : "approved"}`,
      description: action === "reject" ? "Your reason was saved on each." : "Each keeps the amount HR approved.",
    });
  };
  const open = (item: PortalItem, mode: ChangeMode) => setEditing({ item, mode });

  const leaveButton =
    (prefix: string) =>
    (item: PortalItem): ReactNode => (
      <button
        type="button"
        onClick={() => setLeaveFor(item)}
        className={cn(
          "group/leave inline-flex items-center gap-1 rounded-full py-0.5 pr-1 text-left transition-colors hover:bg-slate-100",
          FOCUS,
          "focus-visible:ring-offset-1",
        )}
        title="Open the leave calendar"
        data-testid={`${prefix}-leave-btn-${item.id}`}
      >
        <LeaveCount check={item.advance.leaveCheck} testId={`${prefix}-leave-${item.id}`} />
        <CalendarDays size={13} className="shrink-0 text-slate-400 group-hover/leave:text-[#006496]" aria-hidden />
        <span className="sr-only">, open {item.advance.employeeName}&apos;s leave calendar</span>
      </button>
    );
  const columns = columnsFor(data, leaveButton("portal"));
  const cardLeave = leaveButton("portal-card");
  const cardFigures = columns.filter((c) => c.figure && c.key !== "after");

  return (
    <div className={cn("space-y-5", picked.length > 0 && "pb-28")} data-testid="portal-overview">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="Requests"
          value={String(t.requests)}
          sub={`${formatMoney(t.requested)} requested`}
          icon={FileText}
          testId="portal-total-requests"
        />
        <StatCard
          label="HR approved"
          value={formatMoney(t.hrApproved)}
          sub={`${t.hrApprovedCount} of ${t.requests} approved by HR`}
          icon={BadgeCheck}
          tone="brand"
          testId="portal-total-hr"
        />
        <StatCard
          label="After audit"
          value={formatMoney(t.afterAudit)}
          sub={
            t.difference > 0 ? (
              <span className="font-medium text-amber-800">{formatMoney(t.difference)} less than HR</span>
            ) : (
              `${t.approved} approved · same as HR`
            )
          }
          icon={Scale}
          tone={t.difference > 0 ? "warning" : "success"}
          testId="portal-total-after"
        />
        <StatCard
          label="Rejected"
          value={String(t.rejected)}
          sub={`${rejectedByHr} by HR · ${rejectedByYou} by you`}
          icon={Ban}
          tone={t.rejected ? "danger" : "neutral"}
          testId="portal-total-rejected"
        />
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <StatCard
            label="Your changes"
            value={String(t.changes)}
            sub={`${t.remarks} ${t.remarks === 1 ? "remark" : "remarks"}`}
            icon={PencilLine}
            tone={t.changes ? "warning" : "indigo"}
            testId="portal-total-changes"
          />
        </div>
      </div>

      {review && (
        <div
          className="flex flex-col gap-3 rounded-2xl border border-[#006496]/15 bg-[#006496]/[0.04] px-4 py-3 text-[13px] text-slate-700 sm:flex-row sm:items-center sm:justify-between"
          data-testid="portal-guide"
        >
          <p className="flex items-start gap-2">
            <Info size={16} className="mt-0.5 shrink-0 text-[#006496]" aria-hidden />
            <span>
              Check each request: reduce or reject what HR approved (a remark is required), or leave a remark for HR.
              Your changes save as you go; nothing is final until you submit on the Approval tab.
            </span>
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5 self-start border-[#006496]/30 bg-white text-[#006496] hover:bg-[#006496]/5 sm:self-auto"
            onClick={onGoApproval}
            data-testid="portal-go-approval"
          >
            Go to Approval <ArrowRight size={14} aria-hidden />
          </Button>
        </div>
      )}

      <section className={cn(CARD, "overflow-hidden")} aria-labelledby="portal-requests-heading">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3.5 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h2
              id="portal-requests-heading"
              className="text-[15px] font-bold text-slate-900"
              style={{ fontFamily: HEADING_FONT }}
            >
              Requests
            </h2>
            <p className="text-[12.5px] text-slate-500" data-testid="portal-showing">
              Showing {shown.length} of {requestsWord(data.items.length)}
              {term ? " · Term Loan figures" : " · Salary Advance figures"}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative sm:w-72">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                aria-hidden
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, code or department"
                aria-label="Search requests"
                className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-[#006496] focus:ring-2 focus:ring-[#006496]/20"
                data-testid="portal-search"
              />
            </div>
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-slate-600">
              <span className="shrink-0">Show</span>
              <select
                value={filter}
                onChange={(e) => setFilter(asRowFilter(e.target.value))}
                className="h-9 w-full rounded-lg border border-slate-300 bg-white px-2.5 text-[13px] text-slate-900 outline-none focus:border-[#006496] focus:ring-2 focus:ring-[#006496]/20 sm:w-48"
                data-testid="portal-filter"
              >
                {ROW_FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {shown.length === 0 ? (
          <div className="px-4 py-12 text-center" data-testid="portal-empty">
            <p className="font-semibold text-slate-800">No request matches</p>
            <p className="mt-1 text-[13px] text-slate-500">Try another search or show all requests.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              Show all requests
            </Button>
          </div>
        ) : (
          <>
            {/* wide screens: the report's table, its heading row stays in view */}
            <div
              className="relative hidden max-h-[min(72vh,52rem)] overflow-auto xl:block"
              data-testid="portal-table-scroll"
            >
              <table
                className="w-full border-separate border-spacing-0 text-[13px] text-slate-800"
                data-testid="portal-items-table"
                data-type={term ? "term" : "general"}
              >
                <caption className="sr-only">
                  {data.settlement.title}, {data.settlement.period}: the requests as HR finalized them and after your
                  review
                </caption>
                <thead>
                  <tr>
                    {review && (
                      <th scope="col" className={cn(TH, "w-10 pl-4 pr-0")}>
                        <SelectAll
                          state={selState}
                          onToggle={toggleShown}
                          testId="portal-select-all"
                          label={`Select all ${selectable} requests shown`}
                        />
                      </th>
                    )}
                    {columns.map((c) => (
                      <th key={c.key} scope="col" className={cn(TH, c.figure && "text-right")}>
                        {c.header}
                      </th>
                    ))}
                    {review && (
                      <th scope="col" className={cn(TH, "right-0 z-20 pr-4 text-right")}>
                        Actions
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((item) => {
                    const isChosen = review && bulkSelectable(item) && chosen.has(item.id);
                    const look = rowLook(item, isChosen);
                    return (
                      <tr
                        key={item.id}
                        className="group"
                        data-testid={`portal-row-${item.id}`}
                        data-status={rowStatus(item)}
                        data-selected={isChosen ? "true" : "false"}
                      >
                        {review && (
                          <td className={cn(TD, look.bg, look.edge, "w-10 pl-4 pr-0")}>
                            <SelectBox
                              item={item}
                              chosen={chosen.has(item.id)}
                              onToggle={toggle}
                              testId={`portal-select-${item.id}`}
                            />
                          </td>
                        )}
                        {columns.map((c, n) => (
                          <td
                            key={c.key}
                            className={cn(TD, look.bg, !review && n === 0 && look.edge, c.figure && NUM, c.className)}
                            data-col={c.key}
                            data-testid={
                              c.key === "hr"
                                ? `portal-hr-${item.id}`
                                : c.key === "after"
                                  ? `portal-after-${item.id}`
                                  : c.key === "remarks"
                                    ? `portal-remark-text-${item.id}`
                                    : undefined
                            }
                          >
                            {c.cell(item, sno.get(item.id) ?? 0)}
                          </td>
                        ))}
                        {review && (
                          <td className={cn(TD, look.bg, "pr-4")}>
                            <Actions
                              item={item}
                              onOpen={open}
                              onUndo={(it) => void undo(it)}
                              busy={busyId === item.id}
                              prefix="portal"
                              compact
                            />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr data-testid="portal-totals-row">
                    {review && (
                      <td className="sticky bottom-0 z-10 border-t-2 border-slate-200 bg-slate-50 px-3 py-3" />
                    )}
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={cn(
                          "sticky bottom-0 z-10 border-t-2 border-slate-200 bg-slate-50 px-3 py-3 font-semibold",
                          c.figure && NUM,
                        )}
                        data-col={c.key}
                      >
                        {c.total ?? null}
                      </td>
                    ))}
                    {review && (
                      <td className="sticky bottom-0 z-10 border-t-2 border-slate-200 bg-slate-50 px-3 py-3" />
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* phones and tablets: a card per request */}
            <div className="space-y-3 bg-slate-50/60 p-3 sm:p-4 xl:hidden" data-testid="portal-items-cards">
              {review && selectable > 0 && (
                <label className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-[13px] font-semibold text-slate-700">
                  <SelectAll
                    state={selState}
                    onToggle={toggleShown}
                    testId="portal-card-select-all"
                    label={`Select all ${selectable} requests shown`}
                  />
                  Select all ({selectable})
                </label>
              )}
              {shown.map((item) => {
                const a = item.advance;
                const isChosen = review && bulkSelectable(item) && chosen.has(item.id);
                const status = rowStatus(item);
                return (
                  <article
                    key={item.id}
                    className={cn(
                      "space-y-3 rounded-2xl border bg-white p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
                      status === "rejected_by_auditor"
                        ? "border-rose-200 bg-rose-50/60"
                        : status === "reduced"
                          ? "border-amber-200 bg-amber-50/60"
                          : isChosen
                            ? "border-[#006496]/40 bg-[#eef6fb]"
                            : "border-slate-200",
                    )}
                    aria-label={`${a.employeeName}, ${a.employeeCode}`}
                    data-testid={`portal-card-${item.id}`}
                    data-status={status}
                  >
                    <div className="flex items-start gap-3">
                      {review && (
                        <div className="pt-0.5">
                          <SelectBox
                            item={item}
                            chosen={chosen.has(item.id)}
                            onToggle={toggle}
                            testId={`portal-card-select-${item.id}`}
                          />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p className="min-w-0 font-semibold text-slate-900">
                            <span className="mr-1 text-slate-400">{sno.get(item.id)}.</span>
                            {a.employeeName}
                          </p>
                          <StatusTag status={status} />
                        </div>
                        <p className="text-[12px] text-slate-500">
                          <span className="font-mono">{a.employeeCode}</span>
                          {a.employeeDepartment ? ` · ${a.employeeDepartment}` : ""}
                          {a.employeeDesignation ? ` · ${a.employeeDesignation}` : ""}
                        </p>
                      </div>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-slate-50 px-3 py-2.5 text-[12.5px] sm:grid-cols-3">
                      {cardFigures.map((c) => (
                        <div key={c.key} className="min-w-0" data-col={c.key}>
                          <dt className="text-[11px] font-medium text-slate-500">{c.short ?? c.header}</dt>
                          <dd className="font-medium tabular-nums text-slate-900">
                            {c.cell(item, sno.get(item.id) ?? 0)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-medium text-slate-500">After audit</p>
                        <After item={item} term={term} align="left" />
                      </div>
                      <div className="text-right">
                        <p className="text-[11px] font-medium text-slate-500">Leave</p>
                        {cardLeave(item)}
                      </div>
                    </div>
                    {(item.auditor.remark ?? "").trim() && (
                      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                        <p className="text-[11px] font-medium text-slate-500">Your remark</p>
                        <RemarkText item={item} clamp={false} />
                      </div>
                    )}
                    {review && (
                      <div className="border-t border-slate-100 pt-3">
                        <Actions
                          item={item}
                          onOpen={open}
                          onUndo={(it) => void undo(it)}
                          busy={busyId === item.id}
                          prefix="portal-card"
                        />
                      </div>
                    )}
                  </article>
                );
              })}
              <div
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-[13px] font-semibold"
                data-testid="portal-card-totals"
              >
                <span className="text-slate-600">Total after audit</span>
                <span className="tabular-nums text-[#00466a]">{formatMoney(t.afterAudit)}</span>
              </div>
            </div>
          </>
        )}
      </section>

      {review && picked.length > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-3xl rounded-2xl bg-slate-900 p-3 text-white shadow-[0_16px_48px_-12px_rgba(2,6,23,0.55)] sm:px-4"
          data-testid="portal-bulk-bar"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
            <p className="min-w-0 flex-1 text-[13px]" aria-live="polite" data-testid="portal-bulk-count">
              <b className="text-[15px] tabular-nums">{picked.length}</b> selected
              <span className="text-slate-400"> · HR approved {formatMoney(bulkSummary(picked).amount)}</span>
            </p>
            <div className="flex w-full gap-2 sm:w-auto">
              <Button
                size="sm"
                className="h-9 flex-1 gap-1.5 bg-emerald-500 font-semibold text-emerald-950 hover:bg-emerald-400 sm:flex-none"
                onClick={() => setBulk("approve")}
                data-testid="portal-bulk-approve"
              >
                <CheckCheck size={15} aria-hidden /> Approve selected
              </Button>
              <Button
                size="sm"
                className="h-9 flex-1 gap-1.5 bg-rose-500 font-semibold text-white hover:bg-rose-600 sm:flex-none"
                onClick={() => setBulk("reject")}
                data-testid="portal-bulk-reject"
              >
                <Ban size={15} aria-hidden /> Reject selected
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-9 w-9 shrink-0 p-0 text-slate-300 hover:bg-white/10 hover:text-white"
                onClick={() => setChosen(new Set())}
                aria-label="Clear the selection"
                title="Clear the selection"
                data-testid="portal-bulk-clear"
              >
                <X size={16} aria-hidden />
              </Button>
            </div>
          </div>
        </div>
      )}

      <BulkDialog action={bulk} items={picked} onClose={() => setBulk(null)} onSubmit={runBulk} />
      <ChangeDialog
        item={editing?.item ?? null}
        mode={editing?.mode ?? "remark"}
        term={term}
        onSave={save}
        onClose={() => setEditing(null)}
      />
      <LeaveCalendarDialog
        open={leaveFor !== null}
        onClose={() => setLeaveFor(null)}
        load={() => fetchLeaveCalendar(token, leaveFor?.id ?? 0)}
        title={leaveFor ? `${leaveFor.advance.employeeName} (${leaveFor.advance.employeeCode})` : undefined}
      />
    </div>
  );
}
