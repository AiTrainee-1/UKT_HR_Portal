import type { ReactNode } from "react";
import { Check, MessageSquareText, MinusCircle, PencilLine, XCircle } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SettlementBatch, SettlementBatchItem } from "@/lib/api-client/custom-hooks/settlement-automation";
import { cn } from "@/lib/utils";
import { allState, SelectBox } from "../bulk";
import { LeaveButton } from "../LeaveCalendarButton";
import { formatDays } from "../logic";
import { formatMoney } from "../shared";
import { CardField, FIRST, FROM, Figure, LAST, PersonCell, Pill, RowAction, RowActions, muted } from "../table-kit";
import {
  remarksOf,
  requestColumns,
  requestFigures,
  trailOf,
  type RequestColumn,
  type RequestColumnKey,
  type TrailStep,
} from "./focus";
import { auditorChanged } from "./logic";

/** What this login may do on the requests now: HR Review (proposals) or HR Final Settlement (final decisions). */
export type RequestsMode = "hr_review" | "hr_final" | null;

export type HrAction = "keep" | "reduce" | "reject" | "remark";

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
  onHrAction: (item: SettlementBatchItem, action: HrAction) => void;
  onEditFinal: (item: SettlementBatchItem) => void;
  onLeave: (item: SettlementBatchItem) => void;
  /** The request whose change is being saved: its buttons wait. */
  busyId?: number | null;
};

const ALIGN: Record<RequestColumn["align"], string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

const money = (n: number | null | undefined) => (n == null ? "—" : formatMoney(n));

/** The amount the request stands at now, and from where ("final", "MD", "HR proposes", "after the audit"). */
function Approved({ item }: { item: SettlementBatchItem }) {
  const s = requestFigures(item).standing;
  if (s.decision === "rejected") return <Figure value="Rejected" tone="red" sub={s.label} />;
  if (s.decision === null) return muted;
  const less = s.amount != null && s.amount < item.requestedAmount;
  return (
    <Figure
      value={money(s.amount)}
      strong
      tone={s.source === "hr" ? "amber" : undefined}
      sub={
        <>
          {s.label}
          {less && <span className="block font-medium text-amber-700">less than asked</span>}
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

/** The decisions so far, one line per stage reached (HR, MD, Final, Auditor); the latest is the status pill. */
function Status({ item, batch, prefix }: { item: SettlementBatchItem; batch: SettlementBatch; prefix: string }) {
  const steps = trailOf(item, batch);
  return (
    <ul className="space-y-1" aria-label="Decisions so far">
      {steps.map((t, i) => {
        const latest = i === steps.length - 1;
        return (
          <li
            key={t.step}
            className="flex items-center gap-1.5 whitespace-nowrap"
            data-testid={`${prefix}-${t.step}-view-${item.id}`}
            data-action={t.step === "auditor" ? (item.auditor?.action ?? "none") : undefined}
          >
            <span className="w-9 shrink-0 text-[11px] text-muted-foreground">{t.who}</span>
            {latest ? (
              <Pill tone={t.tone}>{t.text}</Pill>
            ) : (
              <span className={cn("text-xs font-medium", STEP_INK[t.tone])}>{t.text}</span>
            )}
            {t.note && <span className="text-[11px] text-muted-foreground">{t.note}</span>}
          </li>
        );
      })}
    </ul>
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

/** HR Review: Keep / Reduce / Reject / Remark (the proposal made is tinted); HR Final Settlement: Final decision. */
function Actions({
  item,
  mode,
  prefix,
  busy,
  onHrAction,
  onEditFinal,
}: {
  item: SettlementBatchItem;
  mode: RequestsMode;
  prefix: string;
  busy: boolean;
  onHrAction: Props["onHrAction"];
  onEditFinal: Props["onEditFinal"];
}) {
  const name = item.advance.employeeName;
  if (mode === "hr_review") {
    const proposal = item.hr?.action ?? null;
    return (
      <RowActions>
        <RowAction
          label={proposal === null ? "Kept as asked" : "Keep as asked"}
          icon={<Check size={15} />}
          color="emerald"
          onClick={() => onHrAction(item, "keep")}
          disabled={busy || proposal === null}
          pressed={proposal === null}
          aria={`Keep ${name}'s request as asked`}
          testId={`${prefix}-keep-${item.id}`}
        />
        <RowAction
          label="Propose a smaller amount"
          icon={<MinusCircle size={15} />}
          color="amber"
          onClick={() => onHrAction(item, "reduce")}
          disabled={busy}
          pressed={proposal === "reduce"}
          aria={`Propose a smaller amount for ${name}`}
          testId={`${prefix}-reduce-${item.id}`}
        />
        <RowAction
          label="Propose to reject"
          icon={<XCircle size={15} />}
          color="red"
          onClick={() => onHrAction(item, "reject")}
          disabled={busy}
          pressed={proposal === "reject"}
          aria={`Propose to reject ${name}'s request`}
          testId={`${prefix}-hr-reject-${item.id}`}
        />
        <RowAction
          label="Remark to the MD"
          icon={<MessageSquareText size={15} />}
          color="blue"
          onClick={() => onHrAction(item, "remark")}
          disabled={busy}
          aria={`Remark to the MD on ${name}'s request`}
          testId={`${prefix}-note-${item.id}`}
        />
      </RowActions>
    );
  }
  if (mode === "hr_final") {
    return (
      <RowActions>
        <RowAction
          label="Final decision"
          icon={<PencilLine size={15} />}
          color="blue"
          onClick={() => onEditFinal(item)}
          disabled={busy}
          aria={`Final decision on ${name}'s request`}
          testId={`${prefix}-final-${item.id}`}
        />
      </RowActions>
    );
  }
  return null;
}

/** One cell's content by column (the table and the phone cards draw the same values). */
function cellOf(
  key: RequestColumnKey,
  item: SettlementBatchItem,
  ctx: { batch: SettlementBatch; prefix: string; onLeave: Props["onLeave"]; wrap?: boolean },
): ReactNode {
  const f = requestFigures(item);
  switch (key) {
    case "requested":
      return <Figure value={money(item.requestedAmount)} strong />;
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
      return <Approved item={item} />;
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

/**
 * The batch's requests (owner 2026-11-27), in the HRMS table style (All Employees): the employee with initials, code and
 * department; every figure under its own heading, right-aligned (a Salary Advance: fixed salary, working days, earned,
 * requested, eligible limit, approved; a Term Loan: fixed salary, requested, eligible limit, approved, months, monthly
 * EMI, first EMI); the leave check (opens the leave calendar); the status (one line per stage reached, the latest as a
 * pill); the remarks; and the stage's actions as icon buttons. The less needed columns show from a wider screen on, so
 * the table fits its card on a laptop; a phone or tablet gets a card per request with every value.
 */
export default function RequestsTable({
  batch,
  items,
  mode,
  selected,
  onToggle,
  onToggleAll,
  onHrAction,
  onEditFinal,
  onLeave,
  busyId = null,
}: Props) {
  const select = mode !== null;
  const columns = requestColumns(batch.advanceType, { select, actions: mode !== null });
  const ticked = items.filter((i) => selected.has(i.id)).length;
  const ctx = (prefix: string, wrap?: boolean) => ({ batch, prefix, onLeave, wrap });
  const labelOf = (key: RequestColumnKey) => columns.find((c) => c.key === key)?.header ?? "";
  const last = columns[columns.length - 1]?.key;

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
                      "whitespace-nowrap",
                      ALIGN[c.align],
                      c.from && FROM[c.from],
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
            {items.map((item) => {
              const on = selected.has(item.id);
              const changed = auditorChanged(item);
              return (
                <TableRow
                  key={item.id}
                  className={cn(changed && "bg-amber-50/50", on && "bg-sky-50/80 hover:bg-sky-50")}
                  data-state={on ? "selected" : undefined}
                  data-testid={`auto-row-${item.id}`}
                  data-auditor-changed={changed ? "true" : undefined}
                  data-selected={on ? "true" : undefined}
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
                        <TableCell key={c.key} className={cn("max-w-[15rem] py-3", !select && FIRST)}>
                          {person(item)}
                        </TableCell>
                      );
                    if (c.key === "actions")
                      return (
                        <TableCell key={c.key} className={cn("text-right", edge)}>
                          <Actions
                            item={item}
                            mode={mode}
                            prefix="auto"
                            busy={busyId === item.id}
                            onHrAction={onHrAction}
                            onEditFinal={onEditFinal}
                          />
                        </TableCell>
                      );
                    return (
                      <TableCell
                        key={c.key}
                        className={cn(ALIGN[c.align], c.from && FROM[c.from], edge)}
                        data-column={c.key}
                      >
                        {cellOf(c.key, item, ctx("auto"))}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ul className="divide-y divide-slate-100 border-t border-slate-100 xl:hidden" data-testid="auto-requests-cards">
        {items.map((item) => {
          const on = selected.has(item.id);
          return (
            <li
              key={item.id}
              className={cn("space-y-3 px-4 py-3.5", auditorChanged(item) && "bg-amber-50/50", on && "bg-sky-50/80")}
              data-testid={`auto-card-${item.id}`}
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
                <div className="flex justify-end border-t border-slate-100 pt-2">
                  <Actions
                    item={item}
                    mode={mode}
                    prefix="auto-card"
                    busy={busyId === item.id}
                    onHrAction={onHrAction}
                    onEditFinal={onEditFinal}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
