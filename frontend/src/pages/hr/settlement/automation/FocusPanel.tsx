import type { ReactNode } from "react";
import { ListFilter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SettlementBatch, SettlementBatchItem } from "@/lib/api-client/custom-hooks/settlement-automation";
import { roundUpRupee } from "@/lib/round-up-rupee";
import { cn } from "@/lib/utils";
import { LeaveButton } from "../LeaveCalendarButton";
import { formatMoney } from "../shared";
import { CardField, FIRST, LAST, PersonCell, Pill } from "../table-kit";
import {
  answerText,
  auditorAnswerOf,
  countText,
  focusView,
  hrProposalText,
  mdAnswerOf,
  mdRemarkOf,
  outcomeOf,
  requestFigures,
  trailOf,
  type FocusKey,
  type FocusKind,
  type ReworkAnswer,
} from "./focus";
import { auditorChangeText, changesFromMd, effectiveOf, finalEmiText, finalMonthsOf } from "./logic";

type Col = { key: string; header: string; right?: boolean; render: (item: SettlementBatchItem) => ReactNode };

const dash = <span className="text-muted-foreground/60">—</span>;
const quote = (text: string | null | undefined) =>
  (text ?? "").trim() ? (
    <span className="line-clamp-2 text-xs text-slate-700" title={(text ?? "").trim()}>
      &ldquo;{(text ?? "").trim()}&rdquo;
    </span>
  ) : (
    dash
  );
const mask = (account: string | null | undefined) => {
  const digits = (account ?? "").trim();
  return digits ? `•••• ${digits.slice(-4)}` : "No account";
};

function OutcomeChip({ item }: { item: SettlementBatchItem }) {
  const o = outcomeOf(item);
  return o === "approved" ? (
    <Pill tone="success">Approved</Pill>
  ) : o === "rejected" ? (
    <Pill tone="danger">Rejected</Pill>
  ) : (
    <Pill tone="warning">Pending</Pill>
  );
}

function StepChip({ item, batch, step }: { item: SettlementBatchItem; batch: SettlementBatch; step: string }) {
  const t = trailOf(item, batch).find((s) => s.step === step);
  if (!t) return dash;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Pill tone={t.tone}>{t.text}</Pill>
      {t.note && <span className="text-[11px] text-muted-foreground">{t.note}</span>}
    </span>
  );
}

/** HR's answer to the reviewer on a request (a rework stage): waiting in amber, given in quiet words. */
function Answer({ answer, who }: { answer: ReworkAnswer; who: "md" | "auditor" }) {
  if (!answer) return dash;
  return answer === "waiting" ? (
    <Pill tone="warning">Waiting for your answer</Pill>
  ) : (
    <span className="whitespace-nowrap text-[12px] font-medium text-slate-600">{answerText(answer, who)}</span>
  );
}

/** The columns each kind of list shows (after the employee). */
function columnsOf(kind: FocusKind, batch: SettlementBatch, onLeave: (item: SettlementBatchItem) => void): Col[] {
  const requested: Col = {
    key: "requested",
    header: "Requested",
    right: true,
    render: (i) => <span className="font-semibold tabular-nums">{formatMoney(i.requestedAmount)}</span>,
  };
  switch (kind) {
    case "hr":
      return [
        requested,
        { key: "hr", header: "HR proposal", render: (i) => <StepChip item={i} batch={batch} step="hr" /> },
        { key: "remark", header: "HR remark", render: (i) => quote(i.hrNote) },
      ];
    case "md":
      return [
        requested,
        {
          key: "hr",
          header: "HR proposal",
          render: (i) => <span className="text-[12px]">{hrProposalText(i, batch.stage)}</span>,
        },
        { key: "md", header: "MD decision", render: (i) => <StepChip item={i} batch={batch} step="md" /> },
        { key: "remark", header: "MD remark", render: (i) => quote(i.md.remark) },
      ];
    case "md_changes":
      return [
        requested,
        {
          key: "hr",
          header: "HR proposal",
          render: (i) => <span className="text-[12px]">{hrProposalText(i, batch.stage)}</span>,
        },
        { key: "md", header: "MD decision", render: (i) => <StepChip item={i} batch={batch} step="md" /> },
        { key: "remark", header: "MD remark", render: (i) => quote(mdRemarkOf(i)) },
        {
          key: "answer",
          header: "Your answer",
          render: (i) => <Answer answer={batch.stage === "md_changes" ? mdAnswerOf(i) : null} who="md" />,
        },
      ];
    case "final":
      return [
        { key: "md", header: "MD decision", render: (i) => <StepChip item={i} batch={batch} step="md" /> },
        {
          key: "final",
          header: "Final decision",
          render: (i) => (
            <span className="space-y-0.5">
              <StepChip item={i} batch={batch} step="final" />
              {i.advance.advanceType === "term" && i.final.decision === "approved" && (
                <span className="block text-[11px] text-gray-500">
                  {finalEmiText(i, i.final.amount ?? 0, finalMonthsOf(i))}
                </span>
              )}
            </span>
          ),
        },
        {
          key: "changed",
          header: "Changed from the MD",
          render: (i) =>
            changesFromMd(i).length > 0 ? (
              <span className="text-[12px] font-semibold text-orange-700">{changesFromMd(i).join("; ")}</span>
            ) : (
              <span className="text-[12px] text-gray-400">No change</span>
            ),
        },
        { key: "remark", header: "Remark", render: (i) => quote(i.final.remark) },
      ];
    case "auditor":
      return [
        { key: "final", header: "HR final", render: (i) => <StepChip item={i} batch={batch} step="final" /> },
        {
          key: "auditor",
          header: "Auditor change",
          render: (i) => (
            <span className="text-[12px] font-semibold text-orange-800">{auditorChangeText(i) ?? "No change"}</span>
          ),
        },
        { key: "remark", header: "Auditor remark", render: (i) => quote(i.auditor?.remark) },
        batch.stage === "auditor_changes"
          ? {
              key: "answer",
              header: "Your answer",
              render: (i) => <Answer answer={auditorAnswerOf(i)} who="auditor" />,
            }
          : {
              key: "pays",
              header: "Pays",
              right: true,
              render: (i) =>
                effectiveOf(i).decision === "approved" ? (
                  <span className="font-semibold tabular-nums">{formatMoney(effectiveOf(i).amount)}</span>
                ) : (
                  <span className="text-[12px] font-semibold text-red-700">Nothing</span>
                ),
            },
      ];
    case "bank":
      return [
        {
          key: "account",
          header: "Bank account",
          render: (i) => <span className="font-mono text-[12px]">{mask(i.advance.bankAccount)}</span>,
        },
        {
          key: "ifsc",
          header: "IFSC",
          render: (i) => <span className="font-mono text-[12px]">{i.advance.bankIfsc || "-"}</span>,
        },
        {
          key: "paid",
          header: "Paid",
          right: true,
          render: (i) => (
            <span className="font-semibold tabular-nums">{formatMoney(roundUpRupee(effectiveOf(i).amount ?? 0))}</span>
          ),
        },
      ];
    default:
      return [
        requested,
        {
          key: "limit",
          header: "Eligible limit",
          right: true,
          render: (i) => {
            const l = requestFigures(i).limit;
            return l != null ? <span className="tabular-nums">{formatMoney(l)}</span> : dash;
          },
        },
        {
          key: "approved",
          header: "Approved",
          right: true,
          render: (i) => {
            const s = requestFigures(i).standing;
            return s.decision === "approved" ? (
              <span className="font-semibold tabular-nums">{formatMoney(s.amount)}</span>
            ) : (
              dash
            );
          },
        },
        {
          key: "leave",
          header: "Leave",
          render: (i) => (
            <LeaveButton
              check={i.advance.leaveCheck}
              name={i.advance.employeeName}
              onOpen={() => onLeave(i)}
              testId={`auto-focus-leave-${i.id}`}
            />
          ),
        },
        { key: "status", header: "Status", render: (i) => <OutcomeChip item={i} /> },
      ];
  }
}

/**
 * Under the tracker (owner 2026-11-27, round 5): the requests of the stage or summary card clicked, with what matters at
 * that point - HR's proposals, the MD's decisions, the final decisions, the auditor's changes or the bank-file rows paid.
 * A clean list (no new tab row), one row per request; on a phone each value is labelled.
 */
export default function FocusPanel({
  batch,
  focus,
  onClose,
  onLeave,
}: {
  batch: SettlementBatch;
  focus: FocusKey;
  onClose: () => void;
  onLeave: (item: SettlementBatchItem) => void;
}) {
  const view = focusView(batch, focus);
  const cols = columnsOf(view.kind, batch, onLeave);
  const total =
    view.kind === "bank" ? view.items.reduce((s, i) => s + roundUpRupee(effectiveOf(i).amount ?? 0), 0) : null;
  const person = (item: SettlementBatchItem) => (
    <PersonCell
      name={item.advance.employeeName}
      code={item.advance.employeeCode}
      department={item.advance.employeeDepartment}
    />
  );
  return (
    <section
      className="clay-card overflow-hidden rounded-2xl border border-slate-100 bg-white"
      aria-label={view.title}
      data-testid="auto-focus-panel"
      data-focus={focus}
      data-kind={view.kind}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
        <div className="min-w-0">
          <h4 className="flex items-center gap-2 text-sm font-bold text-slate-900" data-testid="auto-focus-title">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#006496]/10 text-[#006496]">
              <ListFilter size={14} aria-hidden />
            </span>
            {view.title}{" "}
            <span className="font-medium text-muted-foreground" data-testid="auto-focus-count">
              · {countText(view.items.length)}
              {total != null && view.items.length > 0 ? ` · ${formatMoney(total)}` : ""}
            </span>
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">{view.hint}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 text-xs"
          onClick={onClose}
          data-view-safe
          data-testid="auto-focus-close"
        >
          <X size={14} /> Close
        </Button>
      </header>
      {view.items.length === 0 ? (
        <p
          className="mx-4 mb-4 rounded-2xl border-2 border-dashed border-slate-200 px-6 py-8 text-center text-sm text-muted-foreground sm:mx-5"
          data-testid="auto-focus-empty"
        >
          {view.empty}
        </p>
      ) : (
        <>
          <div className="hidden border-t border-slate-100 md:block">
            <Table aria-label={view.title}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={cn(FIRST, "whitespace-nowrap")}>Employee</TableHead>
                  {cols.map((c, i) => (
                    <TableHead
                      key={c.key}
                      className={cn("whitespace-nowrap", c.right && "text-right", i === cols.length - 1 && LAST)}
                    >
                      {c.header}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.items.map((item) => (
                  <TableRow key={item.id} data-testid={`auto-focus-row-${item.id}`}>
                    <TableCell className={cn(FIRST, "max-w-[16rem] py-3")}>{person(item)}</TableCell>
                    {cols.map((c, i) => (
                      <TableCell
                        key={c.key}
                        className={cn("text-sm text-slate-700", c.right && "text-right", i === cols.length - 1 && LAST)}
                        data-column={c.key}
                      >
                        {c.render(item)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="divide-y divide-slate-100 border-t border-slate-100 md:hidden">
            {view.items.map((item) => (
              <li key={item.id} className="space-y-3 px-4 py-3.5" data-testid={`auto-focus-card-${item.id}`}>
                {person(item)}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                  {cols.map((c) => (
                    <CardField key={c.key} label={c.header}>
                      {c.render(item)}
                    </CardField>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
