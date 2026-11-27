import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Ban,
  BadgeCheck,
  CalendarDays,
  Check,
  CheckCheck,
  FileText,
  Info,
  Loader2,
  MessageSquarePlus,
  PencilLine,
  RotateCcw,
  Scale,
  Search,
  X,
  XCircle,
} from "lucide-react";
import { LeaveCalendarDialog } from "@/components/leave-calendar/LeaveCalendar";
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
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { groupByReview, reviewGroupLabel, type ReviewState } from "@/lib/reviewOrder";
import { cn } from "@/lib/utils";
import { REMARK_MAX, formatDays } from "@/pages/hr/settlement/logic";
import { formatDateTime, formatMoney } from "@/pages/hr/settlement/shared";
import {
  FIRST,
  FLASH,
  GroupRow,
  LAST,
  PersonCell,
  RowAction,
  RowActions,
  useFlash,
  type ActionColor,
} from "@/pages/hr/settlement/table-kit";
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
  approveBody,
  asRowFilter,
  bulkBody,
  bulkProblem,
  bulkSelectable,
  bulkSummary,
  canRework,
  chosenItems,
  filterItems,
  firstEmiMonth,
  hrApproved,
  isTermSettlement,
  lastRoundSummary,
  pendingCount,
  portalTotals,
  refusalText,
  requestsWord,
  reviewOf,
  reviewRound,
  reworkBody,
  rowState,
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
import {
  AfterAudit,
  CARD,
  FOCUS,
  HEADING_FONT,
  HrAmount,
  LeaveCount,
  RemarkText,
  StatCard,
  StatusTag,
  TrailChip,
  TrailList,
} from "./parts";

// The HRMS table look (owner 2026-11-27: "the All Employees table is the reference"): the shared Table with its quiet
// sentence-case headings, one value per column, the employee as initials + name over the code and department, money
// right-aligned in tabular figures, the row actions as icon buttons with their label drawn above the page. The requests
// are grouped: waiting for the auditor at the top, approved below, rejected below those.

const NUM = "text-right tabular-nums";
/** A heading cell: on the bottom line, so a heading over two lines and a one-line heading read along one baseline. */
const HEAD_CELL = "h-auto py-2.5 align-bottom leading-tight";
const dash = <span className="text-slate-300">—</span>;
const money = (n: number | null | undefined) => (n != null ? formatMoney(n) : dash);

/** The group headings of the auditor's list. */
const groupLabel = (state: ReviewState) => reviewGroupLabel(state, "Waiting for your review");

const GROUP_DOT: Record<ReviewState, string> = {
  pending: "bg-amber-500",
  approved: "bg-emerald-500",
  rejected: "bg-red-500",
};

type Column = {
  key: string;
  header: string;
  /** A figure: right-aligned, and listed on a phone's card. */
  figure?: boolean;
  /** The card's shorter label. */
  short?: string;
  className?: string;
  cell: (item: PortalItem) => ReactNode;
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
    <div className="max-w-[13rem] 2xl:max-w-[15rem]" title={a.employeeDesignation ?? undefined}>
      <PersonCell name={a.employeeName} code={a.employeeCode} department={a.employeeDepartment} />
    </div>
  );
}

/** The auditor's remark, and on a revised settlement what happened to the auditor's earlier change (a chip with the
 *  detail in its tooltip). */
function Remarks({ item }: { item: PortalItem }) {
  const remark = (item.auditor.remark ?? "").trim();
  const chip = <TrailChip item={item} testId={`portal-trail-${item.id}`} />;
  return (
    <div className="flex max-w-[12rem] flex-col items-start gap-1">
      {chip}
      {(remark || !item.trail?.length) && (
        <div className="min-w-0" data-testid={`portal-remark-text-${item.id}`}>
          <RemarkText item={item} />
        </div>
      )}
    </div>
  );
}

/** The columns of the settlement's type: a Salary Advance batch in the Salary Advance report's figures (earned to
 *  Settings' day, Settings' % limit), a Term Loan batch in the Term Loan report's (fixed salary, eligible limit, months,
 *  EMI). */
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
        { key: "fixedSalary", header: "Fixed salary", figure: true, cell: (i) => money(termFixedSalary(i)) },
        { key: "termLimit", header: "Eligible limit", figure: true, cell: (i) => money(i.advance.termLimit) },
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
        { key: "earned", header: "Earned", figure: true, cell: (i) => money(i.advance.earnings?.earnedAmount) },
        requested,
        { key: "limit", header: "Eligible limit", figure: true, cell: (i) => money(i.advance.earnings?.limit) },
        hr,
      ];
  const tail: Column[] = [
    { key: "leave", header: "Leave", cell: leave },
    {
      key: "after",
      header: "After audit",
      figure: true,
      className: "min-w-[5.5rem]",
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
    { key: "remarks", header: "Remarks", className: "min-w-[7rem]", cell: (i) => <Remarks item={i} /> },
  ];
  return [...head, ...figures, ...tail];
}

/** The row's tint (the words say it too: the status pill and the from -> to): a change of the auditor's in its colour,
 *  a chosen row in the selection's, HR's rejection muted. */
function rowTint(item: PortalItem, chosen: boolean): string {
  const s = rowStatus(item);
  if (chosen) return "bg-sky-50/80 hover:bg-sky-50";
  if (s === "rejected_by_auditor") return "bg-rose-50/50 hover:bg-rose-50/80";
  if (s === "reduced") return "bg-amber-50/50 hover:bg-amber-50/80";
  if (s === "rejected_by_hr") return "text-slate-500";
  return "";
}

/** The edge of a changed row's first cell (reduced: amber, rejected by the auditor: rose). */
function rowEdge(item: PortalItem): string {
  const s = rowStatus(item);
  return s === "rejected_by_auditor"
    ? "shadow-[inset_3px_0_0_#e11d48]"
    : s === "reduced"
      ? "shadow-[inset_3px_0_0_#d97706]"
      : "";
}

type Quick = { id: number; what: "approve" | "rework" } | null;

type ActionProps = {
  item: PortalItem;
  /** The row's own quick action being saved (Approve, Rework): its button spins, the others wait. */
  busy: "approve" | "rework" | null;
  /** Another row is saving: every button waits. */
  locked: boolean;
  onApprove: (item: PortalItem) => void;
  onOpen: (item: PortalItem, mode: ChangeMode) => void;
  onRework: (item: PortalItem) => void;
};

/** The table row's actions (icon buttons with their hover label, one line, as All Employees): Approve and Reject on a
 *  request HR approved that waits for the auditor; a Remark on any (to ask HR for a change - the auditor does not reduce
 *  amounts, owner 2026-11-27); Rework on one the auditor answered. */
function TableActions({ item, busy, locked, onApprove, onOpen, onRework }: ActionProps) {
  const who = `${item.advance.employeeName}'s request`;
  const waiting = reviewOf(item) === "pending" && hrApproved(item);
  const off = locked || busy !== null;
  return (
    <RowActions>
      {waiting && (
        <>
          <RowAction
            label="Approve as HR settled it"
            icon={<Check size={15} />}
            color="emerald"
            onClick={() => onApprove(item)}
            busy={busy === "approve"}
            disabled={off}
            aria={`Approve ${who}`}
            testId={`portal-approve-${item.id}`}
          />
          <RowAction
            label="Reject the request"
            icon={<XCircle size={15} />}
            color="red"
            onClick={() => onOpen(item, "reject")}
            disabled={off}
            aria={`Reject ${who}`}
            testId={`portal-reject-${item.id}`}
          />
        </>
      )}
      <RowAction
        label={(item.auditor.remark ?? "").trim() ? "Edit your remark" : "Add a remark"}
        icon={<MessageSquarePlus size={15} />}
        color="blue"
        onClick={() => onOpen(item, "remark")}
        disabled={off}
        aria={`Remark on ${who}`}
        testId={`portal-remark-${item.id}`}
      />
      {canRework(item) && (
        <RowAction
          label="Rework — reopen this decision"
          icon={<RotateCcw size={15} />}
          color="violet"
          onClick={() => onRework(item)}
          busy={busy === "rework"}
          disabled={off}
          aria={`Rework ${who}: reopen your decision`}
          testId={`portal-rework-${item.id}`}
        />
      )}
    </RowActions>
  );
}

const CARD_BUTTON = cn(
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border bg-white px-3 text-[12.5px] font-semibold",
  "shadow-[0_1px_0_rgba(15,23,42,0.03)] transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out",
  "hover:-translate-y-px hover:shadow-sm active:translate-y-0 active:scale-[0.97] active:shadow-none",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
  "disabled:pointer-events-none disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none",
);

/** The bulk bar's buttons: they lift with a coloured glow on hover and sink when pressed. */
const BULK_BUTTON = cn(
  "h-9 flex-1 gap-1.5 font-semibold sm:flex-none",
  "transition-[background-color,box-shadow,transform] duration-150 ease-out hover:-translate-y-px hover:shadow-lg",
  "active:translate-y-0 active:scale-[0.97] active:shadow-none",
  "focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900",
  "motion-reduce:transform-none motion-reduce:transition-none",
);

const CARD_TONE: Record<ActionColor, string> = {
  emerald:
    "border-emerald-200 text-emerald-800 hover:border-emerald-300 hover:bg-emerald-50 focus-visible:ring-emerald-300",
  amber:
    "border-slate-200 text-slate-700 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-900 focus-visible:ring-amber-300",
  red: "border-slate-200 text-rose-700 hover:border-rose-300 hover:bg-rose-50 focus-visible:ring-rose-300",
  blue: "border-slate-200 text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 focus-visible:ring-blue-300",
  violet: "border-violet-200 text-violet-700 hover:border-violet-300 hover:bg-violet-50 focus-visible:ring-violet-300",
};

function CardButton({
  color,
  icon,
  label,
  onClick,
  disabled,
  busy,
  aria,
  testId,
}: {
  color: ActionColor;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  busy?: boolean;
  aria: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      className={cn(CARD_BUTTON, CARD_TONE[color])}
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={aria}
      aria-busy={busy || undefined}
      data-testid={testId}
    >
      {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : icon}
      {label}
    </button>
  );
}

/** A phone card's actions: the same set with their names on the buttons. */
function CardActions({ item, busy, locked, onApprove, onOpen, onRework }: ActionProps) {
  const who = `${item.advance.employeeName}'s request`;
  const waiting = reviewOf(item) === "pending" && hrApproved(item);
  const off = locked || busy !== null;
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:items-center">
      {waiting && (
        <>
          <CardButton
            color="emerald"
            icon={<Check size={14} aria-hidden />}
            label="Approve"
            onClick={() => onApprove(item)}
            busy={busy === "approve"}
            disabled={off}
            aria={`Approve ${who}`}
            testId={`portal-card-approve-${item.id}`}
          />
          <CardButton
            color="red"
            icon={<XCircle size={14} aria-hidden />}
            label="Reject"
            onClick={() => onOpen(item, "reject")}
            disabled={off}
            aria={`Reject ${who}`}
            testId={`portal-card-reject-${item.id}`}
          />
        </>
      )}
      <CardButton
        color="blue"
        icon={<MessageSquarePlus size={14} aria-hidden />}
        label="Remark"
        onClick={() => onOpen(item, "remark")}
        disabled={off}
        aria={`Remark on ${who}`}
        testId={`portal-card-remark-${item.id}`}
      />
      {canRework(item) && (
        <CardButton
          color="violet"
          icon={<RotateCcw size={14} aria-hidden />}
          label="Rework"
          onClick={() => onRework(item)}
          busy={busy === "rework"}
          disabled={off}
          aria={`Rework ${who}: reopen your decision`}
          testId={`portal-card-rework-${item.id}`}
        />
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

/** Approve or reject the chosen requests at once: Approve takes HR's settlement (clearing a change of yours; a remark
 *  is optional), Reject gives them all one reason. */
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
              : "Each request is approved as HR settled it."}
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

/** A revised settlement (round 2+): HR reworked the auditor's earlier changes and resubmitted it - when, by whom, what
 *  HR did with the changes, and HR's note. */
function RoundBanner({ data }: { data: PortalData }) {
  const round = reviewRound(data);
  if (round < 2) return null;
  const s = data.settlement;
  const summary = lastRoundSummary(data);
  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-violet-200/80 bg-gradient-to-r from-violet-50/90 via-white/80 to-sky-50/70 px-4 py-3.5 shadow-[0_10px_30px_-20px_rgba(76,29,149,0.55)] backdrop-blur-md sm:px-5"
      aria-labelledby="portal-round-title"
      data-testid="portal-round-banner"
      data-round={round}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-600/10 text-violet-700 ring-1 ring-violet-200">
          <RotateCcw size={17} aria-hidden />
        </span>
        <div className="min-w-0 space-y-1">
          <h2
            id="portal-round-title"
            className="text-[14.5px] font-bold text-slate-900"
            style={{ fontFamily: HEADING_FONT }}
            data-testid="portal-round-title"
          >
            Revised settlement · round {round}
          </h2>
          <p className="text-[13px] text-slate-700" data-testid="portal-round-text">
            HR reworked your earlier changes and resubmitted it
            {s.resubmittedAt ? ` on ${formatDateTime(s.resubmittedAt)}` : ""}
            {s.resubmittedBy ? ` (${s.resubmittedBy})` : ""}. Review it again: only your approval sends it to Accounts.
          </p>
          {summary && (
            <p className="text-[12.5px] text-slate-600" data-testid="portal-round-summary">
              {summary} Each request says what happened under Remarks.
            </p>
          )}
          {s.resubmitNote && (
            <p
              className="mt-1.5 rounded-lg border-l-[3px] border-violet-400 bg-white/75 px-3 py-1.5 text-[12.5px] text-slate-700"
              data-testid="portal-round-note"
            >
              <b className="font-semibold text-slate-900">HR&apos;s note:</b> {s.resubmitNote}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** A phone list's group heading (the table's GroupRow as a line). */
function CardGroupHeading({ state, count }: { state: ReviewState; count: number }) {
  return (
    <p
      className="flex items-center gap-2 px-1 pt-1 text-[12px] font-semibold text-slate-600"
      data-group={state}
      data-testid={`portal-card-group-${state}`}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", GROUP_DOT[state])} aria-hidden />
      {groupLabel(state)}
      <span className="rounded-full bg-white px-1.5 py-px text-[10.5px] font-bold tabular-nums text-slate-500 ring-1 ring-slate-200">
        {count}
      </span>
    </p>
  );
}

/**
 * Overview: the settlement's figures (summary cards), then every request as HR finalized it in the Loan & Advance
 * report's columns for the batch's type (a Term Loan batch in the Term Loan columns), with the leave check (opens the
 * employee's leave calendar), what is paid after the audit and the auditor's remark. The requests are grouped (owner
 * 2026-11-27): waiting for the auditor at the top, approved below, rejected below those; a request the auditor answers
 * moves to its group and glows there for a moment, and Rework sends it back to the top. While the review is open each
 * request HR approved can be approved or rejected; any can get a remark; several can be chosen (Select All) and
 * approved or rejected at once. A revised settlement (round 2+) says what HR did with the auditor's earlier changes.
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
  const [quick, setQuick] = useState<Quick>(null);
  const [flashId, flash] = useFlash();
  const [leaveFor, setLeaveFor] = useState<PortalItem | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RowFilter>("all");
  const [chosen, setChosen] = useState<ReadonlySet<number>>(() => new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const t = portalTotals(data);
  const term = isTermSettlement(data);
  const review = data.canReview;
  const pending = pendingCount(data);

  const shown = useMemo(() => filterItems(data.items, filter, query), [data.items, filter, query]);
  const groups = useMemo(() => groupByReview(shown, reviewOf), [shown]);
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
    flash(item.id);
  };
  /** Approve (as HR settled it) or Rework (reopen): saved at once, no dialog. */
  const runQuick = async (item: PortalItem, what: "approve" | "rework") => {
    setQuick({ id: item.id, what });
    try {
      await onChange(item, what === "approve" ? approveBody(item) : reworkBody(item));
      flash(item.id);
      toast(
        what === "approve"
          ? { title: "Approved", description: `${item.advance.employeeName}'s request, as HR settled it.` }
          : {
              title: "Reopened for your review",
              description: `${item.advance.employeeName}'s request is back at the top, waiting for your decision.`,
            },
      );
    } catch (err) {
      toast({
        title: what === "approve" ? "Could not approve" : "Could not reopen",
        description: refusalText(
          err,
          what === "approve" ? "The request could not be approved." : "The request could not be reopened.",
        ).text,
        variant: "destructive",
      });
    } finally {
      setQuick(null);
    }
  };
  const runBulk = async (action: BulkAction, remark: string) => {
    const body = bulkBody(picked, action, remark);
    await onBulk(body);
    setBulk(null);
    setChosen(new Set());
    if (body.itemIds.length === 1) flash(body.itemIds[0]);
    toast({
      title: `${requestsWord(body.itemIds.length)} ${action === "reject" ? "rejected" : "approved"}`,
      description: action === "reject" ? "Your reason was saved on each." : "Each is approved as HR settled it.",
    });
  };
  const open = (item: PortalItem, mode: ChangeMode) => setEditing({ item, mode });
  const actionProps = (item: PortalItem) => ({
    item,
    busy: quick?.id === item.id ? quick.what : null,
    locked: quick !== null && quick.id !== item.id,
    onApprove: (it: PortalItem) => void runQuick(it, "approve"),
    onOpen: open,
    onRework: (it: PortalItem) => void runQuick(it, "rework"),
  });

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
  const colCount = columns.length + (review ? 2 : 0);
  const lastCol = columns[columns.length - 1]?.key;

  return (
    <div className={cn("space-y-5", picked.length > 0 && "pb-28")} data-testid="portal-overview">
      <RoundBanner data={data} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="Requests"
          value={String(t.requests)}
          sub={
            <>
              {formatMoney(t.requested)} requested
              {review && (
                <span
                  className={cn("block font-medium", pending > 0 ? "text-amber-800" : "text-emerald-700")}
                  data-testid="portal-total-pending"
                >
                  {pending > 0 ? `${pending} waiting for your review` : "All reviewed"}
                </span>
              )}
            </>
          }
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
          className="flex flex-col gap-3 rounded-2xl border border-[#006496]/15 bg-white/70 px-4 py-3 text-[13px] text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-md sm:flex-row sm:items-center sm:justify-between"
          data-testid="portal-guide"
        >
          <p className="flex items-start gap-2">
            <Info size={16} className="mt-0.5 shrink-0 text-[#006496]" aria-hidden />
            <span>
              Check each request: approve it, reject it (a reason is required), or leave a remark for HR. To have an
              amount changed, write a remark and return the settlement to HR for rework. Rework reopens a decision. Your
              answers save as you go; nothing is final until you submit on the Approval tab.
            </span>
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5 self-start border-[#006496]/30 bg-white text-[#006496] transition-[background-color,box-shadow,transform] hover:-translate-y-px hover:bg-[#006496]/5 hover:shadow-sm active:translate-y-0 active:scale-[0.97] sm:self-auto"
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
                className="h-9 w-full rounded-lg border border-slate-300 bg-white px-2.5 text-[13px] text-slate-900 outline-none focus:border-[#006496] focus:ring-2 focus:ring-[#006496]/20 sm:w-52"
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
            {/* wide screens: the report's table in the HRMS look */}
            <div className="hidden xl:block" data-testid="portal-table-scroll">
              <Table
                className="text-[13px] text-slate-800"
                data-testid="portal-items-table"
                data-type={term ? "term" : "general"}
              >
                <caption className="sr-only">
                  {data.settlement.title}, {data.settlement.period}: the requests as HR finalized them and after your
                  review, waiting ones first
                </caption>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {review && (
                      <TableHead className={cn(FIRST, "w-10 pr-0")}>
                        <SelectAll
                          state={selState}
                          onToggle={toggleShown}
                          testId="portal-select-all"
                          label={`Select all ${selectable} requests shown`}
                        />
                      </TableHead>
                    )}
                    {columns.map((c) => (
                      <TableHead
                        key={c.key}
                        className={cn(
                          HEAD_CELL,
                          // two short words over two lines below 2xl, so every figure fits a laptop without a
                          // sideways scroll
                          c.figure && c.header.includes(" ")
                            ? "whitespace-normal 2xl:whitespace-nowrap"
                            : "whitespace-nowrap",
                          c.figure && "text-right",
                          c.key === "employee" && !review && FIRST,
                          !review && c.key === lastCol && LAST,
                        )}
                        data-column={c.key}
                      >
                        {c.header}
                      </TableHead>
                    ))}
                    {review && (
                      <TableHead className={cn(HEAD_CELL, LAST, "whitespace-nowrap text-right")}>Actions</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((g) => (
                    <Fragment key={g.state}>
                      <GroupRow
                        state={g.state}
                        label={groupLabel(g.state)}
                        count={g.rows.length}
                        colSpan={colCount}
                        testId={`portal-group-${g.state}`}
                      />
                      {g.rows.map((item) => {
                        const isChosen = review && bulkSelectable(item) && chosen.has(item.id);
                        const edge = rowEdge(item);
                        return (
                          <TableRow
                            key={item.id}
                            className={cn(rowTint(item, isChosen), flashId === item.id && FLASH)}
                            data-state={isChosen ? "selected" : undefined}
                            data-testid={`portal-row-${item.id}`}
                            data-status={rowStatus(item)}
                            data-review={reviewOf(item)}
                            data-selected={isChosen ? "true" : "false"}
                          >
                            {review && (
                              <TableCell className={cn(FIRST, "w-10 pr-0", edge)}>
                                <SelectBox
                                  item={item}
                                  chosen={chosen.has(item.id)}
                                  onToggle={toggle}
                                  testId={`portal-select-${item.id}`}
                                />
                              </TableCell>
                            )}
                            {columns.map((c) => (
                              <TableCell
                                key={c.key}
                                className={cn(
                                  "py-3",
                                  c.key === "employee" && !review && cn(FIRST, edge),
                                  !review && c.key === lastCol && LAST,
                                  c.figure && NUM,
                                  c.className,
                                )}
                                data-col={c.key}
                                data-testid={
                                  c.key === "hr"
                                    ? `portal-hr-${item.id}`
                                    : c.key === "after"
                                      ? `portal-after-${item.id}`
                                      : undefined
                                }
                              >
                                {c.cell(item)}
                              </TableCell>
                            ))}
                            {review && (
                              <TableCell className={cn(LAST, "text-right")}>
                                <TableActions {...actionProps(item)} />
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </Fragment>
                  ))}
                </TableBody>
                <TableFooter className="bg-slate-50">
                  <TableRow className="hover:bg-transparent" data-testid="portal-totals-row">
                    {review && <TableCell className={FIRST} />}
                    {columns.map((c) => (
                      <TableCell
                        key={c.key}
                        className={cn("py-3 font-semibold", c.key === "employee" && !review && FIRST, c.figure && NUM)}
                        data-col={c.key}
                      >
                        {c.total ?? null}
                      </TableCell>
                    ))}
                    {review && <TableCell className={LAST} />}
                  </TableRow>
                </TableFooter>
              </Table>
            </div>

            {/* phones and tablets: a card per request, in the same groups */}
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
              {groups.map((g) => (
                <div key={g.state} className="space-y-2.5">
                  <CardGroupHeading state={g.state} count={g.rows.length} />
                  {g.rows.map((item) => {
                    const a = item.advance;
                    const isChosen = review && bulkSelectable(item) && chosen.has(item.id);
                    const status = rowStatus(item);
                    return (
                      <article
                        key={item.id}
                        className={cn(
                          "space-y-3 rounded-2xl border bg-white p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors",
                          status === "rejected_by_auditor"
                            ? "border-rose-200 bg-rose-50/60"
                            : status === "reduced"
                              ? "border-amber-200 bg-amber-50/60"
                              : isChosen
                                ? "border-[#006496]/40 bg-[#eef6fb]"
                                : "border-slate-200",
                          flashId === item.id && cn(FLASH, "ring-2 ring-sky-200"),
                        )}
                        aria-label={`${a.employeeName}, ${a.employeeCode}`}
                        data-testid={`portal-card-${item.id}`}
                        data-status={status}
                        data-review={reviewOf(item)}
                      >
                        <div className="flex items-start gap-3">
                          {review && (
                            <div className="pt-1">
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
                              <PersonCell
                                name={a.employeeName}
                                code={a.employeeCode}
                                department={a.employeeDepartment}
                              />
                              <StatusTag status={rowState(item)} />
                            </div>
                          </div>
                        </div>
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-slate-50 px-3 py-2.5 text-[12.5px] sm:grid-cols-3">
                          {cardFigures.map((c) => (
                            <div key={c.key} className="min-w-0" data-col={c.key}>
                              <dt className="text-[11px] font-medium text-slate-500">{c.short ?? c.header}</dt>
                              <dd className="font-medium tabular-nums text-slate-900">{c.cell(item)}</dd>
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
                        <TrailList item={item} testId={`portal-card-trail-${item.id}`} />
                        {(item.auditor.remark ?? "").trim() && (
                          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                            <p className="text-[11px] font-medium text-slate-500">Your remark</p>
                            <RemarkText item={item} clamp={false} />
                          </div>
                        )}
                        {review && (
                          <div className="border-t border-slate-100 pt-3">
                            <CardActions {...actionProps(item)} />
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              ))}
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
          className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-3xl rounded-2xl bg-slate-900/90 p-3 text-white shadow-[0_16px_48px_-12px_rgba(2,6,23,0.55)] ring-1 ring-white/10 backdrop-blur-md sm:px-4"
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
                className={cn(
                  BULK_BUTTON,
                  "bg-emerald-500 text-emerald-950 hover:bg-emerald-400 hover:shadow-emerald-500/30 focus-visible:ring-emerald-300",
                )}
                onClick={() => setBulk("approve")}
                data-testid="portal-bulk-approve"
              >
                <CheckCheck size={15} aria-hidden /> Approve selected
              </Button>
              <Button
                size="sm"
                className={cn(
                  BULK_BUTTON,
                  "bg-rose-500 text-white hover:bg-rose-400 hover:shadow-rose-500/30 focus-visible:ring-rose-300",
                )}
                onClick={() => setBulk("reject")}
                data-testid="portal-bulk-reject"
              >
                <Ban size={15} aria-hidden /> Reject selected
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-9 w-9 shrink-0 p-0 text-slate-300 transition-[background-color,color,transform] hover:bg-white/10 hover:text-white active:scale-95"
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
