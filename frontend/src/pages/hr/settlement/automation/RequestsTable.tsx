import { Fragment, type ReactNode } from "react";
import {
  Check,
  CheckCheck,
  MessageSquareText,
  MinusCircle,
  PencilLine,
  RotateCcw,
  UserCheck,
  XCircle,
} from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SettlementBatch, SettlementBatchItem } from "@/lib/api-client/custom-hooks/settlement-automation";
import { groupByReview, reviewGroupLabel, type ReviewState } from "@/lib/reviewOrder";
import { cn } from "@/lib/utils";
import { allState, SelectBox } from "../bulk";
import { LeaveButton } from "../LeaveCalendarButton";
import { formatDays } from "../logic";
import { formatMoney } from "../shared";
import {
  CardField,
  FIRST,
  FLASH,
  FROM,
  Figure,
  GroupRow,
  LAST,
  PersonCell,
  Pill,
  RowAction,
  RowActions,
  muted,
} from "../table-kit";
import {
  answerText,
  auditorAnswerOf,
  mdAnswerOf,
  mdRemarkOf,
  pendingGroupLabel,
  remarksOf,
  requestColumns,
  requestFigures,
  reviewStateOf,
  reworkFlag,
  trailOf,
  type RequestColumn,
  type RequestColumnKey,
  type TrailStep,
} from "./focus";
import { auditorChanged } from "./logic";
import { RoundedCell, RoundedLine } from "./Rounded";
import { baseOf, roundingChanged, roundsToZero } from "./rounding";

/** What this login may do on the requests now: HR Review (proposals), HR Rework (MD Changes) (answers to the MD), HR
 *  Final Settlement (final decisions) or HR Rework (Auditor Changes) (answers to the auditor). */
export type RequestsMode = "hr_review" | "md_changes" | "hr_final" | "auditor_changes" | null;

/** A row's actions: HR Review's keep / reduce / reject / remark, the final decision, Rework (reopen a decision HR made in
 *  this stage), and in a rework stage the answer to the reviewer: accept their change, or keep HR's own ("keepOwn"). */
export type RowActionKind = "keep" | "reduce" | "reject" | "remark" | "final" | "rework" | "accept" | "keepOwn";

type Props = {
  batch: SettlementBatch;
  /** The requests the filter shows. */
  items: SettlementBatchItem[];
  mode: RequestsMode;
  /** The ticked requests (bulk); only with a mode. */
  selected: ReadonlySet<number>;
  onToggle: (id: number, on: boolean) => void;
  /** Ticks (or clears) every request shown. */
  onToggleAll: (on: boolean) => void;
  onAction: (item: SettlementBatchItem, action: RowActionKind) => void;
  onLeave: (item: SettlementBatchItem) => void;
  /** The request (and the action) being saved: that button spins, the row's others wait. */
  busy?: { id: number; action: RowActionKind } | null;
  /** Rework is open in this stage (the batch's `canRework`). */
  canRework?: boolean;
  /** The request that just moved between the groups: it glows for a moment where it landed. */
  flashId?: number | null;
};

/** The column tiers: the shared ones, and 1400 px for the xl columns of a table with row actions. */
const TIER: Record<NonNullable<RequestColumn["from"]>, string> = {
  xl: FROM.xl,
  xl2: "hidden min-[1400px]:table-cell",
  "2xl": FROM["2xl"],
  wide: FROM.wide,
  full: FROM.full,
};

/** Where the Rounded column is hidden (below its "full" tier), the rounded amount is a line under the amount asked for. */
const ROUNDED_LINE = "min-[1880px]:hidden";

/** The employee's width by tier (measured 2026-11-27 with a 23-letter name, the rounding line and five row actions): a
 *  long name is cut short with an ellipsis rather than pushing the table past its card on a 1280 / 1536 px screen. */
const PERSON_WIDTH = "max-w-[11rem] min-[1400px]:max-w-[14rem] min-[1800px]:max-w-[15rem]";

const ALIGN: Record<RequestColumn["align"], string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

const money = (n: number | null | undefined) => (n == null ? "—" : formatMoney(n));

/** The amount the request stands at now, and from where ("final", "MD", "HR proposes", "after the audit"); in a rework
 *  stage what HR sends back to the reviewer. A request HR kept as asked at HR Review shows what goes to the MD: a Salary
 *  Advance's rounded amount ("kept · rounded", 2026-11-27). */
function Approved({ item, batch }: { item: SettlementBatchItem; batch: SettlementBatch }) {
  const s = requestFigures(item, batch.stage).standing;
  if (s.decision === "rejected") return <Figure value="Rejected" tone="red" sub={s.label} />;
  if (s.decision === null) {
    if (item.hr?.action !== "approve") return muted;
    return (
      <Figure
        value={money(s.amount)}
        strong
        sub={roundingChanged(item.rounding) ? "kept · rounded" : "kept as asked"}
      />
    );
  }
  // less than the "as asked" amount (a Salary Advance's rounded amount): a reduction, not the rounding
  const base = baseOf(item);
  const less = s.amount != null && s.amount < base - 0.004;
  return (
    <Figure
      value={money(s.amount)}
      strong
      tone={s.source === "hr" ? "amber" : undefined}
      sub={
        <>
          {s.label}
          {less && (
            <span className="block font-medium text-amber-700">
              {s.amount != null && s.amount < item.requestedAmount ? "less than asked" : "below rounded"}
            </span>
          )}
        </>
      }
    />
  );
}

const STEP_INK: Record<TrailStep["tone"], string> = {
  success: "text-green-700",
  danger: "text-red-600",
  warning: "text-amber-700",
  neutral: "text-slate-600",
  info: "text-blue-700",
};

/** The decisions so far, one line per stage reached (HR, MD, Final, Auditor); the latest is the status pill. In a rework
 *  stage (2026-11-27): what the reviewer flagged as a pill on top, the reviewer's own remark under their decision, and
 *  HR's answer once given; HR Rework (Auditor Changes) shows HR's final and the auditor's change only. */
function Status({ item, batch, prefix }: { item: SettlementBatchItem; batch: SettlementBatch; prefix: string }) {
  const stage = batch.stage;
  const all = trailOf(item, batch);
  const steps = stage === "auditor_changes" ? all.filter((t) => t.step === "final" || t.step === "auditor") : all;
  const flag = reworkFlag(item, stage);
  const reviewer = stage === "md_changes" ? "md" : stage === "auditor_changes" ? "auditor" : null;
  const remark =
    reviewer === "md" ? mdRemarkOf(item) : reviewer === "auditor" ? (item.auditor?.remark ?? "").trim() : "";
  const answer = reviewer === "md" ? mdAnswerOf(item) : reviewer === "auditor" ? auditorAnswerOf(item) : null;
  return (
    <div className="space-y-1">
      {flag && (
        <Pill tone={flag.tone} testId={`${prefix}-flag-${item.id}`}>
          {flag.text}
        </Pill>
      )}
      <ul className="space-y-1" aria-label="Decisions so far">
        {steps.map((t, i) => {
          const latest = i === steps.length - 1;
          return (
            <li
              key={t.step}
              data-testid={`${prefix}-${t.step}-view-${item.id}`}
              data-action={t.step === "auditor" ? (item.auditor?.action ?? "none") : undefined}
            >
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="w-9 shrink-0 text-[11px] text-muted-foreground">{t.who}</span>
                {latest ? (
                  <Pill tone={t.tone}>{t.text}</Pill>
                ) : (
                  <span className={cn("text-xs font-medium", STEP_INK[t.tone])}>{t.text}</span>
                )}
                {t.note && <span className="text-[11px] text-muted-foreground">{t.note}</span>}
              </span>
              {t.step === reviewer && remark && (
                <span
                  className="ml-[2.625rem] block max-w-[13rem] truncate text-[11px] italic text-slate-600"
                  title={remark}
                  data-testid={`${prefix}-reviewer-remark-${item.id}`}
                >
                  &ldquo;{remark}&rdquo;
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {reviewer && answer && answer !== "waiting" && (
        <p className="text-[11px] font-medium text-slate-500" data-testid={`${prefix}-answer-${item.id}`}>
          {answerText(answer, reviewer)}
        </p>
      )}
    </div>
  );
}

/** The purpose, then every remark with whose it is; one line each (the whole text on hover). */
function Remarks({ item, wrap }: { item: SettlementBatchItem; wrap?: boolean }) {
  const lines = remarksOf(item);
  const purpose = (item.advance.purpose ?? "").trim();
  if (!purpose && lines.length === 0) return muted;
  const line = cn(wrap ? "line-clamp-2" : "truncate");
  return (
    <div className={cn("space-y-0.5 text-xs leading-snug", !wrap && "max-w-[15rem]")}>
      {purpose && (
        <p className={cn(line, "text-slate-600")} title={purpose}>
          <span className="text-muted-foreground">Purpose: </span>
          {purpose}
        </p>
      )}
      {lines.map((l) => (
        <p key={l.who} className={cn(line, "text-slate-700")} title={`${l.who}: ${l.text}`}>
          <span className="text-muted-foreground">{l.who}: </span>
          &ldquo;{l.text}&rdquo;
        </p>
      ))}
    </div>
  );
}

/**
 * A row's actions, on one line, as ghost icon buttons with their hover label (All Employees). The answer to the stage's
 * reviewer comes first, then what HR may change, so the same buttons line up down the table:
 *  - HR Review: [Rework] Keep as asked / Reduce / Reject / Remark (the proposal made is tinted);
 *  - HR Rework (MD Changes): waiting rows Accept the MD's decision / Keep mine, answered rows Rework; then Reduce /
 *    Reject / Remark;
 *  - HR Final Settlement: [Rework] Final decision;
 *  - HR Rework (Auditor Changes): waiting rows Accept the auditor's change / Keep HR's settlement, answered rows Rework;
 *    then Change the final decision.
 * Rework (reopen a decision made in this stage) shows on a row that is not waiting any more.
 */
function Actions({
  item,
  mode,
  prefix,
  review,
  busy,
  canRework,
  onAction,
}: {
  item: SettlementBatchItem;
  mode: RequestsMode;
  prefix: string;
  review: ReviewState;
  busy: Props["busy"];
  canRework: boolean;
  onAction: Props["onAction"];
}) {
  if (!mode) return null;
  const name = item.advance.employeeName;
  const mine = busy?.id === item.id;
  const spin = (action: RowActionKind) => mine && busy?.action === action;
  const wait = mine;
  const act = (action: RowActionKind) => () => onAction(item, action);
  const rework = canRework && review !== "pending" && (
    <RowAction
      label="Rework — reopen this decision"
      icon={<RotateCcw size={15} />}
      color="violet"
      onClick={act("rework")}
      disabled={wait}
      busy={spin("rework")}
      aria={`Rework: reopen the decision on ${name}'s request`}
      testId={`${prefix}-rework-${item.id}`}
    />
  );
  const proposal = item.hr?.action ?? null;
  const hrChoices = (
    <>
      <RowAction
        label="Propose a smaller amount"
        icon={<MinusCircle size={15} />}
        color="amber"
        onClick={act("reduce")}
        disabled={wait}
        pressed={proposal === "reduce"}
        aria={`Propose a smaller amount for ${name}`}
        testId={`${prefix}-reduce-${item.id}`}
      />
      <RowAction
        label="Propose to reject"
        icon={<XCircle size={15} />}
        color="red"
        onClick={act("reject")}
        disabled={wait}
        pressed={proposal === "reject"}
        aria={`Propose to reject ${name}'s request`}
        testId={`${prefix}-hr-reject-${item.id}`}
      />
      <RowAction
        label="Remark to the MD"
        icon={<MessageSquareText size={15} />}
        color="blue"
        onClick={act("remark")}
        disabled={wait}
        aria={`Remark to the MD on ${name}'s request`}
        testId={`${prefix}-note-${item.id}`}
      />
    </>
  );
  const finalButton = (label: string) => (
    <RowAction
      label={label}
      icon={<PencilLine size={15} />}
      color={mode === "auditor_changes" ? "amber" : "blue"}
      onClick={act("final")}
      disabled={wait}
      aria={`${label} on ${name}'s request`}
      testId={`${prefix}-final-${item.id}`}
    />
  );

  if (mode === "hr_review") {
    const kept = proposal === "approve";
    // a Salary Advance that rounds to ₹0 can only be rejected (2026-11-27; the server refuses a keep)
    const zero = roundsToZero(item);
    const rounded = roundingChanged(item.rounding) ? ` (rounded ${money(baseOf(item))})` : "";
    return (
      <RowActions>
        {rework}
        <RowAction
          label={zero ? "Rounds to ₹0 — reject it" : kept ? `Kept as asked${rounded}` : `Keep as asked${rounded}`}
          icon={<Check size={15} />}
          color="emerald"
          onClick={act("keep")}
          disabled={wait || kept || zero}
          busy={spin("keep")}
          pressed={kept}
          aria={zero ? `${name}'s request rounds to ₹0: it can only be rejected` : `Keep ${name}'s request as asked`}
          testId={`${prefix}-keep-${item.id}`}
        />
        {hrChoices}
      </RowActions>
    );
  }
  if (mode === "md_changes") {
    const waiting = item.rework === "md";
    const mdDecided = !!item.md.decision && !!item.md.decidedAt && !item.md.fromHr;
    return (
      <RowActions>
        {waiting ? (
          <>
            <RowAction
              label={mdDecided ? "Accept the MD's decision" : "The MD has not decided this request"}
              icon={<CheckCheck size={15} />}
              color="emerald"
              onClick={act("accept")}
              disabled={wait || !mdDecided}
              busy={spin("accept")}
              aria={`Accept the MD's decision on ${name}'s request`}
              testId={`${prefix}-accept-${item.id}`}
            />
            <RowAction
              label="Keep mine (my proposal)"
              icon={<UserCheck size={15} />}
              color="blue"
              onClick={act("keepOwn")}
              disabled={wait}
              busy={spin("keepOwn")}
              aria={`Keep your proposal on ${name}'s request`}
              testId={`${prefix}-keep-own-${item.id}`}
            />
          </>
        ) : (
          rework
        )}
        {hrChoices}
      </RowActions>
    );
  }
  if (mode === "hr_final") {
    return (
      <RowActions>
        {rework}
        {finalButton("Final decision")}
      </RowActions>
    );
  }
  // HR Rework (Auditor Changes)
  const waiting = item.rework === "auditor";
  return (
    <RowActions>
      {waiting ? (
        <>
          <RowAction
            label={auditorChanged(item) ? "Accept the auditor's change" : "Accept the auditor's remark"}
            icon={<CheckCheck size={15} />}
            color="emerald"
            onClick={act("accept")}
            disabled={wait}
            busy={spin("accept")}
            aria={`Accept the auditor's change on ${name}'s request`}
            testId={`${prefix}-accept-${item.id}`}
          />
          <RowAction
            label="Keep HR's settlement"
            icon={<UserCheck size={15} />}
            color="blue"
            onClick={act("keepOwn")}
            disabled={wait}
            busy={spin("keepOwn")}
            aria={`Keep HR's settlement of ${name}'s request`}
            testId={`${prefix}-keep-own-${item.id}`}
          />
        </>
      ) : (
        rework
      )}
      {finalButton("Change the final decision")}
    </RowActions>
  );
}

/** One cell's content by column (the table and the phone cards draw the same values). */
function cellOf(
  key: RequestColumnKey,
  item: SettlementBatchItem,
  ctx: {
    batch: SettlementBatch;
    prefix: string;
    onLeave: Props["onLeave"];
    wrap?: boolean;
    /** The table shows the Rounded column (from its tier on): below it, the rounded amount is a line under the ask. */
    roundedLine?: boolean;
  },
): ReactNode {
  const f = requestFigures(item, ctx.batch.stage);
  switch (key) {
    case "requested":
      return (
        <div className="leading-tight">
          <Figure value={money(item.requestedAmount)} strong />
          {ctx.roundedLine && roundingChanged(f.rounding) && (
            <RoundedLine
              rounding={f.rounding}
              className={cn("whitespace-nowrap", ROUNDED_LINE)}
              testId={`${ctx.prefix}-rounded-line-${item.id}`}
            />
          )}
        </div>
      );
    case "rounded":
      return f.rounding ? <RoundedCell rounding={f.rounding} testId={`${ctx.prefix}-rounded-${item.id}`} /> : muted;
    case "fixedSalary":
      return f.fixedSalary != null ? <Figure value={money(f.fixedSalary)} /> : muted;
    case "workingDays":
      return f.workingDays != null ? <Figure value={formatDays(f.workingDays)} /> : muted;
    case "earned":
      return f.earned != null ? <Figure value={money(f.earned)} /> : muted;
    case "limit":
      return f.limit != null ? (
        <span
          className={cn("text-sm tabular-nums", f.overLimit ? "font-semibold text-amber-700" : "text-slate-700")}
          title={f.overLimit ? "Asked for more than the eligible limit" : undefined}
          data-over-limit={f.overLimit ? "true" : undefined}
        >
          {money(f.limit)}
        </span>
      ) : (
        muted
      );
    case "months":
      return f.months != null ? <Figure value={f.months} /> : muted;
    case "emi":
      return f.emi != null ? <Figure value={money(f.emi)} /> : muted;
    case "firstEmi":
      return f.firstEmi ? <span className="whitespace-nowrap text-sm text-slate-700">{f.firstEmi}</span> : muted;
    case "approved":
      return <Approved item={item} batch={ctx.batch} />;
    case "leave":
      return (
        <LeaveButton
          check={item.advance.leaveCheck}
          name={item.advance.employeeName}
          onOpen={() => ctx.onLeave(item)}
          testId={`${ctx.prefix}-leave-${item.id}`}
        />
      );
    case "decision":
      return <Status item={item} batch={ctx.batch} prefix={ctx.prefix} />;
    case "remarks":
      return <Remarks item={item} wrap={ctx.wrap} />;
    default:
      return null;
  }
}

/** The figures a phone card shows as label / value pairs (the rest has its own place on the card). */
const CARD_FIGURES: RequestColumnKey[] = [
  "requested",
  "limit",
  "rounded",
  "approved",
  "fixedSalary",
  "workingDays",
  "earned",
  "months",
  "emi",
  "firstEmi",
];

const person = (item: SettlementBatchItem, size?: number) => (
  <PersonCell
    name={item.advance.employeeName}
    code={item.advance.employeeCode}
    department={item.advance.employeeDepartment}
    size={size}
  />
);

/** A heading of two short words ("Eligible limit", "Working days") may take two lines where the row is tight (the house
 *  rule, table-kit HEAD); a one-word heading stays on one line. */
const headWrap = (header: string) => (header.includes(" ") ? "whitespace-normal" : "whitespace-nowrap");

const GROUP_DOT: Record<ReviewState, string> = {
  pending: "bg-amber-500",
  approved: "bg-emerald-500",
  rejected: "bg-red-500",
};

/**
 * The batch's requests (owner 2026-11-27), in the HRMS table style (All Employees): the employee with initials, code and
 * department; every figure under its own heading, right-aligned (a Salary Advance: fixed salary, working days, earned,
 * requested, eligible limit, approved; a Term Loan: fixed salary, requested, eligible limit, approved, months, monthly
 * EMI, first EMI); the leave check (opens the leave calendar); the status (one line per stage reached, the latest as a
 * pill); the remarks; and the stage's actions as icon buttons. The less needed columns show from a wider screen on, so
 * the table fits its card on a laptop; a phone or tablet gets a card per request with every value.
 *
 * The rows are grouped by where they stand with the stage's reviewer (owner 2026-11-27): the waiting ones on top, the
 * approved ones below, the rejected ones below those, each group under a quiet divider; a request reopened with Rework
 * waits again, so it moves back to the top, and a row that just moved glows for a moment where it landed.
 */
export default function RequestsTable({
  batch,
  items,
  mode,
  selected,
  onToggle,
  onToggleAll,
  onAction,
  onLeave,
  busy = null,
  canRework = false,
  flashId = null,
}: Props) {
  const select = mode !== null;
  // the Rounded column once the batch's requests carry the rounding (a Salary Advance; not a Term Loan, not an older batch)
  const rounding = batch.advanceType !== "term" && batch.items.some((i) => i.rounding);
  const columns = requestColumns(batch.advanceType, { select, actions: mode !== null, rounding });
  const ticked = items.filter((i) => selected.has(i.id)).length;
  const ctx = (prefix: string, wrap?: boolean, table = false) => ({
    batch,
    prefix,
    onLeave,
    wrap,
    roundedLine: rounding && table,
  });
  const labelOf = (key: RequestColumnKey) => columns.find((c) => c.key === key)?.header ?? "";
  const last = columns[columns.length - 1]?.key;
  const reviewOf = (item: SettlementBatchItem) => reviewStateOf(item, batch.stage);
  const groups = groupByReview(items, reviewOf);
  const groupLabel = (state: ReviewState) => reviewGroupLabel(state, pendingGroupLabel(batch.stage));
  const actions = (item: SettlementBatchItem, prefix: string) => (
    <Actions
      item={item}
      mode={mode}
      prefix={prefix}
      review={reviewOf(item)}
      busy={busy}
      canRework={canRework}
      onAction={onAction}
    />
  );

  const row = (item: SettlementBatchItem) => {
    const on = selected.has(item.id);
    const changed = auditorChanged(item);
    return (
      <TableRow
        key={item.id}
        className={cn(changed && "bg-amber-50/50", on && "bg-sky-50/80 hover:bg-sky-50", flashId === item.id && FLASH)}
        data-state={on ? "selected" : undefined}
        data-testid={`auto-row-${item.id}`}
        data-review={reviewOf(item)}
        data-auditor-changed={changed ? "true" : undefined}
        data-selected={on ? "true" : undefined}
        data-flash={flashId === item.id ? "true" : undefined}
      >
        {columns.map((c) => {
          const edge = cn(c.key === last && LAST);
          if (c.key === "select")
            return (
              <TableCell key={c.key} className={cn(FIRST, "w-10")}>
                <SelectBox
                  checked={on}
                  onChange={(v) => onToggle(item.id, v)}
                  label={`Select ${item.advance.employeeName}'s request`}
                  testId={`auto-select-${item.id}`}
                />
              </TableCell>
            );
          if (c.key === "employee")
            return (
              <TableCell key={c.key} className={cn("py-3", !select && FIRST)}>
                <div className={PERSON_WIDTH}>{person(item)}</div>
              </TableCell>
            );
          if (c.key === "actions")
            return (
              <TableCell key={c.key} className={cn("text-right", edge)}>
                {actions(item, "auto")}
              </TableCell>
            );
          return (
            <TableCell key={c.key} className={cn(ALIGN[c.align], c.from && TIER[c.from], edge)} data-column={c.key}>
              {cellOf(c.key, item, ctx("auto", false, true))}
            </TableCell>
          );
        })}
      </TableRow>
    );
  };

  return (
    <>
      <div className="hidden border-t border-slate-100 xl:block">
        <Table data-testid="auto-requests-table" data-type={batch.advanceType}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((c) =>
                c.key === "select" ? (
                  <TableHead key={c.key} className={cn(FIRST, "w-10")}>
                    <SelectBox
                      checked={allState(ticked, items.length)}
                      onChange={onToggleAll}
                      label="Select all the requests shown"
                      testId="auto-select-all"
                    />
                  </TableHead>
                ) : (
                  <TableHead
                    key={c.key}
                    className={cn(
                      "h-auto py-2.5 align-bottom leading-tight",
                      headWrap(c.header),
                      ALIGN[c.align],
                      c.from && TIER[c.from],
                      c.key === "employee" && !select && FIRST,
                      c.key === last && LAST,
                    )}
                    data-column={c.key}
                  >
                    {c.header}
                  </TableHead>
                ),
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
                  colSpan={columns.length}
                  testId={`auto-group-${g.state}`}
                />
                {g.rows.map(row)}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="divide-y divide-slate-100 border-t border-slate-100 xl:hidden" data-testid="auto-requests-cards">
        {groups.map((g) => (
          <Fragment key={g.state}>
            <li
              className="flex items-center gap-2 bg-slate-50/80 px-4 py-1.5 text-[11.5px] font-semibold text-slate-600"
              data-group={g.state}
              data-testid={`auto-card-group-${g.state}`}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", GROUP_DOT[g.state])} aria-hidden />
              {groupLabel(g.state)}
              <span className="rounded-full bg-white px-1.5 py-px text-[10.5px] font-bold tabular-nums text-slate-500 ring-1 ring-slate-200">
                {g.rows.length}
              </span>
            </li>
            {g.rows.map((item) => {
              const on = selected.has(item.id);
              return (
                <li
                  key={item.id}
                  className={cn(
                    "space-y-3 px-4 py-3.5",
                    auditorChanged(item) && "bg-amber-50/50",
                    on && "bg-sky-50/80",
                    flashId === item.id && FLASH,
                  )}
                  data-testid={`auto-card-${item.id}`}
                  data-review={reviewOf(item)}
                >
                  <div className="flex items-center gap-3">
                    {select && (
                      <SelectBox
                        checked={on}
                        onChange={(v) => onToggle(item.id, v)}
                        label={`Select ${item.advance.employeeName}'s request`}
                        testId={`auto-card-select-${item.id}`}
                      />
                    )}
                    <div className="min-w-0 flex-1">{person(item, 38)}</div>
                    {cellOf("leave", item, ctx("auto-card"))}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-xl border border-slate-100 bg-slate-50/60 p-3 sm:grid-cols-3">
                    {CARD_FIGURES.filter((k) => columns.some((c) => c.key === k)).map((k) => (
                      <CardField key={k} label={labelOf(k)}>
                        {cellOf(k, item, ctx("auto-card"))}
                      </CardField>
                    ))}
                  </dl>
                  <dl className="grid gap-2.5 sm:grid-cols-2">
                    <CardField label="Status">{cellOf("decision", item, ctx("auto-card"))}</CardField>
                    <CardField label="Remarks">{cellOf("remarks", item, ctx("auto-card", true))}</CardField>
                  </dl>
                  {mode && (
                    <div className="flex justify-end border-t border-slate-100 pt-2">{actions(item, "auto-card")}</div>
                  )}
                </li>
              );
            })}
          </Fragment>
        ))}
      </ul>
    </>
  );
}
